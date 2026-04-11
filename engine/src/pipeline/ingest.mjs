/**
 * Pipeline — Ingest + Normalize
 * Extracted from mint-one.mjs v1 (Phase 0.5).
 *
 * Fetches wallet transactions from Helius, normalizes swap events.
 * Returns: { events: NormalizedEvent[], stats: { fetched, swaps, skipped } }
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import {
  SOL_MINT, QUOTE_MINTS, DEX_PROGRAMS,
  BASE_URL, PAGE_SIZE, RATE_DELAY_MS,
} from './constants.mjs';

// ---------------------------------------------------------------------------
// Helpers (identical to mint-one.mjs)
// ---------------------------------------------------------------------------

function txTouchesDex(tx) {
  for (const ix of (tx.instructions || [])) {
    if (DEX_PROGRAMS.has(ix.programId)) return true;
    for (const inner of (ix.innerInstructions || [])) {
      if (DEX_PROGRAMS.has(inner.programId)) return true;
    }
  }
  return false;
}

function extractSwapFromTransfers(tx, idx, wallet) {
  const sent = (tx.tokenTransfers || []).filter(t => t.fromUserAccount === wallet);
  const recv = (tx.tokenTransfers || []).filter(t => t.toUserAccount === wallet);

  let nativeSent = 0, nativeRecv = 0;
  for (const nt of (tx.nativeTransfers || [])) {
    if (nt.fromUserAccount === wallet) nativeSent += nt.amount;
    if (nt.toUserAccount === wallet) nativeRecv += nt.amount;
  }
  const netNative = nativeRecv - nativeSent;

  if (sent.length === 1 && recv.length === 1 && sent[0].mint !== recv[0].mint) {
    return { wallet, timestamp: tx.timestamp, tx_hash: tx.signature, source: tx.source || 'unknown', token_in_mint: sent[0].mint || SOL_MINT, token_in_amount: Math.abs(sent[0].tokenAmount), token_in_decimals: null, token_out_mint: recv[0].mint || SOL_MINT, token_out_amount: Math.abs(recv[0].tokenAmount), token_out_decimals: null, extraction_method: 'token_transfers', raw_index: idx };
  }

  if (sent.length === 1 && recv.length === 0 && netNative > 0) {
    const solReceived = netNative / 1e9;
    if (solReceived >= 0.001) {
      return { wallet, timestamp: tx.timestamp, tx_hash: tx.signature, source: tx.source || 'unknown', token_in_mint: sent[0].mint, token_in_amount: Math.abs(sent[0].tokenAmount), token_in_decimals: null, token_out_mint: SOL_MINT, token_out_amount: solReceived, token_out_decimals: 9, extraction_method: 'token_transfers_native', raw_index: idx };
    }
  }

  if (sent.length === 0 && recv.length === 1 && netNative < 0) {
    const solSent = Math.abs(netNative) / 1e9;
    if (solSent >= 0.001) {
      return { wallet, timestamp: tx.timestamp, tx_hash: tx.signature, source: tx.source || 'unknown', token_in_mint: SOL_MINT, token_in_amount: solSent, token_in_decimals: 9, token_out_mint: recv[0].mint, token_out_amount: Math.abs(recv[0].tokenAmount), token_out_decimals: null, extraction_method: 'token_transfers_native', raw_index: idx };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Phase 1: Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch raw transactions from Helius for a wallet.
 * @param {string} wallet - Solana wallet address
 * @param {string} apiKey - Helius API key
 * @param {object} opts - { maxTxns?, dataDir?, silent? }
 * @returns {object[]} Raw transaction objects
 */
