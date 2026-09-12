import { createHash } from 'node:crypto';
import { assertExactFields, canonicalJson, sha256CanonicalJson } from '../contract.mjs';
import { validateSupervisedPhaseBudgetsV1 } from './supervised-profile-v1.mjs';
import { simulateExactPreparedMessageV1 } from './supervised-simulation-v1.mjs';
import { openingPortFromReadinessV1 } from './supervised-finalized-source-v1.mjs';
import { projectTrustedTerminalLegV1 } from './terminal-leg-projection-v1.mjs';
import { validateSupervisedSetupSourceV1 } from './supervised-setup-source-v1.mjs';
import { isOfflineExecutorMandateV1 } from './executor-mandate-profile-v1.mjs';
import { validateHumanRevocationV1 } from './human-revocation-v1.mjs';
const hash = b => createHash('sha256').update(b).digest('hex'), same = (a, b) => canonicalJson(a) === canonicalJson(b);
function need(v) { if (!v) throw Error('RETAINED_SUPERVISION_INVALID'); }
export function loadRetainedSupervisionV1(loaded, control) {
  const s = control.supervision;
  assertExactFields(s, ['phase_budgets', 'journal_members', 'head_sha256'], 'retained_supervision');
  validateSupervisedPhaseBudgetsV1(s.phase_budgets);
  const identity = isOfflineExecutorMandateV1(control.mandate) ? control.mandate.offline_identity : control.mandate.unresolved_live_readiness;
  need(sha256CanonicalJson(s.phase_budgets) === identity.rpc_budget_table_sha256);
  need(Array.isArray(s.journal_members) && s.journal_members.length <= 384);
  let previous = null; const records = [];
  for (const [i, member] of s.journal_members.entries()) {
    const e = loaded.parseMemberV1(member);
    assertExactFields(e, ['version', 'sequence', 'previous_sha256', 'record'], 'supervised_journal_entry');
    need(e.version === 'artifact_supervised_journal_entry_v1' && e.sequence === i + 1 && e.previous_sha256 === previous);
    previous = sha256CanonicalJson(e); records.push(e.record);
  }
  need(previous === s.head_sha256);
  const revocations = records.filter(r => r.kind === 'revocation');
  need((control.revocation !== null) === (revocations.length > 0));
  for (const delivery of revocations) {
    const bytes = Buffer.from(delivery.revocation_bytes_base64, 'base64'), revocation = JSON.parse(bytes);
    need(bytes.toString('base64') === delivery.revocation_bytes_base64 && bytes.toString('utf8') === canonicalJson(revocation));
    validateHumanRevocationV1(revocation);
    need(same(revocation, control.revocation) && revocation.human_public_key === control.authorization.human_public_key
      && revocation.episode_id === `bounded-agent-episode-${control.authorization.authorization_digest}`
      && revocation.authorization_digest === control.authorization.authorization_digest && revocation.mandate_digest === control.mandate.mandate_digest);
  }
  const descriptor = loaded.parseMemberV1('episode.json');
  let selectedSources = 0;
  for (const ordinal of [1, 2]) {
    const economic = records.filter(r => r.kind === 'economic_rpc' && r.ordinal === ordinal);
    const { pairs, unfinished } = validateRetainedRpcPhaseV1(economic, s.phase_budgets.economic_source, 'economic_source',
      control.version === 'artifact_retained_control_v3' ? control.runtime_deadline_unix_seconds : null);
    const sources = records.filter(r => r.kind === 'economic_source' && r.ordinal === ordinal);
    need(sources.length <= 1);
    for (const source of sources) {
      need(unfinished === null && pairs.length > 0 && Array.isArray(source.members));
      const members = new Map(source.members.map(m => [m.path, Buffer.from(m.base64, 'base64')]));
      need(members.size === source.members.length);
      const d = source.descriptor;
      function requestFor(response, method, params) {
        const envelope = JSON.parse(members.get(response));
        const pair = pairs.find(p => p.body.id === envelope.id);
        need(pair && pair.body.method === method && same(pair.body.params, params) && pair.raw.equals(members.get(response)));
      }
      requestFor(d.history.genesis, 'getGenesisHash', []);
      requestFor(d.history.slot, 'getSlot', [{ commitment: 'finalized' }]);
      requestFor(d.history.block, 'getBlock', [JSON.parse(members.get(d.history.slot)).result,
        { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
      for (const [field, programId] of [['classic', control.mandate.wallet_scope.token_program], ['token_2022', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']]) {
        requestFor(d.ending[field], 'getTokenAccountsByOwner', [control.mandate.wallet_scope.wallet, { programId },
          { encoding: 'base64', commitment: 'finalized', minContextSlot: d.ending.minimum_context_slot }]);
      }
      for (const tx of d.transactions) requestFor(tx.response, 'getTransaction', [tx.signature,
        { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
      validateSupervisedSetupSourceV1({ source, mandate: control.mandate, rpc_pairs: pairs,
        loaded: { parseMemberV1: name => JSON.parse(members.get(name)) } });
      for (const [i, pair] of pairs.entries()) {
        need(pair.body.id === `economic-${ordinal}-${i + 1}`
          && members.get(`economic-${ordinal}-${i + 1}-request.json`)?.equals(Buffer.from(pair.request.request_base64, 'base64'))
          && members.get(`economic-${ordinal}-${i + 1}-response.json`)?.equals(pair.raw));
      }
      if (same({ ...source.descriptor, selection: descriptor.selection }, descriptor)) {
        selectedSources++;
        for (const [name, bytes] of members) need(loaded.readMemberV1(name).equals(bytes));
      }
    }
  }
  need(selectedSources === 1);
  return records;
}
export function validateRetainedRpcPhaseV1(records, budget, phase, runtime_deadline_unix_seconds = null) {
  if (runtime_deadline_unix_seconds !== null) need(Number.isSafeInteger(runtime_deadline_unix_seconds) && runtime_deadline_unix_seconds > 0);
  const rows = records.map(r => r.record).filter(r => r?.version === 'artifact_supervised_rpc_attempt_v1' && r.phase === phase);
  let sequence = 0, current = null, origin = null, last = null; const counts = {}, pairs = [];
  for (const row of rows) {
    const response = row.stage === 'RESPONSE_DURABLE';
    const keys = ['version', 'phase', 'ordinal', 'request_base64', 'request_sha256', 'started_monotonic_ms', 'started_unix_seconds', 'provider_retries', 'stage'];
    assertExactFields(row, [...keys, ...(response ? ['response_base64', 'response_sha256', 'completed_monotonic_ms', 'completed_unix_seconds'] : [])], 'retained_rpc_record');
    need(row.version === 'artifact_supervised_rpc_attempt_v1' && row.provider_retries === 0 && row.phase === phase);
    const bytes = Buffer.from(row.request_base64, 'base64'), body = JSON.parse(bytes);
    need(bytes.toString('base64') === row.request_base64 && hash(bytes) === row.request_sha256 && canonicalJson(body) === bytes.toString('utf8'));
    assertExactFields(body, ['jsonrpc', 'id', 'method', 'params'], 'retained_rpc_request');
    need(body.jsonrpc === '2.0' && Array.isArray(body.params) && Object.hasOwn(budget.methods, body.method));
    need(Number.isSafeInteger(row.started_monotonic_ms) && Number.isSafeInteger(row.started_unix_seconds));
    if (runtime_deadline_unix_seconds !== null) need(row.started_unix_seconds < runtime_deadline_unix_seconds
      && (!response || row.completed_unix_seconds < runtime_deadline_unix_seconds));
    if (!response) {
      need(row.stage === 'REQUEST_DURABLE_BEFORE_EFFECT' && current === null && row.ordinal === ++sequence && sequence <= budget.total_calls);
      counts[body.method] = (counts[body.method] ?? 0) + 1; need(counts[body.method] <= budget.methods[body.method]);
      origin ??= row.started_monotonic_ms;
      need((last === null || row.started_monotonic_ms >= last) && row.started_monotonic_ms - origin < budget.overall_timeout_ms);
      current = row;
    } else {
      need(current !== null && same(Object.fromEntries(keys.filter(k => k !== 'stage').map(k => [k, row[k]])),
        Object.fromEntries(keys.filter(k => k !== 'stage').map(k => [k, current[k]]))));
      need(Number.isSafeInteger(row.completed_monotonic_ms) && Number.isSafeInteger(row.completed_unix_seconds)
        && row.completed_unix_seconds >= row.started_unix_seconds && row.completed_monotonic_ms >= row.started_monotonic_ms
        && row.completed_monotonic_ms - row.started_monotonic_ms < budget.call_timeout_ms && row.completed_monotonic_ms - origin < budget.overall_timeout_ms);
      const raw = Buffer.from(row.response_base64, 'base64');
      need(raw.toString('base64') === row.response_base64 && raw.length <= budget.max_response_bytes && hash(raw) === row.response_sha256);
      last = row.completed_monotonic_ms; pairs.push({ request: current, response: row, body, raw }); current = null;
    }
  }
  return { pairs, unfinished: current };
}
export async function validateRetainedSimulationV1({ loaded, control, leg, plan, capture }) {
  const records = loadRetainedSupervisionV1(loaded, control), ordinal = leg.challenge.ordinal;
  need(same(capture.budget, control.supervision.phase_budgets.capture));
  const deadline = control.version === 'artifact_retained_control_v3' ? control.runtime_deadline_unix_seconds : null;
  const { pairs, unfinished } = validateRetainedRpcPhaseV1(records.filter(r => r.kind === 'simulation_rpc' && r.ordinal === ordinal), control.supervision.phase_budgets.simulation, 'simulation', deadline);
  const facts = records.filter(r => r.kind === 'simulation' && r.ordinal === ordinal).map(r => r.record);
  need(pairs.length === 1 && unfinished === null && facts.length === 1);
  const p = pairs[0], fact = facts[0];
  if (deadline !== null) need(Number.isSafeInteger(fact.started_unix_seconds) && Number.isSafeInteger(fact.completed_unix_seconds)
    && fact.started_unix_seconds >= control.authorization.issued_at_unix_seconds
    && fact.started_unix_seconds < deadline && fact.completed_unix_seconds < deadline);
  const fee = leg.record_members.map(m => loaded.parseMemberV1(m)).find(r => r.request.method === 'getFeeForMessage');
  const floor = JSON.parse(fee.raw_response).result.context.slot;
  need(fact.started_monotonic_ms <= p.request.started_monotonic_ms && fact.completed_monotonic_ms >= p.response.completed_monotonic_ms
    && fact.started_unix_seconds <= p.request.started_unix_seconds && fact.completed_unix_seconds >= p.response.completed_unix_seconds);
  let wall = fact.started_unix_seconds, mono = fact.started_monotonic_ms, rebuilt;
  await simulateExactPreparedMessageV1({ message: Buffer.from(plan.message_base64, 'base64'), expected_message_sha256: plan.message_sha256,
    minimum_context_slot: floor, challenge: leg.challenge,
    assertFresh: async () => need(wall < leg.challenge.expires_at_unix_seconds && (deadline === null || wall < deadline)),
    clock: { unixSeconds: () => wall, monotonicMs: () => mono }, async rpc({ body }) {
      need(same(body, p.body)); wall = fact.completed_unix_seconds; mono = fact.completed_monotonic_ms; return p.raw.toString('utf8');
    }, async retain(value) { rebuilt = value; } });
  need(same(rebuilt, fact));
}
export async function validateRetainedTerminalProjectionV1({ loaded, control, leg, state, source_context, tx }) {
  const records = loadRetainedSupervisionV1(loaded, control);
  const captureRecords = leg.record_members.map(m => loaded.parseMemberV1(m));
  const s = leg.signed_intent;
  const derived = await projectTrustedTerminalLegV1({ c: { mandate: control.mandate }, state,
    x: { episode_id: s.episode_id, row: { ordinal: 2, phase: 'DISPOSAL', transaction_signature: s.signature, signed_intent_digest: sha256CanonicalJson(s),
      signed_wire_sha256: s.signed_wire_sha256, message_sha256: s.message_sha256 } },
    source: { context: source_context, terminal_projection: { version: 'artifact_terminal_leg_projection_v1',
      acquisition_finalized: control.legs[0].finalized, opening_enumeration_port: await openingPortFromReadinessV1(control.mandate, captureRecords) } } });
  const retained = records.filter(r => r.kind === 'terminal_record' && r.record.projection);
  need(retained.length <= 1 && (leg.finalized === null || retained.length === 1));
  if (retained.length) need(same(retained[0].record.projection, derived.evidence));
}
