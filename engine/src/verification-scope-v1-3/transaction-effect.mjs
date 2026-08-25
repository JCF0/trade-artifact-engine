import {
  assertExactFields, canonicalJson, fail, sha256CanonicalJson,
} from './contract.mjs';
import {
  isSolanaPublicKeyV1, isSolanaSignatureV1,
} from '../wallet-acquisition/solana-identities.mjs';

export const TRANSACTION_EFFECT_VERSION_V1_3 = 'artifact_transaction_effect_projection_v1_3';
export const TRANSACTION_EFFECT_MODEL_PROFILE_V1_3 = 'ARTIFACT_EFFECT_MODEL_V1_15';

const TOP_FIELDS = [
  'transaction_effect_version', 'effect_model_profile', 'transaction_identity',
  'finalized_execution_status', 'analyzed_wallet', 'fee_payer', 'fee_lamports', 'economic_order_status',
  'established_effects', 'residual_unresolved_effects',
];
const TRANSACTION_FIELDS = ['signature', 'slot', 'block_time', 'transaction_version'];
const COORDINATE_FIELDS = [
  'coordinate_kind', 'outer_instruction_index', 'inner_instruction_index', 'account_index',
];
const EFFECT_FIELDS = [
  'effect_id', 'canonical_order', 'effect_kind', 'commitment', 'evidence_role',
  'corroborating_effect_ids', 'economic_order', 'source_coordinate',
  'account', 'owner', 'authority', 'destination', 'mint', 'token_program', 'direction',
  'signed_raw_quantity', 'decimals', 'signed_lamports',
];
const RESIDUAL_FIELDS = [
  'residual_id', 'canonical_order', 'reason_code', 'source_coordinate', 'program_id', 'accounts', 'account',
  'owner', 'authority', 'destination', 'mint', 'token_program',
  'observed_signed_raw_quantity', 'observed_signed_lamports',
  'missing_balance_side', 'related_effect_ids',
];
const EFFECT_KINDS = [
  'network_fee', 'token_balance_observation', 'native_balance_observation',
  'token_transfer', 'native_transfer', 'account_creation', 'account_closure',
];
const OBSERVATION_KINDS = new Set(['token_balance_observation', 'native_balance_observation']);
export const TRANSACTION_EFFECT_RESIDUAL_REASONS_V1_3 = Object.freeze([
  'UNKNOWN_TOKEN_OWNER',
  'TOKEN_BALANCE_SIDE_MISSING',
  'UNMATCHED_WALLET_INSTRUCTION',
  'NATIVE_BALANCE_RECONCILIATION',
  'FAILED_TOKEN_BALANCE_OBSERVATION',
  'ACCOUNT_CLOSURE_UNRESOLVED',
  'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED',
  'EXTERNAL_CLOSURE_RENT',
  'WALLET_ACCOUNT_EVIDENCE_MISSING',
]);
const DIRECTIONS = new Set(['debit', 'credit', 'none']);
const SIGNED_INTEGER = /^(?:0|-?[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SOURCE_BALANCE_SUM = MAX_SAFE_INTEGER * 100_000n;

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function publicKey(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (!isSolanaPublicKeyV1(value)) fail('invalid_solana_identity', `${field} is invalid`);
}
function exactInteger(value, field, { nullable = false, max = MAX_SAFE_INTEGER } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > 22 || !SIGNED_INTEGER.test(value)) {
    fail('invalid_exact_integer', `${field} is not a canonical source-domain integer`);
  }
  const parsed = BigInt(value);
  if (parsed > max || parsed < -max) fail('invalid_exact_integer', `${field} exceeds the admitted source domain`);
}
function directionFor(value) {
  if (value === '0') return 'none';
  return value.startsWith('-') ? 'debit' : 'credit';
}
function exactSortedUniqueIds(value, field) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !/^(?:effect|residual)-[0-9a-f]{64}$/.test(id))) {
    fail('invalid_reconciliation_reference', `${field} must contain canonical record IDs`);
  }
  const canonical = [...new Set(value)].sort();
  if (canonical.length !== value.length || canonical.some((id, index) => id !== value[index])) {
    fail('invalid_reconciliation_reference', `${field} must be sorted and unique`);
  }
}

