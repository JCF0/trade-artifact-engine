/**
 * Receipt Verifier Tests — B3
 *
 * ~70 tests covering hash recomputation, schema validation,
 * type-specific rules, and status/disclosure consistency.
 */

import { computeReceiptHash } from './receipt-promotion.mjs';
import { verifyReceipt, verifyReceiptBatch } from './receipt-verifier.mjs';

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

function assertViolation(result, ruleCode) {
  const found = result.rule_violations.some(v => v.rule === ruleCode);
  assert(found, `expected violation ${ruleCode}, got: [${result.rule_violations.map(v => v.rule).join(', ')}]`);
}

function assertNoViolation(result, ruleCode) {
  const found = result.rule_violations.some(v => v.rule === ruleCode);
  assert(!found, `unexpected violation ${ruleCode}`);
}

// ═══════════════════════════════════════════════════════════════
// Fixture helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Extract hash fields from a receipt object (same mapping as the verifier).
 */
function extractHashFields(r) {
  return {
    receipt_version:            r.receipt_version,
    receipt_type:               r.receipt_type,
    wallet:                     r.wallet,
    chain:                      r.chain,
    token_mint:                 r.token_mint,
    segment_index:              r.segment_index,
    quote_mint:                 r.quote_mint,
    quote_symbol:               r.quote_symbol,
    valuation_status:           r.valuation_status,
    first_event_at:             r.first_event_at,
    last_event_at:              r.last_event_at,
    entry_tx_hashes:            r.entry_tx_hashes,
    exit_tx_hashes:             r.exit_tx_hashes,
    total_bought_qty:           r.total_bought_qty,
    total_bought_quote:         r.total_bought_quote,
    avg_buy_quote_price:        r.avg_buy_quote_price,
    total_sold_qty:             r.total_sold_qty,
    total_sold_quote:           r.total_sold_quote,
    avg_sell_quote_price:       r.avg_sell_quote_price,
    allocated_cost_basis_quote: r.allocated_cost_basis_quote,
    remaining_qty:              r.remaining_qty,
    remaining_cost_basis_quote: r.remaining_cost_basis_quote,
    realized_pnl_quote:         r.realized_pnl_quote,
    realized_pnl_pct:           r.realized_pnl_pct,
    flags:                      r.flags,
    accounting_method:          r.accounting_method,
    verification_status:        r.verification_status,
  };
}

/**
 * Build a valid receipt of the given type, compute its hash.
 * All returned receipts pass verification out of the box.
 */
