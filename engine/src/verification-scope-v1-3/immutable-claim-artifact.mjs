import { types as utilTypes } from 'node:util';

import {
  assertExactFields, assertPlainJsonValue, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson,
} from './contract.mjs';
import { buildClaimEnvelopeV13, validateClaimEnvelopeV13 } from './claim-envelope.mjs';
import {
  evaluateClaimOutcomeV13, validateClaimEvaluationStructureV13,
} from './claim-outcome-evaluator.mjs';
import {
  computeCandidateMemberDigestV13, selectExplicitCandidateV13,
  validateSelectionArtifactStructureV13,
} from './explicit-candidate-selection.mjs';

export const IMMUTABLE_CLAIM_ARTIFACT_VERSION_V13 = 'artifact_immutable_semantic_claim_v1_3';
export const IMMUTABLE_CLAIM_ARTIFACT_PROFILE_V13 = 'ARTIFACT_IMMUTABLE_POSITION_CLAIM_V1';
export const IMMUTABLE_CLAIM_IDENTITY_VERSION_V13 = 'artifact_immutable_semantic_claim_identity_v1_3';

const DIGEST = /^[0-9a-f]{64}$/;
const REQUEST_FIELDS = ['candidate_population_digest', 'requested_candidate_digest'];
const SOURCE_FIELDS = ['population', 'context', 'context_authority', 'exact_quote_mint', 'economic_evidence_port'];
const ISSUE_INPUT_FIELDS = ['request', 'source'];
const VALIDATION_INPUT_FIELDS = ['artifact', 'request', 'source'];
const DIRECT_POSITION_FIELDS = new Set([
  'scope_identity', 'acquisition_evidence_identity', 'target_mint', 'exact_quote_mint', 'episode_identity',
  'opening_boundary', 'ending_boundary', 'position_state', 'exclusion_references',
  'unresolved_claim_affecting_findings', 'unresolved_finding_references',
  'field_availability', 'reason_codes',
]);
export const IMMUTABLE_CLAIM_ARTIFACT_FIELDS_V13 = Object.freeze([
  'claim_artifact_version', 'claim_artifact_profile', 'claim_artifact_identity_version',
  'claim_artifact_id', 'claim_artifact_digest',
  'candidate_population_id', 'candidate_population_digest', 'candidate_digest',
  'selection_id', 'selection_digest',
  'position_episode_id', 'position_episode_digest',
  'claim_scope_digest', 'evidence_context_digest',
  'claim_evaluation_id', 'claim_evaluation_digest', 'claim_evaluation',
  'claim_envelope_id', 'claim_envelope_digest', 'claim_envelope',
]);

