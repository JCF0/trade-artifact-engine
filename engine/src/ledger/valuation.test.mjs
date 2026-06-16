/**
 * Valuation Schema Tests — C1
 *
 * Tests for valuation status classification, USD-stable mint detection,
 * valuation context building, receipt valuation validation, and
 * context validation.
 */

import {
  VALUATION_STATUSES,
  ACTIVE_VALUATION_STATUSES,
  USD_STABLE_MINTS,
  isActiveValuationStatus,
  isReservedValuationStatus,
  isUsdStableMint,
  buildValuationContext,
  validateReceiptValuation,
  validateValuationContext,
} from './valuation.mjs';

import { USDC_MINT, USDT_MINT, SOL_MINT } from '../pipeline/constants.mjs';

// ═══════════════════════════════════════════════════════════════
// Test harness (matches existing project pattern)
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
  const found = result.violations.some(v => v.rule === ruleCode);
  assert(found, `expected violation ${ruleCode}, got: [${result.violations.map(v => v.rule).join(', ')}]`);
}

function assertNoViolation(result, ruleCode) {
  const found = result.violations.some(v => v.rule === ruleCode);
  assert(!found, `unexpected violation ${ruleCode}`);
}

// ═══════════════════════════════════════════════════════════════
// Fixture: minimal valid raw_quote receipt
// ═══════════════════════════════════════════════════════════════

