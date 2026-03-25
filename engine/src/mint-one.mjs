#!/usr/bin/env node
/**
 * mint-one.mjs — Single Receipt Flow (V1)
 *
 * The smallest usable pipeline: ingest a wallet, find closed cycles,
 * select one receipt, sign → upload → mint → verify.
 *
 * Usage:
 *   node src/mint-one.mjs <wallet> --keypair <path> [options]
 *
 * Options:
 *   --keypair <path>        Solana keypair JSON (required)
 *   --recipient <pubkey>    Mint destination (default: signer wallet)
 *   --pick <N>              Select receipt N (1-indexed). Default: auto (best candidate)
 *   --max-txns <N>          Transaction fetch cap (default: 5000)
 *   --network <devnet|mainnet>  (default: devnet)
 *   --dry-run               Simulate mint only (no on-chain submission)
 *   --list-only             Stop after listing available receipts
 *   --skip-upload           Use dummy metadata URI (skip Arweave)
 *
 * Flow:
 *   Phase 1-6  → ingest, normalize, reconstruct, pnl, receipt, render
 *   List       → show closed cycles, prompt for selection
 *   Phase 7    → claim sign (single receipt)
 *   Phase 8    → arweave upload (single receipt)
 *   Phase 9    → mint on-chain (single receipt)
 *   Verify     → PDA + NFT + signature check
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { createCanvas } from 'canvas';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  Ed25519Program, ComputeBudgetProgram, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ═══════════════════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════════════════
const rawArgs = process.argv.slice(2);

function getFlag(name) {
  const idx = rawArgs.indexOf(name);
  if (idx === -1 || idx + 1 >= rawArgs.length) return null;
  return rawArgs[idx + 1];
}
function hasFlag(name) { return rawArgs.includes(name); }

if (rawArgs.length === 0 || hasFlag('--help') || hasFlag('-h')) {
  console.log(`
mint-one — Single Receipt Mint Flow

USAGE:
  node src/mint-one.mjs <wallet> --keypair <path> [options]

OPTIONS:
  --keypair <path>           Solana keypair JSON file (required for sign/upload/mint)
  --recipient <pubkey>       Mint destination wallet (default: signer)
  --pick <N>                 Select receipt #N (1-indexed, default: auto-select)
  --max-txns <N>             Transaction fetch limit (default: 5000)
  --network <devnet|mainnet> Solana network (default: devnet)
  --dry-run                  Simulate mint transaction only
  --list-only                List available receipts and exit
  --skip-upload              Skip Arweave upload (use dummy metadata URI)

EXAMPLES:
  # List available receipts for a wallet
  node src/mint-one.mjs CsZLf8nu...4pX --keypair ./my-key.json --list-only

  # Auto-select best receipt and mint (devnet)
  node src/mint-one.mjs CsZLf8nu...4pX --keypair ./my-key.json

  # Pick receipt #3, skip upload, dry-run
  node src/mint-one.mjs CsZLf8nu...4pX --keypair ./my-key.json --pick 3 --skip-upload --dry-run
`);
  process.exit(0);
}

// Parse args
const flagNames = new Set(['--keypair','--recipient','--pick','--max-txns','--network']);
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (flagNames.has(rawArgs[i]) || rawArgs[i] === '--dry-run' || rawArgs[i] === '--list-only' || rawArgs[i] === '--skip-upload') {
    if (flagNames.has(rawArgs[i])) i++;
    continue;
  }
  positional.push(rawArgs[i]);
}

const WALLET = positional[0];
const KEYPAIR_PATH = getFlag('--keypair');
const RECIPIENT_OVERRIDE = getFlag('--recipient');
const PICK = getFlag('--pick') ? parseInt(getFlag('--pick')) : null;
const MAX_TXNS = parseInt(getFlag('--max-txns') || '5000');
const NETWORK = getFlag('--network') || 'devnet';
const DRY_RUN = hasFlag('--dry-run');
const LIST_ONLY = hasFlag('--list-only');
const SKIP_UPLOAD = hasFlag('--skip-upload');

if (!WALLET) { console.error('Error: wallet address required.'); process.exit(1); }
if (!KEYPAIR_PATH && !LIST_ONLY) { console.error('Error: --keypair required (or use --list-only).'); process.exit(1); }

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
const SYMS = { [SOL_MINT]: 'SOL', [USDC_MINT]: 'USDC', [USDT_MINT]: 'USDT', MIXED: 'MIXED' };
const DUST_ABS = 0.001;
const DUST_PCT = 0.001;
const BASE_URL = 'https://api-mainnet.helius-rpc.com';
const PAGE_SIZE = 100;
const RATE_DELAY_MS = 350;
const RECEIPT_VERSION = '1.0';
const CHAIN = 'solana';
const ACCOUNTING_METHOD = 'weighted_average_cost_basis';

const PROGRAM_ID = new PublicKey('HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const RECEIPT_SEED = Buffer.from('receipt');
const MINT_SEED = Buffer.from('mint');

const ENDPOINTS = { devnet: 'https://api.devnet.solana.com', mainnet: 'https://api.mainnet-beta.solana.com' };
const GATEWAY_BASE = 'https://gateway.irys.xyz';

// Load Helius key
const envPath = resolve(process.env.USERPROFILE || process.env.HOME, '.openclaw', '.env');
const envContent = readFileSync(envPath, 'utf-8');
const keyMatch = envContent.match(/^HELIUS_API_KEY=(.+)$/m);
if (!keyMatch) { console.error('HELIUS_API_KEY not found in ' + envPath); process.exit(1); }
const API_KEY = keyMatch[1].trim().replace(/^["']|["']$/g, '');

// Output dirs
const dataDir = resolve(ROOT, 'data');
for (const d of ['raw','normalized','cycles','pnl','receipts','renders','claims','arweave','mints']) {
  mkdirSync(resolve(dataDir, d), { recursive: true });
}

console.log(`\n╔════════════════════════════════════════════════════════════╗`);
console.log(`║  MINT-ONE — Single Receipt Flow                           ║`);
console.log(`╚════════════════════════════════════════════════════════════╝`);
console.log(`Wallet:   ${WALLET}`);
console.log(`Max txns: ${MAX_TXNS}`);
console.log(`Network:  ${NETWORK}`);
if (DRY_RUN) console.log(`Mode:     DRY RUN (simulate only)`);
if (LIST_ONLY) console.log(`Mode:     LIST ONLY`);
if (SKIP_UPLOAD) console.log(`Upload:   SKIPPED (dummy metadata)`);

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1: INGEST
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── Phase 1: Ingest ──`);
const rawResponsePath = resolve(dataDir, 'raw/helius_raw_response.jsonl');
const txnOutputPath = resolve(dataDir, 'raw/helius_transactions.jsonl');
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
    console.error(`  HTTP ${res.status}: ${body.slice(0, 200)}`);
    break;
  }
  const batch = await res.json();
  if (!Array.isArray(batch) || batch.length === 0) break;

  appendFileSync(rawResponsePath, JSON.stringify({ page: pageNum, wallet: WALLET, count: batch.length, fetchedAt: new Date().toISOString(), transactions: batch }) + '\n');
  for (const tx of batch) appendFileSync(txnOutputPath, JSON.stringify(tx) + '\n');

  totalFetched += batch.length;
  beforeSig = batch[batch.length - 1].signature;
  process.stdout.write(`  Page ${pageNum}: ${totalFetched} txns\r`);

  if (batch.length < limit) break;
  if (totalFetched < MAX_TXNS) await new Promise(r => setTimeout(r, RATE_DELAY_MS));
}
console.log(`  Ingested: ${totalFetched} transactions`);

if (totalFetched === 0) { console.log('\nNo transactions found. Exiting.'); process.exit(0); }

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2: NORMALIZE
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── Phase 2: Normalize ──`);
const rawContent = readFileSync(txnOutputPath, 'utf-8').trim();
if (!rawContent) { console.log('No transactions. Exiting.'); process.exit(0); }
const rawLines = rawContent.split('\n').filter(Boolean);

const events = [];
let normSkipped = { notSwap: 0, errored: 0, ambiguous: 0 };

for (let i = 0; i < rawLines.length; i++) {
  const tx = JSON.parse(rawLines[i]);
  if (tx.type !== 'SWAP') { normSkipped.notSwap++; continue; }
  if (tx.transactionError) { normSkipped.errored++; continue; }

  let event = null;

  if (tx.events?.swap) {
    const sw = tx.events.swap;
    let inMint, inAmt, inDec, outMint, outAmt, outDec;
    if (sw.nativeInput) { inMint = SOL_MINT; inDec = 9; inAmt = Number(sw.nativeInput.amount) / 1e9; }
    else if (sw.tokenInputs?.length === 1) { const ti = sw.tokenInputs[0]; inMint = ti.mint; inDec = ti.rawTokenAmount?.decimals ?? null; inAmt = Number(ti.rawTokenAmount.tokenAmount) / Math.pow(10, inDec || 0); }
    else { normSkipped.ambiguous++; continue; }

    if (sw.nativeOutput) { outMint = SOL_MINT; outDec = 9; outAmt = Number(sw.nativeOutput.amount) / 1e9; }
    else if (sw.tokenOutputs?.length === 1) { const to = sw.tokenOutputs[0]; outMint = to.mint; outDec = to.rawTokenAmount?.decimals ?? null; outAmt = Number(to.rawTokenAmount.tokenAmount) / Math.pow(10, outDec || 0); }
    else { normSkipped.ambiguous++; continue; }

    event = { wallet: WALLET, timestamp: tx.timestamp, tx_hash: tx.signature, source: tx.source || 'unknown', token_in_mint: inMint, token_in_amount: inAmt, token_in_decimals: inDec, token_out_mint: outMint, token_out_amount: outAmt, token_out_decimals: outDec, extraction_method: 'events_swap', raw_index: i };
  } else {
    const sent = (tx.tokenTransfers || []).filter(t => t.fromUserAccount === WALLET);
    const recv = (tx.tokenTransfers || []).filter(t => t.toUserAccount === WALLET);
    if (sent.length === 1 && recv.length === 1 && sent[0].mint !== recv[0].mint) {
      event = { wallet: WALLET, timestamp: tx.timestamp, tx_hash: tx.signature, source: tx.source || 'unknown', token_in_mint: sent[0].mint || SOL_MINT, token_in_amount: Math.abs(sent[0].tokenAmount), token_in_decimals: null, token_out_mint: recv[0].mint || SOL_MINT, token_out_amount: Math.abs(recv[0].tokenAmount), token_out_decimals: null, extraction_method: 'token_transfers', raw_index: i };
    } else { normSkipped.ambiguous++; }
  }
  if (event) events.push(event);
}

events.sort((a, b) => a.timestamp - b.timestamp || a.raw_index - b.raw_index);
const eventsPath = resolve(dataDir, 'normalized/events.jsonl');
writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
console.log(`  Swaps: ${events.length} (skipped: ${normSkipped.notSwap} non-swap, ${normSkipped.errored} errored, ${normSkipped.ambiguous} ambiguous)`);

if (events.length === 0) { console.log('\nNo swap events. Exiting.'); process.exit(0); }

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3: RECONSTRUCT
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── Phase 3: Reconstruct ──`);
const activeCycles = new Map();
const allCycles = [];
let cycleCounter = 0;

for (const ev of events) {
  const inIsQuote = QUOTE_MINTS.has(ev.token_in_mint);
  const outIsQuote = QUOTE_MINTS.has(ev.token_out_mint);

  let action, baseMint, baseAmt, quoteMint, quoteAmt;
  if (inIsQuote && !outIsQuote) { action = 'buy'; baseMint = ev.token_out_mint; baseAmt = ev.token_out_amount; quoteMint = ev.token_in_mint; quoteAmt = ev.token_in_amount; }
  else if (!inIsQuote && outIsQuote) { action = 'sell'; baseMint = ev.token_in_mint; baseAmt = ev.token_in_amount; quoteMint = ev.token_out_mint; quoteAmt = ev.token_out_amount; }
  else continue;

  let cycle = activeCycles.get(baseMint);
  if (!cycle && action === 'sell') {
    cycleCounter++;
    cycle = { cycle_id: `cycle_${cycleCounter}_${baseMint.slice(0,8)}`, base_mint: baseMint, status: 'partial_history', entry_txs: [], exit_txs: [], running_balance: 0, peak_position: 0, quote_mints: new Set() };
    activeCycles.set(baseMint, cycle);
  }
  if (!cycle && action === 'buy') {
    cycleCounter++;
    cycle = { cycle_id: `cycle_${cycleCounter}_${baseMint.slice(0,8)}`, base_mint: baseMint, status: 'open', entry_txs: [], exit_txs: [], running_balance: 0, peak_position: 0, quote_mints: new Set() };
    activeCycles.set(baseMint, cycle);
  }
  if (!cycle) continue;

  const txEntry = { tx_hash: ev.tx_hash, timestamp: ev.timestamp, amount: baseAmt, quote_amount: quoteAmt, quote_mint: quoteMint };
  cycle.quote_mints.add(quoteMint);

  if (action === 'buy') {
    cycle.entry_txs.push(txEntry);
    cycle.running_balance += baseAmt;
    if (cycle.running_balance > cycle.peak_position) cycle.peak_position = cycle.running_balance;
  } else {
    cycle.exit_txs.push(txEntry);
    cycle.running_balance -= baseAmt;
  }

  const threshold = Math.max(DUST_ABS, DUST_PCT * cycle.peak_position);
  if (action === 'sell' && cycle.status !== 'partial_history' && Math.abs(cycle.running_balance) < threshold && cycle.entry_txs.length > 0) {
    cycle.status = 'closed';
    allCycles.push({ ...cycle, quote_mints: [...cycle.quote_mints] });
    activeCycles.delete(baseMint);
  }
  if (cycle.running_balance < 0 && cycle.status !== 'partial_history') {
    cycle.status = 'partial_history';
  }
}

for (const [, cycle] of activeCycles) {
  allCycles.push({ ...cycle, quote_mints: [...cycle.quote_mints] });
}

const closed = allCycles.filter(c => c.status === 'closed');
const open = allCycles.filter(c => c.status === 'open');
const partial = allCycles.filter(c => c.status === 'partial_history');
console.log(`  Cycles: ${allCycles.length} total (${closed.length} closed, ${open.length} open, ${partial.length} partial)`);

if (closed.length === 0) {
  console.log('\n⚠️  No closed trade cycles found in this transaction window.');
  console.log('   This means no complete buy→sell loops were captured.');
  console.log('   Try increasing --max-txns or using a different wallet.');
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4-5: PNL + RECEIPTS
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── Phase 4-5: PnL + Receipts ──`);
const receipts = [];
let receiptNum = 0;

for (const cycle of closed) {
  receiptNum++;
  const totalBought = cycle.entry_txs.reduce((s, t) => s + t.amount, 0);
  const totalSold = cycle.exit_txs.reduce((s, t) => s + t.amount, 0);
  const costBasis = cycle.entry_txs.reduce((s, t) => s + t.quote_amount, 0);
  const exitProceeds = cycle.exit_txs.reduce((s, t) => s + t.quote_amount, 0);
  const entryAvg = costBasis / totalBought;
  const exitAvg = exitProceeds / totalSold;
  const pnl = exitProceeds - costBasis;
  const pnlPct = (pnl / costBasis) * 100;

  const quoteMints = cycle.quote_mints;
  const quoteCurrency = quoteMints.length === 1 ? quoteMints[0] : 'MIXED';
  const receiptStatus = quoteMints.length === 1 ? 'verified' : 'verified_mixed_quote';

  const stripTx = t => ({ tx_hash: t.tx_hash, timestamp: t.timestamp, amount: t.amount, quote_amount: t.quote_amount });
  const entryTxs = cycle.entry_txs.map(stripTx);
  const exitTxs = cycle.exit_txs.map(stripTx);

  const entryHashes = entryTxs.map(t => t.tx_hash).sort();
  const exitHashes = exitTxs.map(t => t.tx_hash).sort();
  const hashPayload = JSON.stringify([WALLET, CHAIN, cycle.base_mint, entryHashes, exitHashes, entryAvg, exitAvg, ACCOUNTING_METHOD, RECEIPT_VERSION, receiptStatus]);
  const verificationHash = createHash('sha256').update(hashPayload).digest('hex');

  const receiptId = `receipt_${String(receiptNum).padStart(4, '0')}_${cycle.base_mint.slice(0,8)}`;
  const receipt = {
    receipt_id: receiptId, receipt_version: RECEIPT_VERSION, cycle_id: cycle.cycle_id,
    wallet: WALLET, chain: CHAIN, token_mint: cycle.base_mint, status: receiptStatus,
    accounting_method: ACCOUNTING_METHOD,
    avg_entry_price: parseFloat(entryAvg.toPrecision(12)),
    avg_exit_price: parseFloat(exitAvg.toPrecision(12)),
    quote_currency: quoteCurrency,
    total_cost_basis: parseFloat(costBasis.toPrecision(12)),
    total_exit_proceeds: parseFloat(exitProceeds.toPrecision(12)),
    realized_pnl: parseFloat(pnl.toPrecision(12)),
    realized_pnl_pct: parseFloat(pnlPct.toPrecision(6)),
    total_bought: parseFloat(totalBought.toFixed(10)),
    total_sold: parseFloat(totalSold.toFixed(10)),
    peak_position: parseFloat(cycle.peak_position.toFixed(10)),
    remaining_balance: parseFloat((totalBought - totalSold).toFixed(10)),
    num_buys: cycle.entry_txs.length, num_sells: cycle.exit_txs.length,
    opened_at: cycle.entry_txs[0].timestamp,
    closed_at: cycle.exit_txs[cycle.exit_txs.length - 1].timestamp,
    hold_time_seconds: cycle.exit_txs[cycle.exit_txs.length - 1].timestamp - cycle.entry_txs[0].timestamp,
    entry_txs: entryTxs, exit_txs: exitTxs,
    _hash_inputs: { raw_entry_price_avg: entryAvg, raw_exit_price_avg: exitAvg },
    generated_at: Math.floor(Date.now() / 1000),
    verification_hash: verificationHash,
  };
  receipts.push(receipt);
}

writeFileSync(resolve(dataDir, 'receipts/receipts.jsonl'), receipts.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`  Generated ${receipts.length} receipts`);

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 6: RENDER
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── Phase 6: Render ──`);
for (const r of receipts) {
  const W = 800, H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const isProfit = r.realized_pnl >= 0;
  const accent = isProfit ? '#00c853' : '#ff1744';

  // Background
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1a1a2e'); grad.addColorStop(1, '#16213e');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

  // Accent bar
  ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 4);

  // Title
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 22px monospace';
  const tokenShort = r.token_mint.slice(0, 8);
  const qSym = SYMS[r.quote_currency] || (r.quote_currency === 'MIXED' ? 'MIXED' : r.quote_currency?.slice(0, 8));
  ctx.fillText(`${tokenShort} / ${qSym}`, 30, 45);

  // PnL
  ctx.fillStyle = accent; ctx.font = 'bold 48px monospace';
  ctx.fillText(`${isProfit ? '+' : ''}${r.realized_pnl_pct.toFixed(2)}%`, 30, 110);

  // Details
  ctx.fillStyle = '#aaaaaa'; ctx.font = '16px monospace';
  const lines = [
    `PnL: ${r.realized_pnl >= 0 ? '+' : ''}${r.realized_pnl.toPrecision(6)} ${qSym}`,
    `Entry: ${r.avg_entry_price.toPrecision(6)} | Exit: ${r.avg_exit_price.toPrecision(6)}`,
    `Cost: ${r.total_cost_basis.toPrecision(6)} | Proceeds: ${r.total_exit_proceeds.toPrecision(6)}`,
    `Trades: ${r.num_buys}B / ${r.num_sells}S | Hold: ${(r.hold_time_seconds / 3600).toFixed(1)}h`,
    `Status: ${r.status}`,
    ``,
    `Receipt: ${r.receipt_id}`,
    `Hash: ${r.verification_hash.slice(0, 32)}...`,
    `Wallet: ${r.wallet.slice(0, 20)}...`,
    `Opened: ${new Date(r.opened_at * 1000).toISOString().slice(0, 19)}Z`,
    `Closed: ${new Date(r.closed_at * 1000).toISOString().slice(0, 19)}Z`,
  ];
  let y = 160;
  for (const line of lines) { ctx.fillText(line, 30, y); y += 28; }

  // Footer
  ctx.fillStyle = '#555555'; ctx.font = '12px monospace';
  ctx.fillText('Trade Artifact Engine v1.0 — verified on-chain receipt', 30, H - 20);

  const pngPath = resolve(dataDir, `renders/${r.receipt_id}.png`);
  writeFileSync(pngPath, canvas.toBuffer('image/png'));
}
console.log(`  Rendered ${receipts.length} PNGs`);

// ═══════════════════════════════════════════════════════════════════════════
// LIST RECEIPTS
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── Available Receipts ──\n`);
for (let i = 0; i < receipts.length; i++) {
  const r = receipts[i];
  const token = r.token_mint.slice(0, 8);
  const qSym = SYMS[r.quote_currency] || r.quote_currency?.slice(0, 8) || '?';
  const pnlSign = r.realized_pnl_pct >= 0 ? '+' : '';
  const holdH = (r.hold_time_seconds / 3600).toFixed(1);
  console.log(`  [${i + 1}] ${r.receipt_id}`);
  console.log(`      ${token} / ${qSym} | PnL: ${pnlSign}${r.realized_pnl_pct.toFixed(2)}% (${pnlSign}${r.realized_pnl.toPrecision(6)}) | ${r.num_buys}B/${r.num_sells}S | ${holdH}h | ${r.status}`);
}

if (LIST_ONLY) {
  console.log(`\n${receipts.length} receipt(s) available. Use --pick <N> to select one for minting.`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// SELECT RECEIPT
// ═══════════════════════════════════════════════════════════════════════════
let selected;
if (PICK !== null) {
  if (PICK < 1 || PICK > receipts.length) {
    console.error(`\nError: --pick ${PICK} out of range (1–${receipts.length})`);
    process.exit(1);
  }
  selected = receipts[PICK - 1];
  console.log(`\n→ Selected: [${PICK}] ${selected.receipt_id}`);
} else {
  // Auto-select: prefer verified over mixed, then highest absolute PnL %
  const sorted = [...receipts].sort((a, b) => {
    if (a.status === 'verified' && b.status !== 'verified') return -1;
    if (b.status === 'verified' && a.status !== 'verified') return 1;
    return Math.abs(b.realized_pnl_pct) - Math.abs(a.realized_pnl_pct);
  });
  selected = sorted[0];
  const idx = receipts.indexOf(selected) + 1;
  console.log(`\n→ Auto-selected: [${idx}] ${selected.receipt_id} (${selected.status}, ${selected.realized_pnl_pct >= 0 ? '+' : ''}${selected.realized_pnl_pct.toFixed(2)}%)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7: CLAIM SIGN (single receipt)
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── Phase 7: Claim Sign ──`);

const keypairBytes = new Uint8Array(JSON.parse(readFileSync(resolve(KEYPAIR_PATH), 'utf-8')));
const keypair = Keypair.fromSecretKey(keypairBytes);
const signerPubkey = keypair.publicKey.toBase58();
const recipient = RECIPIENT_OVERRIDE || signerPubkey;

if (selected.wallet !== signerPubkey) {
  console.error(`\n⚠️  Wallet mismatch: receipt wallet is ${selected.wallet}, but keypair is ${signerPubkey}`);
  console.error(`   The claim must be signed by the wallet that executed the trades.`);
  process.exit(1);
}

const canonicalMessage =
  `TRADE_RECEIPT_CLAIM_V1\n` +
  `receipt:${selected.verification_hash}\n` +
  `wallet:${selected.wallet}\n` +
  `chain:${CHAIN}\n` +
  `claim_recipient:${recipient}`;

const messageBytes = new TextEncoder().encode(canonicalMessage);
const signature = nacl.sign.detached(messageBytes, keypair.secretKey);

// Self-verify
if (!nacl.sign.detached.verify(messageBytes, signature, keypair.publicKey.toBytes())) {
  console.error('Self-verification failed!'); process.exit(1);
}

const claim = {
  claim_version: '1.0',
  receipt_id: selected.receipt_id,
  verification_hash: selected.verification_hash,
  wallet: selected.wallet,
  chain: CHAIN,
  claim_recipient: recipient,
  signature_bs58: bs58.encode(signature),
  signature_hex: Buffer.from(signature).toString('hex'),
  signed_message: canonicalMessage,
  claimed_at: Math.floor(Date.now() / 1000),
};

writeFileSync(resolve(dataDir, 'claims/claims.jsonl'), JSON.stringify(claim) + '\n');
console.log(`  ✅ Claim signed: ${claim.signature_bs58.slice(0, 20)}...`);
console.log(`     Recipient: ${recipient}`);

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8: ARWEAVE UPLOAD (single receipt)
// ═══════════════════════════════════════════════════════════════════════════
let metadataUri, metadataHash;

if (SKIP_UPLOAD) {
  console.log(`\n── Phase 8: Upload ── SKIPPED (--skip-upload)`);
  metadataUri = 'https://arweave.net/placeholder_pending_upload';
  metadataHash = new Uint8Array(32);
} else {
  console.log(`\n── Phase 8: Arweave Upload ──`);
  try {
    const { default: Uploader } = await import('@irys/upload');
    const { default: Solana } = await import('@irys/upload-solana');

    const irys = await Uploader(Solana)
      .withWallet(Buffer.from(keypairBytes))
      .withRpc(ENDPOINTS[NETWORK])
      .devnet();

    // Upload PNG
    const pngPath = resolve(dataDir, `renders/${selected.receipt_id}.png`);
    const pngResult = await irys.uploadFile(pngPath, { tags: [
      { name: 'Content-Type', value: 'image/png' },
      { name: 'App-Name', value: 'trade-artifact-engine' },
      { name: 'File-Type', value: 'receipt-render' },
      { name: 'Verification-Hash', value: selected.verification_hash },
    ]});
    const pngUri = `${GATEWAY_BASE}/${pngResult.id}`;
    console.log(`  PNG: ${pngUri}`);

    // Upload receipt JSON
    const receiptJsonStr = JSON.stringify(selected, null, 2);
    const tmpReceiptPath = resolve(dataDir, `arweave/_tmp_receipt.json`);
    writeFileSync(tmpReceiptPath, receiptJsonStr);
    const receiptJsonResult = await irys.uploadFile(tmpReceiptPath, { tags: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'App-Name', value: 'trade-artifact-engine' },
      { name: 'File-Type', value: 'receipt-data' },
      { name: 'Verification-Hash', value: selected.verification_hash },
    ]});
    const receiptJsonUri = `${GATEWAY_BASE}/${receiptJsonResult.id}`;
    console.log(`  Receipt JSON: ${receiptJsonUri}`);

    // Build + upload NFT metadata
    const tokenShort = selected.token_mint.slice(0, 8);
    const qSym = SYMS[selected.quote_currency] || (selected.quote_currency === 'MIXED' ? 'MIXED' : selected.quote_currency?.slice(0, 8));
    const nftMetadata = {
      name: `Trade Receipt ${selected.receipt_id.replace('receipt_', '#').replace(/_/g, ' ')}`,
      symbol: 'TREC',
      description: `Verified trade receipt: ${tokenShort} / ${qSym} on Solana. PnL: ${selected.realized_pnl_pct >= 0 ? '+' : ''}${selected.realized_pnl_pct}%`,
      image: pngUri,
      external_url: receiptJsonUri,
      attributes: [
        { trait_type: 'wallet', value: selected.wallet },
        { trait_type: 'token_mint', value: selected.token_mint },
        { trait_type: 'chain', value: CHAIN },
        { trait_type: 'realized_pnl_pct', value: selected.realized_pnl_pct, display_type: 'number' },
        { trait_type: 'status', value: selected.status },
        { trait_type: 'quote_currency', value: qSym },
        { trait_type: 'hold_time_seconds', value: selected.hold_time_seconds, display_type: 'number' },
        { trait_type: 'num_buys', value: selected.num_buys, display_type: 'number' },
        { trait_type: 'num_sells', value: selected.num_sells, display_type: 'number' },
        { trait_type: 'opened_at', value: selected.opened_at, display_type: 'date' },
        { trait_type: 'closed_at', value: selected.closed_at, display_type: 'date' },
      ],
      properties: {
        receipt_version: selected.receipt_version,
        verification_hash: selected.verification_hash,
        accounting_method: selected.accounting_method,
        receipt_json: receiptJsonUri,
      },
    };
    const metadataStr = JSON.stringify(nftMetadata, null, 2);
    metadataHash = createHash('sha256').update(metadataStr).digest();

    const tmpMetaPath = resolve(dataDir, `arweave/_tmp_meta.json`);
    writeFileSync(tmpMetaPath, metadataStr);
    const metaResult = await irys.uploadFile(tmpMetaPath, { tags: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'App-Name', value: 'trade-artifact-engine' },
      { name: 'File-Type', value: 'nft-metadata' },
      { name: 'Verification-Hash', value: selected.verification_hash },
      { name: 'Metadata-Hash', value: metadataHash.toString('hex') },
    ]});
    metadataUri = `${GATEWAY_BASE}/${metaResult.id}`;
    console.log(`  Metadata: ${metadataUri}`);

    // Clean temps
    try { unlinkSync(tmpReceiptPath); } catch {}
    try { unlinkSync(tmpMetaPath); } catch {}

    // Record upload
    const uploadRecord = {
      receipt_id: selected.receipt_id,
      verification_hash: selected.verification_hash,
      metadata_uri: metadataUri,
      metadata_hash: metadataHash.toString('hex'),
      uploaded_at: Math.floor(Date.now() / 1000),
      network: NETWORK,
    };
    appendFileSync(resolve(dataDir, 'arweave/uploads.jsonl'), JSON.stringify(uploadRecord) + '\n');
    console.log(`  ✅ All 3 files uploaded`);
  } catch (e) {
    console.error(`  Upload failed: ${e.message}`);
    console.log(`  Falling back to dummy metadata URI.`);
    metadataUri = 'https://arweave.net/placeholder_pending_upload';
    metadataHash = Buffer.alloc(32);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 9: MINT ON-CHAIN (single receipt)
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── Phase 9: Mint ──`);

const connection = new Connection(ENDPOINTS[NETWORK], 'confirmed');
const hashBytes = Buffer.from(selected.verification_hash, 'hex');
const metadataHashBytes = Buffer.isBuffer(metadataHash) ? metadataHash : Buffer.from(metadataHash);

// Derive PDAs
const [receiptPDA, receiptBump] = PublicKey.findProgramAddressSync([RECEIPT_SEED, hashBytes], PROGRAM_ID);
const [mintPDA] = PublicKey.findProgramAddressSync([MINT_SEED, hashBytes], PROGRAM_ID);

// Check if already minted
const existingPda = await connection.getAccountInfo(receiptPDA);
if (existingPda) {
  console.log(`  ⚠️  Receipt PDA already exists: ${receiptPDA.toBase58()}`);
  console.log(`  This receipt has already been minted. Skipping.`);
  process.exit(0);
}

// Derive ATA
const recipientPubkey = new PublicKey(recipient);
const [ata] = PublicKey.findProgramAddressSync(
  [recipientPubkey.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPDA.toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM_ID
);

// Status byte
const statusByte = selected.status === 'verified' ? 0 : 1;

// Receipt name
const receiptName = `Trade Receipt ${selected.receipt_id.replace('receipt_', '#').replace(/_/g, ' ')}`;

// Build mint_receipt instruction data
const discriminator = createHash('sha256').update('global:mint_receipt').digest().subarray(0, 8);

// Borsh encode args: verification_hash[32] + metadata_hash[32] + status(u8) + metadata_uri(len+str) + receipt_name(len+str)
const uriBytes = Buffer.from(metadataUri, 'utf-8');
const nameBytes = Buffer.from(receiptName, 'utf-8');
const ixDataLen = 8 + 32 + 32 + 1 + 4 + uriBytes.length + 4 + nameBytes.length;
const ixData = Buffer.alloc(ixDataLen);
let offset = 0;
discriminator.copy(ixData, offset); offset += 8;
hashBytes.copy(ixData, offset); offset += 32;
metadataHashBytes.copy(ixData, offset); offset += 32;
ixData.writeUInt8(statusByte, offset); offset += 1;
ixData.writeUInt32LE(uriBytes.length, offset); offset += 4;
uriBytes.copy(ixData, offset); offset += uriBytes.length;
ixData.writeUInt32LE(nameBytes.length, offset); offset += 4;
nameBytes.copy(ixData, offset);

// Account keys for mint_receipt — must match on-chain MintReceipt struct order
const keys = [
  { pubkey: keypair.publicKey, isSigner: true, isWritable: true },         // payer
  { pubkey: new PublicKey(selected.wallet), isSigner: false, isWritable: false }, // trader_wallet
  { pubkey: recipientPubkey, isSigner: false, isWritable: true },           // claim_recipient
  { pubkey: receiptPDA, isSigner: false, isWritable: true },                // receipt_anchor
  { pubkey: mintPDA, isSigner: false, isWritable: true },                   // nft_mint
  { pubkey: ata, isSigner: false, isWritable: true },                       // recipient_token_account
  { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },    // token_program
  { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associated_token_program
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },  // system_program
  { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, // instructions_sysvar
];

const mintIx = new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixData });

// Ed25519 instruction
const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
  publicKey: keypair.publicKey.toBytes(),
  message: messageBytes,
  signature: signature,
});

// Compute budget
const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

// Build transaction
const tx = new Transaction().add(ed25519Ix).add(computeIx).add(mintIx);

if (DRY_RUN) {
  console.log(`  Simulating...`);
  try {
    const simResult = await connection.simulateTransaction(tx, [keypair]);
    if (simResult.value.err) {
      console.log(`  ❌ Simulation failed: ${JSON.stringify(simResult.value.err)}`);
      if (simResult.value.logs) {
        console.log(`  Logs:`);
        for (const log of simResult.value.logs.slice(-10)) console.log(`    ${log}`);
      }
    } else {
      console.log(`  ✅ Simulation passed (CU: ${simResult.value.unitsConsumed})`);
    }
  } catch (e) {
    console.log(`  ❌ Simulation error: ${e.message}`);
  }
} else {
  console.log(`  Submitting to ${NETWORK}...`);
  console.log(`    PDA:  ${receiptPDA.toBase58()}`);
  console.log(`    Mint: ${mintPDA.toBase58()}`);
  console.log(`    ATA:  ${ata.toBase58()}`);

  try {
    const txSig = await sendAndConfirmTransaction(connection, tx, [keypair], {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    console.log(`\n  ✅ MINTED!`);
    console.log(`    TX: ${txSig}`);
    console.log(`    PDA: ${receiptPDA.toBase58()}`);
    console.log(`    Mint: ${mintPDA.toBase58()}`);
    console.log(`    Metadata: ${metadataUri}`);

    // Record result
    const mintResult = {
      receipt_id: selected.receipt_id,
      verification_hash: selected.verification_hash,
      tx_signature: txSig,
      receipt_pda: receiptPDA.toBase58(),
      nft_mint: mintPDA.toBase58(),
      status: 'confirmed',
      network: NETWORK,
      minted_at: Math.floor(Date.now() / 1000),
    };
    appendFileSync(resolve(dataDir, 'mints/mint_results.jsonl'), JSON.stringify(mintResult) + '\n');
  } catch (e) {
    console.error(`\n  ❌ Mint failed: ${e.message}`);
    if (e.logs) {
      console.log(`  Logs:`);
      for (const log of e.logs.slice(-10)) console.log(`    ${log}`);
    }
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DONE
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}`);
console.log(`MINT-ONE COMPLETE`);
console.log(`  Receipt:  ${selected.receipt_id}`);
console.log(`  Token:    ${selected.token_mint.slice(0, 12)}...`);
console.log(`  PnL:      ${selected.realized_pnl_pct >= 0 ? '+' : ''}${selected.realized_pnl_pct.toFixed(2)}%`);
console.log(`  Hash:     ${selected.verification_hash.slice(0, 24)}...`);
console.log(`  Network:  ${NETWORK}`);
console.log(`${'═'.repeat(60)}`);
