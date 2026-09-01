import {
  assertExactFields,
  assertPlainJsonValue,
  canonicalJson,
  cloneAndFreeze,
  deepFreeze,
  fail,
} from './contract.mjs';
import {
  CLAIM_PROFILE_BY_TYPE,
  NON_INTERFERENCE_RULES,
  REASON_CODES,
} from './semantics.mjs';

export const NON_INTERFERENCE_SOURCE_KINDS = deepFreeze([
  'TRANSACTION_EFFECT_RESIDUAL',
  'POSITION_ECONOMIC_DEPENDENCY',
  'ACQUISITION_ACTIVITY_FINDING',
  'BOUNDARY_FINDING',
]);
export const NON_INTERFERENCE_DECISIONS = deepFreeze(['EXCLUDED_NON_INTERFERING', 'CLAIM_AFFECTING']);
export const AVAILABILITY_CONSEQUENCES = deepFreeze(['NO_AVAILABILITY_CHANGE', 'MATERIAL_FIELDS_UNAVAILABLE']);
export const AFFECTED_DIMENSIONS = deepFreeze([
  'TRANSACTION_COMPLETENESS',
  'TARGET_QUANTITY',
  'TARGET_ACCOUNT_OWNERSHIP_AUTHORITY',
  'TARGET_ACCOUNT_CLOSURE_DELEGATION',
  'QUOTE_CONSIDERATION',
  'FEE_NATIVE_TREATMENT',
  'EXTERNAL_INVENTORY_CONTINUITY',
  'BOUNDARY_VALIDITY',
  'ECONOMIC_ORDER',
  'WALLET_EFFECT_COVERAGE',
]);

const CONTEXT_FIELDS = [
  'claim_type', 'claim_profile', 'target_mint', 'exact_quote_mint', 'target_accounts',
  'closed_boundary_coordinate', 'zero_open_boundary_coordinate',
];
const ITEM_FIELDS = [
  'reference_digest', 'source_kind', 'transaction_coordinate', 'transaction_status',
  'residual_reason', 'mint', 'accounts', 'established_effect_kinds', 'dependency_code',
  'dependency_references', 'transaction_residual_reasons', 'dependency_last_event_ordinal',
  'basis_reset_event_ordinal',
];
export const NON_INTERFERENCE_DECISION_FIELDS = deepFreeze([
  'unresolved_reference', 'source_kind', 'affected_dimensions', 'affected_fields', 'decision',
  'applied_rule', 'exclusion_code', 'availability_consequence', 'authoritative_proof_references',
]);
const DIGEST = /^[0-9a-f]{64}$/;
const RESIDUAL_REASONS = [
  'UNKNOWN_TOKEN_OWNER', 'TOKEN_BALANCE_SIDE_MISSING', 'UNMATCHED_WALLET_INSTRUCTION',
  'NATIVE_BALANCE_RECONCILIATION', 'FAILED_TOKEN_BALANCE_OBSERVATION',
  'ACCOUNT_CLOSURE_UNRESOLVED', 'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED',
  'EXTERNAL_CLOSURE_RENT', 'WALLET_ACCOUNT_EVIDENCE_MISSING',
];
const EFFECT_KINDS = [
  'network_fee', 'token_balance_observation', 'native_balance_observation', 'token_transfer',
  'native_transfer', 'account_creation', 'account_closure',
];
const DEPENDENCY_CODES = [
  'OPENING_BASIS_UNRESOLVED', 'QUOTE_CONTEXT_UNRESOLVED', 'TRANSFER_IN_BASIS_UNRESOLVED',
  'TARGET_TRANSFER_EXTERNAL_CONTINUATION', 'SHARED_EFFECT_ALLOCATION_UNRESOLVED',
  'MIXED_QUOTE_UNSUPPORTED',
];

