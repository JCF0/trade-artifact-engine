#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';

import { acquireFinalizedFullTransactionHistoryV1 } from './full-transaction-history-acquisition.mjs';
import { createHeliusFullTransactionPortV2 } from './helius-full-transaction-adapter.mjs';
import { createFullTransactionPageReconcilerV1 } from './full-transaction-page-reconciler.mjs';
import { beginWalletHistoryAcquisitionV2 } from './provider-port-v2.mjs';
import { getWalletAcquisitionFailureDiagnosticV1 } from './provider-port.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from './request-contract.mjs';
import { providerPublicKey, providerSignature } from './fixtures/test-identities.mjs';

const WALLET = '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni';
const PROGRAM = providerPublicKey('slice4-full-program');

function rawTransaction(name, { slot = 900, blockTime = 1_780_000_000, fee = 5000 } = {}) {
  const signature = providerSignature(name);
  return {
    slot,
    blockTime,
    version: 'legacy',
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [WALLET, PROGRAM],
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        recentBlockhash: providerPublicKey(`blockhash-${name}`),
        instructions: [{ programIdIndex: 1, accounts: [0], data: 'A' }],
      },
    },
    meta: {
      err: null,
      fee,
      preBalances: [100000, 0],
      postBalances: [95000, 0],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
  };
}

function rpc(result) { return { jsonrpc: '2.0', id: 'wallet-acquisition-v2', result }; }
function page(data, paginationToken = null) { return { status: 200, data: rpc({ data, paginationToken }) }; }
function exact(transaction) { return { status: 200, data: rpc(transaction) }; }
function budgets(overrides = {}) {
  return {
    pagination_profile: 'solana_full_transaction_page_100_v1', page_size: 100,
    max_pages: 100, max_transactions: 10000,
    retry_profile: 'bounded_exponential_retry_v1', max_attempts_per_operation: 8,
    timeout_profile: 'bounded_provider_timeout_v1', request_timeout_ms: 60000, overall_timeout_ms: 300000,
    exact_fallback_profile: 'finalized_get_transaction_missing_only_v1', max_exact_fallback_transactions: 0,
    ...overrides,
  };
}
function input(pagination_token = null, overrides = {}) {
  return {
    wallet: WALLET,
    pagination_token,
    limit: 100,
    commitment: 'finalized',
    anchor_slot: 1000,
    transaction_details: 'full',
    sort_order: 'desc',
    encoding: 'json',
    max_supported_transaction_version: 0,
    token_account_scope: 'none',
    status: 'any',
    ...overrides,
  };
}
function exactInput(signature) {
  return {
    signature,
    commitment: 'finalized',
    encoding: 'json',
    max_supported_transaction_version: 0,
  };
}
function canonical(raw) {
  return {
    signature: raw.transaction.signatures[0],
    slot: raw.slot,
    block_time: raw.blockTime,
    execution_state: raw.meta.err === null ? 'succeeded' : 'failed',
  };
}
function harness(responses, options = {}) {
  let calls = 0; let now = 0; const seen = [];
  const counts = { retry: 0, timeout: 0 };
  const port = createHeliusFullTransactionPortV2({
    httpClient: { request(request) {
      seen.push(structuredClone({ ...request, signal: undefined }));
      const item = responses[Math.min(calls++, responses.length - 1)];
      if (typeof item === 'function') return item({ request, advance(milliseconds) { now += milliseconds; } });
      if (item instanceof Error) return Promise.reject(item);
      return structuredClone(item);
    } },
    apiKeyProvider: options.apiKeyProvider ?? (() => 'super-secret-key'),
    sleep: options.sleep ?? (async milliseconds => { now += milliseconds; }),
    clock: options.clock ?? (() => now),
    random: () => 0,
    telemetry: options.telemetry ?? {
      onRetryAttemptV1() { counts.retry += 1; },
      onTimeoutAttemptV1() { counts.timeout += 1; },
    },
  });
  return { port, seen, counts, calls: () => calls };
}
function reconcile(reconciler, requested_pagination_token, pageResult) {
  return reconciler.acceptPageV1({ requested_pagination_token, ...pageResult });
}
async function reject(promise, expectedCode, reason = null) {
  await assert.rejects(promise, error => error?.name === 'WalletAcquisitionError'
    && error.code === expectedCode
    && (reason === null || getWalletAcquisitionFailureDiagnosticV1(error)?.reason === reason)
    && error.stack === undefined && error.cause === undefined
    && !inspect(error, { depth: 10 }).includes('super-secret-key'));
}

