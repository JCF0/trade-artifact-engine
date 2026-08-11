import { types as utilTypes } from 'node:util';

import { validateHeliusFullTransactionV1 } from './helius-full-transaction-validator.mjs';
import {
  validateHeliusRpcBlockResponseV1,
  validateHeliusRpcGenesisResponseV1,
  validateHeliusRpcSignaturePageResponseV1,
  validateHeliusRpcSlotResponseV1,
} from './helius-rpc-validator.mjs';
import { createWalletHistoryPortV2 } from './provider-port-v2.mjs';
import {
  detachProviderNeutralValueV1,
  failWalletAcquisitionOperationV1,
} from './provider-port.mjs';
import {
  MAX_ATTEMPTS_PER_OPERATION_V1,
  MAX_EXACT_FALLBACK_TRANSACTIONS_V2,
  MAX_OVERALL_TIMEOUT_MS_V1,
  MAX_PAGES_V1,
  MAX_REQUEST_TIMEOUT_MS_V1,
  MAX_TRANSACTIONS_V1,
  PAGE_SIZE_V1,
  SOLANA_MAINNET_GENESIS_HASH,
} from './request-contract.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './solana-identities.mjs';

const RPC_URL = 'https://mainnet.helius-rpc.com/';
const RPC_ID = 'wallet-acquisition-v2';
const MAX_PAGINATION_TOKEN_LENGTH = 1024;
const FULL_PAGE_INPUT_FIELDS = [
  'wallet','pagination_token','limit','commitment','anchor_slot','transaction_details',
  'sort_order','encoding','max_supported_transaction_version','token_account_scope','status',
];
const EXACT_TRANSACTION_INPUT_FIELDS = [
  'signature','commitment','encoding','max_supported_transaction_version',
];
const BUDGET_FIELDS = [
  'pagination_profile','page_size','max_pages','max_transactions','retry_profile',
  'max_attempts_per_operation','timeout_profile','request_timeout_ms','overall_timeout_ms',
  'exact_fallback_profile','max_exact_fallback_transactions',
];

function fail(code, reason) { failWalletAcquisitionOperationV1(code, reason); }
function exactObject(value, fields, code = 'provider_request_invalid') {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== fields.length
      || fields.some(field => !descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value'))) fail(code);
  return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
}
function method(value, name) {
  const object = exactObject(value, [name], 'acquisition_capability_denied');
  if (typeof object[name] !== 'function') fail('acquisition_capability_denied');
  return object[name].bind(value);
}
function capabilities(value) {
  try {
    const required = ['httpClient','apiKeyProvider','sleep','clock','random'];
    const allowed = [...required, 'telemetry'];
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) fail('acquisition_capability_denied');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).some(name => !allowed.includes(name))
        || required.some(name => !descriptors[name]?.enumerable || !Object.hasOwn(descriptors[name], 'value'))) fail('acquisition_capability_denied');
    const functions = Object.fromEntries(required.slice(1).map(name => {
      if (typeof descriptors[name].value !== 'function') fail('acquisition_capability_denied');
      return [name, descriptors[name].value];
    }));
    let telemetry = Object.freeze({ onRetryAttemptV1() {}, onTimeoutAttemptV1() {} });
    if (descriptors.telemetry !== undefined) {
      const raw = exactObject(descriptors.telemetry.value, ['onRetryAttemptV1','onTimeoutAttemptV1'], 'acquisition_capability_denied');
      if (typeof raw.onRetryAttemptV1 !== 'function' || typeof raw.onTimeoutAttemptV1 !== 'function') fail('acquisition_capability_denied');
      telemetry = Object.freeze({
        onRetryAttemptV1: raw.onRetryAttemptV1.bind(descriptors.telemetry.value),
        onTimeoutAttemptV1: raw.onTimeoutAttemptV1.bind(descriptors.telemetry.value),
      });
    }
    return { request: method(descriptors.httpClient.value, 'request'), ...functions, telemetry };
  } catch {
    fail('acquisition_capability_denied');
  }
}
function now(clock) {
  let value;
  try { value = clock(); } catch { fail('acquisition_capability_denied'); }
  if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) fail('acquisition_capability_denied');
  return value;
}
function apiKey(provider) {
  let value;
  try { value = provider(); } catch { fail('api_key_unavailable'); }
  if (typeof value !== 'string' || value.length === 0) fail('api_key_unavailable');
  return value;
}
function thrownCode(error) {
  try {
    const descriptor = error !== null && (typeof error === 'object' || typeof error === 'function')
      && !utilTypes.isProxy(error) ? Object.getOwnPropertyDescriptor(error, 'code') : null;
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  } catch { return null; }
}
function responseEnvelope(value) {
  const envelope = exactObject(value, ['status','data'], 'provider_transient_failure');
  if (!Number.isSafeInteger(envelope.status) || envelope.status < 100 || envelope.status > 599) fail('provider_transient_failure');
  return envelope;
}
function retryDelay(attempt, random) {
  let value;
  try { value = random(); } catch { fail('acquisition_capability_denied'); }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) fail('acquisition_capability_denied');
  return Math.min(5000, 100 * (2 ** (attempt - 1))) + Math.floor(value * 100);
}

