import {
  assertExactFields, assertPlainJsonValue, cloneAndFreeze, clonePlainData, fail, sha256CanonicalJson,
} from './contract.mjs';
import {
  EXCLUSION_CODES, FULL_RESULT_PROFILE_DEFINITIONS, LIMITED_RESULT_PROFILE_DEFINITIONS,
  POSITION_VERIFIED_FIELD_MATRIX, SUPPORTING_PROFILES,
  normalizeReasonCodes, validateClaimCombination,
} from './semantics.mjs';

export const CLAIM_ENVELOPE_VERSION = 'artifact_verification_claim_envelope_v1_3';
export const CLAIM_IDENTITY_VERSION = 'artifact_verification_claim_identity_v1_3';
export const CLAIM_ID_PREFIX = 'avc13_';
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const FIELD_AVAILABILITY_VALUES = Object.freeze(['AVAILABLE', 'UNAVAILABLE', 'NOT_APPLICABLE']);

const INPUT_FIELDS = Object.freeze([
  'network', 'analyzed_wallet', 'acquisition_request_digest', 'finalized_anchor_digest', 'evidence_context_digest',
  'claim_scope_digest', 'claim_type', 'claim_profile', 'requested', 'target_mint', 'exact_quote_mint',
  'position_episode_digest', 'candidate_digest', 'supporting_profiles', 'opening_boundary_digest',
  'ending_boundary_digest', 'included_evidence_digests', 'exclusions', 'unresolved_finding_digests',
  'claim_outcome', 'position_state', 'reason_codes', 'result_profile', 'field_availability',
  'result_field_references', 'legacy_reference',
]);
export const CLAIM_ENVELOPE_FIELDS = Object.freeze([
  'claim_envelope_version', 'claim_identity_version', 'claim_id', 'claim_digest', ...INPUT_FIELDS,
]);
const PROFILE_FIELDS = Object.freeze(Object.keys(SUPPORTING_PROFILES));
const EXCLUSION_FIELDS = Object.freeze(['evidence_digest', 'exclusion_code', 'non_interference_rule']);
const AVAILABILITY_FIELDS = Object.freeze(['field', 'availability']);
const RESULT_REFERENCE_FIELDS = Object.freeze(['field', 'value_digest']);
const LEGACY_REFERENCE_FIELDS = Object.freeze(['receipt_hash', 'package_digest']);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function assertDigest(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) fail('malformed_digest', `${field} must be a lowercase SHA-256 digest`, { field });
}
function assertIdentifier(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value) || /(?:api[_-]?key|authorization|bearer|credential|password|secret)/i.test(value)) fail('invalid_identifier', `${field} is not a bounded non-sensitive identifier`, { field });
}
function compareCodeUnits(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function assertOrderedUnique(values, field, validator) {
  if (!Array.isArray(values)) fail('invalid_field', `${field} must be an array`, { field });
  values.forEach((value, index) => validator(value, `${field}.${index}`));
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodeUnits(values[index - 1], values[index]) >= 0) fail('noncanonical_order', `${field} must be unique and in canonical order`, { field });
  }
}
function sortedUniqueDigests(values, field) {
  if (!Array.isArray(values)) fail('invalid_field', `${field} must be an array`, { field });
  values.forEach((value, index) => assertDigest(value, `${field}.${index}`));
  if (new Set(values).size !== values.length) fail('duplicate_value', `${field} contains duplicates`, { field });
  return [...values].sort(compareCodeUnits);
}
function fullFieldNames(claimProfile, positionState) {
  if (claimProfile === 'POSITION_ECONOMICS_V1') {
    if (positionState !== null) return Object.entries(POSITION_VERIFIED_FIELD_MATRIX[positionState]).filter(([, requirement]) => requirement !== 'FORBIDDEN').map(([field]) => field).sort(compareCodeUnits);
    const fields = new Set();
    for (const matrix of Object.values(POSITION_VERIFIED_FIELD_MATRIX)) for (const [field, requirement] of Object.entries(matrix)) if (requirement !== 'FORBIDDEN') fields.add(field);
    return [...fields].sort(compareCodeUnits);
  }
  return [...FULL_RESULT_PROFILE_DEFINITIONS[claimProfile].required_fields].sort(compareCodeUnits);
}
function expectedVerifiedAvailability(claimProfile, positionState) {
  if (claimProfile !== 'POSITION_ECONOMICS_V1') return fullFieldNames(claimProfile, positionState).map(field => ({ field, availability: 'AVAILABLE' }));
  return Object.entries(POSITION_VERIFIED_FIELD_MATRIX[positionState])
    .filter(([, requirement]) => requirement !== 'FORBIDDEN')
    .map(([field, requirement]) => ({ field, availability: requirement === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'AVAILABLE' }))
    .sort((left, right) => compareCodeUnits(left.field, right.field));
}
function validateProfiles(value) {
  assertExactFields(value, PROFILE_FIELDS, 'supporting_profiles');
  for (const field of PROFILE_FIELDS) if (value[field] !== SUPPORTING_PROFILES[field]) fail('unsupported_profile', `${field} does not match the frozen v1.3 profile`, { field });
}
function normalizeExclusions(values) {
  if (!Array.isArray(values)) fail('invalid_field', 'exclusions must be an array');
  const seenEvidence = new Set();
  const result = values.map((value, index) => {
    assertExactFields(value, EXCLUSION_FIELDS, `exclusions.${index}`);
    assertDigest(value.evidence_digest, `exclusions.${index}.evidence_digest`);
    const ordinal = EXCLUSION_CODES.indexOf(value.exclusion_code);
    if (ordinal < 0) fail('unknown_exclusion_code', 'exclusion code is not in the frozen vocabulary');
    const expectedRule = `NI-0${ordinal + 1}`;
    if (value.non_interference_rule !== expectedRule) fail('exclusion_rule_mismatch', 'exclusion code does not match its identity-relevant NI rule');
    if (seenEvidence.has(value.evidence_digest)) fail('duplicate_exclusion', 'one evidence item cannot carry multiple exclusion bases');
    seenEvidence.add(value.evidence_digest);
    return { evidence_digest: value.evidence_digest, exclusion_code: value.exclusion_code, non_interference_rule: value.non_interference_rule };
  });
  return result.sort((left, right) => EXCLUSION_CODES.indexOf(left.exclusion_code) - EXCLUSION_CODES.indexOf(right.exclusion_code) || compareCodeUnits(left.evidence_digest, right.evidence_digest));
}
function validateCanonicalExclusions(values) {
  const normalized = normalizeExclusions(values);
  if (JSON.stringify(normalized) !== JSON.stringify(values)) fail('noncanonical_exclusion_order', 'exclusions must follow frozen ordinal order and evidence digest order');
}
function normalizeAvailability(values) {
  if (!Array.isArray(values)) fail('invalid_field', 'field_availability must be an array');
  const seen = new Set();
  const result = values.map((value, index) => {
    assertExactFields(value, AVAILABILITY_FIELDS, `field_availability.${index}`);
    assertIdentifier(value.field, `field_availability.${index}.field`);
    if (!FIELD_AVAILABILITY_VALUES.includes(value.availability)) fail('invalid_field_availability', 'availability value is unsupported');
    if (seen.has(value.field)) fail('duplicate_field_availability', 'field availability contains duplicate fields');
    seen.add(value.field);
    return { field: value.field, availability: value.availability };
  });
  return result.sort((left, right) => compareCodeUnits(left.field, right.field));
}
function validateAvailability(value) {
  const normalized = normalizeAvailability(value.field_availability);
  if (JSON.stringify(normalized) !== JSON.stringify(value.field_availability)) fail('noncanonical_availability_order', 'field availability must be in canonical field order');
  if (value.claim_outcome === 'LIMITED' && value.claim_profile === 'WALLET_EFFECT_COVERAGE_V1') {
    if (normalized.length !== 0) fail('field_availability_shape_invalid', 'wallet limited profile does not define a field availability map');
    return;
  }
  const expectedFields = fullFieldNames(value.claim_profile, value.position_state);
  if (normalized.length !== expectedFields.length || normalized.some((item, index) => item.field !== expectedFields[index])) fail('field_availability_shape_invalid', 'field availability must cover the exact canonical full-profile field set');
  if (value.claim_outcome === 'VERIFIED') {
    if (JSON.stringify(normalized) !== JSON.stringify(expectedVerifiedAvailability(value.claim_profile, value.position_state))) fail('verified_availability_invalid', 'verified field availability does not match the canonical matrix');
  } else if (value.claim_outcome === 'LIMITED') {
    if (!normalized.some(item => item.availability === 'UNAVAILABLE')) fail('limited_availability_invalid', 'limited transaction or position result must identify at least one unavailable full-profile field');
    const byField = Object.fromEntries(normalized.map(item => [item.field, item.availability]));
    const requiredAvailable = value.claim_profile === 'TRANSACTION_EFFECT_V1'
      ? ['transaction_identity', 'finalized_execution_status', 'unresolved_effect_references', 'reason_codes']
      : ['scope_identity', 'target_mint', 'exact_quote_mint', 'episode_identity', 'position_state', 'unresolved_claim_affecting_findings'];
    if (requiredAvailable.some(field => byField[field] !== 'AVAILABLE')) fail('limited_availability_invalid', 'fields established directly by the limited profile must be AVAILABLE');
    if (value.claim_profile === 'TRANSACTION_EFFECT_V1' && byField.committed_effects !== 'UNAVAILABLE') fail('limited_availability_invalid', 'limited transaction cannot mark the complete committed-effects field AVAILABLE');
    if (value.claim_profile === 'POSITION_ECONOMICS_V1' && value.position_state !== null) {
      const matrix = POSITION_VERIFIED_FIELD_MATRIX[value.position_state];
      for (const item of normalized) {
        if ((matrix[item.field] === 'NOT_APPLICABLE') !== (item.availability === 'NOT_APPLICABLE')) fail('limited_availability_invalid', 'state-conditioned not-applicable fields must match the verified matrix');
      }
    } else if (normalized.some(item => item.availability === 'NOT_APPLICABLE')) fail('limited_availability_invalid', 'NOT_APPLICABLE requires a state-conditioned profile field');
  }
}
function directResultFields(value) {
  if (value.claim_type === 'TRANSACTION_EFFECT') return new Set([
    'transaction_identity', 'unresolved_effect_references', 'residual_unresolved_effect_references',
    'field_availability', 'reason_codes',
  ]);
  if (value.claim_type === 'WALLET_WINDOW') return new Set([
    'acquisition_window_identity', 'finalized_anchor', 'unresolved_effect_references', 'reason_codes',
  ]);
  return new Set([
    'scope_identity', 'acquisition_evidence_identity', 'target_mint', 'exact_quote_mint', 'episode_identity',
    'opening_boundary', 'ending_boundary', 'position_state', 'exclusion_references',
    'unresolved_claim_affecting_findings', 'unresolved_finding_references',
    'field_availability', 'reason_codes',
  ]);
}
function requiredResultReferenceFields(value) {
  let required;
  if (value.claim_outcome === 'LIMITED') required = LIMITED_RESULT_PROFILE_DEFINITIONS[value.result_profile].required_fields;
  else if (value.claim_outcome !== 'VERIFIED') required = [];
  else if (value.claim_profile !== 'POSITION_ECONOMICS_V1') required = FULL_RESULT_PROFILE_DEFINITIONS[value.claim_profile].required_fields;
  else required = Object.entries(POSITION_VERIFIED_FIELD_MATRIX[value.position_state])
    .filter(([, requirement]) => !['FORBIDDEN', 'NOT_APPLICABLE'].includes(requirement))
    .map(([field]) => field);
  const direct = directResultFields(value);
  return required.filter(field => !direct.has(field)).sort(compareCodeUnits);
}
function normalizeResultReferences(values) {
  if (!Array.isArray(values)) fail('invalid_field', 'result_field_references must be an array');
  const seen = new Set();
  const result = values.map((value, index) => {
    assertExactFields(value, RESULT_REFERENCE_FIELDS, `result_field_references.${index}`);
    assertIdentifier(value.field, `result_field_references.${index}.field`);
    assertDigest(value.value_digest, `result_field_references.${index}.value_digest`);
    if (seen.has(value.field)) fail('duplicate_result_field_reference', 'result field references contain a duplicate field');
    seen.add(value.field);
    return { field: value.field, value_digest: value.value_digest };
  });
  return result.sort((left, right) => compareCodeUnits(left.field, right.field));
}
function validateResultReferences(value) {
  const normalized = normalizeResultReferences(value.result_field_references);
  if (JSON.stringify(normalized) !== JSON.stringify(value.result_field_references)) fail('noncanonical_result_reference_order', 'result field references must be in canonical field order');
  const expected = requiredResultReferenceFields(value);
  if (normalized.length !== expected.length || normalized.some((reference, index) => reference.field !== expected[index])) fail('result_field_reference_shape_invalid', 'result field references must cover the exact full or limited result profile');
}
function validateLegacyReference(value) {
  if (value === null) return;
  assertExactFields(value, LEGACY_REFERENCE_FIELDS, 'legacy_reference');
  assertDigest(value.receipt_hash, 'legacy_reference.receipt_hash');
  assertDigest(value.package_digest, 'legacy_reference.package_digest');
}
function validateReasons(value) {
  if (!Array.isArray(value.reason_codes)) fail('invalid_field', 'reason_codes must be an array');
  const normalized = normalizeReasonCodes(value.reason_codes);
  if (JSON.stringify(normalized) !== JSON.stringify(value.reason_codes)) fail('noncanonical_reason_order', 'reason codes must be unique and in frozen ordinal order');
  const hasNoProjection = value.reason_codes.includes('NO_LIMITED_PROJECTION');
  if (value.claim_outcome === 'VERIFIED' && (value.reason_codes.length || value.unresolved_finding_digests.length)) fail('verified_reason_set_invalid', 'verified claim cannot retain claim-affecting reasons or unresolved findings');
  if (value.claim_outcome === 'LIMITED' && (!value.reason_codes.length || hasNoProjection || value.unresolved_finding_digests.length === 0)) fail('limited_reason_set_invalid', 'limited claim requires substantive reasons, unresolved references, and no NO_LIMITED_PROJECTION');
  if (value.claim_outcome === 'BLOCKED' && (!hasNoProjection || value.reason_codes.length < 2)) fail('blocked_reason_set_invalid', 'blocked claim requires NO_LIMITED_PROJECTION in addition to a substantive reason');
  if (value.claim_outcome === 'NOT_EVALUATED' && (value.reason_codes.length || value.unresolved_finding_digests.length || value.included_evidence_digests.length || value.exclusions.length)) fail('not_evaluated_reason_set_invalid', 'unrequested companion claim carries status only');
}