const POSITION_FIELD_ORDER = [
  'scope_identity', 'target_mint', 'exact_quote_mint', 'episode_identity', 'opening_boundary',
  'ending_boundary', 'opening_target_inventory', 'opening_attributable_basis',
  'acquisition_event_set', 'disposal_event_set', 'target_transfer_set',
  'aggregate_acquisition_basis', 'fee_treatment', 'exclusion_references',
  'unresolved_claim_affecting_findings', 'disposal_proceeds', 'realized_basis_consumed',
  'realized_pnl', 'realized_return', 'ending_target_inventory',
  'remaining_attributable_basis', 'position_state',
];
const POSITION_FIELDS_BY_DIMENSION = Object.freeze({
  TARGET_QUANTITY: ['acquisition_event_set', 'disposal_event_set', 'target_transfer_set', 'aggregate_acquisition_basis', 'disposal_proceeds', 'realized_basis_consumed', 'realized_pnl', 'realized_return', 'ending_target_inventory', 'remaining_attributable_basis', 'position_state'],
  TARGET_ACCOUNT_OWNERSHIP_AUTHORITY: ['opening_boundary', 'ending_boundary', 'opening_target_inventory', 'acquisition_event_set', 'disposal_event_set', 'target_transfer_set', 'ending_target_inventory', 'remaining_attributable_basis', 'position_state'],
  TARGET_ACCOUNT_CLOSURE_DELEGATION: ['ending_boundary', 'target_transfer_set', 'ending_target_inventory', 'remaining_attributable_basis', 'position_state'],
  QUOTE_CONSIDERATION: ['opening_attributable_basis', 'aggregate_acquisition_basis', 'disposal_proceeds', 'realized_basis_consumed', 'realized_pnl', 'realized_return', 'remaining_attributable_basis'],
  FEE_NATIVE_TREATMENT: ['aggregate_acquisition_basis', 'fee_treatment', 'disposal_proceeds', 'realized_basis_consumed', 'realized_pnl', 'realized_return', 'remaining_attributable_basis'],
  EXTERNAL_INVENTORY_CONTINUITY: ['target_transfer_set', 'ending_target_inventory', 'remaining_attributable_basis', 'position_state'],
  BOUNDARY_VALIDITY: ['opening_boundary', 'ending_boundary', 'opening_target_inventory', 'opening_attributable_basis', 'ending_target_inventory', 'remaining_attributable_basis', 'position_state'],
  ECONOMIC_ORDER: ['acquisition_event_set', 'disposal_event_set', 'target_transfer_set', 'aggregate_acquisition_basis', 'disposal_proceeds', 'realized_basis_consumed', 'realized_pnl', 'realized_return', 'ending_target_inventory', 'remaining_attributable_basis', 'position_state'],
});
const BASIS_INTERVAL_FIELDS = ['realized_basis_consumed', 'realized_pnl', 'realized_return', 'remaining_attributable_basis'];

