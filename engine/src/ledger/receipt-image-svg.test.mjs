/**
 * Receipt Image SVG Tests — E3
 *
 * Tests for SVG generation from D1 preview objects.
 */

import {
  escapeSvg,
  sanitizeFilename,
  renderReceiptSvg,
  renderReceiptSvgBatch,
} from './receipt-image-svg.mjs';
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
// Fixtures
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

test('escapeSvg: all XML special chars', () => {
  const input = '<script>"alert(\'xss\')&</script>';
  const output = escapeSvg(input);
  assert(!output.includes('<s'), 'should escape <');
  assert(output.includes('&lt;'), 'should have &lt;');
  assert(output.includes('&gt;'), 'should have &gt;');
  assert(output.includes('&quot;'), 'should have &quot;');
  assert(output.includes('&#39;'), 'should have &#39;');
  assert(output.includes('&amp;'), 'should have &amp;');
});

test('escapeSvg: null/undefined → empty string', () => {
  assert(escapeSvg(null) === '');
  assert(escapeSvg(undefined) === '');
});

// ═══════════════════════════════════════════════════════════════
// FILENAME SANITIZATION (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Filename sanitization ──');

test('sanitizeFilename: valid receipt_id passes', () => {
  assert(sanitizeFilename('art_v12_cp_TESTMINT_0') === 'art_v12_cp_TESTMINT_0');
});

test('sanitizeFilename: path traversal rejected', () => {
  let threw = false;
  try { sanitizeFilename('../etc/passwd'); } catch { threw = true; }
  assert(threw, 'should reject path traversal');
});

test('sanitizeFilename: spaces and special chars rejected', () => {
  let threw = false;
  try { sanitizeFilename('receipt id with spaces'); } catch { threw = true; }
  assert(threw, 'should reject spaces');

  threw = false;
  try { sanitizeFilename('receipt;rm -rf /'); } catch { threw = true; }
  assert(threw, 'should reject shell metacharacters');
});

// ═══════════════════════════════════════════════════════════════
// SVG STRUCTURE (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── SVG structure ──');

test('starts with <svg and ends with </svg>', () => {
  const svg = renderReceiptSvg(makePreview('closed_position'));
  assert(svg.startsWith('<svg'), 'should start with <svg');
  assert(svg.trimEnd().endsWith('</svg>'), 'should end with </svg>');
});

test('has xmlns attribute', () => {
  const svg = renderReceiptSvg(makePreview('closed_position'));
  assert(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'should have xmlns');
});

test('no script, foreignObject, or event handlers', () => {
  const svg = renderReceiptSvg(makePreview('closed_position'));
  assert(!svg.includes('<script'), 'no script');
  assert(!svg.includes('foreignObject'), 'no foreignObject');
  assert(!svg.includes('onclick'), 'no onclick');
  assert(!svg.includes('onload'), 'no onload');
  assert(!svg.includes('onerror'), 'no onerror');
});

// ═══════════════════════════════════════════════════════════════
// CLOSED_POSITION (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── closed_position SVG ──');

test('contains PnL percentage and profit color', () => {
  const svg = renderReceiptSvg(makePreview('closed_position'));
  assert(svg.includes('+50.000%'), 'should have PnL pct');
  assert(svg.includes('#00c076'), 'should have profit green color');
});

test('contains status label and receipt_id', () => {
  const svg = renderReceiptSvg(makePreview('closed_position'));
  assert(svg.includes('Verified Closed Position'), 'should have status');
  assert(svg.includes('art_v12_xx_TESTMINT_0'), 'should have receipt_id');
});

test('contains pair and wallet', () => {
  const svg = renderReceiptSvg(makePreview('closed_position'));
  assert(svg.includes('SOL'), 'should have quote symbol');
  assert(svg.includes('solana'), 'should have chain');
  assert(svg.includes('TESTWA'), 'should have wallet prefix');
});

// ═══════════════════════════════════════════════════════════════
// REALIZED_PARTIAL (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── realized_partial SVG ──');