function validateSemanticEnvelope(value) {
  validateClaimCombination({
    claim_type: value.claim_type,
    claim_profile: value.claim_profile,
    claim_outcome: value.claim_outcome,
    position_state: value.position_state,
    requested: value.requested,
    result_profile: value.result_profile,
  });
  assertIdentifier(value.network, 'network');
  assertIdentifier(value.analyzed_wallet, 'analyzed_wallet');
  assertDigest(value.acquisition_request_digest, 'acquisition_request_digest');
  assertDigest(value.finalized_anchor_digest, 'finalized_anchor_digest', value.claim_outcome === 'BLOCKED');
  assertDigest(value.evidence_context_digest, 'evidence_context_digest', value.claim_outcome === 'BLOCKED');
  assertDigest(value.claim_scope_digest, 'claim_scope_digest');
  for (const field of ['target_mint', 'exact_quote_mint']) assertIdentifier(value[field], field, true);
  for (const field of ['position_episode_digest', 'candidate_digest', 'opening_boundary_digest', 'ending_boundary_digest']) assertDigest(value[field], field, true);
  validateProfiles(value.supporting_profiles);
  assertOrderedUnique(value.included_evidence_digests, 'included_evidence_digests', assertDigest);
  validateCanonicalExclusions(value.exclusions);
  assertOrderedUnique(value.unresolved_finding_digests, 'unresolved_finding_digests', assertDigest);
  const included = new Set(value.included_evidence_digests);
  const excluded = new Set(value.exclusions.map(exclusion => exclusion.evidence_digest));
  const unresolved = new Set(value.unresolved_finding_digests);
  for (const digest of included) if (excluded.has(digest) || unresolved.has(digest)) fail('evidence_category_conflict', 'included evidence cannot also be excluded or unresolved');
  for (const digest of excluded) if (unresolved.has(digest)) fail('evidence_category_conflict', 'excluded evidence cannot also remain unresolved');
  validateReasons(value);
  validateLegacyReference(value.legacy_reference);
  if (value.claim_outcome === 'NOT_EVALUATED' && value.legacy_reference !== null) fail('not_evaluated_reason_set_invalid', 'unrequested companion claim carries status only');

  const position = value.claim_type === 'POSITION_EPISODE';
  if (!position) {
    for (const field of ['target_mint', 'exact_quote_mint', 'position_episode_digest', 'candidate_digest', 'opening_boundary_digest', 'ending_boundary_digest']) if (value[field] !== null) fail('claim_field_not_applicable', `${field} is position-only`, { field });
  } else if (['VERIFIED', 'LIMITED'].includes(value.claim_outcome)) {
    for (const field of ['target_mint', 'exact_quote_mint', 'position_episode_digest']) if (value[field] === null) fail('position_identity_incomplete', `${field} is required for verified or limited position results`, { field });
    if (value.claim_outcome === 'VERIFIED' && (value.opening_boundary_digest === null || value.ending_boundary_digest === null)) fail('position_boundary_incomplete', 'verified position requires opening and ending boundary identities');
  }

  if (['VERIFIED', 'LIMITED'].includes(value.claim_outcome)) {
    validateAvailability(value);
  } else if (!Array.isArray(value.field_availability) || value.field_availability.length !== 0) fail('non_result_shape_invalid', 'blocked and unevaluated claims carry no field availability');
  validateResultReferences(value);
  return true;
}

