import { types as utilTypes } from 'node:util';

import { MAX_ATTEMPTS_PER_OPERATION_V1, MAX_OVERALL_TIMEOUT_MS_V1, MAX_PAGES_V1, MAX_REQUEST_TIMEOUT_MS_V1, MAX_TRANSACTIONS_V1, PAGE_SIZE_V1 } from './request-contract.mjs';
import { createWalletHistoryPortV1, failWalletAcquisitionOperationV1 } from './provider-port.mjs';
import { projectHeliusEnhancedTransactionV1 } from './helius-enhanced-projector.mjs';
import {
  validateHeliusEnhancedAddressPageV1,
  isSolanaPublicKeyV1,
  isSolanaSignatureV1,
  validateHeliusRpcBlockResponseV1,
  validateHeliusRpcGenesisResponseV1,
  validateHeliusRpcSignaturePageResponseV1,
  validateHeliusRpcSlotResponseV1,
} from './helius-rpc-validator.mjs';

const RPC_URL = 'https://mainnet.helius-rpc.com/';
const ENHANCED_ORIGIN = 'https://api.helius.xyz';

function fail(code) { failWalletAcquisitionOperationV1(code); }
function method(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail('acquisition_capability_denied');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== 1 || !descriptors[name] || !descriptors[name].enumerable || !Object.hasOwn(descriptors[name], 'value') || typeof descriptors[name].value !== 'function') fail('acquisition_capability_denied');
  return descriptors[name].value.bind(value);
}
function options(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail('acquisition_capability_denied');
    const expected = ['httpClient','apiKeyProvider','sleep','clock','random'];
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const optional = ['telemetry'];
    if (Object.keys(descriptors).some(name => ![...expected, ...optional].includes(name)) || expected.some(name => !descriptors[name]?.enumerable || !Object.hasOwn(descriptors[name], 'value'))) fail('acquisition_capability_denied');
    const functions = Object.fromEntries(expected.slice(1).map(name => {
      if (typeof descriptors[name].value !== 'function') fail('acquisition_capability_denied');
      return [name, descriptors[name].value];
    }));
    let telemetry = Object.freeze({ onRetryAttemptV1() {}, onTimeoutAttemptV1() {} });
    if (descriptors.telemetry !== undefined) {
      const value = descriptors.telemetry.value;
      if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('acquisition_capability_denied');
      const telemetryDescriptors = Object.getOwnPropertyDescriptors(value);
      const names = ['onRetryAttemptV1','onTimeoutAttemptV1'];
      if (Object.keys(telemetryDescriptors).length !== names.length || names.some(name => !telemetryDescriptors[name]?.enumerable || !Object.hasOwn(telemetryDescriptors[name], 'value') || typeof telemetryDescriptors[name].value !== 'function')) fail('acquisition_capability_denied');
      telemetry = Object.freeze(Object.fromEntries(names.map(name => [name, telemetryDescriptors[name].value.bind(value)])));
    }
    return { request: method(descriptors.httpClient.value, 'request'), ...functions, telemetry };
  } catch { fail('acquisition_capability_denied'); }
}
function now(clock) { let value; try { value = clock(); } catch { fail('acquisition_capability_denied'); } if (!Number.isFinite(value) || value < 0) fail('acquisition_capability_denied'); return value; }
function key(provider) { let value; try { value = provider(); } catch { fail('api_key_unavailable'); } if (typeof value !== 'string' || value.length === 0) fail('api_key_unavailable'); return value; }
function thrownCode(error) {
  try { const descriptor = error !== null && (typeof error === 'object' || typeof error === 'function') && !utilTypes.isProxy(error) ? Object.getOwnPropertyDescriptor(error, 'code') : null; return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null; }
  catch { return null; }
}
function envelope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail('provider_transient_failure');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== 2 || !descriptors.status?.enumerable || !descriptors.data?.enumerable || !Object.hasOwn(descriptors.status, 'value') || !Object.hasOwn(descriptors.data, 'value')) fail('provider_transient_failure');
  const status = descriptors.status.value;
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) fail('provider_transient_failure');
  return { status, data: descriptors.data.value };
}
function delayFor(attempt, random) { let value; try { value = random(); } catch { fail('acquisition_capability_denied'); } if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) fail('acquisition_capability_denied'); return Math.min(5000, 100 * (2 ** (attempt - 1))) + Math.floor(value * 100); }
const BOUNDED_TIMEOUT = Symbol('bounded-timeout');
async function boundedAwait(value, timeoutMs, timeoutCode, onTimeout = () => {}) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, Math.ceil(timeoutMs)), BOUNDED_TIMEOUT); });
  try {
    const result = await Promise.race([Promise.resolve(value), timeout]);
    if (result === BOUNDED_TIMEOUT) { onTimeout(); fail(timeoutCode); }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

const BUDGET_FIELDS = ['pagination_profile','page_size','max_pages','max_transactions','retry_profile','max_attempts_per_operation','timeout_profile','request_timeout_ms','overall_timeout_ms'];
function operationBudgets(value) {
  if (value === undefined) return {
    max_pages: MAX_PAGES_V1, max_transactions: MAX_TRANSACTIONS_V1,
    max_attempts_per_operation: MAX_ATTEMPTS_PER_OPERATION_V1,
    request_timeout_ms: MAX_REQUEST_TIMEOUT_MS_V1, overall_timeout_ms: MAX_OVERALL_TIMEOUT_MS_V1,
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== BUDGET_FIELDS.length
      || BUDGET_FIELDS.some(field => !Object.hasOwn(value, field))
      || value.pagination_profile !== 'helius_wallet_history_page_100_v1' || value.page_size !== PAGE_SIZE_V1
      || value.retry_profile !== 'bounded_exponential_retry_v1' || value.timeout_profile !== 'bounded_provider_timeout_v1') fail('invalid_acquisition_request');
  for (const [field, maximum] of [['max_pages',MAX_PAGES_V1],['max_transactions',MAX_TRANSACTIONS_V1],['max_attempts_per_operation',MAX_ATTEMPTS_PER_OPERATION_V1],['request_timeout_ms',MAX_REQUEST_TIMEOUT_MS_V1],['overall_timeout_ms',MAX_OVERALL_TIMEOUT_MS_V1]]) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0 || value[field] > maximum) fail('invalid_acquisition_request');
  }
  if (value.request_timeout_ms >= value.overall_timeout_ms) fail('invalid_acquisition_request');
  return value;
}