function validateCoordinate(value, context) {
  assertExactFields(value, COORDINATE_FIELDS, context);
  const { outer_instruction_index: outer, inner_instruction_index: inner, account_index: account } = value;
  if (value.coordinate_kind === 'transaction_fee') {
    if (outer !== null || inner !== null || account !== null) fail('invalid_source_coordinate', `${context} transaction fee coordinate is malformed`);
  } else if (value.coordinate_kind === 'account_balance') {
    if (outer !== null || inner !== null || !safeNonnegativeInteger(account)) fail('invalid_source_coordinate', `${context} account balance coordinate is malformed`);
  } else if (value.coordinate_kind === 'transaction') {
    if (outer !== null || inner !== null || account !== null) fail('invalid_source_coordinate', `${context} transaction coordinate is malformed`);
  } else if (value.coordinate_kind === 'instruction') {
    if (!safeNonnegativeInteger(outer) || (inner !== null && !safeNonnegativeInteger(inner)) || account !== null) fail('invalid_source_coordinate', `${context} instruction coordinate is malformed`);
  } else fail('invalid_source_coordinate', `${context} coordinate kind is unsupported`);
}

function idPreimage(transactionIdentity, analyzedWallet, recordKind, record) {
  const idField = recordKind === 'effect' ? 'effect_id' : 'residual_id';
  const semanticRecord = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(record))) {
    if (key !== idField && key !== 'canonical_order') semanticRecord[key] = descriptor.value;
  }
  return {
    identity_profile: 'ARTIFACT_TRANSACTION_EFFECT_RECORD_ID_V1',
    transaction_identity: transactionIdentity,
    analyzed_wallet: analyzedWallet,
    record_kind: recordKind,
    record: semanticRecord,
  };
}

export function canonicalTransactionEffectRecordIdV13(input) {
  assertExactFields(input, ['transaction_identity', 'analyzed_wallet', 'record_kind', 'record'], 'record_identity_input');
  publicKey(input.analyzed_wallet, 'record_identity_input.analyzed_wallet');
  if (!['effect', 'residual'].includes(input.record_kind)) fail('invalid_effect_identity', 'record kind is invalid');
  const prefix = input.record_kind === 'effect' ? 'effect' : 'residual';
  return `${prefix}-${sha256CanonicalJson(idPreimage(input.transaction_identity, input.analyzed_wallet, input.record_kind, input.record))}`;
}

