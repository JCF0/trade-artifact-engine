#!/usr/bin/env node
/**
 * Tests for classifier.mjs
 *
 * Verifies every transaction type gets classified, no silent drops.
 */
import { classifyTransaction, classifyAll, formatCoverageReport, CLASSIFICATION } from './classifier.mjs';
import { DEX_PROGRAMS, SOL_MINT, USDC_MINT } from './constants.mjs';

const TOKEN_A = 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const WALLET = 'TestWallet11111111111111111111111111111111111';

let passed = 0, failed = 0;
function check(label, actual, expected) {
  if (actual === expected) { passed++; }
  else { failed++; console.error(`  ❌ ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function checkTruthy(label, val) {
  if (val) { passed++; }
  else { failed++; console.error(`  ❌ ${label}: expected truthy, got ${JSON.stringify(val)}`); }
}

// ── Fixture helpers ──

function makeTx(overrides = {}) {
  return {
    signature: 'tx_' + Math.random().toString(36).slice(2, 14),
    timestamp: 1700000000,
    type: 'SWAP',
    transactionError: null,
    events: {},
    instructions: [],
    tokenTransfers: [],
    nativeTransfers: [],
    ...overrides,
  };
}

function makeSwapEvent(inMint, inAmt, outMint, outAmt) {
  const ev = { tokenInputs: [], tokenOutputs: [] };
  if (inMint === SOL_MINT) {
    ev.nativeInput = { amount: Math.round(inAmt * 1e9) };
  } else {
    ev.tokenInputs = [{ mint: inMint, rawTokenAmount: { tokenAmount: String(Math.round(inAmt * 1e6)), decimals: 6 } }];
  }
  if (outMint === SOL_MINT) {
    ev.nativeOutput = { amount: Math.round(outAmt * 1e9) };
  } else {
    ev.tokenOutputs = [{ mint: outMint, rawTokenAmount: { tokenAmount: String(Math.round(outAmt * 1e6)), decimals: 6 } }];
  }
  return ev;
}

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║  Classifier Tests                                       ║`);
console.log(`╚══════════════════════════════════════════════════════════╝\n`);

// ── Test 1: Classified (SOL → Token) ──
console.log(`── Test 1: Classified swap (quote→token) ──`);
{
  const tx = makeTx({ events: { swap: makeSwapEvent(SOL_MINT, 0.01, TOKEN_A, 100) } });
  const r = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);
  check('classification', r.classification, CLASSIFICATION.CLASSIFIED);
  checkTruthy('has reason', r.reason.includes('BUY'));
  checkTruthy('has swap_detail', !!r.swap_detail);
}

// ── Test 2: Classified (Token → SOL) ──
console.log(`── Test 2: Classified swap (token→quote) ──`);
{
  const tx = makeTx({ events: { swap: makeSwapEvent(TOKEN_A, 100, SOL_MINT, 0.01) } });
  const r = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);
  check('classification', r.classification, CLASSIFICATION.CLASSIFIED);
  checkTruthy('has reason', r.reason.includes('SELL'));
}

// ── Test 3: Token-to-token ──
console.log(`── Test 3: Token-to-token ──`);
{
  const tx = makeTx({ events: { swap: makeSwapEvent(TOKEN_A, 100, TOKEN_B, 200) } });
  const r = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);
  check('classification', r.classification, CLASSIFICATION.TOKEN_TO_TOKEN);
  checkTruthy('has reason', r.reason.includes('no quote mint'));
}

// ── Test 4: Quote-to-quote ──
console.log(`── Test 4: Quote-to-quote (SOL→USDC) ──`);
{
  const tx = makeTx({ events: { swap: makeSwapEvent(SOL_MINT, 1, USDC_MINT, 150) } });
  const r = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);
  check('classification', r.classification, CLASSIFICATION.QUOTE_TO_QUOTE);
  checkTruthy('has reason', r.reason.includes('SOL') && r.reason.includes('USDC'));
}

// ── Test 5: Multi-leg ──
console.log(`── Test 5: Multi-leg swap ──`);
{
  const tx = makeTx({
    events: {
      swap: {
        tokenInputs: [
          { mint: TOKEN_A, rawTokenAmount: { tokenAmount: '100', decimals: 6 } },
          { mint: TOKEN_B, rawTokenAmount: { tokenAmount: '200', decimals: 6 } },
        ],
        tokenOutputs: [{ mint: SOL_MINT, rawTokenAmount: { tokenAmount: '1000000000', decimals: 9 } }],
        nativeOutput: { amount: 1000000000 },
      },
    },
  });
  const r = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);
  check('classification', r.classification, CLASSIFICATION.MULTI_LEG);
  checkTruthy('has inputs count', r.inputs === 2);
}

