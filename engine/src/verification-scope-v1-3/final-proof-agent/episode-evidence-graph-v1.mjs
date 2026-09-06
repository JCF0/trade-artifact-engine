import { assertExactFields, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { validateAuthenticatedAgentDecisionV1 } from './agent-decision-v1.mjs';
import { validateExecutorAdmissionV1 } from './executor-admission-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { validateBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { validateReadinessChallengeV1 } from './readiness-challenge-v1.mjs';

export const EPISODE_EVIDENCE_GRAPH_VERSION_V1 = 'artifact_bounded_agent_episode_evidence_graph_v1';
const DIGEST = /^[0-9a-f]{64}$/;
const RAW = /^(?:0|[1-9][0-9]*)$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const SIGNED_FIELDS = [
  'signed_transaction_intent_version', 'episode_id', 'phase', 'admission_digest',
  'semantic_transaction_digest', 'message_sha256', 'signed_wire_sha256', 'signature', 'sign_count',
];
const TRANSMISSION_INPUT_FIELDS = [
  'episode_id', 'phase', 'signed_intent_digest', 'signed_wire_sha256', 'message_sha256', 'signature',
  'scheduler_profile', 'maximum_client_sends', 'actual_client_sends', 'provider_retries',
  'send_wire_sha256s', 'closed_rebroadcast_evidence_sha256', 'terminal_resolution_evidence_sha256',
  'terminal_classification',
];
const TRANSMISSION_FIELDS = [
  'transmission_evidence_version', 'transmission_id', 'transmission_digest', ...TRANSMISSION_INPUT_FIELDS,
];
const FINALIZED_INPUT_FIELDS = [
  'episode_id', 'phase', 'signed_intent_digest', 'signed_wire_sha256', 'message_sha256', 'signature',
  'finalized_transaction_digest', 'slot', 'block_time', 'execution_status', 'wallet',
  'input_mint', 'output_mint', 'input_raw_quantity', 'chain_derived_target_raw_quantity',
];
const FINALIZED_FIELDS = [
  'finalized_leg_evidence_version', 'finalized_evidence_id', 'finalized_evidence_digest', ...FINALIZED_INPUT_FIELDS,
];
const LEG_FIELDS = [
  'readiness', 'decision', 'admission', 'signed_transaction_intent',
  'signed_transaction_intent_digest', 'transmission', 'finalized',
];
const RECONSTRUCTION_INPUT_FIELDS = [
  'episode_id', 'evidence_context_digest', 'transaction_population_digest', 'economic_evidence_digest',
  'position_episode_digest', 'claim_evaluation_digest', 'population_digest', 'candidate_digest',
  'selection_digest', 'immutable_claim_digest', 'claim_outcome', 'position_state',
  'transaction_bindings', 'agent_provenance_authority',
];
const RECONSTRUCTION_FIELDS = [
  'reconstruction_evidence_version', 'reconstruction_id', 'reconstruction_digest',
  ...RECONSTRUCTION_INPUT_FIELDS,
];
const TX_BINDING_FIELDS = ['phase', 'signature', 'finalized_transaction_digest'];
const OUTCOME_FIELDS = ['status', 'public_wording'];
const MEMBER_FIELDS = ['path', 'sha256'];
const MANIFEST_FIELDS = ['manifest_version', 'episode_id', 'member_count', 'members', 'manifest_digest'];
const GRAPH_FIELDS = [
  'episode_evidence_graph_version', 'episode_evidence_graph_id', 'episode_evidence_graph_digest',
  'episode_id', 'mandate', 'human_authorization', 'acquisition', 'disposal',
  'reconstruction', 'outcome', 'manifest',
];
const PUBLIC_WORDING = 'An authorized agent-control runtime directed the bounded acquisition and disposal decisions; a constrained executor independently enforced the mandate and held the wallet key; Artifact independently reconstructed and verified the resulting onchain episode.';
function digestPreimage(value, fields, identityFields) {
  return Object.fromEntries(fields.filter(field => !identityFields.includes(field)).map(field => [field, value[field]]));
}
function requireDigest(value, context) { if (typeof value !== 'string' || !DIGEST.test(value)) fail('bounded_agent_episode_evidence_identity_invalid', `${context} is invalid`); }
function issueRecord(input, inputFields, fields, versionField, versionValue, idField, idPrefix, digestField, validator) {
  assertExactFields(input, inputFields, `${idPrefix}input`);
  const value = {
    [versionField]: versionValue,
    [idField]: `${idPrefix}${'0'.repeat(64)}`,
    [digestField]: '0'.repeat(64),
    ...Object.fromEntries(inputFields.map(field => [field, input[field]])),
  };
  value[digestField] = sha256CanonicalJson(digestPreimage(value, fields, [idField, digestField]));
  value[idField] = `${idPrefix}${value[digestField]}`;
  validator(value);
  return cloneAndFreeze(value);
}
export function validateTransmissionEvidenceV1(value) {
  assertExactFields(value, TRANSMISSION_FIELDS, 'bounded_agent_transmission_evidence');
  if (value.transmission_evidence_version !== 'artifact_bounded_agent_transmission_evidence_v1'
      || !['ACQUISITION', 'DISPOSAL'].includes(value.phase)
      || value.scheduler_profile !== 'IDENTICAL_SIGNED_BYTES_BOUNDED_REBROADCAST_V1'
      || value.maximum_client_sends !== 3 || ![1, 2, 3].includes(value.actual_client_sends)
      || value.provider_retries !== 0 || !/^bounded-agent-episode-[0-9a-f]{64}$/.test(value.episode_id)
      || !SOLANA_SIGNATURE.test(value.signature)
      || !Array.isArray(value.send_wire_sha256s)
      || value.send_wire_sha256s.length !== value.actual_client_sends
      || value.send_wire_sha256s.some(digest => digest !== value.signed_wire_sha256)
      || value.terminal_classification !== 'FINALIZED_SUCCESS') {
    fail('bounded_agent_transmission_evidence_invalid', 'transmission evidence is invalid');
  }
  for (const field of ['signed_intent_digest', 'signed_wire_sha256', 'message_sha256',
    'closed_rebroadcast_evidence_sha256', 'terminal_resolution_evidence_sha256']) requireDigest(value[field], field);
  const expected = sha256CanonicalJson(digestPreimage(value, TRANSMISSION_FIELDS, ['transmission_id', 'transmission_digest']));
  if (value.transmission_digest !== expected || value.transmission_id !== `transmission-${expected}`) fail('bounded_agent_transmission_evidence_identity_invalid', 'transmission identity is invalid');
  return true;
}
export function buildTransmissionEvidenceV1(input) {
  return issueRecord(input, TRANSMISSION_INPUT_FIELDS, TRANSMISSION_FIELDS,
    'transmission_evidence_version', 'artifact_bounded_agent_transmission_evidence_v1',
    'transmission_id', 'transmission-', 'transmission_digest', validateTransmissionEvidenceV1);
}
export function validateFinalizedLegEvidenceV1(value) {
  assertExactFields(value, FINALIZED_FIELDS, 'bounded_agent_finalized_leg_evidence');
  if (value.finalized_leg_evidence_version !== 'artifact_bounded_agent_finalized_leg_evidence_v1'
      || !['ACQUISITION', 'DISPOSAL'].includes(value.phase) || value.execution_status !== 'SUCCEEDED'
      || !/^bounded-agent-episode-[0-9a-f]{64}$/.test(value.episode_id)
      || !Number.isSafeInteger(value.slot) || value.slot < 0
      || !Number.isSafeInteger(value.block_time) || value.block_time < 0
      || !SOLANA_SIGNATURE.test(value.signature)
      || !RAW.test(value.input_raw_quantity) || !RAW.test(value.chain_derived_target_raw_quantity)) {
    fail('bounded_agent_finalized_evidence_invalid', 'finalized leg evidence is invalid');
  }
  for (const field of ['signed_intent_digest', 'signed_wire_sha256', 'message_sha256', 'finalized_transaction_digest']) requireDigest(value[field], field);
  const expected = sha256CanonicalJson(digestPreimage(value, FINALIZED_FIELDS, ['finalized_evidence_id', 'finalized_evidence_digest']));
  if (value.finalized_evidence_digest !== expected || value.finalized_evidence_id !== `finalized-leg-${expected}`) fail('bounded_agent_finalized_evidence_identity_invalid', 'finalized evidence identity is invalid');
  return true;
}
export function buildFinalizedLegEvidenceV1(input) {
  return issueRecord(input, FINALIZED_INPUT_FIELDS, FINALIZED_FIELDS,
    'finalized_leg_evidence_version', 'artifact_bounded_agent_finalized_leg_evidence_v1',
    'finalized_evidence_id', 'finalized-leg-', 'finalized_evidence_digest', validateFinalizedLegEvidenceV1);
}
export function validateReconstructionEvidenceV1(value) {
  assertExactFields(value, RECONSTRUCTION_FIELDS, 'bounded_agent_reconstruction_evidence');
  if (value.reconstruction_evidence_version !== 'artifact_bounded_agent_reconstruction_evidence_v1'
      || !/^bounded-agent-episode-[0-9a-f]{64}$/.test(value.episode_id)
      || value.claim_outcome !== 'VERIFIED' || value.position_state !== 'CLOSED'
      || value.agent_provenance_authority !== 'PROVENANCE_ONLY_NOT_ECONOMIC_AUTHORITY'
      || !Array.isArray(value.transaction_bindings) || value.transaction_bindings.length !== 2) {
    fail('bounded_agent_reconstruction_evidence_invalid', 'reconstruction evidence is invalid');
  }
  for (const field of RECONSTRUCTION_INPUT_FIELDS.filter(field => field.endsWith('_digest'))) requireDigest(value[field], field);
  value.transaction_bindings.forEach((binding, index) => {
    assertExactFields(binding, TX_BINDING_FIELDS, `transaction_binding.${index}`);
    if (binding.phase !== ['ACQUISITION', 'DISPOSAL'][index] || typeof binding.signature !== 'string') fail('bounded_agent_reconstruction_evidence_invalid', 'transaction binding order is invalid');
    requireDigest(binding.finalized_transaction_digest, 'finalized_transaction_digest');
  });
  const expected = sha256CanonicalJson(digestPreimage(value, RECONSTRUCTION_FIELDS, ['reconstruction_id', 'reconstruction_digest']));
  if (value.reconstruction_digest !== expected || value.reconstruction_id !== `artifact-reconstruction-${expected}`) fail('bounded_agent_reconstruction_evidence_identity_invalid', 'reconstruction identity is invalid');
  return true;
}
export function buildReconstructionEvidenceV1(input) {
  return issueRecord(input, RECONSTRUCTION_INPUT_FIELDS, RECONSTRUCTION_FIELDS,
    'reconstruction_evidence_version', 'artifact_bounded_agent_reconstruction_evidence_v1',
    'reconstruction_id', 'artifact-reconstruction-', 'reconstruction_digest', validateReconstructionEvidenceV1);
}
function validateSignedIntent(value, digest) {
  assertExactFields(value, SIGNED_FIELDS, 'bounded_agent_signed_transaction_intent');
  for (const field of ['semantic_transaction_digest', 'message_sha256', 'signed_wire_sha256']) requireDigest(value[field], field);
  requireDigest(digest, 'signed_transaction_intent_digest');
  if (sha256CanonicalJson(value) !== digest || value.sign_count !== 1 || !SOLANA_SIGNATURE.test(value.signature)) fail('bounded_agent_signed_intent_invalid', 'signed intent identity is invalid');
}
function validateLeg(leg, phase, mandate, authorization, episodeId) {
  assertExactFields(leg, LEG_FIELDS, `${phase.toLowerCase()}_evidence`);
  validateReadinessChallengeV1(leg.readiness);
  validateAuthenticatedAgentDecisionV1(leg.decision, { mandate, authorization, challenge: leg.readiness });
  validateExecutorAdmissionV1(leg.admission, { mandate, authorization, challenge: leg.readiness, decision: leg.decision });
  if (leg.admission.status !== 'ADMITTED') fail('bounded_agent_episode_evidence_chain_mismatch', 'successful episode requires admitted decisions');
  validateSignedIntent(leg.signed_transaction_intent, leg.signed_transaction_intent_digest);
  validateTransmissionEvidenceV1(leg.transmission);
  validateFinalizedLegEvidenceV1(leg.finalized);
  const acquisition = phase === 'ACQUISITION';
  const expectedInputMint = acquisition ? mandate.asset_scope.usdc_mint : mandate.asset_scope.jup_mint;
  const expectedOutputMint = acquisition ? mandate.asset_scope.jup_mint : mandate.asset_scope.usdc_mint;
  const expectedInputRaw = acquisition
    ? mandate.economic_authority.acquisition_input_usdc_raw
    : leg.readiness.chain_derived_disposal_jup_raw;
  const records = [leg.readiness, leg.decision, leg.admission, leg.signed_transaction_intent, leg.transmission, leg.finalized];
  if (records.some(record => record.episode_id !== episodeId)
      || leg.readiness.phase !== phase || leg.decision.ordinal !== (phase === 'ACQUISITION' ? 1 : 2)
      || leg.signed_transaction_intent.phase !== phase || leg.transmission.phase !== phase || leg.finalized.phase !== phase
      || leg.signed_transaction_intent.admission_digest !== leg.admission.admission_digest
      || leg.transmission.signed_intent_digest !== leg.signed_transaction_intent_digest
      || leg.finalized.signed_intent_digest !== leg.signed_transaction_intent_digest
      || leg.signed_transaction_intent.semantic_transaction_digest !== leg.finalized.finalized_transaction_digest
      || leg.finalized.wallet !== mandate.wallet_scope.wallet
      || leg.finalized.input_mint !== expectedInputMint || leg.finalized.output_mint !== expectedOutputMint
      || leg.finalized.input_raw_quantity !== expectedInputRaw
      || ['signed_wire_sha256', 'message_sha256', 'signature'].some(field =>
        leg.transmission[field] !== leg.signed_transaction_intent[field] || leg.finalized[field] !== leg.signed_transaction_intent[field])) {
    fail('bounded_agent_episode_evidence_chain_mismatch', `${phase} evidence chain is inconsistent`);
  }
}
function membersFor(value) {
  const rows = [
    ['mandate.json', value.mandate], ['human-authorization.json', value.human_authorization],
    ['acquisition/readiness-challenge.json', value.acquisition.readiness],
    ['acquisition/agent-decision.json', value.acquisition.decision],
    ['acquisition/executor-admission.json', value.acquisition.admission],
    ['acquisition/signed-transaction-intent.json', value.acquisition.signed_transaction_intent],
    ['acquisition/transmission.json', value.acquisition.transmission],
    ['acquisition/finalized-evidence.json', value.acquisition.finalized],
    ['disposal/readiness-challenge.json', value.disposal.readiness],
    ['disposal/agent-decision.json', value.disposal.decision],
    ['disposal/executor-admission.json', value.disposal.admission],
    ['disposal/signed-transaction-intent.json', value.disposal.signed_transaction_intent],
    ['disposal/transmission.json', value.disposal.transmission],
    ['disposal/finalized-evidence.json', value.disposal.finalized],
    ['reconstruction/reconstruction.json', value.reconstruction], ['episode-result.json', value.outcome],
  ];
  return rows.map(([path, record]) => ({ path, sha256: sha256CanonicalJson(record) }));
}
function manifestFor(value) {
  const manifest = {
    manifest_version: 'artifact_bounded_agent_episode_manifest_v1', episode_id: value.episode_id,
    member_count: 0, members: membersFor(value), manifest_digest: '0'.repeat(64),
  };
  manifest.member_count = manifest.members.length;
  manifest.manifest_digest = sha256CanonicalJson(Object.fromEntries(Object.entries(manifest).filter(([field]) => field !== 'manifest_digest')));
  return manifest;
}
// Structural validation establishes a closed, internally hash-linked provenance
// graph. It is deliberately not economic authority; callers that promote a
// claim must use the source-bound finalized-evidence adapter/gate.
export function validateEpisodeEvidenceGraphStructureV1(value) {
  assertExactFields(value, GRAPH_FIELDS, 'bounded_agent_episode_evidence_graph');
  if (value.episode_evidence_graph_version !== EPISODE_EVIDENCE_GRAPH_VERSION_V1
      || !/^bounded-agent-episode-[0-9a-f]{64}$/.test(value.episode_id)) fail('bounded_agent_episode_evidence_version_invalid', 'episode graph version or identity is invalid');
  validateBoundedAgentMandateV1(value.mandate);
  validateHumanEpisodeAuthorizationV1(value.human_authorization, { mandate: value.mandate });
  const episodeId = `bounded-agent-episode-${value.human_authorization.authorization_digest}`;
  if (value.episode_id !== episodeId) fail('bounded_agent_episode_evidence_chain_mismatch', 'episode does not bind its authorization');
  validateLeg(value.acquisition, 'ACQUISITION', value.mandate, value.human_authorization, episodeId);
  validateLeg(value.disposal, 'DISPOSAL', value.mandate, value.human_authorization, episodeId);
  if (value.disposal.readiness.finalized_acquisition_evidence_digest !== value.acquisition.finalized.finalized_evidence_digest
      || value.disposal.readiness.chain_derived_disposal_jup_raw !== value.acquisition.finalized.chain_derived_target_raw_quantity
      || value.disposal.finalized.input_raw_quantity !== value.acquisition.finalized.chain_derived_target_raw_quantity
      || value.disposal.finalized.chain_derived_target_raw_quantity !== '0') {
    fail('bounded_agent_episode_evidence_chain_mismatch', 'disposal does not consume the complete finalized acquisition quantity');
  }
  validateReconstructionEvidenceV1(value.reconstruction);
  if (value.reconstruction.episode_id !== episodeId
      || value.reconstruction.transaction_bindings[0].signature !== value.acquisition.finalized.signature
      || value.reconstruction.transaction_bindings[0].finalized_transaction_digest !== value.acquisition.finalized.finalized_transaction_digest
      || value.reconstruction.transaction_bindings[1].signature !== value.disposal.finalized.signature
      || value.reconstruction.transaction_bindings[1].finalized_transaction_digest !== value.disposal.finalized.finalized_transaction_digest) {
    fail('bounded_agent_episode_evidence_chain_mismatch', 'Artifact reconstruction does not bind the finalized legs');
  }
  assertExactFields(value.outcome, OUTCOME_FIELDS, 'bounded_agent_episode_outcome');
  if (value.outcome.status !== 'CLAIM_VERIFIED_CLOSED' || value.outcome.public_wording !== PUBLIC_WORDING
      || value.reconstruction.claim_outcome !== 'VERIFIED' || value.reconstruction.position_state !== 'CLOSED') {
    fail('bounded_agent_episode_outcome_invalid', 'episode outcome is invalid');
  }
  assertExactFields(value.manifest, MANIFEST_FIELDS, 'bounded_agent_episode_manifest');
  value.manifest.members.forEach((member, index) => assertExactFields(member, MEMBER_FIELDS, `manifest.members.${index}`));
  const expectedManifest = manifestFor(value);
  if (canonicalJson(value.manifest) !== canonicalJson(expectedManifest)) fail('bounded_agent_episode_manifest_mismatch', 'episode manifest does not match its members');
  const expectedDigest = sha256CanonicalJson(digestPreimage(value, GRAPH_FIELDS, ['episode_evidence_graph_id', 'episode_evidence_graph_digest']));
  if (value.episode_evidence_graph_digest !== expectedDigest
      || value.episode_evidence_graph_id !== `bounded-agent-evidence-graph-${expectedDigest}`) {
    fail('bounded_agent_episode_evidence_identity_invalid', 'episode graph identity is invalid');
  }
  return true;
}
export function buildEpisodeEvidenceGraphV1({ mandate, authorization, acquisition, disposal, reconstruction, outcome }) {
  const value = {
    episode_evidence_graph_version: EPISODE_EVIDENCE_GRAPH_VERSION_V1,
    episode_evidence_graph_id: `bounded-agent-evidence-graph-${'0'.repeat(64)}`,
    episode_evidence_graph_digest: '0'.repeat(64),
    episode_id: `bounded-agent-episode-${authorization.authorization_digest}`,
    mandate, human_authorization: authorization, acquisition, disposal, reconstruction, outcome,
    manifest: {},
  };
  value.manifest = manifestFor(value);
  value.episode_evidence_graph_digest = sha256CanonicalJson(digestPreimage(value, GRAPH_FIELDS, ['episode_evidence_graph_id', 'episode_evidence_graph_digest']));
  value.episode_evidence_graph_id = `bounded-agent-evidence-graph-${value.episode_evidence_graph_digest}`;
  validateEpisodeEvidenceGraphStructureV1(value);
  return cloneAndFreeze(value);
}
