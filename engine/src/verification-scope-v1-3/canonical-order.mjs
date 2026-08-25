import {
  assertExactFields, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson,
} from './contract.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from '../wallet-acquisition/solana-identities.mjs';
import { validateSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';

export const CANONICAL_TRANSACTION_ORDER_VERSION_V1_3 = 'artifact_canonical_transaction_order_v1_3';
export const CANONICAL_TRANSACTION_ORDER_PROFILE_V1_3 = 'ARTIFACT_CANONICAL_ORDER_V1';
export const INTRA_TRANSACTION_EFFECT_ORDER_VERSION_V1_3 = 'artifact_intra_tx_effect_order_v1_3';
export const INTRA_TRANSACTION_EFFECT_ORDER_PROFILE_V1_3 = 'ARTIFACT_INTRA_TX_EFFECT_ORDER_V1';

const ORDER_TOP_FIELDS = [
  'canonical_transaction_order_version', 'canonical_ordering_profile', 'analyzed_wallet',
  'population_evidence_identity', 'order_status', 'reason_codes', 'transactions',
];
const ORDER_TRANSACTION_FIELDS = [
  'transaction_identity', 'finalized_execution_status',
  'acquisition_population_coordinate', 'canonical_transaction_coordinate',
];
const TRANSACTION_IDENTITY_FIELDS = ['signature', 'slot', 'block_time', 'transaction_version'];
const SOURCE_FIELDS = ['signature', 'slot', 'block_time', 'execution_state'];
const RECORD_FIELDS = ['transaction', 'effect'];
const INTRA_INPUT_FIELDS = ['wallet', 'target_mint', 'transaction', 'effect'];
const INTRA_TOP_FIELDS = [
  'intra_tx_effect_order_version', 'intra_tx_effect_order_profile', 'transaction_identity',
  'analyzed_wallet', 'target_mint', 'transaction_boundary_units', 'order_status', 'reason_codes',
  'instruction_ordered_effects', 'aggregate_unordered_effects', 'residual_unordered_effects',
  'ambiguity_groups',
];
const BOUNDARY_UNIT_FIELDS = ['transaction_boundary_id', 'transaction_identity'];
const ORDERED_EFFECT_FIELDS = ['effect_id', 'source_coordinate', 'economic_order'];
const UNORDERED_EFFECT_FIELDS = ['effect_id', 'source_coordinate', 'economic_order', 'order_status'];
const RESIDUAL_UNORDERED_FIELDS = ['residual_id', 'source_coordinate', 'economic_order', 'order_status'];
const AMBIGUITY_FIELDS = ['ambiguity_id', 'record_ids', 'reason_code'];
const COORDINATE_FIELDS = ['coordinate_kind', 'outer_instruction_index', 'inner_instruction_index', 'account_index'];

function safeNonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function exactInput(value, fields, context) {
  assertExactFields(value, fields, context);
  return value;
}
function validateWallet(value, field = 'analyzed_wallet') {
  if (!isSolanaPublicKeyV1(value)) fail('invalid_solana_identity', `${field} is invalid`);
}
function validateTransactionIdentity(value, context) {
  assertExactFields(value, TRANSACTION_IDENTITY_FIELDS, context);
  if (!isSolanaSignatureV1(value.signature) || !safeNonnegative(value.slot)
      || !safeNonnegative(value.block_time) || !['legacy', 0].includes(value.transaction_version)) {
    fail('invalid_transaction_identity', `${context} is invalid`);
  }
}
function compareIdentity(left, right) {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
function validateSourceShape(value, context) {
  assertExactFields(value, SOURCE_FIELDS, context);
  if (!isSolanaSignatureV1(value.signature) || !safeNonnegative(value.slot)
      || !safeNonnegative(value.block_time) || !['succeeded', 'failed'].includes(value.execution_state)) {
    fail('invalid_authoritative_population', `${context} is invalid`);
  }
}
function unresolvedTransactions(records) {
  return records.map(record => ({
    transaction_identity: record.effect.transaction_identity,
    finalized_execution_status: record.effect.finalized_execution_status,
    acquisition_population_coordinate: null,
    canonical_transaction_coordinate: null,
  })).sort((left, right) => compareIdentity(left.transaction_identity, right.transaction_identity));
}

export function buildCanonicalTransactionOrderV13(input) {
  exactInput(input, ['wallet', 'authoritative_population', 'transaction_records'], 'canonical_order_input');
  validateWallet(input.wallet, 'canonical_order_input.wallet');
  if (!Array.isArray(input.transaction_records)) fail('invalid_transaction_collection', 'transaction_records must be an array');
  const records = input.transaction_records.map((record, index) => {
    exactInput(record, RECORD_FIELDS, `transaction_records.${index}`);
    validateSolanaFullTransactionEffectV13({ wallet: input.wallet, transaction: record.transaction, effect: record.effect });
    return record;
  });
  const signatures = records.map(record => record.effect.transaction_identity.signature);
  if (new Set(signatures).size !== signatures.length) fail('duplicate_transaction_identity', 'transaction records must be unique');

  const population = Array.isArray(input.authoritative_population) ? input.authoritative_population : null;
  if (population !== null) {
    population.forEach((source, index) => validateSourceShape(source, `authoritative_population.${index}`));
  }

  const result = cloneAndFreeze({
    canonical_transaction_order_version: CANONICAL_TRANSACTION_ORDER_VERSION_V1_3,
    canonical_ordering_profile: CANONICAL_TRANSACTION_ORDER_PROFILE_V1_3,
    analyzed_wallet: input.wallet,
    population_evidence_identity: null,
    order_status: 'UNRESOLVED',
    reason_codes: ['INTRA_OR_INTER_TX_ORDER_UNRESOLVED'],
    transactions: unresolvedTransactions(records),
  });
  validateCanonicalTransactionOrderStructureV13(result);
  return result;
}

export function validateCanonicalTransactionOrderStructureV13(value) {
  assertExactFields(value, ORDER_TOP_FIELDS, 'canonical_transaction_order');
  if (value.canonical_transaction_order_version !== CANONICAL_TRANSACTION_ORDER_VERSION_V1_3
      || value.canonical_ordering_profile !== CANONICAL_TRANSACTION_ORDER_PROFILE_V1_3) {
    fail('unsupported_order_version', 'canonical transaction order version is unsupported');
  }
  validateWallet(value.analyzed_wallet);
  if (value.order_status !== 'UNRESOLVED' || !Array.isArray(value.reason_codes)
      || !Array.isArray(value.transactions)) fail('invalid_order_status', 'canonical order status is invalid');
  value.transactions.forEach((item, index) => {
    assertExactFields(item, ORDER_TRANSACTION_FIELDS, `transactions.${index}`);
    validateTransactionIdentity(item.transaction_identity, `transactions.${index}.transaction_identity`);
    if (!['succeeded', 'failed'].includes(item.finalized_execution_status)) fail('invalid_execution_status', 'transaction execution status is invalid');
  });
  const signatures = value.transactions.map(item => item.transaction_identity.signature);
  if (new Set(signatures).size !== signatures.length) fail('duplicate_transaction_identity', 'ordered transactions must be unique');
  if (value.population_evidence_identity !== null
      || canonicalJson(value.reason_codes) !== canonicalJson(['INTRA_OR_INTER_TX_ORDER_UNRESOLVED'])
      || value.transactions.some(item => item.acquisition_population_coordinate !== null
        || item.canonical_transaction_coordinate !== null)
      || value.transactions.some((item, index) => index > 0
        && compareIdentity(value.transactions[index - 1].transaction_identity, item.transaction_identity) >= 0)) {
    fail('invalid_unresolved_order', 'Slice 3A cannot issue acquisition-population authority');
  }
  return true;
}

export function validateSourceBoundCanonicalTransactionOrderV13(input) {
  assertExactFields(input, ['wallet', 'authoritative_population', 'transaction_records', 'order'],
    'source_bound_canonical_order_input');
  const expected = buildCanonicalTransactionOrderV13({
    wallet: input.wallet,
    authoritative_population: input.authoritative_population,
    transaction_records: input.transaction_records,
  });
  if (canonicalJson(input.order) !== canonicalJson(expected)) {
    fail('canonical_order_source_mismatch', 'canonical order does not match its bound acquisition population');
  }
  return true;
}

function validateCoordinate(value, context, kind) {
  assertExactFields(value, COORDINATE_FIELDS, context);
  if (value.coordinate_kind !== kind) fail('invalid_source_coordinate', `${context} has the wrong coordinate kind`);
  if (kind === 'instruction') {
    if (!safeNonnegative(value.outer_instruction_index)
        || (value.inner_instruction_index !== null && !safeNonnegative(value.inner_instruction_index))
        || value.account_index !== null) fail('invalid_source_coordinate', `${context} is invalid`);
  } else if (value.outer_instruction_index !== null || value.inner_instruction_index !== null
      || !safeNonnegative(value.account_index)) fail('invalid_source_coordinate', `${context} is invalid`);
}
function instructionCompare(left, right) {
  return left.source_coordinate.outer_instruction_index - right.source_coordinate.outer_instruction_index
    || (left.source_coordinate.inner_instruction_index === null ? -1
      : right.source_coordinate.inner_instruction_index === null ? 1
        : left.source_coordinate.inner_instruction_index - right.source_coordinate.inner_instruction_index)
    || (left.effect_id < right.effect_id ? -1 : left.effect_id > right.effect_id ? 1 : 0);
}
function sameInstructionCoordinate(left, right) {
  return left.source_coordinate.outer_instruction_index === right.source_coordinate.outer_instruction_index
    && left.source_coordinate.inner_instruction_index === right.source_coordinate.inner_instruction_index;
}
function boundaryId(wallet, transactionIdentity) {
  return `tx-boundary-${sha256CanonicalJson({
    identity_profile: 'ARTIFACT_TRANSACTION_BOUNDARY_ID_V1', analyzed_wallet: wallet,
    transaction_identity: transactionIdentity,
  })}`;
}
function ambiguityId(transactionIdentity, recordIds) {
  return `order-ambiguity-${sha256CanonicalJson({
    identity_profile: 'ARTIFACT_INTRA_TX_ORDER_AMBIGUITY_ID_V1', transaction_identity: transactionIdentity,
    record_ids: recordIds,
  })}`;
}

export function buildIntraTransactionEffectOrderV13(input) {
  exactInput(input, INTRA_INPUT_FIELDS, 'intra_tx_effect_order_input');
  validateWallet(input.wallet, 'intra_tx_effect_order_input.wallet');
  validateWallet(input.target_mint, 'intra_tx_effect_order_input.target_mint');
  validateSolanaFullTransactionEffectV13({ wallet: input.wallet, transaction: input.transaction, effect: input.effect });

  const targetEffects = input.effect.established_effects.filter(item => item.mint === input.target_mint
    && ((item.signed_raw_quantity !== null && item.signed_raw_quantity !== '0')
      || ['account_creation', 'account_closure'].includes(item.effect_kind)));
  const targetAccounts = new Set(input.effect.established_effects
    .filter(item => item.mint === input.target_mint && item.account !== null)
    .map(item => item.account));
  const instructionOrdered = targetEffects
    .filter(item => item.source_coordinate.coordinate_kind === 'instruction')
    .map(item => ({ effect_id: item.effect_id, source_coordinate: item.source_coordinate, economic_order: null }))
    .sort(instructionCompare);
  let instructionRank = -1;
  instructionOrdered.forEach((item, index) => {
    if (index === 0 || !sameInstructionCoordinate(instructionOrdered[index - 1], item)) instructionRank += 1;
    item.economic_order = instructionRank;
  });
  const aggregateUnordered = targetEffects
    .filter(item => item.source_coordinate.coordinate_kind === 'account_balance')
    .map(item => ({
      effect_id: item.effect_id, source_coordinate: item.source_coordinate,
      economic_order: null, order_status: 'AGGREGATE_CAUSAL_ORDER_UNAVAILABLE',
    }))
    .sort((left, right) => left.effect_id < right.effect_id ? -1 : left.effect_id > right.effect_id ? 1 : 0);
  const residualUnordered = input.effect.residual_unresolved_effects
    .filter(item => ['instruction', 'account_balance'].includes(item.source_coordinate.coordinate_kind)
      && (item.mint === input.target_mint || targetAccounts.has(item.account)
        || item.accounts.some(account => targetAccounts.has(account))))
    .map(item => ({
      residual_id: item.residual_id,
      source_coordinate: item.source_coordinate,
      economic_order: null,
      order_status: 'CAUSAL_SEMANTICS_AND_ORDER_UNAVAILABLE',
    }))
    .sort((left, right) => left.residual_id < right.residual_id ? -1 : left.residual_id > right.residual_id ? 1 : 0);
  const establishedIds = [...instructionOrdered, ...aggregateUnordered].map(item => item.effect_id);
  const potentiallyCompeting = [...establishedIds, ...residualUnordered.map(item => item.residual_id)].sort();
  const duplicateInstructionCoordinate = instructionOrdered.some((item, index) => index > 0
    && sameInstructionCoordinate(instructionOrdered[index - 1], item));
  const unresolved = residualUnordered.length !== 0
    || duplicateInstructionCoordinate || (establishedIds.length >= 2 && aggregateUnordered.length !== 0);
  const ambiguityGroups = unresolved ? [{
    ambiguity_id: ambiguityId(input.effect.transaction_identity, potentiallyCompeting),
    record_ids: potentiallyCompeting,
    reason_code: 'INTRA_TX_EFFECT_ORDER_UNRESOLVED',
  }] : [];
  const result = cloneAndFreeze({
    intra_tx_effect_order_version: INTRA_TRANSACTION_EFFECT_ORDER_VERSION_V1_3,
    intra_tx_effect_order_profile: INTRA_TRANSACTION_EFFECT_ORDER_PROFILE_V1_3,
    transaction_identity: input.effect.transaction_identity,
    analyzed_wallet: input.wallet,
    target_mint: input.target_mint,
    transaction_boundary_units: [{
      transaction_boundary_id: boundaryId(input.wallet, input.effect.transaction_identity),
      transaction_identity: input.effect.transaction_identity,
    }],
    order_status: unresolved ? 'UNRESOLVED' : 'ESTABLISHED_WHERE_AUTHORITATIVE',
    reason_codes: unresolved ? ['INTRA_TX_EFFECT_ORDER_UNRESOLVED'] : [],
    instruction_ordered_effects: instructionOrdered,
    aggregate_unordered_effects: aggregateUnordered,
    residual_unordered_effects: residualUnordered,
    ambiguity_groups: ambiguityGroups,
  });
  validateIntraTransactionEffectOrderStructureV13(result);
  return result;
}

export function validateIntraTransactionEffectOrderStructureV13(value) {
  assertExactFields(value, INTRA_TOP_FIELDS, 'intra_tx_effect_order');
  if (value.intra_tx_effect_order_version !== INTRA_TRANSACTION_EFFECT_ORDER_VERSION_V1_3
      || value.intra_tx_effect_order_profile !== INTRA_TRANSACTION_EFFECT_ORDER_PROFILE_V1_3) {
    fail('unsupported_order_version', 'intra-transaction order version is unsupported');
  }
  validateTransactionIdentity(value.transaction_identity, 'transaction_identity');
  validateWallet(value.analyzed_wallet);
  validateWallet(value.target_mint, 'target_mint');
  if (!Array.isArray(value.transaction_boundary_units) || value.transaction_boundary_units.length !== 1
      || !Array.isArray(value.reason_codes) || !Array.isArray(value.instruction_ordered_effects)
      || !Array.isArray(value.aggregate_unordered_effects) || !Array.isArray(value.residual_unordered_effects)
      || !Array.isArray(value.ambiguity_groups)) {
    fail('invalid_intra_tx_order', 'intra-transaction order collections are invalid');
  }
  const unit = value.transaction_boundary_units[0];
  assertExactFields(unit, BOUNDARY_UNIT_FIELDS, 'transaction_boundary_units.0');
  validateTransactionIdentity(unit.transaction_identity, 'transaction_boundary_units.0.transaction_identity');
  if (canonicalJson(unit.transaction_identity) !== canonicalJson(value.transaction_identity)
      || unit.transaction_boundary_id !== boundaryId(value.analyzed_wallet, value.transaction_identity)) {
    fail('invalid_transaction_boundary', 'transaction boundary must bind the complete transaction');
  }
  value.instruction_ordered_effects.forEach((item, index) => {
    assertExactFields(item, ORDERED_EFFECT_FIELDS, `instruction_ordered_effects.${index}`);
    const previous = value.instruction_ordered_effects[index - 1];
    const expectedRank = index === 0 ? 0
      : previous.economic_order + (sameInstructionCoordinate(previous, item) ? 0 : 1);
    if (!/^effect-[0-9a-f]{64}$/.test(item.effect_id) || item.economic_order !== expectedRank) {
      fail('noncanonical_effect_order', 'instruction economic order must follow authoritative coordinates');
    }
    validateCoordinate(item.source_coordinate, `instruction_ordered_effects.${index}.source_coordinate`, 'instruction');
    if (index > 0 && instructionCompare(value.instruction_ordered_effects[index - 1], item) >= 0) fail('noncanonical_effect_order', 'instruction effects are not canonically ordered');
  });
  value.aggregate_unordered_effects.forEach((item, index) => {
    assertExactFields(item, UNORDERED_EFFECT_FIELDS, `aggregate_unordered_effects.${index}`);
    if (!/^effect-[0-9a-f]{64}$/.test(item.effect_id) || item.economic_order !== null
        || item.order_status !== 'AGGREGATE_CAUSAL_ORDER_UNAVAILABLE') fail('invented_economic_order', 'aggregate observations cannot carry economic order');
    validateCoordinate(item.source_coordinate, `aggregate_unordered_effects.${index}.source_coordinate`, 'account_balance');
    if (index > 0 && value.aggregate_unordered_effects[index - 1].effect_id >= item.effect_id) fail('noncanonical_effect_order', 'aggregate observations are not canonically represented');
  });
  value.residual_unordered_effects.forEach((item, index) => {
    assertExactFields(item, RESIDUAL_UNORDERED_FIELDS, `residual_unordered_effects.${index}`);
    if (!/^residual-[0-9a-f]{64}$/.test(item.residual_id) || item.economic_order !== null
        || item.order_status !== 'CAUSAL_SEMANTICS_AND_ORDER_UNAVAILABLE'
        || !['instruction', 'account_balance'].includes(item.source_coordinate.coordinate_kind)) {
      fail('invented_economic_order', 'residual evidence cannot carry economic order');
    }
    validateCoordinate(item.source_coordinate, `residual_unordered_effects.${index}.source_coordinate`,
      item.source_coordinate.coordinate_kind);
    if (index > 0 && value.residual_unordered_effects[index - 1].residual_id >= item.residual_id) {
      fail('noncanonical_effect_order', 'residual observations are not canonically represented');
    }
  });
  const allIds = [
    ...value.instruction_ordered_effects.map(item => item.effect_id),
    ...value.aggregate_unordered_effects.map(item => item.effect_id),
    ...value.residual_unordered_effects.map(item => item.residual_id),
  ];
  if (new Set(allIds).size !== allIds.length) fail('duplicate_effect_identity', 'ordered effect references must be unique');
  const establishedCount = value.instruction_ordered_effects.length + value.aggregate_unordered_effects.length;
  const duplicateInstructionCoordinate = value.instruction_ordered_effects.some((item, index) => index > 0
    && sameInstructionCoordinate(value.instruction_ordered_effects[index - 1], item));
  const shouldBeUnresolved = value.residual_unordered_effects.length !== 0
    || duplicateInstructionCoordinate
    || (establishedCount >= 2 && value.aggregate_unordered_effects.length !== 0);
  if (value.order_status !== (shouldBeUnresolved ? 'UNRESOLVED' : 'ESTABLISHED_WHERE_AUTHORITATIVE')
      || canonicalJson(value.reason_codes) !== canonicalJson(shouldBeUnresolved ? ['INTRA_TX_EFFECT_ORDER_UNRESOLVED'] : [])) {
    fail('invalid_intra_tx_order', 'intra-transaction order status is inconsistent');
  }
  if (value.ambiguity_groups.length !== (shouldBeUnresolved ? 1 : 0)) fail('invalid_intra_tx_order', 'ambiguity groups are incomplete');
  if (shouldBeUnresolved) {
    const group = value.ambiguity_groups[0];
    assertExactFields(group, AMBIGUITY_FIELDS, 'ambiguity_groups.0');
    const expectedIds = [...allIds].sort();
    if (canonicalJson(group.record_ids) !== canonicalJson(expectedIds)
        || group.reason_code !== 'INTRA_TX_EFFECT_ORDER_UNRESOLVED'
        || group.ambiguity_id !== ambiguityId(value.transaction_identity, expectedIds)) {
      fail('invalid_intra_tx_order', 'ambiguity group is not identity-bound');
    }
  }
  return true;
}

export function validateSourceBoundIntraTransactionEffectOrderV13(input) {
  assertExactFields(input, ['wallet', 'target_mint', 'transaction', 'effect', 'order'],
    'source_bound_intra_tx_order_input');
  const expected = buildIntraTransactionEffectOrderV13({
    wallet: input.wallet,
    target_mint: input.target_mint,
    transaction: input.transaction,
    effect: input.effect,
  });
  if (canonicalJson(input.order) !== canonicalJson(expected)) {
    fail('intra_tx_order_source_mismatch', 'intra-transaction order does not match its bound Slice 2 evidence');
  }
  return true;
}
