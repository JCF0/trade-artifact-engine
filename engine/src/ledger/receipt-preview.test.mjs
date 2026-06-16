/**
 * Receipt Preview Tests — D1
 *
 * Tests for format helpers, per-type previews, valuation display,
 * markdown generation, and batch processing.
 */

import {
  shortWallet,
  shortHash,
  formatPrice,
  formatPnl,
  formatPnlPct,
  formatHoldTime,
  formatDate,
  tokenDisplay,
  buildReceiptPreview,
  buildReceiptPreviews,
} from './receipt-preview.mjs';

import { USDC_MINT, USDT_MINT, SOL_MINT } from '../pipeline/constants.mjs';

// ═══════════════════════════════════════════════════════════════
// Test harness
// ═══════════════════════════════════════════════════════════════

let _passed = 0;
let _failed = 0;
let _total = 0;

function test(name, fn) {
  _total++;
  try {
    fn();
    _passed++;
  } catch (e) {
    _failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

// ═══════════════════════════════════════════════════════════════
// Fixture: minimal valid receipts
// ═══════════════════════════════════════════════════════════════

function makeReceipt(type, overrides = {}) {
  const base = {
    receipt_id: `art_v12_xx_TESTMINT_0`,
    receipt_version: '1.2.0',
    receipt_type: type,
    token_mint: 'TESTMINT1234567890123456789012345678901234abcd',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    segment_index: 0,
    receipt_hash: 'a'.repeat(64),
    verification_status: null,
    display_status: null,
    accounting_method: 'weighted_average_position_accounting_v1',
    quote_mint: SOL_MINT,
    quote_symbol: 'SOL',
    valuation_status: 'raw_quote',
    total_bought_qty: 1000,
    total_bought_quote: 10,
    avg_buy_quote_price: 0.01,
    total_sold_qty: null,
    total_sold_quote: null,
    avg_sell_quote_price: null,
    allocated_cost_basis_quote: null,
    remaining_qty: null,
    remaining_cost_basis_quote: 0,
    realized_pnl_quote: null,
    realized_pnl_pct: null,
    first_event_at: 1700000000,
    last_event_at: 1700100000,
    snapshot_at: null,
    hold_time_seconds: null,
    entry_tx_hashes: ['aaaa1111'],
    exit_tx_hashes: [],
    num_buys: 1,
    num_sells: 0,
    candidate_hash: 'c'.repeat(64),
    limitations: {
      receipt_scope: type,
      pnl_type: 'none',
      price_source: 'none',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    },
    flags: [],
  };

  if (type === 'closed_position') {
    base.total_sold_qty = 1000;
    base.total_sold_quote = 15;
    base.avg_sell_quote_price = 0.015;
    base.allocated_cost_basis_quote = 10;
    base.remaining_qty = 0;
    base.realized_pnl_quote = 5;
    base.realized_pnl_pct = 50;
    base.hold_time_seconds = 100000;
    base.exit_tx_hashes = ['bbbb2222'];
    base.num_sells = 1;
    base.verification_status = 'verified';
    base.display_status = 'Verified Closed Position';
    base.limitations.pnl_type = 'realized_closed';
    base.limitations.price_source = 'on_chain_swaps';
  } else if (type === 'realized_partial') {
    base.total_sold_qty = 500;
    base.total_sold_quote = 7.5;
    base.avg_sell_quote_price = 0.015;
    base.allocated_cost_basis_quote = 5;
    base.remaining_qty = 500;
    base.realized_pnl_quote = 2.5;
    base.realized_pnl_pct = 50;
    base.hold_time_seconds = 100000;
    base.exit_tx_hashes = ['bbbb2222'];
    base.num_sells = 1;
    base.verification_status = 'verified_partial';
    base.display_status = 'Verified Partial (Position Open)';
    base.limitations.pnl_type = 'realized_partial';
    base.limitations.price_source = 'on_chain_swaps';
    base.limitations.disclosures = ['no_usd_normalization', 'position_open'];
  } else if (type === 'open_snapshot') {
    base.remaining_qty = 1000;
    base.remaining_cost_basis_quote = 10;
    base.snapshot_at = 1700200000;
    base.verification_status = 'verified_snapshot';
    base.display_status = 'Verified Snapshot (No PnL Claim)';
    base.limitations.disclosures = ['no_usd_normalization', 'no_pnl_claim', 'no_live_price'];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'limitations' && value && typeof value === 'object') {
      base.limitations = { ...base.limitations, ...value };
    } else {
      base[key] = value;
    }
  }

  return base;
}

// ═══════════════════════════════════════════════════════════════
// FORMAT HELPERS (8 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Format helpers ──');

test('shortWallet: standard address', () => {
  assert(shortWallet('TESTWALLET12345678901234567890123456789012345') === 'TESTWA...2345');
});

test('shortHash: 64-char hex', () => {
  const h = 'a'.repeat(64);
  assert(shortHash(h) === 'aaaaaaaaaaaa...', `got ${shortHash(h)}`);
});

test('formatPrice: null → dash', () => {
  assert(formatPrice(null, 'SOL') === '—');
});

test('formatPrice: tiny value → exponential', () => {
  const r = formatPrice(0.00001, 'SOL');
  assert(r.includes('e') && r.includes('SOL'), `got ${r}`);
});

test('formatPnl: positive with sign', () => {
  const r = formatPnl(5.0, 'SOL');
  assert(r.startsWith('+'), `should start with +, got ${r}`);
  assert(r.includes('SOL'), `should include SOL, got ${r}`);
});

test('formatPnlPct: null → dash', () => {
  assert(formatPnlPct(null) === '—');
});

test('formatHoldTime: days', () => {
  assert(formatHoldTime(100000).includes('days'));
});

test('tokenDisplay: no symbol → mint fallback', () => {
  const r = tokenDisplay(null, 'TESTMINT1234567890123456789012345678901234abcd');
  assert(r === 'TESTMINT...', `got ${r}`);
});

// ═══════════════════════════════════════════════════════════════
// CLOSED_POSITION PREVIEW (5 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── closed_position preview ──');

test('closed_position: display_status correct', () => {
  const p = buildReceiptPreview(makeReceipt('closed_position'));
  assert(p.display_status === 'Verified Closed Position', `got ${p.display_status}`);
});

test('closed_position: PnL formatted', () => {
  const p = buildReceiptPreview(makeReceipt('closed_position'));
  assert(p.pnl.has_pnl === true, 'should have pnl');
  assert(p.pnl.is_profit === true, 'should be profit');
  assert(p.pnl.realized_pnl_display.startsWith('+'), `should start with +, got ${p.pnl.realized_pnl_display}`);
  assert(p.pnl.realized_pnl_pct_display.includes('50.000%'), `got ${p.pnl.realized_pnl_pct_display}`);
});

test('closed_position: stats complete', () => {
  const p = buildReceiptPreview(makeReceipt('closed_position'));
  assert(p.stats.avg_buy_price.includes('SOL'), 'avg_buy should have SOL');
  assert(p.stats.avg_sell_price.includes('SOL'), 'avg_sell should have SOL');
  assert(p.stats.cost_basis !== '—', 'cost_basis should exist');
  assert(p.stats.exit_proceeds !== '—', 'exit_proceeds should exist');
  assert(p.stats.hold_time.includes('days'), 'hold_time should be in days');
  assert(p.stats.trades === '1 buy / 1 sell', `got ${p.stats.trades}`);
});

test('closed_position: proof present', () => {
  const p = buildReceiptPreview(makeReceipt('closed_position'));
  assert(p.proof.receipt_hash === 'a'.repeat(64), 'full receipt_hash');
  assert(p.proof.receipt_hash_short === 'aaaaaaaaaaaa...', 'short receipt_hash');
  assert(p.proof.candidate_hash_short === 'cccccccccccc...', 'short candidate_hash');
  assert(p.proof.accounting_method.includes('weighted_average'), 'accounting method');
});

test('closed_position: header uses mint fallback for token', () => {
  const p = buildReceiptPreview(makeReceipt('closed_position'));
  assert(p.header.token_display === 'TESTMINT...', `got ${p.header.token_display}`);
  assert(p.header.quote_symbol === 'SOL', `got ${p.header.quote_symbol}`);
  assert(p.header.wallet_short.includes('...'), 'wallet shortened');
});

// ═══════════════════════════════════════════════════════════════
// REALIZED_PARTIAL PREVIEW (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── realized_partial preview ──');

test('realized_partial: display_status and remaining qty', () => {
  const p = buildReceiptPreview(makeReceipt('realized_partial'));
  assert(p.display_status === 'Verified Partial (Position Open)', `got ${p.display_status}`);
  assert(p.stats.remaining_qty === '500', `got ${p.stats.remaining_qty}`);
});

test('realized_partial: has_pnl=true, position_open disclosure', () => {
  const p = buildReceiptPreview(makeReceipt('realized_partial'));
  assert(p.pnl.has_pnl === true);
  const hasPositionOpen = p.valuation.disclosures.some(d => d.includes('Position still open'));
  assert(hasPositionOpen, 'should have position_open disclosure');
});

test('realized_partial: markdown contains remaining', () => {
  const p = buildReceiptPreview(makeReceipt('realized_partial'));
  assert(p.markdown.includes('Remaining'), 'markdown should mention remaining');
});

// ═══════════════════════════════════════════════════════════════
// OPEN_SNAPSHOT PREVIEW (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── open_snapshot preview ──');

test('open_snapshot: display_status and no PnL', () => {
  const p = buildReceiptPreview(makeReceipt('open_snapshot'));
  assert(p.display_status === 'Verified Snapshot (No PnL Claim)', `got ${p.display_status}`);
  assert(p.pnl.has_pnl === false, 'should not have pnl');
});

test('open_snapshot: disclosures include no_pnl_claim and no_live_price', () => {
  const p = buildReceiptPreview(makeReceipt('open_snapshot'));
  const hasPnlClaim = p.valuation.disclosures.some(d => d.includes('no PnL claim'));
  const hasLivePrice = p.valuation.disclosures.some(d => d.includes('No live price'));
  assert(hasPnlClaim, 'should have no_pnl_claim disclosure');
  assert(hasLivePrice, 'should have no_live_price disclosure');
});

test('open_snapshot: markdown has snapshot_at', () => {
  const p = buildReceiptPreview(makeReceipt('open_snapshot'));
  assert(p.markdown.includes('Snapshot'), 'markdown should mention snapshot');
});

// ═══════════════════════════════════════════════════════════════
// UNVERIFIED PREVIEW (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── unverified preview ──');

test('unverified: display_status and flag disclosures', () => {
  const r = makeReceipt('closed_position', {
    flags: ['mixed_quote'],
    verification_status: 'unverified',
    display_status: 'Unverified — See Limitations',
    limitations: { disclosures: ['no_usd_normalization', 'mixed_quote_currencies'] },
  });
  const p = buildReceiptPreview(r);
  assert(p.display_status === 'Unverified — See Limitations', `got ${p.display_status}`);
  const hasMixed = p.valuation.disclosures.some(d => d.includes('Mixed quote'));
  assert(hasMixed, 'should have mixed_quote disclosure');
});

test('unverified: markdown contains warning icon', () => {
  const r = makeReceipt('closed_position', {
    verification_status: 'unverified',
    display_status: 'Unverified — See Limitations',
  });
  const p = buildReceiptPreview(r);
  assert(p.markdown.includes('❌'), 'markdown should contain ❌ icon');
});

// ═══════════════════════════════════════════════════════════════
// VALUATION DISPLAY (4 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Valuation display ──');

test('SOL quote: not USD-stable', () => {
  const p = buildReceiptPreview(makeReceipt('closed_position'));
  assert(p.valuation.quote_is_usd_stable === false, 'SOL should not be usd_stable');
  assert(p.valuation.currency_label === 'Raw Quote (SOL)', `got ${p.valuation.currency_label}`);
  assert(!p.valuation.currency_label.includes('USD-stable'), 'SOL should not mention USD-stable');
});

test('USDC quote: USD-stable label with guardrail wording', () => {
  const r = makeReceipt('closed_position', { quote_mint: USDC_MINT, quote_symbol: 'USDC' });
  const p = buildReceiptPreview(r);
  assert(p.valuation.quote_is_usd_stable === true, 'USDC should be usd_stable');
  assert(p.valuation.currency_label.includes('USD-stable quote asset'), 'should mention USD-stable');
  assert(p.valuation.currency_label.includes('still raw quote'), 'should say still raw quote');
  assert(p.valuation.currency_label.includes('no historical USD normalization'), 'should disclaim normalization');
  assert(!p.valuation.currency_label.includes('1:1'), 'must NOT say 1:1');
  assert(p.valuation.status === 'raw_quote', 'status must remain raw_quote');
});

test('USDT quote: same guardrail as USDC', () => {
  const r = makeReceipt('closed_position', { quote_mint: USDT_MINT, quote_symbol: 'USDT' });
  const p = buildReceiptPreview(r);
  assert(p.valuation.quote_is_usd_stable === true);
  assert(p.valuation.currency_label.includes('USD-stable quote asset'));
  assert(p.valuation.currency_label.includes('still raw quote'));
});

test('all_disclosures derive human labels', () => {
  const r = makeReceipt('closed_position', {
    verification_status: 'unverified',
    display_status: 'Unverified — See Limitations',
    flags: ['external_transfer_possible', 'partial_history'],
    limitations: {
      disclosures: ['no_usd_normalization', 'partial_trade_history', 'external_transfer_possible'],
    },
  });
  const p = buildReceiptPreview(r);
  assert(p.valuation.disclosures.length === 3, `expected 3, got ${p.valuation.disclosures.length}`);
  assert(p.valuation.disclosures.every(d => typeof d === 'string' && d.length > 10), 'all should be human-readable');
  assert(p.valuation.disclosure_codes.length === 3, 'codes should match');
});

// ═══════════════════════════════════════════════════════════════
// MARKDOWN (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Markdown ──');

test('markdown is non-empty and contains key fields', () => {
  const p = buildReceiptPreview(makeReceipt('closed_position'));
  assert(p.markdown.length > 100, 'markdown should be substantial');
  assert(p.markdown.includes(p.receipt_id), 'should contain receipt_id');
  assert(p.markdown.includes('Verified Closed Position'), 'should contain status');
  assert(p.markdown.includes('raw_quote'), 'should contain valuation status');
  assert(p.markdown.includes('Receipt Hash'), 'should contain proof section');
});

test('open_snapshot markdown omits PnL section', () => {
  const p = buildReceiptPreview(makeReceipt('open_snapshot'));
  assert(!p.markdown.includes('### PnL'), 'should not have PnL section');
  assert(p.markdown.includes('Snapshot'), 'should mention snapshot');
});

// ═══════════════════════════════════════════════════════════════
// BATCH (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Batch ──');

test('batch: multiple receipts', () => {
  const receipts = [
    makeReceipt('closed_position'),
    makeReceipt('realized_partial'),
    makeReceipt('open_snapshot'),
  ];
  const previews = buildReceiptPreviews(receipts);
  assert(previews.length === 3, `expected 3, got ${previews.length}`);
  assert(previews[0].receipt_type === 'closed_position');
  assert(previews[1].receipt_type === 'realized_partial');
  assert(previews[2].receipt_type === 'open_snapshot');
});

test('batch: empty array', () => {
  const previews = buildReceiptPreviews([]);
  assert(previews.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// EDGE CASES (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Edge cases ──');

test('missing quote_symbol → uses mint fallback', () => {
  const r = makeReceipt('closed_position', { quote_symbol: null });
  const p = buildReceiptPreview(r);
  assert(p.header.quote_symbol === 'So111111...', `got ${p.header.quote_symbol}`);
});

test('missing limitations → no crash, empty disclosures', () => {
  const r = makeReceipt('closed_position');
  r.limitations = null;
  const p = buildReceiptPreview(r);
  assert(p.valuation.disclosures.length === 0, 'should have no disclosures');
  assert(p.valuation.disclosure_codes.length === 0);
});

test('formatDate: null → dash', () => {
  assert(formatDate(null) === '—');
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Receipt Preview: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
