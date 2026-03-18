/**
 * Phase 3 — Trade Cycle Reconstruction
 *
 * Detects buy → accumulate → sell cycles from normalized swap events.
 * Tracks running balance per token mint. Opens cycle on first acquisition,
 * closes when balance falls below dust threshold.
 *
 * Output: data/cycles/trade_cycles.jsonl
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

// Dust threshold: remaining_balance < max(0.001 tokens, 0.1% of peak_position)
const DUST_ABS = 0.001;
const DUST_PCT = 0.001; // 0.1%

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDust(balance, peakPosition) {
  const threshold = Math.max(DUST_ABS, DUST_PCT * peakPosition);
  return balance < threshold;
}

let cycleCounter = 0;
function nextCycleId(tokenMint) {
  cycleCounter++;
  return `cycle_${cycleCounter}_${tokenMint.slice(0, 8)}`;
}

/**
 * Classify an event relative to a base token.
 * Returns { action: 'buy'|'sell'|null, baseMint, quoteMint, baseAmount, quoteAmount }
 */
function classifyEvent(event) {
  const inIsQuote = QUOTE_MINTS.has(event.token_in_mint);
  const outIsQuote = QUOTE_MINTS.has(event.token_out_mint);

  if (inIsQuote && !outIsQuote) {
    // Buying: spent quote, received base token
    return {
      action: 'buy',
      baseMint: event.token_out_mint,
      quoteMint: event.token_in_mint,
      baseAmount: event.token_out_amount,
      quoteAmount: event.token_in_amount,
    };
  } else if (!inIsQuote && outIsQuote) {
    // Selling: spent base token, received quote
    return {
      action: 'sell',
      baseMint: event.token_in_mint,
      quoteMint: event.token_out_mint,
      baseAmount: event.token_in_amount,
      quoteAmount: event.token_out_amount,
    };
  }

  // Quote-to-quote or token-to-token — not a base token trade
  return { action: null };
}

/**
 * Create a new empty cycle object.
 */
function newCycle(tokenMint, openedAt) {
  return {
    cycle_id: nextCycleId(tokenMint),
    token_mint: tokenMint,
    status: 'open',                 // open | closed | partial_history
    opened_at: openedAt,
    closed_at: null,
    entry_txs: [],                  // { tx_hash, timestamp, amount, quote_mint, quote_amount }
    exit_txs: [],
    total_bought: 0,
    total_sold: 0,
    peak_position: 0,
    running_balance: 0,
  };
}

// ---------------------------------------------------------------------------
// Load events
// ---------------------------------------------------------------------------

const eventsPath = resolve(ROOT, 'data', 'normalized', 'events.jsonl');
const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n');
const events = lines.map(l => JSON.parse(l));

// Sort chronologically (oldest first)
events.sort((a, b) => a.timestamp - b.timestamp || a.raw_index - b.raw_index);

console.log(`Loaded ${events.length} normalized events (sorted chronologically)`);

// ---------------------------------------------------------------------------
// Cycle reconstruction
// ---------------------------------------------------------------------------

// Track active cycle per token mint
const activeCycles = new Map();  // mint -> cycle
const completedCycles = [];

for (const event of events) {
  const c = classifyEvent(event);
  if (!c.action) continue; // skip quote-to-quote

  const mint = c.baseMint;
  let cycle = activeCycles.get(mint);

  if (c.action === 'buy') {
    // Open new cycle if none active
    if (!cycle) {
      cycle = newCycle(mint, event.timestamp);
      activeCycles.set(mint, cycle);
    }

    cycle.entry_txs.push({
      tx_hash: event.tx_hash,
      timestamp: event.timestamp,
      amount: c.baseAmount,
      quote_mint: c.quoteMint,
      quote_amount: c.quoteAmount,
      raw_index: event.raw_index,
    });
    cycle.total_bought += c.baseAmount;
    cycle.running_balance += c.baseAmount;
    cycle.peak_position = Math.max(cycle.peak_position, cycle.running_balance);

  } else if (c.action === 'sell') {
    if (!cycle) {
      // Sell without a prior buy in our window — pre-existing position
      cycle = newCycle(mint, event.timestamp);
      cycle.status = 'partial_history';
      activeCycles.set(mint, cycle);
    }

    cycle.exit_txs.push({
      tx_hash: event.tx_hash,
      timestamp: event.timestamp,
      amount: c.baseAmount,
      quote_mint: c.quoteMint,
      quote_amount: c.quoteAmount,
      raw_index: event.raw_index,
    });
    cycle.total_sold += c.baseAmount;
    cycle.running_balance -= c.baseAmount;

    // Check if cycle is closed (balance at dust)
    // Use absolute value of balance for dust check (could go slightly negative due to rounding)
    const absBalance = Math.abs(cycle.running_balance);
    // For partial_history cycles, peak might be 0 if no buys seen.
    // Use total_sold as proxy for peak in that case.
    const effectivePeak = cycle.peak_position > 0 ? cycle.peak_position : cycle.total_sold;

    if (isDust(absBalance, effectivePeak)) {
      cycle.closed_at = event.timestamp;
      if (cycle.status === 'open') cycle.status = 'closed';
      // partial_history stays partial_history even when closed
      completedCycles.push(cycle);
      activeCycles.delete(mint);
    }
  }
}

