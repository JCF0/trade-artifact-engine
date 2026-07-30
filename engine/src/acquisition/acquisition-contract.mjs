import {
  acquisitionFail,
  rethrowSanitizedAcquisitionError,
} from './acquisition-errors.mjs';

export { BoundedAcquisitionError } from './acquisition-errors.mjs';

export const ACQUISITION_FETCH_PROFILE_V1 = 'receipt_scoped_transaction_selection_v1';
export const ACQUISITION_NORMALIZATION_PROFILE_V1 = 'artifact_solana_spot_normalization_v1';
export const ACQUISITION_LIMITS_V1 = Object.freeze({
  max_pages: 100,
  max_transactions: 10000,
  max_request_timeout_ms: 60000,
  max_overall_timeout_ms: 300000,
  max_attempts_per_page: 8,
});

const REQUEST_FIELDS = Object.freeze(['wallet', 'target', 'bounds', 'fetch_profile', 'normalization_profile']);
const TARGET_FIELDS = Object.freeze(['token_mint', 'receipt_type', 'segment_index']);
const BOUNDS_FIELDS = Object.freeze([
  'before_signature', 'oldest_allowed_timestamp', 'newest_allowed_timestamp',
  'max_pages', 'max_transactions', 'request_timeout_ms', 'overall_timeout_ms',
  'max_attempts_per_page',
]);
const RESULT_FIELDS = Object.freeze(['normalizedEvents', 'inputStatus', 'acquisitionSummary']);
const STATUS_FIELDS = Object.freeze([
  'acquisition_complete', 'normalization_complete', 'pagination_complete', 'truncated',
  'capped', 'partial', 'provider_uncertain',
]);
const SUMMARY_FIELDS = Object.freeze([
  'pages_read', 'transactions_read', 'normalized_event_count', 'oldest_observed_timestamp',
  'newest_observed_timestamp', 'pagination_terminal_reason', 'retry_count', 'timeout_count',
]);
const EVENT_FIELDS = Object.freeze([
  'wallet', 'timestamp', 'tx_hash', 'source', 'token_in_mint', 'token_in_amount',
  'token_in_decimals', 'token_out_mint', 'token_out_amount', 'token_out_decimals',
  'extraction_method', 'raw_index',
]);
const EXTRACTION_METHOD_V1 = 'helius_enhanced_transaction_swap_v1';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function descriptorObject(value, fields, code, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    acquisitionFail(code, `${context} must be an ordinary object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) acquisitionFail(code, `${context} must not contain symbols`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      acquisitionFail(code, `${context} must contain only enumerable data properties`);
    }
    if (!fields.includes(field)) acquisitionFail(code, `${context} contains an unknown field`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(descriptors, field)) acquisitionFail(code, `${context} is missing a required field`);
  }
  return Object.fromEntries(Object.entries(descriptors).map(([field, descriptor]) => [field, descriptor.value]));
}

function denseArray(value, code, context) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length !== 0) acquisitionFail(code, `${context} must be an ordinary dense array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors).filter(([field]) => field !== 'length');
  if (entries.length !== value.length || entries.some(([field, descriptor], index) => (
    field !== String(index) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
  ))) acquisitionFail(code, `${context} must be an ordinary dense array`);
  return entries.map(([, descriptor]) => descriptor.value);
}

function isSolanaAddress(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  const bytes = [0];
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return false;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === '1') leadingZeros += 1;
  const decodedLength = bytes.length + leadingZeros - (bytes.length === 1 && bytes[0] === 0 ? 1 : 0);
  return decodedLength === 32;
}

function safeNonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateAcquisitionRequestV1(value) {
  const request = descriptorObject(value, REQUEST_FIELDS, 'invalid_acquisition_request', 'acquisition request');
  const target = descriptorObject(request.target, TARGET_FIELDS, 'invalid_acquisition_request', 'target');
  const bounds = descriptorObject(request.bounds, BOUNDS_FIELDS, 'invalid_acquisition_request', 'bounds');
  if (!isSolanaAddress(request.wallet)) acquisitionFail('invalid_acquisition_request', 'wallet must be a valid Solana address');
  if (!isSolanaAddress(target.token_mint)) acquisitionFail('invalid_acquisition_request', 'target.token_mint must be a valid Solana address');
  if (target.receipt_type !== 'closed_position') acquisitionFail('invalid_acquisition_request', 'only closed_position targets are supported');
  if (!safeNonnegative(target.segment_index)) acquisitionFail('invalid_acquisition_request', 'target.segment_index must be a non-negative safe integer');
  if (bounds.before_signature !== null
      && (typeof bounds.before_signature !== 'string' || bounds.before_signature.length === 0)) {
    acquisitionFail('invalid_acquisition_request', 'bounds.before_signature must be null or a non-empty string');
  }
  for (const field of ['oldest_allowed_timestamp', 'newest_allowed_timestamp']) {
    if (!safeNonnegative(bounds[field])) acquisitionFail('invalid_acquisition_request', `bounds.${field} must be a non-negative safe integer`);
  }
  if (bounds.oldest_allowed_timestamp > bounds.newest_allowed_timestamp) {
    acquisitionFail('invalid_acquisition_request', 'oldest timestamp must not exceed newest timestamp');
  }
  for (const field of ['max_pages', 'max_transactions', 'request_timeout_ms', 'overall_timeout_ms', 'max_attempts_per_page']) {
    if (!Number.isSafeInteger(bounds[field]) || bounds[field] <= 0) {
      acquisitionFail('invalid_acquisition_request', `bounds.${field} must be a positive safe integer`);
    }
  }
  if (bounds.max_pages > ACQUISITION_LIMITS_V1.max_pages
      || bounds.max_transactions > ACQUISITION_LIMITS_V1.max_transactions
      || bounds.request_timeout_ms > ACQUISITION_LIMITS_V1.max_request_timeout_ms
      || bounds.overall_timeout_ms > ACQUISITION_LIMITS_V1.max_overall_timeout_ms
      || bounds.max_attempts_per_page > ACQUISITION_LIMITS_V1.max_attempts_per_page) {
    acquisitionFail('invalid_acquisition_request', 'acquisition bounds exceed conservative v1 limits');
  }
  if (bounds.request_timeout_ms >= bounds.overall_timeout_ms) {
    acquisitionFail('invalid_acquisition_request', 'request timeout must be less than overall timeout');
  }
  if (request.fetch_profile !== ACQUISITION_FETCH_PROFILE_V1
      || request.normalization_profile !== ACQUISITION_NORMALIZATION_PROFILE_V1) {
    acquisitionFail('invalid_acquisition_request', 'acquisition profiles must use the frozen v1 identifiers');
  }
  return structuredClone({ ...request, target, bounds });
}

function validateEvent(value, index, request, previous, txHashes, rawIndexes) {
  const event = descriptorObject(value, EVENT_FIELDS, 'normalization_failed', `normalizedEvents[${index}]`);
  for (const field of ['wallet', 'tx_hash', 'source', 'token_in_mint', 'token_out_mint', 'extraction_method']) {
    if (typeof event[field] !== 'string' || event[field].length === 0) acquisitionFail('normalization_failed', `normalized event ${field} is invalid`);
  }
  if (event.wallet !== request.wallet || event.token_in_mint === event.token_out_mint
      || (event.token_in_mint !== request.target.token_mint
        && event.token_out_mint !== request.target.token_mint)
      || event.extraction_method !== EXTRACTION_METHOD_V1) {
    acquisitionFail('normalization_failed', 'normalized event identity is invalid');
  }
  for (const field of ['timestamp', 'token_in_decimals', 'token_out_decimals', 'raw_index']) {
    if (!safeNonnegative(event[field])) acquisitionFail('normalization_failed', `normalized event ${field} is invalid`);
  }
  if (event.token_in_decimals > 255 || event.token_out_decimals > 255) acquisitionFail('normalization_failed', 'normalized event decimals are invalid');
  for (const field of ['token_in_amount', 'token_out_amount']) {
    if (typeof event[field] !== 'number' || !Number.isFinite(event[field]) || event[field] <= 0 || Object.is(event[field], -0)) {
      acquisitionFail('normalization_failed', `normalized event ${field} is invalid`);
    }
  }
  if (event.timestamp < request.bounds.oldest_allowed_timestamp
      || event.timestamp > request.bounds.newest_allowed_timestamp
      || event.raw_index !== index) {
    acquisitionFail('normalization_failed', 'normalized event is outside the deterministic receipt scope');
  }
  if (txHashes.has(event.tx_hash) || rawIndexes.has(event.raw_index)) acquisitionFail('normalization_failed', 'normalized event identities must be unique');
  if (previous && (event.timestamp < previous.timestamp
      || (event.timestamp === previous.timestamp
        && event.tx_hash <= previous.tx_hash))) {
    acquisitionFail('normalization_failed', 'normalized events must be in deterministic timestamp/signature order');
  }
  txHashes.add(event.tx_hash); rawIndexes.add(event.raw_index);
  return event;
}

