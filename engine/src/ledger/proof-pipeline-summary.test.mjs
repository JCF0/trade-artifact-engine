/**
 * Proof Pipeline Summary Tests — B4
 *
 * ~15 tests covering happy path, consistency check failures,
 * missing data, edge cases.
 */

import { computeReceiptHash } from './receipt-promotion.mjs';
import { buildProofPipelineSummary } from './proof-pipeline-summary.mjs';

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

function extractHashFields(r) {
  return {
    receipt_version: r.receipt_version, receipt_type: r.receipt_type,
    wallet: r.wallet, chain: r.chain, token_mint: r.token_mint,
    segment_index: r.segment_index, quote_mint: r.quote_mint,
    quote_symbol: r.quote_symbol, valuation_status: r.valuation_status,
    first_event_at: r.first_event_at, last_event_at: r.last_event_at,
    entry_tx_hashes: r.entry_tx_hashes, exit_tx_hashes: r.exit_tx_hashes,
    total_bought_qty: r.total_bought_qty, total_bought_quote: r.total_bought_quote,
    avg_buy_quote_price: r.avg_buy_quote_price, total_sold_qty: r.total_sold_qty,
    total_sold_quote: r.total_sold_quote, avg_sell_quote_price: r.avg_sell_quote_price,
    allocated_cost_basis_quote: r.allocated_cost_basis_quote,
    remaining_qty: r.remaining_qty, remaining_cost_basis_quote: r.remaining_cost_basis_quote,
    realized_pnl_quote: r.realized_pnl_quote, realized_pnl_pct: r.realized_pnl_pct,
    flags: r.flags, accounting_method: r.accounting_method,
    verification_status: r.verification_status,
  };
}

function makeCandidate(type, mintPrefix = 'TESTMINT') {
  return {
    candidate_id: `lrc_${type}_${mintPrefix}_0`,
    candidate_type: type,
    candidate_version: '1.2.0',
    token_mint: `${mintPrefix}1234567890123456789012345678901234abcd`,
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    segment_index: 0,
    eligible_for_verified_receipt: true,
    eligible_for_closed_position_receipt: type === 'closed_position',
    candidate_hash: 'a'.repeat(64),
    flags: [],
  };
}

function makeReceipt(type, candidateHash = 'a'.repeat(64), mintPrefix = 'TESTMINT') {
  const r = {
    receipt_id: `art_v12_xx_${mintPrefix}_0`,
    receipt_version: '1.2.0',
    receipt_type: type,
    token_mint: `${mintPrefix}1234567890123456789012345678901234abcd`,
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    segment_index: 0,
    receipt_hash: null,
    verification_status: type === 'closed_position' ? 'verified'
                       : type === 'realized_partial' ? 'verified_partial'
                       : 'verified_snapshot',
    display_status: type === 'closed_position' ? 'Verified Closed Position'
                  : type === 'realized_partial' ? 'Verified Partial (Position Open)'
                  : 'Verified Snapshot (No PnL Claim)',
    accounting_method: 'weighted_average_position_accounting_v1',
    quote_mint: 'So11111111111111111111111111111111111111112',
    quote_symbol: 'SOL',
    valuation_status: 'raw_quote',
    total_bought_qty: 1000,
    total_bought_quote: 10,
    avg_buy_quote_price: 0.01,
    total_sold_qty: type === 'closed_position' ? 1000 : type === 'realized_partial' ? 500 : null,
    total_sold_quote: type === 'closed_position' ? 15 : type === 'realized_partial' ? 7.5 : null,
    avg_sell_quote_price: type === 'closed_position' ? 0.015 : type === 'realized_partial' ? 0.015 : null,
    allocated_cost_basis_quote: type === 'open_snapshot' ? null : 10,
    remaining_qty: type === 'closed_position' ? 0 : 500,
    remaining_cost_basis_quote: type === 'closed_position' ? 0 : 5,
    realized_pnl_quote: type === 'open_snapshot' ? null : 5,
    realized_pnl_pct: type === 'open_snapshot' ? null : 50,
    flags: [],
    candidate_hash: candidateHash,
    entry_tx_hashes: ['aaa111'],
    exit_tx_hashes: type === 'open_snapshot' ? [] : ['bbb222'],
  };
  r.receipt_hash = computeReceiptHash(extractHashFields(r));
  return r;
}