function makeReceipt(type) {
  const base = {
    receipt_id:            `art_v12_xx_TESTMINT_0`,
    receipt_version:       '1.2.0',
    receipt_type:          type,
    token_mint:            'TESTMINT1234567890123456789012345678901234abcd',
    wallet:                'TESTWALLET12345678901234567890123456789012345',
    chain:                 'solana',
    segment_index:         0,
    receipt_hash:          null, // computed below
    verification_status:   null, // set per type
    display_status:        null, // set per type
    accounting_method:     'weighted_average_position_accounting_v1',
    quote_mint:            'So11111111111111111111111111111111111111112',
    quote_symbol:          'SOL',
    valuation_status:      'raw_quote',
    total_bought_qty:      1000,
    total_bought_quote:    10,
    avg_buy_quote_price:   0.01,
    total_sold_qty:        null, // set per type
    total_sold_quote:      null,
    avg_sell_quote_price:  null,
    allocated_cost_basis_quote: null,
    remaining_qty:         null,
    remaining_cost_basis_quote: 0,
    realized_pnl_quote:    null,
    realized_pnl_pct:      null,
    unrealized_pnl_quote:  null,
    unrealized_pnl_pct:    null,
    position_status:       null,
    first_event_at:        1700000000,
    last_event_at:         1700100000,
    snapshot_at:           null,
    hold_time_seconds:     null,
    entry_tx_hashes:       ['aaaa1111'],
    exit_tx_hashes:        [],
    num_buys:              1,
    num_sells:             0,
    limitations:           null, // set per type
    flags:                 [],
    candidate_hash:        'c'.repeat(64),
    source:                'position_ledger_v1',
    promoted_at:           1700100000,
    promoted_from:         `lrc_${type}_TESTMINT_0`,
    ledger_accounting_version: 'weighted_average_position_accounting_v1',
  };

  if (type === 'closed_position') {
    base.total_sold_qty = 1000;
    base.total_sold_quote = 15;
    base.avg_sell_quote_price = 0.015;
    base.allocated_cost_basis_quote = 10;
    base.remaining_qty = 0;
    base.remaining_cost_basis_quote = 0;
    base.realized_pnl_quote = 5;
    base.realized_pnl_pct = 50;
    base.position_status = 'closed';
    base.hold_time_seconds = 100000;
    base.exit_tx_hashes = ['bbbb2222'];
    base.num_sells = 1;
    base.verification_status = 'verified';
    base.display_status = 'Verified Closed Position';
    base.limitations = {
      receipt_scope: 'closed_position',
      pnl_type: 'realized_closed',
      price_source: 'on_chain_swaps',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    };
  } else if (type === 'realized_partial') {
    base.total_sold_qty = 500;
    base.total_sold_quote = 7.5;
    base.avg_sell_quote_price = 0.015;
    base.allocated_cost_basis_quote = 5;
    base.remaining_qty = 500;
    base.remaining_cost_basis_quote = 5;
    base.realized_pnl_quote = 2.5;
    base.realized_pnl_pct = 50;
    base.position_status = 'open';
    base.hold_time_seconds = 100000;
    base.exit_tx_hashes = ['bbbb2222'];
    base.num_sells = 1;
    base.verification_status = 'verified_partial';
    base.display_status = 'Verified Partial (Position Open)';
    base.limitations = {
      receipt_scope: 'realized_partial',
      pnl_type: 'realized_partial',
      price_source: 'on_chain_swaps',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization', 'position_open'],
    };
  } else if (type === 'open_snapshot') {
    base.total_sold_qty = null;
    base.total_sold_quote = null;
    base.avg_sell_quote_price = null;
    base.allocated_cost_basis_quote = null;
    base.remaining_qty = 1000;
    base.remaining_cost_basis_quote = 10;
    base.realized_pnl_quote = null;
    base.realized_pnl_pct = null;
    base.position_status = 'open';
    base.hold_time_seconds = null;
    base.snapshot_at = 1700200000;
    base.verification_status = 'verified_snapshot';
    base.display_status = 'Verified Snapshot (No PnL Claim)';
    base.limitations = {
      receipt_scope: 'open_snapshot',
      pnl_type: 'none',
      price_source: 'none',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization', 'no_pnl_claim', 'no_live_price'],
    };
  }

  // Compute valid hash
  base.receipt_hash = computeReceiptHash(extractHashFields(base));
  return base;
}

/**
 * Deep clone a receipt, apply mutations, optionally recompute hash.
 *
 * When rehash=true (default), the receipt_hash is recomputed from the
 * mutated data so the hash check passes and only the semantic rule
 * is tested in isolation.
 *
 * When rehash=false, the hash is left stale so hash_valid=false.
 */
function mutate(receipt, mutations, rehash = true) {
  const r = JSON.parse(JSON.stringify(receipt));
  for (const [key, value] of Object.entries(mutations)) {
    if (key === 'limitations' && value && typeof value === 'object' && !Array.isArray(value)) {
      r.limitations = { ...r.limitations, ...value };
    } else {
      r[key] = value;
    }
  }
  if (rehash) {
    r.receipt_hash = computeReceiptHash(extractHashFields(r));
  }
  return r;
}

/**
 * Build a receipt with disqualifying flags for unverified tests.
 */
function makeUnverifiedReceipt(type) {
  const r = makeReceipt(type);
  r.flags = ['mixed_quote'];
  r.verification_status = 'unverified';
  r.display_status = 'Unverified — See Limitations';
  r.limitations.disclosures = [...r.limitations.disclosures, 'mixed_quote_currencies'];
  r.receipt_hash = computeReceiptHash(extractHashFields(r));
  return r;
}

// ═══════════════════════════════════════════════════════════════
// Build fixtures
// ═══════════════════════════════════════════════════════════════

const cpReceipt = makeReceipt('closed_position');
const rpReceipt = makeReceipt('realized_partial');
const osReceipt = makeReceipt('open_snapshot');

// ═══════════════════════════════════════════════════════════════
// HAPPY PATH TESTS (3)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Happy paths ──');