export function validateAcquisitionResultV1(value, request) {
  const result = descriptorObject(value, RESULT_FIELDS, 'acquisition_incomplete', 'acquisition result');
  const status = descriptorObject(result.inputStatus, STATUS_FIELDS, 'acquisition_incomplete', 'inputStatus');
  const summary = descriptorObject(result.acquisitionSummary, SUMMARY_FIELDS, 'acquisition_incomplete', 'acquisitionSummary');
  for (const field of STATUS_FIELDS) if (typeof status[field] !== 'boolean') acquisitionFail('acquisition_incomplete', `inputStatus.${field} must be boolean`);
  if (!status.acquisition_complete || !status.normalization_complete || !status.pagination_complete
      || status.truncated || status.capped || status.partial || status.provider_uncertain) {
    acquisitionFail('acquisition_incomplete', 'acquisition result does not prove complete deterministic input');
  }
  for (const field of ['pages_read', 'transactions_read', 'normalized_event_count', 'retry_count', 'timeout_count']) {
    if (!safeNonnegative(summary[field])) acquisitionFail('acquisition_incomplete', `acquisitionSummary.${field} is invalid`);
  }
  for (const field of ['oldest_observed_timestamp', 'newest_observed_timestamp']) {
    if (summary[field] !== null && !safeNonnegative(summary[field])) acquisitionFail('acquisition_incomplete', `acquisitionSummary.${field} is invalid`);
  }
  const hasObservedTransactions = summary.transactions_read > 0;
  if (summary.pages_read < 1 || summary.pages_read > request.bounds.max_pages
      || summary.transactions_read > request.bounds.max_transactions
      || (summary.oldest_observed_timestamp === null) !== !hasObservedTransactions
      || (summary.newest_observed_timestamp === null) !== !hasObservedTransactions
      || (hasObservedTransactions
        && summary.oldest_observed_timestamp > summary.newest_observed_timestamp)
      || summary.retry_count > summary.pages_read * (request.bounds.max_attempts_per_page - 1)
      || summary.timeout_count > summary.retry_count) {
    acquisitionFail('acquisition_incomplete', 'acquisition summary is internally inconsistent');
  }
  if (!['provider_exhaustion', 'historical_bound_reached'].includes(summary.pagination_terminal_reason)) {
    acquisitionFail('acquisition_incomplete', 'pagination terminal reason is unsupported');
  }
  if (summary.pagination_terminal_reason === 'historical_bound_reached'
      && (!hasObservedTransactions
        || summary.oldest_observed_timestamp >= request.bounds.oldest_allowed_timestamp)) {
    acquisitionFail('acquisition_incomplete', 'historical-bound completion is not supported by the summary');
  }
  const values = denseArray(result.normalizedEvents, 'normalization_failed', 'normalizedEvents');
  const events = [];
  const txHashes = new Set(); const rawIndexes = new Set();
  for (let index = 0; index < values.length; index += 1) {
    events.push(validateEvent(values[index], index, request, events.at(-1), txHashes, rawIndexes));
  }
  if (summary.normalized_event_count !== events.length || summary.transactions_read < events.length
      || events.some(event => summary.oldest_observed_timestamp === null
        || event.timestamp < summary.oldest_observed_timestamp
        || event.timestamp > summary.newest_observed_timestamp)) {
    acquisitionFail('acquisition_incomplete', 'normalized events do not match the acquisition summary');
  }
  return deepFreeze(structuredClone({ normalizedEvents: events, inputStatus: status, acquisitionSummary: summary }));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function capabilityMethod(ports) {
  const values = descriptorObject(ports, ['acquisitionPort'], 'acquisition_capability_denied', 'acquisition ports');
  const port = values.acquisitionPort;
  if (port === null || typeof port !== 'object' || Array.isArray(port)) acquisitionFail('acquisition_capability_denied', 'acquisitionPort is required');
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(port); } catch { acquisitionFail('acquisition_capability_denied', 'acquisitionPort is unavailable'); }
  const method = descriptors.acquireNormalizedSolanaSpotEventsV1;
  if (!method || !method.enumerable || !Object.hasOwn(method, 'value') || typeof method.value !== 'function') {
    acquisitionFail('acquisition_capability_denied', 'acquisitionPort does not implement the v1 acquisition method');
  }
  return method.value.bind(port);
}

export async function acquireNormalizedSolanaSpotEventsV1(request, ports) {
  let validated;
  try { validated = validateAcquisitionRequestV1(request); } catch (error) {
    rethrowSanitizedAcquisitionError(error, 'invalid_acquisition_request', 'acquisition request validation failed');
  }
  let acquire;
  try { acquire = capabilityMethod(ports); } catch {
    acquisitionFail('acquisition_capability_denied', 'acquisition capability validation failed');
  }
  let result;
  try { result = await acquire(validated); } catch (error) {
    rethrowSanitizedAcquisitionError(error, 'acquisition_incomplete', 'injected acquisition capability failed');
  }
  try { return validateAcquisitionResultV1(result, validated); } catch (error) {
    rethrowSanitizedAcquisitionError(error, 'acquisition_incomplete', 'acquisition result validation failed');
  }
}
