#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildMarkObservationV1 } from './mark-observations.mjs';
import { GENESIS_HASH } from './schema.mjs';
import { buildOpenPositionSnapshotV1 } from './open-snapshot.mjs';

const boundary = {
  boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta',
  genesis_hash: GENESIS_HASH, commitment: 'finalized', anchor_slot: 100, anchor_block_time: 1000,
  anchor_blockhash: 'blockhash', history_complete_through_anchor: true, lower_bound_completion_proven: true,
  boundary_status: 'proven',
};
const position = {
  candidate_type: 'realized_partial', token_mint: 'TOKEN', quote_mint: 'QUOTE', remaining_qty: 4,
  remaining_cost_basis_quote: 6, realized_pnl_quote: 2, realized_pnl_pct: 20,
};
const fresh = buildMarkObservationV1({
  token_mint: 'TOKEN', quote_mint: 'QUOTE', observation_status: 'available', source_profile: 'direct_quote_mark_v1',
  mark_price_raw_quote: 3, observed_at: 990, source_slot: 99, reason_code: null,
});
const snapshot = buildOpenPositionSnapshotV1({ position, boundary, markObservation: fresh });
assert.equal(snapshot.snapshot_version, 'open_position_snapshot_v1');
assert.equal(snapshot.snapshot_at, boundary.anchor_block_time);
assert.equal(snapshot.source_boundary.source_slot, boundary.anchor_slot);
assert.equal(snapshot.mark.freshness_status, 'fresh');
assert.equal(snapshot.unrealized_pnl.market_value_quote, 12);
assert.equal(snapshot.unrealized_pnl.unrealized_pnl_quote, 6);
assert.equal(snapshot.unrealized_pnl.unrealized_pnl_pct, 100);
assert.deepEqual(snapshot.disclosure_codes, ['open_outcome_not_final', 'partial_exit_position_remains_open']);
assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.mark));

const stale = buildMarkObservationV1({
  token_mint: 'TOKEN', quote_mint: 'QUOTE', observation_status: 'unavailable', source_profile: 'direct_quote_mark_v1',
  mark_price_raw_quote: null, observed_at: null, source_slot: null, reason_code: 'mark_stale',
});
const staleSnapshot = buildOpenPositionSnapshotV1({ position, boundary, markObservation: stale });
assert.equal(staleSnapshot.mark.status, 'unavailable');
assert.equal(staleSnapshot.mark.freshness_status, 'stale');
assert.equal(staleSnapshot.unrealized_pnl, null);

const mismatch = buildMarkObservationV1({
  token_mint: 'TOKEN', quote_mint: 'OTHER-QUOTE', observation_status: 'available', source_profile: 'direct_quote_mark_v1',
  mark_price_raw_quote: 3, observed_at: 990, source_slot: 99, reason_code: null,
});
const mismatchSnapshot = buildOpenPositionSnapshotV1({ position, boundary, markObservation: mismatch });
assert.equal(mismatchSnapshot.mark.reason_code, 'mark_quote_mismatch');
assert.equal(mismatchSnapshot.unrealized_pnl, null);

const future = buildMarkObservationV1({
  token_mint: 'TOKEN', quote_mint: 'QUOTE', observation_status: 'available', source_profile: 'direct_quote_mark_v1',
  mark_price_raw_quote: 3, observed_at: 1001, source_slot: 99, reason_code: null,
});
const futureSnapshot = buildOpenPositionSnapshotV1({ position, boundary, markObservation: future });
assert.equal(futureSnapshot.mark.freshness_status, 'after_boundary');
assert.equal(futureSnapshot.unrealized_pnl, null);
assert.throws(() => buildOpenPositionSnapshotV1({ position, boundary: null, markObservation: null }), error => error.code === 'snapshot_boundary_unavailable');
console.log('candidate-set open snapshots: PASS');