function coordinateSortKey(coordinate) {
  const rank = ({ transaction_fee: 0, account_balance: 1, instruction: 2, transaction: 3 })[coordinate.coordinate_kind];
  return [rank, coordinate.account_index ?? -1, coordinate.outer_instruction_index ?? -1, coordinate.inner_instruction_index ?? -1];
}
function compareValues(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
export function compareTransactionEffectRecordsV13(left, right, recordKind) {
  const leftCoordinate = coordinateSortKey(left.source_coordinate);
  const rightCoordinate = coordinateSortKey(right.source_coordinate);
  for (let index = 0; index < leftCoordinate.length; index += 1) {
    const compared = leftCoordinate[index] - rightCoordinate[index];
    if (compared !== 0) return compared;
  }
  const vocabulary = recordKind === 'effect' ? EFFECT_KINDS : TRANSACTION_EFFECT_RESIDUAL_REASONS_V1_3;
  const discriminator = recordKind === 'effect' ? 'effect_kind' : 'reason_code';
  const kindDifference = vocabulary.indexOf(left[discriminator]) - vocabulary.indexOf(right[discriminator]);
  if (kindDifference !== 0) return kindDifference;
  const leftSemantic = canonicalJson(idPreimage({}, '', recordKind, left).record);
  const rightSemantic = canonicalJson(idPreimage({}, '', recordKind, right).record);
  return compareValues(leftSemantic, rightSemantic);
}

function validateEffect(value, index, projection) {
  const context = `established_effects.${index}`;
  assertExactFields(value, EFFECT_FIELDS, context);
  if (value.canonical_order !== index) fail('noncanonical_effect_order', 'effect canonical_order must be dense');
  if (!EFFECT_KINDS.includes(value.effect_kind)) fail('invalid_effect_kind', `${context}.effect_kind is unsupported`);
  if (value.commitment !== 'committed') fail('invalid_effect_commitment', `${context}.commitment must be committed`);
  const expectedRole = OBSERVATION_KINDS.has(value.effect_kind) ? 'observation' : 'attributed_component';
  if (value.evidence_role !== expectedRole) fail('invalid_evidence_role', `${context}.evidence_role is invalid`);
  exactSortedUniqueIds(value.corroborating_effect_ids, `${context}.corroborating_effect_ids`);
  if (value.evidence_role === 'observation' && value.corroborating_effect_ids.length !== 0) {
    fail('invalid_reconciliation_reference', 'observation records cannot reference corroborating observations');
  }
  if (value.economic_order !== null) fail('economic_order_not_established', 'Slice 2 does not establish economic order');
  validateCoordinate(value.source_coordinate, `${context}.source_coordinate`);
  for (const field of ['account', 'owner', 'authority', 'destination', 'mint', 'token_program']) publicKey(value[field], `${context}.${field}`, true);
  if (value.owner !== null && value.owner !== projection.analyzed_wallet) fail('invalid_effect_identity', `${context} owner must bind to the analyzed wallet`);
  if (!DIRECTIONS.has(value.direction)) fail('invalid_effect_direction', `${context}.direction is unsupported`);
  exactInteger(value.signed_raw_quantity, `${context}.signed_raw_quantity`, { nullable: true, max: MAX_U64 });
  exactInteger(value.signed_lamports, `${context}.signed_lamports`, { nullable: true });
  if (value.decimals !== null && (!safeNonnegativeInteger(value.decimals) || value.decimals > 255)) fail('invalid_decimals', `${context}.decimals is invalid`);

  if (value.effect_kind === 'network_fee') {
    if (value.source_coordinate.coordinate_kind !== 'transaction_fee' || value.account === null
        || [value.owner, value.authority, value.destination, value.mint, value.token_program, value.signed_raw_quantity, value.decimals].some(item => item !== null)
        || value.signed_lamports === null || value.direction !== directionFor(value.signed_lamports)
        || (value.signed_lamports !== '0' && !value.signed_lamports.startsWith('-'))) fail('invalid_effect_shape', `${context} network fee shape is invalid`);
  } else if (value.effect_kind === 'token_balance_observation') {
    if (projection.finalized_execution_status !== 'succeeded') fail('failed_token_effect_not_committed', 'failed transactions cannot contain committed token effects');
    if (value.source_coordinate.coordinate_kind !== 'account_balance' || value.account === null || value.owner === null
        || value.mint === null || value.token_program === null || value.signed_raw_quantity === null || value.signed_raw_quantity === '0'
        || value.decimals === null || value.signed_lamports !== null || value.authority !== null || value.destination !== null
        || value.direction !== directionFor(value.signed_raw_quantity)) fail('invalid_effect_shape', `${context} token observation shape is invalid`);
  } else if (value.effect_kind === 'native_balance_observation') {
    if (value.source_coordinate.coordinate_kind !== 'account_balance' || value.account === null
        || [value.owner, value.authority, value.destination, value.mint, value.token_program, value.signed_raw_quantity, value.decimals].some(item => item !== null)
        || value.signed_lamports === null || value.signed_lamports === '0'
        || value.direction !== directionFor(value.signed_lamports)) fail('invalid_effect_shape', `${context} native observation shape is invalid`);
  } else if (value.effect_kind === 'token_transfer') {
    if (projection.finalized_execution_status !== 'succeeded') fail('failed_token_effect_not_committed', 'failed transactions cannot contain committed token transfers');
    if (value.source_coordinate.coordinate_kind !== 'instruction'
        || [value.account, value.owner, value.authority, value.destination, value.mint, value.token_program].some(item => item === null)
        || value.signed_raw_quantity === null || value.signed_raw_quantity === '0' || value.decimals === null
        || value.signed_lamports !== null || value.direction !== directionFor(value.signed_raw_quantity)) fail('invalid_effect_shape', `${context} token transfer shape is invalid`);
  } else if (value.effect_kind === 'native_transfer') {
    if (projection.finalized_execution_status !== 'succeeded') fail('failed_token_effect_not_committed', 'failed transactions cannot contain committed native transfers');
    if (value.source_coordinate.coordinate_kind !== 'instruction'
        || [value.account, value.owner, value.authority, value.destination].some(item => item === null)
        || [value.mint, value.token_program, value.signed_raw_quantity, value.decimals].some(item => item !== null)
        || value.signed_lamports === null || value.signed_lamports === '0'
        || value.direction !== directionFor(value.signed_lamports)) fail('invalid_effect_shape', `${context} native transfer shape is invalid`);
  } else {
    if (projection.finalized_execution_status !== 'succeeded') fail('failed_token_effect_not_committed', 'failed transactions cannot contain committed account lifecycle effects');
    if (value.source_coordinate.coordinate_kind !== 'instruction' || value.account === null || value.owner === null
        || value.authority === null || value.mint === null || value.token_program === null
        || value.direction !== 'none' || value.signed_raw_quantity !== null || value.decimals !== null) fail('invalid_effect_shape', `${context} account lifecycle shape is invalid`);
    if (value.effect_kind === 'account_creation' && value.destination !== null) fail('invalid_effect_shape', `${context} account creation destination must be null`);
    if (value.effect_kind === 'account_closure' && value.destination === null) fail('invalid_effect_shape', `${context} account closure destination is required`);
    if (value.effect_kind === 'account_creation' && value.signed_lamports !== null && value.signed_lamports.startsWith('-')) fail('invalid_effect_shape', `${context} account creation lamports cannot be negative`);
    if (value.effect_kind === 'account_closure' && value.signed_lamports !== null
        && value.signed_lamports !== '0' && !value.signed_lamports.startsWith('-')) fail('invalid_effect_shape', `${context} account closure lamports cannot be positive`);
  }
  const expectedId = canonicalTransactionEffectRecordIdV13({
    transaction_identity: projection.transaction_identity, analyzed_wallet: projection.analyzed_wallet,
    record_kind: 'effect', record: value,
  });
  if (value.effect_id !== expectedId) fail('invalid_effect_identity', `${context}.effect_id is not canonical`);
}

function nullExcept(value, allowed) {
  return ['program_id', 'account', 'owner', 'authority', 'destination', 'mint', 'token_program',
    'observed_signed_raw_quantity', 'observed_signed_lamports', 'missing_balance_side']
    .filter(field => !allowed.includes(field)).every(field => value[field] === null);
}
function validateResidualSemantics(value, context, projection) {
  const coordinateKind = value.source_coordinate.coordinate_kind;
  const closureReason = ['ACCOUNT_CLOSURE_UNRESOLVED', 'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED', 'EXTERNAL_CLOSURE_RENT']
    .includes(value.reason_code);
  if (!closureReason && (value.authority !== null || value.destination !== null)) {
    fail('invalid_residual_shape', `${context} non-closure payload cannot claim closure identities`);
  }
  if (value.reason_code === 'UNKNOWN_TOKEN_OWNER') {
    if (value.owner !== null || value.account === null || value.mint === null || value.token_program === null) fail('invalid_residual_shape', `${context} unknown-owner payload is contradictory`);
    if (coordinateKind === 'account_balance') {
      if (value.program_id !== null || value.accounts.length !== 0 || value.missing_balance_side !== null
          || (value.observed_signed_raw_quantity === null && value.observed_signed_lamports === null)) fail('invalid_residual_shape', `${context} unknown-owner observation is incomplete`);
    } else if (coordinateKind === 'instruction') {
      if (value.program_id === null || !value.accounts.includes(value.account)
          || value.observed_signed_raw_quantity !== null || value.observed_signed_lamports !== null
          || value.missing_balance_side !== null) fail('invalid_residual_shape', `${context} unknown-owner instruction is incomplete`);
    } else fail('invalid_residual_shape', `${context} unknown-owner coordinate is invalid`);
  } else if (value.reason_code === 'TOKEN_BALANCE_SIDE_MISSING') {
    if (coordinateKind !== 'account_balance' || value.account === null || value.mint === null || value.token_program === null
        || !['pre', 'post'].includes(value.missing_balance_side) || value.program_id !== null || value.accounts.length !== 0
        || value.observed_signed_raw_quantity !== null || value.observed_signed_lamports !== null) fail('invalid_residual_shape', `${context} missing-side payload is invalid`);
  } else if (value.reason_code === 'UNMATCHED_WALLET_INSTRUCTION') {
    const localizedTokenIdentityFields = [value.owner, value.mint, value.token_program]
      .filter(field => field !== null).length;
    if (coordinateKind !== 'instruction' || value.program_id === null || value.accounts.length === 0
        || (value.account !== null && !value.accounts.includes(value.account))
        || ![0, 3].includes(localizedTokenIdentityFields)
        || (localizedTokenIdentityFields === 3
          && (value.owner !== projection.analyzed_wallet || value.account === null))
        || value.observed_signed_raw_quantity !== null || value.observed_signed_lamports !== null
        || value.missing_balance_side !== null) fail('invalid_residual_shape', `${context} unmatched-instruction payload is invalid`);
  } else if (value.reason_code === 'NATIVE_BALANCE_RECONCILIATION') {
    if (coordinateKind !== 'transaction' || !nullExcept(value, ['observed_signed_lamports'])
        || value.observed_signed_lamports === null || value.accounts.length !== 0) fail('invalid_residual_shape', `${context} native reconciliation payload is invalid`);
  } else if (value.reason_code === 'FAILED_TOKEN_BALANCE_OBSERVATION') {
    if (projection.finalized_execution_status !== 'failed' || coordinateKind !== 'account_balance'
        || value.account === null || value.mint === null || value.token_program === null
        || value.observed_signed_raw_quantity === null || value.observed_signed_raw_quantity === '0'
        || value.program_id !== null || value.accounts.length !== 0 || value.observed_signed_lamports !== null
        || value.missing_balance_side !== null) fail('invalid_residual_shape', `${context} failed-token payload is invalid`);
  } else if (value.reason_code === 'WALLET_ACCOUNT_EVIDENCE_MISSING') {
    if (coordinateKind !== 'transaction' || !nullExcept(value, []) || value.accounts.length !== 0) fail('invalid_residual_shape', `${context} missing-wallet payload is invalid`);
  } else if (['ACCOUNT_CLOSURE_UNRESOLVED', 'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED', 'EXTERNAL_CLOSURE_RENT'].includes(value.reason_code)) {
    if (coordinateKind !== 'instruction' || value.program_id === null
        || (value.reason_code !== 'ACCOUNT_CLOSURE_UNRESOLVED' && value.accounts.length === 0)
        || value.missing_balance_side !== null || value.observed_signed_raw_quantity !== null) fail('invalid_residual_shape', `${context} closure payload is invalid`);
    if (value.reason_code === 'ACCOUNT_CLOSURE_UNRESOLVED' && value.accounts.length === 0
        && !nullExcept(value, ['program_id'])) fail('invalid_residual_shape', `${context} operand-free closure payload cannot claim localized evidence`);
    if (value.reason_code === 'ACCOUNT_CLOSURE_UNRESOLVED' && value.accounts.length !== 0) {
      const identityCount = [value.mint, value.token_program].filter(field => field !== null).length;
      if (value.account !== (value.accounts[0] ?? null)
          || value.destination !== (value.accounts[1] ?? null)
          || value.authority !== (value.accounts[2] ?? null)
          || ![0, 2].includes(identityCount)
          || (identityCount === 2 && (value.account === null || value.program_id !== value.token_program))
          || (value.observed_signed_lamports !== null && value.observed_signed_lamports !== '0'
            && !value.observed_signed_lamports.startsWith('-'))) {
        fail('invalid_residual_shape', `${context} unresolved closure identities are contradictory`);
      }
    }
    if (value.reason_code === 'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED'
        && (value.accounts.length !== 3 || value.account === null || value.owner !== projection.analyzed_wallet
          || value.authority === null || value.destination === null || value.mint === null || value.token_program === null
          || value.program_id !== value.token_program
          || value.accounts[0] !== value.account || value.accounts[1] !== value.destination
          || value.accounts[2] !== value.authority)) fail('invalid_residual_shape', `${context} unresolved closure amount is unbound`);
    if (value.reason_code === 'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED'
        && value.observed_signed_lamports !== null && !['0'].includes(value.observed_signed_lamports)
        && !value.observed_signed_lamports.startsWith('-')) fail('invalid_residual_shape', `${context} unresolved closure amount has an impossible sign`);
    if (value.reason_code === 'EXTERNAL_CLOSURE_RENT'
        && (value.accounts.length !== 3 || value.account === null || value.owner !== null
          || value.authority === null || value.destination === null || value.account !== value.destination
          || value.mint === null || value.token_program === null || value.program_id !== value.token_program
          || value.accounts[1] !== value.destination || value.accounts[2] !== value.authority
          || value.observed_signed_lamports === null)) fail('invalid_residual_shape', `${context} external closure rent is invalid`);
  }
}

function validateResidual(value, index, projection) {
  const context = `residual_unresolved_effects.${index}`;
  assertExactFields(value, RESIDUAL_FIELDS, context);
  if (value.canonical_order !== index) fail('noncanonical_effect_order', 'residual canonical_order must be dense');
  if (!TRANSACTION_EFFECT_RESIDUAL_REASONS_V1_3.includes(value.reason_code)) fail('invalid_residual_reason', `${context}.reason_code is unsupported`);
  validateCoordinate(value.source_coordinate, `${context}.source_coordinate`);
  for (const field of ['program_id', 'account', 'owner', 'authority', 'destination', 'mint', 'token_program']) {
    publicKey(value[field], `${context}.${field}`, true);
  }
  if (!Array.isArray(value.accounts)) fail('invalid_residual_shape', `${context}.accounts must be an array`);
  value.accounts.forEach((account, accountIndex) => publicKey(account, `${context}.accounts.${accountIndex}`));
  exactInteger(value.observed_signed_raw_quantity, `${context}.observed_signed_raw_quantity`, { nullable: true, max: MAX_U64 });
  exactInteger(value.observed_signed_lamports, `${context}.observed_signed_lamports`, {
    nullable: true,
    max: value.reason_code === 'NATIVE_BALANCE_RECONCILIATION' ? MAX_SOURCE_BALANCE_SUM : MAX_SAFE_INTEGER,
  });
  if (value.missing_balance_side !== null && !['pre', 'post'].includes(value.missing_balance_side)) fail('invalid_residual_shape', `${context}.missing_balance_side is invalid`);
  exactSortedUniqueIds(value.related_effect_ids, `${context}.related_effect_ids`);
  validateResidualSemantics(value, context, projection);
  const expectedId = canonicalTransactionEffectRecordIdV13({
    transaction_identity: projection.transaction_identity, analyzed_wallet: projection.analyzed_wallet,
    record_kind: 'residual', record: value,
  });
  if (value.residual_id !== expectedId) fail('invalid_effect_identity', `${context}.residual_id is not canonical`);
}

function validateCanonicalOrder(records, recordKind) {
  const sorted = [...records].sort((left, right) => compareTransactionEffectRecordsV13(left, right, recordKind));
  if (sorted.some((record, index) => record !== records[index])) fail('noncanonical_effect_order', `${recordKind} collection order is noncanonical`);
}

export function validateTransactionEffectStructureV13(value) {
  assertExactFields(value, TOP_FIELDS, 'transaction_effect');
  if (value.transaction_effect_version !== TRANSACTION_EFFECT_VERSION_V1_3
      || value.effect_model_profile !== TRANSACTION_EFFECT_MODEL_PROFILE_V1_3) fail('unsupported_effect_version', 'transaction effect version or profile is unsupported');
  assertExactFields(value.transaction_identity, TRANSACTION_FIELDS, 'transaction_identity');
  if (!isSolanaSignatureV1(value.transaction_identity.signature)
      || !safeNonnegativeInteger(value.transaction_identity.slot)
      || !safeNonnegativeInteger(value.transaction_identity.block_time)
      || !['legacy', 0].includes(value.transaction_identity.transaction_version)) fail('invalid_transaction_identity', 'transaction identity is invalid');
  if (!['succeeded', 'failed'].includes(value.finalized_execution_status)) fail('invalid_execution_status', 'execution status is invalid');
  publicKey(value.analyzed_wallet, 'analyzed_wallet');
  publicKey(value.fee_payer, 'fee_payer');
  exactInteger(value.fee_lamports, 'fee_lamports');
  if (value.fee_lamports.startsWith('-')) fail('invalid_fee_effect', 'fee_lamports must be nonnegative');
  if (value.economic_order_status !== 'UNESTABLISHED') fail('economic_order_not_established', 'Slice 2 does not establish economic order');
  if (!Array.isArray(value.established_effects) || !Array.isArray(value.residual_unresolved_effects)) fail('invalid_effect_collection', 'effect collections must be arrays');
  value.established_effects.forEach((effect, index) => validateEffect(effect, index, value));
  value.residual_unresolved_effects.forEach((residual, index) => validateResidual(residual, index, value));
  validateCanonicalOrder(value.established_effects, 'effect');
  validateCanonicalOrder(value.residual_unresolved_effects, 'residual');
  const effectIds = value.established_effects.map(effect => effect.effect_id);
  const residualIds = value.residual_unresolved_effects.map(residual => residual.residual_id);
  const residualIdSet = new Set(residualIds);
  if (new Set(effectIds).size !== effectIds.length || new Set(residualIds).size !== residualIds.length
      || effectIds.some(id => residualIdSet.has(id))) fail('duplicate_effect_identity', 'effect and residual identities must be unique');
  const effectsById = new Map(value.established_effects.map(effect => [effect.effect_id, effect]));
  for (const effect of value.established_effects) for (const reference of effect.corroborating_effect_ids) {
    if (effectsById.get(reference)?.evidence_role !== 'observation') fail('invalid_reconciliation_reference', 'corroborating effect must resolve to an observation');
  }
  const nativeObservationIdsByAccount = new Map();
  for (const effect of value.established_effects) {
    if (effect.effect_kind !== 'native_balance_observation') continue;
    const ids = nativeObservationIdsByAccount.get(effect.account) ?? [];
    ids.push(effect.effect_id);
    nativeObservationIdsByAccount.set(effect.account, ids);
  }
  const nativeObservationIds = account => nativeObservationIdsByAccount.get(account) ?? [];
  for (const effect of value.established_effects) {
    let requiredReferences = null;
    if (effect.effect_kind === 'network_fee') requiredReferences = nativeObservationIds(effect.account);
    if (['account_creation', 'account_closure'].includes(effect.effect_kind)) {
      requiredReferences = [...new Set([
        ...nativeObservationIds(effect.account),
        ...(effect.destination === null ? [] : nativeObservationIds(effect.destination)),
      ])];
    }
    if (requiredReferences !== null) {
      requiredReferences.sort();
      if (canonicalJson(effect.corroborating_effect_ids) !== canonicalJson(requiredReferences)) {
        fail('invalid_reconciliation_reference', 'attributed component does not reference its exact corroborating observations');
      }
    }
  }
  for (const residual of value.residual_unresolved_effects) for (const reference of residual.related_effect_ids) {
    if (!effectsById.has(reference)) fail('invalid_reconciliation_reference', 'residual related effect is absent');
  }
  for (const residual of value.residual_unresolved_effects) {
    const requiresClosure = ['ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED', 'EXTERNAL_CLOSURE_RENT'].includes(residual.reason_code);
    if (!requiresClosure && residual.related_effect_ids.length !== 0) {
      fail('invalid_reconciliation_reference', 'residual reason cannot reference an established effect');
    }
    if (requiresClosure) {
      const related = residual.related_effect_ids.map(id => effectsById.get(id));
      const closures = related.filter(effect => effect?.effect_kind === 'account_closure');
      const fees = related.filter(effect => effect?.effect_kind === 'network_fee');
      const closure = closures.length === 1 ? closures[0] : null;
      const expectedFeeCount = residual.reason_code === 'EXTERNAL_CLOSURE_RENT'
        && residual.account === value.fee_payer ? 1 : 0;
      if (closure?.effect_kind !== 'account_closure'
          || related.length !== 1 + expectedFeeCount || fees.length !== expectedFeeCount
          || closure.source_coordinate.outer_instruction_index !== residual.source_coordinate.outer_instruction_index
          || closure.source_coordinate.inner_instruction_index !== residual.source_coordinate.inner_instruction_index
          || residual.program_id !== closure.token_program
          || residual.mint !== closure.mint
          || residual.token_program !== closure.token_program
          || residual.authority !== closure.authority
          || residual.destination !== closure.destination
          || residual.accounts.length !== 3
          || residual.accounts[0] !== closure.account
          || residual.accounts[1] !== closure.destination
          || residual.accounts[2] !== closure.authority
          || (residual.reason_code === 'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED'
            && (closure.account !== residual.account || closure.owner !== residual.owner
              || closure.signed_lamports !== null))
          || (residual.reason_code === 'EXTERNAL_CLOSURE_RENT'
            && (closure.destination !== residual.account || closure.signed_lamports === null))) {
        fail('invalid_reconciliation_reference', 'closure residual does not bind its exact established closure');
      }
      if (residual.reason_code === 'EXTERNAL_CLOSURE_RENT') {
        const expectedNet = -BigInt(closure.signed_lamports) + (fees[0] === undefined ? 0n : BigInt(fees[0].signed_lamports));
        if (BigInt(residual.observed_signed_lamports) !== expectedNet) {
          fail('invalid_reconciliation_reference', 'external closure observation does not reconcile gross rent and fee');
        }
      }
    }
  }
  const amountResidualCountByClosure = new Map();
  for (const residual of value.residual_unresolved_effects) {
    if (residual.reason_code !== 'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED') continue;
    const closureId = residual.related_effect_ids[0];
    amountResidualCountByClosure.set(closureId, (amountResidualCountByClosure.get(closureId) ?? 0) + 1);
  }
  for (const closure of value.established_effects.filter(effect => effect.effect_kind === 'account_closure')) {
    const amountResidualCount = amountResidualCountByClosure.get(closure.effect_id) ?? 0;
    if ((closure.signed_lamports === null && amountResidualCount !== 1)
        || (closure.signed_lamports !== null && amountResidualCount !== 0)) {
      fail('invalid_reconciliation_reference', 'closure amount establishment and residual evidence are inconsistent');
    }
  }
  const feeEffects = value.established_effects.filter(effect => effect.effect_kind === 'network_fee');
  const expectedSignedFee = value.fee_lamports === '0' ? '0' : `-${value.fee_lamports}`;
  if (feeEffects.length !== 1 || feeEffects[0].account !== value.fee_payer
      || feeEffects[0].signed_lamports !== expectedSignedFee) fail('invalid_fee_effect', 'exactly one fee effect must match the authoritative fee payer and amount');
  return true;
}