// ── Test 6: Errored ──
console.log(`── Test 6: Errored transaction ──`);
{
  const tx = makeTx({ transactionError: { code: 1 } });
  const r = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);
  check('classification', r.classification, CLASSIFICATION.ERRORED);
}

// ── Test 7: Non-swap ──
console.log(`── Test 7: Non-swap (TRANSFER) ──`);
{
  const tx = makeTx({ type: 'TRANSFER' });
  const r = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);
  check('classification', r.classification, CLASSIFICATION.NON_SWAP);
}

// ── Test 8: Unsupported swap (SWAP type but no events and no DEX touch) ──
console.log(`── Test 8: Unsupported swap ──`);
{
  // SWAP type, has swap event but extraction returns null (no inputs at all)
  const tx = makeTx({
    type: 'SWAP',
    events: { swap: { tokenInputs: [], tokenOutputs: [] } },
  });
  const r = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);
  check('classification', r.classification, CLASSIFICATION.UNSUPPORTED_SWAP);
}

// ── Test 9: classifyAll — coverage stats ──
console.log(`── Test 9: Batch classification + coverage ──`);
{
  const txns = [
    makeTx({ events: { swap: makeSwapEvent(SOL_MINT, 0.01, TOKEN_A, 100) } }),  // classified
    makeTx({ events: { swap: makeSwapEvent(TOKEN_A, 100, TOKEN_B, 200) } }),     // token_to_token
    makeTx({ events: { swap: makeSwapEvent(SOL_MINT, 1, USDC_MINT, 150) } }),    // quote_to_quote
    makeTx({ transactionError: { code: 1 } }),                                    // errored
    makeTx({ type: 'TRANSFER' }),                                                  // non_swap
    makeTx({ events: { swap: makeSwapEvent(TOKEN_A, 50, SOL_MINT, 0.005) } }),   // classified
  ];
  const { classifications, coverage } = classifyAll(txns, WALLET, DEX_PROGRAMS);

  check('total classifications', classifications.length, 6);
  check('total_transactions', coverage.total_transactions, 6);
  check('swap_related', coverage.swap_related, 4);  // 6 - 1 non_swap - 1 errored
  check('fully_classified', coverage.fully_classified, 2);
  check('coverage_pct', coverage.coverage_pct, 33.3);
  check('swap_coverage_pct', coverage.swap_coverage_pct, 50);
  check('token_to_token count', coverage.breakdown.token_to_token, 1);
  check('quote_to_quote count', coverage.breakdown.quote_to_quote, 1);
  check('errored count', coverage.breakdown.errored, 1);
  check('non_swap count', coverage.breakdown.non_swap, 1);
}

// ── Test 10: No silent drops — every tx accounted for ──
console.log(`── Test 10: Zero silent drops ──`);
{
  const txns = [
    makeTx({ events: { swap: makeSwapEvent(SOL_MINT, 0.01, TOKEN_A, 100) } }),
    makeTx({ events: { swap: makeSwapEvent(TOKEN_A, 100, TOKEN_B, 200) } }),
    makeTx({ events: { swap: makeSwapEvent(SOL_MINT, 1, USDC_MINT, 150) } }),
    makeTx({ transactionError: { code: 1 } }),
    makeTx({ type: 'TRANSFER' }),
    makeTx({ type: 'COMPRESSED_NFT_MINT' }),
    makeTx({ type: 'SWAP', events: { swap: { tokenInputs: [], tokenOutputs: [] } } }),
  ];

  const { classifications, coverage } = classifyAll(txns, WALLET, DEX_PROGRAMS);

  // Every single tx must have a classification
  check('all txns classified', classifications.length, txns.length);
  const total = Object.values(coverage.breakdown).reduce((s, v) => s + v, 0);
  check('breakdown sums to total', total, txns.length);

  // No classification should be undefined or null
  const badOnes = classifications.filter(c => !c.classification);
  check('no undefined classifications', badOnes.length, 0);
}

// ── Test 11: formatCoverageReport ──
console.log(`── Test 11: Coverage report formatting ──`);
{
  const { coverage } = classifyAll([
    makeTx({ events: { swap: makeSwapEvent(SOL_MINT, 0.01, TOKEN_A, 100) } }),
    makeTx({ events: { swap: makeSwapEvent(TOKEN_A, 100, TOKEN_B, 200) } }),
    makeTx({ type: 'TRANSFER' }),
  ], WALLET, DEX_PROGRAMS);

  const report = formatCoverageReport(coverage);
  checkTruthy('report is a string', typeof report === 'string');
  checkTruthy('report contains coverage', report.includes('Coverage Report'));
  checkTruthy('report contains token_to_token', report.includes('token-to-token'));
}

// ═══════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`✅ ALL ${passed} CHECKS PASSED — classifier is solid`);
} else {
  console.log(`❌ ${failed} FAILED, ${passed} passed`);
}
process.exit(failed > 0 ? 1 : 0);