function makeVerifyResult(receipt, pass = true) {
  return {
    receipt_id: receipt.receipt_id,
    receipt_hash: receipt.receipt_hash,
    recomputed_hash: receipt.receipt_hash,
    hash_valid: pass,
    rule_violations: pass ? [] : [{ rule: 'HASH', message: 'mismatch', severity: 'error' }],
    schema_valid: pass,
    consistency_valid: pass,
    pass,
  };
}

function makeVerifyReport(receipts, allPass = true) {
  const results = receipts.map((r, i) => makeVerifyResult(r, allPass || i > 0));
  const failures = results.filter(r => !r.pass);
  return {
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    by_type: {},
    by_status: {},
    results,
    failures,
  };
}

function makeLedger(closed = 1, open = 1) {
  return {
    processedCount: 3,
    skippedCount: 0,
    closedSegments: closed,
    openPositions: open,
  };
}

function makeComparison(ledgerClosed = 1, v1Closed = 1, matched = 1, mismatches = []) {
  return {
    ledger_closed: ledgerClosed,
    v1_closed: v1Closed,
    matched,
    mismatches,
  };
}

function makeValuation(overrides = {}) {
  return {
    receipt_count: 2,
    all_valid: true,
    contexts: [],
    summary: {
      by_valuation_status: { raw_quote: 2 },
      usd_stable_count: 0,
      non_usd_stable_count: 2,
      invalid_count: 0,
    },
    ...overrides,
  };
}

/**
 * Build a complete valid inputs object for the summary.
 */
function makeInputs(overrides = {}) {
  const candidates = overrides.candidates ?? [
    makeCandidate('closed_position'),
    makeCandidate('open_snapshot', 'TESTMNT2'),
  ];
  const candidateHashes = candidates.map(c => c.candidate_hash);
  const receipts = overrides.receipts ?? [
    makeReceipt('closed_position', candidateHashes[0]),
    makeReceipt('open_snapshot', candidateHashes[1], 'TESTMNT2'),
  ];
  const verifyReport = overrides.verifyReport ?? makeVerifyReport(receipts, true);

  return {
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    generatedAt: '2026-06-13T08:00:00.000Z',
    ledger: overrides.ledger ?? makeLedger(1, 1),
    comparison: overrides.comparison !== undefined ? overrides.comparison : makeComparison(),
    candidates,
    receipts,
    verifyReport,
  };
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

console.log('\n── Happy path ──');

test('all stages present, all checks pass → PASS', () => {
  const inputs = makeInputs();
  inputs.valuation = makeValuation();
  const summary = buildProofPipelineSummary(inputs);

  assert(summary.schema === 'v12_proof_pipeline_summary', 'schema');
  assert(summary.version === '1.0.0', 'version');
  assert(summary.result === 'PASS', `result should be PASS, got ${summary.result}`);
  assert(summary.consistency.all_pass === true, 'all_pass');
  assert(summary.consistency.warnings.length === 0, `no warnings, got ${summary.consistency.warnings.length}`);
  assert(summary.consistency.checks.length === 9, `9 checks, got ${summary.consistency.checks.length}`);
  assert(summary.consistency.checks.every(c => c.pass), 'all checks pass');
  assert(summary.receipts.length === 2, '2 receipt entries');
  assert(summary.artifacts.length === 7, '7 artifacts');
});

console.log('\n── WARN cases ──');

test('comparison with mismatches → WARN', () => {
  const inputs = makeInputs({
    comparison: makeComparison(1, 1, 0, [{ token_mint: 'x', reason: 'test' }]),
  });
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.result === 'WARN', `result should be WARN, got ${summary.result}`);
  assert(summary.consistency.all_pass === true, 'all_pass still true (warn-only)');
  assert(summary.consistency.warnings.length > 0, 'has warnings');
  const mismatchCheck = summary.consistency.checks.find(c => c.check === 'comparison_no_mismatches');
  assert(mismatchCheck && !mismatchCheck.pass, 'comparison_no_mismatches should fail');
  assert(mismatchCheck.severity === 'warn', 'severity should be warn');
});

console.log('\n── FAIL cases ──');

