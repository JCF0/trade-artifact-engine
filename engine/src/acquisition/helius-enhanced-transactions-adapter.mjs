import {
  validateAcquisitionRequestV1,
  validateAcquisitionResultV1,
} from './acquisition-contract.mjs';
import {
  acquisitionFail,
  rethrowSanitizedAcquisitionError,
} from './acquisition-errors.mjs';
import {
  HELIUS_ENHANCED_TRANSACTIONS_PAGE_SIZE,
  validateHeliusEnhancedTransactionsPageV1,
} from './helius-page-validator.mjs';
import { normalizeHeliusSolanaSpotEventsV1 } from './solana-spot-event-normalizer.mjs';

const ENDPOINT_ORIGIN = 'https://api.helius.xyz';

function methodFromObject(value, name, code, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) acquisitionFail(code, `${context} must be an ordinary object`);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length !== 0) acquisitionFail(code, `${context} must not contain symbols`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== 1 || !Object.hasOwn(descriptors, name)) {
    acquisitionFail(code, `${context} must expose only ${name}`);
  }
  const descriptor = descriptors[name];
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    acquisitionFail(code, `${context}.${name} must be a data-property function`);
  }
  return descriptor.value.bind(value);
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype || Object.getOwnPropertySymbols(options).length !== 0) {
    acquisitionFail('acquisition_capability_denied', 'adapter options must be an ordinary object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const expected = ['httpClient', 'apiKeyProvider', 'sleep', 'clock', 'random'];
  for (const field of expected) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      acquisitionFail('acquisition_capability_denied', 'adapter option is missing');
    }
  }
  for (const field of Object.keys(descriptors)) {
    if (!expected.includes(field)) acquisitionFail('acquisition_capability_denied', 'adapter options contain an unknown field');
  }
  const httpRequest = methodFromObject(descriptors.httpClient.value, 'request', 'acquisition_capability_denied', 'httpClient');
  const functions = {};
  for (const field of ['apiKeyProvider', 'sleep', 'clock', 'random']) {
    if (typeof descriptors[field].value !== 'function') acquisitionFail('acquisition_capability_denied', `${field} must be a function`);
    functions[field] = descriptors[field].value;
  }
  return { httpRequest, ...functions };
}

function errorCode(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value : null;
  } catch {
    return null;
  }
}

function responseBoundary(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    acquisitionFail('provider_transient_failure', 'HTTP capability returned an invalid response envelope');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== 2 || !descriptors.status || !descriptors.data
      || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    acquisitionFail('provider_transient_failure', 'HTTP capability returned an invalid response envelope');
  }
  const status = descriptors.status.value;
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    acquisitionFail('provider_transient_failure', 'HTTP capability returned an invalid status');
  }
  return { status, data: descriptors.data.value };
}

function deadlineNow(clock) {
  let value;
  try { value = clock(); } catch { acquisitionFail('acquisition_capability_denied', 'clock capability failed'); }
  if (!Number.isFinite(value) || value < 0) acquisitionFail('acquisition_capability_denied', 'clock capability returned an invalid value');
  return value;
}

function retryDelay(attempt, random) {
  let jitter;
  try { jitter = random(); } catch { acquisitionFail('acquisition_capability_denied', 'random capability failed'); }
  if (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter >= 1) {
    acquisitionFail('acquisition_capability_denied', 'random capability returned an invalid value');
  }
  return Math.min(5000, 100 * (2 ** (attempt - 1))) + Math.floor(jitter * 100);
}

function endpointFor(wallet) {
  return `${ENDPOINT_ORIGIN}/v0/addresses/${wallet}/transactions`;
}

function apiKey(provider) {
  let key;
  try { key = provider(); } catch { acquisitionFail('api_key_unavailable', 'Helius API key capability is unavailable'); }
  if (typeof key !== 'string' || key.length === 0) acquisitionFail('api_key_unavailable', 'Helius API key capability is unavailable');
  return key;
}