function assertDigest(value, field) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail('malformed_digest', `${field} must be a lowercase SHA-256 digest`, { field });
  }
}
function safeCapabilityObject(value, fields, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    fail('invalid_object', `${context} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (!fields.includes(field)) fail('unknown_field', `${context} contains unknown field`, { context, field });
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('accessor_not_allowed', `${context} contains an accessor`, { context, field });
    }
  }
  for (const field of fields) if (!Object.hasOwn(descriptors, field)) {
    fail('missing_field', `${context} is missing field`, { context, field });
  }
  return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
}
function validateRequest(value) {
  const descriptors = assertExactFields(value, REQUEST_FIELDS, 'immutable_claim_request');
  const request = Object.fromEntries(REQUEST_FIELDS.map(field => [field, descriptors[field].value]));
  assertDigest(request.candidate_population_digest, 'candidate_population_digest');
  assertDigest(request.requested_candidate_digest, 'requested_candidate_digest');
  return request;
}
function validateSource(value) {
  return safeCapabilityObject(value, SOURCE_FIELDS, 'immutable_claim_source');
}
function selectionEvaluationSource(row, source) {
  return {
    context: source.context,
    context_authority: source.context_authority,
    episode: row.episode,
    exact_quote_mint: source.exact_quote_mint,
    economic_evidence_port: source.economic_evidence_port,
  };
}
async function reconstructEvaluation(row, source) {
  const request = {
    claim_type: 'POSITION_EPISODE', claim_profile: 'POSITION_ECONOMICS_V1', requested: true,
    scope_digest: row.claim_evaluation_identity.scope_digest,
  };
  return evaluateClaimOutcomeV13({ request, source: selectionEvaluationSource(row, source) });
}
function establishedField(evaluation, field) {
  return evaluation.established_fields.find(item => item.field === field) ?? null;
}
function requiredResultReferences(evaluation) {
  return evaluation.established_fields
    .filter(item => !DIRECT_POSITION_FIELDS.has(item.field))
    .map(item => ({ field: item.field, value_digest: item.value_digest }))
    .sort((left, right) => left.field.localeCompare(right.field));
}
function boundaryDigest(evaluation, kind) {
  return evaluation.derived_boundary_identities.find(item => item.boundary_kind === kind)?.boundary_digest ?? null;
}
function acquisitionRequestDigest(source) {
  return sha256CanonicalJson({
    acquisition_request_identity_profile: 'ARTIFACT_ACQUISITION_SCOPE_ID_V1',
    acquisition_scope: source.context_authority.legacy_acquisition_result.scope,
  });
}
function finalizedAnchorDigest(source) {
  return sha256CanonicalJson({
    finalized_anchor_identity_profile: 'ARTIFACT_FINALIZED_ACQUISITION_BOUNDARY_ID_V1',
    acquisition_boundary: source.context_authority.legacy_acquisition_result.boundary,
  });
}
function projectClaimEnvelope(evaluation, row, candidateDigest, source) {
  const targetMint = establishedField(evaluation, 'target_mint')?.value ?? source.context.target_mint;
  const exactQuoteMint = establishedField(evaluation, 'exact_quote_mint')?.value ?? source.exact_quote_mint;
  return buildClaimEnvelopeV13({
    network: `${source.context.network.chain}:${source.context.network.network}`,
    analyzed_wallet: source.context.analyzed_wallet,
    acquisition_request_digest: acquisitionRequestDigest(source),
    finalized_anchor_digest: finalizedAnchorDigest(source),
    evidence_context_digest: source.context.evidence_context_digest,
    claim_scope_digest: evaluation.scope_digest,
    claim_type: evaluation.claim_type,
    claim_profile: evaluation.claim_profile,
    requested: evaluation.requested,
    target_mint: targetMint,
    exact_quote_mint: exactQuoteMint,
    position_episode_digest: row.episode.position_episode_digest,
    candidate_digest: candidateDigest,
    supporting_profiles: evaluation.supporting_profiles,
    opening_boundary_digest: boundaryDigest(evaluation, 'OPENING'),
    ending_boundary_digest: boundaryDigest(evaluation, 'ENDING_AS_OF'),
    included_evidence_digests: evaluation.authoritative_evidence_identities.map(item => item.evidence_digest),
    exclusions: evaluation.exclusions,
    unresolved_finding_digests: evaluation.unresolved_dependencies.map(item => item.reference_digest),
    claim_outcome: evaluation.claim_outcome,
    position_state: evaluation.position_state,
    reason_codes: evaluation.reason_codes,
    result_profile: evaluation.result_profile,
    field_availability: evaluation.field_availability,
    result_field_references: requiredResultReferences(evaluation),
    legacy_reference: null,
  });
}
function validateEnvelopeProjectionBindings(artifact) {
  const evaluation = artifact.claim_evaluation;
  const envelope = artifact.claim_envelope;
  const targetMint = establishedField(evaluation, 'target_mint')?.value ?? null;
  const exactQuoteMint = establishedField(evaluation, 'exact_quote_mint')?.value ?? null;
  const expectedBindings = {
    evidence_context_digest: artifact.evidence_context_digest,
    claim_scope_digest: evaluation.scope_digest,
    claim_type: evaluation.claim_type,
    claim_profile: evaluation.claim_profile,
    requested: evaluation.requested,
    target_mint: targetMint,
    exact_quote_mint: exactQuoteMint,
    position_episode_digest: artifact.position_episode_digest,
    candidate_digest: artifact.candidate_digest,
    supporting_profiles: evaluation.supporting_profiles,
    opening_boundary_digest: boundaryDigest(evaluation, 'OPENING'),
    ending_boundary_digest: boundaryDigest(evaluation, 'ENDING_AS_OF'),
    included_evidence_digests: evaluation.authoritative_evidence_identities.map(item => item.evidence_digest).sort(),
    exclusions: evaluation.exclusions,
    unresolved_finding_digests: evaluation.unresolved_dependencies.map(item => item.reference_digest).sort(),
    claim_outcome: evaluation.claim_outcome,
    position_state: evaluation.position_state,
    reason_codes: evaluation.reason_codes,
    result_profile: evaluation.result_profile,
    field_availability: [...evaluation.field_availability].sort((left, right) => left.field.localeCompare(right.field)),
    result_field_references: requiredResultReferences(evaluation),
    legacy_reference: null,
  };
  for (const [field, expected] of Object.entries(expectedBindings)) {
    if (canonicalJson(envelope[field]) !== canonicalJson(expected)) {
      fail('claim_envelope_evaluation_mismatch', `claim envelope ${field} does not match the validated evaluation`);
    }
  }
}

export function claimArtifactDigestPreimageV13(value) {
  assertExactFields(value, IMMUTABLE_CLAIM_ARTIFACT_FIELDS_V13, 'immutable_claim_artifact');
  return cloneAndFreeze(Object.fromEntries(IMMUTABLE_CLAIM_ARTIFACT_FIELDS_V13
    .filter(field => !['claim_artifact_id', 'claim_artifact_digest'].includes(field))
    .map(field => [field, value[field]])));
}
export function computeImmutableClaimArtifactDigestV13(value) {
  return sha256CanonicalJson(claimArtifactDigestPreimageV13(value));
}
export function validateImmutableClaimArtifactStructureV13(value) {
  assertPlainJsonValue(value, ['immutable_claim_artifact']);
  assertExactFields(value, IMMUTABLE_CLAIM_ARTIFACT_FIELDS_V13, 'immutable_claim_artifact');
  if (value.claim_artifact_version !== IMMUTABLE_CLAIM_ARTIFACT_VERSION_V13
      || value.claim_artifact_profile !== IMMUTABLE_CLAIM_ARTIFACT_PROFILE_V13
      || value.claim_artifact_identity_version !== IMMUTABLE_CLAIM_IDENTITY_VERSION_V13) {
    fail('immutable_claim_version_invalid', 'immutable claim artifact version or profile is invalid');
  }
  for (const field of [
    'claim_artifact_digest', 'candidate_population_digest', 'candidate_digest', 'selection_digest',
    'position_episode_digest', 'claim_scope_digest', 'evidence_context_digest',
    'claim_evaluation_digest', 'claim_envelope_digest',
  ]) assertDigest(value[field], field);
  if (value.claim_artifact_id !== `immutable-claim-${value.claim_artifact_digest}`
      || value.candidate_population_id !== `episode-population-${value.candidate_population_digest}`
      || value.selection_id !== `selection-${value.selection_digest}`
      || value.position_episode_id !== `position-episode-${value.position_episode_digest}`
      || value.claim_evaluation_id !== `claim-evaluation-${value.claim_evaluation_digest}`) {
    fail('immutable_claim_identity_mismatch', 'immutable claim artifact contains an inconsistent identity');
  }
  validateClaimEvaluationStructureV13(value.claim_evaluation);
  validateClaimEnvelopeV13(value.claim_envelope);
  if (value.claim_evaluation.claim_outcome !== 'VERIFIED'
      || value.claim_evaluation.claim_type !== 'POSITION_EPISODE'
      || value.claim_evaluation.claim_profile !== 'POSITION_ECONOMICS_V1'
      || value.claim_evaluation_id !== value.claim_evaluation.evaluation_id
      || value.claim_evaluation_digest !== value.claim_evaluation.evaluation_digest
      || value.claim_scope_digest !== value.claim_evaluation.scope_digest
      || value.claim_envelope_id !== value.claim_envelope.claim_id
      || value.claim_envelope_digest !== value.claim_envelope.claim_digest) {
    fail('immutable_claim_semantic_identity_mismatch', 'immutable claim semantic identities do not agree');
  }
  validateEnvelopeProjectionBindings(value);
  const expectedDigest = computeImmutableClaimArtifactDigestV13(value);
  if (value.claim_artifact_digest !== expectedDigest) {
    fail('immutable_claim_digest_mismatch', 'immutable claim artifact digest is invalid');
  }
  return true;
}

async function reconstructIssuance(request, source) {
  const selectionResult = await selectExplicitCandidateV13({ request, source });
  if (selectionResult.status !== 'SELECTED_VERIFIED') {
    fail('selected_candidate_not_verified', 'immutable VERIFIED claim issuance requires a VERIFIED selected member', {
      refusal: selectionResult.refusal,
    });
  }
  const selection = selectionResult.selection_artifact;
  validateSelectionArtifactStructureV13(selection);
  const candidates = source.population.episode_dispositions.map(row => ({
    row,
    digest: computeCandidateMemberDigestV13({
      candidate_population_digest: source.population.population_digest,
      episode_disposition: row,
    }),
  })).filter(item => item.digest === request.requested_candidate_digest);
  if (candidates.length !== 1) fail('selected_candidate_membership_changed', 'selected membership is no longer unique');
  const row = candidates[0].row;
  if (row.episode_ordinal !== selection.resolved_episode_ordinal
      || row.episode.position_episode_digest !== selection.position_episode_digest) {
    fail('selected_candidate_resolution_changed', 'selected episode does not match selection artifact');
  }
  const evaluation = await reconstructEvaluation(row, source);
  if (evaluation.evaluation_digest !== selection.claim_evaluation_digest
      || evaluation.scope_digest !== selection.claim_scope_digest
      || evaluation.claim_outcome !== 'VERIFIED') {
    fail('selected_evaluation_changed', 'selected evaluation does not match the successful selection');
  }
  const envelope = projectClaimEnvelope(evaluation, row, candidates[0].digest, source);
  return { selection, row, evaluation, envelope };
}

export async function issueImmutablePositionClaimV13(input) {
  const top = safeCapabilityObject(input, ISSUE_INPUT_FIELDS, 'immutable_claim_issuance_input');
  const request = validateRequest(top.request);
  const source = validateSource(top.source);
  const { selection, row, evaluation, envelope } = await reconstructIssuance(request, source);
  const artifact = {
    claim_artifact_version: IMMUTABLE_CLAIM_ARTIFACT_VERSION_V13,
    claim_artifact_profile: IMMUTABLE_CLAIM_ARTIFACT_PROFILE_V13,
    claim_artifact_identity_version: IMMUTABLE_CLAIM_IDENTITY_VERSION_V13,
    claim_artifact_id: `immutable-claim-${'0'.repeat(64)}`,
    claim_artifact_digest: '0'.repeat(64),
    candidate_population_id: source.population.population_id,
    candidate_population_digest: source.population.population_digest,
    candidate_digest: request.requested_candidate_digest,
    selection_id: selection.selection_id,
    selection_digest: selection.selection_digest,
    position_episode_id: row.episode.episode_id,
    position_episode_digest: row.episode.position_episode_digest,
    claim_scope_digest: evaluation.scope_digest,
    evidence_context_digest: source.context.evidence_context_digest,
    claim_evaluation_id: evaluation.evaluation_id,
    claim_evaluation_digest: evaluation.evaluation_digest,
    claim_evaluation: evaluation,
    claim_envelope_id: envelope.claim_id,
    claim_envelope_digest: envelope.claim_digest,
    claim_envelope: envelope,
  };
  artifact.claim_artifact_digest = computeImmutableClaimArtifactDigestV13(artifact);
  artifact.claim_artifact_id = `immutable-claim-${artifact.claim_artifact_digest}`;
  validateImmutableClaimArtifactStructureV13(artifact);
  return cloneAndFreeze(artifact);
}

export async function validateSourceBoundImmutablePositionClaimV13(input) {
  const top = safeCapabilityObject(input, VALIDATION_INPUT_FIELDS, 'source_bound_immutable_claim_input');
  validateImmutableClaimArtifactStructureV13(top.artifact);
  const expected = await issueImmutablePositionClaimV13({ request: top.request, source: top.source });
  if (canonicalJson(expected) !== canonicalJson(top.artifact)) {
    fail('immutable_claim_source_mismatch', 'immutable claim artifact does not match complete source-bound reconstruction');
  }
  return true;
}
