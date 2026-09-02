import { types as utilTypes } from 'node:util';

import {
  assertExactFields, assertPlainJsonValue, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson,
} from './contract.mjs';
import { validateSourceBoundEpisodeCandidatePopulationV13 } from './episode-candidate-population.mjs';
import { evaluateClaimOutcomeV13 } from './claim-outcome-evaluator.mjs';

export const CANDIDATE_MEMBER_IDENTITY_PROFILE_V13 = 'ARTIFACT_EPISODE_CANDIDATE_MEMBER_ID_V1';
export const EXPLICIT_SELECTION_ARTIFACT_VERSION_V13 = 'artifact_explicit_candidate_selection_v1_3';
export const EXPLICIT_SELECTION_IDENTITY_VERSION_V13 = 'artifact_explicit_candidate_selection_identity_v1_3';
export const EXPLICIT_SELECTION_POLICY_V13 = 'EXPLICIT_DIGEST_NO_FALLBACK_V1';

const DIGEST = /^[0-9a-f]{64}$/;
const CLAIM_EVALUATION_IDENTITY_FIELDS = [
  'evaluation_id', 'evaluation_digest', 'claim_evaluation_profile',
  'claim_type', 'claim_profile', 'scope_digest',
];
const REQUEST_FIELDS = ['candidate_population_digest', 'requested_candidate_digest'];
const SOURCE_FIELDS = ['population', 'context', 'context_authority', 'exact_quote_mint', 'economic_evidence_port'];
const TOP_INPUT_FIELDS = ['request', 'source'];
const SOURCE_BOUND_RESULT_FIELDS = ['result', 'request', 'source'];
const RESULT_FIELDS = ['status', 'selection_artifact'];
const REFUSAL_RESULT_FIELDS = ['status', 'refusal'];
const REFUSAL_FIELDS = [
  'refusal_code', 'requested_population_digest', 'requested_candidate_digest',
  'resolved_candidate_digest', 'resolved_population_disposition',
  'selected_evaluation_id', 'selected_evaluation_digest', 'selected_evaluation_outcome',
];
export const SELECTION_ARTIFACT_FIELDS_V13 = Object.freeze([
  'selection_artifact_version', 'selection_identity_version', 'selection_id', 'selection_digest',
  'selection_policy', 'selection_status', 'candidate_population_id', 'candidate_population_digest',
  'requested_candidate_digest', 'resolved_candidate_digest', 'resolved_episode_ordinal',
  'claim_scope_digest', 'position_episode_id', 'position_episode_digest',
  'claim_evaluation_id', 'claim_evaluation_digest', 'population_disposition', 'position_state',
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
function safeOwnDataField(value, field, context) {
  if (value !== null && typeof value === 'object' && utilTypes.isProxy(value)) {
    fail('proxy_not_allowed', `proxy is not allowed at ${context}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_object', `${context} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail('symbol_key_not_allowed', `${context} contains a symbol key`);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined) fail('missing_field', `${context} is missing field`, { context, field });
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    fail('accessor_not_allowed', `${context} contains an accessor`, { context, field });
  }
  return descriptor.value;
}
function validateRequest(value) {
  const descriptors = assertExactFields(value, REQUEST_FIELDS, 'explicit_selection_request');
  const request = Object.fromEntries(REQUEST_FIELDS.map(field => [field, descriptors[field].value]));
  assertDigest(request.candidate_population_digest, 'candidate_population_digest');
  assertDigest(request.requested_candidate_digest, 'requested_candidate_digest');
  return request;
}
function candidateIdentityParts(input) {
  assertExactFields(input, ['candidate_population_digest', 'episode_disposition'], 'candidate_member_identity_input');
  assertDigest(input.candidate_population_digest, 'candidate_population_digest');
  const row = input.episode_disposition;
  assertPlainJsonValue(row, ['episode_disposition']);
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    fail('candidate_member_invalid', 'episode disposition must be an object');
  }
  for (const field of [
    'episode_ordinal', 'episode', 'claim_evaluation_identity', 'population_disposition', 'position_state',
  ]) if (!Object.hasOwn(row, field)) fail('candidate_member_invalid', `episode disposition is missing ${field}`);
  if (!Number.isSafeInteger(row.episode_ordinal) || row.episode_ordinal < 0 || Object.is(row.episode_ordinal, -0)) {
    fail('candidate_member_invalid', 'episode ordinal must be a nonnegative safe integer');
  }
  if (row.episode === null || typeof row.episode !== 'object' || Array.isArray(row.episode)) {
    fail('candidate_member_invalid', 'episode must be an object');
  }
  assertDigest(row.episode.position_episode_digest, 'position_episode_digest');
  assertExactFields(row.claim_evaluation_identity, CLAIM_EVALUATION_IDENTITY_FIELDS, 'claim_evaluation_identity');
  assertDigest(row.claim_evaluation_identity.evaluation_digest, 'evaluation_digest');
  assertDigest(row.claim_evaluation_identity.scope_digest, 'scope_digest');
  if (row.claim_evaluation_identity.evaluation_id !== `claim-evaluation-${row.claim_evaluation_identity.evaluation_digest}`
      || row.claim_evaluation_identity.claim_evaluation_profile !== 'ARTIFACT_CLAIM_OUTCOME_EVALUATION_V1'
      || row.claim_evaluation_identity.claim_type !== 'POSITION_EPISODE'
      || row.claim_evaluation_identity.claim_profile !== 'POSITION_ECONOMICS_V1') {
    fail('candidate_member_invalid', 'claim evaluation identity is invalid');
  }
  if (!['VERIFIED', 'LIMITED', 'BLOCKED', 'PROFILE_EXCLUDED'].includes(row.population_disposition)) {
    fail('candidate_member_invalid', 'population disposition is invalid');
  }
  if (![null, 'CLOSED', 'OPEN_REALIZED_PARTIAL', 'OPEN'].includes(row.position_state)) {
    fail('candidate_member_invalid', 'position state is invalid');
  }
  return { row };
}

export function candidateMemberDigestPreimageV13(input) {
  const { row } = candidateIdentityParts(input);
  return cloneAndFreeze({
    candidate_member_identity_profile: CANDIDATE_MEMBER_IDENTITY_PROFILE_V13,
    candidate_population_digest: input.candidate_population_digest,
    dense_episode_ordinal: row.episode_ordinal,
    claim_scope_digest: row.claim_evaluation_identity.scope_digest,
    position_episode_digest: row.episode.position_episode_digest,
    claim_evaluation_identity: row.claim_evaluation_identity,
    population_disposition: row.population_disposition,
    position_state: row.position_state,
  });
}
export function computeCandidateMemberDigestV13(input) {
  return sha256CanonicalJson(candidateMemberDigestPreimageV13(input));
}

function selectionSource(row, source) {
  return {
    context: source.context,
    context_authority: source.context_authority,
    episode: row.episode,
    exact_quote_mint: source.exact_quote_mint,
    economic_evidence_port: source.economic_evidence_port,
  };
}
async function reconstructSelectedEvaluation(row, source) {
  const request = {
    claim_type: 'POSITION_EPISODE', claim_profile: 'POSITION_ECONOMICS_V1', requested: true,
    scope_digest: row.claim_evaluation_identity.scope_digest,
  };
  const evaluation = await evaluateClaimOutcomeV13({ request, source: selectionSource(row, source) });
  const identity = {
    evaluation_id: evaluation.evaluation_id,
    evaluation_digest: evaluation.evaluation_digest,
    claim_evaluation_profile: evaluation.claim_evaluation_profile,
    claim_type: evaluation.claim_type,
    claim_profile: evaluation.claim_profile,
    scope_digest: evaluation.scope_digest,
  };
  if (canonicalJson(identity) !== canonicalJson(row.claim_evaluation_identity)
      || evaluation.claim_outcome !== row.population_disposition
      || evaluation.position_state !== row.position_state
      || canonicalJson(evaluation.reason_codes) !== canonicalJson(row.reason_codes)
      || canonicalJson(evaluation.unresolved_dependencies.map(item => item.reference_digest))
        !== canonicalJson(row.unresolved_dependency_references)
      || canonicalJson(evaluation.exclusions) !== canonicalJson(row.exclusion_references)
      || row.candidate_eligible !== (evaluation.claim_outcome === 'VERIFIED')) {
    fail('selected_candidate_evaluation_mismatch', 'selected member does not match reconstructed Slice 5 evaluation');
  }
  return evaluation;
}

export function selectionDigestPreimageV13(value) {
  assertExactFields(value, SELECTION_ARTIFACT_FIELDS_V13, 'selection_artifact');
  return cloneAndFreeze(Object.fromEntries(SELECTION_ARTIFACT_FIELDS_V13
    .filter(field => !['selection_id', 'selection_digest'].includes(field))
    .map(field => [field, value[field]])));
}
export function computeSelectionDigestV13(value) {
  return sha256CanonicalJson(selectionDigestPreimageV13(value));
}
export function validateSelectionArtifactStructureV13(value) {
  assertExactFields(value, SELECTION_ARTIFACT_FIELDS_V13, 'selection_artifact');
  if (value.selection_artifact_version !== EXPLICIT_SELECTION_ARTIFACT_VERSION_V13
      || value.selection_identity_version !== EXPLICIT_SELECTION_IDENTITY_VERSION_V13
      || value.selection_policy !== EXPLICIT_SELECTION_POLICY_V13
      || value.selection_status !== 'SELECTED_VERIFIED') {
    fail('selection_artifact_version_invalid', 'selection artifact version, policy, or status is invalid');
  }
  for (const field of [
    'selection_digest', 'candidate_population_digest', 'requested_candidate_digest',
    'resolved_candidate_digest', 'claim_scope_digest', 'position_episode_digest', 'claim_evaluation_digest',
  ]) assertDigest(value[field], field);
  if (value.selection_id !== `selection-${value.selection_digest}`
      || value.candidate_population_id !== `episode-population-${value.candidate_population_digest}`
      || value.position_episode_id !== `position-episode-${value.position_episode_digest}`
      || value.claim_evaluation_id !== `claim-evaluation-${value.claim_evaluation_digest}`) {
    fail('selection_artifact_identity_mismatch', 'selection artifact contains an inconsistent identity');
  }
  if (value.requested_candidate_digest !== value.resolved_candidate_digest) {
    fail('selection_candidate_mismatch', 'requested and resolved candidate identities must agree');
  }
  if (!Number.isSafeInteger(value.resolved_episode_ordinal) || value.resolved_episode_ordinal < 0
      || Object.is(value.resolved_episode_ordinal, -0)) {
    fail('selection_episode_ordinal_invalid', 'resolved episode ordinal is invalid');
  }
  if (value.population_disposition !== 'VERIFIED'
      || !['CLOSED', 'OPEN_REALIZED_PARTIAL', 'OPEN'].includes(value.position_state)) {
    fail('selection_candidate_not_verified', 'successful selection requires a VERIFIED candidate with known state');
  }
  const expected = computeSelectionDigestV13(value);
  if (value.selection_digest !== expected) fail('selection_digest_mismatch', 'selection digest is invalid');
  return true;
}
function buildSelectionArtifact(request, population, row, candidateDigest, evaluation) {
  const artifact = {
    selection_artifact_version: EXPLICIT_SELECTION_ARTIFACT_VERSION_V13,
    selection_identity_version: EXPLICIT_SELECTION_IDENTITY_VERSION_V13,
    selection_id: `selection-${'0'.repeat(64)}`,
    selection_digest: '0'.repeat(64),
    selection_policy: EXPLICIT_SELECTION_POLICY_V13,
    selection_status: 'SELECTED_VERIFIED',
    candidate_population_id: population.population_id,
    candidate_population_digest: population.population_digest,
    requested_candidate_digest: request.requested_candidate_digest,
    resolved_candidate_digest: candidateDigest,
    resolved_episode_ordinal: row.episode_ordinal,
    claim_scope_digest: evaluation.scope_digest,
    position_episode_id: row.episode.episode_id,
    position_episode_digest: row.episode.position_episode_digest,
    claim_evaluation_id: evaluation.evaluation_id,
    claim_evaluation_digest: evaluation.evaluation_digest,
    population_disposition: row.population_disposition,
    position_state: row.position_state,
  };
  artifact.selection_digest = computeSelectionDigestV13(artifact);
  artifact.selection_id = `selection-${artifact.selection_digest}`;
  validateSelectionArtifactStructureV13(artifact);
  return cloneAndFreeze(artifact);
}
function refusal(request, candidateDigest, row, evaluation) {
  return cloneAndFreeze({
    status: 'REFUSED_SELECTED_CANDIDATE_NOT_VERIFIED',
    refusal: {
      refusal_code: 'selected_candidate_not_verified',
      requested_population_digest: request.candidate_population_digest,
      requested_candidate_digest: request.requested_candidate_digest,
      resolved_candidate_digest: candidateDigest,
      resolved_population_disposition: row.population_disposition,
      selected_evaluation_id: evaluation.evaluation_id,
      selected_evaluation_digest: evaluation.evaluation_digest,
      selected_evaluation_outcome: evaluation.claim_outcome,
    },
  });
}
function validateResultStructure(value) {
  assertPlainJsonValue(value, ['explicit_selection_result']);
  if (value?.status === 'SELECTED_VERIFIED') {
    assertExactFields(value, RESULT_FIELDS, 'explicit_selection_result');
    validateSelectionArtifactStructureV13(value.selection_artifact);
    return true;
  }
  assertExactFields(value, REFUSAL_RESULT_FIELDS, 'explicit_selection_result');
  if (value.status !== 'REFUSED_SELECTED_CANDIDATE_NOT_VERIFIED') {
    fail('selection_result_status_invalid', 'selection result status is invalid');
  }
  assertExactFields(value.refusal, REFUSAL_FIELDS, 'selection_refusal');
  if (value.refusal.refusal_code !== 'selected_candidate_not_verified') {
    fail('selection_refusal_code_invalid', 'selection refusal code is invalid');
  }
  for (const field of [
    'requested_population_digest', 'requested_candidate_digest', 'resolved_candidate_digest',
    'selected_evaluation_digest',
  ]) assertDigest(value.refusal[field], field);
  if (value.refusal.requested_candidate_digest !== value.refusal.resolved_candidate_digest
      || value.refusal.selected_evaluation_id !== `claim-evaluation-${value.refusal.selected_evaluation_digest}`
      || !['LIMITED', 'BLOCKED', 'PROFILE_EXCLUDED'].includes(value.refusal.resolved_population_disposition)
      || value.refusal.selected_evaluation_outcome !== value.refusal.resolved_population_disposition) {
    fail('selection_refusal_invalid', 'selection refusal does not bind one exact non-VERIFIED evaluation');
  }
  return true;
}

export async function selectExplicitCandidateV13(input) {
  const top = safeCapabilityObject(input, TOP_INPUT_FIELDS, 'explicit_selection_input');
  const request = validateRequest(top.request);
  const source = safeCapabilityObject(top.source, SOURCE_FIELDS, 'explicit_selection_source');
  const suppliedPopulationDigest = safeOwnDataField(
    source.population, 'population_digest', 'explicit_selection_source.population',
  );
  if (request.candidate_population_digest !== suppliedPopulationDigest) {
    fail('candidate_population_digest_mismatch', 'requested population digest does not match supplied population');
  }
  await validateSourceBoundEpisodeCandidatePopulationV13({
    population: source.population,
    context: source.context,
    context_authority: source.context_authority,
    exact_quote_mint: source.exact_quote_mint,
    economic_evidence_port: source.economic_evidence_port,
  });
  const members = source.population.episode_dispositions.map(row => ({
    row,
    candidateDigest: computeCandidateMemberDigestV13({
      candidate_population_digest: source.population.population_digest,
      episode_disposition: row,
    }),
  }));
  if (new Set(members.map(item => item.candidateDigest)).size !== members.length) {
    fail('duplicate_candidate_member_identity', 'candidate member identities must be unique within the population');
  }
  const matches = members.filter(item => item.candidateDigest === request.requested_candidate_digest);
  if (matches.length === 0) fail('selected_candidate_absent', 'requested candidate is absent from the exact population');
  if (matches.length !== 1) fail('selected_candidate_duplicated', 'requested candidate is duplicated in the exact population');
  const selected = matches[0];
  const evaluation = await reconstructSelectedEvaluation(selected.row, source);
  if (evaluation.claim_outcome !== 'VERIFIED') {
    const result = refusal(request, selected.candidateDigest, selected.row, evaluation);
    validateResultStructure(result);
    return result;
  }
  const result = cloneAndFreeze({
    status: 'SELECTED_VERIFIED',
    selection_artifact: buildSelectionArtifact(
      request, source.population, selected.row, selected.candidateDigest, evaluation,
    ),
  });
  validateResultStructure(result);
  return result;
}

export async function validateSourceBoundExplicitCandidateSelectionV13(input) {
  const values = safeCapabilityObject(input, SOURCE_BOUND_RESULT_FIELDS, 'source_bound_explicit_selection_input');
  validateResultStructure(values.result);
  const expected = await selectExplicitCandidateV13({ request: values.request, source: values.source });
  if (canonicalJson(expected) !== canonicalJson(values.result)) {
    fail('explicit_selection_source_mismatch', 'selection result does not match source-bound reconstruction');
  }
  return true;
}