const BOUNDED_TIMEOUT = Symbol('bounded-timeout');
async function boundedAwait(value, timeoutMs, timeoutCode) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, Math.ceil(timeoutMs)), BOUNDED_TIMEOUT); });
  try {
    const result = await Promise.race([Promise.resolve(value), timeout]);
    if (result === BOUNDED_TIMEOUT) fail(timeoutCode);
    return result;
  } finally { clearTimeout(timer); }
}

function operationBudgets(value) {
  if (value === undefined) return {
    max_pages: MAX_PAGES_V1,
    max_transactions: MAX_TRANSACTIONS_V1,
    max_attempts_per_operation: MAX_ATTEMPTS_PER_OPERATION_V1,
    request_timeout_ms: MAX_REQUEST_TIMEOUT_MS_V1,
    overall_timeout_ms: MAX_OVERALL_TIMEOUT_MS_V1,
    max_exact_fallback_transactions: 0,
  };
  const budget = exactObject(value, BUDGET_FIELDS, 'invalid_acquisition_request');
  if (budget.pagination_profile !== 'solana_full_transaction_page_100_v1' || budget.page_size !== PAGE_SIZE_V1
      || budget.retry_profile !== 'bounded_exponential_retry_v1' || budget.timeout_profile !== 'bounded_provider_timeout_v1'
      || budget.exact_fallback_profile !== 'finalized_get_transaction_missing_only_v1') fail('invalid_acquisition_request');
  for (const [field, maximum] of [
    ['max_pages', MAX_PAGES_V1], ['max_transactions', MAX_TRANSACTIONS_V1],
    ['max_attempts_per_operation', MAX_ATTEMPTS_PER_OPERATION_V1],
    ['request_timeout_ms', MAX_REQUEST_TIMEOUT_MS_V1], ['overall_timeout_ms', MAX_OVERALL_TIMEOUT_MS_V1],
  ]) {
    if (!Number.isSafeInteger(budget[field]) || budget[field] <= 0 || budget[field] > maximum) fail('invalid_acquisition_request');
  }
  if (!Number.isSafeInteger(budget.max_exact_fallback_transactions) || budget.max_exact_fallback_transactions < 0
      || budget.max_exact_fallback_transactions > MAX_EXACT_FALLBACK_TRANSACTIONS_V2
      || budget.request_timeout_ms >= budget.overall_timeout_ms) fail('invalid_acquisition_request');
  return budget;
}
function beginOperation(capability, requestedBudgets) {
  const budget = operationBudgets(requestedBudgets);
  const deadline = now(capability.clock) + budget.overall_timeout_ms;
  const key = apiKey(capability.apiKeyProvider);
  if (now(capability.clock) >= deadline) fail('acquisition_deadline_exceeded');
  return { deadline, apiKey: key, exactFallbackCalls: 0, ...budget };
}

