#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';

import {
  BoundedAcquisitionError,
  acquireNormalizedSolanaSpotEventsV1,
} from './acquisition-contract.mjs';
import { createHeliusEnhancedTransactionsAcquisitionAdapter } from './helius-enhanced-transactions-adapter.mjs';

const WALLET = '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni';
const TARGET = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BUY = '2ArLuJC2JEuWiavk1jYxLQ2E4xhq63BbeDV2kCWPcZ9zZNc4XyugUEFEryKrYfqcWnxkUvyacRmj2YNTfZGq17yV';
const SELL = '5YCdUYkJVx3kkZUpvz4ygs6QT8GZtYtru4kGkur3LJ8yrMmW2XJ8qXtgjspMpJqqyQA6WPDQxd4BcTpNNSr3Dctk';

function request(overrides = {}) {
  return {
    wallet: WALLET,
    target: { token_mint: TARGET, receipt_type: 'closed_position', segment_index: 0 },
    bounds: {
      before_signature: null,
      oldest_allowed_timestamp: 1781900000,
      newest_allowed_timestamp: 1782070000,
      max_pages: 4,
      max_transactions: 300,
      request_timeout_ms: 1000,
      overall_timeout_ms: 10000,
      max_attempts_per_page: 3,
    },
    fetch_profile: 'receipt_scoped_transaction_selection_v1',
    normalization_profile: 'artifact_solana_spot_normalization_v1',
    ...overrides,
  };
}

function raw(amount, decimals = 6) {
  return { tokenAmount: String(Math.round(amount * (10 ** decimals))), decimals };
}

function swap({ signature, timestamp, inputMint, inputAmount, outputMint, outputAmount, source = 'JUPITER' }) {
  return {
    signature,
    timestamp,
    type: 'SWAP',
    source,
    feePayer: WALLET,
    events: {
      swap: {
        tokenInputs: [{ userAccount: WALLET, mint: inputMint, rawTokenAmount: raw(inputAmount) }],
        tokenOutputs: [{ userAccount: WALLET, mint: outputMint, rawTokenAmount: raw(outputAmount) }],
      },
    },
    tokenTransfers: [],
  };
}

function irrelevant(signature, timestamp) {
  return { signature, timestamp, type: 'TRANSFER', source: 'SYSTEM_PROGRAM', feePayer: WALLET, events: {}, tokenTransfers: [] };
}

const buy = () => swap({ signature: BUY, timestamp: 1781904268, inputMint: QUOTE, inputAmount: 49728.694003, outputMint: TARGET, outputAmount: 265951.319268 });
const sell = () => swap({ signature: SELL, timestamp: 1782068814, inputMint: TARGET, inputAmount: 265951.319268, outputMint: QUOTE, outputAmount: 58016.53285 });

function harness(pages, options = {}) {
  let calls = 0;
  let now = 0;
  const seen = [];
  const httpClient = {
    async request(value) {
      seen.push(structuredClone(value));
      const response = pages[Math.min(calls, pages.length - 1)];
      calls += 1;
      if (typeof response === 'function') return response({ calls, value, advance: ms => { now += ms; } });
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
  };
  const adapter = createHeliusEnhancedTransactionsAcquisitionAdapter({
    httpClient,
    apiKeyProvider: options.apiKeyProvider ?? (() => 'super-secret-key'),
    sleep: async ms => { now += ms; },
    clock: () => now,
    random: () => 0,
  });
  return { adapter, calls: () => calls, seen };
}

async function expectCode(promise, code, forbidden = 'super-secret-key') {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BoundedAcquisitionError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.equal(inspect(error, { depth: 10 }).includes(forbidden), false);
    return true;
  });
}