function plainStrings(value, context, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) fail(`${context}_invalid`, `${context} must be an array`);
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) fail(`${context}_invalid`, `${context} entries must be non-empty strings`);
    result.push(item);
  }
  if (!allowEmpty && result.length === 0) fail(`${context}_invalid`, `${context} must not be empty`);
  return [...new Set(result)].sort();
}
function nullableCoordinate(value, field) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) fail(`${field}_invalid`, `${field} must be null or a nonnegative safe integer`);
  return value;
}
function normalizeContext(value) {
  const descriptors = assertExactFields(value, CONTEXT_FIELDS, 'non_interference_claim_context');
  const context = Object.fromEntries(CONTEXT_FIELDS.map(field => [field, descriptors[field].value]));
  if (CLAIM_PROFILE_BY_TYPE[context.claim_type] !== context.claim_profile) fail('claim_profile_invalid', 'claim profile does not match claim type');
  const position = context.claim_type === 'POSITION_EPISODE';
  if (position !== (typeof context.target_mint === 'string' && context.target_mint.length > 0)) fail('target_mint_invalid', 'target mint is required only for position claims');
  if (position !== (typeof context.exact_quote_mint === 'string' && context.exact_quote_mint.length > 0)) fail('quote_mint_invalid', 'exact quote mint is required only for position claims');
  context.target_accounts = plainStrings(context.target_accounts, 'target_accounts');
  if (!position && context.target_accounts.length !== 0) fail('target_accounts_invalid', 'target accounts are position-only');
  context.closed_boundary_coordinate = nullableCoordinate(context.closed_boundary_coordinate, 'closed_boundary_coordinate');
  context.zero_open_boundary_coordinate = nullableCoordinate(context.zero_open_boundary_coordinate, 'zero_open_boundary_coordinate');
  return context;
}
function normalizeItem(value) {
  let descriptors;
  try { descriptors = assertExactFields(value, ITEM_FIELDS, 'non_interference_evidence_item'); }
  catch (error) {
    if (error?.code === 'unknown_field' || error?.code === 'missing_field' || error?.code === 'invalid_object') fail('evidence_item_shape_invalid', 'evidence item must use the closed schema');
    throw error;
  }
  const item = Object.fromEntries(ITEM_FIELDS.map(field => [field, descriptors[field].value]));
  if (!DIGEST.test(item.reference_digest)) fail('reference_digest_invalid', 'reference digest must be lowercase SHA-256');
  if (!NON_INTERFERENCE_SOURCE_KINDS.includes(item.source_kind)) fail('source_kind_invalid', 'unsupported non-interference source kind');
  item.transaction_coordinate = nullableCoordinate(item.transaction_coordinate, 'transaction_coordinate');
  if (![null, 'succeeded', 'failed'].includes(item.transaction_status)) fail('transaction_status_invalid', 'invalid transaction status');
  if (item.residual_reason !== null && !RESIDUAL_REASONS.includes(item.residual_reason)) fail('residual_reason_invalid', 'unsupported residual reason');
  if (item.mint !== null && (typeof item.mint !== 'string' || item.mint.length === 0)) fail('mint_invalid', 'mint must be null or a non-empty string');
  item.accounts = plainStrings(item.accounts, 'accounts');
  item.established_effect_kinds = plainStrings(item.established_effect_kinds, 'established_effect_kinds');
  if (item.established_effect_kinds.some(kind => !EFFECT_KINDS.includes(kind))) fail('established_effect_kind_invalid', 'unsupported established effect kind');
  if (item.dependency_code !== null && !DEPENDENCY_CODES.includes(item.dependency_code)) fail('dependency_code_invalid', 'unsupported position dependency code');
  item.dependency_references = plainStrings(item.dependency_references, 'dependency_references');
  if (item.dependency_references.some(reference => !DIGEST.test(reference))) fail('dependency_reference_invalid', 'dependency references must be lowercase SHA-256');
  item.transaction_residual_reasons = plainStrings(item.transaction_residual_reasons, 'transaction_residual_reasons');
  if (item.transaction_residual_reasons.some(reason => !RESIDUAL_REASONS.includes(reason))) fail('transaction_residual_reason_invalid', 'unsupported transaction residual reason');
  item.dependency_last_event_ordinal = nullableCoordinate(item.dependency_last_event_ordinal, 'dependency_last_event_ordinal');
  item.basis_reset_event_ordinal = nullableCoordinate(item.basis_reset_event_ordinal, 'basis_reset_event_ordinal');
  if (item.source_kind === 'TRANSACTION_EFFECT_RESIDUAL') {
    const unclassifiedEstablishedEffect = item.residual_reason === null && item.established_effect_kinds.length > 0;
    if ((!unclassifiedEstablishedEffect && item.residual_reason === null) || item.transaction_coordinate === null || item.transaction_status === null || item.dependency_code !== null
        || item.dependency_last_event_ordinal !== null || item.basis_reset_event_ordinal !== null) fail('residual_item_semantics_invalid', 'transaction residual fields are incomplete or contradictory');
    if (item.residual_reason !== null && !item.transaction_residual_reasons.includes(item.residual_reason)) fail('residual_item_semantics_invalid', 'transaction residual population omits the current residual reason');
  } else if (item.source_kind === 'POSITION_ECONOMIC_DEPENDENCY') {
    if (item.dependency_code === null || item.residual_reason !== null || item.transaction_status !== null || item.established_effect_kinds.length !== 0 || item.transaction_residual_reasons.length !== 0) fail('dependency_item_semantics_invalid', 'position dependency fields are incomplete or contradictory');
    if (item.dependency_last_event_ordinal === null
        || (item.basis_reset_event_ordinal !== null && item.basis_reset_event_ordinal <= item.dependency_last_event_ordinal)) fail('dependency_interval_invalid', 'position dependency interval is invalid');
  } else if (item.dependency_last_event_ordinal !== null || item.basis_reset_event_ordinal !== null || item.transaction_residual_reasons.length !== 0) {
    fail('dependency_interval_invalid', 'only position dependencies may carry economic interval ordinals');
  }
  return item;
}

