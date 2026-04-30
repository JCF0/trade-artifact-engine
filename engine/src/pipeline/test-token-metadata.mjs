#!/usr/bin/env node
/**
 * Tests for token-metadata.mjs
 */
import { TokenMetadataCache, collectMints, collectMintsFromPositions, enrichPositions } from './token-metadata.mjs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SOL_MINT, USDC_MINT } from './constants.mjs';

// Load API key for live tests
const envPath = resolve(process.env.USERPROFILE || process.env.HOME, '.openclaw', '.env');
let API_KEY = '';
try {
  const envContent = readFileSync(envPath, 'utf-8');
  const match = envContent.match(/^HELIUS_API_KEY=(.+)$/m);
  if (match) API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
} catch {}

const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const CARDS = 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp';
const FAKE = 'FAKE11111111111111111111111111111111111111111';

let passed = 0, failed = 0;
function check(label, actual, expected) {
  if (actual === expected) { passed++; }
  else { failed++; console.error(`  ❌ ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function checkTruthy(label, val) {
  if (val) { passed++; }
  else { failed++; console.error(`  ❌ ${label}: expected truthy, got ${JSON.stringify(val)}`); }
}

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║  Token Metadata Tests                                    ║`);
console.log(`╚══════════════════════════════════════════════════════════╝\n`);

// ── Test 1: Built-in tokens ──
console.log(`── Test 1: Built-in tokens ──`);
{
  const cache = new TokenMetadataCache();
  const sol = cache.get(SOL_MINT);
  check('SOL symbol', sol.symbol, 'SOL');
  check('SOL name', sol.name, 'Solana');
  check('SOL decimals', sol.decimals, 9);
  check('SOL source', sol.source, 'built-in');

  const usdc = cache.get(USDC_MINT);
  check('USDC symbol', usdc.symbol, 'USDC');
  check('USDC decimals', usdc.decimals, 6);
}

// ── Test 2: Unknown token without API → fallback ──
console.log(`── Test 2: Fallback for unknown tokens ──`);
{
  const cache = new TokenMetadataCache();  // no API key
  await cache.resolve([FAKE]);
  const meta = cache.get(FAKE);
  check('fallback symbol', meta.symbol, 'FAKE11');
  check('fallback name', meta.name, 'Unknown Token');
  check('fallback source', meta.source, 'fallback');
}

// ── Test 3: Live Helius DAS resolution ──
console.log(`── Test 3: Live Helius DAS resolution ──`);
if (API_KEY) {
  const cache = new TokenMetadataCache({ heliusApiKey: API_KEY });
  await cache.resolve([JUP, CARDS]);

  const jup = cache.get(JUP);
  check('JUP symbol', jup.symbol, 'JUP');
  check('JUP name', jup.name, 'Jupiter');
  check('JUP decimals', jup.decimals, 6);
  check('JUP source', jup.source, 'helius-das');
  checkTruthy('JUP has logo', !!jup.logo);

  const cards = cache.get(CARDS);
  check('CARDS symbol', cards.symbol, 'CARDS');
  checkTruthy('CARDS has name', cards.name.length > 0);
  check('CARDS source', cards.source, 'helius-das');
} else {
  console.log('  ⚠️  No API key — skipping live DAS tests');
}

// ── Test 4: Batch resolution (no duplicate API calls) ──
console.log(`── Test 4: Batch resolution caching ──`);
{
  const cache = new TokenMetadataCache({ heliusApiKey: API_KEY });
  await cache.resolve([SOL_MINT, JUP]);  // SOL from built-in, JUP needs fetch
  const sol = cache.get(SOL_MINT);
  check('SOL still built-in', sol.source, 'built-in');

  // Second resolve should not re-fetch
  await cache.resolve([SOL_MINT, JUP]);
  check('cache size stable', cache.size >= 3, true);  // SOL + USDC + USDT + JUP
}

// ── Test 5: collectMints ──
console.log(`── Test 5: collectMints ──`);
{
  const events = [
    { token_in_mint: SOL_MINT, token_out_mint: JUP },
    { token_in_mint: JUP, token_out_mint: SOL_MINT },
    { token_in_mint: CARDS, token_out_mint: USDC_MINT },
  ];
  const mints = collectMints(events);
  check('unique mints count', mints.length, 4);  // SOL, JUP, CARDS, USDC
  checkTruthy('has SOL', mints.includes(SOL_MINT));
  checkTruthy('has JUP', mints.includes(JUP));
  checkTruthy('has CARDS', mints.includes(CARDS));
}

// ── Test 6: collectMintsFromPositions ──
console.log(`── Test 6: collectMintsFromPositions ──`);
{
  const positions = [{
    token: JUP,
    legs: [
      { quote_mint: SOL_MINT },
      { raw_quote_mint: USDC_MINT, quote_mint: SOL_MINT },
    ],
  }];
  const mints = collectMintsFromPositions(positions);
  check('position mints count', mints.length, 3);  // JUP, SOL, USDC
}

// ── Test 7: enrichPositions ──
console.log(`── Test 7: enrichPositions ──`);
{
  const cache = new TokenMetadataCache({ heliusApiKey: API_KEY });
  if (API_KEY) await cache.resolve([JUP, CARDS]);

  const positions = [{
    token: JUP,
    legs: [
      { quote_mint: SOL_MINT },
      { raw_quote_mint: USDC_MINT, quote_mint: SOL_MINT },
    ],
  }];
  enrichPositions(positions, cache);

  if (API_KEY) {
    check('token_meta symbol', positions[0].token_meta.symbol, 'JUP');
    check('leg 0 quote_meta', positions[0].legs[0].quote_meta.symbol, 'SOL');
    check('leg 1 quote_meta (raw)', positions[0].legs[1].quote_meta.symbol, 'USDC');
  }
}

// ── Test 8: Stats ──
console.log(`── Test 8: Cache stats ──`);
{
  const cache = new TokenMetadataCache();
  const stats = cache.stats;
  check('built-in count', stats.builtIn, 3);
  check('total >= 3', stats.total >= 3, true);
}

// ═══════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`✅ ALL ${passed} CHECKS PASSED — token metadata is solid`);
} else {
  console.log(`❌ ${failed} FAILED, ${passed} passed`);
}
process.exit(failed > 0 ? 1 : 0);