test('candidate/receipt count mismatch → FAIL', () => {
  const candidates = [makeCandidate('closed_position')];
  const receipts = [
    makeReceipt('closed_position', candidates[0].candidate_hash),
    makeReceipt('open_snapshot', 'b'.repeat(64), 'EXTRA000'),
  ];
  const inputs = makeInputs({ candidates, receipts, verifyReport: makeVerifyReport(receipts) });
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.result === 'FAIL', `result should be FAIL, got ${summary.result}`);
  const check = summary.consistency.checks.find(c => c.check === 'candidate_receipt_count');
  assert(check && !check.pass, 'candidate_receipt_count should fail');
});

test('receipt/verify count mismatch → FAIL', () => {
  const inputs = makeInputs();
  // Tamper: remove one verify result
  inputs.verifyReport.results = [inputs.verifyReport.results[0]];
  inputs.verifyReport.total = 1;
  inputs.verifyReport.passed = 1;
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.result === 'FAIL', `result should be FAIL, got ${summary.result}`);
  const check = summary.consistency.checks.find(c => c.check === 'receipt_verify_count');
  assert(check && !check.pass, 'receipt_verify_count should fail');
});

test('verify failure present → FAIL', () => {
  const inputs = makeInputs();
  inputs.verifyReport = makeVerifyReport(inputs.receipts, false);
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.result === 'FAIL', `result should be FAIL, got ${summary.result}`);
  const check = summary.consistency.checks.find(c => c.check === 'all_verify_passed');
  assert(check && !check.pass, 'all_verify_passed should fail');
});

test('type distribution mismatch → FAIL', () => {
  const candidates = [makeCandidate('closed_position'), makeCandidate('closed_position', 'MINT0002')];
  const receipts = [
    makeReceipt('closed_position', candidates[0].candidate_hash),
    makeReceipt('open_snapshot', candidates[1].candidate_hash, 'MINT0002'),
  ];
  const inputs = makeInputs({ candidates, receipts, verifyReport: makeVerifyReport(receipts) });
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.result === 'FAIL', `result should be FAIL, got ${summary.result}`);
  const check = summary.consistency.checks.find(c => c.check === 'type_distribution_match');
  assert(check && !check.pass, 'type_distribution_match should fail');
});

test('missing candidate_hash trace → FAIL', () => {
  const inputs = makeInputs();
  inputs.receipts[1].candidate_hash = 'f'.repeat(64); // not in any candidate
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.result === 'FAIL', `result should be FAIL, got ${summary.result}`);
  const check = summary.consistency.checks.find(c => c.check === 'candidate_hash_traceability');
  assert(check && !check.pass, 'candidate_hash_traceability should fail');
});

test('missing receipt_id in verify → FAIL', () => {
  const inputs = makeInputs();
  inputs.verifyReport.results[1].receipt_id = 'wrong_id'; // breaks coverage
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.result === 'FAIL', `result should be FAIL, got ${summary.result}`);
  const check = summary.consistency.checks.find(c => c.check === 'receipt_id_coverage');
  assert(check && !check.pass, 'receipt_id_coverage should fail');
});

console.log('\n── Edge cases ──');

test('null comparison → skipped checks + warning', () => {
  const inputs = makeInputs({ comparison: null });
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.stages.comparison === null, 'comparison stage should be null');
  assert(summary.consistency.warnings.length >= 2, 'at least 2 skip warnings');
  // 6 checks (2 comparison skipped + 1 valuation skipped = 3 skipped from 9)
  assert(summary.consistency.checks.length === 6, `6 checks, got ${summary.consistency.checks.length}`);
  // Still WARN because of skip warnings
  assert(summary.result === 'WARN', `result should be WARN, got ${summary.result}`);
});

test('empty inputs (0 candidates, 0 receipts) → PASS', () => {
  const inputs = makeInputs({
    ledger: makeLedger(0, 0),
    comparison: makeComparison(0, 0, 0),
    candidates: [],
    receipts: [],
    verifyReport: makeVerifyReport([], true),
  });
  inputs.valuation = makeValuation({ receipt_count: 0, summary: { by_valuation_status: {}, usd_stable_count: 0, non_usd_stable_count: 0, invalid_count: 0 } });
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.result === 'PASS', `result should be PASS, got ${summary.result}`);
  assert(summary.receipts.length === 0, 'no receipt entries');
  assert(summary.stages.candidates.total === 0, 'candidates total 0');
});