function residualDimensions(item, context) {
  if (item.residual_reason === 'UNMATCHED_WALLET_INSTRUCTION' || item.residual_reason === 'WALLET_ACCOUNT_EVIDENCE_MISSING') {
    return ['TARGET_QUANTITY', 'TARGET_ACCOUNT_OWNERSHIP_AUTHORITY', 'TARGET_ACCOUNT_CLOSURE_DELEGATION', 'QUOTE_CONSIDERATION', 'FEE_NATIVE_TREATMENT', 'EXTERNAL_INVENTORY_CONTINUITY', 'BOUNDARY_VALIDITY', 'ECONOMIC_ORDER'];
  }
  if (item.residual_reason === 'NATIVE_BALANCE_RECONCILIATION' || item.residual_reason === 'EXTERNAL_CLOSURE_RENT') return ['FEE_NATIVE_TREATMENT'];
  const targetOrUnknown = item.mint === null || item.mint === context.target_mint;
  const quoteOrUnknown = item.mint === null || item.mint === context.exact_quote_mint;
  const result = [];
  if (targetOrUnknown) result.push('TARGET_QUANTITY', 'ECONOMIC_ORDER');
  if (quoteOrUnknown) result.push('QUOTE_CONSIDERATION');
  if (['UNKNOWN_TOKEN_OWNER', 'ACCOUNT_CLOSURE_UNRESOLVED', 'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED'].includes(item.residual_reason) && targetOrUnknown) {
    result.push('TARGET_ACCOUNT_OWNERSHIP_AUTHORITY', 'TARGET_ACCOUNT_CLOSURE_DELEGATION', 'BOUNDARY_VALIDITY', 'EXTERNAL_INVENTORY_CONTINUITY');
  }
  return [...new Set(result)];
}
function dependencyDimensions(code) {
  if (code === 'OPENING_BASIS_UNRESOLVED') return ['QUOTE_CONSIDERATION', 'BOUNDARY_VALIDITY'];
  if (code === 'TRANSFER_IN_BASIS_UNRESOLVED') return [];
  if (code === 'TARGET_TRANSFER_EXTERNAL_CONTINUATION') return ['EXTERNAL_INVENTORY_CONTINUITY'];
  if (code === 'SHARED_EFFECT_ALLOCATION_UNRESOLVED') return ['FEE_NATIVE_TREATMENT'];
  return ['QUOTE_CONSIDERATION'];
}
function affectedDimensions(item, context) {
  if (context.claim_type === 'TRANSACTION_EFFECT') return ['TRANSACTION_COMPLETENESS'];
  if (context.claim_type === 'WALLET_WINDOW') return ['WALLET_EFFECT_COVERAGE'];
  if (item.source_kind === 'POSITION_ECONOMIC_DEPENDENCY') return dependencyDimensions(item.dependency_code);
  if (item.source_kind === 'TRANSACTION_EFFECT_RESIDUAL') return residualDimensions(item, context);
  return ['TARGET_QUANTITY', 'TARGET_ACCOUNT_OWNERSHIP_AUTHORITY', 'QUOTE_CONSIDERATION', 'FEE_NATIVE_TREATMENT', 'EXTERNAL_INVENTORY_CONTINUITY', 'BOUNDARY_VALIDITY', 'ECONOMIC_ORDER'];
}
function affectedFields(item, dimensions, context) {
  if (context.claim_type === 'TRANSACTION_EFFECT') return ['committed_effects'];
  if (context.claim_type === 'WALLET_WINDOW') return ['transaction_dispositions'];
  if (item.dependency_code === 'TRANSFER_IN_BASIS_UNRESOLVED') {
    return item.basis_reset_event_ordinal === null ? BASIS_INTERVAL_FIELDS : BASIS_INTERVAL_FIELDS.filter(field => field !== 'remaining_attributable_basis');
  }
  if (item.dependency_code === 'OPENING_BASIS_UNRESOLVED') {
    const fields = ['opening_attributable_basis', ...BASIS_INTERVAL_FIELDS];
    return item.basis_reset_event_ordinal === null ? fields : fields.filter(field => field !== 'remaining_attributable_basis');
  }
  const fields = new Set(['unresolved_claim_affecting_findings']);
  for (const dimension of dimensions) for (const field of POSITION_FIELDS_BY_DIMENSION[dimension] ?? []) fields.add(field);
  return POSITION_FIELD_ORDER.filter(field => fields.has(field));
}
function ni03(item, context) {
  const eligibleResidual = item.source_kind === 'TRANSACTION_EFFECT_RESIDUAL'
    && ['TOKEN_BALANCE_SIDE_MISSING', 'FAILED_TOKEN_BALANCE_OBSERVATION'].includes(item.residual_reason);
  if (!eligibleResidual) return false;
  if (item.established_effect_kinds.some(kind => ['token_transfer', 'native_transfer', 'account_creation', 'account_closure'].includes(kind))) return false;
  if (item.mint === null || item.mint === context.target_mint || item.mint === context.exact_quote_mint) return false;
  if (item.accounts.length === 0) return false;
  const target = new Set(context.target_accounts);
  return item.accounts.every(account => !target.has(account));
}
function applicableRule(item, context) {
  if (context.claim_type !== 'POSITION_EPISODE') return null;
  if (context.closed_boundary_coordinate !== null && item.transaction_coordinate !== null && item.transaction_coordinate > context.closed_boundary_coordinate) return NON_INTERFERENCE_RULES[0];
  if (context.zero_open_boundary_coordinate !== null && item.transaction_coordinate !== null && item.transaction_coordinate < context.zero_open_boundary_coordinate) return NON_INTERFERENCE_RULES[1];
  if (item.source_kind === 'TRANSACTION_EFFECT_RESIDUAL' && ni03(item, context)) return NON_INTERFERENCE_RULES[2];
  if (item.source_kind === 'TRANSACTION_EFFECT_RESIDUAL' && item.transaction_status === 'failed'
      && (item.residual_reason === null || item.residual_reason === 'FAILED_TOKEN_BALANCE_OBSERVATION')
      && item.established_effect_kinds.includes('network_fee')
      && item.established_effect_kinds.includes('native_balance_observation')
      && !item.transaction_residual_reasons.some(reason => ['NATIVE_BALANCE_RECONCILIATION', 'WALLET_ACCOUNT_EVIDENCE_MISSING'].includes(reason))
      && !item.established_effect_kinds.some(kind => ['token_transfer', 'account_creation', 'account_closure'].includes(kind))) return NON_INTERFERENCE_RULES[3];
  return null;
}

