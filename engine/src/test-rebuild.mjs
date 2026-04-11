#!/usr/bin/env node
/**
 * Phase 4 — Deterministic Rebuild Tests
 *
 * Verifies rebuild determinism by running the pipeline multiple times
 * and confirming identical outputs. Uses cached data — zero live API calls.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { normalizeTransactions } from './pipeline/ingest.mjs';
import { reconstructCycles } from './pipeline/reconstruct.mjs';
import { buildPositionReceipt } from './pipeline/receipt.mjs';
import { buildPositions, computePositionId } from './position/position-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let pass = 0, fail = 0;

function check(label, actual, expected) {
  const eq = typeof expected === 'number'
    ? Math.abs(actual - expected) < 1e-10
    : actual === expected;
  if (eq) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}

function section(title) { console.log(`\n── ${title} ──`); }

// ── Rebuild helper (simulates the rebuild-position.mjs pipeline) ──
function rebuild(txns, { wallet, token, from_ts, to_ts, position_id }) {
  const { events } = normalizeTransactions(txns, wallet, { silent: true });
  const { cycles } = reconstructCycles(events);
  const positions = buildPositions(cycles, { wallet, token, from_ts, to_ts });

  if (positions.length === 0) return { error: 'not_found', positions };

  let selected;
  if (position_id) {
    selected = positions.find(p => p.position_id === position_id || p.position_id.startsWith(position_id));
    if (!selected) return { error: 'not_found', positions };
  } else if (positions.length === 1) {
    selected = positions[0];
  } else {
    return { error: 'ambiguous', positions };
  }

  const receipt = buildPositionReceipt(selected);
  return { position: selected, receipt };
}

// ── Load test data ──
const txns = readFileSync(resolve(ROOT, 'data/raw/helius_transactions.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const WALLET = 'FDh2oFVBYzmVrqVrNQNR8vRwVZhfRhW5w964HG8eypxP';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Phase 4 — Deterministic Rebuild Tests                  ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ═══════════════════════════════════════════════════════════════
// Test 1: Repeated rebuilds produce identical results
// ═══════════════════════════════════════════════════════════════
section('Test 1: Determinism — 3 identical rebuilds');

const r1 = rebuild(txns, { wallet: WALLET });
const r2 = rebuild(txns, { wallet: WALLET });
const r3 = rebuild(txns, { wallet: WALLET });

check('Run 1 succeeded', !!r1.receipt, true);
check('Run 2 succeeded', !!r2.receipt, true);
check('Run 3 succeeded', !!r3.receipt, true);

check('Position ID: run1 == run2', r1.position.position_id, r2.position.position_id);
check('Position ID: run2 == run3', r2.position.position_id, r3.position.position_id);

check('Hash: run1 == run2', r1.receipt.verification_hash, r2.receipt.verification_hash);
check('Hash: run2 == run3', r2.receipt.verification_hash, r3.receipt.verification_hash);

check('avg_entry: run1 == run2', r1.receipt.avg_entry_price, r2.receipt.avg_entry_price);
check('avg_exit: run1 == run2', r1.receipt.avg_exit_price, r2.receipt.avg_exit_price);
check('pnl_pct: run1 == run2', r1.receipt.realized_pnl_pct, r2.receipt.realized_pnl_pct);

// ═══════════════════════════════════════════════════════════════
// Test 2: Position ID selection works
// ═══════════════════════════════════════════════════════════════
section('Test 2: Position ID selection');

const knownId = r1.position.position_id;
const byId = rebuild(txns, { wallet: WALLET, position_id: knownId });
check('Select by full ID', byId.receipt.verification_hash, r1.receipt.verification_hash);

// Prefix match
const prefix = knownId.slice(0, 12);
const byPrefix = rebuild(txns, { wallet: WALLET, position_id: prefix });
check('Select by prefix', byPrefix.receipt.verification_hash, r1.receipt.verification_hash);

// Non-existent ID
const badId = rebuild(txns, { wallet: WALLET, position_id: 'deadbeef00000000' });
check('Non-existent ID returns error', badId.error, 'not_found');

// ═══════════════════════════════════════════════════════════════
// Test 3: Token filter
// ═══════════════════════════════════════════════════════════════
section('Test 3: Token filter');

const withToken = rebuild(txns, { wallet: WALLET, token: JUP_MINT });
check('Token filter produces same hash', withToken.receipt.verification_hash, r1.receipt.verification_hash);

const badToken = rebuild(txns, { wallet: WALLET, token: 'FakeToken111111' });
check('Bad token returns not_found', badToken.error, 'not_found');

// ═══════════════════════════════════════════════════════════════
// Test 4: Timeframe filter determinism
// ═══════════════════════════════════════════════════════════════
section('Test 4: Timeframe filter determinism');

// Narrow to first cycle only
const narrow1a = rebuild(txns, { wallet: WALLET, from_ts: 1774400000, to_ts: 1774400500 });
const narrow1b = rebuild(txns, { wallet: WALLET, from_ts: 1774400000, to_ts: 1774400500 });
check('Narrow rebuild succeeded', !!narrow1a.receipt, true);
check('Narrow hash: run1 == run2', narrow1a.receipt.verification_hash, narrow1b.receipt.verification_hash);
check('Narrow position_id: run1 == run2', narrow1a.position.position_id, narrow1b.position.position_id);
check('Narrow has 1 cycle', narrow1a.position.num_cycles, 1);

// Different timeframe = different position ID and hash
check('Different timeframe = different hash', narrow1a.receipt.verification_hash !== r1.receipt.verification_hash, true);
check('Different timeframe = different position_id', narrow1a.position.position_id !== r1.position.position_id, true);

// ═══════════════════════════════════════════════════════════════
// Test 5: Position ID is correctly derived
// ═══════════════════════════════════════════════════════════════
section('Test 5: Position ID derivation');

const pos = r1.position;
const expectedId = computePositionId(WALLET, JUP_MINT, pos.from_ts, pos.to_ts);
check('Position ID matches compute', pos.position_id, expectedId);

// Narrow position
const narrowPos = narrow1a.position;
const narrowExpectedId = computePositionId(WALLET, JUP_MINT, 1774400000, 1774400500);
check('Narrow position ID matches compute', narrowPos.position_id, narrowExpectedId);

// ═══════════════════════════════════════════════════════════════
// Test 6: Receipt is always verified type
// ═══════════════════════════════════════════════════════════════
section('Test 6: Receipt type is always verified');

check('Full rebuild: receipt_type', r1.receipt.receipt_type, 'verified');
check('Full rebuild: is_custom', r1.receipt.is_custom, false);
check('Narrow rebuild: receipt_type', narrow1a.receipt.receipt_type, 'verified');

// ═══════════════════════════════════════════════════════════════
// Test 7: All required output fields present
// ═══════════════════════════════════════════════════════════════
section('Test 7: Required output fields');

const rr = r1.receipt;
const pp = r1.position;
check('wallet', rr.wallet, WALLET);
check('token_mint', rr.token_mint, JUP_MINT);
check('from_ts', typeof pp.from_ts, 'number');
check('to_ts', typeof pp.to_ts, 'number');
check('position_id', typeof pp.position_id, 'string');
check('receipt_type', rr.receipt_type, 'verified');
check('status', typeof rr.status, 'string');
check('verification_hash length', rr.verification_hash.length, 64);
check('avg_entry_price', typeof rr.avg_entry_price, 'number');
check('avg_exit_price', typeof rr.avg_exit_price, 'number');
check('realized_pnl_pct', typeof rr.realized_pnl_pct, 'number');
check('opened_at', typeof rr.opened_at, 'number');
check('closed_at', typeof rr.closed_at, 'number');

// ═══════════════════════════════════════════════════════════════
// Example output
// ═══════════════════════════════════════════════════════════════
section('Example: Successful Deterministic Rebuild');

function tsDisplay(epoch) { return new Date(epoch * 1000).toISOString().slice(0, 19) + 'Z'; }
const pnlSign = rr.realized_pnl_pct >= 0 ? '+' : '';

console.log(`\n  ╔════════════════════════════════════════════════════════════╗`);
console.log(`  ║  REBUILD RESULT — Deterministic Verified Receipt          ║`);
console.log(`  ╠════════════════════════════════════════════════════════════╣`);
console.log(`  ║  Wallet:        ${rr.wallet.padEnd(41)}║`);
console.log(`  ║  Token:         ${rr.token_mint.padEnd(41)}║`);
console.log(`  ║  From:          ${tsDisplay(pp.from_ts).padEnd(41)}║`);
console.log(`  ║  To:            ${tsDisplay(pp.to_ts).padEnd(41)}║`);
console.log(`  ║  Position ID:   ${pp.position_id.padEnd(41)}║`);
console.log(`  ║  Receipt type:  ${rr.receipt_type.padEnd(41)}║`);
console.log(`  ║  Status:        ${rr.status.padEnd(41)}║`);
console.log(`  ║  Hash:          ${rr.verification_hash.padEnd(41)}║`);
console.log(`  ║  Avg entry:     ${rr.avg_entry_price.toPrecision(6).padEnd(41)}║`);
console.log(`  ║  Avg exit:      ${rr.avg_exit_price.toPrecision(6).padEnd(41)}║`);
console.log(`  ║  PnL:           ${(pnlSign + rr.realized_pnl_pct.toFixed(2) + '%').padEnd(41)}║`);
console.log(`  ║  Trades:        ${(rr.num_buys + 'B / ' + rr.num_sells + 'S (' + rr.num_cycles + ' cycles)').padEnd(41)}║`);
console.log(`  ║  Opened:        ${tsDisplay(rr.opened_at).padEnd(41)}║`);
console.log(`  ║  Closed:        ${tsDisplay(rr.closed_at).padEnd(41)}║`);
console.log(`  ╚════════════════════════════════════════════════════════════╝`);

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(58)}`);
if (fail === 0) {
  console.log(`✅ ALL ${pass} CHECKS PASSED — rebuild is deterministic`);
} else {
  console.log(`❌ ${fail} FAILED, ${pass} passed`);
}
console.log(`${'═'.repeat(58)}`);

process.exit(fail > 0 ? 1 : 0);
