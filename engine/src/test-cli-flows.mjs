#!/usr/bin/env node
/**
 * Phase 3 — CLI Flow Test
 *
 * Tests the mint-one.mjs CLI flows by simulating them programmatically.
 * Uses cached data — zero API calls.
 *
 * Verifies:
 *   1. Cycle flow (--pick) produces same hashes as v1
 *   2. Position flow produces verified receipt
 *   3. Custom flow produces custom receipt with different hash
 *   4. Custom receipt has integrity warnings
 *   5. All receipt fields are populated correctly
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { normalizeTransactions } from './pipeline/ingest.mjs';
import { reconstructCycles } from './pipeline/reconstruct.mjs';
import { buildReceipts, buildPositionReceipt, buildCustomReceipt } from './pipeline/receipt.mjs';
import { buildPositions, buildCustomPosition } from './position/position-builder.mjs';

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

// ── Load test data ──
const txns = readFileSync(resolve(ROOT, 'data/raw/helius_transactions.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const WALLET = 'FDh2oFVBYzmVrqVrNQNR8vRwVZhfRhW5w964HG8eypxP';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

const { events } = normalizeTransactions(txns, WALLET, { silent: true });
const { cycles } = reconstructCycles(events);
const closed = cycles.filter(c => c.status === 'closed');

const EXPECTED_HASHES = [
  '582cc281a9edadf08b9519f5f8373359bd24c9a4047e50be0bd78927df6bac0e',
  'c6d45f7eb7a6b429e59480a280c513c52c3f9413844bee2d393e670934ec1f49',
];

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Phase 3 — CLI Flow Tests                               ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ═══════════════════════════════════════════════════════════════
// Test 1: Cycle flow (--pick) — v1 regression
// ═══════════════════════════════════════════════════════════════
section('Test 1: Cycle flow (--pick) — v1 regression');

const cycleReceipts = buildReceipts(closed, WALLET);
check('Cycle receipts count', cycleReceipts.length, 2);
check('Receipt 1 hash matches v1', cycleReceipts[0].verification_hash, EXPECTED_HASHES[0]);
check('Receipt 2 hash matches v1', cycleReceipts[1].verification_hash, EXPECTED_HASHES[1]);
check('Receipt 1 receipt_type', cycleReceipts[0].receipt_type, 'verified');
check('Receipt 1 has status_byte', cycleReceipts[0].status_byte, 0);

// Simulate --pick 1
const picked = cycleReceipts[0];
check('Picked receipt_id', picked.receipt_id, 'receipt_0001_JUPyiwrY');
check('Picked wallet', picked.wallet, WALLET);

// ═══════════════════════════════════════════════════════════════
// Test 2: Position flow — verified receipt
// ═══════════════════════════════════════════════════════════════
section('Test 2: Position flow — verified receipt');

const positions = buildPositions(cycles, { wallet: WALLET });
check('Position count', positions.length, 1);

const pos = positions[0];
const posReceipt = buildPositionReceipt(pos);

check('Position receipt receipt_type', posReceipt.receipt_type, 'verified');
check('Position receipt is_custom', posReceipt.is_custom, false);
check('Position receipt has position_id', posReceipt.position_id, pos.position_id);
check('Position receipt status', posReceipt.status, 'verified');
check('Position receipt status_byte', posReceipt.status_byte, 0);
check('Position receipt num_buys', posReceipt.num_buys, 2);
check('Position receipt num_sells', posReceipt.num_sells, 2);
check('Position receipt num_cycles', posReceipt.num_cycles, 2);
check('Position receipt has verification_hash', posReceipt.verification_hash.length, 64);
check('Position receipt wallet', posReceipt.wallet, WALLET);
check('Position receipt token', posReceipt.token_mint, JUP_MINT);

// Position receipt differs from cycle receipts (aggregates 2 cycles)
check('Position hash differs from cycle 1', posReceipt.verification_hash !== EXPECTED_HASHES[0], true);
check('Position hash differs from cycle 2', posReceipt.verification_hash !== EXPECTED_HASHES[1], true);

// ═══════════════════════════════════════════════════════════════
// Test 3: Position flow with --token filter
// ═══════════════════════════════════════════════════════════════
section('Test 3: Position flow with --token filter');

const filteredPos = buildPositions(cycles, { wallet: WALLET, token: JUP_MINT });
check('Filtered positions count', filteredPos.length, 1);

const noMatchPos = buildPositions(cycles, { wallet: WALLET, token: 'FakeToken' });
check('No-match filter returns 0', noMatchPos.length, 0);

// ═══════════════════════════════════════════════════════════════
// Test 4: Custom flow — --remove-legs simulation
// ═══════════════════════════════════════════════════════════════
section('Test 4: Custom flow (--remove-legs simulation)');

const firstEntryHash = pos.entries[0].tx_hash;
const customPos = buildCustomPosition(pos, { removed_legs: [firstEntryHash] });
const customReceipt = buildCustomReceipt(customPos, posReceipt.verification_hash);

check('Custom receipt_type', customReceipt.receipt_type, 'custom');
check('Custom is_custom', customReceipt.is_custom, true);
check('Custom status', customReceipt.status, 'custom');
check('Custom status_byte', customReceipt.status_byte, 2);
check('Custom receipt_id has _custom', customReceipt.receipt_id.endsWith('_custom'), true);
check('Custom has position_id', !!customReceipt.position_id, true);
check('Custom has base_position_id', !!customReceipt.base_position_id, true);
check('Custom has base_position_hash', customReceipt.base_position_hash, posReceipt.verification_hash);
check('Custom has removed_legs', customReceipt.removed_legs.length, 1);
check('Custom hash differs from verified', customReceipt.verification_hash !== posReceipt.verification_hash, true);
check('Custom hash is 64 chars', customReceipt.verification_hash.length, 64);

// Custom hash is deterministic
const customPos2 = buildCustomPosition(pos, { removed_legs: [firstEntryHash] });
const customReceipt2 = buildCustomReceipt(customPos2, posReceipt.verification_hash);
check('Custom hash deterministic', customReceipt2.verification_hash, customReceipt.verification_hash);

// ═══════════════════════════════════════════════════════════════
// Test 5: Custom integrity warnings
// ═══════════════════════════════════════════════════════════════
section('Test 5: Custom integrity warnings');

check('Custom has integrity_warnings', Array.isArray(customReceipt.integrity_warnings), true);
check('Has sold_exceeds_bought', customReceipt.integrity_warnings.some(w => w.includes('sold_exceeds_bought')), true);

// Verified should NOT have warnings
check('Verified has no warnings', posReceipt.integrity_warnings, undefined);

// ═══════════════════════════════════════════════════════════════
// Test 6: Receipt preview fields (all required fields present)
// ═══════════════════════════════════════════════════════════════
section('Test 6: All required CLI preview fields present');

for (const [label, receipt] of [['Verified', posReceipt], ['Custom', customReceipt]]) {
  check(`${label}: token_mint`, typeof receipt.token_mint, 'string');
  check(`${label}: receipt_type`, typeof receipt.receipt_type, 'string');
  check(`${label}: status`, typeof receipt.status, 'string');
  check(`${label}: position_id`, typeof receipt.position_id, 'string');
  check(`${label}: avg_entry_price`, typeof receipt.avg_entry_price, 'number');
  check(`${label}: avg_exit_price`, typeof receipt.avg_exit_price, 'number');
  check(`${label}: realized_pnl_pct`, typeof receipt.realized_pnl_pct, 'number');
  check(`${label}: num_buys`, typeof receipt.num_buys, 'number');
  check(`${label}: num_sells`, typeof receipt.num_sells, 'number');
  check(`${label}: opened_at`, typeof receipt.opened_at, 'number');
  check(`${label}: closed_at`, typeof receipt.closed_at, 'number');
  check(`${label}: verification_hash`, typeof receipt.verification_hash, 'string');
}

// Custom-specific
check('Custom: base_position_id present', typeof customReceipt.base_position_id, 'string');
check('Custom: removed_legs present', Array.isArray(customReceipt.removed_legs), true);

// ═══════════════════════════════════════════════════════════════
// Example Terminal Output Simulation
// ═══════════════════════════════════════════════════════════════
section('Example: Verified Position Receipt Preview');

function tsDisplay(epoch) { return new Date(epoch * 1000).toISOString().slice(0, 19) + 'Z'; }
const SYMS_MAP = { 'So11111111111111111111111111111111111111112': 'SOL' };

function printPreview(r) {
  const isC = r.receipt_type === 'custom';
  const pnlSign = r.realized_pnl_pct >= 0 ? '+' : '';
  const bar = isC ? '⚠️  CUSTOM RECEIPT (not verified)' : '✅ VERIFIED RECEIPT';

  console.log(`\n  ┌─────────────────────────────────────────────────────┐`);
  console.log(`  │ ${bar.padEnd(52)}│`);
  console.log(`  ├─────────────────────────────────────────────────────┤`);
  console.log(`  │ Token:          ${r.token_mint.slice(0, 12)}...${' '.repeat(28)}│`);
  console.log(`  │ Receipt type:   ${r.receipt_type.padEnd(36)}│`);
  console.log(`  │ Status:         ${r.status.padEnd(36)}│`);
  if (r.position_id)
    console.log(`  │ Position ID:    ${r.position_id.slice(0, 24)}...${' '.repeat(9)}│`);
  if (isC && r.base_position_id)
    console.log(`  │ Base position:  ${r.base_position_id.slice(0, 24)}...${' '.repeat(9)}│`);
  console.log(`  │ Avg entry:      ${r.avg_entry_price.toPrecision(6).padEnd(36)}│`);
  console.log(`  │ Avg exit:       ${r.avg_exit_price.toPrecision(6).padEnd(36)}│`);
  console.log(`  │ PnL:            ${(pnlSign + r.realized_pnl_pct.toFixed(2) + '%').padEnd(36)}│`);
  console.log(`  │ Trades:         ${(r.num_buys + 'B / ' + r.num_sells + 'S').padEnd(36)}│`);
  console.log(`  │ Opened:         ${tsDisplay(r.opened_at).padEnd(36)}│`);
  console.log(`  │ Closed:         ${tsDisplay(r.closed_at).padEnd(36)}│`);
  console.log(`  │ Hash:           ${r.verification_hash.slice(0, 24)}...${' '.repeat(9)}│`);
  if (isC && r.removed_legs) {
    console.log(`  │ Removed legs:   ${String(r.removed_legs.length).padEnd(36)}│`);
  }
  if (r.integrity_warnings && r.integrity_warnings.length > 0) {
    console.log(`  │${'─'.repeat(53)}│`);
    console.log(`  │ ⚠️  INTEGRITY WARNINGS:${' '.repeat(29)}│`);
    for (const w of r.integrity_warnings) {
      console.log(`  │   ${w.slice(0, 50).padEnd(50)}│`);
    }
  }
  console.log(`  └─────────────────────────────────────────────────────┘`);
}

printPreview(posReceipt);

section('Example: Custom Receipt Preview');
printPreview(customReceipt);

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(58)}`);
if (fail === 0) {
  console.log(`✅ ALL ${pass} CHECKS PASSED — CLI flows are solid`);
} else {
  console.log(`❌ ${fail} FAILED, ${pass} passed`);
}
console.log(`${'═'.repeat(58)}`);

process.exit(fail > 0 ? 1 : 0);
