#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WalletAcquisitionError,
  WALLET_ACQUISITION_FAILURE_OPERATIONS_V1,
  WALLET_ACQUISITION_FAILURE_STAGES_V1,
  WALLET_ACQUISITION_MALFORMED_REASONS_V1,
  beginWalletHistoryAcquisitionV1,
  contextualizeWalletAcquisitionErrorV1,
  createWalletHistoryPortV1,
  failWalletAcquisitionOperationV1,
  getWalletAcquisitionFailureDiagnosticV1,
} from './provider-port.mjs';

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

test('diagnostic enums are closed and trusted metadata survives only private provenance', () => {
  assert.deepEqual(WALLET_ACQUISITION_FAILURE_STAGES_V1, [
    'request_binding','finalized_anchor','canonical_pagination','latest_state_recheck',
    'enhanced_history','enhanced_projection','full_transaction_history','full_transaction_projection',
    'exact_transaction_fallback','internal_boundary',
  ]);
  assert.deepEqual(WALLET_ACQUISITION_FAILURE_OPERATIONS_V1, [
    'acquisition_budget_binding','network_identity','finalized_slot','finalized_block',
    'canonical_signature_page','enhanced_address_history','enhanced_transaction_projection',
    'full_transaction_address_history','full_transaction_validation','full_transaction_projection',
    'exact_transaction_fallback','none',
  ]);
  assert.deepEqual(WALLET_ACQUISITION_MALFORMED_REASONS_V1, [
    'invalid_json','rpc_envelope_invalid','rpc_genesis_result_invalid','rpc_slot_result_invalid',
    'rpc_block_result_invalid','rpc_signature_page_invalid','enhanced_page_invalid',
    'enhanced_duplicate_signature','enhanced_order_invalid','enhanced_page_incomplete',
    'enhanced_cursor_repeated','enhanced_transaction_shape_invalid',
    'enhanced_projection_internal_rejection','full_transaction_page_invalid',
    'full_transaction_duplicate_signature','full_transaction_order_invalid',
    'full_transaction_page_incomplete','full_transaction_pagination_token_invalid',
    'full_transaction_pagination_token_repeated','full_transaction_shape_invalid',
    'full_transaction_signature_mismatch','full_transaction_projection_internal_rejection',
    'exact_transaction_result_invalid','provider_value_unsafe','unlocalized_malformed_response',
  ]);

  let minted;
  try { failWalletAcquisitionOperationV1('malformed_provider_response', 'rpc_slot_result_invalid'); }
  catch (error) { minted = error; }
  const contextual = contextualizeWalletAcquisitionErrorV1(minted, 'finalized_anchor', 'finalized_slot');
  assert.notEqual(contextual, minted);
  assert.equal(contextual.code, 'malformed_provider_response');
  assert.deepEqual(getWalletAcquisitionFailureDiagnosticV1(contextual), {
    diagnostic_version: 'controlled_live_failure_diagnostic_v1',
    stage: 'finalized_anchor', operation: 'finalized_slot', reason: 'rpc_slot_result_invalid',
  });

  const forged = new WalletAcquisitionError('malformed_provider_response');
  forged.failure_diagnostic = { stage: 'finalized_anchor', operation: 'finalized_slot', reason: 'secret-value' };
  assert.equal(getWalletAcquisitionFailureDiagnosticV1(forged), null);
  assert.equal(getWalletAcquisitionFailureDiagnosticV1(contextualizeWalletAcquisitionErrorV1(
    forged, 'finalized_anchor', 'finalized_slot',
  )), null);
  assert.throws(
    () => failWalletAcquisitionOperationV1('malformed_provider_response', 'secret-value'),
    error => error.code === 'malformed_provider_response' && getWalletAcquisitionFailureDiagnosticV1(error) === null,
  );
});

test('generic provider boundary classifies every required unsafe-value class without retaining values', async () => {
  const cyclic = {}; cyclic.self = cyclic;
  const accessor = {}; Object.defineProperty(accessor, 'secret', { enumerable: true, get() { return 'credential'; } });
  const sparse = new Array(2); sparse[1] = 'secret';
  const deep = {}; let cursor = deep;
  for (let index = 0; index < 257; index += 1) { cursor.next = {}; cursor = cursor.next; }
  const wide = Array.from({ length: 100001 }, () => null);
  const hostile = [
    cyclic, accessor, sparse, new Proxy({}, {}), new Date(0), deep, wide,
    { value: Number.NaN }, { value: Number.POSITIVE_INFINITY }, { value: -0 },
  ];
  for (const value of hostile) {
    const port = createWalletHistoryPortV1(capability({ getFinalizedSlotV1: async () => value }));
    await assert.rejects(port.getFinalizedSlotV1(), error => {
      assert.equal(error.code, 'malformed_provider_response');
      assert.deepEqual(getWalletAcquisitionFailureDiagnosticV1(error), {
        diagnostic_version: 'controlled_live_failure_diagnostic_v1',
        stage: null, operation: null, reason: 'provider_value_unsafe',
      });
      assert.equal(JSON.stringify(error).includes('secret'), false);
      return true;
    });
  }
});

test('acquisition starter is mandatory, receives detached immutable budgets, and survives rewrapping', () => {
  const budgets = { overall_timeout_ms: 1000 };
  let received = null;
  const registered = createWalletHistoryPortV1(capability(), { beginAcquisitionV1(value) { received = value; } });
  const rewrapped = createWalletHistoryPortV1(registered);
  assert.equal(beginWalletHistoryAcquisitionV1(rewrapped, budgets), true);
  assert.deepEqual(received, budgets);
  assert.ok(Object.isFrozen(received));
  budgets.overall_timeout_ms = 2000;
  assert.equal(received.overall_timeout_ms, 1000);
  assert.throws(() => beginWalletHistoryAcquisitionV1(createWalletHistoryPortV1(capability()), budgets), error => error.code === 'acquisition_capability_denied' && !JSON.stringify(error).includes('2000'));
});