function validateCanonicalUniqueArray(value, allowed, context) {
  if (!Array.isArray(value)) fail(`${context}_invalid`, `${context} must be an array`);
  const normalized = [...new Set(value)].sort((left, right) => allowed.indexOf(left) - allowed.indexOf(right));
  if (normalized.length !== value.length || value.some((item, index) => item !== normalized[index]) || value.some(item => !allowed.includes(item))) {
    fail(`${context}_noncanonical`, `${context} is not a canonical closed array`);
  }
}

export function validateNonInterferenceDecisionStructureV13(value) {
  assertPlainJsonValue(value, ['non_interference_decision']);
  const descriptors = assertExactFields(value, NON_INTERFERENCE_DECISION_FIELDS, 'non_interference_decision');
  value = Object.fromEntries(NON_INTERFERENCE_DECISION_FIELDS.map(field => [field, descriptors[field].value]));
  if (!DIGEST.test(value.unresolved_reference)) fail('unresolved_reference_invalid', 'unresolved reference must be lowercase SHA-256');
  if (!NON_INTERFERENCE_SOURCE_KINDS.includes(value.source_kind)) fail('source_kind_invalid', 'source kind is invalid');
  validateCanonicalUniqueArray(value.affected_dimensions, AFFECTED_DIMENSIONS, 'affected_dimensions');
  validateCanonicalUniqueArray(value.affected_fields, [...POSITION_FIELD_ORDER, 'committed_effects', 'transaction_dispositions'], 'affected_fields');
  if (!NON_INTERFERENCE_DECISIONS.includes(value.decision) || !AVAILABILITY_CONSEQUENCES.includes(value.availability_consequence)) fail('decision_invalid', 'non-interference decision is invalid');
  if (!Array.isArray(value.authoritative_proof_references)
      || value.authoritative_proof_references.some(reference => !DIGEST.test(reference))
      || canonicalJson(value.authoritative_proof_references) !== canonicalJson([...new Set(value.authoritative_proof_references)].sort())) {
    fail('proof_references_noncanonical', 'authoritative proof references are not canonical');
  }
  if (value.decision === 'EXCLUDED_NON_INTERFERING') {
    const rule = NON_INTERFERENCE_RULES.find(item => item.rule === value.applied_rule && item.exclusion_code === value.exclusion_code);
    if (!rule || value.availability_consequence !== 'NO_AVAILABILITY_CHANGE' || !value.authoritative_proof_references.includes(value.unresolved_reference)) fail('exclusion_decision_invalid', 'excluded decision is internally inconsistent');
  } else if (value.applied_rule !== null || value.exclusion_code !== null || value.availability_consequence !== 'MATERIAL_FIELDS_UNAVAILABLE' || value.authoritative_proof_references.length !== 0) {
    fail('claim_affecting_decision_invalid', 'claim-affecting decision is internally inconsistent');
  }
  return true;
}

