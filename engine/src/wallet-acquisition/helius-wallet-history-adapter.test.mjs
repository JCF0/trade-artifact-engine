#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';

import { createHeliusWalletHistoryPortV1 } from './helius-wallet-history-adapter.mjs';
import { beginWalletHistoryAcquisitionV1 } from './provider-port.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from './request-contract.mjs';
import { enhanced, providerSignature, request, WALLET } from './fixtures/slice4-fixtures.mjs';

function rpc(result) { return { jsonrpc: '2.0', id: 'wallet-acquisition-v1', result }; }
function harness(responses, options = {}) {
  let calls = 0; let now = 0; const seen = [];
  const port = createHeliusWalletHistoryPortV1({
    httpClient: { async request(input) { seen.push(structuredClone(input)); const item = responses[Math.min(calls++, responses.length - 1)]; return typeof item === 'function' ? item({ input, advance: ms => { now += ms; } }) : item instanceof Error ? Promise.reject(item) : structuredClone(item); } },
    apiKeyProvider: options.apiKeyProvider ?? (() => 'super-secret-key'),
    sleep: options.sleep ?? (async ms => { now += ms; }), clock: () => now, random: () => 0,
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
  });
  return { port, seen, calls: () => calls };
}
async function code(promise, expected) {
  await assert.rejects(promise, error => error?.name === 'WalletAcquisitionError' && error.code === expected
    && error.stack === undefined && error.cause === undefined && !inspect(error, { depth: 10 }).includes('super-secret-key'));
}

test('implements finalized RPC operations through the injected client only', async () => {
  const h = harness([
    { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) }, { status: 200, data: rpc(100) },
    { status: 200, data: rpc({ blockTime: 200, blockhash: '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh' }) },
    { status: 200, data: rpc([{ signature: providerSignature('sig'), slot: 99, blockTime: 199, err: null, memo: null, confirmationStatus: 'finalized' }]) },
  ]);
  assert.equal((await h.port.getNetworkIdentityV1()).genesis_hash, SOLANA_MAINNET_GENESIS_HASH);
  assert.equal(await h.port.getFinalizedSlotV1(), 100);
  assert.equal((await h.port.getFinalizedBlockV1({ slot: 100 })).slot, 100);
  assert.deepEqual(await h.port.getFinalizedWalletSignaturePageV1({ wallet: WALLET, before: null, limit: 100, commitment: 'finalized' }), [{ signature: providerSignature('sig'), slot: 99, block_time: 199, execution_state: 'succeeded' }]);
  assert.deepEqual(h.seen.map(x => x.body.method), ['getGenesisHash','getSlot','getBlock','getSignaturesForAddress']);
  assert.equal(h.seen[3].body.params[1].limit, 100);
  assert.equal(Object.hasOwn(h.seen[3].body.params[1], 'before'), false);
});

test('established Enhanced operation uses exact reconciliation against local address-history contract', async () => {
  const a = enhanced('a'); const b = enhanced('b', { slot: 999, timestamp: 1780604799 });
  const h = harness([{ status: 200, data: [a, b] }]);
  const result = await h.port.getEnhancedTransactionsBySignatureV1({ wallet: WALLET, signatures: [b.signature,a.signature] });
  assert.deepEqual(result.map(x => x.signature), [b.signature,a.signature]);
  assert.equal(result[0].spot_evidence_version, 'solana_spot_evidence_v1');
  assert.equal(Object.hasOwn(result[0], 'tokenTransfers'), false);
  assert.equal(h.seen[0].method, 'GET');
  assert.equal(h.seen[0].url, `https://api.helius.xyz/v0/addresses/${WALLET}/transactions`);
  assert.deepEqual(h.seen[0].query, { 'api-key': 'super-secret-key', limit: 100 });
  await code(harness([{ status: 200, data: [a] }]).port.getEnhancedTransactionsBySignatureV1({ wallet: WALLET, signatures: [a.signature,providerSignature('missing')] }), 'malformed_provider_response');
  const duplicate = harness([{ status: 200, data: [a, a] }]);
  await code(duplicate.port.getEnhancedTransactionsBySignatureV1({ wallet: WALLET, signatures: [a.signature] }), 'malformed_provider_response');
});

