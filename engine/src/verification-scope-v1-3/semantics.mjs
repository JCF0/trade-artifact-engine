import { assertExactFields, assertPlainJsonValue, deepFreeze, fail } from './contract.mjs';

export const VERIFICATION_SCOPE_SPEC_VERSION = 'verification_scope_acceptability_v1_3';
export const CLAIM_TYPES = deepFreeze(['TRANSACTION_EFFECT', 'POSITION_EPISODE', 'WALLET_WINDOW']);
export const CLAIM_PROFILES = deepFreeze(['TRANSACTION_EFFECT_V1', 'POSITION_ECONOMICS_V1', 'WALLET_EFFECT_COVERAGE_V1']);
export const LIMITED_RESULT_PROFILES = deepFreeze(['TRANSACTION_EFFECT_V1_LIMITED', 'POSITION_ECONOMICS_V1_LIMITED', 'WALLET_EFFECT_COVERAGE_V1_LIMITED']);
export const CLAIM_OUTCOMES = deepFreeze(['VERIFIED', 'LIMITED', 'BLOCKED', 'NOT_EVALUATED']);
export const POSITION_STATES = deepFreeze(['CLOSED', 'OPEN_REALIZED_PARTIAL', 'OPEN', null]);
export const POSITION_STATE_DERIVATION_RULE = deepFreeze({ derivation_source: 'ADMITTED_EVIDENCE', independent_of_claim_outcome: true });
export const CLAIM_SCOPED_PROJECTION_RULE = deepFreeze({ source_transaction_promotion_allowed: false, prohibited_derived_label: 'TRANSACTION_VERIFIED' });

export const SUPPORTING_PROFILES = deepFreeze({
  effect_model_profile: 'ARTIFACT_EFFECT_MODEL_V1_15',
  boundary_authority_profile: 'ARTIFACT_POSITION_BOUNDARY_V1',
  canonical_ordering_profile: 'ARTIFACT_CANONICAL_ORDER_V1',
  intra_tx_effect_order_profile: 'ARTIFACT_INTRA_TX_EFFECT_ORDER_V1',
  accounting_profile: 'ARTIFACT_WAC_ACCOUNTING_V1',
  quote_profile: 'ARTIFACT_RAW_QUOTE_V1',
  non_interference_profile: 'ARTIFACT_NON_INTERFERENCE_V1',
  episode_enumeration_profile: 'ARTIFACT_EPISODE_ENUMERATION_V1',
  candidate_population_profile: 'ARTIFACT_CANDIDATE_POPULATION_V1',
  candidate_selection_policy: 'ARTIFACT_EXPLICIT_DIGEST_SELECTION_V1',
});

export const CLAIM_PROFILE_BY_TYPE = deepFreeze({
  TRANSACTION_EFFECT: 'TRANSACTION_EFFECT_V1',
  POSITION_EPISODE: 'POSITION_ECONOMICS_V1',
  WALLET_WINDOW: 'WALLET_EFFECT_COVERAGE_V1',
});
export const LIMITED_PROFILE_BY_CLAIM_PROFILE = deepFreeze({
  TRANSACTION_EFFECT_V1: 'TRANSACTION_EFFECT_V1_LIMITED',
  POSITION_ECONOMICS_V1: 'POSITION_ECONOMICS_V1_LIMITED',
  WALLET_EFFECT_COVERAGE_V1: 'WALLET_EFFECT_COVERAGE_V1_LIMITED',
});

export const REASON_CODES = deepFreeze([
  'ACQUISITION_AUTHORITY_UNRESOLVED',
  'TRANSACTION_EFFECT_UNRESOLVED',
  'OBJECT_BOUNDARY_UNRESOLVED',
  'OPENING_INVENTORY_UNRESOLVED',
  'OPENING_BASIS_UNRESOLVED',
  'ENDING_INVENTORY_UNRESOLVED',
  'TARGET_ACCOUNT_COVERAGE_INCOMPLETE',
  'TARGET_TRANSFER_EXTERNAL_CONTINUATION',
  'UNKNOWN_TOKEN_SCOPE',
  'UNMATCHED_WALLET_INSTRUCTION',
  'UNSUPPORTED_NESTED_INSTRUCTION_SHAPE',
  'ACCOUNT_AUTHORITY_UNRESOLVED',
  'QUOTE_CONTEXT_UNRESOLVED',
  'MIXED_QUOTE_UNSUPPORTED',
  'FEE_TREATMENT_UNRESOLVED',
  'SHARED_EFFECT_ALLOCATION_UNRESOLVED',
  'INTRA_OR_INTER_TX_ORDER_UNRESOLVED',
  'INTRA_TX_EFFECT_ORDER_UNRESOLVED',
  'OVERSOLD_ESTABLISHED_INVENTORY',
  'WALLET_EFFECT_UNRESOLVED',
  'CANDIDATE_POPULATION_INCOMPLETE',
  'NO_LIMITED_PROJECTION',
]);