export function claimDigestPreimage(value) {
  assertPlainJsonValue(value);
  const body = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!['claim_id', 'claim_digest'].includes(key)) Object.defineProperty(body, key, { value: clonePlainData(descriptor.value), enumerable: true, writable: true, configurable: true });
  }
  return cloneAndFreeze({ claim_identity_version: CLAIM_IDENTITY_VERSION, claim: body });
}
export function computeClaimDigest(value) { return sha256CanonicalJson(claimDigestPreimage(value)); }

export function validateClaimEnvelopeV13(value, { verifyDigest = true } = {}) {
  assertExactFields(value, CLAIM_ENVELOPE_FIELDS, 'claim_envelope');
  if (value.claim_envelope_version !== CLAIM_ENVELOPE_VERSION || value.claim_identity_version !== CLAIM_IDENTITY_VERSION) fail('unsupported_claim_version', 'claim envelope or identity version is unsupported');
  assertDigest(value.claim_digest, 'claim_digest');
  if (value.claim_id !== `${CLAIM_ID_PREFIX}${value.claim_digest}`) fail('claim_id_mismatch', 'claim ID must contain the complete claim digest');
  validateSemanticEnvelope(value);
  if (verifyDigest && computeClaimDigest(value) !== value.claim_digest) fail('claim_digest_mismatch', 'claim digest does not match the canonical semantic preimage');
  return true;
}