test('valid closed_position passes', () => {
  const result = verifyReceipt(cpReceipt);
  assert(result.pass === true, `expected pass=true, got violations: [${result.rule_violations.map(v => v.rule).join(', ')}]`);
  assert(result.hash_valid === true, 'hash should be valid');
  assert(result.schema_valid === true, 'schema should be valid');
  assert(result.consistency_valid === true, 'consistency should be valid');
});

test('valid realized_partial passes', () => {
  const result = verifyReceipt(rpReceipt);
  assert(result.pass === true, `expected pass=true, got violations: [${result.rule_violations.map(v => v.rule).join(', ')}]`);
});

test('valid open_snapshot passes', () => {
  const result = verifyReceipt(osReceipt);
  assert(result.pass === true, `expected pass=true, got violations: [${result.rule_violations.map(v => v.rule).join(', ')}]`);
});

// ═══════════════════════════════════════════════════════════════
// HASH RECOMPUTATION TESTS (3)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Hash recomputation ──');

test('closed_position: tampered field → hash_valid=false', () => {
  const r = mutate(cpReceipt, { total_sold_quote: 999 }, false); // no rehash
  const result = verifyReceipt(r);
  assert(result.hash_valid === false, 'hash should be invalid');
  assertViolation(result, 'HASH');
});

test('realized_partial: tampered field → hash_valid=false', () => {
  const r = mutate(rpReceipt, { realized_pnl_quote: 999 }, false);
  const result = verifyReceipt(r);
  assert(result.hash_valid === false, 'hash should be invalid');
});

test('open_snapshot: tampered field → hash_valid=false', () => {
  const r = mutate(osReceipt, { total_bought_qty: 1 }, false);
  const result = verifyReceipt(r);
  assert(result.hash_valid === false, 'hash should be invalid');
});

// ═══════════════════════════════════════════════════════════════
// SHARED SCHEMA TESTS (S-1 to S-16)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Shared schema (S-*) ──');

test('S-1: bad receipt_version', () => {
  const r = mutate(cpReceipt, { receipt_version: '2.0.0' });
  assertViolation(verifyReceipt(r), 'S-1');
});

test('S-2: bad receipt_type', () => {
  const r = mutate(cpReceipt, { receipt_type: 'invalid_type' });
  assertViolation(verifyReceipt(r), 'S-2');
});

test('S-3: bad receipt_hash format', () => {
  const r = mutate(cpReceipt, { receipt_hash: 'not-hex' }, false);
  assertViolation(verifyReceipt(r), 'S-3');
});

test('S-4: empty wallet', () => {
  const r = mutate(cpReceipt, { wallet: '' });
  assertViolation(verifyReceipt(r), 'S-4');
});

test('S-5: empty chain', () => {
  const r = mutate(cpReceipt, { chain: '' });
  assertViolation(verifyReceipt(r), 'S-5');
});

test('S-6: empty token_mint', () => {
  const r = mutate(cpReceipt, { token_mint: '' });
  assertViolation(verifyReceipt(r), 'S-6');
});

test('S-7: negative segment_index', () => {
  const r = mutate(cpReceipt, { segment_index: -1 });
  assertViolation(verifyReceipt(r), 'S-7');
});

test('S-7b: float segment_index', () => {
  const r = mutate(cpReceipt, { segment_index: 1.5 });
  assertViolation(verifyReceipt(r), 'S-7');
});

test('S-8: zero first_event_at', () => {
  const r = mutate(cpReceipt, { first_event_at: 0 });
  assertViolation(verifyReceipt(r), 'S-8');
});

test('S-9: last_event_at < first_event_at', () => {
  const r = mutate(cpReceipt, { last_event_at: 1699999999 });
  assertViolation(verifyReceipt(r), 'S-9');
});

test('S-10: zero total_bought_qty', () => {
  const r = mutate(cpReceipt, { total_bought_qty: 0 });
  assertViolation(verifyReceipt(r), 'S-10');
});

test('S-11: zero total_bought_quote', () => {
  const r = mutate(cpReceipt, { total_bought_quote: 0 });
  assertViolation(verifyReceipt(r), 'S-11');
});

test('S-12: zero avg_buy_quote_price', () => {
  const r = mutate(cpReceipt, { avg_buy_quote_price: 0 });
  assertViolation(verifyReceipt(r), 'S-12');
});

test('S-13: unsorted flags', () => {
  const r = mutate(cpReceipt, { flags: ['z_flag', 'a_flag'], verification_status: 'unverified', display_status: 'Unverified — See Limitations' });
  assertViolation(verifyReceipt(r), 'S-13');
});