export const EXCLUSION_CODES = deepFreeze([
  'EXCLUDED_AFTER_CLOSED_BOUNDARY',
  'EXCLUDED_BEFORE_ZERO_OPEN_BOUNDARY',
  'EXCLUDED_ASSET_AND_DIMENSION_DISJOINT',
  'EXCLUDED_FAILED_TX_NO_COMMITTED_TARGET_EFFECT',
  'EXCLUDED_QUOTE_FUNDING_ONLY',
  'EXCLUDED_QUOTE_WITHDRAWAL_ONLY',
]);
export const NON_INTERFERENCE_RULES = deepFreeze(EXCLUSION_CODES.map((exclusion_code, index) => ({
  ordinal: index + 1,
  rule: `NI-0${index + 1}`,
  exclusion_code,
})));

const POSITION_COMMON = deepFreeze({
  scope_identity: 'REQUIRED', target_mint: 'REQUIRED', exact_quote_mint: 'REQUIRED', episode_identity: 'REQUIRED',
  opening_boundary: 'REQUIRED', ending_boundary: 'REQUIRED', opening_target_inventory: 'REQUIRED',
  opening_attributable_basis: 'REQUIRED', acquisition_event_set: 'REQUIRED', disposal_event_set: 'REQUIRED',
  target_transfer_set: 'REQUIRED', aggregate_acquisition_basis: 'REQUIRED', fee_treatment: 'REQUIRED',
  exclusion_references: 'REQUIRED_MAY_BE_EMPTY', unresolved_claim_affecting_findings: 'REQUIRED_EMPTY',
  unrealized_mark_pnl: 'FORBIDDEN', portfolio_return: 'FORBIDDEN',
});
export const POSITION_VERIFIED_FIELD_MATRIX = deepFreeze({
  CLOSED: { ...POSITION_COMMON, disposal_proceeds: 'REQUIRED', realized_basis_consumed: 'REQUIRED', realized_pnl: 'REQUIRED', realized_return: 'REQUIRED', ending_target_inventory: 'EXACT_ZERO', remaining_attributable_basis: 'EXACT_ZERO', position_state: 'CLOSED' },
  OPEN_REALIZED_PARTIAL: { ...POSITION_COMMON, disposal_proceeds: 'REQUIRED', realized_basis_consumed: 'REQUIRED', realized_pnl: 'REQUIRED', realized_return: 'REQUIRED', ending_target_inventory: 'POSITIVE', remaining_attributable_basis: 'REQUIRED', position_state: 'OPEN_REALIZED_PARTIAL' },
  OPEN: { ...POSITION_COMMON, disposal_proceeds: 'NOT_APPLICABLE', realized_basis_consumed: 'NOT_APPLICABLE', realized_pnl: 'NOT_APPLICABLE', realized_return: 'NOT_APPLICABLE', ending_target_inventory: 'POSITIVE', remaining_attributable_basis: 'REQUIRED', position_state: 'OPEN' },
});

export const FULL_RESULT_PROFILE_DEFINITIONS = deepFreeze({
  TRANSACTION_EFFECT_V1: {
    required_fields: ['transaction_identity', 'finalized_execution_status', 'committed_effects', 'unresolved_effect_references', 'reason_codes'],
    empty_fields: ['unresolved_effect_references', 'reason_codes'],
  },
  POSITION_ECONOMICS_V1: { state_conditioned: POSITION_VERIFIED_FIELD_MATRIX },
  WALLET_EFFECT_COVERAGE_V1: {
    required_fields: ['acquisition_window_identity', 'finalized_anchor', 'transaction_population', 'transaction_dispositions', 'unresolved_effect_references', 'reason_codes'],
    empty_fields: ['unresolved_effect_references', 'reason_codes'],
  },
});

