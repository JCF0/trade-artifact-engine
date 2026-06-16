/**
 * Receipt Metadata Scaffold Tests — E1
 *
 * Tests for metadata generation from v1.2 receipts + D1 previews.
 */

import { buildReceiptMetadata, buildReceiptMetadataBatch } from './receipt-metadata.mjs';
import { buildReceiptPreview } from './receipt-preview.mjs';
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
// Fixture helpers
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

function buildMeta(type, overrides = {}) {
  const receipt = makeReceipt(type, overrides);
  const preview = buildReceiptPreview(receipt);
  return { meta: buildReceiptMetadata(receipt, preview), receipt, preview };
}

// ═══════════════════════════════════════════════════════════════
// CLOSED_POSITION (4 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── closed_position ──');

test('name and symbol', () => {
  const { meta } = buildMeta('closed_position');
  assert(meta.name === 'Trade Receipt #art_v12_xx_TESTMINT_0', `got ${meta.name}`);
  assert(meta.symbol === 'TREC', `got ${meta.symbol}`);
});

test('description includes status + PnL + valuation', () => {
  const { meta } = buildMeta('closed_position');
  assert(meta.description.includes('Verified Closed Position'), 'should include status');
  assert(meta.description.includes('+50.000%'), 'should include PnL pct');
  assert(meta.description.includes('raw_quote'), 'should include valuation');
  assert(meta.description.includes('No USD normalization'), 'should disclaim USD');
});

test('attributes complete', () => {
  const { meta } = buildMeta('closed_position');
  const byTrait = new Map(meta.attributes.map(a => [a.trait_type, a]));
  assert(byTrait.get('receipt_type').value === 'closed_position');
  assert(byTrait.get('verification_status').value === 'verified');
  assert(byTrait.get('display_status').value === 'Verified Closed Position');
  assert(byTrait.get('chain').value === 'solana');
  assert(byTrait.get('quote_symbol').value === 'SOL');
  assert(byTrait.get('valuation_status').value === 'raw_quote');
  assert(byTrait.get('realized_pnl_pct').value === 50);
  assert(byTrait.get('realized_pnl_quote').value === 5);
  assert(byTrait.get('hold_time_seconds').value === 100000);
  assert(byTrait.get('num_buys').value === 1);
  assert(byTrait.get('num_sells').value === 1);
  assert(byTrait.get('quote_is_usd_stable').value === false);
});

