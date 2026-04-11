#!/usr/bin/env node
/**
 * Phase 0.5 Regression Test
 *
 * Verifies that the extracted pipeline modules produce IDENTICAL outputs
 * to the original mint-one.mjs v1 monolith.
 *
 * Uses existing cached data (data/raw/helius_transactions.jsonl) to avoid
 * any API calls. Compares:
 *   1. Normalized event count
 *   2. Reconstructed cycle count + statuses
 *   3. Receipt count
 *   4. Verification hashes (the critical check)
 *   5. All numeric fields on receipts
 *
 * Expected baseline (from v1 output):
 *   receipt_0001: hash = 582cc281a9edadf08b9519f5f8373359bd24c9a4047e50be0bd78927df6bac0e
 *   receipt_0002: hash = c6d45f7eb7a6b429e59480a280c513c52c3f9413844bee2d393e670934ec1f49
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { normalizeTransactions } from './ingest.mjs';
import { reconstructCycles } from './reconstruct.mjs';
import { buildReceipts } from './receipt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// ── Load existing raw transactions (no API call needed) ──
const txnPath = resolve(ROOT, 'data', 'raw', 'helius_transactions.jsonl');
const rawLines = readFileSync(txnPath, 'utf-8').trim().split('\n').filter(Boolean);
const rawTxns = rawLines.map(l => JSON.parse(l));

// The wallet used in the original run
const WALLET = 'FDh2oFVBYzmVrqVrNQNR8vRwVZhfRhW5w964HG8eypxP';

// Known-good hashes from v1 output
const EXPECTED_HASHES = [
  '582cc281a9edadf08b9519f5f8373359bd24c9a4047e50be0bd78927df6bac0e',
  'c6d45f7eb7a6b429e59480a280c513c52c3f9413844bee2d393e670934ec1f49',
];

// Known-good receipt fields from v1 output
const EXPECTED_RECEIPTS = [
  {
    receipt_id: 'receipt_0001_JUPyiwrY',
    avg_entry_price: 0.00171731781061,
    avg_exit_price: 0.00171650431717,
    realized_pnl: -0.000009474,
    realized_pnl_pct: -0.04737,
    total_bought: 11.646068,
    total_sold: 11.646068,
    num_buys: 1, num_sells: 1,
    hold_time_seconds: 34,
    status: 'verified',
  },
  {
    receipt_id: 'receipt_0002_JUPyiwrY',
    avg_entry_price: 0.00188912927009,
    avg_exit_price: 0.00188795687647,
    realized_pnl: -0.000003103,
    realized_pnl_pct: -0.06206,
    total_bought: 2.646722,
    total_sold: 2.646722,
    num_buys: 1, num_sells: 1,
    hold_time_seconds: 39,
    status: 'verified',
  },
];

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✅ ${label}: ${actual}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}: expected ${expected}, got ${actual}`);
    fail++;
  }
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Phase 0.5 Regression Test — Pipeline Module Extraction ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// ── Phase 2: Normalize ──
console.log('── Normalize ──');
const { events, stats: normStats } = normalizeTransactions(rawTxns, WALLET, { silent: true });
console.log(`  Raw txns loaded: ${rawTxns.length}`);
console.log(`  Swap events: ${events.length}`);

// ── Phase 3: Reconstruct ──
console.log('\n── Reconstruct ──');
const { cycles, stats: cycleStats } = reconstructCycles(events);
check('Total cycles', cycleStats.total, cycles.length);
console.log(`  Closed: ${cycleStats.closed} | Open: ${cycleStats.open} | Partial: ${cycleStats.partial}`);
check('Closed cycles', cycleStats.closed, 2);

// ── Phase 4-5: Receipts ──
console.log('\n── Receipts ──');
const closed = cycles.filter(c => c.status === 'closed');
const receipts = buildReceipts(closed, WALLET);
check('Receipt count', receipts.length, 2);

// ── Hash verification (THE critical test) ──
console.log('\n── Verification Hashes ──');
for (let i = 0; i < receipts.length; i++) {
  const r = receipts[i];
  check(`Receipt ${i + 1} hash`, r.verification_hash, EXPECTED_HASHES[i]);
}

// ── Field-level verification ──
console.log('\n── Field-Level Checks ──');
for (let i = 0; i < receipts.length; i++) {
  const r = receipts[i];
  const e = EXPECTED_RECEIPTS[i];
  console.log(`\n  Receipt ${i + 1}: ${r.receipt_id}`);
  check(`  receipt_id`, r.receipt_id, e.receipt_id);
  check(`  avg_entry_price`, r.avg_entry_price, e.avg_entry_price);
  check(`  avg_exit_price`, r.avg_exit_price, e.avg_exit_price);
  check(`  realized_pnl`, r.realized_pnl, e.realized_pnl);
  check(`  realized_pnl_pct`, r.realized_pnl_pct, e.realized_pnl_pct);
  check(`  total_bought`, r.total_bought, e.total_bought);
  check(`  total_sold`, r.total_sold, e.total_sold);
  check(`  num_buys`, r.num_buys, e.num_buys);
  check(`  num_sells`, r.num_sells, e.num_sells);
  check(`  hold_time_seconds`, r.hold_time_seconds, e.hold_time_seconds);
  check(`  status`, r.status, e.status);
}

// ── Summary ──
console.log(`\n${'═'.repeat(58)}`);
if (fail === 0) {
  console.log(`✅ ALL ${pass} CHECKS PASSED — pipeline extraction is regression-safe`);
} else {
  console.log(`❌ ${fail} FAILED, ${pass} passed — REGRESSION DETECTED`);
}
console.log(`${'═'.repeat(58)}`);

process.exit(fail > 0 ? 1 : 0);
