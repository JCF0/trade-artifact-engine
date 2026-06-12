#!/usr/bin/env node
/**
 * Receipt Candidate Generator — B1 Tests
 *
 * All synthetic fixtures. No API calls, no file I/O, no cached data dependency.
 * Fixed timestamps throughout for deterministic output.
 *
 * Tests:
 *   1.  Single clean closed → closed_position (both eligible)
 *   2.  Closed + mixed_quote → both eligibility false
 *   3.  Closed + partial_history → both eligibility false
 *   4.  Closed + unsupported_inventory → both eligibility false
 *   5.  Open with sells, clean → realized_partial (verified eligible, closed not)
 *   6.  Open with sells + mixed_quote → verified not eligible
 *   7.  Open no sells, clean → open_snapshot (verified eligible, closed not)
 *   8.  Open no sells + partial_history → verified not eligible
 *   9.  Empty ledger → empty candidates
 *   10. Multiple tokens → correct candidate count
 *   11. candidate_hash determinism
 *   12. candidate_hash differs from v1.1 verification_hash formula
 *   13. valuation_status === "raw_quote" always
 *   14. snapshot_at uses explicit param
 *   15. snapshot_at falls back to last_event_at
 *   16. Flags in hash, warnings excluded from hash
 */

import { generateReceiptCandidates, computeCandidateHash } from './receipt-candidates.mjs';
import { createHash } from 'crypto';

// ── Constants ──
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const TOKEN_A   = 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B   = 'TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const WALLET    = 'TestWallet1111111111111111111111111111111111';

// ── Test harness ──
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const eq = typeof expected === 'number'
    ? Math.abs(actual - expected) < 1e-8
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { pass++; }
  else { console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}

function section(title) { console.log(`\n── ${title} ──`); }

// ── Fixture helpers ──

function makeClosedSegment(overrides = {}) {
  return {
    token_mint: TOKEN_A,
    segment_index: 0,
    quote_mint: SOL_MINT,
    quote_symbol: 'SOL',
    valuation_status: 'raw_quote',
    total_bought_qty: 100,
    total_bought_quote: 0.5,
    avg_buy_quote_price: 0.005,
    total_sold_qty: 100,
    total_sold_quote: 0.6,
    avg_sell_quote_price: 0.006,
    allocated_cost_basis_quote: 0.5,
    remaining_qty: 0,
    remaining_cost_basis_quote: 0,
    realized_pnl_quote: 0.1,
    realized_pnl_pct: 20,
    unrealized_pnl_quote: null,
    unrealized_pnl_pct: null,
    total_pnl_quote: 0.1,
    total_pnl_pct: 20,
    status: 'closed',
    flags: ['dust_closed'],
    unaccounted_sold_qty: 0,
    unaccounted_sold_quote: 0,
    events: [
      { tx_hash: 'buy_tx_aaa', timestamp: 1000000, raw_index: 0, action: 'buy', base_qty: 100, quote_amount: 0.5, quote_mint: SOL_MINT },
      { tx_hash: 'sell_tx_bbb', timestamp: 1000100, raw_index: 1, action: 'sell', base_qty: 100, quote_amount: 0.6, quote_mint: SOL_MINT },
    ],
    first_event_at: 1000000,
    last_event_at: 1000100,
    accounting_method_version: 'weighted_average_position_accounting_v1',
    ...overrides,
  };
}

function makeOpenPosition(overrides = {}) {
  return {
    token_mint: TOKEN_A,
    segment_index: 0,
    quote_mint: SOL_MINT,
    quote_symbol: 'SOL',
    valuation_status: 'raw_quote',
    total_bought_qty: 200,
    total_bought_quote: 1.0,
    avg_buy_quote_price: 0.005,
    total_sold_qty: 50,
    total_sold_quote: 0.35,
    avg_sell_quote_price: 0.007,
    allocated_cost_basis_quote: 0.25,
    remaining_qty: 150,
    remaining_cost_basis_quote: 0.75,
    realized_pnl_quote: 0.1,
    realized_pnl_pct: 40,
    unrealized_pnl_quote: null,
    unrealized_pnl_pct: null,
    total_pnl_quote: null,
    total_pnl_pct: null,
    status: 'open',
    flags: [],
    unaccounted_sold_qty: 0,
    unaccounted_sold_quote: 0,
    events: [
      { tx_hash: 'buy_tx_ccc', timestamp: 2000000, raw_index: 0, action: 'buy', base_qty: 200, quote_amount: 1.0, quote_mint: SOL_MINT },
      { tx_hash: 'sell_tx_ddd', timestamp: 2000500, raw_index: 1, action: 'sell', base_qty: 50, quote_amount: 0.35, quote_mint: SOL_MINT },
    ],
    first_event_at: 2000000,
    last_event_at: 2000500,
    accounting_method_version: 'weighted_average_position_accounting_v1',
    ...overrides,
  };
}