test('generates the exact fixed Helius full-transaction request and returns detached transactions', async () => {
  const raw = rawTransaction('exact-request');
  const h = harness([page([raw])]);
  beginWalletHistoryAcquisitionV2(h.port, budgets());
  const result = await h.port.getFinalizedFullTransactionPageV1(input());
  assert.equal(result.transactions[0].signature, raw.transaction.signatures[0]);
  assert.equal(result.pagination_token, null);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.transactions[0]));
  raw.meta.fee = 1;
  assert.equal(result.transactions[0].fee_lamports, 5000);
  assert.deepEqual(h.seen[0], {
    method: 'POST',
    url: 'https://mainnet.helius-rpc.com/',
    query: { 'api-key': 'super-secret-key' },
    headers: { 'content-type': 'application/json' },
    body: {
      jsonrpc: '2.0', id: 'wallet-acquisition-v2', method: 'getTransactionsForAddress',
      params: [WALLET, {
        transactionDetails: 'full', sortOrder: 'desc', limit: 100,
        commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0,
        minContextSlot: 1000,
        filters: { status: 'any', tokenAccounts: 'none', slot: { lte: 1000 } },
      }],
    },
    timeout_ms: 60000,
    signal: undefined,
  });
});

test('preserves finalized standard-RPC completeness operations on the v2 port', async () => {
  const signature = providerSignature('canonical-signature');
  const blockhash = providerPublicKey('canonical-blockhash');
  const h = harness([
    { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) },
    { status: 200, data: rpc(1000) },
    { status: 200, data: rpc({ blockTime: 1_780_000_000, blockhash }) },
    { status: 200, data: rpc([{
      signature, slot: 999, blockTime: 1_779_999_999, err: null, memo: null,
      confirmationStatus: 'finalized',
    }]) },
  ]);
  beginWalletHistoryAcquisitionV2(h.port, budgets());
  assert.deepEqual(await h.port.getNetworkIdentityV1(), {
    chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
  });
  assert.equal(await h.port.getFinalizedSlotV1(), 1000);
  assert.deepEqual(await h.port.getFinalizedBlockV1({ slot: 1000 }), {
    slot: 1000, block_time: 1_780_000_000, blockhash, commitment: 'finalized',
  });
  assert.deepEqual(await h.port.getFinalizedWalletSignaturePageV1({
    wallet: WALLET, before: null, limit: 100, commitment: 'finalized',
  }), [{ signature, slot: 999, block_time: 1_779_999_999, execution_state: 'succeeded' }]);
  assert.deepEqual(h.seen.map(request => request.body.method), [
    'getGenesisHash','getSlot','getBlock','getSignaturesForAddress',
  ]);
  assert.equal(Object.hasOwn(h.seen[3].body.params[1], 'before'), false);
});

test('propagates opaque pagination tokens unchanged', async () => {
  const first = rawTransaction('page-first', { slot: 900 });
  const second = rawTransaction('page-second', { slot: 800 });
  const opaque = '900:opaque/value?still-not-parsed';
  const h = harness([page([first], opaque), page([second], null)]);
  beginWalletHistoryAcquisitionV2(h.port, budgets());
  assert.equal((await h.port.getFinalizedFullTransactionPageV1(input())).pagination_token, opaque);
  assert.equal((await h.port.getFinalizedFullTransactionPageV1(input(opaque))).transactions[0].signature, second.transaction.signatures[0]);
  assert.equal(h.seen[1].body.params[1].paginationToken, opaque);
  assert.equal(Object.hasOwn(h.seen[0].body.params[1], 'paginationToken'), false);
});

test('rejects negative-zero slot inputs before starting transport', async () => {
  const h = harness([]);
  beginWalletHistoryAcquisitionV2(h.port, budgets());
  await reject(h.port.getFinalizedBlockV1({ slot: -0 }), 'provider_request_invalid');
  await reject(h.port.getFinalizedFullTransactionPageV1(input(null, { anchor_slot: -0 })),
    'provider_request_invalid');
  assert.equal(h.calls(), 0);
});

