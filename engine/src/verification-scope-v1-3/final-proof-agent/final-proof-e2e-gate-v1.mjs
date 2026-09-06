import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { buildEpisodeCandidatePopulationV13, validateSourceBoundEpisodeCandidatePopulationV13 } from '../episode-candidate-population.mjs';
import { computeCandidateMemberDigestV13, selectExplicitCandidateV13, validateSourceBoundExplicitCandidateSelectionV13 } from '../explicit-candidate-selection.mjs';
import { issueImmutablePositionClaimV13, validateSourceBoundImmutablePositionClaimV13 } from '../immutable-claim-artifact.mjs';
import { captureFinalizedEvidenceAuthorityV1 } from './finalized-evidence-adapter-v1.mjs';
import { createBoundedAgentOfflineEpisodeFixtureV1 } from './fixtures/bounded-agent-offline-v1.mjs';
import { POLICY as REVIEWED_REBROADCAST_POLICY_V1 } from './reused/bounded-rebroadcast-v1.mjs';

export const BOUNDED_AGENT_FINAL_PROOF_GATE_VERSION_V1 = 'artifact_bounded_agent_final_proof_offline_gate_v1';
export const BOUNDED_AGENT_FINAL_PROOF_GATE_PROFILE_V1 = 'ARTIFACT_BOUNDED_AGENT_FINAL_PROOF_OFFLINE_E2E_V1';
export const BOUNDED_AGENT_FINAL_PROOF_GATE_RESULT_SHA256_V1 =
  'fe01703bb25a4a987b0f957c329dd71eb926c966beeac47da4bda884b63d8385';