test('contains remaining qty and partial status', () => {
  const svg = renderReceiptSvg(makePreview('realized_partial'));
  assert(svg.includes('Remaining'), 'should show remaining label');
  assert(svg.includes('500'), 'should show remaining qty');
  assert(svg.includes('Verified Partial'), 'should have partial status');
});

test('has amber accent color', () => {
  const svg = renderReceiptSvg(makePreview('realized_partial'));
  assert(svg.includes('#f0a030'), 'should have amber accent');
});

// ═══════════════════════════════════════════════════════════════
// OPEN_SNAPSHOT (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── open_snapshot SVG ──');

test('no PnL percentage, has snapshot notice', () => {
  const svg = renderReceiptSvg(makePreview('open_snapshot'));
  assert(!svg.includes('+50.000%'), 'should NOT have PnL pct');
  assert(svg.includes('No PnL Claim'), 'should have snapshot notice');
});

test('has blue accent color', () => {
  const svg = renderReceiptSvg(makePreview('open_snapshot'));
  assert(svg.includes('#4a90d9'), 'should have blue accent');
});

// ═══════════════════════════════════════════════════════════════
// UNVERIFIED (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── unverified SVG ──');

test('has red accent and unverified label', () => {
  const p = makePreview('closed_position', {
    verification_status: 'unverified',
    display_status: 'Unverified \u2014 See Limitations',
  });
  const svg = renderReceiptSvg(p);
  assert(svg.includes('#ff4d4d'), 'should have red accent');
  assert(svg.includes('Unverified'), 'should have unverified label');
});

test('escapes special chars in injected data', () => {
  const p = makePreview('closed_position', {
    display_status: '<b>Injected</b> & "quoted"',
  });
  const svg = renderReceiptSvg(p);
  assert(!svg.includes('<b>Injected</b>'), 'should escape injected HTML');
  assert(svg.includes('&lt;b&gt;'), 'should have escaped tag');
});

// ═══════════════════════════════════════════════════════════════
// VALUATION DISPLAY (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Valuation display ──');

test('raw_quote visible in SVG', () => {
  const svg = renderReceiptSvg(makePreview('closed_position'));
  assert(svg.includes('Raw Quote'), 'should contain raw quote label');
});

test('USDC guardrail wording present', () => {
  const p = makePreview('closed_position', { quote_mint: USDC_MINT, quote_symbol: 'USDC' });
  const svg = renderReceiptSvg(p);
  assert(svg.includes('USD-stable quote asset'), 'should have guardrail');
  assert(svg.includes('still raw quote'), 'should disclaim');
});

// ═══════════════════════════════════════════════════════════════
// PROOF FOOTER (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Proof footer ──');

test('contains receipt hash short and candidate hash short', () => {
  const svg = renderReceiptSvg(makePreview('closed_position'));
  assert(svg.includes('aaaaaaaaaaaa'), 'should have receipt hash short');
  assert(svg.includes('cccccccccccc'), 'should have candidate hash short');
  assert(svg.includes('weighted_average'), 'should have accounting method');
});

// ═══════════════════════════════════════════════════════════════
// DETERMINISM (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Determinism ──');

test('same preview \u2192 identical SVG', () => {
  const p = makePreview('closed_position');
  const s1 = renderReceiptSvg(p);
  const s2 = renderReceiptSvg(p);
  assert(s1 === s2, 'should be identical');
});

// ═══════════════════════════════════════════════════════════════
// BATCH (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Batch ──');

test('batch: multiple previews', () => {
  const previews = [
    makePreview('closed_position'),
    makePreview('realized_partial'),
    makePreview('open_snapshot'),
  ];
  const svgs = renderReceiptSvgBatch(previews);
  assert(svgs.length === 3, `expected 3, got ${svgs.length}`);
  assert(svgs.every(s => s.startsWith('<svg')), 'all should be valid SVGs');
});

test('batch: empty array', () => {
  const svgs = renderReceiptSvgBatch([]);
  assert(svgs.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Receipt Image SVG: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
