import { types as utilTypes } from 'node:util';

export const WALLET_ACQUISITION_PORT_METHODS_V1 = Object.freeze([
  'getNetworkIdentityV1',
  'getFinalizedSlotV1',
  'getFinalizedBlockV1',
  'getFinalizedWalletSignaturePageV1',
  'getEnhancedTransactionsBySignatureV1',
]);

export const WALLET_ACQUISITION_OPERATION_ERROR_CODES_V1 = Object.freeze([
  'acquisition_capability_denied','api_key_unavailable','provider_auth_failed','provider_request_invalid',
  'provider_transient_failure','provider_timeout','provider_retry_exhausted','acquisition_deadline_exceeded',
  'malformed_provider_response','chain_identity_mismatch','finalized_boundary_unavailable',
  'finalized_boundary_incoherent','latest_state_unproven','pagination_incomplete','pagination_cursor_invalid',
  'pagination_cursor_repeated','pagination_order_invalid','pagination_duplicate_conflict','acquisition_capped',
  'provider_uncertain','source_transaction_mismatch','normalization_failed','wallet_wide_impact_unresolved',
  'event_finding_reconciliation_failed','transaction_disposition_failed','invalid_acquisition_request',
  'unsupported_lookback_profile','lookback_boundary_mismatch','lower_bound_unproven',
  'acquisition_truncated','invalid_source_transaction','normalization_ambiguous',
]);
const CODES = new Set(WALLET_ACQUISITION_OPERATION_ERROR_CODES_V1);
const MESSAGES = Object.freeze(Object.fromEntries(WALLET_ACQUISITION_OPERATION_ERROR_CODES_V1.map(code => [code, code.replaceAll('_', ' ')])));
const ACQUISITION_STARTERS = new WeakMap();

export class WalletAcquisitionError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'provider_uncertain';
    super(MESSAGES[safe]);
    delete this.stack;
    this.name = 'WalletAcquisitionError';
    this.code = safe;
    this.details = Object.freeze({});
  }
}
export function failWalletAcquisitionOperationV1(code) { throw new WalletAcquisitionError(code); }

function ownCode(error) {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function') || utilTypes.isProxy(error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') && CODES.has(descriptor.value) ? descriptor.value : null;
  } catch { return null; }
}
export function sanitizeWalletAcquisitionErrorV1(error, fallback = 'provider_uncertain') {
  return new WalletAcquisitionError(ownCode(error) ?? fallback);
}

function plain(value, active = new Set(), depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 100000 || depth > 256) failWalletAcquisitionOperationV1('malformed_provider_response');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) failWalletAcquisitionOperationV1('malformed_provider_response');
    return;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value) || active.has(value)) failWalletAcquisitionOperationV1('malformed_provider_response');
  let prototype; let descriptors; let symbols;
  try { prototype = Object.getPrototypeOf(value); descriptors = Object.getOwnPropertyDescriptors(value); symbols = Object.getOwnPropertySymbols(value); }
  catch { failWalletAcquisitionOperationV1('malformed_provider_response'); }
  const array = Array.isArray(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) || symbols.length) failWalletAcquisitionOperationV1('malformed_provider_response');
  const entries = Object.entries(descriptors).filter(([key]) => !(array && key === 'length'));
  if (array && (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))) failWalletAcquisitionOperationV1('malformed_provider_response');
  active.add(value);
  for (const [, descriptor] of entries) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) failWalletAcquisitionOperationV1('malformed_provider_response');
    plain(descriptor.value, active, depth + 1, budget);
  }
  active.delete(value);
}
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) Object.defineProperty(output, key, { value: clone(descriptor.value), enumerable: true, writable: true, configurable: true });
    return output;
  }
  return value;
}
function freeze(value) { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export function detachProviderNeutralValueV1(value) { plain(value); return freeze(clone(value)); }

function validateCapability(capability) {
  try {
    if (capability === null || typeof capability !== 'object' || Array.isArray(capability) || utilTypes.isProxy(capability)
        || Object.getPrototypeOf(capability) !== Object.prototype || Object.getOwnPropertySymbols(capability).length) failWalletAcquisitionOperationV1('acquisition_capability_denied');
    const descriptors = Object.getOwnPropertyDescriptors(capability);
    if (Object.keys(descriptors).length !== WALLET_ACQUISITION_PORT_METHODS_V1.length) failWalletAcquisitionOperationV1('acquisition_capability_denied');
    return Object.fromEntries(WALLET_ACQUISITION_PORT_METHODS_V1.map(name => {
      const descriptor = descriptors[name];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') failWalletAcquisitionOperationV1('acquisition_capability_denied');
      return [name, descriptor.value.bind(capability)];
    }));
  } catch (error) {
    throw sanitizeWalletAcquisitionErrorV1(error, 'acquisition_capability_denied');
  }
}

function acquisitionStarter(options, capability) {
  if (options === undefined) return ACQUISITION_STARTERS.get(capability) ?? null;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options) || utilTypes.isProxy(options)
        || Object.getPrototypeOf(options) !== Object.prototype || Object.getOwnPropertySymbols(options).length) failWalletAcquisitionOperationV1('acquisition_capability_denied');
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (Object.keys(descriptors).length !== 1 || !descriptors.beginAcquisitionV1?.enumerable
        || !Object.hasOwn(descriptors.beginAcquisitionV1, 'value') || typeof descriptors.beginAcquisitionV1.value !== 'function') failWalletAcquisitionOperationV1('acquisition_capability_denied');
    return descriptors.beginAcquisitionV1.value;
  } catch (error) {
    throw sanitizeWalletAcquisitionErrorV1(error, 'acquisition_capability_denied');
  }
}

export function createWalletHistoryPortV1(capability, options) {
  const methods = validateCapability(capability);
  const starter = acquisitionStarter(options, capability);
  const port = {};
  for (const name of WALLET_ACQUISITION_PORT_METHODS_V1) Object.defineProperty(port, name, {
    enumerable: true,
    value: async (...args) => {
      try { return detachProviderNeutralValueV1(await methods[name](...args)); }
      catch (error) { throw sanitizeWalletAcquisitionErrorV1(error); }
    },
  });
  Object.freeze(port);
  if (starter !== null) ACQUISITION_STARTERS.set(port, starter);
  return port;
}

export function beginWalletHistoryAcquisitionV1(port, budgets) {
  const starter = port !== null && typeof port === 'object' ? ACQUISITION_STARTERS.get(port) : null;
  if (starter === null || starter === undefined) failWalletAcquisitionOperationV1('acquisition_capability_denied');
  try {
    const detached = detachProviderNeutralValueV1(budgets);
    starter(detached);
    return true;
  } catch (error) {
    throw sanitizeWalletAcquisitionErrorV1(error, 'acquisition_capability_denied');
  }
}