test('S-14: empty accounting_method', () => {
  const r = mutate(cpReceipt, { accounting_method: '' });
  assertViolation(verifyReceipt(r), 'S-14');
});

test('S-15: bad verification_status', () => {
  const r = mutate(cpReceipt, { verification_status: 'pending' });
  assertViolation(verifyReceipt(r), 'S-15');
});

test('S-16: missing limitations', () => {
  const r = mutate(cpReceipt, { limitations: null });
  assertViolation(verifyReceipt(r), 'S-16');
});

// ═══════════════════════════════════════════════════════════════
// CLOSED_POSITION TESTS (CP-1 to CP-10)
// ═══════════════════════════════════════════════════════════════

console.log('\n── closed_position (CP-*) ──');

test('CP-1: null total_sold_qty', () => {
  const r = mutate(cpReceipt, { total_sold_qty: null });
  assertViolation(verifyReceipt(r), 'CP-1');
});

test('CP-2: null total_sold_quote', () => {
  const r = mutate(cpReceipt, { total_sold_quote: null });
  assertViolation(verifyReceipt(r), 'CP-2');
});

test('CP-3: null allocated_cost_basis_quote', () => {
  const r = mutate(cpReceipt, { allocated_cost_basis_quote: null });
  assertViolation(verifyReceipt(r), 'CP-3');
});

test('CP-4: null realized_pnl_quote', () => {
  const r = mutate(cpReceipt, { realized_pnl_quote: null });
  assertViolation(verifyReceipt(r), 'CP-4');
});

test('CP-5: null realized_pnl_pct', () => {
  const r = mutate(cpReceipt, { realized_pnl_pct: null });
  assertViolation(verifyReceipt(r), 'CP-5');
});

test('CP-6: large remaining_qty', () => {
  const r = mutate(cpReceipt, { remaining_qty: 500 });
  assertViolation(verifyReceipt(r), 'CP-6');
});

test('CP-6b: dust remaining_qty is OK', () => {
  const r = mutate(cpReceipt, { remaining_qty: 0.0001 });
  assertNoViolation(verifyReceipt(r), 'CP-6');
});

test('CP-7: empty exit_tx_hashes', () => {
  const r = mutate(cpReceipt, { exit_tx_hashes: [] });
  assertViolation(verifyReceipt(r), 'CP-7');
});

test('CP-8: empty entry_tx_hashes', () => {
  const r = mutate(cpReceipt, { entry_tx_hashes: [] });
  assertViolation(verifyReceipt(r), 'CP-8');
});

test('CP-9: null hold_time_seconds', () => {
  const r = mutate(cpReceipt, { hold_time_seconds: null });
  assertViolation(verifyReceipt(r), 'CP-9');
});

test('CP-10: non-null snapshot_at', () => {
  const r = mutate(cpReceipt, { snapshot_at: 1700200000 });
  assertViolation(verifyReceipt(r), 'CP-10');
});

// ═══════════════════════════════════════════════════════════════
// REALIZED_PARTIAL TESTS (RP-1 to RP-6)
// ═══════════════════════════════════════════════════════════════

console.log('\n── realized_partial (RP-*) ──');

test('RP-1: null total_sold_qty', () => {
  const r = mutate(rpReceipt, { total_sold_qty: null });
  assertViolation(verifyReceipt(r), 'RP-1');
});

test('RP-2: null realized_pnl_quote', () => {
  const r = mutate(rpReceipt, { realized_pnl_quote: null });
  assertViolation(verifyReceipt(r), 'RP-2');
});

test('RP-3: zero remaining_qty', () => {
  const r = mutate(rpReceipt, { remaining_qty: 0 });
  assertViolation(verifyReceipt(r), 'RP-3');
});

test('RP-4: empty exit_tx_hashes', () => {
  const r = mutate(rpReceipt, { exit_tx_hashes: [] });
  assertViolation(verifyReceipt(r), 'RP-4');
});

test('RP-5: empty entry_tx_hashes', () => {
  const r = mutate(rpReceipt, { entry_tx_hashes: [] });
  assertViolation(verifyReceipt(r), 'RP-5');
});

test('RP-6: non-null snapshot_at', () => {
  const r = mutate(rpReceipt, { snapshot_at: 1700200000 });
  assertViolation(verifyReceipt(r), 'RP-6');
});