export function buildClaimEnvelopeV13(input) {
  assertExactFields(input, INPUT_FIELDS, 'claim_input');
  const body = clonePlainData(input);
  body.reason_codes = [...normalizeReasonCodes(body.reason_codes)];
  body.included_evidence_digests = sortedUniqueDigests(body.included_evidence_digests, 'included_evidence_digests');
  body.unresolved_finding_digests = sortedUniqueDigests(body.unresolved_finding_digests, 'unresolved_finding_digests');
  body.exclusions = normalizeExclusions(body.exclusions);
  body.field_availability = normalizeAvailability(body.field_availability);
  body.result_field_references = normalizeResultReferences(body.result_field_references);
  const provisional = {
    claim_envelope_version: CLAIM_ENVELOPE_VERSION,
    claim_identity_version: CLAIM_IDENTITY_VERSION,
    claim_id: `${CLAIM_ID_PREFIX}${'0'.repeat(64)}`,
    claim_digest: '0'.repeat(64),
    ...body,
  };
  validateClaimEnvelopeV13(provisional, { verifyDigest: false });
  const claimDigest = computeClaimDigest(provisional);
  const result = { ...provisional, claim_id: `${CLAIM_ID_PREFIX}${claimDigest}`, claim_digest: claimDigest };
  validateClaimEnvelopeV13(result);
  return cloneAndFreeze(result);
}
