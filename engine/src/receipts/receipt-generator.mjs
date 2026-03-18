/**
 * Phase 5 — Receipt Generator
 *
 * Converts closed/verified PnL cycles into canonical TradeReceipt JSON objects.
 * Generates a deterministic verification hash for each receipt.
 *
 * Output: data/receipts/receipts.jsonl
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const RECEIPT_VERSION = '1.0';
const CHAIN = 'solana';
const WALLET = 'CreQJ2t94QK5dsxUZGXfPJ8Nx7wA9LHr5chxjSMkbNft';
const ACCOUNTING_METHOD = 'weighted_average_cost_basis';

// ---------------------------------------------------------------------------
// Verification hash
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic SHA-256 hash over the receipt's core fields.
 *
 * Inputs (concatenated in order, JSON-serialized where needed):
 *   wallet, chain, token_mint, entry_tx_hashes (sorted), exit_tx_hashes (sorted),
 *   entry_price_avg, exit_price_avg, accounting_method, receipt_version
 *
 * Sorting tx hashes ensures the hash is order-independent and reproducible.
 */
function computeVerificationHash(fields) {
  const entryHashes = fields.entry_txs.map(t => t.tx_hash).sort();
  const exitHashes = fields.exit_txs.map(t => t.tx_hash).sort();

  const payload = JSON.stringify([
    fields.wallet,
    fields.chain,
    fields.token_mint,
    entryHashes,
    exitHashes,
    fields.entry_price_avg,
    fields.exit_price_avg,
    fields.accounting_method,
    fields.receipt_version,
  ]);

  return createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Receipt builder
// ---------------------------------------------------------------------------

function buildReceipt(cycle, index) {
  const receiptId = `receipt_${String(index + 1).padStart(4, '0')}_${cycle.token_mint.slice(0, 8)}`;

  const receipt = {
    receipt_id: receiptId,
    receipt_version: RECEIPT_VERSION,
    cycle_id: cycle.cycle_id,
    wallet: WALLET,
    chain: CHAIN,
    token_mint: cycle.token_mint,
    status: 'verified',
    accounting_method: ACCOUNTING_METHOD,

    // Pricing
    avg_entry_price: cycle.entry_price_avg,
    avg_exit_price: cycle.exit_price_avg,
    quote_currency: cycle.quote_currency,

    // PnL
    total_cost_basis: cycle.total_cost_basis,
    total_exit_proceeds: cycle.total_exit_proceeds,
    realized_pnl: cycle.realized_pnl,
    realized_pnl_pct: cycle.realized_pnl_pct,

    // Position
    total_bought: cycle.total_bought,
    total_sold: cycle.total_sold,
    peak_position: cycle.peak_position,
    remaining_balance: cycle.remaining_balance,
    num_buys: cycle.num_buys,
    num_sells: cycle.num_sells,

    // Timing
    opened_at: cycle.opened_at,
    closed_at: cycle.closed_at,
    hold_time_seconds: cycle.hold_time_seconds,

    // Transaction references
    entry_txs: cycle.entry_txs.map(t => ({
      tx_hash: t.tx_hash,
      timestamp: t.timestamp,
      amount: t.amount,
      quote_amount: t.quote_amount,
    })),
    exit_txs: cycle.exit_txs.map(t => ({
      tx_hash: t.tx_hash,
      timestamp: t.timestamp,
      amount: t.amount,
      quote_amount: t.quote_amount,
    })),

    // Generation metadata
    generated_at: Math.floor(Date.now() / 1000),

    // Verification — computed last
    verification_hash: null,
  };

  // Compute hash over the canonical fields (not generated_at — that's metadata)
  receipt.verification_hash = computeVerificationHash({
    wallet: receipt.wallet,
    chain: receipt.chain,
    token_mint: receipt.token_mint,
    entry_txs: receipt.entry_txs,
    exit_txs: receipt.exit_txs,
    entry_price_avg: receipt.avg_entry_price,
    exit_price_avg: receipt.avg_exit_price,
    accounting_method: receipt.accounting_method,
    receipt_version: receipt.receipt_version,
  });

  return receipt;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const pnlPath = resolve(ROOT, 'data', 'pnl', 'pnl_cycles.jsonl');
const lines = readFileSync(pnlPath, 'utf-8').trim().split('\n');
const cycles = lines.map(l => JSON.parse(l));

console.log(`Loaded ${cycles.length} PnL cycles`);

// Filter to closed/verified only
const closedCycles = cycles.filter(c => c.status === 'closed');
console.log(`Closed cycles eligible for receipts: ${closedCycles.length}`);

const receipts = closedCycles.map((c, i) => buildReceipt(c, i));

// Write output
const outPath = resolve(ROOT, 'data', 'receipts', 'receipts.jsonl');
writeFileSync(outPath, receipts.map(r => JSON.stringify(r)).join('\n') + '\n');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n=== Phase 5 — Receipt Generator Report ===`);
console.log(`Receipts generated: ${receipts.length}`);
console.log(`Skipped (open):            ${cycles.filter(c => c.status === 'open').length}`);
console.log(`Skipped (partial_history): ${cycles.filter(c => c.status === 'partial_history').length}`);

for (const r of receipts) {
  console.log(`\n--- ${r.receipt_id} ---`);
  console.log(JSON.stringify(r, null, 2));
}

console.log(`\nOutput: ${outPath}`);