async function execute(capability, logicalRequest, operation) {
  const baseRequest = { ...logicalRequest, query: { ...(logicalRequest.query ?? {}), 'api-key': operation.apiKey } };
  for (let attempt = 1; attempt <= operation.max_attempts_per_operation; attempt += 1) {
    const attemptStarted = now(capability.clock);
    const remaining = operation.deadline - attemptStarted;
    if (remaining <= 0) fail('acquisition_deadline_exceeded');
    const timeout = Math.min(operation.request_timeout_ms, remaining);
    const attemptDeadline = attemptStarted + timeout;
    const timeoutCode = remaining <= operation.request_timeout_ms ? 'acquisition_deadline_exceeded' : 'provider_timeout';
    const controller = new AbortController();
    let deadlineExpired = false;
    let transportSettled = false;
    let transportSettledAt = null;
    let timeoutAccounted = false;
    const accountTimeout = () => {
      if (!timeoutAccounted) {
        timeoutAccounted = true;
        capability.telemetry.onTimeoutAttemptV1();
      }
    };
    const abortTimer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, Math.max(1, Math.ceil(timeout)));
    let response = null;
    let retryable = false;
    try {
      if (attempt > 1) capability.telemetry.onRetryAttemptV1();
      let pending;
      try { pending = capability.request({ ...baseRequest, timeout_ms: timeout, signal: controller.signal }); }
      catch (error) { transportSettled = true; throw error; }
      const observed = Promise.resolve(pending).then(
        value => ({ status: 'fulfilled', value }),
        error => ({ status: 'rejected', error }),
      );
      const outcome = await boundedAwait(observed, timeout, timeoutCode);
      transportSettled = true;
      transportSettledAt = now(capability.clock);
      if (outcome.status === 'rejected') throw outcome.error;
      const value = outcome.value;
      if (deadlineExpired || controller.signal.aborted || transportSettledAt === null || transportSettledAt >= attemptDeadline) {
        fail(timeoutCode);
      }
      response = responseEnvelope(value);
    } catch (error) {
      const code = thrownCode(error);
      if (code === 'invalid_json') fail('malformed_provider_response', 'invalid_json');
      const timeoutThrown = code === 'request_timeout' || code === 'provider_timeout' || code === 'ETIMEDOUT';
      if (timeoutThrown && !transportSettled) fail('provider_retry_exhausted');
      const terminatedByEffectiveTimeout = transportSettled && (timeoutThrown || (deadlineExpired && controller.signal.aborted));
      if (terminatedByEffectiveTimeout) { accountTimeout(); retryable = true; }
      else if (timeoutThrown || code === 'transient_transport') retryable = true;
      else if (code !== null) fail(code);
      else fail('provider_transient_failure');
    } finally { clearTimeout(abortTimer); }
    if (now(capability.clock) >= operation.deadline) fail('acquisition_deadline_exceeded');
    if (response !== null) {
      if (response.status >= 200 && response.status <= 299) return response.data;
      if (response.status === 400) fail('provider_request_invalid');
      if (response.status === 401 || response.status === 403) fail('provider_auth_failed');
      retryable = response.status === 429 || response.status >= 500;
      if (!retryable) fail('provider_request_invalid');
    }
    if (!retryable) fail('provider_transient_failure');
    if (attempt === operation.max_attempts_per_operation) fail('provider_retry_exhausted');
    const delay = retryDelay(attempt, capability.random);
    if (now(capability.clock) + delay >= operation.deadline) fail('acquisition_deadline_exceeded');
    const sleepRemaining = operation.deadline - now(capability.clock);
    const sleepController = new AbortController();
    const sleepTimer = setTimeout(() => sleepController.abort(), Math.max(1, Math.ceil(sleepRemaining)));
    try {
      await boundedAwait(capability.sleep(delay, sleepController.signal), sleepRemaining, 'acquisition_deadline_exceeded');
    } catch (error) {
      if (sleepController.signal.aborted || now(capability.clock) >= operation.deadline) fail('acquisition_deadline_exceeded');
      if (thrownCode(error) === 'acquisition_deadline_exceeded') throw error;
      fail('provider_transient_failure');
    } finally { clearTimeout(sleepTimer); }
    if (now(capability.clock) >= operation.deadline) fail('acquisition_deadline_exceeded');
  }
  fail('provider_retry_exhausted');
}