test('orchestrator-side page reconciliation rejects repeated and unexpected pagination tokens', async () => {
  const first = rawTransaction('token-first', { slot: 900 });
  const second = rawTransaction('token-second', { slot: 800 });
  const repeated = harness([page([first], 'opaque'), page([second], 'opaque')]);
  beginWalletHistoryAcquisitionV2(repeated.port, budgets());
  const reconciler = createFullTransactionPageReconcilerV1({ max_pages: 2, max_transactions: 2 });
  reconcile(reconciler, null, await repeated.port.getFinalizedFullTransactionPageV1(input()));
  await assert.rejects(async () => reconcile(reconciler, 'opaque',
    await repeated.port.getFinalizedFullTransactionPageV1(input('opaque'))),
  error => getWalletAcquisitionFailureDiagnosticV1(error)?.reason === 'full_transaction_pagination_token_repeated');

  const wrong = createFullTransactionPageReconcilerV1({ max_pages: 2, max_transactions: 2 });
  assert.throws(() => reconcile(wrong, 'unexpected', { transactions: [], pagination_token: null }),
    error => getWalletAcquisitionFailureDiagnosticV1(error)?.reason === 'full_transaction_pagination_token_invalid');
});

test('rejects malformed page envelopes and tokens with generic unsafe-value precedence', async () => {
  const malformed = [
    [{ status: 200, data: { jsonrpc: '2.0', id: 'wrong', result: { data: [], paginationToken: null } } }, 'rpc_envelope_invalid'],
    [{ status: 200, data: { jsonrpc: '2.0', id: 'wallet-acquisition-v2', result: { data: [], paginationToken: null }, extra: true } }, 'rpc_envelope_invalid'],
    [{ status: 200, data: rpc([]) }, 'full_transaction_page_invalid'],
    [{ status: 200, data: rpc({ data: [], paginationToken: '' }) }, 'full_transaction_pagination_token_invalid'],
    [{ status: 200, data: rpc({ data: [], paginationToken: 'x'.repeat(1025) }) }, 'full_transaction_pagination_token_invalid'],
    [{ status: 200, data: rpc({ data: [], paginationToken: null, extra: true }) }, 'full_transaction_page_invalid'],
  ];
  for (const [response, reason] of malformed) {
    const h = harness([response]); beginWalletHistoryAcquisitionV2(h.port, budgets());
    await reject(h.port.getFinalizedFullTransactionPageV1(input()), 'malformed_provider_response', reason);
  }
  const cyclic = { jsonrpc: '2.0', id: 'wallet-acquisition-v2' }; cyclic.result = cyclic;
  const unsafe = harness([{ status: 200, data: cyclic }]); beginWalletHistoryAcquisitionV2(unsafe.port, budgets());
  await reject(unsafe.port.getFinalizedFullTransactionPageV1(input()), 'malformed_provider_response', 'provider_value_unsafe');
});

test('validates a full 100-entry page and preserves identical duplicates across pages', async () => {
  const full = Array.from({ length: 100 }, (_, index) => rawTransaction(`full-${index}`, { slot: 900 - index }));
  const duplicate = structuredClone(full.at(-1));
  const h = harness([page(full, 'opaque-next'), page([duplicate], null)]);
  beginWalletHistoryAcquisitionV2(h.port, budgets());
  const reconciler = createFullTransactionPageReconcilerV1({ max_pages: 2, max_transactions: 101 });
  assert.equal(reconcile(reconciler, null,
    await h.port.getFinalizedFullTransactionPageV1(input())).transactions.length, 100);
  assert.equal(reconcile(reconciler, 'opaque-next',
    await h.port.getFinalizedFullTransactionPageV1(input('opaque-next'))).transactions.length, 0);
});