export const LIMITED_RESULT_PROFILE_DEFINITIONS = deepFreeze({
  TRANSACTION_EFFECT_V1_LIMITED: { required_fields: ['transaction_identity', 'finalized_execution_status', 'established_effects', 'residual_unresolved_effect_references', 'field_availability', 'reason_codes'] },
  POSITION_ECONOMICS_V1_LIMITED: { required_fields: ['scope_identity', 'acquisition_evidence_identity', 'target_mint', 'exact_quote_mint', 'episode_identity', 'observed_episode_span', 'established_target_effects', 'verified_subordinate_effect_references', 'field_availability', 'unresolved_finding_references', 'reason_codes', 'position_state'] },
  WALLET_EFFECT_COVERAGE_V1_LIMITED: { required_fields: ['acquisition_window_identity', 'finalized_anchor', 'transaction_population', 'transaction_dispositions', 'unresolved_effect_references', 'reason_codes'] },
});

function normalizeOrdinalCodes(value, vocabulary, code) {
  assertPlainJsonValue(value, ['codes']);
  if (!Array.isArray(value)) fail('invalid_code_set', 'canonical code set must be an array');
  const indexes = new Set();
  for (const item of value) {
    const index = vocabulary.indexOf(item);
    if (index < 0) fail(code, 'code is not in the frozen vocabulary', { value: item });
    indexes.add(index);
  }
  return deepFreeze([...indexes].sort((a, b) => a - b).map(index => vocabulary[index]));
}
export function normalizeReasonCodes(value) { return normalizeOrdinalCodes(value, REASON_CODES, 'unknown_reason_code'); }
export function normalizeExclusionCodes(value) { return normalizeOrdinalCodes(value, EXCLUSION_CODES, 'unknown_exclusion_code'); }

export function validateClaimCombination(value) {
  const fields = ['claim_type', 'claim_profile', 'claim_outcome', 'position_state', 'requested', 'result_profile'];
  const descriptors = assertExactFields(value, fields, 'claim_combination');
  value = Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
  if (!CLAIM_TYPES.includes(value.claim_type)) fail('invalid_claim_type', 'claim type is unsupported');
  if (value.claim_profile !== CLAIM_PROFILE_BY_TYPE[value.claim_type]) fail('invalid_claim_profile', 'claim profile does not match claim type');
  if (!CLAIM_OUTCOMES.includes(value.claim_outcome)) fail('invalid_claim_outcome', 'claim outcome is unsupported');
  if (typeof value.requested !== 'boolean') fail('invalid_requested_state', 'requested must be boolean');
  if (value.requested === (value.claim_outcome === 'NOT_EVALUATED')) fail('invalid_requested_outcome', 'requested claims must be evaluated and companion claims must be NOT_EVALUATED');
  if (value.claim_type !== 'POSITION_EPISODE' && value.position_state !== null) fail('invalid_position_state', 'non-position claim state must be null');
  if (value.claim_type === 'POSITION_EPISODE') {
    if (!POSITION_STATES.includes(value.position_state)) fail('invalid_position_state', 'position state is unsupported');
    if (value.claim_outcome === 'VERIFIED' && value.position_state === null) fail('invalid_outcome_state', 'verified position requires a known state');
    if (['BLOCKED', 'NOT_EVALUATED'].includes(value.claim_outcome) && value.position_state !== null) fail('invalid_outcome_state', 'blocked or unevaluated position state must be null');
  }
  const expectedResultProfile = value.claim_outcome === 'VERIFIED' ? value.claim_profile
    : value.claim_outcome === 'LIMITED' ? LIMITED_PROFILE_BY_CLAIM_PROFILE[value.claim_profile] : null;
  if (value.result_profile !== expectedResultProfile) fail('invalid_result_profile', 'result profile does not match claim outcome');
  return true;
}

export function deriveVerificationLabel(value) {
  validateClaimCombination(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors.claim_outcome.value !== 'VERIFIED') return null;
  return ({ TRANSACTION_EFFECT: 'TRANSACTION_VERIFIED', POSITION_EPISODE: 'POSITION_VERIFIED', WALLET_WINDOW: 'WALLET_WINDOW_VERIFIED' })[descriptors.claim_type.value];
}
