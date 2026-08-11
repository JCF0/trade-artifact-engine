#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WALLET_ACQUISITION_PORT_METHODS_V2,
  beginWalletHistoryAcquisitionV2,
  createWalletHistoryPortV2,
} from './provider-port-v2.mjs';

const METHODS = [
  'getNetworkIdentityV1',
  'getFinalizedSlotV1',
  'getFinalizedBlockV1',
  'getFinalizedWalletSignaturePageV1',
  'getFinalizedFullTransactionPageV1',
  'getFinalizedTransactionV1',
];

function capability(overrides = {}) {
  return Object.fromEntries(METHODS.map(name => [
    name,
    Object.hasOwn(overrides, name) ? overrides[name] : (async input => ({ name, input: input ?? null })),
  ]));
}

test('provider port v2 exposes only the exact six semantic methods and detaches results', async () => {
  assert.deepEqual(WALLET_ACQUISITION_PORT_METHODS_V2, METHODS);
  const mutable = { transactions: [], pagination_token: null };
  const port = createWalletHistoryPortV2(capability({ getFinalizedFullTransactionPageV1: async () => mutable }));
  assert.deepEqual(Object.keys(port), METHODS);
  const result = await port.getFinalizedFullTransactionPageV1({});
  mutable.transactions.push({ secret: true });
  assert.deepEqual(result, { transactions: [], pagination_token: null });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.transactions));
});

test('provider port v2 rejects missing, extra, accessor, proxy, and non-function capabilities', () => {
  assert.throws(() => createWalletHistoryPortV2({}), error => error?.code === 'acquisition_capability_denied');
  const extra = capability(); extra.fetch = () => {};
  assert.throws(() => createWalletHistoryPortV2(extra), error => error?.code === 'acquisition_capability_denied');
  const accessor = capability();
  Object.defineProperty(accessor, METHODS[0], { enumerable: true, get() { throw new Error('must not run'); } });
  assert.throws(() => createWalletHistoryPortV2(accessor), error => error?.code === 'acquisition_capability_denied');
  assert.throws(() => createWalletHistoryPortV2(new Proxy(capability(), {})), error => error?.code === 'acquisition_capability_denied');
  assert.throws(() => createWalletHistoryPortV2(capability({ getFinalizedTransactionV1: null })), error => error?.code === 'acquisition_capability_denied');
});

test('provider port v2 keeps the acquisition starter hidden and passes detached budgets', () => {
  const budgets = { overall_timeout_ms: 1000 };
  let received = null;
  const port = createWalletHistoryPortV2(capability(), { beginAcquisitionV2(value) { received = value; } });
  assert.equal(beginWalletHistoryAcquisitionV2(port, budgets), true);
  budgets.overall_timeout_ms = 2;
  assert.deepEqual(received, { overall_timeout_ms: 1000 });
  assert.ok(Object.isFrozen(received));
  assert.throws(() => beginWalletHistoryAcquisitionV2(createWalletHistoryPortV2(capability()), budgets), error => error?.code === 'acquisition_capability_denied');
});

test('provider port v2 sanitizes thrown values and unsafe returned graphs', async () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const hostile of [new Error('secret'), cyclic, new Proxy({}, {})]) {
    const port = createWalletHistoryPortV2(capability({ getFinalizedSlotV1: async () => { if (hostile === cyclic) return hostile; throw hostile; } }));
    await assert.rejects(port.getFinalizedSlotV1(), error => error?.name === 'WalletAcquisitionError'
      && ['provider_uncertain','malformed_provider_response'].includes(error.code)
      && error.stack === undefined && !JSON.stringify(error).includes('secret'));
  }
});