test('accepts canonical-identical duplicates, rejects conflicting duplicates, and rejects increasing page order', async () => {
  const original = rawTransaction('duplicate', { slot: 900 });
  const identical = structuredClone(original);
  const accepted = harness([page([original, identical])]);
  beginWalletHistoryAcquisitionV2(accepted.port, budgets());
  const acceptedReconciler = createFullTransactionPageReconcilerV1({ max_pages: 1, max_transactions: 2 });
  const result = reconcile(acceptedReconciler, null, await accepted.port.getFinalizedFullTransactionPageV1(input()));
  assert.equal(result.transactions.length, 1);

  const changed = structuredClone(original); changed.meta.fee = 1; changed.meta.postBalances[0] = 99999;
  const conflict = harness([page([original], 'next'), page([changed], null)]);
  beginWalletHistoryAcquisitionV2(conflict.port, budgets());
  const conflictReconciler = createFullTransactionPageReconcilerV1({ max_pages: 2, max_transactions: 2 });
  reconcile(conflictReconciler, null, await conflict.port.getFinalizedFullTransactionPageV1(input()));
  await assert.rejects(async () => reconcile(conflictReconciler, 'next',
    await conflict.port.getFinalizedFullTransactionPageV1(input('next'))),
  error => getWalletAcquisitionFailureDiagnosticV1(error)?.reason === 'full_transaction_duplicate_signature');

  const outOfOrder = harness([page([
    rawTransaction('older', { slot: 800 }), rawTransaction('newer', { slot: 801 }),
  ])]);
  beginWalletHistoryAcquisitionV2(outOfOrder.port, budgets());
  const orderReconciler = createFullTransactionPageReconcilerV1({ max_pages: 1, max_transactions: 2 });
  await assert.rejects(async () => reconcile(orderReconciler, null,
    await outOfOrder.port.getFinalizedFullTransactionPageV1(input())),
  error => getWalletAcquisitionFailureDiagnosticV1(error)?.reason === 'full_transaction_order_invalid');
});

test('structurally validates and counts every entry before enforcing anchor filtering and caps', async () => {
  const postAnchor = rawTransaction('post-anchor', { slot: 1001 });
  const h = harness([page([postAnchor])]); beginWalletHistoryAcquisitionV2(h.port, budgets());
  assert.equal((await h.port.getFinalizedFullTransactionPageV1(input())).transactions[0].slot, 1001);

  const capped = harness([page([rawTransaction('one'), rawTransaction('two')])]);
  beginWalletHistoryAcquisitionV2(capped.port, budgets({ max_transactions: 1 }));
  const entryReconciler = createFullTransactionPageReconcilerV1({ max_pages: 1, max_transactions: 1 });
  await assert.rejects(async () => reconcile(entryReconciler, null,
    await capped.port.getFinalizedFullTransactionPageV1(input())), error => error?.code === 'acquisition_capped');

  const pageCapped = harness([page([], 'next'), page([], null)]);
  beginWalletHistoryAcquisitionV2(pageCapped.port, budgets({ max_pages: 1 }));
  const pageReconciler = createFullTransactionPageReconcilerV1({ max_pages: 1, max_transactions: 1 });
  reconcile(pageReconciler, null, await pageCapped.port.getFinalizedFullTransactionPageV1(input()));
  assert.throws(() => pageReconciler.assertPageRequestAllowedV1('next'), error => error?.code === 'acquisition_capped');
  assert.equal(pageCapped.calls(), 1);

  const transactionCapped = harness([page([rawTransaction('cap-filled')], 'next'), page([], null)]);
  beginWalletHistoryAcquisitionV2(transactionCapped.port, budgets({ max_transactions: 1 }));
  const transactionReconciler = createFullTransactionPageReconcilerV1({ max_pages: 2, max_transactions: 1 });
  reconcile(transactionReconciler, null,
    await transactionCapped.port.getFinalizedFullTransactionPageV1(input()));
  assert.throws(() => transactionReconciler.assertPageRequestAllowedV1('next'),
    error => error?.code === 'acquisition_capped');
  assert.equal(transactionCapped.calls(), 1);

  for (const invalid of [
    { max_pages: 101, max_transactions: 1 },
    { max_pages: 1, max_transactions: 10001 },
  ]) assert.throws(() => createFullTransactionPageReconcilerV1(invalid), error => error?.code === 'invalid_acquisition_request');
});

test('shares one monotonic deadline across methods and pages and preserves retry telemetry semantics', async () => {
  const transient = Object.assign(new Error('hostile'), { code: 'request_timeout' });
  const retry = harness([transient, page([])]);
  beginWalletHistoryAcquisitionV2(retry.port, budgets({ max_attempts_per_operation: 2 }));
  await retry.port.getFinalizedFullTransactionPageV1(input());
  assert.deepEqual(retry.counts, { retry: 1, timeout: 1 });

  const shared = harness([
    ({ advance }) => { advance(16); return { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) }; },
    ({ request, advance }) => { assert.equal(request.timeout_ms, 4); advance(5); return page([]); },
  ]);
  beginWalletHistoryAcquisitionV2(shared.port, budgets({ request_timeout_ms: 17, overall_timeout_ms: 20 }));
  await shared.port.getNetworkIdentityV1();
  await reject(shared.port.getFinalizedFullTransactionPageV1(input()), 'acquisition_deadline_exceeded');
  assert.equal(shared.calls(), 2);

  const repeatedIdentity = harness([
    ({ advance }) => { advance(6); return { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) }; },
    ({ advance }) => { advance(5); return { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) }; },
  ]);
  beginWalletHistoryAcquisitionV2(repeatedIdentity.port,
    budgets({ request_timeout_ms: 8, overall_timeout_ms: 10 }));
  await repeatedIdentity.port.getNetworkIdentityV1();
  await reject(repeatedIdentity.port.getNetworkIdentityV1(), 'acquisition_deadline_exceeded');
  assert.equal(repeatedIdentity.calls(), 2);
});