test('provider-neutral boundary rejects malformed requests and denied capabilities', async () => {
  const validPort = { acquireNormalizedSolanaSpotEventsV1: async () => ({}) };
  for (const bad of [
    { ...request(), wallet: 'not-a-solana-wallet' },
    { ...request(), extra: true },
    { ...request(), target: { ...request().target, receipt_type: 'open_snapshot' } },
    { ...request(), target: { ...request().target, segment_index: 1.5 } },
    { ...request(), bounds: { ...request().bounds, oldest_allowed_timestamp: 20, newest_allowed_timestamp: 10 } },
    { ...request(), bounds: { ...request().bounds, max_pages: 0 } },
    { ...request(), bounds: { ...request().bounds, request_timeout_ms: 10000 } },
    { ...request(), fetch_profile: 'changed' },
    { ...request(), normalization_profile: 'changed' },
  ]) await expectCode(acquireNormalizedSolanaSpotEventsV1(bad, { acquisitionPort: validPort }), 'invalid_acquisition_request');
  await expectCode(acquireNormalizedSolanaSpotEventsV1(request(), {}), 'acquisition_capability_denied');
  const accessor = { ...request() };
  Object.defineProperty(accessor, 'wallet', { enumerable: true, get() { throw new Error('executed'); } });
  await expectCode(acquireNormalizedSolanaSpotEventsV1(accessor, { acquisitionPort: validPort }), 'invalid_acquisition_request');
  const symbolRequest = request();
  symbolRequest[Symbol('hidden')] = true;
  await expectCode(acquireNormalizedSolanaSpotEventsV1(symbolRequest, { acquisitionPort: validPort }), 'invalid_acquisition_request');
  const customRequest = Object.assign(Object.create({ inherited: true }), request());
  await expectCode(acquireNormalizedSolanaSpotEventsV1(customRequest, { acquisitionPort: validPort }), 'invalid_acquisition_request');
  await expectCode(acquireNormalizedSolanaSpotEventsV1(request(), {
    acquisitionPort: {
      acquireNormalizedSolanaSpotEventsV1: async () => {
        throw new BoundedAcquisitionError('provider_auth_failed', 'leak super-secret-key /private/keyfile');
      },
    },
  }), 'provider_auth_failed');
});

test('one short terminal page proves exhaustion and returns the exact closed result schema', async () => {
  const { adapter } = harness([{ status: 200, data: [sell(), buy()] }]);
  const result = await acquireNormalizedSolanaSpotEventsV1(request(), { acquisitionPort: adapter });
  assert.deepEqual(Object.keys(result), ['normalizedEvents', 'inputStatus', 'acquisitionSummary']);
  assert.deepEqual(result.inputStatus, {
    acquisition_complete: true,
    normalization_complete: true,
    pagination_complete: true,
    truncated: false,
    capped: false,
    partial: false,
    provider_uncertain: false,
  });
  assert.deepEqual(result.acquisitionSummary, {
    pages_read: 1,
    transactions_read: 2,
    normalized_event_count: 2,
    oldest_observed_timestamp: 1781904268,
    newest_observed_timestamp: 1782068814,
    pagination_terminal_reason: 'provider_exhaustion',
    retry_count: 0,
    timeout_count: 0,
  });
  assert.deepEqual(result.normalizedEvents, [
    { wallet: WALLET, timestamp: 1781904268, tx_hash: BUY, source: 'JUPITER', token_in_mint: QUOTE, token_in_amount: 49728.694003, token_in_decimals: 6, token_out_mint: TARGET, token_out_amount: 265951.319268, token_out_decimals: 6, extraction_method: 'helius_enhanced_transaction_swap_v1', raw_index: 0 },
    { wallet: WALLET, timestamp: 1782068814, tx_hash: SELL, source: 'JUPITER', token_in_mint: TARGET, token_in_amount: 265951.319268, token_in_decimals: 6, token_out_mint: QUOTE, token_out_amount: 58016.53285, token_out_decimals: 6, extraction_method: 'helius_enhanced_transaction_swap_v1', raw_index: 1 },
  ]);
  assert.equal(inspect(result, { depth: 10 }).includes('super-secret-key'), false);
});

