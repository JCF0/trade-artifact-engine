#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildPositionLedger } from '../ledger/position-ledger.mjs';
import { computeCandidateHash, generateReceiptCandidates } from '../ledger/receipt-candidates.mjs';
import { buildCandidateV1, buildEventRecordV1 } from './identity.mjs';
import { buildReceiptScopedEvidenceV1 } from './receipt-scoped-evidence.mjs';
import { projectCandidateV1 } from './project-candidate.mjs';
import { buildMarkObservationV1 } from './mark-observations.mjs';
import { candidateDigestPreimage } from './identity.mjs';
import { GENESIS_HASH } from './schema.mjs';

const WALLET = 'wallet';
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const boundary = { boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, commitment: 'finalized', anchor_slot: 100, anchor_block_time: 1000, anchor_blockhash: 'blockhash', history_complete_through_anchor: true, lower_bound_completion_proven: true, boundary_status: 'proven' };
function raw({ token, timestamp, tx, index, buy, base = 5, quote = 10 }) {
  return { wallet: WALLET, timestamp, tx_hash: tx, source: 'swap', token_in_mint: buy ? QUOTE : token, token_in_amount: buy ? quote : base, token_in_decimals: 6, token_out_mint: buy ? token : QUOTE, token_out_amount: buy ? base : quote, token_out_decimals: 6, extraction_method: 'balance_delta', raw_index: index };
}
function records(events) { return events.map((event, index) => buildEventRecordV1({ source_slot: 10 + index, slice7_event: event })); }
function projectionFor(events, token, markObservation = null) {
  const legacy = generateReceiptCandidates(buildPositionLedger(events), WALLET, { snapshotAt: boundary.anchor_block_time }).find(item => item.token_mint === token);
  const evidence = buildReceiptScopedEvidenceV1({ wallet: WALLET, tokenMint: token, normalizedEventRecords: records(events) });
  return projectCandidateV1({ ledgerCandidate: legacy, receiptScopedEvidence: evidence, boundary, markObservation, associatedFindings: [] });
}

const closedEvents = [
  raw({ token: 'CLOSED', timestamp: 0, tx: 'buy-closed', index: 0, buy: true }),
  raw({ token: 'OTHER', timestamp: 150, tx: 'buy-other', index: 1, buy: true }),
  raw({ token: 'CLOSED', timestamp: 200, tx: 'sell-closed', index: 2, buy: false, quote: 15 }),
];
const closed = projectionFor(closedEvents, 'CLOSED');
assert.equal(closed.projection.candidate_type, 'closed_position');
assert.equal(closed.projection.position_status, 'closed');
assert.equal(closed.projection.selection_status, 'selectable');
assert.equal(closed.projection.package_eligibility, 'eligible_closed_position_v1');
assert.equal(closed.projection.economics_status, 'available');
assert.equal(closed.projection.economics.realized_pnl_quote, 5);
assert.equal(closed.projection.economics.remaining_qty, 0);
assert.equal(closed.projection.economics.remaining_cost_basis_quote, 0);
assert.equal(closed.projection.economics.hold_time_seconds, 200);
assert.equal(closed.projection.economics.entry_count, 1);
assert.equal(closed.projection.economics.exit_count, 1);
assert.equal(closed.projection.snapshot, null);
assert.deepEqual(Object.keys(candidateDigestPreimage(closed)), ['candidate_identity_version','receipt_scoped_evidence_digest','ledger_candidate_hash','projection']);
assert.equal(closed.candidate_id, `acv1_${closed.candidate_digest}`);

const forgedClosed = structuredClone(generateReceiptCandidates(buildPositionLedger(closedEvents), WALLET)[0]);
forgedClosed.total_bought_quote = 1;
forgedClosed.realized_pnl_quote = 14;
forgedClosed.candidate_hash = computeCandidateHash(forgedClosed);
const closedEvidence = buildReceiptScopedEvidenceV1({ wallet: WALLET, tokenMint: 'CLOSED', normalizedEventRecords: records(closedEvents) });
assert.throws(() => projectCandidateV1({ ledgerCandidate: forgedClosed, receiptScopedEvidence: closedEvidence, boundary, markObservation: null, associatedFindings: [] }), error => error.code === 'ledger_candidate_reconstruction_mismatch');

const partialEvents = [
  raw({ token: 'PARTIAL', timestamp: 300, tx: 'buy-partial', index: 0, buy: true, base: 10, quote: 20 }),
  raw({ token: 'PARTIAL', timestamp: 400, tx: 'sell-partial', index: 1, buy: false, base: 2, quote: 6 }),
];
const mark = buildMarkObservationV1({ token_mint: 'PARTIAL', quote_mint: QUOTE, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 4, observed_at: 990, source_slot: 99, reason_code: null });
const partial = projectionFor(partialEvents, 'PARTIAL', mark);
assert.equal(partial.projection.candidate_type, 'realized_partial');
assert.equal(partial.projection.position_status, 'open');
assert.equal(partial.projection.selection_status, 'visible_only');
assert.equal(partial.projection.package_eligibility, 'not_publication_eligible_v1');
assert.equal(partial.projection.economics.realized_pnl_quote, 2);
assert.equal(partial.projection.economics.remaining_qty, 8);
assert.equal(partial.projection.economics.remaining_cost_basis_quote, 16);
assert.equal(partial.projection.snapshot.snapshot_at, 1000);
assert.deepEqual(partial.projection.disclosure_codes, ['open_outcome_not_final','partial_exit_position_remains_open']);

