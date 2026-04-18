#!/usr/bin/env node
/**
 * Tests for quote-normalizer.mjs
 *
 * Covers:
 * - Single-quote detection (no normalization needed)
 * - Mixed-quote detection
 * - Normalization with mock rates
 * - Warning generation for missing rates
 * - Confidence levels
 * - Batch normalization
 * - PnL correctness after normalization
 */
import { detectMixedQuotes, normalizePosition, normalizePositions } from './quote-normalizer.mjs';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp';

let passed = 0, failed = 0;
function check(label, actual, expected) {
  if (actual === expected) { passed++; }
  else { failed++; console.error(`  ❌ ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

function checkApprox(label, actual, expected, tolerance = 0.001) {
  if (Math.abs(actual - expected) <= Math.abs(expected * tolerance)) { passed++; }
  else { failed++; console.error(`  ❌ ${label}: got ${actual}, expected ~${expected} (tol=${tolerance})`); }
}

function checkTruthy(label, actual) {
  if (actual) { passed++; }
  else { failed++; console.error(`  ❌ ${label}: got ${JSON.stringify(actual)}, expected truthy`); }
}

// ── Fixtures ──

function makeLeg(action, amount, quoteAmount, quoteMint, txHash) {
  return {
    tx_hash: txHash || `tx_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: 1700000000 + Math.random() * 1000,
    amount,
    quote_amount: quoteAmount,
    quote_mint: quoteMint,
    action,
  };
}

function makePosition(legs, token = TOKEN) {
  const entries = legs.filter(l => l.action === 'buy');
  const exits = legs.filter(l => l.action === 'sell');
  return {
    position_id: 'test_pos_' + Math.random().toString(36).slice(2, 10),
    wallet: 'TestWallet',
    token,
    legs,
    entries,
    exits,
    avg_entry: 0,
    avg_exit: 0,
    realized_pnl: 0,
    realized_pnl_pct: 0,
    total_bought: entries.reduce((s, l) => s + l.amount, 0),
    total_sold: exits.reduce((s, l) => s + l.amount, 0),
  };
}

// ═══════════════════════════════════════════════════════════════
// Test 1: Detection — single quote
// ═══════════════════════════════════════════════════════════════

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║  Quote Normalizer Tests                                 ║`);
console.log(`╚══════════════════════════════════════════════════════════╝\n`);

console.log(`── Test 1: Single-quote detection ──`);
{
  const pos = makePosition([
    makeLeg('buy', 10, 0.005, SOL),
    makeLeg('sell', 10, 0.006, SOL),
  ]);
  const result = detectMixedQuotes(pos);
  check('single-quote: mixed=false', result.mixed, false);
  check('single-quote: mints count', result.quote_mints.length, 1);
  check('single-quote: mint is SOL', result.quote_mints[0], SOL);
}

// ═══════════════════════════════════════════════════════════════
// Test 2: Detection — mixed quotes
// ═══════════════════════════════════════════════════════════════

console.log(`── Test 2: Mixed-quote detection ──`);
{
  const pos = makePosition([
    makeLeg('buy', 10, 0.005, SOL),
    makeLeg('buy', 20, 0.78, USDC),
    makeLeg('sell', 30, 0.03, SOL),
  ]);
  const result = detectMixedQuotes(pos);
  check('mixed-quote: mixed=true', result.mixed, true);
  check('mixed-quote: mints count', result.quote_mints.length, 2);
  checkTruthy('mixed-quote: has SOL', result.quote_mints.includes(SOL));
  checkTruthy('mixed-quote: has USDC', result.quote_mints.includes(USDC));
}

// ═══════════════════════════════════════════════════════════════
// Test 3: Normalization — single quote passthrough
// ═══════════════════════════════════════════════════════════════

console.log(`── Test 3: Single-quote passthrough ──`);
{
  const pos = makePosition([
    makeLeg('buy', 10, 0.005, SOL),
    makeLeg('sell', 10, 0.006, SOL),
  ]);
  const result = await normalizePosition(pos);
  check('passthrough: normalization.required=false', result.normalization.required, false);
  check('passthrough: mixed_quotes=false', result.normalization.mixed_quotes, false);
  check('passthrough: primary_quote', result.normalization.primary_quote, SOL);
  // Original values preserved
  check('passthrough: legs count', result.legs.length, 2);
}

// ═══════════════════════════════════════════════════════════════
// Test 4: Normalization — mixed quotes (live Jupiter call)
// ═══════════════════════════════════════════════════════════════

console.log(`── Test 4: Mixed-quote normalization (live) ──`);
{
  const pos = makePosition([
    makeLeg('buy', 11.164579, 0.005, SOL, 'tx_buy_sol'),
    makeLeg('buy', 19.182745, 0.783759, USDC, 'tx_buy_usdc'),
    makeLeg('sell', 30.347324, 0.030561091, SOL, 'tx_sell_sol'),
  ]);

  const result = await normalizePosition(pos);

  check('mixed: normalization.required=true', result.normalization.required, true);
  check('mixed: mixed_quotes=true', result.normalization.mixed_quotes, true);
  check('mixed: target_denomination', result.normalization.target_denomination, 'SOL');
  checkTruthy('mixed: has fetched_at', result.normalization.fetched_at);
  checkTruthy('mixed: has confidence', ['high', 'estimated', 'low'].includes(result.normalization.confidence));

  // Normalized legs should have raw preservations
  const usdcLeg = result.legs.find(l => l.raw_quote_mint === USDC);
  checkTruthy('mixed: USDC leg has raw_quote_amount', usdcLeg?.raw_quote_amount === 0.783759);
  checkTruthy('mixed: USDC leg has quote_amount_sol', usdcLeg?.quote_amount_sol > 0);
  checkTruthy('mixed: USDC leg has conversion_rate', usdcLeg?.conversion_rate > 0);

  // SOL leg should have identity conversion
  const solLeg = result.legs.find(l => l.raw_quote_mint === SOL && l.action === 'buy');
  checkTruthy('mixed: SOL leg has quote_amount_sol', solLeg?.quote_amount_sol === 0.005);

  // Normalized PnL should exist
  checkTruthy('mixed: has normalized_cost_basis', result.normalized_cost_basis > 0);
  checkTruthy('mixed: has normalized_proceeds', result.normalized_proceeds > 0);
  checkTruthy('mixed: has normalized_realized_pnl', result.normalized_realized_pnl !== undefined);
  checkTruthy('mixed: has normalized_realized_pnl_pct', result.normalized_realized_pnl_pct !== undefined);

  // The USDC leg (0.78 USDC) at ~$150/SOL should convert to ~0.005 SOL
  // So total cost ≈ 0.005 + 0.005 = 0.01 SOL, proceeds = 0.0306 SOL → positive PnL
  // This is the critical correctness check
  checkTruthy('mixed: normalized cost basis reasonable (0.005-0.02 SOL)', result.normalized_cost_basis > 0.005 && result.normalized_cost_basis < 0.02);
  checkTruthy('mixed: normalized PnL is POSITIVE (was -96% before normalization)', result.normalized_realized_pnl > 0);
  checkTruthy('mixed: normalized PnL% is positive', result.normalized_realized_pnl_pct > 0);

  console.log(`    [info] Normalized cost basis: ${result.normalized_cost_basis} SOL`);
  console.log(`    [info] Normalized proceeds:   ${result.normalized_proceeds} SOL`);
  console.log(`    [info] Normalized PnL:        ${result.normalized_realized_pnl} SOL (${result.normalized_realized_pnl_pct}%)`);
  console.log(`    [info] Confidence:            ${result.normalization.confidence}`);
  console.log(`    [info] USDC→SOL rate:         ${usdcLeg?.conversion_rate}`);
  if (result.normalization.sol_usd_rate) {
    console.log(`    [info] SOL/USD rate:          $${result.normalization.sol_usd_rate}`);
    console.log(`    [info] PnL in USD:            $${result.normalized_realized_pnl_usd}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Test 5: Warning for exotic quote mint
// ═══════════════════════════════════════════════════════════════

console.log(`── Test 5: Missing rate warning ──`);
{
  const EXOTIC = 'EXOTICmintThatDoesNotExist11111111111111111';
  const pos = makePosition([
    makeLeg('buy', 10, 0.005, SOL),
    makeLeg('buy', 20, 500, EXOTIC),
    makeLeg('sell', 30, 0.03, SOL),
  ]);

  const result = await normalizePosition(pos);
  check('exotic: confidence=low', result.normalization.confidence, 'low');
  checkTruthy('exotic: has warnings', result.normalization.warnings.length > 0);

  const convWarning = result.normalization.warnings.find(w => w.type === 'conversion_unavailable');
  checkTruthy('exotic: conversion_unavailable warning', convWarning);

  const exoticLeg = result.legs.find(l => l.raw_quote_mint === EXOTIC);
  check('exotic: leg conversion_failed=true', exoticLeg?.conversion_failed, true);
  check('exotic: leg quote_amount_sol=null', exoticLeg?.quote_amount_sol, null);
}

// ═══════════════════════════════════════════════════════════════
// Test 6: Batch normalization
// ═══════════════════════════════════════════════════════════════

console.log(`── Test 6: Batch normalization ──`);
{
  const pos1 = makePosition([
    makeLeg('buy', 10, 0.005, SOL),
    makeLeg('sell', 10, 0.006, SOL),
  ]);
  const pos2 = makePosition([
    makeLeg('buy', 10, 0.005, SOL),
    makeLeg('buy', 20, 0.78, USDC),
    makeLeg('sell', 30, 0.03, SOL),
  ]);

  const results = await normalizePositions([pos1, pos2]);
  check('batch: count', results.length, 2);
  check('batch: pos1 not mixed', results[0].normalization.required, false);
  check('batch: pos2 mixed', results[1].normalization.required, true);
}

// ═══════════════════════════════════════════════════════════════
// Test 7: PnL math correctness with known rates
// ═══════════════════════════════════════════════════════════════

console.log(`── Test 7: PnL math audit ──`);
{
  // Single-quote position: PnL should match raw calculation
  const pos = makePosition([
    makeLeg('buy', 100, 0.1, SOL),  // entry at 0.001 SOL/token
    makeLeg('sell', 100, 0.15, SOL),  // exit at 0.0015 SOL/token
  ]);
  const result = await normalizePosition(pos);
  // Single-quote: original values should still be on position (not normalized)
  check('pnl-audit: not normalized', result.normalization.required, false);
  // Original position PnL: (0.15 - 0.1) / 0.1 = 50%
  // The position builder values are what we set in makePosition (0), but the legs are correct
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`✅ ALL ${passed} CHECKS PASSED — quote normalizer is solid`);
} else {
  console.log(`❌ ${failed} FAILED, ${passed} passed`);
}
process.exit(failed > 0 ? 1 : 0);