test('provider-neutral result validation rejects out-of-window, unrelated, or non-dense events', async () => {
  const base = await harness([{ status: 200, data: [sell(), buy()] }]).adapter.acquireNormalizedSolanaSpotEventsV1(request());
  const cases = [
    events => { events[0].timestamp = request().bounds.oldest_allowed_timestamp - 1; },
    events => { events[0].token_in_mint = 'So11111111111111111111111111111111111111112'; events[0].token_out_mint = QUOTE; },
    events => { events[0].raw_index = 9; },
    events => { events[0].extraction_method = 'forged_extraction'; },
  ];
  for (const mutate of cases) {
    const forged = structuredClone(base);
    mutate(forged.normalizedEvents);
    await expectCode(acquireNormalizedSolanaSpotEventsV1(request(), {
      acquisitionPort: { acquireNormalizedSolanaSpotEventsV1: async () => forged },
    }), 'normalization_failed');
  }
  const contradictory = structuredClone(base);
  contradictory.acquisitionSummary.pages_read = 0;
  await expectCode(acquireNormalizedSolanaSpotEventsV1(request(), {
    acquisitionPort: { acquireNormalizedSolanaSpotEventsV1: async () => contradictory },
  }), 'acquisition_incomplete');
  const permuted = structuredClone(base);
  permuted.normalizedEvents.reverse();
  permuted.normalizedEvents[0].timestamp = 1782000000;
  permuted.normalizedEvents[0].raw_index = 0;
  permuted.normalizedEvents[1].timestamp = 1782000000;
  permuted.normalizedEvents[1].raw_index = 1;
  permuted.acquisitionSummary.oldest_observed_timestamp = 1782000000;
  permuted.acquisitionSummary.newest_observed_timestamp = 1782000000;
  await expectCode(acquireNormalizedSolanaSpotEventsV1(request(), {
    acquisitionPort: { acquireNormalizedSolanaSpotEventsV1: async () => permuted },
  }), 'normalization_failed');
});

test('normalized event order is invariant to provider page chunking and unrelated history', async () => {
  const direct = await harness([{ status: 200, data: [sell(), buy()] }]).adapter.acquireNormalizedSolanaSpotEventsV1(request());
  const full = [
    sell(),
    ...Array.from({ length: 98 }, (_, index) => irrelevant(`chunk-${index}`, 1782068000 - index)),
    buy(),
  ];
  const chunked = await harness([
    { status: 200, data: full },
    { status: 200, data: [irrelevant('chunk-terminal', 1781900001)] },
  ]).adapter.acquireNormalizedSolanaSpotEventsV1(request());
  assert.deepEqual(chunked.normalizedEvents, direct.normalizedEvents);
});

test('full pages continue with validated final signature and a short page terminates', async () => {
  const first = Array.from({ length: 100 }, (_, index) => irrelevant(`page-1-${index}`, 2000 - index));
  const second = [irrelevant('terminal', 1800)];
  const { adapter, seen } = harness([{ status: 200, data: first }, { status: 200, data: second }]);
  const result = await adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, oldest_allowed_timestamp: 1000 } }));
  assert.equal(result.acquisitionSummary.pages_read, 2);
  assert.equal(result.acquisitionSummary.transactions_read, 101);
  assert.equal(seen[1].query.before, 'page-1-99');
});

test('historical bound proves completion on a full page', async () => {
  const page = Array.from({ length: 100 }, (_, index) => irrelevant(`history-${index}`, 2000 - index));
  const { adapter } = harness([{ status: 200, data: page }]);
  const result = await adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, oldest_allowed_timestamp: 1950 } }));
  assert.equal(result.acquisitionSummary.pagination_terminal_reason, 'historical_bound_reached');
  assert.equal(result.inputStatus.pagination_complete, true);
});

test('pagination integrity failures fail closed', async () => {
  const full = Array.from({ length: 100 }, (_, index) => irrelevant(`same-${index}`, 2000 - index));
  const repeated = [
    ...Array.from({ length: 99 }, (_, index) => irrelevant(`next-${index}`, 1901)),
    irrelevant('same-99', 1901),
  ];
  await expectCode(harness([{ status: 200, data: full }, { status: 200, data: repeated }]).adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, oldest_allowed_timestamp: 1000 } })), 'pagination_cursor_repeated');
  const newer = [irrelevant('newer', 3000)];
  await expectCode(harness([{ status: 200, data: full }, { status: 200, data: newer }]).adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, oldest_allowed_timestamp: 1000 } })), 'pagination_order_invalid');
  const disagree = [
    ...Array.from({ length: 99 }, (_, index) => irrelevant(`different-${index}`, 1900 - index)),
    { ...irrelevant('same-99', 1800), type: 'SWAP' },
  ];
  await expectCode(harness([{ status: 200, data: full }, { status: 200, data: disagree }]).adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, oldest_allowed_timestamp: 1000 } })), 'pagination_order_invalid');
  await expectCode(harness([{ status: 200, data: full }, { status: 200, data: [] }]).adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, oldest_allowed_timestamp: 1000 } })), 'pagination_terminal_ambiguous');
  const initialCursor = 'initial-cursor';
  await expectCode(harness([{ status: 200, data: [irrelevant(initialCursor, 1782000000)] }]).adapter.acquireNormalizedSolanaSpotEventsV1(request({
    bounds: { ...request().bounds, before_signature: initialCursor },
  })), 'pagination_cursor_repeated');
});

