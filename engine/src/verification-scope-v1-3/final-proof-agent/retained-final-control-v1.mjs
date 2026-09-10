// Read-only retained control verification. No signing, storage, transports, or
// executor brands are imported/adopted. Authentication never supplies economics.
import { Message } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { assertExactFields, canonicalJson, cloneAndFreeze, sha256CanonicalJson as digest } from '../contract.mjs';
import { validateExecutorMandateV1, OFFLINE_WALLET_PROFILE_V1 } from './executor-mandate-profile-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { validateHumanRevocationV1 } from './human-revocation-v1.mjs';
import { createAuthorizedEpisodeStateV1, admitAgentDecisionStateV1, recordSignedIntentV1, closeFinalizedLegV1, applyHumanRevocationV1 } from './episode-state-machine-v1.mjs';
import { createOrcaReadinessCaptureV1 } from './orca-readiness-capture-v1.mjs';
import { buildOrcaMessageBoundaryV1 } from './orca-message-boundary-v1.mjs';
import { buildFinalizedLegEvidenceV1 } from './episode-evidence-graph-v1.mjs';
import { validateRetainedSubmissionSnapshotV1 } from './wiggles-submission-v1.mjs';
import { inspectSignedLegacyWire, POLICY, canonicalJson as schedulerJson } from './reused/bounded-rebroadcast-v1.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
class ControlError extends Error { constructor(code) { super(code); this.code = code; } }
function need(value, code) { if (!value) throw new ControlError(code); }
function issue(error) {
  if (!(error instanceof ControlError) && error?.name !== 'VerificationScopeError'
      && error?.message !== 'TRUSTED_SUBMISSION_EVIDENCE_OR_AUTHORITY_INVALID'
      && !/^(?:EVIDENCE_[A-Z_]+|RESOLUTION_EVIDENCE_INVALID|IMMUTABLE_PAYLOAD_MISMATCH|INTENT_SCHEMA_INVALID|UNSAFE_CANONICAL_JSON)$/.test(error?.code ?? '')) throw error;
  return { code: error.code ?? error.message, detail: error.message };
}
import { loadRetainedSupervisionV1, validateRetainedSimulationV1, validateRetainedTerminalProjectionV1 } from './retained-supervision-v1.mjs';
import { SUPERVISED_SUBMISSION_PROFILE_V1 } from './supervised-profile-v1.mjs';
export function loadRetainedControlV1(loaded, reference) {
  if (reference === null) return null;
  const value = loaded.parseMemberV1(reference);
  const supervised = value.version === 'artifact_retained_control_v2';
  assertExactFields(value, ['version', 'mandate', 'authorization', 'configured_principals', 'legs', 'revocation', ...(supervised ? ['supervision'] : [])], 'retained_control');
  need((supervised || value.version === 'artifact_retained_control_v1') && Array.isArray(value.legs) && value.legs.length <= 2, 'CONTROL_FORMAT_INVALID');
  if (supervised) loadRetainedSupervisionV1(loaded, value);
  // Resolve every reference before any replay capability is constructed.
  for (const leg of value.legs) {
    assertExactFields(leg, ['challenge', 'decision', 'admitted_at_unix_seconds', 'admission', 'signed_intent', 'wire_member',
      'capture_member', 'record_members', 'submission_members', 'finalized'], 'retained_leg');
    need(Array.isArray(leg.record_members) && leg.record_members.length <= 64
      && Array.isArray(leg.submission_members) && leg.submission_members.length <= 512, 'CONTROL_INVENTORY_INVALID');
    for (const p of [leg.wire_member, leg.capture_member, ...leg.record_members].filter(p => p !== null)) loaded.readMemberV1(p);
    for (const item of leg.submission_members) { assertExactFields(item, ['path', 'member'], 'retained_submission_reference'); loaded.readMemberV1(item.member); }
  }
  return value;
}
async function readiness(loaded, c, leg, state, rows, descriptor) {
  need(leg.capture_member !== null, 'OPENING_CAPTURE_MISSING');
  const manifest = loaded.parseMemberV1(leg.capture_member), records = leg.record_members.map(p => loaded.parseMemberV1(p));
  assertExactFields(manifest, ['classification', 'source', 'challenge', 'raw_evidence_digests', 'counts', 'budget', 'anchor', 'enumeration', 'acquisition_evidence_digest'], 'retained_capture');
  for (const r of records) assertExactFields(r, ['request', 'raw_response', 'started_unix_seconds', 'observed_unix_seconds', 'elapsed_ms'], 'retained_capture_record');
  need(records.length > 0 && equal(manifest.challenge, leg.challenge)
    && equal(manifest.raw_evidence_digests, records.map(digest)), 'CAPTURE_REFERENCE_MISMATCH');
  let at = 0, retained = 0, wall = records[0].started_unix_seconds, mono = 0;
  const outputs = [];
  const capture = createOrcaReadinessCaptureV1({ mandate: c.mandate, authorization: c.authorization, budget: manifest.budget,
    deadline_unix_seconds: leg.challenge.expires_at_unix_seconds,
    clock: { unixSeconds: () => wall, monotonicMs: () => mono },
    durable_episode_authority: { async loadCurrentEpisodeStateV1() { return state; },
      async inspectEpisodeV1() { return { revoked: false, ordinals: rows }; } },
    async transport({ body }) {
      const r = records[at++]; need(r && equal(r.request, body), 'CAPTURE_REQUEST_MISMATCH');
      wall = r.observed_unix_seconds; mono = r.elapsed_ms; return r.raw_response;
    },
    async retain_evidence(v) {
      if (v.request) { need(equal(v, records[retained++]), 'CAPTURE_CLOCK_OR_BYTES_MISMATCH');
        if (retained === records.length) wall = leg.challenge.issued_at_unix_seconds;
      } else outputs.push(v);
      return digest(v);
    },
  });
  await capture.issueReadinessChallengeV1({ phase: leg.challenge.phase, state });
  need(at === records.length && retained === records.length && outputs.length === 1, 'CAPTURE_COMPLETENESS_MISMATCH');
  const replayed = outputs[0];
  for (const field of ['source', 'raw_evidence_digests', 'counts', 'budget', 'anchor', 'enumeration', 'acquisition_evidence_digest']) {
    need(equal(replayed[field], manifest[field]), 'CAPTURE_SOURCE_MISMATCH');
  }
  const omitNonce = ({ challenge_id, challenge_digest, challenge_nonce, ...v }) => v;
  need(equal(omitNonce(replayed.challenge), omitNonce(leg.challenge)), 'CAPTURE_CHALLENGE_MISMATCH');
  if (leg.challenge.phase === 'ACQUISITION') {
    const record = records.find(r => r.request.method === 'getMultipleAccounts');
    const original = JSON.parse(record.raw_response).result;
    const opening = loaded.parseMemberV1(descriptor.opening.classic).result;
    const target = opening.value.find(row => row.pubkey === c.mandate.wallet_scope.jup_ata);
    need(descriptor.opening.minimum_context_slot === original.context.slot && opening.context.slot === original.context.slot
      && target?.account.data[0] === original.value[1].data[0], 'ECONOMIC_OPENING_CAPTURE_MISMATCH');
  }
  if (c.version === 'artifact_retained_control_v2' && leg.signed_intent !== null) {
    const { fee_message_sha256, ...source } = manifest.source;
    const amount = leg.challenge.ordinal === 1 ? c.mandate.economic_authority.acquisition_input_usdc_raw : state.chain_derived_acquired_jup_raw;
    const plan = buildOrcaMessageBoundaryV1({ ...source, mandate: c.mandate, phase: leg.challenge.phase, ordinal: leg.challenge.ordinal,
      input_raw_quantity: amount, retained_acquisition_jup_raw: leg.challenge.ordinal === 1 ? null : amount });
    await validateRetainedSimulationV1({ loaded, control: c, leg, plan, capture: manifest });
  }
  return { phase: leg.challenge.phase, status: 'ELIGIBLE', original_opening_block_time: manifest.anchor.block_time,
    original_capture_unix_seconds: records[0].started_unix_seconds, evidence_member: leg.capture_member };
}
function delta(tx, wallet, mint) {
  const before = tx.pre_token_balances.filter(r => r.owner === wallet && r.mint === mint);
  const after = tx.post_token_balances.filter(r => r.owner === wallet && r.mint === mint);
  need(before.length === 1 && after.length === 1 && before[0].account === after[0].account, 'FINALIZED_BALANCE_UNRESOLVED');
  return BigInt(after[0].raw_amount) - BigInt(before[0].raw_amount);
}
export async function evaluateRetainedControlV1({ loaded, control: c, descriptor, transactions, reconciliation, source_context }) {
  const eligibility = { status: 'NOT_ESTABLISHED', legs: [] }, transmission = { status: 'NOT_ESTABLISHED', economic_authority: 'NONE', legs: [] };
  const result = { eligibility, transmission, control: { status: c === null ? 'MISSING' : 'INVALID', issues: [], state: null } };
  if (c === null) return result;
  const m = c.mandate, a = c.authorization;
  let state;
  try {
    validateExecutorMandateV1(m);
    need(m.wallet_scope.wallet === descriptor.scope.wallet, 'CONTROL_SCOPE_MISMATCH');
    validateHumanEpisodeAuthorizationV1(a, { mandate: m });
    assertExactFields(c.configured_principals, ['human_public_key', 'agent_public_key', 'executor_release_sha256'], 'retained_principals');
    need(equal(c.configured_principals, { human_public_key: a.human_public_key, agent_public_key: a.agent_public_key, executor_release_sha256: a.executor_release_sha256 }), 'CONFIGURED_PRINCIPAL_MISMATCH');
    const principals = m.mandate_profile === OFFLINE_WALLET_PROFILE_V1 ? m.offline_identity : m.unresolved_live_readiness;
    need(principals.human_authorization_public_key === a.human_public_key && principals.agent_control_public_key === a.agent_public_key
      && principals.executor_release_sha256 === a.executor_release_sha256, 'MANDATE_PRINCIPAL_MISMATCH');
    state = createAuthorizedEpisodeStateV1({ mandate: m, authorization: a });
    result.control.status = 'AUTHENTICATED';
  } catch (error) { result.control.issues.push(issue(error)); return result; }
  const rows = [], consumed = new Set();
  let revoked = false, eventTime = a.issued_at_unix_seconds;
  function applyRetainedRevocation() {
    if (c.revocation === null || revoked || c.revocation.predecessor_state_digest !== state.state_digest) return;
    validateHumanRevocationV1(c.revocation, { mandate: m, authorization: a, state });
    need(c.revocation.revoked_at_unix_seconds >= eventTime, 'REVOCATION_TIME_CONTRADICTION');
    state = applyHumanRevocationV1({ state, authorization_digest: a.authorization_digest });
    eventTime = c.revocation.revoked_at_unix_seconds; revoked = true; result.control.status = 'REVOKED';
  }
  for (const [i, leg] of c.legs.entries()) {
    try {
      applyRetainedRevocation();
      need(leg.challenge.ordinal === i + 1 && leg.challenge.phase === ['ACQUISITION', 'DISPOSAL'][i], 'CONTROL_ORDINAL_MISMATCH');
      try { eligibility.legs.push(await readiness(loaded, c, leg, state, rows, descriptor)); }
      catch (error) { eligibility.legs.push({ phase: leg.challenge.phase, status: 'INELIGIBLE', issue: issue(error) }); }
      const admitted = admitAgentDecisionStateV1({ state, mandate: m, authorization: a, challenge: leg.challenge, decision: leg.decision,
        executor_release_sha256: c.configured_principals.executor_release_sha256, now_unix_seconds: leg.admitted_at_unix_seconds });
      need(equal(admitted.admission, leg.admission), 'ADMISSION_RECORD_MISMATCH'); state = admitted.state;
      eventTime = leg.admitted_at_unix_seconds; applyRetainedRevocation();
      if (admitted.admission.status === 'REFUSED') { need(leg.signed_intent === null, 'REFUSED_DECISION_HAS_WIRE'); break; }
      if (leg.signed_intent === null) { transmission.legs.push({ ordinal: i + 1, status: 'UNRESOLVED', reason: 'SIGNED_INTENT_MISSING' }); break; }
      const captured = loaded.parseMemberV1(leg.capture_member), { fee_message_sha256, ...source } = captured.source;
      need(digest({ episode_id: state.episode_id, ordinal: i + 1, source: captured.source }) === leg.challenge.readiness_evidence_digest, 'READINESS_DIGEST_MISMATCH');
      const amount = i === 0 ? m.economic_authority.acquisition_input_usdc_raw : state.chain_derived_acquired_jup_raw;
      const plan = buildOrcaMessageBoundaryV1({ ...source, mandate: m, phase: leg.challenge.phase, ordinal: i + 1,
        input_raw_quantity: amount, retained_acquisition_jup_raw: i === 0 ? null : amount });
      const wireRecord = loaded.parseMemberV1(leg.wire_member); assertExactFields(wireRecord, ['base64'], 'retained_wire');
      const wire = inspectSignedLegacyWire(wireRecord.base64), s = leg.signed_intent;
      const expected = { signed_transaction_intent_version: 'artifact_bounded_agent_signed_transaction_intent_v1', episode_id: state.episode_id,
        phase: leg.challenge.phase, admission_digest: admitted.admission.admission_digest, semantic_transaction_digest: digest(plan),
        message_sha256: hash(wire.message), signed_wire_sha256: hash(wire.wire), signature: wire.expectedSignature, sign_count: 1 };
      need(equal(s, expected) && fee_message_sha256 === s.message_sha256 && plan.message_sha256 === s.message_sha256
        && Buffer.from(plan.message_base64, 'base64').equals(wire.message), 'SIGNED_PLAN_MISMATCH');
      state = recordSignedIntentV1({ state, signed_intent_digest: digest(s) });
      applyRetainedRevocation();
      const independent = reconciliation.find(r => r.signature === s.signature), tx = transactions.find(t => t.signature === s.signature);
      let finalized = null;
      if (tx) {
        consumed.add(tx.signature);
        need(independent.signed_wire_sha256 === s.signed_wire_sha256 && independent.message_sha256 === s.message_sha256
          && tx.block_time >= leg.admitted_at_unix_seconds, 'FINALIZED_WIRE_OR_TIME_MISMATCH');
        if (tx.execution_state === 'succeeded') {
          const target = delta(tx, m.wallet_scope.wallet, m.asset_scope.jup_mint), quote = delta(tx, m.wallet_scope.wallet, m.asset_scope.usdc_mint);
          need(i === 0 ? target > 0n && quote === -BigInt(amount) : target === -BigInt(amount) && quote > 0n, 'FINALIZED_QUANTITY_MISMATCH');
          finalized = buildFinalizedLegEvidenceV1({ episode_id: state.episode_id, phase: s.phase, signed_intent_digest: digest(s),
            signed_wire_sha256: s.signed_wire_sha256, message_sha256: s.message_sha256, signature: s.signature,
            finalized_transaction_digest: independent.full_transaction_digest, slot: tx.slot, block_time: tx.block_time, execution_status: 'SUCCEEDED',
            wallet: m.wallet_scope.wallet, input_mint: plan.input_mint, output_mint: plan.output_mint, input_raw_quantity: amount,
            chain_derived_target_raw_quantity: i === 0 ? String(target) : '0' });
        }
      }
      const t = { ordinal: i + 1, signature: s.signature, status: 'UNRESOLVED', terminal_classification: null,
        finalized_execution_state: tx?.execution_state ?? null, issues: [] };
      try {
        need(leg.submission_members.length > 0, 'SUBMISSION_RECORDS_MISSING');
        const members = leg.submission_members.map(({ path, member }) => ({ path, base64: loaded.readMemberV1(member).toString('base64') }));
        const get = p => { const entry = members.find(x => x.path === p); need(entry, 'SUBMISSION_REFERENCE_MISSING'); return JSON.parse(Buffer.from(entry.base64, 'base64')); };
        const binding = get('binding.json'), records = leg.record_members.map(p => loaded.parseMemberV1(p));
        const latest = records.filter(r => r.request.method === 'getLatestBlockhash'); need(latest.length === 1, 'LIFETIME_RECORD_MISSING');
        const lifetime = JSON.parse(latest[0].raw_response).result;
        need(lifetime.value.blockhash === wire.recentBlockhash, 'LIFETIME_WIRE_MISMATCH');
        const prepared = { prepared_transaction_version: 'artifact_bounded_agent_prepared_transaction_v1', episode_id: state.episode_id, phase: s.phase,
          admission_digest: s.admission_digest, wallet: m.wallet_scope.wallet, pool: m.route_scope.pool, input_mint: plan.input_mint, output_mint: plan.output_mint,
          input_raw_quantity: amount, maximum_slippage_bps: m.economic_authority.maximum_slippage_bps,
          transaction_profile: 'DIRECT_CLASSIC_ORCA_LEGACY_SWAP_V1', unsigned_transaction_digest: digest(plan), readiness_evidence_digest: leg.challenge.readiness_evidence_digest };
        assertExactFields(binding.limits, ['profile', 'max_calls', 'overall_timeout_ms', 'max_response_bytes'], 'retained_submission_limits');
        const submissionProfile = c.version === 'artifact_retained_control_v2' ? SUPERVISED_SUBMISSION_PROFILE_V1 : 'OFFLINE_INJECTED_SUBMISSION_V1';
        if (c.version === 'artifact_retained_control_v2') {
          const authorized = c.supervision.phase_budgets.submission;
          need(binding.limits.max_calls === authorized.max_calls && binding.limits.overall_timeout_ms === authorized.overall_timeout_ms
            && binding.limits.max_response_bytes === authorized.max_response_bytes, 'SUBMISSION_BUDGET_AUTHORITY_MISMATCH');
        }
        need(Number.isSafeInteger(binding.limits.overall_timeout_ms) && Number.isSafeInteger(binding.limits.max_response_bytes)
          && Number.isSafeInteger(binding.runtime_deadline_unix_seconds) && binding.runtime_deadline_unix_seconds > leg.admitted_at_unix_seconds
          && binding.limits.profile === submissionProfile && Number.isSafeInteger(binding.limits.max_calls)
          && binding.limits.max_calls > 0 && binding.limits.max_calls <= 188 && binding.limits.overall_timeout_ms > 0
          && binding.limits.overall_timeout_ms <= 190000 && binding.limits.max_response_bytes > 0 && binding.limits.max_response_bytes <= 1048576, 'SUBMISSION_BUDGET_INVALID');
        const expected_binding = { schema: 'artifact_trusted_submission_binding_v1', profile: submissionProfile, policy: POLICY.id,
          episode_id: state.episode_id, ordinal: i + 1, mandate_digest: m.mandate_digest, authorization_digest: a.authorization_digest,
          executor_release_sha256: a.executor_release_sha256, signed_intent_digest: digest(s), prepared_transaction_digest: digest(prepared), capture_digest: digest(captured),
          intent: { parent_intent_path: 'signed-intent.json', parent_intent_sha256: hash(schedulerJson(s)), expected_signature: s.signature,
            signed_transaction_sha256: s.signed_wire_sha256, message_sha256: s.message_sha256, recent_blockhash: wire.recentBlockhash,
            last_valid_block_height: lifetime.value.lastValidBlockHeight, latest_blockhash_context_slot: lifetime.context.slot, endpoint_capability_id: 'PRIMARY_SOLANA_RPC' },
          limits: binding.limits, runtime_deadline_unix_seconds: binding.runtime_deadline_unix_seconds,
          recovery_policy: 'WHOLE_SCHEDULE_CONSUMED_BEFORE_EFFECT_NO_RESTART_TRANSPORT' };
        const verified = validateRetainedSubmissionSnapshotV1({ members, expected_binding });
        t.terminal_classification = verified.classification;
        if (['FINALIZED_SUCCESS', 'FINALIZED_FAILURE'].includes(verified.classification)) {
          const retained = get('terminal/finalized-transaction-raw-response.json').result;
          need(tx && retained.slot === tx.slot && retained.transaction[0] === wireRecord.base64
            && (retained.meta.err === null) === (tx.execution_state === 'succeeded'), 'TERMINAL_FINALIZED_CONTRADICTION');
          need(equal(retained, loaded.parseMemberV1(independent.source_member).result), 'TERMINAL_FINALIZED_BODY_CONTRADICTION');
          t.status = 'RECONCILED';
        } else need(!tx, 'TERMINAL_ABSENCE_FINALIZED_CONTRADICTION');
      } catch (error) { t.status = 'UNRESOLVED_OR_CONTRADICTORY'; t.issues.push(issue(error)); }
      transmission.legs.push(t);
      // The rebuilt plan already binds the captured fee to this exact serialized
      // message and the mandate's applicable per-leg fee. Finalized metadata must
      // agree even for failed execution; retain its observed fee, never replace it.
      if (tx) need(BigInt(tx.fee_lamports) === BigInt(plan.fee_lamports), 'FINALIZED_FEE_MISMATCH');
      if (leg.finalized !== null) need(finalized !== null && equal(finalized, leg.finalized), 'RETAINED_FINALIZED_CLAIM_CONTRADICTED');
      if (!finalized) break;
      if (i === 1 && c.version === 'artifact_retained_control_v2') {
        await validateRetainedTerminalProjectionV1({ loaded, control: c, leg, state, source_context, tx });
      }
      rows.push({ ordinal: i + 1, transaction_signature: s.signature });
      need(tx.block_time >= eventTime, 'FINALIZED_REVOCATION_TIME_CONTRADICTION');
      state = closeFinalizedLegV1({ state, phase: s.phase, finalized_evidence_digest: finalized.finalized_evidence_digest,
        chain_derived_acquired_jup_raw: i === 0 ? finalized.chain_derived_target_raw_quantity : null });
      eventTime = tx.block_time;
    } catch (error) { result.control.status = 'INVALID'; result.control.issues.push(issue(error)); break; }
  }
  if (c.revocation !== null) {
    try { applyRetainedRevocation(); need(revoked, 'REVOCATION_PREDECESSOR_NOT_RECONSTRUCTED'); }
    catch (error) { result.control.status = 'INVALID'; result.control.issues.push(issue(error)); }
  }
  result.control.revocation_status = c.revocation === null ? 'NOT_RETAINED' : revoked ? 'AUTHENTICATED' : 'INVALID';
  if (consumed.size !== transactions.length) { result.control.status = 'INVALID'; result.control.issues.push({ code: 'UNBOUND_FINALIZED_TRANSACTIONS', detail: 'Economic transactions are not all bound to authenticated decisions.' }); }
  result.control.state = state;
  eligibility.status = eligibility.legs.length === 0 ? 'NOT_ESTABLISHED' : eligibility.legs.every(l => l.status === 'ELIGIBLE') ? 'ELIGIBLE' : 'INELIGIBLE';
  transmission.status = transmission.legs.length > 0 && transmission.legs.every(l => l.status === 'RECONCILED') ? 'RECONCILED' : 'UNRESOLVED';
  return cloneAndFreeze(result);
}