export async function fetchTransactions(wallet, apiKey, opts = {}) {
  const maxTxns = opts.maxTxns || 5000;
  const dataDir = opts.dataDir || null;
  const silent = opts.silent || false;

  // Optionally persist raw data
  let rawResponsePath, txnOutputPath;
  if (dataDir) {
    mkdirSync(resolve(dataDir, 'raw'), { recursive: true });
    rawResponsePath = resolve(dataDir, 'raw/helius_raw_response.jsonl');
    txnOutputPath = resolve(dataDir, 'raw/helius_transactions.jsonl');
    writeFileSync(rawResponsePath, '');
    writeFileSync(txnOutputPath, '');
  }

  let beforeSig = null;
  let totalFetched = 0;
  let pageNum = 0;
  const allTxns = [];

  while (totalFetched < maxTxns) {
    pageNum++;
    const limit = Math.min(PAGE_SIZE, maxTxns - totalFetched);
    let url = `${BASE_URL}/v0/addresses/${wallet}/transactions?api-key=${apiKey}&limit=${limit}`;
    if (beforeSig) url += `&before-signature=${beforeSig}`;

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      if (!silent) console.error(`  HTTP ${res.status}: ${body.slice(0, 200)}`);
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    if (dataDir) {
      appendFileSync(rawResponsePath, JSON.stringify({ page: pageNum, wallet, count: batch.length, fetchedAt: new Date().toISOString(), transactions: batch }) + '\n');
      for (const tx of batch) appendFileSync(txnOutputPath, JSON.stringify(tx) + '\n');
    }

    allTxns.push(...batch);
    totalFetched += batch.length;
    beforeSig = batch[batch.length - 1].signature;
    if (!silent) process.stdout.write(`  Page ${pageNum}: ${totalFetched} txns\r`);

    if (batch.length < limit) break;
    if (totalFetched < maxTxns) await new Promise(r => setTimeout(r, RATE_DELAY_MS));
  }
  if (!silent) console.log(`  Ingested: ${totalFetched} transactions`);

  return allTxns;
}

// ---------------------------------------------------------------------------
// Phase 2: Normalize
// ---------------------------------------------------------------------------

/**
 * Normalize raw Helius transactions into swap events.
 * @param {object[]} rawTxns - Raw transaction objects
 * @param {string} wallet - Wallet address
 * @param {object} opts - { dataDir?, silent? }
 * @returns {{ events: object[], stats: { fetched: number, swaps: number, skipped: object } }}
 */
export function normalizeTransactions(rawTxns, wallet, opts = {}) {
  const dataDir = opts.dataDir || null;
  const silent = opts.silent || false;

  const events = [];
  const skipped = { notSwap: 0, errored: 0, ambiguous: 0 };

  for (let i = 0; i < rawTxns.length; i++) {
    const tx = rawTxns[i];
    if (tx.transactionError) { skipped.errored++; continue; }

    let event = null;

    // Primary path: Helius events.swap
    if (tx.type === 'SWAP' && tx.events?.swap) {
      const sw = tx.events.swap;
      let inMint, inAmt, inDec, outMint, outAmt, outDec;
      if (sw.nativeInput) { inMint = SOL_MINT; inDec = 9; inAmt = Number(sw.nativeInput.amount) / 1e9; }
      else if (sw.tokenInputs?.length === 1) { const ti = sw.tokenInputs[0]; inMint = ti.mint; inDec = ti.rawTokenAmount?.decimals ?? null; inAmt = Number(ti.rawTokenAmount.tokenAmount) / Math.pow(10, inDec || 0); }
      else { skipped.ambiguous++; continue; }

      if (sw.nativeOutput) { outMint = SOL_MINT; outDec = 9; outAmt = Number(sw.nativeOutput.amount) / 1e9; }
      else if (sw.tokenOutputs?.length === 1) { const to = sw.tokenOutputs[0]; outMint = to.mint; outDec = to.rawTokenAmount?.decimals ?? null; outAmt = Number(to.rawTokenAmount.tokenAmount) / Math.pow(10, outDec || 0); }
      else { skipped.ambiguous++; continue; }

      event = { wallet, timestamp: tx.timestamp, tx_hash: tx.signature, source: tx.source || 'unknown', token_in_mint: inMint, token_in_amount: inAmt, token_in_decimals: inDec, token_out_mint: outMint, token_out_amount: outAmt, token_out_decimals: outDec, extraction_method: 'events_swap', raw_index: i };
    }

    // Fallback: token-transfer analysis
    if (!event) {
      if (tx.type === 'SWAP' || txTouchesDex(tx)) {
        event = extractSwapFromTransfers(tx, i, wallet);
      }
    }

    if (!event) {
      if (tx.type === 'SWAP') { skipped.ambiguous++; }
      else { skipped.notSwap++; }
      continue;
    }
    events.push(event);
  }

  events.sort((a, b) => a.timestamp - b.timestamp || a.raw_index - b.raw_index);

  if (dataDir) {
    mkdirSync(resolve(dataDir, 'normalized'), { recursive: true });
    writeFileSync(resolve(dataDir, 'normalized/events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  if (!silent) {
    console.log(`  Swaps: ${events.length} (skipped: ${skipped.notSwap} non-swap, ${skipped.errored} errored, ${skipped.ambiguous} ambiguous)`);
  }

  return { events, stats: { fetched: rawTxns.length, swaps: events.length, skipped } };
}