function transientThrownCode(code) {
  return code === 'request_timeout' || code === 'ETIMEDOUT' || code === 'transient_transport';
}

async function requestPage({ capabilities, request, key, cursor, deadline, counters }) {
  const query = {
    'api-key': key,
    before: cursor,
    limit: HELIUS_ENHANCED_TRANSACTIONS_PAGE_SIZE,
  };
  for (let attempt = 1; attempt <= request.bounds.max_attempts_per_page; attempt += 1) {
    if (deadlineNow(capabilities.clock) >= deadline) acquisitionFail('acquisition_deadline_exceeded', 'overall acquisition deadline was exceeded');
    let response;
    let thrownCode = null;
    let rawResponse;
    let requestReturned = false;
    try {
      rawResponse = await capabilities.httpRequest({
        method: 'GET',
        url: endpointFor(request.wallet),
        query: { ...query },
        timeout_ms: request.bounds.request_timeout_ms,
      });
      requestReturned = true;
    } catch (error) {
      thrownCode = errorCode(error);
      if (thrownCode === 'invalid_json') acquisitionFail('malformed_provider_page', 'provider returned invalid JSON');
      if (thrownCode === 'provider_uncertain') acquisitionFail('acquisition_incomplete', 'provider outcome is uncertain');
      if (!transientThrownCode(thrownCode)) acquisitionFail('provider_transient_failure', 'HTTP capability failed without a retryable classification');
      if (thrownCode === 'request_timeout' || thrownCode === 'ETIMEDOUT') counters.timeout_count += 1;
    }
    if (requestReturned) {
      try { response = responseBoundary(rawResponse); } catch (error) {
        rethrowSanitizedAcquisitionError(error, 'provider_transient_failure', 'HTTP capability returned an invalid response');
      }
    }
    if (deadlineNow(capabilities.clock) >= deadline) acquisitionFail('acquisition_deadline_exceeded', 'overall acquisition deadline was exceeded');
    if (response) {
      if (response.status >= 200 && response.status <= 299) return response.data;
      if (response.status === 400) acquisitionFail('provider_request_invalid', 'provider rejected the bounded request');
      if (response.status === 401 || response.status === 403) acquisitionFail('provider_auth_failed', 'provider authentication failed');
      if (response.status !== 429 && (response.status < 500 || response.status > 599)) {
        acquisitionFail('acquisition_incomplete', 'provider returned an unsupported terminal status');
      }
    }
    if (attempt === request.bounds.max_attempts_per_page) {
      acquisitionFail('provider_retry_exhausted', 'provider retry budget was exhausted');
    }
    counters.retry_count += 1;
    const delay = retryDelay(attempt, capabilities.random);
    if (deadlineNow(capabilities.clock) + delay >= deadline) acquisitionFail('acquisition_deadline_exceeded', 'retry backoff would exceed the overall deadline');
    try { await capabilities.sleep(delay); } catch { acquisitionFail('acquisition_capability_denied', 'sleep capability failed'); }
  }
  acquisitionFail('provider_retry_exhausted', 'provider retry budget was exhausted');
}

function completedStatus() {
  return {
    acquisition_complete: true,
    normalization_complete: true,
    pagination_complete: true,
    truncated: false,
    capped: false,
    partial: false,
    provider_uncertain: false,
  };
}

