#!/usr/bin/env node
/**
 * Receipt Promotion — B2 Tests
 *
 * All synthetic fixtures. No API calls, no file I/O, no cached data dependency.
 * Fixed timestamps throughout for deterministic output.
 *
 * Tests:
 *   1.  Clean closed_position → verified
 *   2.  Disqualified closed_position → unverified
 *   3.  Clean realized_partial → verified_partial
 *   4.  Disqualified realized_partial → unverified
 *   5.  Clean open_snapshot → verified_snapshot
 *   6.  Disqualified open_snapshot → unverified
 *   7.  Empty candidates → empty receipts
 *   8.  Multiple candidates → correct receipt count
 *   9.  receipt_hash determinism
 *   10. receipt_hash differs from v1.1 verification_hash
 *   11. receipt_hash differs from B1 candidate_hash
 *   12. verification_status in hash
 *   13. promoted_from traces to candidate_id
 *   14. promoted_at uses explicit param
 *   15. valuation_status always raw_quote
 *   16. no_usd_normalization disclosure always present
 *   17. limitations.pnl_type correct per type
 */

import { promoteReceiptCandidates, computeReceiptHash } from './receipt-promotion.mjs';
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

// ── Candidate fixture helpers (reuse B1 ledger fixtures → generateReceiptCandidates) ──

function makeClosedSegment(overrides = {}) {
  return {
    token_mint: TOKEN_A, segment_index: 0,
    quote_mint: SOL_MINT, quote_symbol: 'SOL', valuation_status: 'raw_quote',
    total_bought_qty: 100, total_bought_quote: 0.5, avg_buy_quote_price: 0.005,
    total_sold_qty: 100, total_sold_quote: 0.6, avg_sell_quote_price: 0.006,
    allocated_cost_basis_quote: 0.5, remaining_qty: 0, remaining_cost_basis_quote: 0,
    realized_pnl_quote: 0.1, realized_pnl_pct: 20,
    unrealized_pnl_quote: null, unrealized_pnl_pct: null,
    total_pnl_quote: 0.1, total_pnl_pct: 20,
    status: 'closed', flags: ['dust_closed'],
    unaccounted_sold_qty: 0, unaccounted_sold_quote: 0,
    events: [
      { tx_hash: 'buy_tx_aaa', timestamp: 1000000, raw_index: 0, action: 'buy', base_qty: 100, quote_amount: 0.5, quote_mint: SOL_MINT },
      { tx_hash: 'sell_tx_bbb', timestamp: 1000100, raw_index: 1, action: 'sell', base_qty: 100, quote_amount: 0.6, quote_mint: SOL_MINT },
    ],
    first_event_at: 1000000, last_event_at: 1000100,
    accounting_method_version: 'weighted_average_position_accounting_v1',
    ...overrides,
  };
}

function makeOpenPosition(overrides = {}) {
  return {
    token_mint: TOKEN_A, segment_index: 0,
    quote_mint: SOL_MINT, quote_symbol: 'SOL', valuation_status: 'raw_quote',
    total_bought_qty: 200, total_bought_quote: 1.0, avg_buy_quote_price: 0.005,
    total_sold_qty: 50, total_sold_quote: 0.35, avg_sell_quote_price: 0.007,
    allocated_cost_basis_quote: 0.25, remaining_qty: 150, remaining_cost_basis_quote: 0.75,
    realized_pnl_quote: 0.1, realized_pnl_pct: 40,
    unrealized_pnl_quote: null, unrealized_pnl_pct: null,
    total_pnl_quote: null, total_pnl_pct: null,
    status: 'open', flags: [],
    unaccounted_sold_qty: 0, unaccounted_sold_quote: 0,
    events: [
      { tx_hash: 'buy_tx_ccc', timestamp: 2000000, raw_index: 0, action: 'buy', base_qty: 200, quote_amount: 1.0, quote_mint: SOL_MINT },
      { tx_hash: 'sell_tx_ddd', timestamp: 2000500, raw_index: 1, action: 'sell', base_qty: 50, quote_amount: 0.35, quote_mint: SOL_MINT },
    ],
    first_event_at: 2000000, last_event_at: 2000500,
    accounting_method_version: 'weighted_average_position_accounting_v1',
    ...overrides,
  };
}

