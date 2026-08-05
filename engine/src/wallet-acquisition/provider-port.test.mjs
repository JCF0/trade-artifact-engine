#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { WalletAcquisitionError, createWalletHistoryPortV1 } from './provider-port.mjs';

const names = ['getNetworkIdentityV1','getFinalizedSlotV1','getFinalizedBlockV1','getFinalizedWalletSignaturePageV1','getEnhancedTransactionsBySignatureV1'];
function capability(overrides = {}) {
  return Object.fromEntries(names.map(name => [name, overrides[name] ?? (async input => ({ name, input: input ?? null }))]));
}

test('provider-neutral port exposes only the five closed methods and detaches values', async () => {
  const mutable = { chain: 'solana', nested: [] };
  const port = createWalletHistoryPortV1(capability({ getNetworkIdentityV1: async () => mutable }));
  assert.deepEqual(Object.keys(port), names);
  const result = await port.getNetworkIdentityV1();
  mutable.nested.push('changed');
  assert.deepEqual(result, { chain: 'solana', nested: [] });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.nested));
});

test('port rejects malformed capability objects and sanitizes every thrown value', async () => {
  assert.throws(() => createWalletHistoryPortV1({}), error => error?.code === 'acquisition_capability_denied');
  for (const hostile of [new Error('secret https://host.invalid /root/key'), new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('secret'); } })]) {
    const port = createWalletHistoryPortV1(capability({ getFinalizedSlotV1: async () => { throw hostile; } }));
    await assert.rejects(port.getFinalizedSlotV1(), error => error instanceof WalletAcquisitionError
      && error.code === 'provider_uncertain' && error.stack === undefined && error.cause === undefined
      && !JSON.stringify(error).includes('secret'));
  }
});

test('allowlisted WalletAcquisitionError codes are laundered into fresh fixed errors', async () => {
  const forged = new WalletAcquisitionError('provider_auth_failed');
  forged.details = { secret: 'credential' };
  const port = createWalletHistoryPortV1(capability({ getFinalizedSlotV1: async () => { throw forged; } }));
  await assert.rejects(port.getFinalizedSlotV1(), error => error !== forged && error.code === 'provider_auth_failed'
    && error.details !== forged.details && JSON.stringify(error.details) === '{}');
});