test('Enhanced address-history pagination continues identically until all signatures reconcile', async () => {
  const filler = Array.from({ length: 99 }, (_, i) => enhanced(`f-${i}`, { slot: 2000 - i, timestamp: 2000 - i, type: 'TRANSFER', program: null, transfers: false }));
  const wanted = enhanced('wanted', { slot: 1800, timestamp: 1800 });
  const first = [...filler, enhanced('cursor', { slot: 1900, timestamp: 1900, type: 'TRANSFER', program: null, transfers: false })];
  const h = harness([{ status: 200, data: first }, { status: 200, data: [wanted] }]);
  assert.equal((await h.port.getEnhancedTransactionsBySignatureV1({ wallet: WALLET, signatures: [wanted.signature] }))[0].signature, wanted.signature);
  assert.equal(h.seen[1].query.before, providerSignature('cursor'));
});

test('retries only timeout, transient transport, 429, and 5xx with identical method arguments', async () => {
  const timeout = new Error('hostile'); timeout.code = 'request_timeout';
  const transport = new Error('hostile'); transport.code = 'transient_transport';
  const h = harness([timeout, { status: 429, data: null }, { status: 503, data: null }, transport, { status: 200, data: rpc(7) }]);
  assert.equal(await h.port.getFinalizedSlotV1(), 7);
  assert.equal(h.calls(), 5);
  assert.equal(new Set(h.seen.map(x => JSON.stringify(x))).size, 1);
  for (const [status, expected] of [[400,'provider_request_invalid'],[401,'provider_auth_failed'],[403,'provider_auth_failed']]) {
    const one = harness([{ status, data: { hostile: 'super-secret-key' } }]);
    await code(one.port.getFinalizedSlotV1(), expected); assert.equal(one.calls(), 1);
  }
  const malformed = harness([{ status: 200, data: rpc('bad-slot') }]);
  await code(malformed.port.getFinalizedSlotV1(), 'malformed_provider_response'); assert.equal(malformed.calls(), 1);
});

test('retry and timeout telemetry counts only attempts actually begun and actually timed out', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'request_timeout' });
  function scenario(responses, maxAttempts = responses.length) {
    const counts = { retry: 0, timeout: 0 };
    const h = harness(responses, { telemetry: {
      onRetryAttemptV1() { counts.retry += 1; },
      onTimeoutAttemptV1() { counts.timeout += 1; },
    } });
    beginWalletHistoryAcquisitionV1(h.port, { ...request().budgets, max_attempts_per_operation: maxAttempts });
    return { h, counts };
  }
  let value = scenario([{ status: 200, data: rpc(1) }], 1);
  assert.equal(await value.h.port.getFinalizedSlotV1(), 1);
  assert.deepEqual(value.counts, { retry: 0, timeout: 0 });
  value = scenario([{ status: 429, data: null }, { status: 200, data: rpc(2) }], 2);
  assert.equal(await value.h.port.getFinalizedSlotV1(), 2);
  assert.deepEqual(value.counts, { retry: 1, timeout: 0 });
  value = scenario([{ status: 429, data: null }], 1);
  await code(value.h.port.getFinalizedSlotV1(), 'provider_retry_exhausted');
  assert.deepEqual(value.counts, { retry: 0, timeout: 0 });
  value = scenario([{ status: 503, data: null }, { status: 502, data: null }, { status: 200, data: rpc(3) }], 3);
  assert.equal(await value.h.port.getFinalizedSlotV1(), 3);
  assert.deepEqual(value.counts, { retry: 2, timeout: 0 });
  value = scenario([timeout], 1);
  await code(value.h.port.getFinalizedSlotV1(), 'provider_retry_exhausted');
  assert.deepEqual(value.counts, { retry: 0, timeout: 1 });
  value = scenario([timeout, { status: 200, data: rpc(4) }], 2);
  assert.equal(await value.h.port.getFinalizedSlotV1(), 4);
  assert.deepEqual(value.counts, { retry: 1, timeout: 1 });
});

test('abort-respecting transport increments timeout telemetry exactly once', async () => {
  const counts = { retry: 0, timeout: 0 };
  const port = createHeliusWalletHistoryPortV1({
    httpClient: { request(input) {
      return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => {
        reject(Object.freeze({ code: 'request_timeout' }));
      }, { once: true }));
    } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {}, clock: () => Date.now(), random: () => 0,
    telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
  });
  beginWalletHistoryAcquisitionV1(port, { ...request().budgets, max_attempts_per_operation: 1, request_timeout_ms: 10, overall_timeout_ms: 100 });
  await code(port.getFinalizedSlotV1(), 'provider_retry_exhausted');
  assert.deepEqual(counts, { retry: 0, timeout: 1 });
});