test('receipt entries have correct fields', () => {
  const inputs = makeInputs();
  const summary = buildProofPipelineSummary(inputs);
  const entry = summary.receipts[0];
  assert(entry.receipt_id !== undefined, 'has receipt_id');
  assert(entry.receipt_type !== undefined, 'has receipt_type');
  assert(entry.token_mint !== undefined, 'has token_mint');
  assert(entry.verification_status !== undefined, 'has verification_status');
  assert(entry.receipt_hash !== undefined, 'has receipt_hash');
  assert(entry.candidate_hash !== undefined, 'has candidate_hash');
  assert(entry.hash_valid === true, 'hash_valid');
  assert(entry.violations === 0, 'violations');
});

test('artifacts list has 7 paths', () => {
  const inputs = makeInputs();
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.artifacts.length === 7, `7 artifacts, got ${summary.artifacts.length}`);
  assert(summary.artifacts[5] === 'data/debug/ledger-valuations-v12.json', 'valuations artifact');
  assert(summary.artifacts[6] === 'data/debug/v12-proof-pipeline-summary.json', 'last artifact is summary itself');
});

test('stage counts match inputs', () => {
  const inputs = makeInputs({ ledger: makeLedger(3, 5) });
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.stages.ledger.closed_segments === 3, 'closed_segments');
  assert(summary.stages.ledger.open_positions === 5, 'open_positions');
  assert(summary.stages.verification.total === 2, 'verify total');
  assert(summary.stages.verification.passed === 2, 'verify passed');
});

// ═══════════════════════════════════════════════════════════════
// VALUATION STAGE (C3)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Valuation stage (C3) ──');

test('valuation stage present → stage populated', () => {
  const inputs = makeInputs();
  inputs.valuation = makeValuation();
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.stages.valuation !== null, 'valuation stage should exist');
  assert(summary.stages.valuation.total === 2, `total should be 2, got ${summary.stages.valuation.total}`);
  assert(summary.stages.valuation.all_valid === true, 'all_valid should be true');
  assert(summary.stages.valuation.usd_stable_count === 0, 'usd_stable_count should be 0');
  assert(summary.stages.valuation.invalid_count === 0, 'invalid_count should be 0');
  assert(summary.stages.valuation.artifact === 'data/debug/ledger-valuations-v12.json', 'artifact path');
});

test('valuation stage null → stage absent + warning', () => {
  const inputs = makeInputs();
  // no inputs.valuation set
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.stages.valuation === null, 'valuation stage should be null');
  const hasWarning = summary.consistency.warnings.some(w => w.includes('valuation'));
  assert(hasWarning, 'should have valuation skip warning');
});

test('valuation_all_valid check passes when invalid_count=0', () => {
  const inputs = makeInputs();
  inputs.valuation = makeValuation();
  const summary = buildProofPipelineSummary(inputs);
  const check = summary.consistency.checks.find(c => c.check === 'valuation_all_valid');
  assert(check, 'valuation_all_valid check should exist');
  assert(check.pass === true, 'should pass');
  assert(check.expected === 0, 'expected should be 0');
  assert(check.actual === 0, 'actual should be 0');
});

test('valuation_all_valid check fails when invalid_count>0 → FAIL', () => {
  const inputs = makeInputs();
  inputs.valuation = makeValuation({
    all_valid: false,
    summary: { by_valuation_status: { raw_quote: 2 }, usd_stable_count: 0, non_usd_stable_count: 2, invalid_count: 1 },
  });
  const summary = buildProofPipelineSummary(inputs);
  const check = summary.consistency.checks.find(c => c.check === 'valuation_all_valid');
  assert(check, 'valuation_all_valid check should exist');
  assert(check.pass === false, 'should fail');
  assert(check.actual === 1, `actual should be 1, got ${check.actual}`);
  assert(summary.result === 'FAIL', `result should be FAIL, got ${summary.result}`);
});

test('valuation present → artifact list includes valuation path', () => {
  const inputs = makeInputs();
  inputs.valuation = makeValuation();
  const summary = buildProofPipelineSummary(inputs);
  assert(summary.artifacts.includes('data/debug/ledger-valuations-v12.json'), 'should include valuation artifact');
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Proof Pipeline Summary: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