const DIGEST = /^[0-9a-f]{64}$/;
const UNRESOLVED = Object.freeze([
  'REAL_HUMAN_AUTHORIZATION_PUBLIC_KEY',
  'REAL_AGENT_CONTROL_PUBLIC_KEY',
  'ACQUISITION_NOT_AFTER_UNIX_SECONDS',
  'LIVE_RPC_BUDGET_TABLE_SHA256',
  'FINAL_WIGGLES_EXECUTOR_RELEASE_SHA256',
]);
const RESULT_FIELDS = [
  'gate_result_version', 'gate_profile', 'mandate_id', 'mandate_digest',
  'authorization_id', 'authorization_digest', 'episode_id', 'episode_evidence_graph_id',
  'episode_evidence_graph_digest', 'evidence_context_digest', 'transaction_population_digest',
  'population_digest', 'selection_digest', 'immutable_claim_digest', 'claim_outcome',
  'position_state', 'agent_decision_count', 'wallet_sign_count', 'agent_provenance_authority',
  'economic_authority', 'public_wording', 'unresolved_live_readiness', 'assertions',
  'overall_status', 'gate_result_sha256',
];
const ASSERTION_FIELDS = [
  'human_authorization_bound', 'two_authenticated_agent_decisions_bound',
  'executor_admissions_bound', 'identical_byte_policy_bound', 'full_chain_derived_disposal_bound',
  'existing_v1_3_pipeline_only', 'immutable_claim_reconstructed', 'live_execution_blocked',
];
function preimage(value) {
  return Object.fromEntries(RESULT_FIELDS.filter(field => field !== 'gate_result_sha256').map(field => [field, value[field]]));
}
function validateBoundedAgentFinalProofGateResultStructureV1(value) {
  assertExactFields(value, RESULT_FIELDS, 'bounded_agent_final_proof_gate_result');
  assertExactFields(value.assertions, ASSERTION_FIELDS, 'bounded_agent_final_proof_gate_assertions');
  if (value.gate_result_version !== BOUNDED_AGENT_FINAL_PROOF_GATE_VERSION_V1
      || value.gate_profile !== BOUNDED_AGENT_FINAL_PROOF_GATE_PROFILE_V1
      || value.claim_outcome !== 'VERIFIED' || value.position_state !== 'CLOSED'
      || value.agent_decision_count !== 2 || value.wallet_sign_count !== 2
      || value.agent_provenance_authority !== 'PROVENANCE_ONLY_NOT_ECONOMIC_AUTHORITY'
      || value.economic_authority !== 'FINALIZED_ONCHAIN_EVIDENCE_THROUGH_EXISTING_V1_3_PIPELINE_ONLY'
      || value.overall_status !== 'PASS_OFFLINE_LIVE_BLOCKED'
      || Object.values(value.assertions).some(assertion => assertion !== true)
      || JSON.stringify(value.unresolved_live_readiness) !== JSON.stringify(UNRESOLVED)) {
    fail('bounded_agent_final_proof_gate_semantics_invalid', 'offline gate semantics are invalid');
  }
  for (const field of RESULT_FIELDS.filter(field => field.endsWith('_digest') || field.endsWith('_sha256'))) {
    if (typeof value[field] !== 'string' || !DIGEST.test(value[field])) fail('bounded_agent_final_proof_gate_identity_invalid', `${field} is invalid`);
  }
  if (value.gate_result_sha256 !== sha256CanonicalJson(preimage(value))) fail('bounded_agent_final_proof_gate_identity_invalid', 'gate result identity is invalid');
  return true;
}
export async function validateBoundedAgentFinalProofGateResultV1(value, {
  evidence_graph, finalized_evidence_port,
} = {}) {
  validateBoundedAgentFinalProofGateResultStructureV1(value);
  if (evidence_graph === undefined || finalized_evidence_port === undefined) {
    fail('bounded_agent_final_proof_gate_authority_missing', 'source-bound gate validation requires the evidence graph and finalized-evidence port');
  }
  const captured = await captureFinalizedEvidenceAuthorityV1({ finalized_evidence_port, evidence_graph });
  const populationInput = {
    context: captured.context,
    context_authority: captured.context_authority,
    exact_quote_mint: captured.exact_quote_mint,
    economic_evidence_port: captured.economic_evidence_port,
  };
  const population = await buildEpisodeCandidatePopulationV13(populationInput);
  await validateSourceBoundEpisodeCandidatePopulationV13({ population, ...populationInput });
  if (population.episode_dispositions.length !== 1) fail('bounded_agent_final_proof_population_cardinality', 'source validation requires exactly one reconstructed episode');
  const row = population.episode_dispositions[0];
  const requestedCandidateDigest = computeCandidateMemberDigestV13({
    candidate_population_digest: population.population_digest,
    episode_disposition: row,
  });
  const request = { candidate_population_digest: population.population_digest, requested_candidate_digest: requestedCandidateDigest };
  const source = { population, ...populationInput };
  const selection = await selectExplicitCandidateV13({ request, source });
  await validateSourceBoundExplicitCandidateSelectionV13({ result: selection, request, source });
  const claim = await issueImmutablePositionClaimV13({ request, source });
  await validateSourceBoundImmutablePositionClaimV13({ artifact: claim, request, source });
  const graph = evidence_graph;
  const mismatched = value.mandate_id !== graph.mandate.mandate_id
    || value.mandate_digest !== graph.mandate.mandate_digest
    || value.authorization_id !== graph.human_authorization.authorization_id
    || value.authorization_digest !== graph.human_authorization.authorization_digest
    || value.episode_id !== graph.episode_id
    || value.episode_evidence_graph_id !== graph.episode_evidence_graph_id
    || value.episode_evidence_graph_digest !== graph.episode_evidence_graph_digest
    || value.evidence_context_digest !== captured.context.evidence_context_digest
    || value.transaction_population_digest !== captured.context.transaction_population.population_evidence_digest
    || value.population_digest !== population.population_digest
    || value.selection_digest !== selection.selection_artifact.selection_digest
    || value.immutable_claim_digest !== claim.claim_artifact_digest
    || value.claim_outcome !== claim.claim_evaluation.claim_outcome
    || value.position_state !== claim.claim_evaluation.position_state
    || value.public_wording !== graph.outcome.public_wording
    || graph.reconstruction.evidence_context_digest !== captured.context.evidence_context_digest
    || graph.reconstruction.transaction_population_digest !== captured.context.transaction_population.population_evidence_digest
    || graph.reconstruction.economic_evidence_digest !== row.episode.economic_evidence_identity.economic_evidence_digest
    || graph.reconstruction.position_episode_digest !== row.episode.position_episode_digest
    || graph.reconstruction.claim_evaluation_digest !== claim.claim_evaluation.evaluation_digest
    || graph.reconstruction.population_digest !== population.population_digest
    || graph.reconstruction.candidate_digest !== selection.selection_artifact.requested_candidate_digest
    || graph.reconstruction.selection_digest !== selection.selection_artifact.selection_digest
    || graph.reconstruction.immutable_claim_digest !== claim.claim_artifact_digest;
  if (mismatched) fail('bounded_agent_final_proof_gate_source_mismatch', 'gate result differs from source-bound reconstruction');
  return true;
}
async function buildBoundedAgentFinalProofOfflineE2EGateV1() {
  const fixture = await createBoundedAgentOfflineEpisodeFixtureV1();
  const captured = await captureFinalizedEvidenceAuthorityV1({
    finalized_evidence_port: fixture.finalized_evidence_port,
    evidence_graph: fixture.evidence_graph,
  });
  const populationInput = {
    context: captured.context,
    context_authority: captured.context_authority,
    exact_quote_mint: captured.exact_quote_mint,
    economic_evidence_port: captured.economic_evidence_port,
  };
  const population = await buildEpisodeCandidatePopulationV13(populationInput);
  await validateSourceBoundEpisodeCandidatePopulationV13({ population, ...populationInput });
  if (population.episode_dispositions.length !== 1) fail('bounded_agent_final_proof_population_cardinality', 'offline gate requires exactly one reconstructed episode');
  const row = population.episode_dispositions[0];
  const requestedCandidateDigest = computeCandidateMemberDigestV13({
    candidate_population_digest: population.population_digest,
    episode_disposition: row,
  });
  const request = { candidate_population_digest: population.population_digest, requested_candidate_digest: requestedCandidateDigest };
  const source = { population, ...populationInput };
  const selection = await selectExplicitCandidateV13({ request, source });
  await validateSourceBoundExplicitCandidateSelectionV13({ result: selection, request, source });
  if (selection.status !== 'SELECTED_VERIFIED') fail('bounded_agent_final_proof_selection_refused', 'existing v1.3 selection refused the offline episode');
  const claim = await issueImmutablePositionClaimV13({ request, source });
  await validateSourceBoundImmutablePositionClaimV13({ artifact: claim, request, source });
  const reconstructed = await issueImmutablePositionClaimV13({ request, source });
  const graph = fixture.evidence_graph;
  if (graph.reconstruction.evidence_context_digest !== captured.context.evidence_context_digest
      || graph.reconstruction.transaction_population_digest !== captured.context.transaction_population.population_evidence_digest
      || graph.reconstruction.economic_evidence_digest !== row.episode.economic_evidence_identity.economic_evidence_digest
      || graph.reconstruction.position_episode_digest !== row.episode.position_episode_digest
      || graph.reconstruction.claim_evaluation_digest !== claim.claim_evaluation.evaluation_digest
      || graph.reconstruction.candidate_digest !== selection.selection_artifact.requested_candidate_digest
      || claim.claim_artifact_digest !== graph.reconstruction.immutable_claim_digest
      || selection.selection_artifact.selection_digest !== graph.reconstruction.selection_digest
      || population.population_digest !== graph.reconstruction.population_digest) {
    fail('bounded_agent_final_proof_reconstruction_drift', 'recaptured v1.3 reconstruction differs from the evidence graph');
  }
  const assertions = {
    human_authorization_bound: graph.human_authorization.authorization_digest === graph.acquisition.decision.authorization_digest,
    two_authenticated_agent_decisions_bound: graph.acquisition.decision.ordinal === 1 && graph.disposal.decision.ordinal === 2,
    executor_admissions_bound: graph.acquisition.admission.status === 'ADMITTED' && graph.disposal.admission.status === 'ADMITTED',
    identical_byte_policy_bound: [graph.acquisition, graph.disposal].every(leg =>
      leg.transmission.scheduler_profile === REVIEWED_REBROADCAST_POLICY_V1.id
      && leg.transmission.provider_retries === REVIEWED_REBROADCAST_POLICY_V1.providerMaxRetries
      && leg.transmission.maximum_client_sends === REVIEWED_REBROADCAST_POLICY_V1.maxClientSendAttempts),
    full_chain_derived_disposal_bound: graph.disposal.finalized.input_raw_quantity === graph.acquisition.finalized.chain_derived_target_raw_quantity,
    existing_v1_3_pipeline_only: graph.reconstruction.agent_provenance_authority === 'PROVENANCE_ONLY_NOT_ECONOMIC_AUTHORITY',
    immutable_claim_reconstructed: claim.claim_artifact_digest === reconstructed.claim_artifact_digest,
    live_execution_blocked: graph.mandate.unresolved_live_readiness.status === 'UNRESOLVED',
  };
  const result = {
    gate_result_version: BOUNDED_AGENT_FINAL_PROOF_GATE_VERSION_V1,
    gate_profile: BOUNDED_AGENT_FINAL_PROOF_GATE_PROFILE_V1,
    mandate_id: graph.mandate.mandate_id,
    mandate_digest: graph.mandate.mandate_digest,
    authorization_id: graph.human_authorization.authorization_id,
    authorization_digest: graph.human_authorization.authorization_digest,
    episode_id: graph.episode_id,
    episode_evidence_graph_id: graph.episode_evidence_graph_id,
    episode_evidence_graph_digest: graph.episode_evidence_graph_digest,
    evidence_context_digest: captured.context.evidence_context_digest,
    transaction_population_digest: captured.context.transaction_population.population_evidence_digest,
    population_digest: population.population_digest,
    selection_digest: selection.selection_artifact.selection_digest,
    immutable_claim_digest: claim.claim_artifact_digest,
    claim_outcome: claim.claim_evaluation.claim_outcome,
    position_state: claim.claim_evaluation.position_state,
    agent_decision_count: 2,
    wallet_sign_count: fixture.signer_calls,
    agent_provenance_authority: 'PROVENANCE_ONLY_NOT_ECONOMIC_AUTHORITY',
    economic_authority: 'FINALIZED_ONCHAIN_EVIDENCE_THROUGH_EXISTING_V1_3_PIPELINE_ONLY',
    public_wording: graph.outcome.public_wording,
    unresolved_live_readiness: [...UNRESOLVED],
    assertions,
    overall_status: Object.values(assertions).every(Boolean) ? 'PASS_OFFLINE_LIVE_BLOCKED' : 'FAIL',
    gate_result_sha256: '0'.repeat(64),
  };
  result.gate_result_sha256 = sha256CanonicalJson(preimage(result));
  validateBoundedAgentFinalProofGateResultStructureV1(result);
  return cloneAndFreeze(result);
}

let gateResultPromise;
export function runBoundedAgentFinalProofOfflineE2EGateV1() {
  gateResultPromise ??= buildBoundedAgentFinalProofOfflineE2EGateV1();
  return gateResultPromise;
}