function rpc(method, params) { return { jsonrpc: '2.0', id: RPC_ID, method, params }; }
function post(body) { return { method: 'POST', url: RPC_URL, query: {}, headers: { 'content-type': 'application/json' }, body }; }
function rpcResultV2(value) {
  const detached = detachProviderNeutralValueV1(value);
  if (detached === null || typeof detached !== 'object' || Array.isArray(detached)
      || Object.keys(detached).length !== 3
      || !Object.hasOwn(detached, 'jsonrpc') || !Object.hasOwn(detached, 'id') || !Object.hasOwn(detached, 'result')) {
    fail('malformed_provider_response', 'rpc_envelope_invalid');
  }
  const envelope = detached;
  if (envelope.jsonrpc !== '2.0' || envelope.id !== RPC_ID) fail('malformed_provider_response', 'rpc_envelope_invalid');
  return envelope.result;
}
function asV1Envelope(result) { return { jsonrpc: '2.0', id: 'wallet-acquisition-v1', result }; }
function isSafeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function validateSlotInput(value) {
  const input = exactObject(value, ['slot']);
  if (!isSafeNonnegativeInteger(input.slot)) fail('provider_request_invalid');
  return input;
}
function validateSignaturePageInput(value) {
  const input = exactObject(value, ['wallet','before','limit','commitment']);
  if (!isSolanaPublicKeyV1(input.wallet) || (input.before !== null && !isSolanaSignatureV1(input.before))
      || input.limit !== PAGE_SIZE_V1 || input.commitment !== 'finalized') fail('provider_request_invalid');
  return input;
}
function validateFullPageInput(value) {
  const input = exactObject(value, FULL_PAGE_INPUT_FIELDS);
  if (!isSolanaPublicKeyV1(input.wallet)
      || (input.pagination_token !== null && (typeof input.pagination_token !== 'string'
        || input.pagination_token.length === 0 || input.pagination_token.length > MAX_PAGINATION_TOKEN_LENGTH))
      || input.limit !== PAGE_SIZE_V1 || input.commitment !== 'finalized'
      || !isSafeNonnegativeInteger(input.anchor_slot)
      || input.transaction_details !== 'full' || input.sort_order !== 'desc' || input.encoding !== 'json'
      || input.max_supported_transaction_version !== 0 || input.token_account_scope !== 'none' || input.status !== 'any') {
    fail('provider_request_invalid');
  }
  return input;
}
function validateExactTransactionInput(value) {
  const input = exactObject(value, EXACT_TRANSACTION_INPUT_FIELDS);
  if (!isSolanaSignatureV1(input.signature) || input.commitment !== 'finalized'
      || input.encoding !== 'json' || input.max_supported_transaction_version !== 0) {
    fail('provider_request_invalid');
  }
  return input;
}
function paginationToken(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PAGINATION_TOKEN_LENGTH) {
    fail('malformed_provider_response', 'full_transaction_pagination_token_invalid');
  }
  return value;
}
function rawSignature(value) {
  try {
    const signature = value?.transaction?.signatures?.[0];
    if (!isSolanaSignatureV1(signature)) fail('malformed_provider_response', 'full_transaction_shape_invalid');
    return signature;
  } catch (error) {
    if (thrownCode(error) !== null) throw error;
    fail('malformed_provider_response', 'full_transaction_shape_invalid');
  }
}
function validateFullPage(value) {
  const result = rpcResultV2(value);
  if (result === null || typeof result !== 'object' || Array.isArray(result)) fail('malformed_provider_response', 'full_transaction_page_invalid');
  if (Object.keys(result).length !== 2 || !Object.hasOwn(result, 'data') || !Object.hasOwn(result, 'paginationToken')) {
    fail('malformed_provider_response', 'full_transaction_page_invalid');
  }
  const page = result;
  if (!Array.isArray(page.data) || page.data.length > PAGE_SIZE_V1) fail('malformed_provider_response', 'full_transaction_page_invalid');
  const token = paginationToken(page.paginationToken);
  const transactions = page.data.map(raw => validateHeliusFullTransactionV1(raw, rawSignature(raw)));
  return Object.freeze({ transactions: Object.freeze(transactions), pagination_token: token });
}