function makeOpenNoSells(overrides = {}) {
  return {
    token_mint: TOKEN_A,
    segment_index: 0,
    quote_mint: SOL_MINT,
    quote_symbol: 'SOL',
    valuation_status: 'raw_quote',
    total_bought_qty: 300,
    total_bought_quote: 1.5,
    avg_buy_quote_price: 0.005,
    total_sold_qty: 0,
    total_sold_quote: 0,
    avg_sell_quote_price: 0,
    allocated_cost_basis_quote: 0,
    remaining_qty: 300,
    remaining_cost_basis_quote: 1.5,
    realized_pnl_quote: 0,
    realized_pnl_pct: 0,
    unrealized_pnl_quote: null,
    unrealized_pnl_pct: null,
    total_pnl_quote: null,
    total_pnl_pct: null,
    status: 'open',
    flags: [],
    unaccounted_sold_qty: 0,
    unaccounted_sold_quote: 0,
    events: [
      { tx_hash: 'buy_tx_eee', timestamp: 3000000, raw_index: 0, action: 'buy', base_qty: 300, quote_amount: 1.5, quote_mint: SOL_MINT },
    ],
    first_event_at: 3000000,
    last_event_at: 3000000,
    accounting_method_version: 'weighted_average_position_accounting_v1',
    ...overrides,
  };
}