// Remaining active cycles: reclassify if balance went negative (pre-existing position)
const openCycles = [...activeCycles.values()];
for (const c of openCycles) {
  if (c.running_balance < 0 && c.status === 'open') {
    c.status = 'partial_history';
  }
}

// All cycles combined
const allCycles = [...completedCycles, ...openCycles];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const outPath = resolve(ROOT, 'data', 'cycles', 'trade_cycles.jsonl');

// Write cycles sorted by opened_at
allCycles.sort((a, b) => a.opened_at - b.opened_at);

// Strip running_balance from output (internal tracking only) and add final fields
const output = allCycles.map(c => ({
  cycle_id: c.cycle_id,
  token_mint: c.token_mint,
  status: c.status,
  opened_at: c.opened_at,
  closed_at: c.closed_at,
  num_buys: c.entry_txs.length,
  num_sells: c.exit_txs.length,
  total_bought: parseFloat(c.total_bought.toFixed(10)),
  total_sold: parseFloat(c.total_sold.toFixed(10)),
  peak_position: parseFloat(c.peak_position.toFixed(10)),
  remaining_balance: parseFloat(c.running_balance.toFixed(10)),
  entry_txs: c.entry_txs,
  exit_txs: c.exit_txs,
}));

writeFileSync(outPath, output.map(c => JSON.stringify(c)).join('\n') + '\n');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const statusCounts = {};
for (const c of output) {
  statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
}

console.log(`\n=== Phase 3 — Trade Cycle Reconstruction Report ===`);
console.log(`Total cycles detected:  ${output.length}`);
for (const [s, n] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s}: ${n}`);
}

console.log(`\nClosed cycles:`);
const closed = output.filter(c => c.status === 'closed');
for (const c of closed) {
  const duration = c.closed_at - c.opened_at;
  const durMin = (duration / 60).toFixed(1);
  console.log(`  ${c.cycle_id} | buys=${c.num_buys} sells=${c.num_sells} | bought=${c.total_bought} sold=${c.total_sold} | peak=${c.peak_position} remain=${c.remaining_balance} | ${durMin}min`);
}

console.log(`\nPartial history cycles:`);
const partial = output.filter(c => c.status === 'partial_history');
for (const c of partial) {
  console.log(`  ${c.cycle_id} | buys=${c.num_buys} sells=${c.num_sells} | bought=${c.total_bought} sold=${c.total_sold} | remain=${c.remaining_balance}`);
}

console.log(`\nOpen cycles (not closed yet):`);
const open = output.filter(c => c.status === 'open');
for (const c of open) {
  console.log(`  ${c.cycle_id} | buys=${c.num_buys} sells=${c.num_sells} | bought=${c.total_bought} sold=${c.total_sold} | remain=${c.remaining_balance.toFixed(6)}`);
}

console.log(`\nOutput: ${outPath}`);

// Print 3 full sample cycles (1 closed, 1 partial, 1 open if available)
console.log(`\n=== Sample Cycles ===`);
const samples = [
  closed[0],
  partial[0],
  open[0],
].filter(Boolean);
for (const s of samples) {
  console.log(`\n--- ${s.status}: ${s.cycle_id} ---`);
  console.log(JSON.stringify(s, null, 2));
}
