/**
 * Full Pipeline Runner
 * 
 * Runs: ingest → normalize → reconstruct → pnl → receipts → render [→ claim]
 * for a given wallet address.
 * 
 * Usage: node src/run-pipeline.mjs <wallet> [maxTxns] [--keypair <path>] [--recipient <pubkey>]
 *
 * If --keypair is provided, Phase 7 (claim signing) runs after render.
 * If --recipient is omitted, claims are self-addressed (trader = recipient).
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { createCanvas } from 'canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Args (positional + flags)
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);

// Extract flags
function getFlag(name) {
  const idx = rawArgs.indexOf(name);
  if (idx === -1 || idx + 1 >= rawArgs.length) return null;
  return rawArgs[idx + 1];
}
const KEYPAIR_PATH = getFlag('--keypair');
const RECIPIENT_OVERRIDE = getFlag('--recipient');

// Positional args (skip flags and their values)
const flagNames = new Set(['--keypair', '--recipient']);
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (flagNames.has(rawArgs[i])) { i++; continue; } // skip flag + value
  positional.push(rawArgs[i]);
}

const WALLET = positional[0];
if (!WALLET) {
  console.error('Usage: node src/run-pipeline.mjs <wallet> [maxTxns] [--keypair <path>] [--recipient <pubkey>]');
  process.exit(1);
}
const MAX_TXNS = parseInt(positional[1] || '10000', 10);

console.log(`\n${'='.repeat(60)}`);
console.log(`TRADE ARTIFACT ENGINE — Full Pipeline`);
console.log(`Wallet:  ${WALLET}`);
console.log(`Max txn: ${MAX_TXNS}`);
if (KEYPAIR_PATH) console.log(`Keypair: ${KEYPAIR_PATH}`);
if (RECIPIENT_OVERRIDE) console.log(`Recipient: ${RECIPIENT_OVERRIDE}`);
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
  const receipt_status = quoteCurrency === 'MIXED' ? 'verified_mixed_quote' : 'verified';

  return { ...c,
    receipt_status,
    entry_price_avg: parseFloat(entryAvg.toPrecision(12)),
    exit_price_avg: parseFloat(exitAvg.toPrecision(12)),
    total_cost_basis: parseFloat(totalCost.toPrecision(12)),
    total_exit_proceeds: parseFloat(totalProceeds.toPrecision(12)),
    realized_pnl: parseFloat(pnl.toPrecision(12)),
    realized_pnl_pct: parseFloat(pnlPct.toPrecision(6)),
    hold_time_seconds: c.closed_at - c.opened_at,
    quote_currency: quoteCurrency,
    // Raw doubles for verification hash — no display rounding applied
    _raw_entry_price_avg: entryAvg,
    _raw_exit_price_avg: exitAvg,
  };
});

writeFileSync(resolve(ROOT, 'data/pnl/pnl_cycles.jsonl'), pnlCycles.map(c => JSON.stringify(c)).join('\n') + '\n');
const pnlClosed = pnlCycles.filter(c => c.status === 'closed' && c.receipt_status);
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
  const entryTxs = c.entry_txs.map(t => ({ tx_hash: t.tx_hash, timestamp: t.timestamp, amount: t.amount, quote_amount: t.quote_amount }));
  const exitTxs = c.exit_txs.map(t => ({ tx_hash: t.tx_hash, timestamp: t.timestamp, amount: t.amount, quote_amount: t.quote_amount }));
  const entryH = entryTxs.map(t => t.tx_hash).sort();
  const exitH = exitTxs.map(t => t.tx_hash).sort();

  // Use raw doubles for verification hash (frozen spec: no display rounding in hash)
  const rawEntryAvg = c._raw_entry_price_avg;
  const rawExitAvg = c._raw_exit_price_avg;

  const verificationHash = createHash('sha256').update(JSON.stringify([
    WALLET, CHAIN, c.token_mint, entryH, exitH,
    rawEntryAvg, rawExitAvg,
    ACCOUNTING_METHOD, RECEIPT_VERSION,
    c.receipt_status,  // frozen spec: status is part of verification hash
  ])).digest('hex');

  return {
    receipt_id: `receipt_${String(i + 1).padStart(4, '0')}_${c.token_mint.slice(0, 8)}`,
    receipt_version: RECEIPT_VERSION, cycle_id: c.cycle_id, wallet: WALLET, chain: CHAIN,
    token_mint: c.token_mint, status: c.receipt_status, accounting_method: ACCOUNTING_METHOD,
    avg_entry_price: c.entry_price_avg, avg_exit_price: c.exit_price_avg,
    quote_currency: c.quote_currency,
    total_cost_basis: c.total_cost_basis, total_exit_proceeds: c.total_exit_proceeds,
    realized_pnl: c.realized_pnl, realized_pnl_pct: c.realized_pnl_pct,
    total_bought: c.total_bought, total_sold: c.total_sold,
    peak_position: c.peak_position, remaining_balance: c.remaining_balance,
    num_buys: c.num_buys, num_sells: c.num_sells,
    opened_at: c.opened_at, closed_at: c.closed_at, hold_time_seconds: c.hold_time_seconds,
    entry_txs: entryTxs, exit_txs: exitTxs,
    _hash_inputs: { raw_entry_price_avg: rawEntryAvg, raw_exit_price_avg: rawExitAvg },
    generated_at: Math.floor(Date.now() / 1000),
    verification_hash: verificationHash,
  };
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

// ===== PHASE 7: CLAIM SIGNING (optional) =====
let claimCount = 0;
if (KEYPAIR_PATH && receipts.length > 0) {
  console.log(`\n--- Phase 7: Claim Signing ---`);

  // Dynamic imports for claim signing deps (only loaded when needed)
  const nacl = (await import('tweetnacl')).default;
  const bs58 = (await import('bs58')).default;
  const { Keypair, PublicKey } = await import('@solana/web3.js');

  let keypair;
  try {
    const keypairBytes = new Uint8Array(JSON.parse(readFileSync(resolve(KEYPAIR_PATH), 'utf-8')));
    keypair = Keypair.fromSecretKey(keypairBytes);
  } catch (e) {
    console.error(`  ERROR: Failed to load keypair from ${KEYPAIR_PATH}: ${e.message}`);
    console.log('  Skipping claim signing.');
    keypair = null;
  }

  if (keypair) {
    const signerWallet = keypair.publicKey.toBase58();
    let recipientPubkey = signerWallet; // default: self-addressed

    if (RECIPIENT_OVERRIDE) {
      try {
        new PublicKey(RECIPIENT_OVERRIDE);
        recipientPubkey = RECIPIENT_OVERRIDE;
      } catch {
        console.error(`  ERROR: Invalid --recipient pubkey: ${RECIPIENT_OVERRIDE}`);
        console.log('  Falling back to self-addressed claims.');
      }
    }

    console.log(`  Signer:    ${signerWallet}`);
    console.log(`  Recipient: ${recipientPubkey}`);

    const claimsDir = resolve(ROOT, 'data/claims');
    mkdirSync(claimsDir, { recursive: true });

    const claims = [];
    let skipped = 0;

    for (const receipt of receipts) {
      if (receipt.wallet !== signerWallet) {
        skipped++;
        continue;
      }

      const claimMessage = `TRADE_RECEIPT_CLAIM_V1\nreceipt:${receipt.verification_hash}\nwallet:${receipt.wallet}\nchain:${receipt.chain}\nclaim_recipient:${recipientPubkey}`;
      const messageBytes = new TextEncoder().encode(claimMessage);
      const signature = nacl.sign.detached(messageBytes, keypair.secretKey);

      // Self-verify
      const verified = nacl.sign.detached.verify(messageBytes, signature, keypair.publicKey.toBytes());
      if (!verified) {
        console.error(`  FATAL: Self-verification failed for ${receipt.receipt_id}`);
        process.exit(1);
      }

      claims.push({
        claim_version: '1.0',
        receipt_id: receipt.receipt_id,
        verification_hash: receipt.verification_hash,
        wallet: receipt.wallet,
        chain: receipt.chain,
        claim_recipient: recipientPubkey,
        signature_bs58: bs58.encode(signature),
        signature_hex: Buffer.from(signature).toString('hex'),
        signed_message: claimMessage,
        claimed_at: Math.floor(Date.now() / 1000),
      });
    }

    if (claims.length > 0) {
      writeFileSync(resolve(claimsDir, 'claims.jsonl'), claims.map(c => JSON.stringify(c)).join('\n') + '\n');
    }
    claimCount = claims.length;
    console.log(`  Claims signed: ${claimCount} (skipped: ${skipped} wallet mismatch)`);
  }
} else if (!KEYPAIR_PATH && receipts.length > 0) {
  console.log(`\n--- Phase 7: Claim Signing --- SKIPPED (no --keypair)`);
}

// ===== PHASE 8: ARWEAVE UPLOAD (optional) =====
let uploadCount = 0;
const uploadsMap = new Map();  // verification_hash → upload record (for Phase 9)
if (KEYPAIR_PATH && receipts.length > 0) {
  console.log(`\n--- Phase 8: Arweave Upload ---`);

  const { Uploader } = await import('@irys/upload');
  const { Solana } = await import('@irys/upload-solana');

  const GATEWAY_BASE = 'https://gateway.irys.xyz';
  const rpcUrl = 'https://api.devnet.solana.com'; // TODO: parameterize for mainnet

  try {
    const keypairBytes = JSON.parse(readFileSync(resolve(KEYPAIR_PATH), 'utf-8'));
    let irysBuilder = Uploader(Solana)
      .withWallet(Buffer.from(keypairBytes))
      .withRpc(rpcUrl)
      .devnet();
    const irys = await irysBuilder;
    console.log(`  Irys URL: ${irys.url}`);

    const arweaveDir = resolve(ROOT, 'data/arweave');
    mkdirSync(arweaveDir, { recursive: true });
    const uploadsPath = resolve(arweaveDir, 'uploads.jsonl');

    // Load existing uploads for idempotency
    if (existsSync(uploadsPath)) {
      const lines = readFileSync(uploadsPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const l of lines) {
        const u = JSON.parse(l);
        uploadsMap.set(u.verification_hash, u);
      }
      console.log(`  Existing uploads: ${uploadsMap.size}`);
    }

    const SOL_MINT_S = 'So11111111111111111111111111111111111111112';
    const USDC_MINT_S = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDT_MINT_S = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const SYMS = { [SOL_MINT_S]: 'SOL', [USDC_MINT_S]: 'USDC', [USDT_MINT_S]: 'USDT' };

    const newUploads = [];

    for (const receipt of receipts) {
      if (uploadsMap.has(receipt.verification_hash)) {
        console.log(`  ⏭️  SKIP ${receipt.receipt_id}: already uploaded`);
        continue;
      }

      const pngPath = resolve(ROOT, 'data/renders', `${receipt.receipt_id}.png`);
      if (!existsSync(pngPath)) {
        console.log(`  ⚠️  SKIP ${receipt.receipt_id}: no PNG`);
        continue;
      }

      console.log(`  📤 ${receipt.receipt_id}...`);

      // Upload PNG
      const pngResult = await irys.uploadFile(pngPath, { tags: [
        { name: 'Content-Type', value: 'image/png' },
        { name: 'App-Name', value: 'trade-artifact-engine' },
        { name: 'Receipt-Id', value: receipt.receipt_id },
        { name: 'Verification-Hash', value: receipt.verification_hash },
      ]});
      const pngUri = `${GATEWAY_BASE}/${pngResult.id}`;

      // Upload receipt JSON
      const receiptJsonStr = JSON.stringify(receipt, null, 2);
      const tmpReceiptPath = resolve(arweaveDir, `_tmp_${receipt.receipt_id}.json`);
      writeFileSync(tmpReceiptPath, receiptJsonStr);
      const receiptJsonResult = await irys.uploadFile(tmpReceiptPath, { tags: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'App-Name', value: 'trade-artifact-engine' },
        { name: 'File-Type', value: 'receipt-data' },
        { name: 'Verification-Hash', value: receipt.verification_hash },
      ]});
      const receiptJsonUri = `${GATEWAY_BASE}/${receiptJsonResult.id}`;

      // Build + upload NFT metadata
      const tokenShort = receipt.token_mint.slice(0, 8);
      const qSym = SYMS[receipt.quote_currency] || (receipt.quote_currency === 'MIXED' ? 'MIXED' : receipt.quote_currency?.slice(0, 8));
      const nftMetadata = {
        name: `Trade Receipt ${receipt.receipt_id.replace('receipt_', '#').replace(/_/g, ' ')}`,
        symbol: 'TREC',
        description: `Verified trade receipt: ${tokenShort} / ${qSym} on Solana. PnL: ${receipt.realized_pnl_pct >= 0 ? '+' : ''}${receipt.realized_pnl_pct}%`,
        image: pngUri,
        external_url: receiptJsonUri,
        attributes: [
          { trait_type: 'wallet', value: receipt.wallet },
          { trait_type: 'token_mint', value: receipt.token_mint },
          { trait_type: 'chain', value: receipt.chain },
          { trait_type: 'realized_pnl_pct', value: receipt.realized_pnl_pct, display_type: 'number' },
          { trait_type: 'status', value: receipt.status },
          { trait_type: 'quote_currency', value: qSym },
          { trait_type: 'hold_time_seconds', value: receipt.hold_time_seconds, display_type: 'number' },
          { trait_type: 'num_buys', value: receipt.num_buys, display_type: 'number' },
          { trait_type: 'num_sells', value: receipt.num_sells, display_type: 'number' },
          { trait_type: 'opened_at', value: receipt.opened_at, display_type: 'date' },
          { trait_type: 'closed_at', value: receipt.closed_at, display_type: 'date' },
        ],
        properties: {
          receipt_version: receipt.receipt_version,
          verification_hash: receipt.verification_hash,
          accounting_method: receipt.accounting_method,
          receipt_json: receiptJsonUri,
        },
      };
      const metadataStr = JSON.stringify(nftMetadata, null, 2);
      const metadataHash = createHash('sha256').update(metadataStr).digest('hex');

      const tmpMetaPath = resolve(arweaveDir, `_tmp_${receipt.receipt_id}_meta.json`);
      writeFileSync(tmpMetaPath, metadataStr);
      const metaResult = await irys.uploadFile(tmpMetaPath, { tags: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'App-Name', value: 'trade-artifact-engine' },
        { name: 'File-Type', value: 'nft-metadata' },
        { name: 'Verification-Hash', value: receipt.verification_hash },
        { name: 'Metadata-Hash', value: metadataHash },
      ]});
      const metadataUri = `${GATEWAY_BASE}/${metaResult.id}`;

      // Clean up temp files
      try { (await import('fs')).unlinkSync(tmpReceiptPath); } catch {}
      try { (await import('fs')).unlinkSync(tmpMetaPath); } catch {}

      const uploadRecord = {
        receipt_id: receipt.receipt_id,
        verification_hash: receipt.verification_hash,
        png_irys_id: pngResult.id, png_uri: pngUri,
        receipt_json_irys_id: receiptJsonResult.id, receipt_json_uri: receiptJsonUri,
        metadata_json_irys_id: metaResult.id, metadata_uri: metadataUri,
        metadata_hash: metadataHash,
        uploaded_at: Math.floor(Date.now() / 1000), network: 'devnet',
      };
      newUploads.push(uploadRecord);
      uploadsMap.set(receipt.verification_hash, uploadRecord);
      console.log(`     ✅ ${metadataUri}`);
    }

    if (newUploads.length > 0) {
      const existing = existsSync(uploadsPath) ? readFileSync(uploadsPath, 'utf-8') : '';
      writeFileSync(uploadsPath, existing + newUploads.map(u => JSON.stringify(u)).join('\n') + '\n');
    }
    uploadCount = newUploads.length;
    console.log(`  Uploads: ${uploadCount} new, ${uploadsMap.size - uploadCount} existing`);
  } catch (e) {
    console.error(`  ERROR: Arweave upload failed: ${e.message}`);
    console.log('  Continuing without uploads.');
  }
} else if (!KEYPAIR_PATH && receipts.length > 0) {
  console.log(`\n--- Phase 8: Arweave Upload --- SKIPPED (no --keypair)`);
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
console.log(`Claims:              ${claimCount}`);
console.log(`Uploads:             ${uploadCount}`);
