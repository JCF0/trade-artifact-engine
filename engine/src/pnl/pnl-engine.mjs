/**
 * Phase 4 — PnL Engine
 *
 * For closed cycles: compute weighted average entry/exit prices,
 * realized PnL, PnL %, and hold time.
 *
 * For open/partial_history: pass through with null accounting fields.
 *
 * Output: data/pnl/pnl_cycles.jsonl
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Load cycles
// ---------------------------------------------------------------------------

const cyclesPath = resolve(ROOT, 'data', 'cycles', 'trade_cycles.jsonl');
const lines = readFileSync(cyclesPath, 'utf-8').trim().split('\n');
const cycles = lines.map(l => JSON.parse(l));

console.log(`Loaded ${cycles.length} trade cycles`);

// ---------------------------------------------------------------------------
// PnL computation
// ---------------------------------------------------------------------------

function computePnl(cycle) {
  // Only compute for closed cycles
  if (cycle.status !== 'closed') {
    return {
      ...cycle,
      entry_price_avg: null,
      exit_price_avg: null,
      total_cost_basis: null,
      total_exit_proceeds: null,
      realized_pnl: null,
      realized_pnl_pct: null,
      hold_time_seconds: null,
      quote_currency: null,
    };
  }

  // Determine quote currency — check if all txs use same quote
  const allQuotes = [
    ...cycle.entry_txs.map(t => t.quote_mint),
    ...cycle.exit_txs.map(t => t.quote_mint),
  ];
  const uniqueQuotes = [...new Set(allQuotes)];

  let totalCostBasis, totalExitProceeds, entryPriceAvg, exitPriceAvg, quoteCurrency;

  if (uniqueQuotes.length === 1) {
    // Simple case: single quote currency throughout
    quoteCurrency = uniqueQuotes[0];
    totalCostBasis = cycle.entry_txs.reduce((sum, t) => sum + t.quote_amount, 0);
    totalExitProceeds = cycle.exit_txs.reduce((sum, t) => sum + t.quote_amount, 0);
    entryPriceAvg = totalCostBasis / cycle.total_bought;
    exitPriceAvg = totalExitProceeds / cycle.total_sold;
  } else {
    // Mixed quote currencies — compute price per token in each tx,
    // then weighted average. Report in the dominant quote currency.
    // For V1, we flag this but still compute using raw quote amounts.
    // The quote_currency will note it's mixed.
    quoteCurrency = 'MIXED';

    // Weighted average entry: Σ(quote_amount) / Σ(base_amount)
    // This gives "average cost per token in mixed units" — imprecise but
    // still directionally correct if quotes are close in value.
    totalCostBasis = cycle.entry_txs.reduce((sum, t) => sum + t.quote_amount, 0);
    totalExitProceeds = cycle.exit_txs.reduce((sum, t) => sum + t.quote_amount, 0);
    entryPriceAvg = totalCostBasis / cycle.total_bought;
    exitPriceAvg = totalExitProceeds / cycle.total_sold;
  }

  // Realized PnL = total exit proceeds - total cost basis
  const realizedPnl = totalExitProceeds - totalCostBasis;

  // Realized PnL % = (exit proceeds - cost basis) / cost basis × 100
  const realizedPnlPct = totalCostBasis > 0
    ? (realizedPnl / totalCostBasis) * 100
    : 0;

  // Hold time
  const holdTimeSeconds = cycle.closed_at - cycle.opened_at;

  return {
    ...cycle,
    entry_price_avg: parseFloat(entryPriceAvg.toPrecision(12)),
    exit_price_avg: parseFloat(exitPriceAvg.toPrecision(12)),
    total_cost_basis: parseFloat(totalCostBasis.toPrecision(12)),
    total_exit_proceeds: parseFloat(totalExitProceeds.toPrecision(12)),
    realized_pnl: parseFloat(realizedPnl.toPrecision(12)),
    realized_pnl_pct: parseFloat(realizedPnlPct.toPrecision(6)),
    hold_time_seconds: holdTimeSeconds,
    quote_currency: quoteCurrency,
  };
}

// ---------------------------------------------------------------------------
// Process all cycles
// ---------------------------------------------------------------------------

const enriched = cycles.map(computePnl);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const outPath = resolve(ROOT, 'data', 'pnl', 'pnl_cycles.jsonl');
writeFileSync(outPath, enriched.map(c => JSON.stringify(c)).join('\n') + '\n');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n=== Phase 4 — PnL Engine Report ===`);
console.log(`Total cycles:    ${enriched.length}`);

const closed = enriched.filter(c => c.status === 'closed');
const open = enriched.filter(c => c.status === 'open');
const partial = enriched.filter(c => c.status === 'partial_history');

console.log(`  closed:          ${closed.length} (PnL computed)`);
console.log(`  open:            ${open.length} (no PnL)`);
console.log(`  partial_history: ${partial.length} (no PnL)`);

for (const c of closed) {
  const holdMin = (c.hold_time_seconds / 60).toFixed(1);
  console.log(`\n--- Closed: ${c.cycle_id} ---`);
  console.log(`  Token:              ${c.token_mint}`);
  console.log(`  Quote:              ${c.quote_currency}`);
  console.log(`  Entry price (avg):  ${c.entry_price_avg}`);
  console.log(`  Exit price (avg):   ${c.exit_price_avg}`);
  console.log(`  Total bought:       ${c.total_bought} tokens`);
  console.log(`  Total sold:         ${c.total_sold} tokens`);
  console.log(`  Cost basis:         ${c.total_cost_basis}`);
  console.log(`  Exit proceeds:      ${c.total_exit_proceeds}`);
  console.log(`  Realized PnL:       ${c.realized_pnl}`);
  console.log(`  Realized PnL %:     ${c.realized_pnl_pct}%`);
  console.log(`  Hold time:          ${holdMin} min (${c.hold_time_seconds}s)`);
  console.log(`  Peak position:      ${c.peak_position}`);
  console.log(`  Remaining balance:  ${c.remaining_balance}`);
}

console.log(`\n=== Sample Enriched Cycles ===`);

// Show 1 closed, 1 open, 1 partial
const samples = [closed[0], open[0], partial[0]].filter(Boolean);
for (const s of samples) {
  // Print without the full tx arrays to keep it readable
  const { entry_txs, exit_txs, ...summary } = s;
  console.log(`\n--- ${s.status}: ${s.cycle_id} ---`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`  (${entry_txs.length} entry txs, ${exit_txs.length} exit txs — omitted for brevity)`);
}

console.log(`\nOutput: ${outPath}`);