function makeOpenNoSells(overrides = {}) {
  return {
    token_mint: TOKEN_A, segment_index: 0,
    quote_mint: SOL_MINT, quote_symbol: 'SOL', valuation_status: 'raw_quote',
    total_bought_qty: 300, total_bought_quote: 1.5, avg_buy_quote_price: 0.005,
    total_sold_qty: 0, total_sold_quote: 0, avg_sell_quote_price: 0,
    allocated_cost_basis_quote: 0, remaining_qty: 300, remaining_cost_basis_quote: 1.5,
    realized_pnl_quote: 0, realized_pnl_pct: 0,
    unrealized_pnl_quote: null, unrealized_pnl_pct: null,
    total_pnl_quote: null, total_pnl_pct: null,
    status: 'open', flags: [],
    unaccounted_sold_qty: 0, unaccounted_sold_quote: 0,
    events: [
      { tx_hash: 'buy_tx_eee', timestamp: 3000000, raw_index: 0, action: 'buy', base_qty: 300, quote_amount: 1.5, quote_mint: SOL_MINT },
    ],
    first_event_at: 3000000, last_event_at: 3000000,
    accounting_method_version: 'weighted_average_position_accounting_v1',
    ...overrides,
  };
}

function makeLedger(closedSegments, openPositions) {
  const positionsByMint = new Map();
  for (const p of openPositions) positionsByMint.set(p.token_mint, p);
  return { closedSegments, positionsByMint, accountingMethodVersion: 'weighted_average_position_accounting_v1', eventCount: 0, processedCount: 0, skippedCount: 0 };
}

