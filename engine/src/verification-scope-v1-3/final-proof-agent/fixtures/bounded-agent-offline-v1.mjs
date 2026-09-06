import { PublicKey } from '@solana/web3.js';

import { acquireWalletHistoryV2 } from '../../../wallet-acquisition/orchestrator.mjs';
import { createWalletHistoryPortV2 } from '../../../wallet-acquisition/provider-port-v2.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from '../../../wallet-acquisition/request-contract.mjs';
import { createEvidenceContextTranscriptPortV1 } from '../../../wallet-acquisition/evidence-context-sidecar-v1.mjs';
import { createFrozenControlledHeliusTargetAccountEnumerationPortV2 } from '../../../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import { buildSourceBoundAuthoritativeEvidenceContextV13 } from '../../authoritative-evidence-context.mjs';
import { buildEpisodeCandidatePopulationV13 } from '../../episode-candidate-population.mjs';
import { computeCandidateMemberDigestV13, selectExplicitCandidateV13 } from '../../explicit-candidate-selection.mjs';
import { issueImmutablePositionClaimV13 } from '../../immutable-claim-artifact.mjs';
import { createProductionPositionEconomicEvidencePortV13 } from '../../production-position-economic-evidence-bridge-v1-3.mjs';
import { controlledMainnetCalibrationTransactionsV1 } from '../../fixtures/controlled-mainnet-calibration-round-trip-v1.mjs';
import { sha256CanonicalJson } from '../../contract.mjs';
import { buildFinalizedLegEvidenceV1, buildEpisodeEvidenceGraphV1, buildReconstructionEvidenceV1, buildTransmissionEvidenceV1 } from '../episode-evidence-graph-v1.mjs';
import { closeFinalizedLegV1, createAuthorizedEpisodeStateV1 } from '../episode-state-machine-v1.mjs';
import { createOfflineBoundedExecutorCoreV1 } from '../offline-executor-core-v1.mjs';
import { createOfflineFinalizedEvidencePortV1 } from '../finalized-evidence-adapter-v1.mjs';
import { buildFixedTestAgentDecisionV1, buildFixedTestAuthorizationV1, buildFixedTestChallengeV1, buildFixedTestMandateV1 } from './fixed-test-identities-v1.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const OLD_WALLET = '6nHvRF1wK9T4wdnbSZES4mrAfKfJPkVX5wrHqhbkDBgs';
const OLD_QUOTE_ACCOUNT = '5DTAMqHM14qZmkmHDmKq1b6EkCdohVd28QqsQ67WDLjJ';
const OLD_TARGET_ACCOUNT = '88RjLVrrgiowBs7ZG4NqSGhVSsqBZFVVXuMnnpWdwmr6';

