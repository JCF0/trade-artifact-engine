/**
 * Receipt Inspection Report
 * 
 * For each receipt: full JSON, cycle summary, accounting breakdown,
 * and sanity checks.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SYMBOLS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij': 'cbBTC',
};
function sym(mint) { return SYMBOLS[mint] || mint.slice(0, 12) + '...'; }

const receipts = readFileSync(resolve(ROOT, 'data/receipts/receipts.jsonl'), 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l));

for (const r of receipts) {
  const qSym = sym(r.quote_currency);
  const tSym = sym(r.token_mint);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`RECEIPT: ${r.receipt_id}`);
  console.log(`${'='.repeat(80)}`);

  // Summary
  console.log(`\n--- Summary ---`);
  console.log(`Token:           ${tSym} (${r.token_mint})`);
  console.log(`Quote:           ${qSym} (${r.quote_currency})`);
  console.log(`Status:          ${r.status}`);
  console.log(`Buys:            ${r.num_buys}`);
  console.log(`Sells:           ${r.num_sells}`);
  console.log(`Total bought:    ${r.total_bought} ${tSym}`);
  console.log(`Total sold:      ${r.total_sold} ${tSym}`);
  console.log(`Remaining:       ${r.remaining_balance} ${tSym}`);
  console.log(`Peak position:   ${r.peak_position} ${tSym}`);

  // Accounting
  console.log(`\n--- Accounting ---`);
  console.log(`Entry price avg: ${r.avg_entry_price} ${qSym}/${tSym}`);
  console.log(`Exit price avg:  ${r.avg_exit_price} ${qSym}/${tSym}`);
  console.log(`Cost basis:      ${r.total_cost_basis} ${qSym}`);
  console.log(`Exit proceeds:   ${r.total_exit_proceeds} ${qSym}`);
  console.log(`Realized PnL:    ${r.realized_pnl >= 0 ? '+' : ''}${r.realized_pnl} ${qSym}`);
  console.log(`Realized PnL %:  ${r.realized_pnl_pct >= 0 ? '+' : ''}${r.realized_pnl_pct}%`);

  // Timing
  const holdMin = (r.hold_time_seconds / 60).toFixed(1);
  const holdHrs = (r.hold_time_seconds / 3600).toFixed(2);
  console.log(`\n--- Timing ---`);
  console.log(`Opened:          ${new Date(r.opened_at * 1000).toISOString()}`);
  console.log(`Closed:          ${new Date(r.closed_at * 1000).toISOString()}`);
  console.log(`Hold time:       ${holdMin} min (${holdHrs} hrs)`);

  // Sanity checks
  console.log(`\n--- Sanity Checks ---`);

  // 1. Verify WACB entry
  const calcCostBasis = r.entry_txs.reduce((s, t) => s + t.quote_amount, 0);
  const calcTotalBought = r.entry_txs.reduce((s, t) => s + t.amount, 0);
  const calcEntryAvg = calcCostBasis / calcTotalBought;
  console.log(`Entry WACB check:  Σ(quote) = ${calcCostBasis.toFixed(6)} / Σ(amount) = ${calcTotalBought.toFixed(10)} = ${calcEntryAvg.toPrecision(12)}`);
  console.log(`  Matches receipt: ${Math.abs(calcEntryAvg - r.avg_entry_price) < 1e-6 ? '✅' : '❌'}`);

  // 2. Verify WACB exit
  const calcExitProceeds = r.exit_txs.reduce((s, t) => s + t.quote_amount, 0);
  const calcTotalSold = r.exit_txs.reduce((s, t) => s + t.amount, 0);
  const calcExitAvg = calcExitProceeds / calcTotalSold;
  console.log(`Exit WACB check:   Σ(quote) = ${calcExitProceeds.toFixed(6)} / Σ(amount) = ${calcTotalSold.toFixed(10)} = ${calcExitAvg.toPrecision(12)}`);
  console.log(`  Matches receipt: ${Math.abs(calcExitAvg - r.avg_exit_price) < 1e-6 ? '✅' : '❌'}`);

  // 3. Verify PnL
  const calcPnl = calcExitProceeds - calcCostBasis;
  const calcPnlPct = (calcPnl / calcCostBasis) * 100;
  console.log(`PnL check:         ${calcExitProceeds.toFixed(6)} - ${calcCostBasis.toFixed(6)} = ${calcPnl.toFixed(6)}`);
  console.log(`  Matches receipt: ${Math.abs(calcPnl - r.realized_pnl) < 0.01 ? '✅' : '❌'}`);
  console.log(`PnL % check:       ${calcPnlPct.toFixed(6)}%`);
  console.log(`  Matches receipt: ${Math.abs(calcPnlPct - r.realized_pnl_pct) < 0.01 ? '✅' : '❌'}`);

  // 4. Dust threshold check
  const dustThreshold = Math.max(0.001, 0.001 * r.peak_position);
  const absRemain = Math.abs(r.remaining_balance);
  console.log(`Dust check:        |${r.remaining_balance}| < max(0.001, 0.1% × ${r.peak_position}) = ${dustThreshold.toFixed(10)}`);
  console.log(`  ${absRemain.toFixed(10)} < ${dustThreshold.toFixed(10)}: ${absRemain < dustThreshold ? '✅' : '❌'}`);

  // 5. Verification hash re-derive
  const entryHashes = r.entry_txs.map(t => t.tx_hash).sort();
  const exitHashes = r.exit_txs.map(t => t.tx_hash).sort();
  const payload = JSON.stringify([
    r.wallet, r.chain, r.token_mint, entryHashes, exitHashes,
    r.avg_entry_price, r.avg_exit_price, r.accounting_method, r.receipt_version,
  ]);
  const reHash = createHash('sha256').update(payload).digest('hex');
  console.log(`Hash re-derive:    ${reHash}`);
  console.log(`  Matches receipt: ${reHash === r.verification_hash ? '✅' : '❌'}`);

  // Quote currency breakdown for MIXED
  if (r.quote_currency === 'MIXED') {
    console.log(`\n--- Quote Currency Breakdown (MIXED) ---`);
    const entryQuotes = {};
    for (const t of r.entry_txs) {
      // We don't have quote_mint in receipts, but we can check from cycles
      entryQuotes['entry'] = (entryQuotes['entry'] || 0) + t.quote_amount;
    }
    const exitQuotes = {};
    for (const t of r.exit_txs) {
      exitQuotes['exit'] = (exitQuotes['exit'] || 0) + t.quote_amount;
    }
    // Check the cycle for full quote mint breakdown
    console.log(`  (Quote mint detail available in cycle data, not in receipt)`);
    console.log(`  Total entry quote spent:    ${calcCostBasis.toFixed(6)}`);
    console.log(`  Total exit quote received:  ${calcExitProceeds.toFixed(6)}`);

    // Inspect quote amounts to detect mixed currency patterns
    const entryAmounts = r.entry_txs.map(t => t.quote_amount);
    const smallEntries = entryAmounts.filter(a => a < 100);
    const largeEntries = entryAmounts.filter(a => a >= 100);
    console.log(`  Entry txs < 100 quote:      ${smallEntries.length} (likely SOL-denominated)`);
    console.log(`  Entry txs >= 100 quote:     ${largeEntries.length} (likely USDC-denominated)`);
  }
}

console.log(`\n${'='.repeat(80)}`);
console.log(`INSPECTION COMPLETE — ${receipts.length} receipts audited`);
console.log(`${'='.repeat(80)}`);
