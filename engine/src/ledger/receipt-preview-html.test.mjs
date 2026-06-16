/**
 * Receipt Preview HTML Tests — D2
 *
 * Tests for HTML generation from D1 preview objects.
 */

import { escapeHtml, renderPreviewsHtml } from './receipt-preview-html.mjs';
import { buildReceiptPreview } from './receipt-preview.mjs';
import { USDC_MINT, SOL_MINT } from '../pipeline/constants.mjs';

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
// Fixture: minimal receipts → D1 previews
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

function makePreview(type, overrides = {}) {
  return buildReceiptPreview(makeReceipt(type, overrides));
}

// ═══════════════════════════════════════════════════════════════
// ESCAPING (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Escaping ──');

test('escapeHtml: all special chars', () => {
  const input = '<script>"alert(\'xss\')&</script>';
  const output = escapeHtml(input);
  assert(!output.includes('<'), 'should escape <');
  assert(!output.includes('>'), 'should escape >');
  assert(output.includes('&lt;'), 'should have &lt;');
  assert(output.includes('&gt;'), 'should have &gt;');
  assert(output.includes('&quot;'), 'should have &quot;');
  assert(output.includes('&#39;'), 'should have &#39;');
  assert(output.includes('&amp;'), 'should have &amp;');
});

test('escapeHtml: null/undefined → empty string', () => {
  assert(escapeHtml(null) === '', 'null');
  assert(escapeHtml(undefined) === '', 'undefined');
});

// ═══════════════════════════════════════════════════════════════
// HTML STRUCTURE (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── HTML structure ──');

test('starts with DOCTYPE and ends with </html>', () => {
  const html = renderPreviewsHtml([makePreview('closed_position')]);
  assert(html.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
  assert(html.trimEnd().endsWith('</html>'), 'should end with </html>');
});

test('contains <style> block', () => {
  const html = renderPreviewsHtml([makePreview('closed_position')]);
  assert(html.includes('<style>'), 'should have <style>');
  assert(html.includes('</style>'), 'should have </style>');
});

test('header shows count and generatedAt', () => {
  const html = renderPreviewsHtml(
    [makePreview('closed_position'), makePreview('open_snapshot')],
    { generatedAt: '2026-06-16T05:00:00.000Z' }
  );
  assert(html.includes('2 receipts'), 'should show count');
  assert(html.includes('2026-06-16T05:00:00.000Z'), 'should show generatedAt');
});

// ═══════════════════════════════════════════════════════════════
// CARD RENDERING (4 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Card rendering ──');

test('closed_position: has PnL section and status class', () => {
  const html = renderPreviewsHtml([makePreview('closed_position')]);
  assert(html.includes('status-verified'), 'should have verified class');
  assert(html.includes('Verified Closed Position'), 'should have status label');
  assert(html.includes('pnl-pct'), 'should have PnL section');
  assert(html.includes('+50.000%'), 'should show PnL pct');
});

test('realized_partial: has remaining and partial class', () => {
  const html = renderPreviewsHtml([makePreview('realized_partial')]);
  assert(html.includes('status-partial'), 'should have partial class');
  assert(html.includes('Remaining'), 'should show remaining');
  assert(html.includes('500'), 'should show remaining qty');
});

test('open_snapshot: no PnL section, has snapshot class', () => {
  const html = renderPreviewsHtml([makePreview('open_snapshot')]);
  assert(html.includes('status-snapshot'), 'should have snapshot class');
  // Check that no pnl-pct class appears inside a card div (CSS defines it but card should not use it)
  const cardStart = html.indexOf('class="card ');
  const cardHtml = html.slice(cardStart);
  assert(!cardHtml.includes('class="pnl-pct'), 'should NOT have PnL section in card');
  assert(html.includes('Snapshot'), 'should mention snapshot');
});

test('unverified: has unverified class and icon text', () => {
  const p = makePreview('closed_position', {
    verification_status: 'unverified',
    display_status: 'Unverified — See Limitations',
  });
  const html = renderPreviewsHtml([p]);
  assert(html.includes('status-unverified'), 'should have unverified class');
  assert(html.includes('Unverified'), 'should show unverified label');
});

// ═══════════════════════════════════════════════════════════════
// VALUATION DISPLAY (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Valuation display ──');

test('disclosures rendered as list items', () => {
  const html = renderPreviewsHtml([makePreview('open_snapshot')]);
  assert(html.includes('<li>'), 'should have list items');
  assert(html.includes('No USD normalization'), 'should have no_usd disclosure');
  assert(html.includes('no PnL claim'), 'should have no_pnl_claim disclosure');
});

test('USDC card has guardrail wording', () => {
  const p = makePreview('closed_position', { quote_mint: USDC_MINT, quote_symbol: 'USDC' });
  const html = renderPreviewsHtml([p]);
  assert(html.includes('USD-stable quote asset'), 'should have guardrail wording');
  assert(html.includes('still raw quote'), 'should disclaim raw quote');
  assert(!html.includes('1:1'), 'must NOT say 1:1');
});

// ═══════════════════════════════════════════════════════════════
// PROOF SECTION (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Proof section ──');

test('contains receipt hash and candidate hash', () => {
  const html = renderPreviewsHtml([makePreview('closed_position')]);
  assert(html.includes('Receipt Hash'), 'should have receipt hash label');
  assert(html.includes('aaaaaaaaaaaa'), 'should have receipt hash short');
  assert(html.includes('Candidate Hash'), 'should have candidate hash label');
  assert(html.includes('cccccccccccc'), 'should have candidate hash short');
  assert(html.includes('weighted_average'), 'should have accounting method');
});

// ═══════════════════════════════════════════════════════════════
// ESCAPING IN CONTEXT (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Escaping in context ──');

test('special chars in display fields do not break HTML', () => {
  const p = makePreview('closed_position', {
    display_status: '<b>Injected</b> & "quoted"',
    wallet: '<script>alert(1)</script>WALLET1234567890123456',
  });
  const html = renderPreviewsHtml([p]);
  assert(!html.includes('<b>Injected</b>'), 'should escape display_status');
  assert(!html.includes('<script>alert'), 'should escape wallet');
  assert(html.includes('&lt;b&gt;'), 'should have escaped tag');
});

// ═══════════════════════════════════════════════════════════════
// EMPTY / BATCH (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Empty / batch ──');

test('empty array → valid HTML with 0 receipts', () => {
  const html = renderPreviewsHtml([]);
  assert(html.includes('<!DOCTYPE html>'), 'should be valid HTML');
  assert(html.includes('0 receipts'), 'should show 0 count');
  assert(!html.includes('class="card'), 'should have no cards');
});

test('multiple receipts → multiple cards', () => {
  const previews = [
    makePreview('closed_position'),
    makePreview('realized_partial'),
    makePreview('open_snapshot'),
  ];
  const html = renderPreviewsHtml(previews);
  assert(html.includes('3 receipts'), 'should show 3 count');
  const cardCount = (html.match(/class="card /g) || []).length;
  assert(cardCount === 3, `expected 3 cards, got ${cardCount}`);
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Receipt Preview HTML: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