export function deriveNonInterferenceDecisionsV13(input) {
  assertPlainJsonValue(input, ['non_interference_input']);
  const descriptors = assertExactFields(input, ['claim_context', 'evidence_items'], 'non_interference_input');
  const context = normalizeContext(descriptors.claim_context.value);
  if (!Array.isArray(descriptors.evidence_items.value)) fail('evidence_items_invalid', 'evidence items must be an array');
  const items = descriptors.evidence_items.value.map(normalizeItem);
  const byDigest = new Map();
  for (const item of items) {
    const prior = byDigest.get(item.reference_digest);
    if (prior && canonicalJson(prior) !== canonicalJson(item)) fail('conflicting_evidence_reference', 'one evidence reference cannot carry multiple semantics');
    if (!prior) byDigest.set(item.reference_digest, item);
  }
  const result = [...byDigest.values()].sort((a, b) => a.reference_digest.localeCompare(b.reference_digest)).map(item => {
    const dimensions = affectedDimensions(item, context).sort((a, b) => AFFECTED_DIMENSIONS.indexOf(a) - AFFECTED_DIMENSIONS.indexOf(b));
    const fields = affectedFields(item, dimensions, context);
    const rule = applicableRule(item, context);
    const proofReferences = rule ? [item.reference_digest, ...item.dependency_references].sort() : [];
    return {
      unresolved_reference: item.reference_digest,
      source_kind: item.source_kind,
      affected_dimensions: dimensions,
      affected_fields: fields,
      decision: rule ? 'EXCLUDED_NON_INTERFERING' : 'CLAIM_AFFECTING',
      applied_rule: rule?.rule ?? null,
      exclusion_code: rule?.exclusion_code ?? null,
      availability_consequence: rule ? 'NO_AVAILABILITY_CHANGE' : 'MATERIAL_FIELDS_UNAVAILABLE',
      authoritative_proof_references: proofReferences,
    };
  });
  for (const decision of result) validateNonInterferenceDecisionStructureV13(decision);
  return cloneAndFreeze(result);
}
