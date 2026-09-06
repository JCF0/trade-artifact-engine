'use strict';

const { types } = require('node:util');

const TRANSACTION_ERROR_NAMES = new Set([
  'AccountBorrowOutstanding', 'AccountInUse', 'AccountLoadedTwice', 'AccountNotFound',
  'AddressLookupTableNotFound', 'AlreadyProcessed', 'BlockhashNotFound', 'CallChainTooDeep',
  'ClusterMaintenance', 'InsufficientFundsForFee', 'InvalidAccountForFee', 'InvalidAccountIndex',
  'InvalidAddressLookupTableData', 'InvalidAddressLookupTableIndex', 'InvalidAddressLookupTableOwner',
  'InvalidLoadedAccountsDataSizeLimit', 'InvalidProgramForExecution', 'InvalidRentPayingAccount',
  'InvalidWritableAccount', 'MaxLoadedAccountsDataSizeExceeded', 'MissingSignatureForFee',
  'ProgramAccountNotFound', 'ResanitizationNeeded', 'SanitizeFailure', 'SignatureFailure',
  'TooManyAccountLocks', 'UnbalancedTransaction', 'UnsupportedVersion',
  'WouldExceedAccountDataBlockLimit', 'WouldExceedAccountDataTotalLimit',
  'WouldExceedMaxAccountCostLimit', 'WouldExceedMaxBlockCostLimit', 'WouldExceedMaxVoteCostLimit',
]);
const INSTRUCTION_ERROR_NAMES = new Set([
  'AccountAlreadyInitialized', 'AccountBorrowFailed', 'AccountBorrowOutstanding',
  'AccountDataSizeChanged', 'AccountDataTooSmall', 'AccountNotExecutable', 'AccountNotRentExempt',
  'ArithmeticOverflow', 'BorshIoError', 'BuiltinProgramsMustConsumeComputeUnits', 'CallDepth',
  'ComputationalBudgetExceeded', 'DuplicateAccountIndex', 'DuplicateAccountOutOfSync',
  'ExecutableAccountNotRentExempt', 'ExecutableDataModified', 'ExecutableLamportChange',
  'ExecutableModified', 'ExternalAccountDataModified', 'ExternalAccountLamportSpend', 'GenericError',
  'IllegalOwner', 'Immutable', 'IncorrectAuthority', 'IncorrectProgramId', 'InsufficientFunds',
  'InvalidAccountData', 'InvalidAccountOwner', 'InvalidArgument', 'InvalidError',
  'InvalidInstructionData', 'InvalidRealloc', 'InvalidSeeds', 'MaxAccountsDataAllocationsExceeded',
  'MaxAccountsExceeded', 'MaxInstructionTraceLengthExceeded', 'MaxSeedLengthExceeded',
  'MissingAccount', 'MissingRequiredSignature', 'ModifiedProgramId', 'NotEnoughAccountKeys',
  'PrivilegeEscalation', 'ProgramEnvironmentSetupFailure', 'ProgramFailedToCompile',
  'ProgramFailedToComplete', 'ReadonlyDataModified', 'ReadonlyLamportChange', 'ReentrancyNotAllowed',
  'RentEpochModified', 'UnbalancedInstruction', 'UninitializedAccount', 'UnsupportedProgramId',
  'UnsupportedSysvar',
]);

function isOrdinaryEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined
    && Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set')
    && descriptor.writable === true
    && descriptor.enumerable === true
    && descriptor.configurable === true;
}

function inspectSinglePropertyRecord(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || typeof keys[0] !== 'string') return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, keys[0]);
  if (!isOrdinaryEnumerableDataDescriptor(descriptor)) return null;
  return { key: keys[0], value: descriptor.value };
}

function inspectInstructionErrorTuple(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Array.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys[0] !== '0' || keys[1] !== '1' || keys[2] !== 'length') return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!isOrdinaryEnumerableDataDescriptor(descriptors['0'])
      || !isOrdinaryEnumerableDataDescriptor(descriptors['1'])) return null;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined
      || !Object.hasOwn(lengthDescriptor, 'value')
      || Object.hasOwn(lengthDescriptor, 'get')
      || Object.hasOwn(lengthDescriptor, 'set')
      || lengthDescriptor.value !== 2
      || lengthDescriptor.writable !== true
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.configurable !== false) return null;
  return [descriptors['0'].value, descriptors['1'].value];
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function isValidTransactionError(value) {
  try {
    if (typeof value === 'string') return TRANSACTION_ERROR_NAMES.has(value);
    const outer = inspectSinglePropertyRecord(value);
    if (outer === null) return false;
    if (outer.key === 'DuplicateInstruction') return isNonnegativeSafeInteger(outer.value);
    if (outer.key === 'InsufficientFundsForRent' || outer.key === 'ProgramExecutionTemporarilyRestricted') {
      const detail = inspectSinglePropertyRecord(outer.value);
      return detail !== null
        && detail.key === 'account_index'
        && isNonnegativeSafeInteger(detail.value);
    }
    if (outer.key !== 'InstructionError') return false;
    const tuple = inspectInstructionErrorTuple(outer.value);
    if (tuple === null || !isNonnegativeSafeInteger(tuple[0])) return false;
    const instructionError = tuple[1];
    if (typeof instructionError === 'string') return INSTRUCTION_ERROR_NAMES.has(instructionError);
    const custom = inspectSinglePropertyRecord(instructionError);
    return custom !== null
      && custom.key === 'Custom'
      && isNonnegativeSafeInteger(custom.value);
  } catch {
    return false;
  }
}

module.exports = Object.freeze({ isValidTransactionError });
