// Offline only. No executor/runtime state, transport, environment or wall clock is
// consulted. Source admission is separate from byte identity and claim issuance.
import { Message } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { assertExactFields, canonicalJson, cloneAndFreeze, sha256CanonicalJson } from '../contract.mjs';
import { acquireWalletHistoryV2 } from '../../wallet-acquisition/orchestrator.mjs';
import { createWalletHistoryPortV2 } from '../../wallet-acquisition/provider-port-v2.mjs';
import { validateHeliusFullTransactionV1 } from '../../wallet-acquisition/helius-full-transaction-validator.mjs';
import { validateHeliusRpcGenesisResponseV1, validateHeliusRpcSlotResponseV1, validateHeliusRpcBlockResponseV1, validateHeliusRpcSignaturePageResponseV1 } from '../../wallet-acquisition/helius-rpc-validator.mjs';
import { createEvidenceContextTranscriptPortV1 } from '../../wallet-acquisition/evidence-context-sidecar-v1.mjs';
import { createFrozenControlledHeliusTargetAccountEnumerationPortV2 } from '../../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import { buildSourceBoundAuthoritativeEvidenceContextV13, validateSourceBoundAuthoritativeEvidenceContextV13 } from '../authoritative-evidence-context.mjs';
import { createProductionPositionEconomicEvidencePortV13 } from '../production-position-economic-evidence-bridge-v1-3.mjs';
import { buildEpisodeCandidatePopulationV13, validateSourceBoundEpisodeCandidatePopulationV13 } from '../episode-candidate-population.mjs';
import { selectExplicitCandidateV13, validateSourceBoundExplicitCandidateSelectionV13 } from '../explicit-candidate-selection.mjs';
import { issueImmutablePositionClaimV13, validateSourceBoundImmutablePositionClaimV13 } from '../immutable-claim-artifact.mjs';
import { inspectSignedLegacyWire } from './reused/bounded-rebroadcast-v1.mjs';
import { loadRetainedEpisodePackageV1, RetainedEpisodePackageError } from './retained-episode-package-v1.mjs';
import { loadRetainedControlV1, evaluateRetainedControlV1 } from './retained-final-control-v1.mjs';
import { OFFLINE_WALLET_SCOPE_V1 } from './executor-mandate-profile-v1.mjs';
import { admitSupervisedHistoryV1 } from './supervised-history-v1.mjs';

