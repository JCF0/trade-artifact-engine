#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceFinalizedAnchorSearchStateV1,
  buildFinalizedAcquisitionBoundaryV1,
  createFinalizedAnchorSearchStateV1,
  deriveOldestAllowedTimestampV1,
  validateFinalizedAcquisitionBoundaryV1,
  validateFinalizedAnchorSearchStateV1,
} from './boundary-contract.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from './request-contract.mjs';

const BLOCKHASH = '11111111111111111111111111111111';

function validBoundary(overrides = {}) {
  return {
    boundary_version: 'solana_finalized_acquisition_boundary_v1',
    chain: 'solana',
    network: 'mainnet-beta',
    genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    commitment: 'finalized',
    anchor_slot: 100,
    anchor_block_time: 15552000,
    anchor_blockhash: BLOCKHASH,
    history_complete_through_anchor: true,
    lower_bound_completion_proven: true,
    boundary_status: 'proven',
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error => error?.name === 'WalletAcquisitionContractError' && error.code === code);
}

test('builds a detached deeply frozen finalized boundary tuple', () => {
  const input = validBoundary();
  const boundary = buildFinalizedAcquisitionBoundaryV1(input);
  assert.deepEqual(boundary, input);
  assert.ok(Object.isFrozen(boundary));
  input.anchor_slot = 999;
  assert.equal(boundary.anchor_slot, 100);
  assert.doesNotThrow(() => validateFinalizedAcquisitionBoundaryV1(boundary));
});

test('rejects wrong chain identity, missing evidence, invalid slots, and unproven contradictions', () => {
  for (const mutation of [
    { chain: 'ethereum' }, { network: 'devnet' }, { genesis_hash: 'wrong' },
  ]) expectCode(() => validateFinalizedAcquisitionBoundaryV1(validBoundary(mutation)), 'chain_identity_mismatch');
  for (const mutation of [
    { commitment: 'confirmed' }, { boundary_version: 'other' }, { anchor_block_time: null },
    { anchor_blockhash: '' }, { anchor_slot: -1 }, { anchor_slot: Number.MAX_SAFE_INTEGER + 1 },
    { boundary_status: 'pending' },
  ]) expectCode(() => validateFinalizedAcquisitionBoundaryV1(validBoundary(mutation)), 'finalized_boundary_incoherent');
  expectCode(() => validateFinalizedAcquisitionBoundaryV1(validBoundary({ history_complete_through_anchor: false })), 'latest_state_unproven');
  expectCode(() => validateFinalizedAcquisitionBoundaryV1(validBoundary({ lower_bound_completion_proven: false })), 'lower_bound_unproven');
  const extra = validBoundary(); extra.provider = 'helius';
  expectCode(() => validateFinalizedAcquisitionBoundaryV1(extra), 'finalized_boundary_incoherent');
});

test('derives the exact nonnegative safe-integer lower timestamp', () => {
  assert.equal(deriveOldestAllowedTimestampV1({ anchor_block_time: 15552000, requested_lookback_seconds: 15552000 }), 0);
  assert.equal(deriveOldestAllowedTimestampV1({ anchor_block_time: 15552001, requested_lookback_seconds: 15552000 }), 1);
  expectCode(() => deriveOldestAllowedTimestampV1({ anchor_block_time: 604799, requested_lookback_seconds: 604800 }), 'lookback_boundary_mismatch');
  expectCode(() => deriveOldestAllowedTimestampV1({ anchor_block_time: Number.MAX_SAFE_INTEGER, requested_lookback_seconds: -1 }), 'lookback_boundary_mismatch');
  expectCode(() => deriveOldestAllowedTimestampV1({ anchor_block_time: Number.MAX_SAFE_INTEGER + 1, requested_lookback_seconds: 1 }), 'lookback_boundary_mismatch');
  expectCode(() => deriveOldestAllowedTimestampV1({ anchor_block_time: 10, requested_lookback_seconds: 1, extra: true }), 'lookback_boundary_mismatch');
});

test('models the exact 32-slot bounded unavailable-anchor search', () => {
  let state = createFinalizedAnchorSearchStateV1({ initial_slot: 100, max_anchor_search_slots: 32 });
  assert.deepEqual(state, {
    search_state_version: 'solana_finalized_anchor_search_state_v1',
    initial_slot: 100,
    next_slot: 100,
    slots_examined: 0,
    max_anchor_search_slots: 32,
    search_status: 'searching',
    anchor_slot: null,
  });
  for (let index = 0; index < 31; index += 1) state = advanceFinalizedAnchorSearchStateV1(state, 'unavailable');
  assert.equal(state.search_status, 'searching');
  assert.equal(state.slots_examined, 31);
  assert.equal(state.next_slot, 69);
  const foundOnLastAllowedSlot = advanceFinalizedAnchorSearchStateV1(state, 'found');
  assert.equal(foundOnLastAllowedSlot.search_status, 'found');
  assert.equal(foundOnLastAllowedSlot.slots_examined, 32);
  assert.equal(foundOnLastAllowedSlot.anchor_slot, 69);
  assert.equal(foundOnLastAllowedSlot.next_slot, null);

  state = advanceFinalizedAnchorSearchStateV1(state, 'unavailable');
  assert.equal(state.search_status, 'exhausted');
  assert.equal(state.slots_examined, 32);
  assert.equal(state.next_slot, null);
  assert.equal(state.anchor_slot, null);
  expectCode(() => advanceFinalizedAnchorSearchStateV1(state, 'found'), 'finalized_boundary_unavailable');
});

test('handles genesis-limited searches and rejects forged search-state relationships', () => {
  expectCode(() => createFinalizedAnchorSearchStateV1({ initial_slot: 100, max_anchor_search_slots: 31 }), 'finalized_boundary_incoherent');
  expectCode(() => createFinalizedAnchorSearchStateV1({ initial_slot: -1, max_anchor_search_slots: 32 }), 'finalized_boundary_incoherent');
  for (const initialSlot of [0, 1, 30, 31]) {
    let genesisState = createFinalizedAnchorSearchStateV1({ initial_slot: initialSlot, max_anchor_search_slots: 32 });
    while (genesisState.search_status === 'searching') genesisState = advanceFinalizedAnchorSearchStateV1(genesisState, 'unavailable');
    assert.equal(genesisState.search_status, 'exhausted');
    assert.equal(genesisState.slots_examined, Math.min(32, initialSlot + 1));
    assert.equal(validateFinalizedAnchorSearchStateV1(genesisState), true);
  }
  const forgedExhaustion = {
    ...createFinalizedAnchorSearchStateV1({ initial_slot: 0, max_anchor_search_slots: 32 }),
    next_slot: null,
    slots_examined: 32,
    search_status: 'exhausted',
  };
  expectCode(() => validateFinalizedAnchorSearchStateV1(forgedExhaustion), 'finalized_boundary_incoherent');
  const forged = { ...createFinalizedAnchorSearchStateV1({ initial_slot: 100, max_anchor_search_slots: 32 }), next_slot: 99 };
  expectCode(() => validateFinalizedAnchorSearchStateV1(forged), 'finalized_boundary_incoherent');
  expectCode(() => advanceFinalizedAnchorSearchStateV1(createFinalizedAnchorSearchStateV1({ initial_slot: 100, max_anchor_search_slots: 32 }), 'timeout'), 'finalized_boundary_incoherent');
});