// ═══════════════════════════════════════════════════════════════
// OPEN_SNAPSHOT TESTS (OS-1 to OS-10)
// ═══════════════════════════════════════════════════════════════

console.log('\n── open_snapshot (OS-*) ──');

test('OS-1: non-null total_sold_qty', () => {
  const r = mutate(osReceipt, { total_sold_qty: 100 });
  assertViolation(verifyReceipt(r), 'OS-1');
});

test('OS-2: non-null total_sold_quote', () => {
  const r = mutate(osReceipt, { total_sold_quote: 5 });
  assertViolation(verifyReceipt(r), 'OS-2');
});

test('OS-3: non-null avg_sell_quote_price', () => {
  const r = mutate(osReceipt, { avg_sell_quote_price: 0.05 });
  assertViolation(verifyReceipt(r), 'OS-3');
});

test('OS-4: non-null allocated_cost_basis_quote', () => {
  const r = mutate(osReceipt, { allocated_cost_basis_quote: 5 });
  assertViolation(verifyReceipt(r), 'OS-4');
});

test('OS-5: non-null realized_pnl_quote', () => {
  const r = mutate(osReceipt, { realized_pnl_quote: 1 });
  assertViolation(verifyReceipt(r), 'OS-5');
});

test('OS-6: non-null realized_pnl_pct', () => {
  const r = mutate(osReceipt, { realized_pnl_pct: 10 });
  assertViolation(verifyReceipt(r), 'OS-6');
});

test('OS-7: non-empty exit_tx_hashes', () => {
  const r = mutate(osReceipt, { exit_tx_hashes: ['xxxx'] });
  assertViolation(verifyReceipt(r), 'OS-7');
});

test('OS-8: empty entry_tx_hashes', () => {
  const r = mutate(osReceipt, { entry_tx_hashes: [] });
  assertViolation(verifyReceipt(r), 'OS-8');
});

test('OS-9: zero remaining_qty', () => {
  const r = mutate(osReceipt, { remaining_qty: 0 });
  assertViolation(verifyReceipt(r), 'OS-9');
});

test('OS-10: null snapshot_at', () => {
  const r = mutate(osReceipt, { snapshot_at: null });
  assertViolation(verifyReceipt(r), 'OS-10');
});

// ═══════════════════════════════════════════════════════════════
// CONSISTENCY TESTS (C-1 to C-20)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Consistency (C-*) ──');

test('C-1: closed_position must be verified (no flags)', () => {
  const r = mutate(cpReceipt, { verification_status: 'unverified', display_status: 'Unverified — See Limitations' });
  assertViolation(verifyReceipt(r), 'C-1');
});

test('C-2: realized_partial must be verified_partial (no flags)', () => {
  const r = mutate(rpReceipt, { verification_status: 'verified', display_status: 'Verified Closed Position' });
  assertViolation(verifyReceipt(r), 'C-2');
});

test('C-3: open_snapshot must be verified_snapshot (no flags)', () => {
  const r = mutate(osReceipt, { verification_status: 'verified', display_status: 'Verified Closed Position' });
  assertViolation(verifyReceipt(r), 'C-3');
});

test('C-4: disqualifying flag → must be unverified', () => {
  const r = makeUnverifiedReceipt('closed_position');
  // Override to non-unverified
  r.verification_status = 'verified';
  r.display_status = 'Verified Closed Position';
  r.receipt_hash = computeReceiptHash(extractHashFields(r));
  assertViolation(verifyReceipt(r), 'C-4');
});

test('C-5: limitations.receipt_scope mismatch', () => {
  const r = mutate(cpReceipt, { limitations: { receipt_scope: 'open_snapshot' } });
  assertViolation(verifyReceipt(r), 'C-5');
});

test('C-6: closed_position pnl_type mismatch', () => {
  const r = mutate(cpReceipt, { limitations: { pnl_type: 'none' } });
  assertViolation(verifyReceipt(r), 'C-6');
});

test('C-7: realized_partial pnl_type mismatch', () => {
  const r = mutate(rpReceipt, { limitations: { pnl_type: 'none' } });
  assertViolation(verifyReceipt(r), 'C-7');
});

test('C-8: open_snapshot pnl_type mismatch', () => {
  const r = mutate(osReceipt, { limitations: { pnl_type: 'realized_closed' } });
  assertViolation(verifyReceipt(r), 'C-8');
});

