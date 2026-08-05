import { types as utilTypes } from 'node:util';

export const WALLET_ACQUISITION_ERROR_CODES_V1 = Object.freeze([
  'invalid_acquisition_request',
  'unsupported_lookback_profile',
  'lookback_boundary_mismatch',
  'chain_identity_mismatch',
  'finalized_boundary_unavailable',
  'finalized_boundary_incoherent',
  'latest_state_unproven',
  'lower_bound_unproven',
  'pagination_incomplete',
  'pagination_cursor_invalid',
  'pagination_cursor_repeated',
  'pagination_order_invalid',
  'pagination_duplicate_conflict',
  'acquisition_capped',
  'acquisition_truncated',
  'provider_uncertain',
  'acquisition_deadline_exceeded',
  'invalid_source_transaction',
  'source_transaction_mismatch',
  'transaction_disposition_failed',
  'normalization_failed',
  'normalization_ambiguous',
  'wallet_wide_impact_unresolved',
  'event_finding_reconciliation_failed',
]);

const ERROR_MESSAGES = Object.freeze({
  invalid_acquisition_request: 'wallet acquisition request is invalid',
  unsupported_lookback_profile: 'wallet acquisition lookback profile is unsupported',
  lookback_boundary_mismatch: 'wallet acquisition lookback boundary is inconsistent',
  chain_identity_mismatch: 'wallet acquisition chain identity is invalid',
  finalized_boundary_unavailable: 'finalized acquisition boundary is unavailable',
  finalized_boundary_incoherent: 'finalized acquisition boundary is incoherent',
  latest_state_unproven: 'latest wallet history state is unproven',
  lower_bound_unproven: 'wallet history lower bound is unproven',
  pagination_incomplete: 'wallet history pagination is incomplete',
  pagination_cursor_invalid: 'wallet history pagination cursor is invalid',
  pagination_cursor_repeated: 'wallet history pagination cursor did not progress',
  pagination_order_invalid: 'wallet history pagination order is invalid',
  pagination_duplicate_conflict: 'wallet history contains a duplicate transaction identity',
  acquisition_capped: 'wallet acquisition reached a configured cap',
  acquisition_truncated: 'wallet acquisition was truncated',
  provider_uncertain: 'wallet acquisition provider outcome is uncertain',
  acquisition_deadline_exceeded: 'wallet acquisition deadline was exceeded',
  invalid_source_transaction: 'wallet source transaction is invalid',
  source_transaction_mismatch: 'wallet source transaction evidence is inconsistent',
  transaction_disposition_failed: 'wallet transaction disposition could not be constructed',
  normalization_failed: 'wallet transaction normalization failed',
  normalization_ambiguous: 'wallet transaction normalization is ambiguous',
  wallet_wide_impact_unresolved: 'wallet-wide transaction impact is unresolved',
  event_finding_reconciliation_failed: 'wallet transaction event and finding references are inconsistent',
});

const ERROR_CODE_SET = new Set(WALLET_ACQUISITION_ERROR_CODES_V1);
const MAX_PLAIN_DEPTH = 256;
const MAX_PLAIN_NODES = 100000;

export class WalletAcquisitionContractError extends Error {
  constructor(code) {
    const safeCode = ERROR_CODE_SET.has(code) ? code : 'invalid_acquisition_request';
    super(ERROR_MESSAGES[safeCode]);
    delete this.stack;
    this.name = 'WalletAcquisitionContractError';
    this.code = safeCode;
    this.details = Object.freeze({});
  }
}

export function failWalletAcquisitionV1(code) {
  throw new WalletAcquisitionContractError(code);
}

export function assertPlainDataV1(value, code = 'invalid_acquisition_request', seen = new Set(), depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_PLAIN_NODES || depth > MAX_PLAIN_DEPTH) failWalletAcquisitionV1(code);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) failWalletAcquisitionV1(code);
    return true;
  }
  if (typeof value !== 'object') failWalletAcquisitionV1(code);
  if (utilTypes.isProxy(value)) failWalletAcquisitionV1(code);
  if (seen.has(value)) failWalletAcquisitionV1(code);
  let prototype;
  let descriptors;
  let symbols;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    failWalletAcquisitionV1(code);
  }
  const isArray = Array.isArray(value);
  if (prototype !== (isArray ? Array.prototype : Object.prototype) || symbols.length !== 0) failWalletAcquisitionV1(code);
  const entries = Object.entries(descriptors).filter(([key]) => !(isArray && key === 'length'));
  if (isArray && (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))) failWalletAcquisitionV1(code);
  seen.add(value);
  for (const [, descriptor] of entries) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) failWalletAcquisitionV1(code);
    assertPlainDataV1(descriptor.value, code, seen, depth + 1, budget);
  }
  seen.delete(value);
  return true;
}

export function assertExactFieldsV1(value, fields, code = 'invalid_acquisition_request') {
  assertPlainDataV1(value, code);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) failWalletAcquisitionV1(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) failWalletAcquisitionV1(code);
}

function clonePlainData(value) {
  if (Array.isArray(value)) return value.map(clonePlainData);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      Object.defineProperty(result, key, { value: clonePlainData(descriptor.value), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}

export function cloneAndFreezePlainDataV1(value, code = 'invalid_acquisition_request') {
  assertPlainDataV1(value, code);
  return deepFreeze(clonePlainData(value));
}

export function assertSafeNonnegativeIntegerV1(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) failWalletAcquisitionV1(code);
}

export function assertSafePositiveIntegerV1(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) failWalletAcquisitionV1(code);
}