function replaceStrings(value, substitutions) {
  if (typeof value === 'string') return substitutions.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => replaceStrings(item, substitutions));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item, substitutions)]));
  }
  return value;
}
function finalProofTransactions(mandate) {
  const substitutions = new Map([
    [OLD_WALLET, mandate.wallet_scope.wallet],
    [OLD_QUOTE_ACCOUNT, mandate.wallet_scope.usdc_ata],
    [OLD_TARGET_ACCOUNT, mandate.wallet_scope.jup_ata],
  ]);
  return controlledMainnetCalibrationTransactionsV1().map((transaction, index) => {
    const transformed = replaceStrings(transaction, substitutions);
    transformed.block_time = index === 0 ? 1900000100 : 1900001100;
    return transformed;
  });
}
function targetAccountData(mandate) {
  const data = Buffer.alloc(165);
  new PublicKey(mandate.asset_scope.jup_mint).toBuffer().copy(data, 0);
  new PublicKey(mandate.wallet_scope.wallet).toBuffer().copy(data, 32);
  data[108] = 1;
  return data;
}
async function enumerationPort(mandate, boundaryKind, slot) {
  const data = targetAccountData(mandate);
  return createFrozenControlledHeliusTargetAccountEnumerationPortV2({
    wallet: mandate.wallet_scope.wallet, target_mint: mandate.asset_scope.jup_mint,
    boundary_kind: boundaryKind, minimum_context_slot: slot,
  }, {
    clock: () => 0, sleep: async () => {},
    async request({ body }) {
      const rows = body.params[1].programId === TOKEN_PROGRAM ? [{
        pubkey: mandate.wallet_scope.jup_ata,
        account: { data: [data.toString('base64'), 'base64'], executable: false, lamports: 2_039_280, owner: TOKEN_PROGRAM, rentEpoch: 0, space: data.length },
      }] : [];
      return {
        status: 200,
        data: { jsonrpc: '2.0', id: body.id, result: { context: { slot }, value: rows } },
        raw_body_sha256: boundaryKind === 'OPENING' ? 'b'.repeat(64) : 'c'.repeat(64),
      };
    },
  });
}
function acquisitionRequest(mandate) {
  return {
    request_version: 'wallet_wide_acquisition_request_v2', chain: 'solana', network: 'mainnet-beta',
    genesis_hash: SOLANA_MAINNET_GENESIS_HASH, wallet: mandate.wallet_scope.wallet,
    window: { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1', requested_lookback_seconds: 2_592_000, initial_before_signature: null },
    finality: { commitment: 'finalized', boundary_profile: 'solana_finalized_anchor_v1', max_anchor_search_slots: 32 },
    budgets: { pagination_profile: 'solana_full_transaction_page_100_v1', page_size: 100, max_pages: 100, max_transactions: 10_000, retry_profile: 'bounded_exponential_retry_v1', max_attempts_per_operation: 8, timeout_profile: 'bounded_provider_timeout_v1', request_timeout_ms: 60_000, overall_timeout_ms: 300_000, exact_fallback_profile: 'finalized_get_transaction_missing_only_v1', max_exact_fallback_transactions: 0 },
    profiles: { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1' },
  };
}
async function createSyntheticFinalizedAuthority(mandate) {
  const transactions = finalProofTransactions(mandate);
  const descending = [...transactions].reverse();
  const sources = descending.map(({ signature, slot, block_time, execution_state }) => ({ signature, slot, block_time, execution_state }));
  const rawPort = {
    async getNetworkIdentityV1() { return { chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH }; },
    async getFinalizedSlotV1() { return 444223891; },
    async getFinalizedBlockV1({ slot }) { return { slot, block_time: 1900001200, blockhash: '11111111111111111111111111111111', commitment: 'finalized' }; },
    async getFinalizedWalletSignaturePageV1() { return structuredClone(sources); },
    async getFinalizedFullTransactionPageV1() { return { transactions: structuredClone(descending), pagination_token: null }; },
    async getFinalizedTransactionV1() { throw new TypeError('bounded-agent offline fixture forbids fallback'); },
  };
  const legacyAcquisitionResult = await acquireWalletHistoryV2(acquisitionRequest(mandate), {
    walletHistoryPort: createWalletHistoryPortV2(rawPort, { beginAcquisitionV2() {} }),
  });
  const transcriptPort = createEvidenceContextTranscriptPortV1({
    async getAuthoritativeTransactionTranscriptV1() {
      return { authoritative_population: structuredClone(sources), full_transactions: structuredClone(descending) };
    },
  });
  const contextAuthority = {
    transaction_transcript_port: transcriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
    opening_enumeration_port: await enumerationPort(mandate, 'OPENING', 444006969),
    ending_enumeration_port: await enumerationPort(mandate, 'ENDING_AS_OF', 444223890),
    target_mint: mandate.asset_scope.jup_mint,
    opening_basis_reference: null,
  };
  const context = await buildSourceBoundAuthoritativeEvidenceContextV13(contextAuthority);
  return { context, context_authority: contextAuthority, exact_quote_mint: mandate.asset_scope.usdc_mint, transactions };
}
async function runExistingPipeline(authority) {
  const economicEvidencePort = await createProductionPositionEconomicEvidencePortV13({
    evidence_context: authority.context, context_authority: authority.context_authority,
    exact_quote_mint: authority.exact_quote_mint,
  });
  const populationInput = { context: authority.context, context_authority: authority.context_authority, exact_quote_mint: authority.exact_quote_mint, economic_evidence_port: economicEvidencePort };
  const population = await buildEpisodeCandidatePopulationV13(populationInput);
  if (population.episode_dispositions.length !== 1) throw new TypeError('offline bounded-agent fixture requires exactly one episode');
  const row = population.episode_dispositions[0];
  const requestedCandidateDigest = computeCandidateMemberDigestV13({ candidate_population_digest: population.population_digest, episode_disposition: row });
  const request = { candidate_population_digest: population.population_digest, requested_candidate_digest: requestedCandidateDigest };
  const source = { population, ...populationInput };
  const selection = await selectExplicitCandidateV13({ request, source });
  const claim = await issueImmutablePositionClaimV13({ request, source });
  return { economicEvidencePort, population, row, selection, claim };
}
function preparedFor(mandate, challenge, admission, authority) {
  const acquisition = challenge.phase === 'ACQUISITION';
  const transaction = authority.transactions[acquisition ? 0 : 1];
  return {
    prepared_transaction_version: 'artifact_bounded_agent_prepared_transaction_v1',
    episode_id: challenge.episode_id, phase: challenge.phase, admission_digest: admission.admission_digest,
    wallet: mandate.wallet_scope.wallet, pool: mandate.route_scope.pool,
    input_mint: acquisition ? mandate.asset_scope.usdc_mint : mandate.asset_scope.jup_mint,
    output_mint: acquisition ? mandate.asset_scope.jup_mint : mandate.asset_scope.usdc_mint,
    input_raw_quantity: acquisition ? mandate.economic_authority.acquisition_input_usdc_raw : challenge.chain_derived_disposal_jup_raw,
    maximum_slippage_bps: mandate.economic_authority.maximum_slippage_bps,
    transaction_profile: 'DIRECT_CLASSIC_ORCA_LEGACY_SWAP_V1',
    unsigned_transaction_digest: sha256CanonicalJson(transaction),
    readiness_evidence_digest: challenge.readiness_evidence_digest,
  };
}
async function buildBoundedAgentOfflineEpisodeFixtureV1(options = {}) {
  const mandate = buildFixedTestMandateV1();
  const authorization = buildFixedTestAuthorizationV1(mandate, options.episode_nonce_suffix ?? '');
  const authority = await createSyntheticFinalizedAuthority(mandate);
  const pipeline = await runExistingPipeline(authority);
  let signerCalls = 0;
  const consumedAuthority = new Set();
  const revokedEpisodes = new Set();
  const executor = createOfflineBoundedExecutorCoreV1({
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    decision_consumption_port: {
      async consumeEpisodeOrdinalV1({ episode_id, ordinal, decision_id, challenge_id }) {
        if (revokedEpisodes.has(episode_id)) return 'REVOKED';
        const keys = [`ordinal:${episode_id}:${ordinal}`, `decision:${decision_id}`, `challenge:${challenge_id}`];
        if (keys.some(key => consumedAuthority.has(key))) return 'ALREADY_CONSUMED';
        keys.forEach(key => consumedAuthority.add(key));
        return 'CONSUMED';
      },
      async revokeAuthorizationV1({ episode_id, predecessor_state }) {
        if (revokedEpisodes.has(episode_id)) return 'ALREADY_REVOKED';
        const hasAdmission = [...consumedAuthority].some(key => key.startsWith(`ordinal:${episode_id}:`));
        if ((predecessor_state === 'AUTHORIZED_DORMANT') === hasAdmission) return 'STATE_MISMATCH';
        revokedEpisodes.add(episode_id);
        return 'REVOKED';
      },
    },
    execution_port: { async prepareBoundedLegV1({ challenge, admission }) { return preparedFor(mandate, challenge, admission, authority); } },
    wallet_signer_port: { async signAdmittedTransactionV1({ admission, prepared_transaction: prepared }) {
      signerCalls += 1;
      const transaction = authority.transactions[prepared.phase === 'ACQUISITION' ? 0 : 1];
      return {
        signed_transaction_intent_version: 'artifact_bounded_agent_signed_transaction_intent_v1',
        episode_id: prepared.episode_id, phase: prepared.phase, admission_digest: admission.admission_digest,
        semantic_transaction_digest: prepared.unsigned_transaction_digest,
        message_sha256: sha256CanonicalJson({ transaction, kind: 'message' }),
        signed_wire_sha256: sha256CanonicalJson({ transaction, kind: 'signed-wire' }),
        signature: transaction.signature, sign_count: 1,
      };
    } },
  });
  let state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const acquisitionChallenge = buildFixedTestChallengeV1({ mandate, authorization, state, phase: 'ACQUISITION', nonce: `offline-acquisition-challenge-v1${options.episode_nonce_suffix ?? ''}` });
  const acquisitionDecision = buildFixedTestAgentDecisionV1(mandate, authorization, acquisitionChallenge);
  const acquisitionExecution = await executor.executeAgentDecisionV1({ state, mandate, authorization, challenge: acquisitionChallenge, decision: acquisitionDecision, now_unix_seconds: 1900000012 });
  const acquisitionTransmission = buildTransmissionEvidenceV1({
    episode_id: state.episode_id, phase: 'ACQUISITION', signed_intent_digest: acquisitionExecution.signed_transaction_intent_digest,
    signed_wire_sha256: acquisitionExecution.signed_transaction_intent.signed_wire_sha256,
    message_sha256: acquisitionExecution.signed_transaction_intent.message_sha256, signature: acquisitionExecution.signed_transaction_intent.signature,
    scheduler_profile: 'IDENTICAL_SIGNED_BYTES_BOUNDED_REBROADCAST_V1', maximum_client_sends: 3, actual_client_sends: 1, provider_retries: 0,
    send_wire_sha256s: [acquisitionExecution.signed_transaction_intent.signed_wire_sha256],
    closed_rebroadcast_evidence_sha256: sha256CanonicalJson({ phase: 'ACQUISITION', profile: 'OFFLINE_REVIEWED_SCHEDULER_EVIDENCE_V1' }),
    terminal_resolution_evidence_sha256: sha256CanonicalJson({ phase: 'ACQUISITION', classification: 'FINALIZED_SUCCESS' }),
    terminal_classification: 'FINALIZED_SUCCESS',
  });
  const acquisitionTx = authority.transactions[0];
  const acquisitionFinalized = buildFinalizedLegEvidenceV1({
    episode_id: state.episode_id, phase: 'ACQUISITION', signed_intent_digest: acquisitionExecution.signed_transaction_intent_digest,
    signed_wire_sha256: acquisitionExecution.signed_transaction_intent.signed_wire_sha256,
    message_sha256: acquisitionExecution.signed_transaction_intent.message_sha256, signature: acquisitionTx.signature,
    finalized_transaction_digest: sha256CanonicalJson(acquisitionTx), slot: acquisitionTx.slot, block_time: acquisitionTx.block_time,
    execution_status: 'SUCCEEDED', wallet: mandate.wallet_scope.wallet, input_mint: mandate.asset_scope.usdc_mint,
    output_mint: mandate.asset_scope.jup_mint, input_raw_quantity: '5000000', chain_derived_target_raw_quantity: '21437310',
  });
  state = closeFinalizedLegV1({ state: acquisitionExecution.state, phase: 'ACQUISITION', finalized_evidence_digest: acquisitionFinalized.finalized_evidence_digest, chain_derived_acquired_jup_raw: '21437310' });
  const disposalChallenge = buildFixedTestChallengeV1({ mandate, authorization, state, phase: 'DISPOSAL', nonce: `offline-disposal-challenge-v1${options.episode_nonce_suffix ?? ''}`, amount: '21437310' });
  const disposalDecision = buildFixedTestAgentDecisionV1(mandate, authorization, disposalChallenge);
  const disposalExecution = await executor.executeAgentDecisionV1({ state, mandate, authorization, challenge: disposalChallenge, decision: disposalDecision, now_unix_seconds: 1900001012 });
  const disposalTransmission = buildTransmissionEvidenceV1({
    episode_id: state.episode_id, phase: 'DISPOSAL', signed_intent_digest: disposalExecution.signed_transaction_intent_digest,
    signed_wire_sha256: disposalExecution.signed_transaction_intent.signed_wire_sha256,
    message_sha256: disposalExecution.signed_transaction_intent.message_sha256, signature: disposalExecution.signed_transaction_intent.signature,
    scheduler_profile: 'IDENTICAL_SIGNED_BYTES_BOUNDED_REBROADCAST_V1', maximum_client_sends: 3, actual_client_sends: 1, provider_retries: 0,
    send_wire_sha256s: [disposalExecution.signed_transaction_intent.signed_wire_sha256],
    closed_rebroadcast_evidence_sha256: sha256CanonicalJson({ phase: 'DISPOSAL', profile: 'OFFLINE_REVIEWED_SCHEDULER_EVIDENCE_V1' }),
    terminal_resolution_evidence_sha256: sha256CanonicalJson({ phase: 'DISPOSAL', classification: 'FINALIZED_SUCCESS' }),
    terminal_classification: 'FINALIZED_SUCCESS',
  });
  const disposalTx = authority.transactions[1];
  const disposalFinalized = buildFinalizedLegEvidenceV1({
    episode_id: state.episode_id, phase: 'DISPOSAL', signed_intent_digest: disposalExecution.signed_transaction_intent_digest,
    signed_wire_sha256: disposalExecution.signed_transaction_intent.signed_wire_sha256,
    message_sha256: disposalExecution.signed_transaction_intent.message_sha256, signature: disposalTx.signature,
    finalized_transaction_digest: sha256CanonicalJson(disposalTx), slot: disposalTx.slot, block_time: disposalTx.block_time,
    execution_status: 'SUCCEEDED', wallet: mandate.wallet_scope.wallet, input_mint: mandate.asset_scope.jup_mint,
    output_mint: mandate.asset_scope.usdc_mint, input_raw_quantity: '21437310', chain_derived_target_raw_quantity: '0',
  });
  state = closeFinalizedLegV1({ state: disposalExecution.state, phase: 'DISPOSAL', finalized_evidence_digest: disposalFinalized.finalized_evidence_digest });
  const episode = pipeline.row.episode;
  const reconstruction = buildReconstructionEvidenceV1({
    episode_id: state.episode_id, evidence_context_digest: authority.context.evidence_context_digest,
    transaction_population_digest: authority.context.transaction_population.population_evidence_digest,
    economic_evidence_digest: episode.economic_evidence_identity.economic_evidence_digest,
    position_episode_digest: episode.position_episode_digest,
    claim_evaluation_digest: pipeline.claim.claim_evaluation.evaluation_digest,
    population_digest: pipeline.population.population_digest,
    candidate_digest: pipeline.selection.selection_artifact.requested_candidate_digest,
    selection_digest: pipeline.selection.selection_artifact.selection_digest,
    immutable_claim_digest: pipeline.claim.claim_artifact_digest,
    claim_outcome: pipeline.claim.claim_evaluation.claim_outcome,
    position_state: pipeline.claim.claim_evaluation.position_state,
    transaction_bindings: [acquisitionTx, disposalTx].map((transaction, index) => ({
      phase: index === 0 ? 'ACQUISITION' : 'DISPOSAL', signature: transaction.signature,
      finalized_transaction_digest: sha256CanonicalJson(transaction),
    })),
    agent_provenance_authority: 'PROVENANCE_ONLY_NOT_ECONOMIC_AUTHORITY',
  });
  const evidenceGraph = buildEpisodeEvidenceGraphV1({
    mandate, authorization,
    acquisition: { readiness: acquisitionChallenge, decision: acquisitionDecision, admission: acquisitionExecution.admission, signed_transaction_intent: acquisitionExecution.signed_transaction_intent, signed_transaction_intent_digest: acquisitionExecution.signed_transaction_intent_digest, transmission: acquisitionTransmission, finalized: acquisitionFinalized },
    disposal: { readiness: disposalChallenge, decision: disposalDecision, admission: disposalExecution.admission, signed_transaction_intent: disposalExecution.signed_transaction_intent, signed_transaction_intent_digest: disposalExecution.signed_transaction_intent_digest, transmission: disposalTransmission, finalized: disposalFinalized },
    reconstruction,
    outcome: { status: 'CLAIM_VERIFIED_CLOSED', public_wording: 'An authorized agent-control runtime directed the bounded acquisition and disposal decisions; a constrained executor independently enforced the mandate and held the wallet key; Artifact independently reconstructed and verified the resulting onchain episode.' },
  });
  const finalizedEvidencePort = createOfflineFinalizedEvidencePortV1({ capture_authority: async () => ({ context: authority.context, context_authority: authority.context_authority, exact_quote_mint: authority.exact_quote_mint }) });
  return Object.freeze({
    mandate, authorization, evidence_graph: evidenceGraph, finalized_evidence_port: finalizedEvidencePort,
    context: authority.context, context_authority: authority.context_authority,
    economic_evidence_port: pipeline.economicEvidencePort, pipeline,
    signer_calls: signerCalls, terminal_state: state,
  });
}

let defaultFixturePromise;
export function createBoundedAgentOfflineEpisodeFixtureV1(options = {}) {
  if (Object.keys(options).length === 0) {
    defaultFixturePromise ??= buildBoundedAgentOfflineEpisodeFixtureV1();
    return defaultFixturePromise;
  }
  return buildBoundedAgentOfflineEpisodeFixtureV1(options);
}
