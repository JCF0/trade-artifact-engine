#!/usr/bin/env node
/**
 * Position Ledger — Slice 1A Tests
 *
 * All synthetic fixtures. No API calls, no file I/O, no cached data dependency.
 *
 * Tests:
 *   1.  single_buy_single_sell        — basic realized PnL
 *   2.  multi_buy_full_sell           — weighted average cost basis
 *   3.  multi_buy_partial_sell        — partial realized + remaining cost basis
 *   4.  full_close_then_reopen        — segment boundary handling
 *   5.  sell_before_buy               — partial_history flagging
 *   6.  sell_exceeds_remaining        — excess sell split + no fabricated PnL
 *   7.  mixed_quote_mints             — mixed_quote flagging
 *   8.  empty_events                  — safe empty output
 *   9.  determinism                   — identical input → identical output
 *   10. dust_close                    — dust threshold behavior
 *   11. economic_equivalence          — matches v1.1 for equivalent closed trades
 */

import { buildPositionLedger, classifyEvent, serializeLedger } from './position-ledger.mjs';

// ── Constants (from pipeline/constants.mjs) ──
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Fake token mints for testing
const TOKEN_A = 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// ── Test harness ──
let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const eq = typeof expected === 'number'
    ? Math.abs(actual - expected) < 1e-8
    : actual === expected;
  if (eq) {
    pass++;
  } else {
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

function checkTrue(label, value) {
  if (value) {
    pass++;
  } else {
    console.log(`  ❌ ${label}: expected truthy, got ${JSON.stringify(value)}`);
    fail++;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ── Event factory ──

let _txCounter = 0;

function makeBuyEvent(tokenMint, baseQty, quoteAmt, opts = {}) {
  _txCounter++;
  return {
    wallet: 'TestWallet',
    timestamp: opts.timestamp ?? (1000 + _txCounter),
    tx_hash: opts.tx_hash ?? `tx_${String(_txCounter).padStart(4, '0')}`,
    source: 'TEST',
    token_in_mint: opts.quoteMint ?? SOL_MINT,
    token_in_amount: quoteAmt,
    token_in_decimals: 9,
    token_out_mint: tokenMint,
    token_out_amount: baseQty,
    token_out_decimals: 9,
    extraction_method: 'synthetic',
    raw_index: opts.raw_index ?? _txCounter,
  };
}

function makeSellEvent(tokenMint, baseQty, quoteAmt, opts = {}) {
  _txCounter++;
  return {
    wallet: 'TestWallet',
    timestamp: opts.timestamp ?? (1000 + _txCounter),
    tx_hash: opts.tx_hash ?? `tx_${String(_txCounter).padStart(4, '0')}`,
    source: 'TEST',
    token_in_mint: tokenMint,
    token_in_amount: baseQty,
    token_in_decimals: 9,
    token_out_mint: opts.quoteMint ?? SOL_MINT,
    token_out_amount: quoteAmt,
    token_out_decimals: 9,
    extraction_method: 'synthetic',
    raw_index: opts.raw_index ?? _txCounter,
  };
}

function resetCounter() {
  _txCounter = 0;
}

// ═══════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Position Ledger — Slice 1A Tests                       ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ═══════════════════════════════════════════════════════════════
// Test 1: single_buy_single_sell
// ═══════════════════════════════════════════════════════════════
section('Test 1: single_buy_single_sell');
resetCounter();
{
  // Buy 100 tokens spending 100 SOL (price = 1.0 SOL/token)
  // Sell 100 tokens receiving 150 SOL (price = 1.5 SOL/token)
  const events = [
    makeBuyEvent(TOKEN_A, 100, 100),
    makeSellEvent(TOKEN_A, 100, 150),
  ];

  const result = buildPositionLedger(events);

  check('eventCount', result.eventCount, 2);
  check('processedCount', result.processedCount, 2);
  check('skippedCount', result.skippedCount, 0);
  check('closedSegments count', result.closedSegments.length, 1);
  check('positionsByMint empty', result.positionsByMint.size, 0);

  const seg = result.closedSegments[0];
  check('token_mint', seg.token_mint, TOKEN_A);
  check('segment_index', seg.segment_index, 0);
  check('status', seg.status, 'closed');
  check('quote_mint', seg.quote_mint, SOL_MINT);
  check('quote_symbol', seg.quote_symbol, 'SOL');
  check('valuation_status', seg.valuation_status, 'raw_quote');

  check('total_bought_qty', seg.total_bought_qty, 100);
  check('total_bought_quote', seg.total_bought_quote, 100);
  check('avg_buy_quote_price', seg.avg_buy_quote_price, 1.0);

  check('total_sold_qty', seg.total_sold_qty, 100);
  check('total_sold_quote', seg.total_sold_quote, 150);
  check('avg_sell_quote_price', seg.avg_sell_quote_price, 1.5);

  check('allocated_cost_basis_quote', seg.allocated_cost_basis_quote, 100);
  check('remaining_qty', seg.remaining_qty, 0);
  check('remaining_cost_basis_quote', seg.remaining_cost_basis_quote, 0);

  check('realized_pnl_quote', seg.realized_pnl_quote, 50);
  check('realized_pnl_pct', seg.realized_pnl_pct, 50);
  check('unrealized_pnl_quote', seg.unrealized_pnl_quote, null);
  check('total_pnl_quote', seg.total_pnl_quote, 50);
  check('total_pnl_pct', seg.total_pnl_pct, 50);

  checkTrue('flags includes dust_closed', seg.flags.includes('dust_closed'));
  check('unaccounted_sold_qty', seg.unaccounted_sold_qty, 0);
  check('events count', seg.events.length, 2);

  check('accounting_method_version', seg.accounting_method_version, 'weighted_average_position_accounting_v1');

  console.log(`  ✅ Test 1 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 2: multi_buy_full_sell
// ═══════════════════════════════════════════════════════════════
section('Test 2: multi_buy_full_sell');
resetCounter();
{
  // Buy 100 @ 1.0, buy 100 @ 2.0 → avg = 300/200 = 1.5
  // Sell 200 @ 2.0 → proceeds = 400, cost = 300, PnL = +100
  const events = [
    makeBuyEvent(TOKEN_A, 100, 100),   // 100 tokens for 100 SOL
    makeBuyEvent(TOKEN_A, 100, 200),   // 100 tokens for 200 SOL
    makeSellEvent(TOKEN_A, 200, 400),  // 200 tokens for 400 SOL
  ];

  const result = buildPositionLedger(events);
  check('closedSegments', result.closedSegments.length, 1);

  const seg = result.closedSegments[0];
  check('avg_buy_quote_price', seg.avg_buy_quote_price, 1.5);
  check('total_bought_qty', seg.total_bought_qty, 200);
  check('total_bought_quote', seg.total_bought_quote, 300);
  check('allocated_cost_basis_quote', seg.allocated_cost_basis_quote, 300);
  check('realized_pnl_quote', seg.realized_pnl_quote, 100);

  // PnL% = 100/300 * 100 = 33.3333...
  checkTrue('realized_pnl_pct ~33.33', Math.abs(seg.realized_pnl_pct - 33.3333) < 0.01);
  check('status', seg.status, 'closed');

  // Check per-event snapshots
  const buyEvent1 = seg.events[0];
  check('buy1 avg_after', buyEvent1.avg_buy_quote_price_after, 1.0);
  check('buy1 remaining_after', buyEvent1.remaining_qty_after, 100);

  const buyEvent2 = seg.events[1];
  check('buy2 avg_after', buyEvent2.avg_buy_quote_price_after, 1.5);
  check('buy2 remaining_after', buyEvent2.remaining_qty_after, 200);

  const sellEvent = seg.events[2];
  check('sell cost_basis_allocated', sellEvent.cost_basis_allocated, 300);
  check('sell realized_pnl_event', sellEvent.realized_pnl_event, 100);
  check('sell accounted_qty', sellEvent.accounted_qty, 200);
  check('sell unaccounted_qty', sellEvent.unaccounted_qty, 0);

  console.log(`  ✅ Test 2 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 3: multi_buy_partial_sell
// ═══════════════════════════════════════════════════════════════
section('Test 3: multi_buy_partial_sell');
resetCounter();
{
  // Buy 100 @ 1.0, buy 100 @ 2.0 → avg = 1.5
  // Sell 50 @ 3.0 → allocated = 75, realized = 75, remaining = 150, cost = 225
  const events = [
    makeBuyEvent(TOKEN_A, 100, 100),
    makeBuyEvent(TOKEN_A, 100, 200),
    makeSellEvent(TOKEN_A, 50, 150),
  ];

  const result = buildPositionLedger(events);
  check('closedSegments', result.closedSegments.length, 0);
  check('positionsByMint has token', result.positionsByMint.has(TOKEN_A), true);

  const pos = result.positionsByMint.get(TOKEN_A);
  check('status', pos.status, 'open');
  check('avg_buy_quote_price', pos.avg_buy_quote_price, 1.5);
  check('allocated_cost_basis_quote', pos.allocated_cost_basis_quote, 75);
  check('realized_pnl_quote', pos.realized_pnl_quote, 75);
  check('realized_pnl_pct', pos.realized_pnl_pct, 100);  // 75/75 * 100
  check('remaining_qty', pos.remaining_qty, 150);
  check('remaining_cost_basis_quote', pos.remaining_cost_basis_quote, 225);
  check('total_pnl_quote (open)', pos.total_pnl_quote, null);
  check('total_pnl_pct (open)', pos.total_pnl_pct, null);
  check('unaccounted_sold_qty', pos.unaccounted_sold_qty, 0);

  // Per-event: sell event should show correct allocation
  const sellEvent = pos.events[2];
  check('sell cost_basis_allocated', sellEvent.cost_basis_allocated, 75);
  check('sell realized_pnl_event', sellEvent.realized_pnl_event, 75);
  check('sell remaining_qty_after', sellEvent.remaining_qty_after, 150);

  console.log(`  ✅ Test 3 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 4: full_close_then_reopen
// ═══════════════════════════════════════════════════════════════
section('Test 4: full_close_then_reopen');
resetCounter();
{
  // Segment 0: buy 100 @ 1.0, sell 100 @ 2.0 → closes
  // Segment 1: buy 50 @ 3.0 → opens fresh
  const events = [
    makeBuyEvent(TOKEN_A, 100, 100),
    makeSellEvent(TOKEN_A, 100, 200),
    makeBuyEvent(TOKEN_A, 50, 150),
  ];

  const result = buildPositionLedger(events);

  // Segment 0 should be closed
  check('closedSegments count', result.closedSegments.length, 1);
  const seg0 = result.closedSegments[0];
  check('seg0 segment_index', seg0.segment_index, 0);
  check('seg0 status', seg0.status, 'closed');
  check('seg0 realized_pnl_quote', seg0.realized_pnl_quote, 100);
  check('seg0 total_pnl_quote', seg0.total_pnl_quote, 100);
  check('seg0 events count', seg0.events.length, 2);

  // Segment 1 should be open with fresh state
  check('positionsByMint has token', result.positionsByMint.has(TOKEN_A), true);
  const seg1 = result.positionsByMint.get(TOKEN_A);
  check('seg1 segment_index', seg1.segment_index, 1);
  check('seg1 status', seg1.status, 'open');
  check('seg1 total_bought_qty', seg1.total_bought_qty, 50);
  check('seg1 total_bought_quote', seg1.total_bought_quote, 150);
  check('seg1 avg_buy_quote_price', seg1.avg_buy_quote_price, 3.0);
  check('seg1 remaining_qty', seg1.remaining_qty, 50);
  check('seg1 remaining_cost_basis_quote', seg1.remaining_cost_basis_quote, 150);
  check('seg1 realized_pnl_quote', seg1.realized_pnl_quote, 0);
  check('seg1 events count', seg1.events.length, 1);

  // No cost basis bleed from segment 0
  check('seg1 allocated_cost_basis_quote (fresh)', seg1.allocated_cost_basis_quote, 0);

  console.log(`  ✅ Test 4 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 5: sell_before_buy
// ═══════════════════════════════════════════════════════════════
section('Test 5: sell_before_buy');
resetCounter();
{
  // Sell 100 @ 2.0 with no prior buy
  const events = [
    makeSellEvent(TOKEN_A, 100, 200),
  ];

  const result = buildPositionLedger(events);

  // Should NOT close (no buys observed → total_bought_qty = 0)
  check('closedSegments', result.closedSegments.length, 0);
  check('positionsByMint has token', result.positionsByMint.has(TOKEN_A), true);

  const pos = result.positionsByMint.get(TOKEN_A);
  check('status', pos.status, 'partial_history');
  checkTrue('flags: partial_history', pos.flags.includes('partial_history'));
  checkTrue('flags: external_transfer_possible', pos.flags.includes('external_transfer_possible'));
  checkTrue('flags: negative_inventory', pos.flags.includes('negative_inventory'));
  checkTrue('flags: unsupported_inventory', pos.flags.includes('unsupported_inventory'));

  // No fabricated PnL
  check('realized_pnl_quote', pos.realized_pnl_quote, 0);
  check('allocated_cost_basis_quote', pos.allocated_cost_basis_quote, 0);
  check('total_sold_qty (accounted)', pos.total_sold_qty, 0);
  check('total_sold_quote (accounted)', pos.total_sold_quote, 0);
  check('remaining_qty', pos.remaining_qty, 0);

  // Full sell tracked as unaccounted
  check('unaccounted_sold_qty', pos.unaccounted_sold_qty, 100);
  check('unaccounted_sold_quote', pos.unaccounted_sold_quote, 200);

  // LedgerEvent records the full sell
  const sellEvent = pos.events[0];
  check('event base_qty', sellEvent.base_qty, 100);
  check('event quote_amount', sellEvent.quote_amount, 200);
  check('event accounted_qty', sellEvent.accounted_qty, 0);
  check('event unaccounted_qty', sellEvent.unaccounted_qty, 100);
  check('event cost_basis_allocated', sellEvent.cost_basis_allocated, 0);
  check('event realized_pnl_event', sellEvent.realized_pnl_event, 0);

  console.log(`  ✅ Test 5 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 6: sell_exceeds_remaining
// ═══════════════════════════════════════════════════════════════
section('Test 6: sell_exceeds_remaining');
resetCounter();
{
  // Buy 50 @ 1.0 (cost = 50 SOL)
  // Sell 100 @ 2.0 (proceeds = 200 SOL)
  //   → accounted: 50 tokens, cost = 50, proceeds = 100, pnl = +50
  //   → excess: 50 tokens, proceeds = 100 → unaccounted
  const events = [
    makeBuyEvent(TOKEN_A, 50, 50),
    makeSellEvent(TOKEN_A, 100, 200),
  ];

  const result = buildPositionLedger(events);

  // Should close as partial_history (remaining=0, total_bought>0)
  check('closedSegments', result.closedSegments.length, 1);

  const seg = result.closedSegments[0];
  check('status', seg.status, 'partial_history');
  checkTrue('flags: negative_inventory', seg.flags.includes('negative_inventory'));
  checkTrue('flags: unsupported_inventory', seg.flags.includes('unsupported_inventory'));
  checkTrue('flags: partial_history', seg.flags.includes('partial_history'));
  checkTrue('flags: external_transfer_possible', seg.flags.includes('external_transfer_possible'));
  checkTrue('flags: dust_closed', seg.flags.includes('dust_closed'));

  // Remaining floored at 0
  check('remaining_qty', seg.remaining_qty, 0);
  check('remaining_cost_basis_quote', seg.remaining_cost_basis_quote, 0);

  // Only accounted portion has PnL
  check('total_sold_qty (accounted)', seg.total_sold_qty, 50);
  check('total_sold_quote (accounted)', seg.total_sold_quote, 100);
  check('allocated_cost_basis_quote', seg.allocated_cost_basis_quote, 50);
  check('realized_pnl_quote', seg.realized_pnl_quote, 50);
  check('realized_pnl_pct', seg.realized_pnl_pct, 100);  // 50/50 * 100

  // Excess tracked separately
  check('unaccounted_sold_qty', seg.unaccounted_sold_qty, 50);
  check('unaccounted_sold_quote', seg.unaccounted_sold_quote, 100);

  // LedgerEvent for the sell shows the split
  const sellEvent = seg.events[1];
  check('sell base_qty (full)', sellEvent.base_qty, 100);
  check('sell quote_amount (full)', sellEvent.quote_amount, 200);
  check('sell accounted_qty', sellEvent.accounted_qty, 50);
  check('sell unaccounted_qty', sellEvent.unaccounted_qty, 50);
  check('sell cost_basis_allocated', sellEvent.cost_basis_allocated, 50);
  check('sell realized_pnl_event', sellEvent.realized_pnl_event, 50);

  console.log(`  ✅ Test 6 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 7: mixed_quote_mints
// ═══════════════════════════════════════════════════════════════
section('Test 7: mixed_quote_mints');
resetCounter();
{
  // Buy 100 via SOL (100 SOL → 100 tokens)
  // Sell 100 via USDC (100 tokens → 200 USDC)
  const events = [
    makeBuyEvent(TOKEN_A, 100, 100, { quoteMint: SOL_MINT }),
    makeSellEvent(TOKEN_A, 100, 200, { quoteMint: USDC_MINT }),
  ];

  const result = buildPositionLedger(events);
  check('closedSegments', result.closedSegments.length, 1);

  const seg = result.closedSegments[0];
  check('quote_mint', seg.quote_mint, 'MIXED');
  check('quote_symbol', seg.quote_symbol, 'MIXED');
  checkTrue('flags: mixed_quote', seg.flags.includes('mixed_quote'));

  // Math is mechanically correct but economically meaningless
  check('total_bought_quote', seg.total_bought_quote, 100);
  check('total_sold_quote', seg.total_sold_quote, 200);
  check('status', seg.status, 'closed');

  console.log(`  ✅ Test 7 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 8: empty_events
// ═══════════════════════════════════════════════════════════════
section('Test 8: empty_events');
resetCounter();
{
  const result = buildPositionLedger([]);

  check('positionsByMint empty', result.positionsByMint.size, 0);
  check('closedSegments empty', result.closedSegments.length, 0);
  check('eventCount', result.eventCount, 0);
  check('processedCount', result.processedCount, 0);
  check('skippedCount', result.skippedCount, 0);

  console.log(`  ✅ Test 8 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 9: determinism
// ═══════════════════════════════════════════════════════════════
section('Test 9: determinism');
resetCounter();
{
  const makeEvents = () => {
    _txCounter = 0;
    return [
      makeBuyEvent(TOKEN_A, 100, 100),
      makeBuyEvent(TOKEN_A, 100, 200),
      makeSellEvent(TOKEN_A, 200, 400),
    ];
  };

  const result1 = buildPositionLedger(makeEvents());
  const result2 = buildPositionLedger(makeEvents());

  const json1 = JSON.stringify(serializeLedger(result1));
  const json2 = JSON.stringify(serializeLedger(result2));

  check('deterministic output', json1, json2);
  checkTrue('non-empty', json1.length > 100);

  console.log(`  ✅ Test 9 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 10: dust_close
// ═══════════════════════════════════════════════════════════════
section('Test 10: dust_close');
resetCounter();
{
  // Buy 1000 @ 1.0, sell 999.9999 @ 1.0
  // Remaining = 0.0001, DUST_ABS = 0.001 → 0.0001 < 0.001 → dust_closed
  const events = [
    makeBuyEvent(TOKEN_A, 1000, 1000),
    makeSellEvent(TOKEN_A, 999.9999, 999.9999),
  ];

  const result = buildPositionLedger(events);
  check('closedSegments', result.closedSegments.length, 1);

  const seg = result.closedSegments[0];
  check('status', seg.status, 'closed');
  checkTrue('flags: dust_closed', seg.flags.includes('dust_closed'));

  // Remaining should be the tiny leftover (dust)
  checkTrue('remaining_qty near zero', seg.remaining_qty < 0.001);
  checkTrue('remaining_qty >= 0', seg.remaining_qty >= 0);

  console.log(`  ✅ Test 10 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Test 11: economic_equivalence
// ═══════════════════════════════════════════════════════════════
section('Test 11: economic_equivalence (vs v1.1 position-builder)');
resetCounter();
{
  // Synthetic events matching the JUP 2-cycle test data shape:
  //   Cycle 1: buy 11.646068 JUP for 0.02 SOL, sell 11.646068 for 0.019990526 SOL
  //   Cycle 2: buy 2.646722 JUP for 0.005 SOL, sell 2.646722 for 0.004996897 SOL
  const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

  const events = [
    makeBuyEvent(JUP_MINT, 11.646068, 0.02, { timestamp: 1774400456 }),
    makeSellEvent(JUP_MINT, 11.646068, 0.019990526, { timestamp: 1774400490 }),
    makeBuyEvent(JUP_MINT, 2.646722, 0.005, { timestamp: 1774953880 }),
    makeSellEvent(JUP_MINT, 2.646722, 0.004996897, { timestamp: 1774953919 }),
  ];

  const result = buildPositionLedger(events);

  // Ledger produces 2 closed segments (one per cycle)
  check('closedSegments', result.closedSegments.length, 2);

  const seg0 = result.closedSegments[0];
  const seg1 = result.closedSegments[1];

  check('seg0 segment_index', seg0.segment_index, 0);
  check('seg1 segment_index', seg1.segment_index, 1);

  // Segment 0: cost=0.02, proceeds=0.019990526, PnL=-0.000009474
  check('seg0 total_bought_quote', seg0.total_bought_quote, 0.02);
  check('seg0 total_sold_quote', seg0.total_sold_quote, 0.019990526);
  checkTrue('seg0 pnl close', Math.abs(seg0.realized_pnl_quote - (0.019990526 - 0.02)) < 1e-10);

  // Segment 1: cost=0.005, proceeds=0.004996897, PnL=-0.000003103
  check('seg1 total_bought_quote', seg1.total_bought_quote, 0.005);
  check('seg1 total_sold_quote', seg1.total_sold_quote, 0.004996897);
  checkTrue('seg1 pnl close', Math.abs(seg1.realized_pnl_quote - (0.004996897 - 0.005)) < 1e-10);

  // v1.1 combined values:
  //   total cost = 0.025, total proceeds = 0.024987423, pnl = -0.000012577
  const v11_cost = 0.025;
  const v11_proceeds = 0.024987423;
  const v11_pnl = v11_proceeds - v11_cost;  // -0.000012577

  const ledger_total_cost = seg0.total_bought_quote + seg1.total_bought_quote;
  const ledger_total_proceeds = seg0.total_sold_quote + seg1.total_sold_quote;
  const ledger_total_pnl = seg0.realized_pnl_quote + seg1.realized_pnl_quote;

  checkTrue('economic: cost matches', Math.abs(ledger_total_cost - v11_cost) < 1e-10);
  checkTrue('economic: proceeds matches', Math.abs(ledger_total_proceeds - v11_proceeds) < 1e-10);
  checkTrue('economic: total PnL matches', Math.abs(ledger_total_pnl - v11_pnl) < 1e-10);

  // Total quantities match
  const ledger_total_bought_qty = seg0.total_bought_qty + seg1.total_bought_qty;
  const ledger_total_sold_qty = seg0.total_sold_qty + seg1.total_sold_qty;
  checkTrue('qty bought matches', Math.abs(ledger_total_bought_qty - 14.29279) < 1e-6);
  checkTrue('qty sold matches', Math.abs(ledger_total_sold_qty - 14.29279) < 1e-6);

  console.log(`  ✅ Test 11 assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Bonus: classifyEvent unit tests
// ═══════════════════════════════════════════════════════════════
section('Bonus: classifyEvent');
{
  // Buy: SOL → TOKEN_A
  const buyEvt = { token_in_mint: SOL_MINT, token_in_amount: 10, token_out_mint: TOKEN_A, token_out_amount: 100 };
  const buyC = classifyEvent(buyEvt);
  check('buy action', buyC.action, 'buy');
  check('buy baseMint', buyC.baseMint, TOKEN_A);
  check('buy quoteMint', buyC.quoteMint, SOL_MINT);

  // Sell: TOKEN_A → SOL
  const sellEvt = { token_in_mint: TOKEN_A, token_in_amount: 100, token_out_mint: SOL_MINT, token_out_amount: 15 };
  const sellC = classifyEvent(sellEvt);
  check('sell action', sellC.action, 'sell');
  check('sell baseMint', sellC.baseMint, TOKEN_A);

  // Quote-to-quote: SOL → USDC
  const qqEvt = { token_in_mint: SOL_MINT, token_in_amount: 1, token_out_mint: USDC_MINT, token_out_amount: 150 };
  const qqC = classifyEvent(qqEvt);
  check('quote-to-quote skipped', qqC.action, null);

  // Token-to-token: TOKEN_A → TOKEN_B
  const ttEvt = { token_in_mint: TOKEN_A, token_in_amount: 50, token_out_mint: TOKEN_B, token_out_amount: 200 };
  const ttC = classifyEvent(ttEvt);
  check('token-to-token skipped', ttC.action, null);

  console.log(`  ✅ classifyEvent assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Bonus: serializeLedger
// ═══════════════════════════════════════════════════════════════
section('Bonus: serializeLedger');
resetCounter();
{
  const events = [
    makeBuyEvent(TOKEN_A, 100, 100),
  ];
  const result = buildPositionLedger(events);
  const serialized = serializeLedger(result);

  checkTrue('positions is plain object', typeof serialized.positions === 'object' && !Array.isArray(serialized.positions));
  checkTrue('has token key', TOKEN_A in serialized.positions);
  check('closedSegments is array', Array.isArray(serialized.closedSegments), true);
  checkTrue('JSON.stringify works', JSON.stringify(serialized).length > 50);

  console.log(`  ✅ serializeLedger assertions complete`);
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(58)}`);
if (fail === 0) {
  console.log(`✅ ALL ${pass} CHECKS PASSED — position-ledger Slice 1A is solid`);
} else {
  console.log(`❌ ${fail} FAILED, ${pass} passed`);
}
console.log(`${'═'.repeat(58)}`);

process.exit(fail > 0 ? 1 : 0);