function beginOperation(capabilities, requestedBudgets) {
  const budgets = operationBudgets(requestedBudgets);
  const started = now(capabilities.clock);
  const deadline = started + budgets.overall_timeout_ms;
  const apiKey = key(capabilities.apiKeyProvider);
  if (now(capabilities.clock) >= deadline) fail('acquisition_deadline_exceeded');
  return { deadline, apiKey, ...budgets };
}

async function execute(capabilities, logicalRequest, context = beginOperation(capabilities)) {
  const { deadline, apiKey } = context;
  const baseRequest = { ...logicalRequest, query: { ...(logicalRequest.query ?? {}), 'api-key': apiKey } };
  for (let attempt = 1; attempt <= context.max_attempts_per_operation; attempt += 1) {
    const remaining = deadline - now(capabilities.clock);
    if (remaining <= 0) fail('acquisition_deadline_exceeded');
    const timeout = Math.min(context.request_timeout_ms, remaining);
    const timeoutCode = remaining <= context.request_timeout_ms ? 'acquisition_deadline_exceeded' : 'provider_timeout';
    const controller = new AbortController();
    const request = { ...baseRequest, timeout_ms: timeout, signal: controller.signal };
    let deadlineExpired = false;
    let transportSettled = false;
    let timeoutAccounted = false;
    const markTimeout = () => {
      if (timeoutAccounted) return;
      timeoutAccounted = true;
      capabilities.telemetry.onTimeoutAttemptV1();
    };
    const abortTimer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, Math.max(1, Math.ceil(timeout)));
    let response = null; let retryable = false;
    try {
      if (attempt > 1) capabilities.telemetry.onRetryAttemptV1();
      let pending;
      try { pending = capabilities.request(request); }
      catch (error) { transportSettled = true; throw error; }
      const observed = Promise.resolve(pending).then(
        value => { transportSettled = true; return value; },
        error => { transportSettled = true; throw error; },
      );
      response = envelope(await boundedAwait(observed, timeout, timeoutCode));
    }
    catch (error) {
      const code = thrownCode(error);
      if (code === 'invalid_json') fail('malformed_provider_response');
      const timeoutCodeThrown = code === 'request_timeout' || code === 'provider_timeout' || code === 'ETIMEDOUT';
      const terminatedByEffectiveTimeout = transportSettled && (timeoutCodeThrown || (deadlineExpired && controller.signal.aborted));
      if (terminatedByEffectiveTimeout) { markTimeout(); retryable = true; }
      else if (timeoutCodeThrown) retryable = true;
      else if (code === 'transient_transport') retryable = true;
      else if (code !== null) fail(code);
      else fail('provider_transient_failure');
    } finally {
      clearTimeout(abortTimer);
    }
    if (now(capabilities.clock) >= deadline) fail('acquisition_deadline_exceeded');
    if (response !== null) {
      if (response.status >= 200 && response.status <= 299) return response.data;
      if (response.status === 400) fail('provider_request_invalid');
      if (response.status === 401 || response.status === 403) fail('provider_auth_failed');
      retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (!retryable) fail('provider_request_invalid');
    }
    if (!retryable) fail('provider_transient_failure');
    if (attempt === context.max_attempts_per_operation) fail('provider_retry_exhausted');
    const delay = delayFor(attempt, capabilities.random);
    if (now(capabilities.clock) + delay >= deadline) fail('acquisition_deadline_exceeded');
    const sleepRemaining = deadline - now(capabilities.clock);
    const sleepController = new AbortController();
    const sleepTimer = setTimeout(() => sleepController.abort(), Math.max(1, Math.ceil(sleepRemaining)));
    try { await boundedAwait(capabilities.sleep(delay, sleepController.signal), sleepRemaining, 'acquisition_deadline_exceeded'); } catch (error) {
      if (sleepController.signal.aborted || now(capabilities.clock) >= deadline) fail('acquisition_deadline_exceeded');
      if (thrownCode(error) === 'acquisition_deadline_exceeded') throw error;
      fail('provider_transient_failure');
    } finally {
      clearTimeout(sleepTimer);
    }
    if (now(capabilities.clock) >= deadline) fail('acquisition_deadline_exceeded');
  }
  fail('provider_retry_exhausted');
}

