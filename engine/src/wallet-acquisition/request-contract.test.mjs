#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOOKBACK_SECONDS_BY_PROFILE_V1,
  SOLANA_MAINNET_GENESIS_HASH,
  buildWalletAcquisitionRequestV1,
  validateWalletAcquisitionRequestV1,
} from './request-contract.mjs';
import { WALLET_ACQUISITION_ERROR_CODES_V1 } from './errors.mjs';

const WALLET = '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni';

function validRequest(overrides = {}) {
  const request = {
    request_version: 'wallet_wide_acquisition_request_v1',
    chain: 'solana',
    network: 'mainnet-beta',
    genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    wallet: WALLET,
    window: {
      window_version: 'fixed_lookback_latest_state_v1',
      lookback_profile: 'lookback_7d_v1',
      requested_lookback_seconds: 604800,
      initial_before_signature: null,
    },
    finality: {
      commitment: 'finalized',
      boundary_profile: 'solana_finalized_anchor_v1',
      max_anchor_search_slots: 32,
    },
    budgets: {
      pagination_profile: 'helius_wallet_history_page_100_v1',
      page_size: 100,
      max_pages: 100,
      max_transactions: 10000,
      retry_profile: 'bounded_exponential_retry_v1',
      max_attempts_per_operation: 8,
      timeout_profile: 'bounded_provider_timeout_v1',
      request_timeout_ms: 60000,
      overall_timeout_ms: 300000,
    },
    profiles: {
      wallet_acquisition_profile: 'wallet_wide_bounded_history_v1',
      wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1',
    },
  };
  return { ...request, ...overrides };
}

function expectCode(fn, code) {
  assert.throws(fn, error => error?.name === 'WalletAcquisitionContractError' && error.code === code);
}

test('accepts and freezes every permitted lookback profile', () => {
  assert.deepEqual(LOOKBACK_SECONDS_BY_PROFILE_V1, {
    lookback_7d_v1: 604800,
    lookback_30d_v1: 2592000,
    lookback_90d_v1: 7776000,
    lookback_180d_v1: 15552000,
  });
  for (const [lookback_profile, requested_lookback_seconds] of Object.entries(LOOKBACK_SECONDS_BY_PROFILE_V1)) {
    const input = validRequest({ window: { ...validRequest().window, lookback_profile, requested_lookback_seconds } });
    const built = buildWalletAcquisitionRequestV1(input);
    assert.deepEqual(built, input);
    assert.ok(Object.isFrozen(built));
    assert.ok(Object.isFrozen(built.window));
    assert.ok(Object.isFrozen(built.budgets));
    input.window.lookback_profile = 'mutated';
    assert.equal(built.window.lookback_profile, lookback_profile);
    assert.doesNotThrow(() => validateWalletAcquisitionRequestV1(built));
  }
});

test('exports the exact stable sanitized Slice 1 error taxonomy', () => {
  assert.deepEqual(WALLET_ACQUISITION_ERROR_CODES_V1, [
    'invalid_acquisition_request',
    'unsupported_lookback_profile',
    'lookback_boundary_mismatch',
    'chain_identity_mismatch',
    'finalized_boundary_unavailable',
    'finalized_boundary_incoherent',
    'latest_state_unproven',
    'lower_bound_unproven',
    'pagination_incomplete',
    'pagination_cursor_invalid',
    'pagination_cursor_repeated',
    'pagination_order_invalid',
    'pagination_duplicate_conflict',
    'acquisition_capped',
    'acquisition_truncated',
    'provider_uncertain',
    'acquisition_deadline_exceeded',
  ]);
});

test('rejects every profile and seconds mismatch and arbitrary profiles', () => {
  const entries = Object.entries(LOOKBACK_SECONDS_BY_PROFILE_V1);
  for (const [profile, seconds] of entries) {
    for (const [, otherSeconds] of entries) {
      if (seconds === otherSeconds) continue;
      expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ window: { ...validRequest().window, lookback_profile: profile, requested_lookback_seconds: otherSeconds } })), 'lookback_boundary_mismatch');
    }
  }
  expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ window: { ...validRequest().window, lookback_profile: 'lookback_custom_v1' } })), 'unsupported_lookback_profile');
});

test('rejects a non-null initial cursor and unknown fixed identities', () => {
  expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ window: { ...validRequest().window, initial_before_signature: 'signature' } })), 'invalid_acquisition_request');
  for (const [field, value] of [['chain', 'ethereum'], ['network', 'devnet'], ['genesis_hash', 'wrong']]) {
    expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ [field]: value })), 'chain_identity_mismatch');
  }
  expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ finality: { ...validRequest().finality, commitment: 'confirmed' } })), 'invalid_acquisition_request');
  expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ finality: { ...validRequest().finality, boundary_profile: 'other' } })), 'invalid_acquisition_request');
  expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ profiles: { ...validRequest().profiles, wallet_acquisition_profile: 'other' } })), 'invalid_acquisition_request');
  expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ profiles: { ...validRequest().profiles, wallet_normalization_profile: 'other' } })), 'invalid_acquisition_request');
});