test('C-9: open_snapshot price_source mismatch', () => {
  const r = mutate(osReceipt, { limitations: { price_source: 'on_chain_swaps' } });
  assertViolation(verifyReceipt(r), 'C-9');
});

test('C-10: closed_position price_source mismatch', () => {
  const r = mutate(cpReceipt, { limitations: { price_source: 'none' } });
  assertViolation(verifyReceipt(r), 'C-10');
});

test('C-11: missing no_usd_normalization', () => {
  const r = mutate(cpReceipt, { limitations: { disclosures: [] } });
  assertViolation(verifyReceipt(r), 'C-11');
});

test('C-12: realized_partial missing position_open', () => {
  const r = mutate(rpReceipt, { limitations: { disclosures: ['no_usd_normalization'] } });
  assertViolation(verifyReceipt(r), 'C-12');
});

test('C-13a: open_snapshot missing no_pnl_claim', () => {
  const r = mutate(osReceipt, { limitations: { disclosures: ['no_usd_normalization', 'no_live_price'] } });
  assertViolation(verifyReceipt(r), 'C-13a');
});

test('C-13b: open_snapshot missing no_live_price', () => {
  const r = mutate(osReceipt, { limitations: { disclosures: ['no_usd_normalization', 'no_pnl_claim'] } });
  assertViolation(verifyReceipt(r), 'C-13b');
});

test('C-14: mixed_quote flag without disclosure', () => {
  const r = makeUnverifiedReceipt('closed_position');
  r.limitations.disclosures = ['no_usd_normalization']; // remove mixed_quote_currencies
  r.receipt_hash = computeReceiptHash(extractHashFields(r));
  assertViolation(verifyReceipt(r), 'C-14');
});

test('C-15: partial_history flag without disclosure', () => {
  const r = makeReceipt('closed_position');
  r.flags = ['partial_history'];
  r.verification_status = 'unverified';
  r.display_status = 'Unverified — See Limitations';
  r.limitations.disclosures = ['no_usd_normalization']; // missing partial_trade_history
  r.receipt_hash = computeReceiptHash(extractHashFields(r));
  assertViolation(verifyReceipt(r), 'C-15');
});

test('C-16: unsupported_inventory flag without disclosure', () => {
  const r = makeReceipt('closed_position');
  r.flags = ['unsupported_inventory'];
  r.verification_status = 'unverified';
  r.display_status = 'Unverified — See Limitations';
  r.limitations.disclosures = ['no_usd_normalization'];
  r.receipt_hash = computeReceiptHash(extractHashFields(r));
  assertViolation(verifyReceipt(r), 'C-16');
});

test('C-17: external_transfer_possible flag without disclosure', () => {
  const r = makeReceipt('closed_position');
  r.flags = ['external_transfer_possible'];
  r.limitations.disclosures = ['no_usd_normalization'];
  r.receipt_hash = computeReceiptHash(extractHashFields(r));
  assertViolation(verifyReceipt(r), 'C-17');
});

test('C-18: display_status mismatch', () => {
  const r = mutate(cpReceipt, { display_status: 'Wrong Display' });
  assertViolation(verifyReceipt(r), 'C-18');
});

test('C-19: valuation_currency not raw_quote', () => {
  const r = mutate(cpReceipt, { limitations: { valuation_currency: 'usd' } });
  assertViolation(verifyReceipt(r), 'C-19');
});

test('C-20: phantom disclosure', () => {
  const r = mutate(cpReceipt, { limitations: { disclosures: ['no_usd_normalization', 'no_pnl_claim'] } });
  assertViolation(verifyReceipt(r), 'C-20');
});

test('C-20b: valid disclosures produce no C-20', () => {
  assertNoViolation(verifyReceipt(cpReceipt), 'C-20');
  assertNoViolation(verifyReceipt(rpReceipt), 'C-20');
  assertNoViolation(verifyReceipt(osReceipt), 'C-20');
});

// ═══════════════════════════════════════════════════════════════
// VALUATION TESTS (V-1 to V-6) — C2 integration
// ═══════════════════════════════════════════════════════════════

console.log('\n── Valuation (V-*) ──');

test('V-*: valid raw_quote receipts produce no V-* violations', () => {
  for (const r of [cpReceipt, rpReceipt, osReceipt]) {
    const result = verifyReceipt(r);
    const vViols = result.rule_violations.filter(v => v.rule.startsWith('V-'));
    assert(vViols.length === 0, `unexpected V-* violations: [${vViols.map(v => v.rule).join(', ')}]`);
  }
});