async function acquire(capabilities, rawRequest) {
  let request;
  try { request = validateAcquisitionRequestV1(rawRequest); } catch (error) {
    rethrowSanitizedAcquisitionError(error, 'invalid_acquisition_request', 'acquisition request validation failed');
  }
  const startedAt = deadlineNow(capabilities.clock);
  const deadline = startedAt + request.bounds.overall_timeout_ms;
  const key = apiKey(capabilities.apiKeyProvider);
  if (deadlineNow(capabilities.clock) >= deadline) {
    acquisitionFail('acquisition_deadline_exceeded', 'overall acquisition deadline was exceeded during API key acquisition');
  }
  const counters = { retry_count: 0, timeout_count: 0 };
  const transactions = [];
  const seenSignatures = new Map();
  let cursor = request.bounds.before_signature;
  let previousTimestamp = null;
  let pagesRead = 0;
  let oldestObserved = null;
  let newestObserved = null;
  let terminalReason = null;

  while (terminalReason === null) {
    if (pagesRead >= request.bounds.max_pages) acquisitionFail('acquisition_capped', 'maximum page count was reached before completeness was proven');
    const pageData = await requestPage({ capabilities, request, key, cursor, deadline, counters });
    let page;
    try {
      page = validateHeliusEnhancedTransactionsPageV1(pageData, {
        seenSignatures,
        previousTimestamp,
        requestCursor: cursor,
      });
    } catch (error) {
      rethrowSanitizedAcquisitionError(error, 'malformed_provider_page', 'provider page validation failed');
    }
    if (pagesRead > 0 && page.transactions.length === 0) {
      acquisitionFail('pagination_terminal_ambiguous', 'an empty intermediate page does not prove exhaustion');
    }
    if (transactions.length + page.transactions.length > request.bounds.max_transactions) {
      acquisitionFail('acquisition_capped', 'maximum transaction count was reached before completeness was proven');
    }
    pagesRead += 1;
    transactions.push(...page.transactions);
    previousTimestamp = page.lastTimestamp;
    if (page.transactions.length > 0) {
      newestObserved = newestObserved === null ? page.transactions[0].timestamp : Math.max(newestObserved, page.transactions[0].timestamp);
      oldestObserved = oldestObserved === null ? page.transactions.at(-1).timestamp : Math.min(oldestObserved, page.transactions.at(-1).timestamp);
    }
    const historicalBoundReached = page.transactions.some(transaction => transaction.timestamp < request.bounds.oldest_allowed_timestamp);
    if (historicalBoundReached) {
      terminalReason = 'historical_bound_reached';
    } else if (page.transactions.length < HELIUS_ENHANCED_TRANSACTIONS_PAGE_SIZE) {
      terminalReason = 'provider_exhaustion';
    } else {
      if (page.continuationCursor === null) acquisitionFail('pagination_terminal_ambiguous', 'full provider page has no continuation cursor');
      if (page.continuationCursor === cursor) acquisitionFail('pagination_cursor_repeated', 'provider pagination cursor did not advance');
      cursor = page.continuationCursor;
      if (transactions.length >= request.bounds.max_transactions) acquisitionFail('acquisition_capped', 'maximum transaction count was reached before completeness was proven');
      if (pagesRead >= request.bounds.max_pages) acquisitionFail('acquisition_capped', 'maximum page count was reached before completeness was proven');
    }
  }

  let normalizedEvents;
  try { normalizedEvents = normalizeHeliusSolanaSpotEventsV1(transactions, request); } catch (error) {
    rethrowSanitizedAcquisitionError(error, 'normalization_failed', 'provider transaction normalization failed');
  }
  const result = {
    normalizedEvents,
    inputStatus: completedStatus(),
    acquisitionSummary: {
      pages_read: pagesRead,
      transactions_read: transactions.length,
      normalized_event_count: normalizedEvents.length,
      oldest_observed_timestamp: oldestObserved,
      newest_observed_timestamp: newestObserved,
      pagination_terminal_reason: terminalReason,
      retry_count: counters.retry_count,
      timeout_count: counters.timeout_count,
    },
  };
  try { return validateAcquisitionResultV1(result, request); } catch (error) {
    rethrowSanitizedAcquisitionError(error, 'acquisition_incomplete', 'acquisition result validation failed');
  }
}

export function createHeliusEnhancedTransactionsAcquisitionAdapter(options) {
  let capabilities;
  try { capabilities = validateOptions(options); } catch {
    acquisitionFail('acquisition_capability_denied', 'adapter capability validation failed');
  }
  return Object.freeze({
    acquireNormalizedSolanaSpotEventsV1(request) {
      return acquire(capabilities, request);
    },
  });
}