/** Helper: generate candidates then promote */
function candidatesAndReceipts(closedSegments, openPositions, opts = {}) {
  const ledger = makeLedger(closedSegments, openPositions);
  const candidates = generateReceiptCandidates(ledger, WALLET, opts);
  const receipts = promoteReceiptCandidates(candidates, opts);
  return { candidates, receipts };
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  B2 — Receipt Promotion Tests                          ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ── Test 1: Clean closed_position → verified ──
section('Test 1: Clean closed_position → verified');
{
  const { receipts } = candidatesAndReceipts([makeClosedSegment()], [], { promotedAt: 8000000 });
  check('Count', receipts.length, 1);
  const r = receipts[0];
  check('receipt_type', r.receipt_type, 'closed_position');
  check('verification_status', r.verification_status, 'verified');
  check('display_status', r.display_status, 'Verified Closed Position');
  check('receipt_version', r.receipt_version, '1.2.0');
  check('receipt_hash is 64 hex', /^[0-9a-f]{64}$/.test(r.receipt_hash), true);
  check('receipt_id prefix', r.receipt_id.startsWith('art_v12_cp_'), true);
  check('realized_pnl_quote', r.realized_pnl_quote, 0.1);
  check('position_status', r.position_status, 'closed');
  check('hold_time_seconds', r.hold_time_seconds, 100);
  check('snapshot_at null', r.snapshot_at, null);
  check('promoted_at', r.promoted_at, 8000000);
  check('wallet', r.wallet, WALLET);
  check('chain', r.chain, 'solana');
}

// ── Test 2: Disqualified closed_position → unverified ──
section('Test 2: Disqualified closed_position → unverified');
{
  const seg = makeClosedSegment({ flags: ['dust_closed', 'partial_history', 'external_transfer_possible'] });
  const { receipts } = candidatesAndReceipts([seg], [], { promotedAt: 8000000 });
  const r = receipts[0];
  check('verification_status', r.verification_status, 'unverified');
  check('display_status', r.display_status, 'Unverified — See Limitations');
  check('has partial_trade_history disclosure', r.limitations.disclosures.includes('partial_trade_history'), true);
  check('has external_transfer disclosure', r.limitations.disclosures.includes('external_transfer_possible'), true);
  check('has no_usd_normalization', r.limitations.disclosures.includes('no_usd_normalization'), true);
}

// ── Test 3: Clean realized_partial → verified_partial ──
section('Test 3: Clean realized_partial → verified_partial');
{
  const { receipts } = candidatesAndReceipts([], [makeOpenPosition()], { promotedAt: 8000000 });
  check('Count', receipts.length, 1);
  const r = receipts[0];
  check('receipt_type', r.receipt_type, 'realized_partial');
  check('verification_status', r.verification_status, 'verified_partial');
  check('display_status', r.display_status, 'Verified Partial (Position Open)');
  check('receipt_id prefix', r.receipt_id.startsWith('art_v12_rp_'), true);
  check('realized_pnl_quote', r.realized_pnl_quote, 0.1);
  check('position_status', r.position_status, 'open');
  check('has position_open disclosure', r.limitations.disclosures.includes('position_open'), true);
  check('pnl_type', r.limitations.pnl_type, 'realized_partial');
  check('price_source', r.limitations.price_source, 'on_chain_swaps');
}

// ── Test 4: Disqualified realized_partial → unverified ──
section('Test 4: Disqualified realized_partial → unverified');
{
  const pos = makeOpenPosition({ flags: ['mixed_quote'], quote_mint: 'MIXED', quote_symbol: 'MIXED' });
  const { receipts } = candidatesAndReceipts([], [pos], { promotedAt: 8000000 });
  const r = receipts[0];
  check('verification_status', r.verification_status, 'unverified');
  check('has mixed_quote_currencies disclosure', r.limitations.disclosures.includes('mixed_quote_currencies'), true);
  check('has position_open disclosure', r.limitations.disclosures.includes('position_open'), true);
}

// ── Test 5: Clean open_snapshot → verified_snapshot ──
section('Test 5: Clean open_snapshot → verified_snapshot');
{
  const { receipts } = candidatesAndReceipts([], [makeOpenNoSells()], { snapshotAt: 9999999, promotedAt: 8000000 });
  check('Count', receipts.length, 1);
  const r = receipts[0];
  check('receipt_type', r.receipt_type, 'open_snapshot');
  check('verification_status', r.verification_status, 'verified_snapshot');
  check('display_status', r.display_status, 'Verified Snapshot (No PnL Claim)');
  check('receipt_id prefix', r.receipt_id.startsWith('art_v12_os_'), true);
  check('realized_pnl_quote null', r.realized_pnl_quote, null);
  check('realized_pnl_pct null', r.realized_pnl_pct, null);
  check('unrealized_pnl_quote null', r.unrealized_pnl_quote, null);
  check('total_sold_qty null', r.total_sold_qty, null);
  check('snapshot_at', r.snapshot_at, 9999999);
  check('hold_time_seconds null', r.hold_time_seconds, null);
  check('has no_pnl_claim disclosure', r.limitations.disclosures.includes('no_pnl_claim'), true);
  check('has no_live_price disclosure', r.limitations.disclosures.includes('no_live_price'), true);
  check('pnl_type', r.limitations.pnl_type, 'none');
  check('price_source', r.limitations.price_source, 'none');
}

// ── Test 6: Disqualified open_snapshot → unverified ──
section('Test 6: Disqualified open_snapshot → unverified');
{
  const pos = makeOpenNoSells({ flags: ['partial_history', 'external_transfer_possible'], status: 'partial_history' });
  const { receipts } = candidatesAndReceipts([], [pos], { promotedAt: 8000000 });
  const r = receipts[0];
  check('verification_status', r.verification_status, 'unverified');
  check('has partial_trade_history', r.limitations.disclosures.includes('partial_trade_history'), true);
  check('has external_transfer_possible', r.limitations.disclosures.includes('external_transfer_possible'), true);
  check('has no_pnl_claim', r.limitations.disclosures.includes('no_pnl_claim'), true);
  check('has no_live_price', r.limitations.disclosures.includes('no_live_price'), true);
}

// ── Test 7: Empty candidates → empty receipts ──
section('Test 7: Empty');
{
  const { receipts } = candidatesAndReceipts([], []);
  check('Empty', receipts.length, 0);
}

// ── Test 8: Multiple candidates → correct receipt count ──
section('Test 8: Multiple candidates');
{
  const seg1 = makeClosedSegment({ token_mint: TOKEN_A });
  const seg2 = makeClosedSegment({ token_mint: TOKEN_B });
  const open1 = makeOpenNoSells({ token_mint: 'TokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' });
  const { receipts } = candidatesAndReceipts([seg1, seg2], [open1], { promotedAt: 8000000 });
  check('Total receipts', receipts.length, 3);
  check('closed count', receipts.filter(r => r.receipt_type === 'closed_position').length, 2);
  check('snapshot count', receipts.filter(r => r.receipt_type === 'open_snapshot').length, 1);
}

// ── Test 9: receipt_hash determinism ──
section('Test 9: Hash determinism');
{
  const { receipts: r1 } = candidatesAndReceipts([makeClosedSegment()], [], { promotedAt: 8000000 });
  const { receipts: r2 } = candidatesAndReceipts([makeClosedSegment()], [], { promotedAt: 8000000 });
  check('Same hash twice', r1[0].receipt_hash, r2[0].receipt_hash);
  check('Hash is 64 hex', /^[0-9a-f]{64}$/.test(r1[0].receipt_hash), true);
}

// ── Test 10: receipt_hash differs from v1.1 verification_hash ──
section('Test 10: Hash isolation from v1.1');
{
  const { receipts } = candidatesAndReceipts([makeClosedSegment()], [], { promotedAt: 8000000 });
  const rHash = receipts[0].receipt_hash;

  // Simulate v1.1 formula
  const entryHashes = ['buy_tx_aaa'];
  const exitHashes = ['sell_tx_bbb'];
  const v11Payload = JSON.stringify([WALLET, 'solana', TOKEN_A, entryHashes, exitHashes, 0.005, 0.006, 'weighted_average_cost_basis', '1.0', 'verified']);
  const v11Hash = createHash('sha256').update(v11Payload).digest('hex');

  check('Differs from v1.1', rHash !== v11Hash, true);
}

// ── Test 11: receipt_hash differs from B1 candidate_hash ──
section('Test 11: Hash isolation from B1');
{
  const { candidates, receipts } = candidatesAndReceipts([makeClosedSegment()], [], { promotedAt: 8000000 });
  check('Differs from candidate_hash', receipts[0].receipt_hash !== candidates[0].candidate_hash, true);
  // Also verify the candidate_hash is preserved
  check('candidate_hash preserved', receipts[0].candidate_hash, candidates[0].candidate_hash);
}

// ── Test 12: verification_status in hash ──
section('Test 12: verification_status affects hash');
{
  // Clean → verified
  const { receipts: r1 } = candidatesAndReceipts([makeClosedSegment()], [], { promotedAt: 8000000 });
  // Disqualified → unverified (same economic data, different status)
  const seg = makeClosedSegment({ flags: ['mixed_quote'], quote_mint: 'MIXED', quote_symbol: 'MIXED' });
  const { receipts: r2 } = candidatesAndReceipts([seg], [], { promotedAt: 8000000 });
  check('Different verification_status → different hash', r1[0].receipt_hash !== r2[0].receipt_hash, true);
}

// ── Test 13: promoted_from traces to candidate_id ──
section('Test 13: Provenance chain');
{
  const { candidates, receipts } = candidatesAndReceipts([makeClosedSegment()], [], { promotedAt: 8000000 });
  check('promoted_from matches candidate_id', receipts[0].promoted_from, candidates[0].candidate_id);
  check('source', receipts[0].source, 'position_ledger_v1');
}

// ── Test 14: promoted_at uses explicit param ──
section('Test 14: Explicit promoted_at');
{
  const { receipts } = candidatesAndReceipts([makeClosedSegment()], [], { promotedAt: 7777777 });
  check('promoted_at', receipts[0].promoted_at, 7777777);
}

// ── Test 15: valuation_status always raw_quote ──
section('Test 15: valuation_status');
{
  const { receipts } = candidatesAndReceipts(
    [makeClosedSegment()],
    [makeOpenPosition(), makeOpenNoSells({ token_mint: TOKEN_B })],
    { promotedAt: 8000000 }
  );
  for (const r of receipts) {
    check(`${r.receipt_type} valuation_status`, r.valuation_status, 'raw_quote');
  }
  check('limitations.valuation_currency', receipts[0].limitations.valuation_currency, 'raw_quote');
}

// ── Test 16: no_usd_normalization disclosure always present ──
section('Test 16: Global no_usd_normalization');
{
  const { receipts } = candidatesAndReceipts(
    [makeClosedSegment()],
    [makeOpenPosition(), makeOpenNoSells({ token_mint: TOKEN_B })],
    { promotedAt: 8000000 }
  );
  for (const r of receipts) {
    check(`${r.receipt_type} has no_usd_normalization`, r.limitations.disclosures.includes('no_usd_normalization'), true);
  }
}

// ── Test 17: limitations.pnl_type correct per type ──
section('Test 17: pnl_type per receipt type');
{
  const { receipts } = candidatesAndReceipts(
    [makeClosedSegment()],
    [makeOpenPosition(), makeOpenNoSells({ token_mint: TOKEN_B })],
    { promotedAt: 8000000 }
  );
  const byType = {};
  for (const r of receipts) byType[r.receipt_type] = r.limitations.pnl_type;
  check('closed_position pnl_type', byType['closed_position'], 'realized_closed');
  check('realized_partial pnl_type', byType['realized_partial'], 'realized_partial');
  check('open_snapshot pnl_type', byType['open_snapshot'], 'none');
}

// ══════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(58)}`);
if (fail === 0) {
  console.log(`✅ ALL ${pass} CHECKS PASSED — receipt-promotion B2 is solid`);
} else {
  console.log(`❌ ${fail} FAILED, ${pass} passed — ISSUES DETECTED`);
}
console.log('═'.repeat(58));

process.exit(fail > 0 ? 1 : 0);