test('V-1: reserved status usd_normalized (rehashed)', () => {
  // valuation_status is hashed → rehash to isolate V-1
  const r = mutate(cpReceipt, { valuation_status: 'usd_normalized' });
  const result = verifyReceipt(r);
  assertViolation(result, 'V-1');
  assert(result.consistency_valid === false, 'V-1 must make consistency_valid=false');
  assert(result.pass === false, 'V-1 must make pass=false');
});

test('V-1: unknown garbage status (rehashed)', () => {
  const r = mutate(cpReceipt, { valuation_status: 'banana' });
  const result = verifyReceipt(r);
  assertViolation(result, 'V-1');
});

test('V-2: valuation_currency mismatch (non-hashed field)', () => {
  const r = mutate(cpReceipt, { limitations: { valuation_currency: 'usd' } });
  const result = verifyReceipt(r);
  assertViolation(result, 'V-2');
  // Also expect C-19 (intentional redundancy)
  assertViolation(result, 'C-19');
});

test('V-3: missing no_usd_normalization disclosure (non-hashed field)', () => {
  const r = mutate(cpReceipt, { limitations: { disclosures: [] } });
  const result = verifyReceipt(r);
  assertViolation(result, 'V-3');
  // Also expect C-11 (intentional redundancy)
  assertViolation(result, 'C-11');
});

test('V-4: non-null _usd field (non-hashed field)', () => {
  const r = mutate(cpReceipt, {});
  r.realized_pnl_usd = 42.5;
  const result = verifyReceipt(r);
  assertViolation(result, 'V-4');
  assert(result.consistency_valid === false, 'V-4 must make consistency_valid=false');
});

test('V-4: zero _usd field triggers violation', () => {
  const r = mutate(cpReceipt, {});
  r.total_pnl_usd = 0;
  const result = verifyReceipt(r);
  assertViolation(result, 'V-4');
});

test('V-5: empty quote_mint (rehashed)', () => {
  // quote_mint is hashed → rehash to isolate V-5
  const r = mutate(cpReceipt, { quote_mint: '' });
  const result = verifyReceipt(r);
  assertViolation(result, 'V-5');
});

test('V-6: empty quote_symbol (rehashed)', () => {
  // quote_symbol is hashed → rehash to isolate V-6
  const r = mutate(cpReceipt, { quote_symbol: '' });
  const result = verifyReceipt(r);
  assertViolation(result, 'V-6');
});

test('V-*: reserved status only fires V-1, skips V-2..V-6', () => {
  const r = mutate(cpReceipt, { valuation_status: 'usd_estimated' });
  const result = verifyReceipt(r);
  assertViolation(result, 'V-1');
  assertNoViolation(result, 'V-2');
  assertNoViolation(result, 'V-3');
  assertNoViolation(result, 'V-4');
  assertNoViolation(result, 'V-5');
  assertNoViolation(result, 'V-6');
});

// ═══════════════════════════════════════════════════════════════
// BATCH REPORT TESTS (2)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Batch report ──');

test('batch: all pass', () => {
  const report = verifyReceiptBatch([cpReceipt, rpReceipt, osReceipt]);
  assert(report.total === 3, `total should be 3, got ${report.total}`);
  assert(report.passed === 3, `passed should be 3, got ${report.passed}`);
  assert(report.failed === 0, `failed should be 0, got ${report.failed}`);
  assert(report.failures.length === 0, 'failures array should be empty');
  assert(report.by_type.closed_position === 1, 'by_type.closed_position should be 1');
  assert(report.by_type.realized_partial === 1, 'by_type.realized_partial should be 1');
  assert(report.by_type.open_snapshot === 1, 'by_type.open_snapshot should be 1');
});

test('batch: mix of pass/fail', () => {
  const bad = mutate(cpReceipt, { receipt_version: '9.9.9' });
  const report = verifyReceiptBatch([cpReceipt, bad, rpReceipt]);
  assert(report.total === 3, `total should be 3, got ${report.total}`);
  assert(report.passed === 2, `passed should be 2, got ${report.passed}`);
  assert(report.failed === 1, `failed should be 1, got ${report.failed}`);
  assert(report.failures.length === 1, 'failures array should have 1 entry');
  assertViolation(report.failures[0], 'S-1');
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Receipt Verifier: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