test('malformed successful provider pages are never retried', async () => {
  for (const data of [{ transactions: [] }, '<html>failure</html>', [null], [irrelevant('a', 1), irrelevant('b', 2)]]) {
    const h = harness([{ status: 200, data }]);
    await expectCode(h.adapter.acquireNormalizedSolanaSpotEventsV1(request()), data instanceof Array && data.length === 2 ? 'pagination_order_invalid' : 'malformed_provider_page');
    assert.equal(h.calls(), 1);
  }
  const invalidJson = new Error('secret URL https://example.test/?api-key=super-secret-key');
  invalidJson.code = 'invalid_json';
  const h = harness([invalidJson]);
  await expectCode(h.adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'malformed_provider_page');
  assert.equal(h.calls(), 1);
  let getterCalls = 0;
  const accessorTransaction = irrelevant('accessor', 1);
  Object.defineProperty(accessorTransaction, 'type', { enumerable: true, get() { getterCalls += 1; return 'TRANSFER'; } });
  await expectCode(harness([() => ({ status: 200, data: [accessorTransaction] })]).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'malformed_provider_page');
  assert.equal(getterCalls, 0);
  const symbolTransaction = irrelevant('symbol', 1);
  symbolTransaction[Symbol('hidden')] = true;
  await expectCode(harness([() => ({ status: 200, data: [symbolTransaction] })]).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'malformed_provider_page');
  const customTransaction = Object.assign(Object.create({ inherited: true }), irrelevant('custom', 1));
  await expectCode(harness([() => ({ status: 200, data: [customTransaction] })]).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'malformed_provider_page');
  const hostileField = irrelevant('hostile-field', 1);
  Object.defineProperty(hostileField, 'api-key=super-secret-key /private/keyfile', { value: true });
  await expectCode(harness([() => ({ status: 200, data: [hostileField] })]).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'malformed_provider_page');
  const hostileResponse = new Proxy({}, { getPrototypeOf() { throw new Error('leak super-secret-key /private/keyfile'); } });
  await expectCode(harness([() => hostileResponse]).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'provider_transient_failure');
});

test('hostile adapter capability objects cannot leak introspection errors', async () => {
  const hostileClient = new Proxy({}, { getPrototypeOf() { throw new Error('leak super-secret-key /private/keyfile'); } });
  await expectCode(Promise.resolve().then(() => createHeliusEnhancedTransactionsAcquisitionAdapter({
    httpClient: hostileClient,
    apiKeyProvider: () => 'unused', sleep: async () => {}, clock: () => 0, random: () => 0,
  })), 'acquisition_capability_denied');
});

test('page and transaction caps are not successful completion', async () => {
  const full = Array.from({ length: 100 }, (_, index) => irrelevant(`cap-${index}`, 2000 - index));
  await expectCode(harness([{ status: 200, data: full }]).adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, max_pages: 1, oldest_allowed_timestamp: 1000 } })), 'acquisition_capped');
  await expectCode(harness([{ status: 200, data: [sell(), buy()] }]).adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, max_transactions: 1 } })), 'acquisition_capped');
});