const open = projectionFor([raw({ token: 'OPEN', timestamp: 500, tx: 'buy-open', index: 0, buy: true, base: 4, quote: 8 })], 'OPEN');
assert.equal(open.projection.candidate_type, 'open_snapshot');
assert.equal(open.projection.economics.realized_pnl_to_date_quote, 0);
assert.equal(open.projection.snapshot.unrealized_pnl, null);
assert.equal(open.projection.valuation_status, 'mark_unavailable');

const freshOpenMark = buildMarkObservationV1({ token_mint: 'OPEN', quote_mint: QUOTE, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 3, observed_at: 1000, source_slot: 100, reason_code: null });
const markedOpen = projectionFor([raw({ token: 'OPEN', timestamp: 500, tx: 'buy-open', index: 0, buy: true, base: 4, quote: 8 })], 'OPEN', freshOpenMark);
const forgedOldFreshProjection = structuredClone(markedOpen.projection);
forgedOldFreshProjection.snapshot.mark.mark_observed_at = 699;
assert.throws(() => buildCandidateV1({
  ledger_candidate_hash: markedOpen.ledger_candidate_hash,
  receipt_scoped_evidence_digest: markedOpen.receipt_scoped_evidence_digest,
  selection_key: markedOpen.selection_key,
  projection: forgedOldFreshProjection,
}), error => error.code === 'mark_observation_invalid');
const forgedMarkProfile = structuredClone(markedOpen.projection);
forgedMarkProfile.snapshot.mark.mark_profile = 'attacker_profile_v1';
assert.throws(() => buildCandidateV1({
  ledger_candidate_hash: markedOpen.ledger_candidate_hash,
  receipt_scoped_evidence_digest: markedOpen.receipt_scoped_evidence_digest,
  selection_key: markedOpen.selection_key,
  projection: forgedMarkProfile,
}), error => error.code === 'unsupported_profile');

const limitedMark = buildMarkObservationV1({ token_mint: 'LIMITED', quote_mint: QUOTE, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 4, observed_at: 990, source_slot: 99, reason_code: null });
const limited = projectionFor([raw({ token: 'LIMITED', timestamp: 600, tx: 'sell-limited', index: 0, buy: false, base: 3, quote: 9 })], 'LIMITED', limitedMark);
assert.equal(limited.projection.ledger_evidence_status, 'limited_partial_history');
assert.equal(limited.projection.selection_status, 'visible_only');
assert.equal(limited.projection.package_eligibility, 'not_publication_eligible_v1');
assert.equal(limited.projection.economics_status, 'unavailable_partial_history');
assert.equal(limited.projection.economics, null);
assert.equal(limited.projection.snapshot, null);
assert.equal(limited.projection.valuation_status, 'unavailable');
assert.ok(limited.projection.reason_codes.includes('partial_history_boundary'));
assert.ok(limited.projection.reason_codes.includes('unobserved_pre_window_inventory'));
assert.ok(limited.projection.disclosure_codes.includes('history_begins_mid_position'));
assert.ok(limited.projection.limitations.includes('partial_history_pnl_unreliable'));
assert.ok(Object.isFrozen(limited) && Object.isFrozen(limited.projection));

const partiallyObservedEvents = [
  raw({ token: 'PARTIALLY-OBSERVED', timestamp: 600, tx: 'partial-observed-buy', index: 0, buy: true, base: 1, quote: 2 }),
  raw({ token: 'PARTIALLY-OBSERVED', timestamp: 700, tx: 'partial-observed-sell', index: 1, buy: false, base: 3, quote: 9 }),
];
const partiallyObservedMark = buildMarkObservationV1({ token_mint: 'PARTIALLY-OBSERVED', quote_mint: QUOTE, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 4, observed_at: 990, source_slot: 99, reason_code: null });
const partiallyObserved = projectionFor(partiallyObservedEvents, 'PARTIALLY-OBSERVED', partiallyObservedMark);
assert.equal(partiallyObserved.projection.ledger_evidence_status, 'limited_partial_history');
assert.equal(partiallyObserved.projection.economics_status, 'unavailable_partial_history');
assert.equal(partiallyObserved.projection.economics, null);
assert.equal(partiallyObserved.projection.snapshot, null);
assert.equal(partiallyObserved.projection.valuation_status, 'unavailable');

const corruptLegacy = structuredClone(generateReceiptCandidates(buildPositionLedger(closedEvents), WALLET, { snapshotAt: 1000 }).find(item => item.token_mint === 'CLOSED'));
corruptLegacy.candidate_hash = 'f'.repeat(64);
const evidence = buildReceiptScopedEvidenceV1({ wallet: WALLET, tokenMint: 'CLOSED', normalizedEventRecords: records(closedEvents) });
assert.throws(() => projectCandidateV1({ ledgerCandidate: corruptLegacy, receiptScopedEvidence: evidence, boundary, markObservation: null, associatedFindings: [] }), error => error.code === 'ledger_candidate_hash_mismatch');
console.log('candidate-set candidate projections: PASS');