test('properties has proof hashes and limitations', () => {
  const { meta } = buildMeta('closed_position');
  assert(meta.properties.receipt_hash === 'a'.repeat(64), 'receipt_hash');
  assert(meta.properties.candidate_hash === 'c'.repeat(64), 'candidate_hash');
  assert(meta.properties.receipt_version === '1.2.0');
  assert(meta.properties.accounting_method.includes('weighted_average'));
  assert(meta.properties.valuation_status === 'raw_quote');
  assert(meta.properties.valuation_currency === 'raw_quote');
  assert(meta.properties.limitations.receipt_scope === 'closed_position');
  assert(meta.properties.limitations.pnl_type === 'realized_closed');
  assert(meta.properties.limitations.disclosures.includes('no_usd_normalization'));
  assert(meta.properties.category === 'image');
  assert(Array.isArray(meta.properties.files) && meta.properties.files.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// REALIZED_PARTIAL (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── realized_partial ──');

test('description mentions partial', () => {
  const { meta } = buildMeta('realized_partial');
  assert(meta.description.includes('Verified Partial'), 'should mention partial');
  assert(meta.description.includes('PnL:'), 'should have PnL');
});

test('attributes have PnL and position_open disclosure', () => {
  const { meta } = buildMeta('realized_partial');
  const byTrait = new Map(meta.attributes.map(a => [a.trait_type, a]));
  assert(byTrait.get('realized_pnl_pct').value === 50);
  assert(meta.properties.limitations.disclosures.includes('position_open'));
});

test('limitations pnl_type is realized_partial', () => {
  const { meta } = buildMeta('realized_partial');
  assert(meta.properties.limitations.pnl_type === 'realized_partial');
});

// ═══════════════════════════════════════════════════════════════
// OPEN_SNAPSHOT (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── open_snapshot ──');

test('description says no PnL claim', () => {
  const { meta } = buildMeta('open_snapshot');
  assert(meta.description.includes('No PnL claim'), 'should say no PnL');
  assert(!meta.description.includes('PnL: +'), 'should not have PnL value');
});

test('null PnL attributes omitted', () => {
  const { meta } = buildMeta('open_snapshot');
  const traits = new Set(meta.attributes.map(a => a.trait_type));
  assert(!traits.has('realized_pnl_pct'), 'should not have pnl_pct');
  assert(!traits.has('realized_pnl_quote'), 'should not have pnl_quote');
  assert(!traits.has('hold_time_seconds'), 'should not have hold_time');
});

test('disclosures include no_pnl_claim and no_live_price', () => {
  const { meta } = buildMeta('open_snapshot');
  const d = meta.properties.limitations.disclosures;
  assert(d.includes('no_pnl_claim'), 'should have no_pnl_claim');
  assert(d.includes('no_live_price'), 'should have no_live_price');
});

// ═══════════════════════════════════════════════════════════════
// UNVERIFIED (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── unverified ──');

test('description mentions unverified', () => {
  const { meta } = buildMeta('closed_position', {
    verification_status: 'unverified',
    display_status: 'Unverified — See Limitations',
    flags: ['mixed_quote'],
    limitations: { disclosures: ['no_usd_normalization', 'mixed_quote_currencies'] },
  });
  assert(meta.description.includes('Unverified'), 'should mention unverified');
});

test('flag disclosures in properties', () => {
  const { meta } = buildMeta('closed_position', {
    verification_status: 'unverified',
    display_status: 'Unverified — See Limitations',
    flags: ['mixed_quote'],
    limitations: { disclosures: ['no_usd_normalization', 'mixed_quote_currencies'] },
  });
  assert(meta.properties.limitations.disclosures.includes('mixed_quote_currencies'));
});

// ═══════════════════════════════════════════════════════════════
// VALUATION IN METADATA (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Valuation in metadata ──');

test('raw_quote in attributes', () => {
  const { meta } = buildMeta('closed_position');
  const byTrait = new Map(meta.attributes.map(a => [a.trait_type, a]));
  assert(byTrait.get('valuation_status').value === 'raw_quote');
});

test('USDC: quote_is_usd_stable=true + guardrail description', () => {
  const { meta } = buildMeta('closed_position', { quote_mint: USDC_MINT, quote_symbol: 'USDC' });
  const byTrait = new Map(meta.attributes.map(a => [a.trait_type, a]));
  assert(byTrait.get('quote_is_usd_stable').value === true, 'USDC should be usd_stable');
  assert(meta.description.includes('USD-stable quote asset'), 'should have guardrail');
  assert(meta.description.includes('still raw quote'), 'should disclaim');
  assert(meta.description.includes('no historical USD normalization'), 'should disclaim normalization');
  assert(!meta.description.includes('1:1'), 'must NOT say 1:1');
});

test('USDT same guardrail as USDC', () => {
  const { meta } = buildMeta('closed_position', { quote_mint: USDT_MINT, quote_symbol: 'USDT' });
  const byTrait = new Map(meta.attributes.map(a => [a.trait_type, a]));
  assert(byTrait.get('quote_is_usd_stable').value === true);
  assert(meta.description.includes('USD-stable quote asset'));
});

// ═══════════════════════════════════════════════════════════════
// PLACEHOLDERS (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Placeholders ──');

test('image=null, external_url=null, files=[]', () => {
  const { meta } = buildMeta('closed_position');
  assert(meta.image === null, 'image should be null');
  assert(meta.external_url === null, 'external_url should be null');
  assert(Array.isArray(meta.properties.files) && meta.properties.files.length === 0, 'files should be []');
});

test('_scaffold block present with correct status', () => {
  const { meta } = buildMeta('closed_position');
  assert(meta._scaffold, '_scaffold should exist');
  assert(meta._scaffold.version === '1.0.0');
  assert(meta._scaffold.status === 'placeholder');
  assert(meta._scaffold.image_status === 'not_rendered');
  assert(meta._scaffold.upload_status === 'not_uploaded');
  assert(typeof meta._scaffold.notes === 'string' && meta._scaffold.notes.length > 0);
});

// ═══════════════════════════════════════════════════════════════
// DETERMINISM (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Determinism ──');

test('same inputs → identical metadata', () => {
  const receipt = makeReceipt('closed_position');
  const preview = buildReceiptPreview(receipt);
  const m1 = buildReceiptMetadata(receipt, preview);
  const m2 = buildReceiptMetadata(receipt, preview);
  assert(JSON.stringify(m1) === JSON.stringify(m2), 'should be identical');
});

// ═══════════════════════════════════════════════════════════════
// VALUATION CONTEXT (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Valuation context input ──');

test('valuation context overrides usd_stable detection', () => {
  const receipt = makeReceipt('closed_position');
  const preview = buildReceiptPreview(receipt);
  // SOL is not USD-stable, but pass a context saying it is
  const ctx = { quote_is_usd_stable: true };
  const meta = buildReceiptMetadata(receipt, preview, ctx);
  const byTrait = new Map(meta.attributes.map(a => [a.trait_type, a]));
  assert(byTrait.get('quote_is_usd_stable').value === true, 'should use context override');
});

// ═══════════════════════════════════════════════════════════════
// BATCH (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Batch ──');

test('batch: multiple receipts', () => {
  const types = ['closed_position', 'realized_partial', 'open_snapshot'];
  const receipts = types.map(t => makeReceipt(t));
  const previews = receipts.map(r => buildReceiptPreview(r));
  const batch = buildReceiptMetadataBatch(receipts, previews);
  assert(batch.length === 3, `expected 3, got ${batch.length}`);
  assert(batch[0].description.includes('Verified Closed'));
  assert(batch[1].description.includes('Verified Partial'));
  assert(batch[2].description.includes('No PnL claim'));
});

test('batch: empty arrays', () => {
  const batch = buildReceiptMetadataBatch([], []);
  assert(batch.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Receipt Metadata: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