test('validates the Solana wallet and every fixed budget ceiling', () => {
  assert.doesNotThrow(() => validateWalletAcquisitionRequestV1(validRequest({ wallet: '1'.repeat(32) })));
  for (const wallet of ['', 'wallet', '0'.repeat(32), 'O'.repeat(32), 'a'.repeat(31), 'a'.repeat(45), 'z'.repeat(44), '1'.repeat(33)]) {
    expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ wallet })), 'invalid_acquisition_request');
  }
  const excessive = {
    max_pages: 101,
    max_transactions: 10001,
    max_attempts_per_operation: 9,
    request_timeout_ms: 60001,
    overall_timeout_ms: 300001,
  };
  for (const [field, value] of Object.entries(excessive)) {
    expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ budgets: { ...validRequest().budgets, [field]: value } })), 'invalid_acquisition_request');
  }
  for (const field of ['max_pages', 'max_transactions', 'max_attempts_per_operation', 'request_timeout_ms', 'overall_timeout_ms']) {
    expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ budgets: { ...validRequest().budgets, [field]: 0 } })), 'invalid_acquisition_request');
  }
  expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ budgets: { ...validRequest().budgets, page_size: 99 } })), 'invalid_acquisition_request');
  expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ budgets: { ...validRequest().budgets, request_timeout_ms: 60000, overall_timeout_ms: 60000 } })), 'invalid_acquisition_request');
  expectCode(() => validateWalletAcquisitionRequestV1(validRequest({ budgets: { ...validRequest().budgets, request_timeout_ms: 60001, overall_timeout_ms: 60000 } })), 'invalid_acquisition_request');
});

test('is closed at every request object boundary', () => {
  const top = validRequest(); top.extra = true;
  expectCode(() => validateWalletAcquisitionRequestV1(top), 'invalid_acquisition_request');
  for (const field of ['window', 'finality', 'budgets', 'profiles']) {
    const nested = validRequest(); nested[field].extra = true;
    expectCode(() => validateWalletAcquisitionRequestV1(nested), 'invalid_acquisition_request');
  }
  const forbidden = validRequest(); forbidden.provider_url = 'https://invalid.example';
  expectCode(() => validateWalletAcquisitionRequestV1(forbidden), 'invalid_acquisition_request');
});

test('rejects hostile non-plain request graphs without invoking accessors or proxy traps', () => {
  let accessorCalls = 0;
  const accessor = validRequest();
  Object.defineProperty(accessor, 'wallet', { enumerable: true, get() { accessorCalls += 1; return WALLET; } });
  expectCode(() => validateWalletAcquisitionRequestV1(accessor), 'invalid_acquisition_request');
  assert.equal(accessorCalls, 0);

  const proxy = new Proxy(validRequest(), { get() { throw new Error('trap invoked'); }, ownKeys() { throw new Error('trap invoked'); } });
  expectCode(() => validateWalletAcquisitionRequestV1(proxy), 'invalid_acquisition_request');

  const symbol = validRequest(); symbol[Symbol('secret')] = true;
  expectCode(() => validateWalletAcquisitionRequestV1(symbol), 'invalid_acquisition_request');

  const sparse = validRequest(); sparse.unexpected = new Array(2);
  expectCode(() => validateWalletAcquisitionRequestV1(sparse), 'invalid_acquisition_request');

  const custom = validRequest(); custom.window = Object.create({ inherited: true });
  Object.assign(custom.window, validRequest().window);
  expectCode(() => validateWalletAcquisitionRequestV1(custom), 'invalid_acquisition_request');

  const cyclic = validRequest(); cyclic.window.cycle = cyclic;
  expectCode(() => validateWalletAcquisitionRequestV1(cyclic), 'invalid_acquisition_request');
});

test('contract errors retain only fixed sanitized contract data', () => {
  try {
    validateWalletAcquisitionRequestV1(validRequest({ provider_url: 'https://secret.invalid/key' }));
    assert.fail('expected request rejection');
  } catch (error) {
    assert.equal(error.name, 'WalletAcquisitionContractError');
    assert.equal(error.code, 'invalid_acquisition_request');
    assert.deepEqual(error.details, {});
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(error.stack, undefined);
    assert.equal(JSON.stringify(error).includes('secret.invalid'), false);
  }
});
