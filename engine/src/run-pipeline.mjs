/**
 * Full Pipeline Runner
 * 
 * Runs: ingest → normalize → reconstruct → pnl → receipts → render
 * for a given wallet address.
 * 
 * Usage: node src/run-pipeline.mjs <wallet> [maxTxns]
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { createCanvas } from 'canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const WALLET = process.argv[2];
if (!WALLET) { console.error('Usage: node src/run-pipeline.mjs <wallet> [maxTxns]'); process.exit(1); }
const MAX_TXNS = parseInt(process.argv[3] || '10000', 10);

console.log(`\n${'='.repeat(60)}`);
console.log(`TRADE ARTIFACT ENGINE — Full Pipeline`);
console.log(`Wallet:  ${WALLET}`);
console.log(`Max txn: ${MAX_TXNS}`);
console.log(`${'='.repeat(60)}`);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
const DUST_ABS = 0.001;
const DUST_PCT = 0.001;
const BASE_URL = 'https://api-mainnet.helius-rpc.com';
const PAGE_SIZE = 100;
const RATE_DELAY_MS = 350;
const RECEIPT_VERSION = '1.0';
const CHAIN = 'solana';
const ACCOUNTING_METHOD = 'weighted_average_cost_basis';

// Load API key
const envPath = resolve(process.env.USERPROFILE, '.openclaw', '.env');
const envContent = readFileSync(envPath, 'utf-8');
const keyMatch = envContent.match(/^HELIUS_API_KEY=(.+)$/m);
if (!keyMatch) { console.error('HELIUS_API_KEY not found'); process.exit(1); }
const API_KEY = keyMatch[1].trim().replace(/^["']|["']$/g, '');

// Ensure directories
for (const d of ['data/raw', 'data/normalized', 'data/cycles', 'data/pnl', 'data/receipts', 'data/renders']) {
  mkdirSync(resolve(ROOT, d), { recursive: true });
}

// ===== PHASE 1: INGEST =====
console.log(`\n--- Phase 1: Ingest ---`);
const rawResponsePath = resolve(ROOT, 'data/raw/helius_raw_response.jsonl');
const txnOutputPath = resolve(ROOT, 'data/raw/helius_transactions.jsonl');
writeFileSync(rawResponsePath, '');
writeFileSync(txnOutputPath, '');

let beforeSig = null;
let totalFetched = 0;
let pageNum = 0;

while (totalFetched < MAX_TXNS) {
  pageNum++;
  const limit = Math.min(PAGE_SIZE, MAX_TXNS - totalFetched);
  let url = `${BASE_URL}/v0/addresses/${WALLET}/transactions?api-key=${API_KEY}&limit=${limit}`;
  if (beforeSig) url += `&before-signature=${beforeSig}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    break;
  }
  const batch = await res.json();
  if (!Array.isArray(batch) || batch.length === 0) { console.log('No more transactions.'); break; }

  appendFileSync(rawResponsePath, JSON.stringify({ page: pageNum, wallet: WALLET, count: batch.length, fetchedAt: new Date().toISOString(), transactions: batch }) + '\n');
  for (const tx of batch) appendFileSync(txnOutputPath, JSON.stringify(tx) + '\n');

  totalFetched += batch.length;
  beforeSig = batch[batch.length - 1].signature;
  process.stdout.write(`  Page ${pageNum}: +${batch.length} (total: ${totalFetched})\r`);

  if (batch.length < limit) break;
  if (totalFetched < MAX_TXNS) await new Promise(r => setTimeout(r, RATE_DELAY_MS));
}
console.log(`\nIngested: ${totalFetched} transactions in ${pageNum} pages`);

// ===== PHASE 2: NORMALIZE =====
console.log(`\n--- Phase 2: Normalize ---`);
const rawLines = readFileSync(txnOutputPath, 'utf-8').trim().split('\n');
const events = [];
let normSkipped = { notSwap: 0, errored: 0, ambiguous: 0 };

for (let i = 0; i < rawLines.length; i++) {
  const tx = JSON.parse(rawLines[i]);
  if (tx.type !== 'SWAP') { normSkipped.notSwap++; continue; }
  if (tx.transactionError) { normSkipped.errored++; continue; }

  let event = null;

  // Primary: events.swap
  if (tx.events?.swap) {
    const sw = tx.events.swap;
    let inMint, inAmt, inDec, outMint, outAmt, outDec;

    if (sw.nativeInput) {
      inMint = SOL_MINT; inDec = 9; inAmt = Number(sw.nativeInput.amount) / 1e9;
    } else if (sw.tokenInputs?.length === 1) {
      const ti = sw.tokenInputs[0];
      inMint = ti.mint; inDec = ti.rawTokenAmount.decimals;
      inAmt = Number(ti.rawTokenAmount.tokenAmount) / Math.pow(10, ti.rawTokenAmount.decimals);
    }

    if (sw.nativeOutput) {
      outMint = SOL_MINT; outDec = 9; outAmt = Number(sw.nativeOutput.amount) / 1e9;
    } else if (sw.tokenOutputs?.length === 1) {
      const to = sw.tokenOutputs[0];
      outMint = to.mint; outDec = to.rawTokenAmount.decimals;
      outAmt = Number(to.rawTokenAmount.tokenAmount) / Math.pow(10, to.rawTokenAmount.decimals);
    }

    if (inMint && outMint) {
      event = { wallet: WALLET, timestamp: tx.timestamp, tx_hash: tx.signature, source: tx.source || 'UNKNOWN',
        token_in_mint: inMint, token_in_amount: inAmt, token_in_decimals: inDec,
        token_out_mint: outMint, token_out_amount: outAmt, token_out_decimals: outDec,
        extraction_method: 'events_swap', raw_index: i };
    }
  }

  // Fallback: tokenTransfers
  if (!event) {
    const sent = (tx.tokenTransfers || []).filter(t => t.fromUserAccount === WALLET);
    const recv = (tx.tokenTransfers || []).filter(t => t.toUserAccount === WALLET);
    if (sent.length === 1 && recv.length === 1 && sent[0].mint !== recv[0].mint) {
      const guessDecimals = (mint) => {
        if (mint === SOL_MINT) return 9;
        for (const ad of (tx.accountData || [])) {
          for (const tbc of (ad.tokenBalanceChanges || [])) {
            if (tbc.mint === mint && tbc.rawTokenAmount?.decimals !== undefined) return tbc.rawTokenAmount.decimals;
          }
        }
        return null;
      };
      event = { wallet: WALLET, timestamp: tx.timestamp, tx_hash: tx.signature, source: tx.source || 'UNKNOWN',
        token_in_mint: sent[0].mint, token_in_amount: sent[0].tokenAmount, token_in_decimals: guessDecimals(sent[0].mint),
        token_out_mint: recv[0].mint, token_out_amount: recv[0].tokenAmount, token_out_decimals: guessDecimals(recv[0].mint),
        extraction_method: 'token_transfers', raw_index: i };
    }
  }

  if (!event) { normSkipped.ambiguous++; continue; }
  events.push(event);
}

events.sort((a, b) => a.timestamp - b.timestamp || a.raw_index - b.raw_index);
const eventsPath = resolve(ROOT, 'data/normalized/events.jsonl');
writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
console.log(`Normalized: ${events.length} swap events (skipped: ${normSkipped.notSwap} non-swap, ${normSkipped.errored} errored, ${normSkipped.ambiguous} ambiguous)`);

// ===== PHASE 3: RECONSTRUCT =====
console.log(`\n--- Phase 3: Reconstruct ---`);
let cycleCounter = 0;
const activeCycles = new Map();
const completedCycles = [];

function isDust(bal, peak) { return bal < Math.max(DUST_ABS, DUST_PCT * peak); }

for (const event of events) {
  const inQ = QUOTE_MINTS.has(event.token_in_mint);
  const outQ = QUOTE_MINTS.has(event.token_out_mint);
  let action, baseMint, quoteAmount, baseAmount, quoteMint;

  if (inQ && !outQ) {
    action = 'buy'; baseMint = event.token_out_mint; baseAmount = event.token_out_amount;
    quoteMint = event.token_in_mint; quoteAmount = event.token_in_amount;
  } else if (!inQ && outQ) {
    action = 'sell'; baseMint = event.token_in_mint; baseAmount = event.token_in_amount;
    quoteMint = event.token_out_mint; quoteAmount = event.token_out_amount;
  } else continue;

  let cycle = activeCycles.get(baseMint);

  if (action === 'buy') {
    if (!cycle) {
      cycleCounter++;
      cycle = { cycle_id: `cycle_${cycleCounter}_${baseMint.slice(0,8)}`, token_mint: baseMint, status: 'open',
        opened_at: event.timestamp, closed_at: null, entry_txs: [], exit_txs: [],
        total_bought: 0, total_sold: 0, peak_position: 0, running_balance: 0 };
      activeCycles.set(baseMint, cycle);
    }
    cycle.entry_txs.push({ tx_hash: event.tx_hash, timestamp: event.timestamp, amount: baseAmount, quote_mint: quoteMint, quote_amount: quoteAmount, raw_index: event.raw_index });
    cycle.total_bought += baseAmount;
    cycle.running_balance += baseAmount;
    cycle.peak_position = Math.max(cycle.peak_position, cycle.running_balance);
  } else {
    if (!cycle) {
      cycleCounter++;
      cycle = { cycle_id: `cycle_${cycleCounter}_${baseMint.slice(0,8)}`, token_mint: baseMint, status: 'partial_history',
        opened_at: event.timestamp, closed_at: null, entry_txs: [], exit_txs: [],
        total_bought: 0, total_sold: 0, peak_position: 0, running_balance: 0 };
      activeCycles.set(baseMint, cycle);
    }
    cycle.exit_txs.push({ tx_hash: event.tx_hash, timestamp: event.timestamp, amount: baseAmount, quote_mint: quoteMint, quote_amount: quoteAmount, raw_index: event.raw_index });
    cycle.total_sold += baseAmount;
    cycle.running_balance -= baseAmount;

    const absBal = Math.abs(cycle.running_balance);
    const effPeak = cycle.peak_position > 0 ? cycle.peak_position : cycle.total_sold;
    if (isDust(absBal, effPeak)) {
      cycle.closed_at = event.timestamp;
      if (cycle.status === 'open') cycle.status = 'closed';
      completedCycles.push(cycle);
      activeCycles.delete(baseMint);
    }
  }
}

const openCycles = [...activeCycles.values()];
for (const c of openCycles) { if (c.running_balance < 0 && c.status === 'open') c.status = 'partial_history'; }
const allCycles = [...completedCycles, ...openCycles].sort((a, b) => a.opened_at - b.opened_at);

const cyclesOutput = allCycles.map(c => ({
  ...c,
  num_buys: c.entry_txs.length, num_sells: c.exit_txs.length,
  total_bought: parseFloat(c.total_bought.toFixed(10)),
  total_sold: parseFloat(c.total_sold.toFixed(10)),
  peak_position: parseFloat(c.peak_position.toFixed(10)),
  remaining_balance: parseFloat(c.running_balance.toFixed(10)),
}));
// Remove running_balance from output (replaced by remaining_balance above)
for (const c of cyclesOutput) delete c.running_balance;

writeFileSync(resolve(ROOT, 'data/cycles/trade_cycles.jsonl'), cyclesOutput.map(c => JSON.stringify(c)).join('\n') + '\n');
const closed = cyclesOutput.filter(c => c.status === 'closed');
const open = cyclesOutput.filter(c => c.status === 'open');
const partial = cyclesOutput.filter(c => c.status === 'partial_history');
console.log(`Cycles: ${cyclesOutput.length} total (${closed.length} closed, ${open.length} open, ${partial.length} partial_history)`);

// ===== PHASE 4: PNL =====
console.log(`\n--- Phase 4: PnL ---`);
const pnlCycles = cyclesOutput.map(c => {
  if (c.status !== 'closed') return { ...c, entry_price_avg: null, exit_price_avg: null, total_cost_basis: null, total_exit_proceeds: null, realized_pnl: null, realized_pnl_pct: null, hold_time_seconds: null, quote_currency: null };

  const allQuotes = [...c.entry_txs.map(t => t.quote_mint), ...c.exit_txs.map(t => t.quote_mint)];
  const uniqueQuotes = [...new Set(allQuotes)];
  const quoteCurrency = uniqueQuotes.length === 1 ? uniqueQuotes[0] : 'MIXED';

  const totalCost = c.entry_txs.reduce((s, t) => s + t.quote_amount, 0);
  const totalProceeds = c.exit_txs.reduce((s, t) => s + t.quote_amount, 0);
  const entryAvg = totalCost / c.total_bought;
  const exitAvg = totalProceeds / c.total_sold;
  const pnl = totalProceeds - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  return { ...c,
    entry_price_avg: parseFloat(entryAvg.toPrecision(12)),
    exit_price_avg: parseFloat(exitAvg.toPrecision(12)),
    total_cost_basis: parseFloat(totalCost.toPrecision(12)),
    total_exit_proceeds: parseFloat(totalProceeds.toPrecision(12)),
    realized_pnl: parseFloat(pnl.toPrecision(12)),
    realized_pnl_pct: parseFloat(pnlPct.toPrecision(6)),
    hold_time_seconds: c.closed_at - c.opened_at,
    quote_currency: quoteCurrency,
  };
});

writeFileSync(resolve(ROOT, 'data/pnl/pnl_cycles.jsonl'), pnlCycles.map(c => JSON.stringify(c)).join('\n') + '\n');
const pnlClosed = pnlCycles.filter(c => c.status === 'closed');
console.log(`PnL computed for ${pnlClosed.length} closed cycles`);

for (const c of pnlClosed) {
  const SYMS = { [SOL_MINT]: 'SOL', [USDC_MINT]: 'USDC', [USDT_MINT]: 'USDT' };
  const qs = SYMS[c.quote_currency] || c.quote_currency?.slice(0,8) || 'MIXED';
  const sign = c.realized_pnl >= 0 ? '+' : '';
  console.log(`  ${c.cycle_id}: ${sign}${c.realized_pnl_pct}% (${sign}${c.realized_pnl?.toFixed?.(6) || c.realized_pnl} ${qs}) | ${c.num_buys}b/${c.num_sells}s | ${((c.hold_time_seconds||0)/60).toFixed(1)}min`);
}

// ===== PHASE 5: RECEIPTS =====
console.log(`\n--- Phase 5: Receipts ---`);
const receipts = pnlClosed.map((c, i) => {
  const r = {
    receipt_id: `receipt_${String(i + 1).padStart(4, '0')}_${c.token_mint.slice(0, 8)}`,
    receipt_version: RECEIPT_VERSION, cycle_id: c.cycle_id, wallet: WALLET, chain: CHAIN,
    token_mint: c.token_mint, status: 'verified', accounting_method: ACCOUNTING_METHOD,
    avg_entry_price: c.entry_price_avg, avg_exit_price: c.exit_price_avg,
    quote_currency: c.quote_currency,
    total_cost_basis: c.total_cost_basis, total_exit_proceeds: c.total_exit_proceeds,
    realized_pnl: c.realized_pnl, realized_pnl_pct: c.realized_pnl_pct,
    total_bought: c.total_bought, total_sold: c.total_sold,
    peak_position: c.peak_position, remaining_balance: c.remaining_balance,
    num_buys: c.num_buys, num_sells: c.num_sells,
    opened_at: c.opened_at, closed_at: c.closed_at, hold_time_seconds: c.hold_time_seconds,
    entry_txs: c.entry_txs.map(t => ({ tx_hash: t.tx_hash, timestamp: t.timestamp, amount: t.amount, quote_amount: t.quote_amount })),
    exit_txs: c.exit_txs.map(t => ({ tx_hash: t.tx_hash, timestamp: t.timestamp, amount: t.amount, quote_amount: t.quote_amount })),
    generated_at: Math.floor(Date.now() / 1000),
    verification_hash: null,
  };
  const entryH = r.entry_txs.map(t => t.tx_hash).sort();
  const exitH = r.exit_txs.map(t => t.tx_hash).sort();
  r.verification_hash = createHash('sha256').update(JSON.stringify([
    r.wallet, r.chain, r.token_mint, entryH, exitH, r.avg_entry_price, r.avg_exit_price, r.accounting_method, r.receipt_version
  ])).digest('hex');
  return r;
});

writeFileSync(resolve(ROOT, 'data/receipts/receipts.jsonl'), receipts.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`Receipts generated: ${receipts.length}`);

// ===== PHASE 6: RENDER =====
console.log(`\n--- Phase 6: Render ---`);

const SYMBOLS = { [SOL_MINT]: 'SOL', [USDC_MINT]: 'USDC', [USDT_MINT]: 'USDT' };
function sym(mint) { return SYMBOLS[mint] || mint.slice(0, 8) + '...'; }
function shortW(a) { return a.slice(0,6)+'...'+a.slice(-4); }
function fmtHold(s) { return s < 60 ? `${s}s` : s < 3600 ? `${(s/60).toFixed(1)} min` : s < 86400 ? `${(s/3600).toFixed(1)} hrs` : `${(s/86400).toFixed(1)} days`; }
function fmtPrice(p, q) { return p < 0.0001 ? `${p.toExponential(4)} ${q}` : p < 1 ? `${p.toFixed(6)} ${q}` : `${p.toFixed(4)} ${q}`; }
function fmtPnl(v, q) { const s = v>=0?'+':''; return Math.abs(v)<0.0001 ? `${s}${v.toExponential(3)} ${q}` : `${s}${v.toFixed(6)} ${q}`; }
function fmtDate(ts) { return new Date(ts*1000).toISOString().replace('T',' ').replace(/\.\d+Z/,' UTC'); }
function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();}
function drawStat(ctx,x,y,label,value){ctx.fillStyle='#8899a6';ctx.font='400 12px "Segoe UI", Arial, sans-serif';ctx.fillText(label,x,y);ctx.fillStyle='#e1e8ed';ctx.font='600 16px "Segoe UI", Arial, sans-serif';ctx.fillText(value,x,y+20);}

for (const r of receipts) {
  const W=800,H=520,canvas=createCanvas(W,H),ctx=canvas.getContext('2d');
  const tSym=sym(r.token_mint),qSym=sym(r.quote_currency),isProfit=r.realized_pnl>=0;
  const grad=ctx.createLinearGradient(0,0,0,H);grad.addColorStop(0,'#0f1419');grad.addColorStop(1,'#1a1f2e');
  ctx.fillStyle=grad;roundRect(ctx,0,0,W,H,16);ctx.fill();
  ctx.strokeStyle=isProfit?'#00c07640':'#ff4d4d40';ctx.lineWidth=2;roundRect(ctx,1,1,W-2,H-2,16);ctx.stroke();
  let y=40;
  ctx.fillStyle='#8899a6';ctx.font='600 13px "Segoe UI", Arial, sans-serif';ctx.fillText('TRADE RECEIPT',32,y);
  ctx.fillStyle='#00c076';ctx.font='600 13px "Segoe UI", Arial, sans-serif';
  const st=`● ${r.status.toUpperCase()}`;ctx.fillText(st,W-32-ctx.measureText(st).width,y);
  y+=44;ctx.fillStyle='#ffffff';ctx.font='700 36px "Segoe UI", Arial, sans-serif';ctx.fillText(`${tSym} / ${qSym}`,32,y);
  y+=28;ctx.fillStyle='#8899a6';ctx.font='400 14px "Segoe UI", Arial, sans-serif';ctx.fillText(`${r.chain.toUpperCase()}  •  ${shortW(r.wallet)}`,32,y);
  y+=20;ctx.strokeStyle='#2a3040';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(32,y);ctx.lineTo(W-32,y);ctx.stroke();
  y+=48;const pc=isProfit?'#00c076':'#ff4d4d',ps=isProfit?'+':'';
  ctx.fillStyle=pc;ctx.font='700 48px "Segoe UI", Arial, sans-serif';ctx.fillText(`${ps}${r.realized_pnl_pct.toFixed(3)}%`,32,y);
  y+=30;ctx.fillStyle=pc;ctx.font='400 18px "Segoe UI", Arial, sans-serif';ctx.fillText(fmtPnl(r.realized_pnl,qSym),32,y);
  y+=44;const c1=32,c2=W/2+16,rh=52;
  drawStat(ctx,c1,y,'Avg Entry Price',fmtPrice(r.avg_entry_price,qSym));
  drawStat(ctx,c2,y,'Avg Exit Price',fmtPrice(r.avg_exit_price,qSym));
  y+=rh;drawStat(ctx,c1,y,'Cost Basis',`${r.total_cost_basis.toFixed(6)} ${qSym}`);
  drawStat(ctx,c2,y,'Exit Proceeds',`${r.total_exit_proceeds.toFixed(6)} ${qSym}`);
  y+=rh;drawStat(ctx,c1,y,'Hold Time',fmtHold(r.hold_time_seconds));
  const bL=r.num_buys===1?'buy':'buys',sL=r.num_sells===1?'sell':'sells';
  drawStat(ctx,c2,y,'Trades',`${r.num_buys} ${bL} / ${r.num_sells} ${sL}`);
  y+=rh+10;ctx.strokeStyle='#2a3040';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(32,y);ctx.lineTo(W-32,y);ctx.stroke();
  y+=24;ctx.fillStyle='#556677';ctx.font='400 12px "Consolas", "Courier New", monospace';
  ctx.fillText(`${r.receipt_id}  •  hash: ${r.verification_hash.slice(0,12)}...`,32,y);
  y+=18;ctx.fillText(`${fmtDate(r.opened_at)} → ${fmtDate(r.closed_at)}`,32,y);
  const fn=`${r.receipt_id}.png`;
  writeFileSync(resolve(ROOT,'data/renders',fn),canvas.toBuffer('image/png'));
  console.log(`  Rendered: ${fn}`);
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(60)}`);
console.log(`PIPELINE COMPLETE`);
console.log(`${'='.repeat(60)}`);
console.log(`Wallet:              ${WALLET}`);
console.log(`Transactions:        ${totalFetched}`);
console.log(`Swap events:         ${events.length}`);
console.log(`Trade cycles:        ${cyclesOutput.length} (${closed.length} closed, ${open.length} open, ${partial.length} partial)`);
console.log(`Receipts:            ${receipts.length}`);
console.log(`PNGs:                ${receipts.length}`);