test('invalid JSON does not retry and retry sleep expiry starts no fabricated retry', async () => {
  const invalid = Object.assign(new Error('hostile prose'), { code: 'invalid_json' });
  const malformed = harness([invalid, page([])]);
  beginWalletHistoryAcquisitionV2(malformed.port, budgets({ max_attempts_per_operation: 2 }));
  await reject(malformed.port.getFinalizedFullTransactionPageV1(input()), 'malformed_provider_response', 'invalid_json');
  assert.equal(malformed.calls(), 1);
  assert.deepEqual(malformed.counts, { retry: 0, timeout: 0 });

  const sleeping = harness([{ status: 429, data: null }], { sleep: () => new Promise(() => {}) });
  beginWalletHistoryAcquisitionV2(sleeping.port, budgets({
    max_attempts_per_operation: 2, request_timeout_ms: 5, overall_timeout_ms: 20,
  }));
  await reject(sleeping.port.getFinalizedFullTransactionPageV1(input()), 'acquisition_deadline_exceeded');
  assert.equal(sleeping.calls(), 1);
  assert.deepEqual(sleeping.counts, { retry: 0, timeout: 0 });
});

test('abort-respecting timeout termination increments timeout telemetry exactly once', async () => {
  const counts = { retry: 0, timeout: 0 };
  const port = createHeliusFullTransactionPortV2({
    httpClient: { request(request) {
      return new Promise((resolve, rejectRequest) => request.signal.addEventListener('abort', () => {
        rejectRequest(Object.freeze({ code: 'request_timeout' }));
      }, { once: true }));
    } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {}, clock: () => performance.now(), random: () => 0,
    telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
  });
  beginWalletHistoryAcquisitionV2(port, budgets({ max_attempts_per_operation: 1, request_timeout_ms: 10, overall_timeout_ms: 100 }));
  await reject(port.getFinalizedFullTransactionPageV1(input()), 'provider_retry_exhausted');
  assert.deepEqual(counts, { retry: 0, timeout: 1 });
});

test('abort-ignoring request timeout starts no retry and records no effective timeout', async () => {
  let calls = 0; const counts = { retry: 0, timeout: 0 };
  const port = createHeliusFullTransactionPortV2({
    httpClient: { request() { calls += 1; return new Promise(() => {}); } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {},
    clock: () => performance.now(), random: () => 0,
    telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
  });
  beginWalletHistoryAcquisitionV2(port,
    budgets({ max_attempts_per_operation: 2, request_timeout_ms: 10, overall_timeout_ms: 500 }));
  await reject(port.getFinalizedFullTransactionPageV1(input()), 'provider_retry_exhausted');
  assert.equal(calls, 1);
  assert.deepEqual(counts, { retry: 0, timeout: 0 });
});

test('aborts timed-out requests and discards late success without retry or post-finalization effects', async () => {
  let calls = 0; let clockCalls = 0; let aborted = false; const counts = { retry: 0, timeout: 0 };
  const port = createHeliusFullTransactionPortV2({
    httpClient: { request(request) {
      calls += 1;
      request.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(resolve => setTimeout(() => resolve(page([])), 50));
    } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {},
    clock: () => { clockCalls += 1; return performance.now(); }, random: () => 0,
    telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
  });
  beginWalletHistoryAcquisitionV2(port, budgets({ max_attempts_per_operation: 2, request_timeout_ms: 20, overall_timeout_ms: 25 }));
  await reject(port.getFinalizedFullTransactionPageV1(input()), 'provider_retry_exhausted');
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  assert.deepEqual(counts, { retry: 0, timeout: 0 });
  const finalizedClockCalls = clockCalls;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls, 1);
  assert.equal(clockCalls, finalizedClockCalls);
  assert.deepEqual(counts, { retry: 0, timeout: 0 });
});

test('generates the exact fixed finalized getTransaction request and returns one detached transaction', async () => {
  const prior = globalThis.fetch; let globalCalls = 0;
  globalThis.fetch = () => { globalCalls += 1; throw new Error('forbidden'); };
  try {
    const raw = rawTransaction('fallback');
    const h = harness([exact(raw)]);
    beginWalletHistoryAcquisitionV2(h.port, budgets({ max_exact_fallback_transactions: 1 }));
    const result = await h.port.getFinalizedTransactionV1(exactInput(raw.transaction.signatures[0]));
    assert.equal(result.signature, raw.transaction.signatures[0]);
    assert.ok(Object.isFrozen(result));
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.seen[0].body, {
      jsonrpc: '2.0', id: 'wallet-acquisition-v2', method: 'getTransaction',
      params: [raw.transaction.signatures[0], {
        commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0,
      }],
    });
    assert.equal(globalCalls, 0);
  } finally { globalThis.fetch = prior; }
});

test('recovers terminal bulk-history omissions in deterministic canonical order only', async () => {
  const newest = rawTransaction('canonical-newest', { slot: 903, blockTime: 1_780_000_003 });
  const middle = rawTransaction('canonical-middle', { slot: 902, blockTime: 1_780_000_002 });
  const oldest = rawTransaction('canonical-oldest', { slot: 901, blockTime: 1_780_000_001 });
  const h = harness([page([middle]), exact(newest), exact(oldest)]);
  const configured = budgets({ max_exact_fallback_transactions: 2 });
  beginWalletHistoryAcquisitionV2(h.port, configured);
  const result = await acquireFinalizedFullTransactionHistoryV1({
    port: h.port,
    wallet: WALLET,
    anchor_slot: 1000,
    canonical_sources: [canonical(newest), canonical(middle), canonical(oldest)],
    budgets: configured,
  });
  assert.deepEqual(result.map(transaction => transaction.signature), [
    newest.transaction.signatures[0], middle.transaction.signatures[0], oldest.transaction.signatures[0],
  ]);
  assert.deepEqual(h.seen.map(request => request.body.method), [
    'getTransactionsForAddress','getTransaction','getTransaction',
  ]);
  assert.deepEqual(h.seen.slice(1).map(request => request.body.params[0]), [
    newest.transaction.signatures[0], oldest.transaction.signatures[0],
  ]);
});

test('enforces zero allowance and the configured exact-call cap before transport', async () => {
  const signature = providerSignature('no-fallback-allowance');
  const disabled = harness([exact(rawTransaction('unused'))]);
  beginWalletHistoryAcquisitionV2(disabled.port, budgets());
  await reject(disabled.port.getFinalizedTransactionV1(exactInput(signature)), 'acquisition_capped');
  assert.equal(disabled.calls(), 0);

  const first = rawTransaction('exact-cap-first');
  const capped = harness([exact(first), exact(rawTransaction('exact-cap-second'))]);
  beginWalletHistoryAcquisitionV2(capped.port, budgets({ max_exact_fallback_transactions: 1 }));
  await capped.port.getFinalizedTransactionV1(exactInput(first.transaction.signatures[0]));
  await reject(capped.port.getFinalizedTransactionV1(exactInput(providerSignature('exact-cap-second'))),
    'acquisition_capped');
  assert.equal(capped.calls(), 1);
});

test('rejects non-exact getTransaction inputs before transport', async () => {
  const signature = providerSignature('invalid-exact-input');
  const invalid = [
    { signature },
    { ...exactInput(signature), commitment: 'confirmed' },
    { ...exactInput(signature), encoding: 'jsonParsed' },
    { ...exactInput(signature), max_supported_transaction_version: 1 },
    { ...exactInput(signature), extra: true },
  ];
  for (const candidate of invalid) {
    const h = harness([exact(rawTransaction('unused-exact-input'))]);
    beginWalletHistoryAcquisitionV2(h.port, budgets({ max_exact_fallback_transactions: 1 }));
    await reject(h.port.getFinalizedTransactionV1(candidate), 'provider_request_invalid');
    assert.equal(h.calls(), 0);
  }
});

test('recovers the hard maximum of eight omissions without a ninth call', async () => {
  const raws = Array.from({ length: 8 }, (_, index) => rawTransaction(`fallback-eight-${index}`, {
    slot: 908 - index, blockTime: 1_780_000_008 - index,
  }));
  const h = harness([page([]), ...raws.map(exact)]);
  const configured = budgets({ max_exact_fallback_transactions: 8 });
  beginWalletHistoryAcquisitionV2(h.port, configured);
  const result = await acquireFinalizedFullTransactionHistoryV1({
    port: h.port, wallet: WALLET, anchor_slot: 1000,
    canonical_sources: raws.map(canonical), budgets: configured,
  });
  assert.deepEqual(result.map(transaction => transaction.signature), raws.map(raw => raw.transaction.signatures[0]));
  assert.equal(h.seen.filter(request => request.body.method === 'getTransaction').length, 8);
});

test('fails closed on null, malformed, signature-mismatching, and source-mismatching exact results', async () => {
  const expected = rawTransaction('exact-expected');
  const malformed = structuredClone(expected); delete malformed.meta.fee;
  const cases = [
    [null, 'source_transaction_mismatch'],
    [malformed, 'malformed_provider_response'],
    [rawTransaction('wrong-signature'), 'malformed_provider_response'],
    [rawTransaction('exact-expected', { slot: 899 }), 'source_transaction_mismatch'],
    [rawTransaction('exact-expected', { blockTime: 1_779_999_999 }), 'source_transaction_mismatch'],
  ];
  for (const [candidate, code] of cases) {
    const h = harness([page([]), exact(candidate)]);
    const configured = budgets({ max_exact_fallback_transactions: 1, max_attempts_per_operation: 1 });
    beginWalletHistoryAcquisitionV2(h.port, configured);
    await reject(acquireFinalizedFullTransactionHistoryV1({
      port: h.port, wallet: WALLET, anchor_slot: 1000,
      canonical_sources: [canonical(expected)], budgets: configured,
    }), code);
    assert.deepEqual(h.seen.map(request => request.body.method), ['getTransactionsForAddress','getTransaction']);
  }
  const failed = rawTransaction('exact-expected'); failed.meta.err = { InstructionError: [0, 'Custom'] };
  const execution = harness([page([]), exact(failed)]);
  const configured = budgets({ max_exact_fallback_transactions: 1 });
  beginWalletHistoryAcquisitionV2(execution.port, configured);
  await reject(acquireFinalizedFullTransactionHistoryV1({
    port: execution.port, wallet: WALLET, anchor_slot: 1000,
    canonical_sources: [canonical(expected)], budgets: configured,
  }), 'source_transaction_mismatch');

  const cyclic = rpc(null); cyclic.result = cyclic;
  const unsafe = harness([{ status: 200, data: cyclic }]);
  beginWalletHistoryAcquisitionV2(unsafe.port, configured);
  await reject(unsafe.port.getFinalizedTransactionV1(exactInput(expected.transaction.signatures[0])),
    'malformed_provider_response', 'provider_value_unsafe');
});

test('does not fallback when allowance is zero or terminal omissions exceed allowance', async () => {
  const sources = [canonical(rawTransaction('missing-one')), canonical(rawTransaction('missing-two', { slot: 899 }))];
  for (const allowance of [0, 1]) {
    const h = harness([page([])]);
    const configured = budgets({ max_exact_fallback_transactions: allowance });
    beginWalletHistoryAcquisitionV2(h.port, configured);
    await reject(acquireFinalizedFullTransactionHistoryV1({
      port: h.port, wallet: WALLET, anchor_slot: 1000, canonical_sources: sources, budgets: configured,
    }), 'source_transaction_mismatch');
    assert.deepEqual(h.seen.map(request => request.body.method), ['getTransactionsForAddress']);
  }
});

test('never starts fallback after malformed bulk evidence, duplicate conflict, repeated token, cap, timeout, or deadline failure', async () => {
  const source = canonical(rawTransaction('bulk-failure-missing'));
  const duplicate = rawTransaction('bulk-conflict');
  const changed = structuredClone(duplicate); changed.meta.fee = 1; changed.meta.postBalances[0] = 99999;
  const timeout = Object.assign(new Error('hostile timeout'), { code: 'request_timeout' });
  const cases = [
    { responses: [{ status: 200, data: rpc({ data: 'bad', paginationToken: null }) }] },
    { responses: [page([duplicate, changed])] },
    { responses: [page([], 'repeat'), page([], 'repeat')] },
    { responses: [page([], 'next')], overrides: { max_pages: 1 } },
    { responses: [timeout], overrides: { max_attempts_per_operation: 1 } },
    { responses: [({ advance }) => { advance(21); return page([]); }], overrides: {
      request_timeout_ms: 19, overall_timeout_ms: 20,
    } },
  ];
  for (const fixture of cases) {
    const h = harness(fixture.responses);
    const configured = budgets({ max_exact_fallback_transactions: 1, ...fixture.overrides });
    beginWalletHistoryAcquisitionV2(h.port, configured);
    await assert.rejects(acquireFinalizedFullTransactionHistoryV1({
      port: h.port, wallet: WALLET, anchor_slot: 1000,
      canonical_sources: [source], budgets: configured,
    }));
    assert.equal(h.seen.some(request => request.body.method === 'getTransaction'), false);
  }
});

test('never repairs a canonical bulk signature carrying contradictory post-anchor source evidence', async () => {
  const expected = rawTransaction('canonical-post-anchor-conflict', { slot: 900 });
  const contradictory = rawTransaction('canonical-post-anchor-conflict', { slot: 1001 });
  const h = harness([page([contradictory]), exact(expected)]);
  const configured = budgets({ max_exact_fallback_transactions: 1 });
  beginWalletHistoryAcquisitionV2(h.port, configured);
  await reject(acquireFinalizedFullTransactionHistoryV1({
    port: h.port, wallet: WALLET, anchor_slot: 1000,
    canonical_sources: [canonical(expected)], budgets: configured,
  }), 'source_transaction_mismatch');
  assert.deepEqual(h.seen.map(request => request.body.method), ['getTransactionsForAddress']);
});

test('fallback shares the acquisition deadline, retries, and telemetry', async () => {
  const missing = rawTransaction('shared-fallback', { slot: 899 });
  const transient = Object.assign(new Error('hostile timeout'), { code: 'request_timeout' });
  const h = harness([
    ({ advance }) => { advance(5); return page([]); },
    transient,
    ({ request, advance }) => { assert.equal(request.timeout_ms, 15); advance(1); return exact(missing); },
  ]);
  const configured = budgets({
    max_exact_fallback_transactions: 1, max_attempts_per_operation: 2,
    request_timeout_ms: 20, overall_timeout_ms: 120,
  });
  beginWalletHistoryAcquisitionV2(h.port, configured);
  const result = await acquireFinalizedFullTransactionHistoryV1({
    port: h.port, wallet: WALLET, anchor_slot: 1000,
    canonical_sources: [canonical(missing)], budgets: configured,
  });
  assert.equal(result[0].signature, missing.transaction.signatures[0]);
  assert.deepEqual(h.counts, { retry: 1, timeout: 1 });
  assert.deepEqual(h.seen.map(request => request.body.method), [
    'getTransactionsForAddress','getTransaction','getTransaction',
  ]);
});

test('fallback aborts and discards abort-ignoring late success without retry or telemetry mutation', async () => {
  const missing = rawTransaction('late-fallback', { slot: 899 });
  let calls = 0; let clockCalls = 0; let aborted = false;
  const counts = { retry: 0, timeout: 0 };
  const port = createHeliusFullTransactionPortV2({
    httpClient: { request(request) {
      calls += 1;
      if (calls === 1) return page([]);
      request.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(resolve => setTimeout(() => resolve(exact(missing)), 50));
    } },
    apiKeyProvider: () => 'super-secret-key', sleep: async () => {},
    clock: () => { clockCalls += 1; return performance.now(); }, random: () => 0,
    telemetry: { onRetryAttemptV1() { counts.retry += 1; }, onTimeoutAttemptV1() { counts.timeout += 1; } },
  });
  const configured = budgets({
    max_exact_fallback_transactions: 1, max_attempts_per_operation: 2,
    request_timeout_ms: 10, overall_timeout_ms: 100,
  });
  beginWalletHistoryAcquisitionV2(port, configured);
  await reject(acquireFinalizedFullTransactionHistoryV1({
    port, wallet: WALLET, anchor_slot: 1000,
    canonical_sources: [canonical(missing)], budgets: configured,
  }), 'provider_retry_exhausted');
  assert.equal(aborted, true);
  assert.equal(calls, 2);
  assert.deepEqual(counts, { retry: 0, timeout: 0 });
  const finalizedClockCalls = clockCalls;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls, 2);
  assert.equal(clockCalls, finalizedClockCalls);
  assert.deepEqual(counts, { retry: 0, timeout: 0 });
});