function makeLedger(closedSegments, openPositions) {
  const positionsByMint = new Map();
  for (const p of openPositions) {
    positionsByMint.set(p.token_mint, p);
  }
  return {
    closedSegments,
    positionsByMint,
    accountingMethodVersion: 'weighted_average_position_accounting_v1',
    eventCount: 0,
    processedCount: 0,
    skippedCount: 0,
  };
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  B1 — Receipt Candidate Generator Tests                 ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ── Test 1: Single clean closed → closed_position ──
section('Test 1: Clean closed_position');
{
  const ledger = makeLedger([makeClosedSegment()], []);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  check('Count', candidates.length, 1);
  const c = candidates[0];
  check('candidate_type', c.candidate_type, 'closed_position');
  check('receipt_scope', c.receipt_scope, 'closed_position');
  check('eligible_for_verified_receipt', c.eligible_for_verified_receipt, true);
  check('eligible_for_closed_position_receipt', c.eligible_for_closed_position_receipt, true);
  check('status', c.status, 'closed');
  check('realized_pnl_quote', c.realized_pnl_quote, 0.1);
  check('wallet', c.wallet, WALLET);
  check('chain', c.chain, 'solana');
  check('candidate_id starts with lrc_', c.candidate_id.startsWith('lrc_closed_position_'), true);
  check('hold_time_seconds', c.hold_time_seconds, 100);
  check('snapshot_at', c.snapshot_at, null);
  check('num_buys', c.num_buys, 1);
  check('num_sells', c.num_sells, 1);
}

// ── Test 2: Closed + mixed_quote ──
section('Test 2: Closed + mixed_quote');
{
  const seg = makeClosedSegment({ flags: ['dust_closed', 'mixed_quote'], quote_mint: 'MIXED', quote_symbol: 'MIXED' });
  const ledger = makeLedger([seg], []);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  const c = candidates[0];
  check('eligible_for_verified_receipt', c.eligible_for_verified_receipt, false);
  check('eligible_for_closed_position_receipt', c.eligible_for_closed_position_receipt, false);
  check('has mixed_quote warning', c.warnings.includes('mixed_quote_not_verified'), true);
}

// ── Test 3: Closed + partial_history ──
section('Test 3: Closed + partial_history');
{
  const seg = makeClosedSegment({ flags: ['partial_history'] });
  const ledger = makeLedger([seg], []);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  const c = candidates[0];
  check('eligible_for_verified_receipt', c.eligible_for_verified_receipt, false);
  check('eligible_for_closed_position_receipt', c.eligible_for_closed_position_receipt, false);
  check('has partial_history warning', c.warnings.includes('partial_history_pnl_unreliable'), true);
}

// ── Test 4: Closed + unsupported_inventory ──
section('Test 4: Closed + unsupported_inventory');
{
  const seg = makeClosedSegment({ flags: ['unsupported_inventory'] });
  const ledger = makeLedger([seg], []);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  const c = candidates[0];
  check('eligible_for_verified_receipt', c.eligible_for_verified_receipt, false);
  check('eligible_for_closed_position_receipt', c.eligible_for_closed_position_receipt, false);
  check('has unsupported warning', c.warnings.includes('unsupported_inventory_detected'), true);
}

// ── Test 5: Open with sells, clean → realized_partial ──
section('Test 5: Clean realized_partial');
{
  const ledger = makeLedger([], [makeOpenPosition()]);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  check('Count', candidates.length, 1);
  const c = candidates[0];
  check('candidate_type', c.candidate_type, 'realized_partial');
  check('receipt_scope', c.receipt_scope, 'realized_partial');
  check('eligible_for_verified_receipt', c.eligible_for_verified_receipt, true);
  check('eligible_for_closed_position_receipt', c.eligible_for_closed_position_receipt, false);
  check('realized_pnl_quote populated', c.realized_pnl_quote, 0.1);
  check('has position_still_open warning', c.warnings.includes('position_still_open'), true);
  check('snapshot_at is null', c.snapshot_at, null);
  check('hold_time_seconds', c.hold_time_seconds, 500);
  check('total_sold_qty populated', c.total_sold_qty, 50);
}

// ── Test 6: Open with sells + mixed_quote ──
section('Test 6: realized_partial + mixed_quote');
{
  const pos = makeOpenPosition({ flags: ['mixed_quote'], quote_mint: 'MIXED', quote_symbol: 'MIXED' });
  const ledger = makeLedger([], [pos]);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  const c = candidates[0];
  check('eligible_for_verified_receipt', c.eligible_for_verified_receipt, false);
  check('has mixed_quote warning', c.warnings.includes('mixed_quote_not_verified'), true);
  check('has position_still_open warning', c.warnings.includes('position_still_open'), true);
}

// ── Test 7: Open no sells, clean → open_snapshot ──
section('Test 7: Clean open_snapshot');
{
  const ledger = makeLedger([], [makeOpenNoSells()]);
  const candidates = generateReceiptCandidates(ledger, WALLET, { snapshotAt: 9999999 });
  check('Count', candidates.length, 1);
  const c = candidates[0];
  check('candidate_type', c.candidate_type, 'open_snapshot');
  check('receipt_scope', c.receipt_scope, 'open_snapshot');
  check('eligible_for_verified_receipt', c.eligible_for_verified_receipt, true);
  check('eligible_for_closed_position_receipt', c.eligible_for_closed_position_receipt, false);
  check('realized_pnl_quote is null', c.realized_pnl_quote, null);
  check('realized_pnl_pct is null', c.realized_pnl_pct, null);
  check('total_sold_qty is null', c.total_sold_qty, null);
  check('total_sold_quote is null', c.total_sold_quote, null);
  check('allocated_cost_basis_quote is null', c.allocated_cost_basis_quote, null);
  check('avg_sell_quote_price is null', c.avg_sell_quote_price, null);
  check('snapshot_at uses explicit param', c.snapshot_at, 9999999);
  check('hold_time_seconds is null', c.hold_time_seconds, null);
  check('has no_realized_pnl warning', c.warnings.includes('no_realized_pnl'), true);
  check('has snapshot_no_live_price warning', c.warnings.includes('snapshot_no_live_price'), true);
  check('unrealized_pnl_quote is null', c.unrealized_pnl_quote, null);
  check('unrealized_pnl_pct is null', c.unrealized_pnl_pct, null);
}

// ── Test 8: Open no sells + partial_history ──
section('Test 8: open_snapshot + partial_history');
{
  const pos = makeOpenNoSells({ flags: ['partial_history', 'external_transfer_possible'], status: 'partial_history' });
  const ledger = makeLedger([], [pos]);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  const c = candidates[0];
  check('candidate_type', c.candidate_type, 'open_snapshot');
  check('eligible_for_verified_receipt', c.eligible_for_verified_receipt, false);
  check('has partial_history warning', c.warnings.includes('partial_history_pnl_unreliable'), true);
  check('has external_transfer warning', c.warnings.includes('external_transfer_possible'), true);
}

// ── Test 9: Empty ledger → empty candidates ──
section('Test 9: Empty ledger');
{
  const ledger = makeLedger([], []);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  check('Empty', candidates.length, 0);
}

// ── Test 10: Multiple tokens → correct candidate count ──
section('Test 10: Multiple tokens');
{
  const seg1 = makeClosedSegment({ token_mint: TOKEN_A, segment_index: 0 });
  const seg2 = makeClosedSegment({ token_mint: TOKEN_B, segment_index: 0 });
  const open1 = makeOpenNoSells({ token_mint: 'TokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' });
  const ledger = makeLedger([seg1, seg2], [open1]);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  check('Total candidates', candidates.length, 3);
  check('closed count', candidates.filter(c => c.candidate_type === 'closed_position').length, 2);
  check('snapshot count', candidates.filter(c => c.candidate_type === 'open_snapshot').length, 1);
}

// ── Test 11: candidate_hash determinism ──
section('Test 11: Hash determinism');
{
  const ledger = makeLedger([makeClosedSegment()], []);
  const run1 = generateReceiptCandidates(ledger, WALLET);
  const run2 = generateReceiptCandidates(ledger, WALLET);
  check('Same hash twice', run1[0].candidate_hash, run2[0].candidate_hash);
  check('Hash is 64 hex chars', run1[0].candidate_hash.length, 64);
  check('Hash is hex', /^[0-9a-f]{64}$/.test(run1[0].candidate_hash), true);
}

// ── Test 12: candidate_hash differs from v1.1 verification_hash ──
section('Test 12: Hash isolation from v1.1');
{
  const seg = makeClosedSegment();
  const ledger = makeLedger([seg], []);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  const candidateHash = candidates[0].candidate_hash;

  // Simulate v1.1 verification_hash formula
  const entryHashes = ['buy_tx_aaa'];
  const exitHashes = ['sell_tx_bbb'];
  const v11Payload = JSON.stringify([WALLET, 'solana', TOKEN_A, entryHashes, exitHashes, 0.005, 0.006, 'weighted_average_cost_basis', '1.0', 'verified']);
  const v11Hash = createHash('sha256').update(v11Payload).digest('hex');

  check('Hashes differ', candidateHash !== v11Hash, true);
}

// ── Test 13: valuation_status always raw_quote ──
section('Test 13: valuation_status');
{
  const ledger = makeLedger([makeClosedSegment()], [makeOpenPosition(), makeOpenNoSells({ token_mint: TOKEN_B })]);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  for (const c of candidates) {
    check(`${c.candidate_type} valuation_status`, c.valuation_status, 'raw_quote');
  }
}

// ── Test 14: snapshot_at uses explicit param ──
section('Test 14: Explicit snapshot_at');
{
  const ledger = makeLedger([], [makeOpenNoSells()]);
  const candidates = generateReceiptCandidates(ledger, WALLET, { snapshotAt: 5555555 });
  check('snapshot_at', candidates[0].snapshot_at, 5555555);
}

// ── Test 15: snapshot_at falls back to last_event_at ──
section('Test 15: snapshot_at fallback');
{
  const pos = makeOpenNoSells();
  const ledger = makeLedger([], [pos]);
  const candidates = generateReceiptCandidates(ledger, WALLET);
  check('snapshot_at fallback', candidates[0].snapshot_at, pos.last_event_at);
}

// ── Test 16: Flags in hash, warnings excluded ──
section('Test 16: Flags in hash, warnings excluded');
{
  // Two segments identical except flags differ
  const seg1 = makeClosedSegment({ flags: ['dust_closed'] });
  const seg2 = makeClosedSegment({ flags: ['dust_closed', 'mixed_quote'] });
  const ledger1 = makeLedger([seg1], []);
  const ledger2 = makeLedger([seg2], []);
  const c1 = generateReceiptCandidates(ledger1, WALLET)[0];
  const c2 = generateReceiptCandidates(ledger2, WALLET)[0];
  check('Different flags → different hash', c1.candidate_hash !== c2.candidate_hash, true);

  // Warnings are derived, so same flags → same hash regardless of warning text changes
  // (This is inherently true since warnings aren't in the hash payload, but verify the hash is stable)
  const c1b = generateReceiptCandidates(ledger1, WALLET)[0];
  check('Same flags → same hash', c1.candidate_hash, c1b.candidate_hash);
}

// ══════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(58)}`);
if (fail === 0) {
  console.log(`✅ ALL ${pass} CHECKS PASSED — receipt-candidates B1 is solid`);
} else {
  console.log(`❌ ${fail} FAILED, ${pass} passed — ISSUES DETECTED`);
}
console.log('═'.repeat(58));

process.exit(fail > 0 ? 1 : 0);
