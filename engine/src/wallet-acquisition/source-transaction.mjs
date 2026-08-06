import {
  assertExactFieldsV1,
  assertPlainDataV1,
  assertSafeNonnegativeIntegerV1,
  cloneAndFreezePlainDataV1,
  failWalletAcquisitionV1,
} from './errors.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './solana-identities.mjs';

export const SOURCE_TRANSACTION_VERSION_V1 = 'wallet_source_transaction_v1';

const SOURCE_FIELDS = [
  'source_transaction_version',
  'signature',
  'slot',
  'block_time',
  'execution_state',
  'provider_failure_indicator',
  'wallet',
  'fee_payer',
  'token_operations',
  'native_sol_operations',
  'provider_classification_code',
  'recognized_programs',
];
const TOKEN_OPERATION_FIELDS = ['operation_id','economic_group','operation_kind','direction','owner','mint','amount','decimals'];
const NATIVE_OPERATION_FIELDS = ['operation_id','economic_group','operation_kind','direction','owner','amount_lamports'];
const PROGRAM_FIELDS = ['program_id','program_role'];
const OPERATION_KINDS = new Set(['swap','transfer','metadata','account_record','account_close','unknown']);
const DIRECTIONS = new Set(['debit','credit','none','unknown']);
const PROGRAM_ROLES = new Set(['spot_swap','token','system','metadata','other']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function invalid() {
  failWalletAcquisitionV1('invalid_source_transaction');
}

function safeIdentifier(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function assertNullablePositiveAmount(value) {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) || value <= 0) invalid();
}

function validateOperationCommon(operation) {
  if (!safeIdentifier(operation.operation_id)) invalid();
  if (operation.economic_group !== null && !safeIdentifier(operation.economic_group)) invalid();
  if (!OPERATION_KINDS.has(operation.operation_kind) || !DIRECTIONS.has(operation.direction)) invalid();
  if (!isSolanaPublicKeyV1(operation.owner)) invalid();
  if (['metadata','account_record'].includes(operation.operation_kind)
      && (operation.direction !== 'none' || operation.economic_group !== null)) invalid();
  if (operation.operation_kind === 'swap' && operation.economic_group === null) invalid();
}

function validateTokenOperation(operation, wallet) {
  assertExactFieldsV1(operation, TOKEN_OPERATION_FIELDS, 'invalid_source_transaction');
  validateOperationCommon(operation);
  if (operation.owner !== wallet) invalid();
  if (operation.mint !== null && !isSolanaPublicKeyV1(operation.mint)) invalid();
  if (operation.operation_kind !== 'unknown' && operation.mint === null) invalid();
  assertNullablePositiveAmount(operation.amount);
  if (operation.decimals !== null) {
    assertSafeNonnegativeIntegerV1(operation.decimals, 'invalid_source_transaction');
    if (operation.decimals > 255) invalid();
  }
  if ((operation.amount === null) !== (operation.decimals === null)
      && !['metadata','account_record','account_close','unknown'].includes(operation.operation_kind)) invalid();
  if (operation.direction === 'none' && operation.amount !== null) invalid();
  if (['debit','credit'].includes(operation.direction) && operation.amount === null) invalid();
}

function validateNativeOperation(operation, wallet) {
  assertExactFieldsV1(operation, NATIVE_OPERATION_FIELDS, 'invalid_source_transaction');
  validateOperationCommon(operation);
  if (operation.owner !== wallet) invalid();
  if (operation.amount_lamports !== null) {
    assertSafeNonnegativeIntegerV1(operation.amount_lamports, 'invalid_source_transaction');
    if (operation.amount_lamports === 0) invalid();
  }
  if (operation.direction === 'none' && operation.amount_lamports !== null) invalid();
  if (['debit','credit'].includes(operation.direction) && operation.amount_lamports === null) invalid();
}

function validateProgram(program) {
  assertExactFieldsV1(program, PROGRAM_FIELDS, 'invalid_source_transaction');
  if (!isSolanaPublicKeyV1(program.program_id) || !PROGRAM_ROLES.has(program.program_role)) invalid();
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function operationKey(operation) {
  return [operation.operation_id, operation.economic_group ?? '', operation.operation_kind, operation.direction].join('\u0000');
}

export function validateWalletSourceTransactionV1(sourceTransaction) {
  assertExactFieldsV1(sourceTransaction, SOURCE_FIELDS, 'invalid_source_transaction');
  if (sourceTransaction.source_transaction_version !== SOURCE_TRANSACTION_VERSION_V1) invalid();
  if (!isSolanaSignatureV1(sourceTransaction.signature) || !isSolanaPublicKeyV1(sourceTransaction.wallet) || !isSolanaPublicKeyV1(sourceTransaction.fee_payer)) invalid();
  assertSafeNonnegativeIntegerV1(sourceTransaction.slot, 'invalid_source_transaction');
  assertSafeNonnegativeIntegerV1(sourceTransaction.block_time, 'invalid_source_transaction');
  if (!['succeeded','failed'].includes(sourceTransaction.execution_state)) invalid();
  if (![null,'succeeded','failed'].includes(sourceTransaction.provider_failure_indicator)) invalid();
  if (sourceTransaction.provider_failure_indicator !== null
      && sourceTransaction.provider_failure_indicator !== sourceTransaction.execution_state) invalid();
  if (sourceTransaction.provider_classification_code !== null
      && (typeof sourceTransaction.provider_classification_code !== 'string'
        || !PROVIDER_CODE.test(sourceTransaction.provider_classification_code))) invalid();
  if (!Array.isArray(sourceTransaction.token_operations)
      || !Array.isArray(sourceTransaction.native_sol_operations)
      || !Array.isArray(sourceTransaction.recognized_programs)) invalid();
  sourceTransaction.token_operations.forEach(operation => validateTokenOperation(operation, sourceTransaction.wallet));
  sourceTransaction.native_sol_operations.forEach(operation => validateNativeOperation(operation, sourceTransaction.wallet));
  sourceTransaction.recognized_programs.forEach(validateProgram);
  const operationIds = [...sourceTransaction.token_operations, ...sourceTransaction.native_sol_operations].map(item => item.operation_id);
  if (new Set(operationIds).size !== operationIds.length) invalid();
  const programIds = sourceTransaction.recognized_programs.map(item => item.program_id);
  if (new Set(programIds).size !== programIds.length) invalid();
  return true;
}

export function buildWalletSourceTransactionV1(input) {
  try {
    assertPlainDataV1(input, 'invalid_source_transaction');
    validateWalletSourceTransactionV1(input);
    const canonical = {
      ...input,
      token_operations: [...input.token_operations].sort((left, right) => compareCodeUnits(operationKey(left), operationKey(right))),
      native_sol_operations: [...input.native_sol_operations].sort((left, right) => compareCodeUnits(operationKey(left), operationKey(right))),
      recognized_programs: [...input.recognized_programs].sort((left, right) => compareCodeUnits(left.program_id, right.program_id)),
    };
    return cloneAndFreezePlainDataV1(canonical, 'invalid_source_transaction');
  } catch (error) {
    if (error?.name === 'WalletAcquisitionContractError' && error.code === 'invalid_source_transaction') throw error;
    invalid();
  }
}
