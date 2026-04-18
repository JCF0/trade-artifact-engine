#!/usr/bin/env node
/**
 * debug-position.mjs — Per-Leg Audit for a Single Position
 *
 * Prints the exact values used in PnL calculation for each leg,
 * then the position summary with the formula.
 *
 * Usage:
 *   node src/debug-position.mjs <wallet> [--token <mint>] [--position-id <id>]
 *
 * Requires HELIUS_API_KEY in ~/.openclaw/.env
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fetchTransactions, normalizeTransactions } from './pipeline/ingest.mjs';
import { reconstructCycles } from './pipeline/reconstruct.mjs';
import { buildPositions } from './position/position-builder.mjs';
import { QUOTE_MINTS, SYMS } from './pipeline/constants.mjs';

// ── Load API key ──
const envPath = resolve(process.env.USERPROFILE || process.env.HOME, '.openclaw', '.env');
let API_KEY = '';
try {
  const envContent = readFileSync(envPath, 'utf-8');
  const match = envContent.match(/^HELIUS_API_KEY=(.+)$/m);
  if (match) API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
} catch {}

if (!API_KEY) { console.error('HELIUS_API_KEY not found'); process.exit(1); }

// ── Parse args ──
const args = process.argv.slice(2);
const wallet = args[0];
if (!wallet) { console.error('Usage: node src/debug-position.mjs <wallet> [--token <mint>] [--position-id <id>]'); process.exit(1); }

const tokenIdx = args.indexOf('--token');
const tokenFilter = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
const posIdIdx = args.indexOf('--position-id');
const posIdFilter = posIdIdx !== -1 ? args[posIdIdx + 1] : undefined;
const maxTxnsIdx = args.indexOf('--max-txns');
const maxTxns = maxTxnsIdx !== -1 ? parseInt(args[maxTxnsIdx + 1]) : 5000;

console.log(`\n╔════════════════════════════════════════════════════════════╗`);
console.log(`║  Position Debug — Per-Leg Audit                          ║`);
console.log(`╚════════════════════════════════════════════════════════════╝`);
console.log(`  Wallet:   ${wallet}`);
if (tokenFilter) console.log(`  Token:    ${tokenFilter}`);
if (posIdFilter) console.log(`  Position: ${posIdFilter}`);
console.log();

// ── Run pipeline ──
console.log(`── Phase 1: Ingest ──`);
const rawTxns = await fetchTransactions(wallet, API_KEY, { maxTxns, silent: false });
if (rawTxns.length === 0) { console.error('No transactions found'); process.exit(1); }

console.log(`\n── Phase 2: Normalize ──`);
const { events } = normalizeTransactions(rawTxns, wallet, { silent: false });
if (events.length === 0) { console.error('No swap events found'); process.exit(1); }

// Print all normalized events for debug
console.log(`\n── All Normalized Events (${events.length}) ──`);
for (const ev of events) {
  const inIsQuote = QUOTE_MINTS.has(ev.token_in_mint);
  const outIsQuote = QUOTE_MINTS.has(ev.token_out_mint);
  let action = '???';
  if (inIsQuote && !outIsQuote) action = 'BUY';
  else if (!inIsQuote && outIsQuote) action = 'SELL';

  const inSym = SYMS[ev.token_in_mint] || ev.token_in_mint.slice(0, 8);
  const outSym = SYMS[ev.token_out_mint] || ev.token_out_mint.slice(0, 8);

  console.log(`  ${ev.tx_hash.slice(0, 16)}  ${action.padEnd(5)} ${ev.token_in_amount} ${inSym} → ${ev.token_out_amount} ${outSym}`);
  console.log(`    in_mint:  ${ev.token_in_mint}`);
  console.log(`    out_mint: ${ev.token_out_mint}`);
  console.log(`    in_dec:   ${ev.token_in_decimals}   out_dec: ${ev.token_out_decimals}`);
  console.log(`    method:   ${ev.extraction_method}`);
  console.log();
}

console.log(`── Phase 3: Reconstruct ──`);
const { cycles, stats } = reconstructCycles(events);
console.log(`  ${stats.total} cycles (${stats.closed} closed, ${stats.open} open, ${stats.partial} partial)`);

// Show cycle details before position building
console.log(`\n── Cycle Details ──`);
for (const c of cycles) {
  const tokenMint = c.base_mint;
  const tokenSym = SYMS[tokenMint] || tokenMint.slice(0, 8);
  console.log(`  ${c.cycle_id} [${c.status}] token=${tokenSym}`);
  for (const e of c.entry_txs) {
    console.log(`    BUY   amount=${e.amount}  quote_amount=${e.quote_amount}  quote_mint=${SYMS[e.quote_mint] || e.quote_mint.slice(0, 8)}  price=${e.quote_amount / e.amount}  tx=${e.tx_hash.slice(0, 16)}`);
  }
  for (const e of c.exit_txs) {
    console.log(`    SELL  amount=${e.amount}  quote_amount=${e.quote_amount}  quote_mint=${SYMS[e.quote_mint] || e.quote_mint.slice(0, 8)}  price=${e.quote_amount / e.amount}  tx=${e.tx_hash.slice(0, 16)}`);
  }
  console.log(`    running_balance=${c.running_balance}  peak=${c.peak_position}`);
  console.log();
}

console.log(`── Phase 4: Build Positions ──`);
const positions = buildPositions(cycles, { wallet, token: tokenFilter });
console.log(`  ${positions.length} position(s)`);

if (positions.length === 0) {
  console.error('\n⚠️  No positions found. Check token filter.');
  process.exit(1);
}

// Select position
let selected;
if (posIdFilter) {
  selected = positions.find(p => p.position_id === posIdFilter || p.position_id.startsWith(posIdFilter));
  if (!selected) {
    console.error(`\n⚠️  No position matching: ${posIdFilter}`);
    console.log('  Available:');
    for (const p of positions) console.log(`    ${p.position_id.slice(0, 20)}  ${p.token.slice(0, 8)}  ${p.realized_pnl_pct}%`);
    process.exit(1);
  }
} else if (positions.length === 1) {
  selected = positions[0];
} else {
  console.log('\n  Multiple positions — select with --position-id:');
  for (const p of positions) console.log(`    ${p.position_id.slice(0, 20)}  ${p.token.slice(0, 8)}  ${p.realized_pnl_pct}%`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
// Per-Leg Audit
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`  POSITION AUDIT: ${selected.position_id}`);
console.log(`  Token: ${selected.token}`);
console.log(`${'═'.repeat(60)}\n`);

console.log(`── Per-Leg Breakdown ──\n`);

const hdr = [
  'tx_hash'.padEnd(18),
  'side'.padEnd(5),
  'base_amount'.padEnd(16),
  'quote_amount'.padEnd(16),
  'price (q/b)'.padEnd(18),
  'quote_mint',
].join(' │ ');
console.log(`  ${hdr}`);
console.log(`  ${'─'.repeat(hdr.length)}`);

// We need to audit using the exact same values the position builder uses
// The PB uses entry.amount and entry.quote_amount from the cycle legs
let auditCostBasis = 0;
let auditProceeds = 0;
let auditTotalBought = 0;
let auditTotalSold = 0;

for (const leg of selected.legs) {
  const side = leg.action.toUpperCase();
  const price = leg.amount > 0 ? leg.quote_amount / leg.amount : 0;
  const quoteSym = SYMS[leg.quote_mint] || leg.quote_mint?.slice(0, 8) || 'N/A';

  if (leg.action === 'buy') {
    auditCostBasis += leg.quote_amount;
    auditTotalBought += leg.amount;
  } else {
    auditProceeds += leg.quote_amount;
    auditTotalSold += leg.amount;
  }

  const row = [
    leg.tx_hash.slice(0, 16).padEnd(18),
    side.padEnd(5),
    leg.amount.toString().padEnd(16),
    leg.quote_amount.toString().padEnd(16),
    price.toPrecision(12).padEnd(18),
    quoteSym,
  ].join(' │ ');
  console.log(`  ${row}`);
}

console.log();

// Extended per-leg detail (raw values from the normalized events)
console.log(`── Extended Leg Detail (raw event values) ──\n`);
for (const leg of selected.legs) {
  // Find the original normalized event
  const origEvent = events.find(e => e.tx_hash === leg.tx_hash);
  const price = leg.amount > 0 ? leg.quote_amount / leg.amount : 0;

  console.log(`  Tx:      ${leg.tx_hash}`);
  console.log(`  Side:    ${leg.action.toUpperCase()}`);
  console.log(`  ── Values used in PnL (from cycle/position builder) ──`);
  console.log(`    base_amount (token):  ${leg.amount}`);
  console.log(`    quote_amount:         ${leg.quote_amount}`);
  console.log(`    computed price:       ${price}  (quote_amount / base_amount)`);
  console.log(`    price direction:      quote/token (how much quote per 1 token)`);

  if (origEvent) {
    console.log(`  ── Raw normalized event ──`);
    console.log(`    token_in_mint:    ${origEvent.token_in_mint}`);
    console.log(`    token_in_amount:  ${origEvent.token_in_amount}`);
    console.log(`    token_in_dec:     ${origEvent.token_in_decimals}`);
    console.log(`    token_out_mint:   ${origEvent.token_out_mint}`);
    console.log(`    token_out_amount: ${origEvent.token_out_amount}`);
    console.log(`    token_out_dec:    ${origEvent.token_out_decimals}`);
    console.log(`    extraction:       ${origEvent.extraction_method}`);
  } else {
    console.log(`  ── (no matching normalized event found) ──`);
  }
  console.log();
}

// ═══════════════════════════════════════════════════════════════
// Position Summary (using exact same math as position-builder)
// ═══════════════════════════════════════════════════════════════

const auditAvgEntry = auditTotalBought > 0 ? auditCostBasis / auditTotalBought : 0;
const auditAvgExit = auditTotalSold > 0 ? auditProceeds / auditTotalSold : 0;
const auditRealizedPnl = auditProceeds - auditCostBasis;
const auditRealizedPnlPct = auditCostBasis > 0 ? (auditRealizedPnl / auditCostBasis) * 100 : 0;

console.log(`── Position Summary (audit re-derivation) ──\n`);
console.log(`  Total tokens bought:     ${auditTotalBought}`);
console.log(`  Total tokens sold:       ${auditTotalSold}`);
console.log(`  Total cost basis:        ${auditCostBasis}  (sum of buy quote_amounts)`);
console.log(`  Total proceeds:          ${auditProceeds}  (sum of sell quote_amounts)`);
console.log(`  Weighted avg entry:      ${auditAvgEntry}  (cost_basis / total_bought)`);
console.log(`  Weighted avg exit:       ${auditAvgExit}  (proceeds / total_sold)`);
console.log(`  Realized PnL (abs):      ${auditRealizedPnl}  (proceeds - cost_basis)`);
console.log(`  Realized PnL (%):        ${auditRealizedPnlPct}%  ((proceeds - cost_basis) / cost_basis * 100)`);

console.log(`\n── Cross-check vs position-builder output ──\n`);
console.log(`                         Audit            Position-Builder`);
console.log(`  avg_entry:         ${auditAvgEntry.toPrecision(12).padEnd(20)} ${selected.avg_entry}`);
console.log(`  avg_exit:          ${auditAvgExit.toPrecision(12).padEnd(20)} ${selected.avg_exit}`);
console.log(`  realized_pnl:     ${auditRealizedPnl.toPrecision(12).padEnd(20)} ${selected.realized_pnl}`);
console.log(`  realized_pnl_pct: ${auditRealizedPnlPct.toPrecision(6).padEnd(20)} ${selected.realized_pnl_pct}`);
console.log(`  total_bought:     ${auditTotalBought.toFixed(10).padEnd(20)} ${selected.total_bought}`);
console.log(`  total_sold:       ${auditTotalSold.toFixed(10).padEnd(20)} ${selected.total_sold}`);

const match = (
  auditAvgEntry.toPrecision(12) === selected.avg_entry.toPrecision(12) &&
  auditAvgExit.toPrecision(12) === selected.avg_exit.toPrecision(12) &&
  auditRealizedPnlPct.toPrecision(6) === selected.realized_pnl_pct.toPrecision(6)
);
console.log(`\n  Match: ${match ? '✅ EXACT' : '❌ MISMATCH'}`);

console.log(`\n── Formula ──`);
console.log(`  PnL formula: WACB (Weighted Average Cost Basis)`);
console.log(`  cost_basis   = Σ(buy_quote_amount)     = ${auditCostBasis}`);
console.log(`  proceeds     = Σ(sell_quote_amount)     = ${auditProceeds}`);
console.log(`  avg_entry    = cost_basis / total_bought = ${auditCostBasis} / ${auditTotalBought} = ${auditAvgEntry}`);
console.log(`  avg_exit     = proceeds / total_sold     = ${auditProceeds} / ${auditTotalSold} = ${auditAvgExit}`);
console.log(`  realized_pnl = proceeds - cost_basis     = ${auditProceeds} - ${auditCostBasis} = ${auditRealizedPnl}`);
console.log(`  pnl_pct      = realized_pnl / cost_basis = ${auditRealizedPnl} / ${auditCostBasis} = ${auditRealizedPnlPct}%`);
console.log();