function rpc(methodName, params) { return { jsonrpc: '2.0', id: 'wallet-acquisition-v1', method: methodName, params }; }
function post(body) { return { method: 'POST', url: RPC_URL, query: {}, headers: { 'content-type': 'application/json' }, body }; }
function validateSlotInput(value) { if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.slot) || value.slot < 0) fail('provider_request_invalid'); }
function validatePageInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
      || !isSolanaPublicKeyV1(value.wallet) || (value.before !== null && !isSolanaSignatureV1(value.before))
      || value.limit !== PAGE_SIZE_V1 || value.commitment !== 'finalized') fail('provider_request_invalid');
}
function validateEnhancedInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !isSolanaPublicKeyV1(value.wallet)
      || !Array.isArray(value.signatures) || value.signatures.some(signature => !isSolanaSignatureV1(signature)) || new Set(value.signatures).size !== value.signatures.length) fail('provider_request_invalid');
}

async function enhancedBySignature(capabilities, input, operation) {
  validateEnhancedInput(input);
  if (input.signatures.length === 0) return [];
  const requested = new Set(input.signatures); const found = new Map(); const seen = new Map();
  let before = null; let entries = 0; let previous = null;
  for (let pageIndex = 0; pageIndex < operation.max_pages; pageIndex += 1) {
    const query = { limit: PAGE_SIZE_V1 };
    if (before !== null) query.before = before;
    const data = await execute(capabilities, { method: 'GET', url: `${ENHANCED_ORIGIN}/v0/addresses/${input.wallet}/transactions`, query }, operation);
    const page = validateHeliusEnhancedAddressPageV1(data);
    entries += page.length;
    if (entries > operation.max_transactions) fail('acquisition_capped');
    for (const body of page) {
      if (seen.has(body.signature)) fail('malformed_provider_response');
      if (body.signature === before || (previous !== null && (body.slot > previous.slot || body.timestamp > previous.timestamp))) fail('malformed_provider_response');
      seen.set(body.signature, body);
      if (requested.has(body.signature)) found.set(body.signature, body);
      previous = body;
    }
    if (found.size === requested.size) {
      return input.signatures.map(signature => projectHeliusEnhancedTransactionV1({ wallet: input.wallet, transaction: found.get(signature) }));
    }
    if (page.length < PAGE_SIZE_V1) fail('malformed_provider_response');
    const next = page.at(-1).signature;
    if (next === before) fail('malformed_provider_response');
    before = next;
  }
  fail('acquisition_capped');
}

export function createHeliusWalletHistoryPortV1(rawOptions) {
  const capabilities = options(rawOptions);
  let acquisition = null;
  let prepared = false;
  const context = networkStart => {
    if ((networkStart && !prepared) || acquisition === null) acquisition = beginOperation(capabilities);
    if (networkStart) prepared = false;
    return acquisition;
  };
  return createWalletHistoryPortV1({
    async getNetworkIdentityV1() { return validateHeliusRpcGenesisResponseV1(await execute(capabilities, post(rpc('getGenesisHash', [])), context(true))); },
    async getFinalizedSlotV1() { return validateHeliusRpcSlotResponseV1(await execute(capabilities, post(rpc('getSlot', [{ commitment: 'finalized' }])), context(false))); },
    async getFinalizedBlockV1(input) {
      validateSlotInput(input);
      return validateHeliusRpcBlockResponseV1(await execute(capabilities, post(rpc('getBlock', [input.slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false }])), context(false)), input.slot);
    },
    async getFinalizedWalletSignaturePageV1(input) {
      validatePageInput(input);
      const config = { limit: PAGE_SIZE_V1, commitment: 'finalized' };
      if (input.before !== null) config.before = input.before;
      return validateHeliusRpcSignaturePageResponseV1(await execute(capabilities, post(rpc('getSignaturesForAddress', [input.wallet, config])), context(false)));
    },
    async getEnhancedTransactionsBySignatureV1(input) { return enhancedBySignature(capabilities, input, context(false)); },
  }, {
    beginAcquisitionV1(budgets) {
      acquisition = beginOperation(capabilities, budgets);
      prepared = true;
    },
  });
}