test('abort-ignoring transport fails closed without timeout accounting and discards late success', async () => {
  const counts = { retry: 0, timeout: 0 };
  let resolveTransport;
  const port = createHeliusWalletHistoryPortV1({
    httpClient: { request() { return new Promise(resolve => { resolveTransport = resolve; }); } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {}, clock: () => Date.now(), random: () => 0,
    telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
  });
  beginWalletHistoryAcquisitionV1(port, { ...request().budgets, max_attempts_per_operation: 1, request_timeout_ms: 10, overall_timeout_ms: 100 });
  await code(port.getFinalizedSlotV1(), 'provider_retry_exhausted');
  assert.deepEqual(counts, { retry: 0, timeout: 0 });
  resolveTransport({ status: 200, data: rpc(999) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(counts, { retry: 0, timeout: 0 });
});

test('transport success delivered from the effective-timeout abort callback fails closed without timeout accounting', async () => {
  const counts = { retry: 0, timeout: 0 };
  let aborted = false;
  const port = createHeliusWalletHistoryPortV1({
    httpClient: { request(input) {
      return new Promise(resolve => input.signal.addEventListener('abort', () => {
        aborted = true;
        resolve({ status: 200, data: rpc(999) });
      }, { once: true }));
    } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {}, clock: () => Date.now(), random: () => 0,
    telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
  });
  beginWalletHistoryAcquisitionV1(port, { ...request().budgets, max_attempts_per_operation: 1, request_timeout_ms: 10, overall_timeout_ms: 100 });
  await code(port.getFinalizedSlotV1(), 'provider_timeout');
  assert.equal(aborted, true);
  assert.deepEqual(counts, { retry: 0, timeout: 0 });
});

test('synchronous success after the request or remaining overall deadline fails closed', async () => {
  const requestLate = createHeliusWalletHistoryPortV1({
    httpClient: { request() {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      return { status: 200, data: rpc(777) };
    } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {}, clock: () => performance.now(), random: () => 0,
  });
  beginWalletHistoryAcquisitionV1(requestLate, { ...request().budgets, max_attempts_per_operation: 1, request_timeout_ms: 5, overall_timeout_ms: 100 });
  await code(requestLate.getFinalizedSlotV1(), 'provider_timeout');

  let now = 0;
  let overallCalls = 0;
  const overallLate = createHeliusWalletHistoryPortV1({
    httpClient: { request() { overallCalls += 1; now += 6; return { status: 200, data: rpc(888) }; } },
    apiKeyProvider: () => { now = 15; return 'super-secret-key'; }, sleep: async () => {}, clock: () => now, random: () => 0,
  });
  beginWalletHistoryAcquisitionV1(overallLate, { ...request().budgets, max_attempts_per_operation: 2, request_timeout_ms: 10, overall_timeout_ms: 20 });
  await code(overallLate.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
  assert.equal(overallCalls, 1);
});

test('monotonic settlement check accepts pre-deadline success and rejects post-deadline success before timers run', async () => {
  async function scenario(settledAt) {
    let now = 0;
    const counts = { retry: 0, timeout: 0 };
    const port = createHeliusWalletHistoryPortV1({
      httpClient: { request() { now = settledAt; return { status: 200, data: rpc(settledAt) }; } },
      apiKeyProvider: () => 'super-secret-key', sleep: async () => {}, clock: () => now, random: () => 0,
      telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
    });
    beginWalletHistoryAcquisitionV1(port, { ...request().budgets, max_attempts_per_operation: 1, request_timeout_ms: 10, overall_timeout_ms: 100 });
    return { port, counts };
  }
  const before = await scenario(9);
  assert.equal(await before.port.getFinalizedSlotV1(), 9);
  assert.deepEqual(before.counts, { retry: 0, timeout: 0 });
  const after = await scenario(11);
  await code(after.port.getFinalizedSlotV1(), 'provider_timeout');
  assert.deepEqual(after.counts, { retry: 0, timeout: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(after.counts, { retry: 0, timeout: 0 });
});

test('timer expiry, abort rejection, and attempted late settlement cannot double-count one timeout', async () => {
  const counts = { retry: 0, timeout: 0 };
  let attemptLateResolve = () => {};
  const port = createHeliusWalletHistoryPortV1({
    httpClient: { request(input) {
      return new Promise((resolve, reject) => {
        attemptLateResolve = () => resolve({ status: 200, data: rpc(999) });
        input.signal.addEventListener('abort', () => reject(Object.freeze({ code: 'request_timeout' })), { once: true });
      });
    } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {}, clock: () => Date.now(), random: () => 0,
    telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
  });
  beginWalletHistoryAcquisitionV1(port, { ...request().budgets, max_attempts_per_operation: 1, request_timeout_ms: 10, overall_timeout_ms: 100 });
  await code(port.getFinalizedSlotV1(), 'provider_retry_exhausted');
  attemptLateResolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(counts, { retry: 0, timeout: 1 });
});

test('retry sleep exhaustion does not fabricate a retry attempt', async () => {
  const counts = { retry: 0, timeout: 0 };
  const h = harness([{ status: 429, data: null }], {
    sleep: () => new Promise(() => {}),
    telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
  });
  beginWalletHistoryAcquisitionV1(h.port, { ...request().budgets, max_attempts_per_operation: 2, request_timeout_ms: 5, overall_timeout_ms: 20 });
  await code(h.port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
  assert.deepEqual(counts, { retry: 0, timeout: 0 });
  assert.equal(h.calls(), 1);
});

test('hidden acquisition controls enforce request-specific retry, request-timeout, and scan budgets', async () => {
  const oneAttempt = harness([{ status: 503, data: null }, { status: 200, data: rpc(7) }]);
  beginWalletHistoryAcquisitionV1(oneAttempt.port, { ...request().budgets, max_attempts_per_operation: 1 });
  await code(oneAttempt.port.getFinalizedSlotV1(), 'provider_retry_exhausted');
  assert.equal(oneAttempt.calls(), 1);

  const shortTimeout = harness([() => new Promise(() => {})]);
  beginWalletHistoryAcquisitionV1(shortTimeout.port, { ...request().budgets, max_attempts_per_operation: 1, request_timeout_ms: 5 });
  await code(shortTimeout.port.getFinalizedSlotV1(), 'provider_retry_exhausted');

  const full = Array.from({ length: 100 }, (_, index) => enhanced(`budget-${index}`, { slot: 2000 - index, timestamp: 2000 - index, type: 'TRANSFER', program: null, transfers: false }));
  const scan = harness([{ status: 200, data: full }, { status: 200, data: [] }]);
  beginWalletHistoryAcquisitionV1(scan.port, { ...request().budgets, max_pages: 1 });
  await code(scan.port.getEnhancedTransactionsBySignatureV1({ wallet: WALLET, signatures: [providerSignature('missing')] }), 'acquisition_capped');
  assert.equal(scan.calls(), 1);
});

test('retry exhaustion, deadline, key failures, and hostile errors are sanitized without partial data', async () => {
  const timeout = new Error('super-secret-key /root/key'); timeout.code = 'request_timeout';
  await code(harness([timeout]).port.getFinalizedSlotV1(), 'provider_retry_exhausted');
  await code(harness([({ advance }) => { advance(300001); throw timeout; }]).port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
  await code(harness([], { apiKeyProvider: () => { throw new Error('super-secret-key'); } }).port.getFinalizedSlotV1(), 'api_key_unavailable');
  await code(harness([], { apiKeyProvider: async () => 'super-secret-key' }).port.getFinalizedSlotV1(), 'api_key_unavailable');

  let keyCalls = 0;
  const first = Array.from({ length: 100 }, (_, i) => enhanced(`deadline-${i}`, { slot: 2000 - i, timestamp: 2000 - i, type: 'TRANSFER', program: null, transfers: false }));
  const acrossPages = harness([
    ({ advance }) => { advance(16); return { status: 200, data: first }; },
    ({ advance }) => { advance(5); return { status: 200, data: [] }; },
  ], { apiKeyProvider: () => { keyCalls += 1; return 'super-secret-key'; } });
  beginWalletHistoryAcquisitionV1(acrossPages.port, { ...request().budgets, request_timeout_ms: 17, overall_timeout_ms: 20 });
  await code(acrossPages.port.getEnhancedTransactionsBySignatureV1({ wallet: WALLET, signatures: [providerSignature('missing')] }), 'acquisition_deadline_exceeded');
  assert.equal(keyCalls, 1);

  keyCalls = 0;
  const acrossMethods = harness([
    ({ advance }) => { advance(16); return { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) }; },
    ({ advance }) => { advance(5); return { status: 200, data: rpc(1000) }; },
  ], { apiKeyProvider: () => { keyCalls += 1; return 'super-secret-key'; } });
  beginWalletHistoryAcquisitionV1(acrossMethods.port, { ...request().budgets, request_timeout_ms: 17, overall_timeout_ms: 20 });
  await acrossMethods.port.getNetworkIdentityV1();
  await code(acrossMethods.port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
  assert.equal(keyCalls, 1);

  const hangingRequest = harness([
    ({ advance }) => { advance(16); return { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) }; },
    () => new Promise(() => {}),
  ]);
  beginWalletHistoryAcquisitionV1(hangingRequest.port, { ...request().budgets, request_timeout_ms: 17, overall_timeout_ms: 20 });
  await hangingRequest.port.getNetworkIdentityV1();
  await code(hangingRequest.port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');

  let sleepAborted = false;
  const hangingSleep = harness([({ advance }) => {
    advance(15);
    return { status: 429, data: null };
  }], { sleep: (_milliseconds, signal) => new Promise(() => {
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener('abort', () => { sleepAborted = true; }, { once: true });
  }) });
  beginWalletHistoryAcquisitionV1(hangingSleep.port, { ...request().budgets, request_timeout_ms: 110, overall_timeout_ms: 120 });
  await code(hangingSleep.port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
  assert.equal(sleepAborted, true);
});

test('global fetch is untouched and import/operation has no ambient credential access', async () => {
  const prior = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('forbidden'); };
  try { assert.equal(await harness([{ status: 200, data: rpc(1) }]).port.getFinalizedSlotV1(), 1); assert.equal(calls, 0); }
  finally { globalThis.fetch = prior; }
});

test('effective transport timeout is the smaller request or acquisition-wide remaining budget', async () => {
  const requestBound = harness([({ input }) => {
    assert.equal(input.timeout_ms, 5);
    return { status: 200, data: rpc(1) };
  }]);
  beginWalletHistoryAcquisitionV1(requestBound.port, { ...request().budgets, request_timeout_ms: 5, overall_timeout_ms: 20 });
  assert.equal(await requestBound.port.getFinalizedSlotV1(), 1);

  const overallBound = harness([
    ({ advance }) => { advance(16); return { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) }; },
    ({ input }) => {
      assert.equal(input.timeout_ms, 4);
      return { status: 200, data: rpc(2) };
    },
  ]);
  beginWalletHistoryAcquisitionV1(overallBound.port, { ...request().budgets, request_timeout_ms: 17, overall_timeout_ms: 20 });
  await overallBound.port.getNetworkIdentityV1();
  assert.equal(await overallBound.port.getFinalizedSlotV1(), 2);
});

test('wall-clock rollback and forward jumps cannot alter monotonic acquisition deadlines', async () => {
  const originalDateNow = Date.now;
  let wallNow = 1_000_000;
  Date.now = () => wallNow;
  try {
    for (const jump of [-900_000, 9_000_000]) {
      const h = harness([
        ({ advance }) => { wallNow += jump; advance(16); return { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) }; },
        ({ input, advance }) => { assert.equal(input.timeout_ms, 4); advance(4); return { status: 200, data: rpc(2) }; },
      ]);
      beginWalletHistoryAcquisitionV1(h.port, { ...request().budgets, request_timeout_ms: 17, overall_timeout_ms: 20 });
      await h.port.getNetworkIdentityV1();
      await code(h.port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
      assert.equal(h.calls(), 2);
    }
  } finally {
    Date.now = originalDateNow;
  }
});

test('overall deadline aborts in-flight transport, discards late success, and starts no later attempt', async () => {
  let aborted = false;
  let calls = 0;
  const port = createHeliusWalletHistoryPortV1({
    httpClient: { request(input) {
      calls += 1;
      assert.ok(input.signal instanceof AbortSignal);
      input.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(resolve => setTimeout(() => resolve({ status: 200, data: rpc(999) }), 50));
    } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {}, clock: () => Date.now(), random: () => 0,
  });
  beginWalletHistoryAcquisitionV1(port, { ...request().budgets, max_attempts_per_operation: 2, request_timeout_ms: 20, overall_timeout_ms: 25 });
  await code(port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
  assert.equal(aborted, true);
  assert.equal(calls, 1);

  const noNext = createHeliusWalletHistoryPortV1({
    httpClient: { request(input) {
      calls += 1;
      return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(Object.freeze({ code: 'request_timeout' })), { once: true }));
    } },
    apiKeyProvider: () => 'super-secret-key', sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), clock: () => Date.now(), random: () => 0,
  });
  calls = 0;
  beginWalletHistoryAcquisitionV1(noNext, { ...request().budgets, max_attempts_per_operation: 8, request_timeout_ms: 20, overall_timeout_ms: 21 });
  await code(noNext.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
  assert.equal(calls, 1);
});