const HASH = b => createHash('sha256').update(b).digest('hex');
const CALIBRATION_WALLET = '6nHvRF1wK9T4wdnbSZES4mrAfKfJPkVX5wrHqhbkDBgs';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const POOL = '4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TX_PINS = ['52ca7d50c18e24cbf519986fa13c8b9f79c7ca38dfa523dc333bfa896d5a17aa', '910e71083f3743a135bcc1d6ef1ddcb19855d4eb3a36c33c833e29e547508754'];
function stop(code) { throw new RetainedEpisodePackageError(code); }
function rpc(loaded, path) {
  const value = loaded.parseMemberV1(path);
  assertExactFields(value, ['jsonrpc', 'id', 'result'], 'retained_rpc');
  if (value.jsonrpc !== '2.0' || !(typeof value.id === 'string' || Number.isSafeInteger(value.id))) stop('REPLAY_RPC_INVALID');
  return value;
}
function v1(envelope) { return { ...envelope, id: 'wallet-acquisition-v1' }; }
function descriptor(loaded, kind) {
  const d = loaded.parseMemberV1('episode.json');
  assertExactFields(d, ['version', 'evidence_kind', 'scope', 'acquisition_request', 'history', 'transactions', 'opening', 'ending', 'selection', 'control'], 'episode_replay');
  const wallets = { CALIBRATION_TRANSACTIONS_SYNTHETIC_BOUNDARIES: CALIBRATION_WALLET,
    SYNTHETIC_FINAL_EPISODE: OFFLINE_WALLET_SCOPE_V1.wallet,
    SUPERVISED_RETAINED_FINAL_EPISODE: '5CJdSbz9d5CifzFcWL5NcbicgpSAEuDGpSZBgaLHN1tA' };
  if (d.evidence_kind !== kind || !Object.hasOwn(wallets, kind)
      || !(kind === 'CALIBRATION_TRANSACTIONS_SYNTHETIC_BOUNDARIES' ? ['artifact_final_episode_replay_v1']
        : ['artifact_final_episode_replay_v2', 'artifact_final_episode_replay_v3']).includes(d.version)) stop('REPLAY_SOURCE_ADMISSION_UNAVAILABLE');
  assertExactFields(d.scope, ['wallet', 'target_mint', 'exact_quote_mint', 'route_program', 'route_pool'], 'episode_scope');
  if (d.scope.wallet !== wallets[kind] || d.scope.target_mint !== JUP || d.scope.exact_quote_mint !== USDC
      || d.scope.route_program !== PROGRAM || d.scope.route_pool !== POOL || d.acquisition_request.wallet !== d.scope.wallet) stop('REPLAY_SCOPE_MISMATCH');
  assertExactFields(d.history, ['genesis', 'slot', 'block', 'pages', ...(d.version.endsWith('_v3') ? ['admission'] : [])], 'episode_history');
  if (!Array.isArray(d.transactions) || d.transactions.length > 2 || (d.version.endsWith('_v1') && d.transactions.length < 1)
      || !Array.isArray(d.history.pages) || !d.history.pages.length || d.history.pages.length > 100) stop('REPLAY_POPULATION_INVALID');
  return d;
}
export async function buildRetainedFinalizedSourceV1(loaded, d, control) {
  const network = validateHeliusRpcGenesisResponseV1(v1(rpc(loaded, d.history.genesis)));
  const slot = validateHeliusRpcSlotResponseV1(v1(rpc(loaded, d.history.slot)));
  const block = validateHeliusRpcBlockResponseV1(v1(rpc(loaded, d.history.block)), slot);
  if (block === null) stop('REPLAY_ANCHOR_UNAVAILABLE');
  const pages = d.history.pages.map(path => validateHeliusRpcSignaturePageResponseV1(v1(rpc(loaded, path))));
  if (!d.version.endsWith('_v3') && (pages.at(-1).length >= 100 || pages.slice(0, -1).some(p => p.length !== 100))) stop('REPLAY_HISTORY_INCOMPLETE');
  const reconciliation = [];
  const transactions = d.transactions.map((item, i) => {
    assertExactFields(item, ['signature', 'response'], 'episode_transaction');
    const bytes = loaded.readMemberV1(item.response);
    if (d.version.endsWith('_v1') && HASH(bytes) !== TX_PINS[i]) stop('REPLAY_CALIBRATION_SOURCE_MISMATCH');
    const raw = rpc(loaded, item.response).result;
    if (!Array.isArray(raw.transaction) || raw.transaction.length !== 2 || raw.transaction[1] !== 'base64') stop('REPLAY_WIRE_FORMAT_INVALID');
    const inspected = inspectSignedLegacyWire(raw.transaction[0]);
    const wire = inspected.wire, message = Message.from(inspected.message);
    const normalized = validateHeliusFullTransactionV1({ ...raw, transaction: {
      signatures: [inspected.expectedSignature], message: { header: message.header,
        accountKeys: message.accountKeys.map(k => k.toBase58()), recentBlockhash: message.recentBlockhash, instructions: message.instructions },
    } }, item.signature);
    if (inspected.expectedSignature !== normalized.signature || normalized.fee_payer !== d.scope.wallet
        || normalized.instructions.length !== 1 || normalized.instructions[0].program_id !== d.scope.route_program
        || normalized.instructions[0].accounts[2] !== d.scope.route_pool) stop('REPLAY_TRANSACTION_MISMATCH');
    reconciliation.push({ signature: normalized.signature, slot: normalized.slot, block_time: normalized.block_time,
      finalized_execution_state: normalized.execution_state, full_transaction_digest: sha256CanonicalJson(normalized),
      signed_wire_sha256: HASH(wire), message_sha256: HASH(inspected.message), signature_verified: true,
      wire_evidence: 'EXACT_SIGNED_LEGACY_WIRE_IN_RETAINED_FINALIZED_RESPONSE', source_member: item.response });
    return normalized;
  });
  const descending = [...transactions].reverse();
  const admission = d.version.endsWith('_v3') ? admitSupervisedHistoryV1({ loaded, descriptor: d, control,
    anchor_slot: slot, anchor_block_time: block.block_time, transactions }) : null;
  const indexed = admission === null ? pages.flat() : admission.admitted;
  if (indexed.length !== transactions.length || canonicalJson(indexed) !== canonicalJson(descending.map(({ signature, slot, block_time, execution_state }) => ({ signature, slot, block_time, execution_state })))) stop('REPLAY_HISTORY_TRANSACTION_MISMATCH');
  // Admission accounts for every original row in all three lanes. Only its
  // checked economic view enters the swap pipeline; original pages stay intact.
  const acquisitionPages = admission === null ? pages : [indexed];
  const rawPort = {
    async getNetworkIdentityV1() { return network; }, async getFinalizedSlotV1() { return slot; },
    async getFinalizedBlockV1(input) { if (input.slot !== slot) stop('REPLAY_REQUEST_UNAVAILABLE'); return block; },
    async getFinalizedWalletSignaturePageV1(input) {
      const index = input.before === null ? 0 : acquisitionPages.findIndex(p => p.at(-1)?.signature === input.before) + 1;
      if (input.wallet !== d.scope.wallet || index < 0 || index >= acquisitionPages.length) stop('REPLAY_REQUEST_UNAVAILABLE');
      return acquisitionPages[index];
    },
    async getFinalizedFullTransactionPageV1(input) {
      if (input.wallet !== d.scope.wallet || input.pagination_token !== null || input.anchor_slot !== slot) stop('REPLAY_REQUEST_UNAVAILABLE');
      return { transactions: descending, pagination_token: null };
    },
    async getFinalizedTransactionV1() { stop('REPLAY_FALLBACK_FORBIDDEN'); },
  };
  const acquired = await acquireWalletHistoryV2(d.acquisition_request, { walletHistoryPort: createWalletHistoryPortV2(rawPort, { beginAcquisitionV2() {} }) });
  const transcript = createEvidenceContextTranscriptPortV1({ async getAuthoritativeTransactionTranscriptV1() {
    return { authoritative_population: indexed, full_transactions: descending };
  } });
  async function boundary(name, kind) {
    const b = d[name]; assertExactFields(b, ['minimum_context_slot', 'classic', 'token_2022'], 'episode_boundary');
    return createFrozenControlledHeliusTargetAccountEnumerationPortV2({ wallet: d.scope.wallet, target_mint: d.scope.target_mint,
      boundary_kind: kind, minimum_context_slot: b.minimum_context_slot }, {
      clock: () => 0, sleep: async () => { stop('REPLAY_BOUNDARY_RETRY_FORBIDDEN'); },
      async request({ body }) {
        if (body.method !== 'getTokenAccountsByOwner') stop('REPLAY_BOUNDARY_REQUEST_UNAVAILABLE');
        const path = body.params[1].programId === TOKEN ? b.classic : b.token_2022;
        return { status: 200, data: { ...rpc(loaded, path), id: body.id }, raw_body_sha256: HASH(loaded.readMemberV1(path)) };
      },
    });
  }
  const authority = { transaction_transcript_port: transcript, legacy_acquisition_result: acquired,
    opening_enumeration_port: await boundary('opening', 'OPENING'), ending_enumeration_port: await boundary('ending', 'ENDING_AS_OF'),
    target_mint: d.scope.target_mint, opening_basis_reference: null };
  const context = await buildSourceBoundAuthoritativeEvidenceContextV13(authority);
  await validateSourceBoundAuthoritativeEvidenceContextV13({ context, ...authority });
  return { context, authority, acquired, reconciliation, transactions, admission };
}
export async function reconstructFinalEpisodeReleaseV1(input) {
  assertExactFields(input, ['root', 'expected_manifest_sha256', 'expected_evidence_kind'], 'episode_release_input');
  const loaded = loadRetainedEpisodePackageV1({ root: input.root, expected_manifest_sha256: input.expected_manifest_sha256 });
  const d = descriptor(loaded, input.expected_evidence_kind);
  const control = !d.version.endsWith('_v1') ? loadRetainedControlV1(loaded, d.control) : null;
  const captured = await buildRetainedFinalizedSourceV1(loaded, d, control);
  let economic = null, unavailable = null;
  try {
    economic = await createProductionPositionEconomicEvidencePortV13({ evidence_context: captured.context, context_authority: captured.authority, exact_quote_mint: d.scope.exact_quote_mint });
  } catch (error) {
    // These are explicit existing profile limits, not evaluated BLOCKED claims.
    // Unexpected exceptions and selection/issuance errors retain their own type.
    if (d.version.endsWith('_v1') || error?.name !== 'VerificationScopeError'
        || !['position_economic_controlled_boundary_invalid', 'position_economic_controlled_population_invalid', 'position_economic_transaction_unsupported'].includes(error.code)) throw error;
    unavailable = { code: error.code, detail: error.message };
  }
  const populationInput = { context: captured.context, context_authority: captured.authority, exact_quote_mint: d.scope.exact_quote_mint, economic_evidence_port: economic };
  const population = economic === null ? null : await buildEpisodeCandidatePopulationV13(populationInput);
  if (population !== null) await validateSourceBoundEpisodeCandidatePopulationV13({ population, ...populationInput });
  const selectionSource = { population, ...populationInput };
  let selection = null, claim = null;
  if (d.selection !== null && population !== null) {
    selection = await selectExplicitCandidateV13({ request: d.selection, source: selectionSource });
    await validateSourceBoundExplicitCandidateSelectionV13({ result: selection, request: d.selection, source: selectionSource });
    if (selection.status === 'SELECTED_VERIFIED') {
      claim = await issueImmutablePositionClaimV13({ request: d.selection, source: selectionSource });
      await validateSourceBoundImmutablePositionClaimV13({ artifact: claim, request: d.selection, source: selectionSource });
    }
  }
  const result = {
    version: 'artifact_final_episode_release_v1', operation: { status: 'COMPLETED' },
    input_identity: { manifest_sha256: loaded.manifest_sha256 }, scope: d.scope,
    integrity: { status: 'VERIFIED' }, source_admission: { evidence_kind: d.evidence_kind,
      status: 'CALIBRATION_ONLY', authority: 'RETAINED_REAL_TRANSACTIONS_WITH_SYNTHETIC_HISTORY_AND_BOUNDARIES' },
    evidence_inventory: loaded.inventory, acquisition: captured.acquired, evidence_context: captured.context,
    population, selection, claim, transaction_reconciliation: captured.reconciliation,
    control: { status: d.control === null ? 'MISSING' : 'NOT_ADMITTED' },
    transmission: { status: 'NOT_ESTABLISHED', economic_authority: 'NONE' },
    demonstration: { eligible: false, limitations: ['NOT_THE_FINAL_AGENT_DIRECTED_EPISODE', 'SYNTHETIC_HISTORY_AND_BOUNDARIES', 'AUTHENTICATED_RUNTIME_DIRECTION_NOT_ESTABLISHED', 'TRANSMISSION_NOT_ESTABLISHED'] },
    demo_summary: { version: 'artifact_episode_demo_summary_v1', evidence_kind: d.evidence_kind,
      manifest_sha256: loaded.manifest_sha256, claim_digest: claim?.claim_artifact_digest ?? null,
      claim_outcome: claim?.claim_evaluation.claim_outcome ?? null, position_state: claim?.claim_evaluation.position_state ?? null,
      full_demonstration_success: false,
      public_wording: 'Artifact reconstructed retained calibration transactions with synthetic history and boundaries. This is not the final episode and does not establish direction by the trusted executor or authenticated agent control.' },
    verification: { procedure: 'Import reconstructFinalEpisodeReleaseV1; supply explicit root, expected_manifest_sha256 and expected_evidence_kind. Preserve episode.json selection; never infer a singleton selection.',
      source_truth: 'Checksums bind bytes, not provider truth. This profile admits only the pinned calibration transaction bodies. History and boundary evidence are synthetic and cannot establish final-demo eligibility.',
      live_authorization: 'NONE' },
  };
  if (!d.version.endsWith('_v1')) {
    result.economic_availability = { status: unavailable === null ? 'AVAILABLE' : 'UNAVAILABLE',
      dependencies: unavailable === null ? [] : [unavailable], selection_request: d.selection,
      evaluator_outcome: claim?.claim_evaluation.claim_outcome ?? null };
    result.economic_observations = { opening_target_raw_quantity: captured.context.opening_snapshot.aggregate_raw_quantity,
      ending_target_raw_quantity: captured.context.ending_snapshot.aggregate_raw_quantity,
      transactions: captured.transactions.map(t => ({ signature: t.signature, execution_state: t.execution_state,
        fee_lamports: t.fee_lamports, pre_token_balances: t.pre_token_balances, post_token_balances: t.post_token_balances })) };
    const assessed = await evaluateRetainedControlV1({ loaded, control, descriptor: d, transactions: captured.transactions, reconciliation: captured.reconciliation,
      source_context: captured.context });
    Object.assign(result, assessed);
    const synthetic = d.evidence_kind === 'SYNTHETIC_FINAL_EPISODE';
    result.source_admission = { evidence_kind: d.evidence_kind, status: 'ADMITTED',
      authority: synthetic ? 'EXPLICIT_SYNTHETIC_PROVIDER_FIXTURE' : 'SUPERVISED_RETAINED_PROVIDER_ATTESTATION_NOT_PROVIDER_SIGNATURE',
      custody_assumption: 'Expected package identity and source classification supplied by trusted administrator; hashes do not establish provider truth.' };
    const complete = assessed.eligibility.status === 'ELIGIBLE' && assessed.eligibility.legs.length === 2
      && assessed.control.status === 'AUTHENTICATED' && assessed.control.state?.state === 'DISPOSAL_EVIDENCE_CLOSED'
      && assessed.transmission.status === 'RECONCILED' && assessed.transmission.legs.length === 2
      && claim?.claim_evaluation.claim_outcome === 'VERIFIED' && claim.claim_evaluation.position_state === 'CLOSED';
    result.demonstration = { eligible: complete, contract_satisfied: complete, synthetic,
      limitations: synthetic ? ['SYNTHETIC_ONLY_NOT_AN_ONCHAIN_FINAL_EPISODE'] : ['SUPERVISED_PROVIDER_AND_EXECUTOR_CUSTODY_ASSUMPTIONS'] };
    result.demo_summary = { ...result.demo_summary, full_demonstration_success: complete && !synthetic,
      synthetic_demonstration_success: complete && synthetic, authorization_provenance: assessed.control.status,
      original_eligibility: assessed.eligibility.status, transmission_reconciliation: assessed.transmission.status,
      public_wording: synthetic ? 'Offline synthetic episode evidence was independently replayed. No onchain occurrence or live final demonstration is asserted.'
        : complete ? 'Retained evidence supports the bounded final demonstration under the stated supervised provider and executor custody assumptions.'
          : 'Retained economic evidence was reconstructed; a complete authorized agent-directed final demonstration is not established.' };
    result.verification.source_truth = 'Explicit-root, administrator-qualified retained provider evidence, not independent provider authentication. Synthetic and final-wallet profiles are disjoint. Original opening predicates are re-evaluated from retained request/response bytes.';
  }
  if (captured.admission !== null) result.history_admission = captured.admission;
  return cloneAndFreeze({ ...result, release_digest: sha256CanonicalJson(result) });
}