export function createHeliusFullTransactionPortV2(rawOptions) {
  const capability = capabilities(rawOptions);
  let operation = null;
  const context = () => {
    if (operation === null) fail('acquisition_capability_denied');
    return operation;
  };
  return createWalletHistoryPortV2({
    async getNetworkIdentityV1() {
      const result = rpcResultV2(await execute(capability, post(rpc('getGenesisHash', [])), context()));
      return validateHeliusRpcGenesisResponseV1(asV1Envelope(result));
    },
    async getFinalizedSlotV1() {
      const result = rpcResultV2(await execute(capability, post(rpc('getSlot', [{ commitment: 'finalized' }])), context()));
      return validateHeliusRpcSlotResponseV1(asV1Envelope(result));
    },
    async getFinalizedBlockV1(value) {
      const input = validateSlotInput(value);
      const result = rpcResultV2(await execute(capability, post(rpc('getBlock', [input.slot, {
        commitment: 'finalized', transactionDetails: 'none', rewards: false,
      }])), context()));
      return validateHeliusRpcBlockResponseV1(asV1Envelope(result), input.slot);
    },
    async getFinalizedWalletSignaturePageV1(value) {
      const input = validateSignaturePageInput(value);
      const config = { limit: PAGE_SIZE_V1, commitment: 'finalized' };
      if (input.before !== null) config.before = input.before;
      const result = rpcResultV2(await execute(capability, post(rpc('getSignaturesForAddress', [input.wallet, config])), context()));
      return validateHeliusRpcSignaturePageResponseV1(asV1Envelope(result));
    },
    async getFinalizedFullTransactionPageV1(value) {
      const input = validateFullPageInput(value);
      const current = context();
      const config = {
        transactionDetails: 'full',
        sortOrder: 'desc',
        limit: PAGE_SIZE_V1,
        commitment: 'finalized',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
        minContextSlot: input.anchor_slot,
        filters: { status: 'any', tokenAccounts: 'none', slot: { lte: input.anchor_slot } },
      };
      if (input.pagination_token !== null) config.paginationToken = input.pagination_token;
      const body = await execute(capability, post(rpc('getTransactionsForAddress', [input.wallet, config])), current);
      return validateFullPage(body);
    },
    async getFinalizedTransactionV1(value) {
      const input = validateExactTransactionInput(value);
      const current = context();
      if (current.exactFallbackCalls >= current.max_exact_fallback_transactions) fail('acquisition_capped');
      current.exactFallbackCalls += 1;
      const result = rpcResultV2(await execute(capability, post(rpc('getTransaction', [input.signature, {
        commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0,
      }])), current));
      return result === null ? null : validateHeliusFullTransactionV1(result, input.signature);
    },
  }, {
    beginAcquisitionV2(budgets) {
      operation = beginOperation(capability, budgets);
    },
  });
}