function makeValidReceipt(overrides = {}) {
  const base = {
    receipt_version: '1.2.0',
    receipt_type: 'closed_position',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    token_mint: 'TESTMINT1234567890123456789012345678901234abcd',
    segment_index: 0,
    quote_mint: SOL_MINT,
    quote_symbol: 'SOL',
    valuation_status: 'raw_quote',
    total_bought_qty: 1000,
    total_bought_quote: 10,
    avg_buy_quote_price: 0.01,
    total_sold_qty: 1000,
    total_sold_quote: 15,
    avg_sell_quote_price: 0.015,
    allocated_cost_basis_quote: 10,
    remaining_qty: 0,
    remaining_cost_basis_quote: 0,
    realized_pnl_quote: 5,
    realized_pnl_pct: 50,
    first_event_at: 1700000000,
    last_event_at: 1700100000,
    entry_tx_hashes: ['aaaa1111'],
    exit_tx_hashes: ['bbbb2222'],
    flags: [],
    accounting_method: 'weighted_average_position_accounting_v1',
    verification_status: 'verified',
    limitations: {
      receipt_scope: 'closed_position',
      pnl_type: 'realized_closed',
      price_source: 'on_chain_swaps',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    },
  };

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
// STATUS CLASSIFICATION (8 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Status classification ──');

test('ACTIVE_VALUATION_STATUSES contains raw_quote', () => {
  assert(ACTIVE_VALUATION_STATUSES.has('raw_quote'), 'should contain raw_quote');
});

test('ACTIVE_VALUATION_STATUSES has exactly 1 member', () => {
  assert(ACTIVE_VALUATION_STATUSES.size === 1, `expected 1, got ${ACTIVE_VALUATION_STATUSES.size}`);
});

test('VALUATION_STATUSES is superset of ACTIVE_VALUATION_STATUSES', () => {
  for (const s of ACTIVE_VALUATION_STATUSES) {
    assert(VALUATION_STATUSES.has(s), `VALUATION_STATUSES missing active status "${s}"`);
  }
});

test('VALUATION_STATUSES includes reserved statuses', () => {
  assert(VALUATION_STATUSES.has('usd_normalized'), 'should include usd_normalized');
  assert(VALUATION_STATUSES.has('usd_estimated'), 'should include usd_estimated');
  assert(VALUATION_STATUSES.has('usd_partial'), 'should include usd_partial');
});

test('isActiveValuationStatus: raw_quote → true', () => {
  assert(isActiveValuationStatus('raw_quote') === true);
});

test('isActiveValuationStatus: usd_normalized → false', () => {
  assert(isActiveValuationStatus('usd_normalized') === false);
});

test('isReservedValuationStatus: usd_normalized → true', () => {
  assert(isReservedValuationStatus('usd_normalized') === true);
});

test('isReservedValuationStatus: raw_quote → false', () => {
  assert(isReservedValuationStatus('raw_quote') === false);
});

// ═══════════════════════════════════════════════════════════════
// USD-STABLE MINTS (5 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── USD-stable mints ──');

test('USD_STABLE_MINTS contains USDC', () => {
  assert(USD_STABLE_MINTS.has(USDC_MINT), 'should contain USDC');
});

test('USD_STABLE_MINTS contains USDT', () => {
  assert(USD_STABLE_MINTS.has(USDT_MINT), 'should contain USDT');
});

test('USD_STABLE_MINTS does NOT contain SOL', () => {
  assert(!USD_STABLE_MINTS.has(SOL_MINT), 'SOL should not be USD-stable');
});

test('isUsdStableMint: USDC → true', () => {
  assert(isUsdStableMint(USDC_MINT) === true);
});

test('isUsdStableMint: SOL → false', () => {
  assert(isUsdStableMint(SOL_MINT) === false);
});

// ═══════════════════════════════════════════════════════════════
// buildValuationContext (8 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── buildValuationContext ──');

test('builds context from valid SOL-quoted receipt', () => {
  const receipt = makeValidReceipt();
  const ctx = buildValuationContext(receipt);
  assert(ctx.valuation_status === 'raw_quote', `expected raw_quote, got ${ctx.valuation_status}`);
  assert(ctx.valuation_currency === 'raw_quote', `expected raw_quote, got ${ctx.valuation_currency}`);
  assert(ctx.quote_mint === SOL_MINT, `expected SOL mint, got ${ctx.quote_mint}`);
  assert(ctx.quote_symbol === 'SOL', `expected SOL, got ${ctx.quote_symbol}`);
  assert(ctx.quote_is_usd_stable === false, 'SOL should not be usd_stable');
  assert(ctx.has_no_usd_normalization_disclosure === true, 'should have disclosure');
  assert(ctx.receipt_type === 'closed_position');
  assert(ctx.receipt_version === '1.2.0');
});

test('USDC-quoted receipt: quote_is_usd_stable=true', () => {
  const receipt = makeValidReceipt({ quote_mint: USDC_MINT, quote_symbol: 'USDC' });
  const ctx = buildValuationContext(receipt);
  assert(ctx.quote_is_usd_stable === true, 'USDC should be usd_stable');
  assert(ctx.valuation_status === 'raw_quote', 'valuation_status must still be raw_quote');
});

test('USDT-quoted receipt: quote_is_usd_stable=true', () => {
  const receipt = makeValidReceipt({ quote_mint: USDT_MINT, quote_symbol: 'USDT' });
  const ctx = buildValuationContext(receipt);
  assert(ctx.quote_is_usd_stable === true, 'USDT should be usd_stable');
  assert(ctx.valuation_status === 'raw_quote', 'valuation_status must still be raw_quote');
});

test('quote_is_usd_stable does NOT change valuation_status', () => {
  const receipt = makeValidReceipt({ quote_mint: USDC_MINT, quote_symbol: 'USDC' });
  const ctx = buildValuationContext(receipt);
  assert(ctx.valuation_status === 'raw_quote', 'must remain raw_quote even for USDC');
  assert(ctx.valuation_currency === 'raw_quote', 'valuation_currency must remain raw_quote');
});

test('missing limitations → valuation_currency=null, disclosure=false', () => {
  const receipt = makeValidReceipt();
  receipt.limitations = null;
  const ctx = buildValuationContext(receipt);
  assert(ctx.valuation_currency === null, 'should be null when no limitations');
  assert(ctx.has_no_usd_normalization_disclosure === false, 'should be false');
});

test('missing disclosures array → disclosure=false', () => {
  const receipt = makeValidReceipt();
  receipt.limitations = { valuation_currency: 'raw_quote' };
  const ctx = buildValuationContext(receipt);
  assert(ctx.has_no_usd_normalization_disclosure === false, 'should be false');
});

test('open_snapshot receipt context', () => {
  const receipt = makeValidReceipt({
    receipt_type: 'open_snapshot',
    quote_mint: SOL_MINT,
    quote_symbol: 'SOL',
  });
  const ctx = buildValuationContext(receipt);
  assert(ctx.receipt_type === 'open_snapshot');
  assert(ctx.valuation_status === 'raw_quote');
});

test('null quote_mint → quote_is_usd_stable=false', () => {
  const receipt = makeValidReceipt({ quote_mint: null });
  const ctx = buildValuationContext(receipt);
  assert(ctx.quote_is_usd_stable === false, 'null mint should not be usd_stable');
});

// ═══════════════════════════════════════════════════════════════
// validateReceiptValuation — happy paths (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── validateReceiptValuation: happy paths ──');

test('valid raw_quote receipt passes', () => {
  const receipt = makeValidReceipt();
  const result = validateReceiptValuation(receipt);
  assert(result.valid === true, `expected valid=true, got violations: [${result.violations.map(v => v.rule).join(', ')}]`);
});

test('valid USDC receipt passes (still raw_quote)', () => {
  const receipt = makeValidReceipt({ quote_mint: USDC_MINT, quote_symbol: 'USDC' });
  const result = validateReceiptValuation(receipt);
  assert(result.valid === true, `expected valid=true, got violations: [${result.violations.map(v => v.rule).join(', ')}]`);
});

test('valid USDT receipt passes (still raw_quote)', () => {
  const receipt = makeValidReceipt({ quote_mint: USDT_MINT, quote_symbol: 'USDT' });
  const result = validateReceiptValuation(receipt);
  assert(result.valid === true, `expected valid=true, got violations: [${result.violations.map(v => v.rule).join(', ')}]`);
});

// ═══════════════════════════════════════════════════════════════
// validateReceiptValuation — V-1: status checks (4 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── validateReceiptValuation: V-1 (status) ──');

test('V-1: reserved status usd_normalized fails', () => {
  const receipt = makeValidReceipt({ valuation_status: 'usd_normalized' });
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-1');
  assert(result.violations[0].message.includes('reserved'), 'should say reserved');
});

test('V-1: reserved status usd_estimated fails', () => {
  const receipt = makeValidReceipt({ valuation_status: 'usd_estimated' });
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-1');
});

test('V-1: unknown garbage status fails', () => {
  const receipt = makeValidReceipt({ valuation_status: 'banana' });
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-1');
  assert(result.violations[0].message.includes('not a recognized'), 'should say not recognized');
});

test('V-1: null status fails', () => {
  const receipt = makeValidReceipt({ valuation_status: null });
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-1');
});

// ═══════════════════════════════════════════════════════════════
// validateReceiptValuation — V-2 to V-6: raw_quote rules (7 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── validateReceiptValuation: V-2 to V-6 (raw_quote rules) ──');

test('V-2: valuation_currency mismatch', () => {
  const receipt = makeValidReceipt({ limitations: { valuation_currency: 'usd' } });
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-2');
});

test('V-2: null limitations → V-2 fires', () => {
  const receipt = makeValidReceipt();
  receipt.limitations = null;
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-2');
});

test('V-3: missing no_usd_normalization disclosure', () => {
  const receipt = makeValidReceipt({ limitations: { disclosures: [] } });
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-3');
});

test('V-4: non-null _usd field fails', () => {
  const receipt = makeValidReceipt();
  receipt.realized_pnl_usd = 42.5;
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-4');
});

test('V-4: multiple _usd fields → multiple V-4 violations', () => {
  const receipt = makeValidReceipt();
  receipt.realized_pnl_usd = 42.5;
  receipt.total_pnl_usd = 42.5;
  const result = validateReceiptValuation(receipt);
  const v4s = result.violations.filter(v => v.rule === 'V-4');
  assert(v4s.length === 2, `expected 2 V-4 violations, got ${v4s.length}`);
});

test('V-5: empty quote_mint', () => {
  const receipt = makeValidReceipt({ quote_mint: '' });
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-5');
});

test('V-6: empty quote_symbol', () => {
  const receipt = makeValidReceipt({ quote_symbol: '' });
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-6');
});

// ═══════════════════════════════════════════════════════════════
// validateReceiptValuation — non-raw_quote skips V-2..V-6 (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── validateReceiptValuation: non-raw_quote skips V-2..V-6 ──');

test('reserved status only fires V-1, not V-2..V-6', () => {
  const receipt = makeValidReceipt({ valuation_status: 'usd_normalized' });
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-1');
  assertNoViolation(result, 'V-2');
  assertNoViolation(result, 'V-3');
  assertNoViolation(result, 'V-4');
  assertNoViolation(result, 'V-5');
  assertNoViolation(result, 'V-6');
});

// ═══════════════════════════════════════════════════════════════
// validateValuationContext — happy path (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── validateValuationContext: happy paths ──');

test('valid raw_quote context passes', () => {
  const receipt = makeValidReceipt();
  const ctx = buildValuationContext(receipt);
  const result = validateValuationContext(ctx);
  assert(result.valid === true, `expected valid=true, got violations: [${result.violations.map(v => v.rule).join(', ')}]`);
});

test('valid USDC context passes', () => {
  const receipt = makeValidReceipt({ quote_mint: USDC_MINT, quote_symbol: 'USDC' });
  const ctx = buildValuationContext(receipt);
  const result = validateValuationContext(ctx);
  assert(result.valid === true, `expected valid=true, got violations: [${result.violations.map(v => v.rule).join(', ')}]`);
});

// ═══════════════════════════════════════════════════════════════
// validateValuationContext — VC rules (8 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── validateValuationContext: VC rules ──');

test('VC-1: null context', () => {
  const result = validateValuationContext(null);
  assertViolation(result, 'VC-1');
  assert(result.valid === false);
});

test('VC-1: non-object context', () => {
  const result = validateValuationContext('not an object');
  assertViolation(result, 'VC-1');
});

test('VC-2: unknown status', () => {
  const ctx = buildValuationContext(makeValidReceipt());
  ctx.valuation_status = 'garbage';
  const result = validateValuationContext(ctx);
  assertViolation(result, 'VC-2');
  assert(result.violations[0].message.includes('not a recognized'), 'should say not recognized');
});

test('VC-2: reserved status recognized but fails', () => {
  const ctx = buildValuationContext(makeValidReceipt());
  ctx.valuation_status = 'usd_normalized';
  const result = validateValuationContext(ctx);
  assertViolation(result, 'VC-2');
  assert(result.violations[0].message.includes('reserved'), 'should say reserved');
});

test('VC-3: valuation_currency mismatch for raw_quote', () => {
  const ctx = buildValuationContext(makeValidReceipt());
  ctx.valuation_currency = 'usd';
  const result = validateValuationContext(ctx);
  assertViolation(result, 'VC-3');
});

test('VC-4: missing disclosure for raw_quote', () => {
  const ctx = buildValuationContext(makeValidReceipt());
  ctx.has_no_usd_normalization_disclosure = false;
  const result = validateValuationContext(ctx);
  assertViolation(result, 'VC-4');
});

test('VC-5: empty quote_mint', () => {
  const ctx = buildValuationContext(makeValidReceipt());
  ctx.quote_mint = '';
  const result = validateValuationContext(ctx);
  assertViolation(result, 'VC-5');
});

test('VC-6: empty quote_symbol', () => {
  const ctx = buildValuationContext(makeValidReceipt());
  ctx.quote_symbol = '';
  const result = validateValuationContext(ctx);
  assertViolation(result, 'VC-6');
});

// ═══════════════════════════════════════════════════════════════
// validateValuationContext — VC-7 (1 test)
// ═══════════════════════════════════════════════════════════════

test('VC-7: non-boolean quote_is_usd_stable', () => {
  const ctx = buildValuationContext(makeValidReceipt());
  ctx.quote_is_usd_stable = 'yes';
  const result = validateValuationContext(ctx);
  assertViolation(result, 'VC-7');
});

// ═══════════════════════════════════════════════════════════════
// Edge cases (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Edge cases ──');

test('USDC receipt: quote_is_usd_stable=true does NOT make it usd_normalized', () => {
  const receipt = makeValidReceipt({ quote_mint: USDC_MINT, quote_symbol: 'USDC' });
  const ctx = buildValuationContext(receipt);
  assert(ctx.quote_is_usd_stable === true, 'USDC should be stable');
  assert(ctx.valuation_status === 'raw_quote', 'must remain raw_quote');
  assert(ctx.valuation_currency === 'raw_quote', 'valuation_currency must remain raw_quote');

  // Receipt validation must still pass as raw_quote
  const result = validateReceiptValuation(receipt);
  assert(result.valid === true, 'USDC raw_quote receipt must still be valid');
});

test('undefined _usd fields do not trigger V-4', () => {
  const receipt = makeValidReceipt();
  // Fields simply don't exist — undefined == null → no violation
  const result = validateReceiptValuation(receipt);
  assertNoViolation(result, 'V-4');
});

test('zero _usd field DOES trigger V-4 (0 is not null)', () => {
  const receipt = makeValidReceipt();
  receipt.realized_pnl_usd = 0;
  const result = validateReceiptValuation(receipt);
  assertViolation(result, 'V-4');
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Valuation Schema: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