test('429, 5xx, timeout, and classified transport failures retry with the same logical request', async () => {
  const timeout = new Error('timed out with super-secret-key'); timeout.code = 'request_timeout';
  const transport = new Error('socket failed'); transport.code = 'transient_transport';
  const h = harness([timeout, { status: 429, data: null }, { status: 503, data: null }, transport, { status: 200, data: [sell(), buy()] }]);
  const result = await h.adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, max_attempts_per_page: 5 } }));
  assert.equal(result.acquisitionSummary.retry_count, 4);
  assert.equal(result.acquisitionSummary.timeout_count, 1);
  assert.equal(new Set(h.seen.map(call => JSON.stringify(call.query))).size, 1);
});

test('400, 401, and 403 do not retry; credentials and hostile errors are sanitized', async () => {
  for (const [status, code] of [[400, 'provider_request_invalid'], [401, 'provider_auth_failed'], [403, 'provider_auth_failed']]) {
    const h = harness([{ status, data: { url: '?api-key=super-secret-key' } }]);
    await expectCode(h.adapter.acquireNormalizedSolanaSpotEventsV1(request()), code);
    assert.equal(h.calls(), 1);
  }
  const hostile = () => { throw new Error('leak super-secret-key /private/keyfile'); };
  await expectCode(harness([], { apiKeyProvider: hostile }).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'api_key_unavailable');
  await expectCode(harness([], { apiKeyProvider: () => '' }).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'api_key_unavailable');
  await expectCode(harness([], { apiKeyProvider: async () => 'super-secret-key' }).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'api_key_unavailable');
  const forged = new BoundedAcquisitionError('provider_auth_failed', 'leak super-secret-key /private/keyfile');
  await expectCode(harness([forged]).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'provider_transient_failure');
});

test('retry exhaustion, timeouts, and overall deadline fail incomplete without merging attempts', async () => {
  const timeout = new Error('timeout'); timeout.code = 'request_timeout';
  const h = harness([timeout]);
  await expectCode(h.adapter.acquireNormalizedSolanaSpotEventsV1(request({ bounds: { ...request().bounds, max_attempts_per_page: 2 } })), 'provider_retry_exhausted');
  assert.equal(h.calls(), 2);
  const deadline = harness([({ advance }) => { advance(10001); throw timeout; }]);
  await expectCode(deadline.adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'acquisition_deadline_exceeded');
  let keyNow = 0;
  let keyHttpCalls = 0;
  const keyDeadlineAdapter = createHeliusEnhancedTransactionsAcquisitionAdapter({
    httpClient: { async request() { keyHttpCalls += 1; return { status: 200, data: [] }; } },
    apiKeyProvider() { keyNow = 10001; return 'super-secret-key'; },
    sleep: async () => {}, clock: () => keyNow, random: () => 0,
  });
  await expectCode(keyDeadlineAdapter.acquireNormalizedSolanaSpotEventsV1(request()), 'acquisition_deadline_exceeded');
  assert.equal(keyHttpCalls, 0);
  const uncertain = new Error('uncertain'); uncertain.code = 'provider_uncertain';
  await expectCode(harness([uncertain]).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'acquisition_incomplete');
});

test('target-affecting ambiguity fails while documented irrelevant activity is ignored', async () => {
  const ambiguous = sell();
  ambiguous.events.swap.tokenOutputs.push({ userAccount: WALLET, mint: QUOTE, rawTokenAmount: raw(1) });
  await expectCode(harness([{ status: 200, data: [ambiguous] }]).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'normalization_ambiguous');
  const unsupported = irrelevant('target-transfer', 1782000000);
  unsupported.tokenTransfers.push({ fromUserAccount: WALLET, toUserAccount: 'other', mint: TARGET, tokenAmount: 1 });
  await expectCode(harness([{ status: 200, data: [unsupported] }]).adapter.acquireNormalizedSolanaSpotEventsV1(request()), 'unsupported_target_activity');
  const fixture = [sell(), irrelevant('unrelated', 1782000000), buy()];
  const before = structuredClone(fixture);
  const result = await harness([{ status: 200, data: fixture }]).adapter.acquireNormalizedSolanaSpotEventsV1(request());
  assert.equal(result.normalizedEvents.length, 2);
  assert.deepEqual(fixture, before);
});

test('global fetch is never used', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('global fetch forbidden'); };
  try {
    await harness([{ status: 200, data: [sell(), buy()] }]).adapter.acquireNormalizedSolanaSpotEventsV1(request());
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
