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
    ({ advance }) => { advance(299_999); return { status: 200, data: first }; },
    ({ advance }) => { advance(2); return { status: 200, data: [] }; },
  ], { apiKeyProvider: () => { keyCalls += 1; return 'super-secret-key'; } });
  await code(acrossPages.port.getEnhancedTransactionsBySignatureV1({ wallet: WALLET, signatures: [providerSignature('missing')] }), 'acquisition_deadline_exceeded');
  assert.equal(keyCalls, 1);

  keyCalls = 0;
  const acrossMethods = harness([
    ({ advance }) => { advance(299_999); return { status: 200, data: rpc(SOLANA_MAINNET_GENESIS_HASH) }; },
    ({ advance }) => { advance(2); return { status: 200, data: rpc(1000) }; },
  ], { apiKeyProvider: () => { keyCalls += 1; return 'super-secret-key'; } });
  await acrossMethods.port.getNetworkIdentityV1();
  await code(acrossMethods.port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
  assert.equal(keyCalls, 1);

  const hangingRequest = harness([({ advance }) => {
    advance(299_999);
    return new Promise(() => {});
  }]);
  await code(hangingRequest.port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');

  const hangingSleep = harness([({ advance }) => {
    advance(299_899);
    return { status: 429, data: null };
  }], { sleep: () => new Promise(() => {}) });
  await code(hangingSleep.port.getFinalizedSlotV1(), 'acquisition_deadline_exceeded');
});

test('global fetch is untouched and import/operation has no ambient credential access', async () => {
  const prior = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('forbidden'); };
  try { assert.equal(await harness([{ status: 200, data: rpc(1) }]).port.getFinalizedSlotV1(), 1); assert.equal(calls, 0); }
  finally { globalThis.fetch = prior; }
});
