/**
 * Phase 2 — Event Normalization
 *
 * Converts raw Helius enhanced transactions into normalized swap events.
 *
 * Primary path:  events.swap structured data
 * Fallback path: tokenTransfers direction analysis
 *
 * Output: data/normalized/events.jsonl (one swap event per line)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const WALLET = 'CreQJ2t94QK5dsxUZGXfPJ8Nx7wA9LHr5chxjSMkbNft';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS = 9;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert raw token amount string + decimals to a normalized number. */
function normalizeAmount(rawAmount, decimals) {
  return Number(rawAmount) / Math.pow(10, decimals);
}

/** Build a normalized event object. */
function makeEvent(fields) {
  return {
    wallet: WALLET,
    timestamp: fields.timestamp,
    tx_hash: fields.tx_hash,
    source: fields.source,
    token_in_mint: fields.token_in_mint,
    token_in_amount: fields.token_in_amount,
    token_in_decimals: fields.token_in_decimals,
    token_out_mint: fields.token_out_mint,
    token_out_amount: fields.token_out_amount,
    token_out_decimals: fields.token_out_decimals,
    extraction_method: fields.extraction_method,
    raw_index: fields.raw_index,
  };
}

// ---------------------------------------------------------------------------
// Primary path: events.swap
// ---------------------------------------------------------------------------

function extractFromSwapEvent(tx, rawIndex) {
  const sw = tx.events.swap;

  let tokenInMint, tokenInAmount, tokenInDecimals;
  let tokenOutMint, tokenOutAmount, tokenOutDecimals;

  // --- Determine token_in (what the wallet sent) ---
  if (sw.nativeInput) {
    // Wallet sent SOL
    tokenInMint = SOL_MINT;
    tokenInDecimals = SOL_DECIMALS;
    tokenInAmount = normalizeAmount(sw.nativeInput.amount, SOL_DECIMALS);
  } else if (sw.tokenInputs && sw.tokenInputs.length === 1) {
    const ti = sw.tokenInputs[0];
    tokenInMint = ti.mint;
    tokenInDecimals = ti.rawTokenAmount.decimals;
    tokenInAmount = normalizeAmount(ti.rawTokenAmount.tokenAmount, ti.rawTokenAmount.decimals);
  } else if (sw.tokenInputs && sw.tokenInputs.length > 1) {
    // Multiple token inputs — ambiguous, skip
    return null;
  } else {
    return null; // No input detected
  }

  // --- Determine token_out (what the wallet received) ---
  if (sw.nativeOutput) {
    // Wallet received SOL
    tokenOutMint = SOL_MINT;
    tokenOutDecimals = SOL_DECIMALS;
    tokenOutAmount = normalizeAmount(sw.nativeOutput.amount, SOL_DECIMALS);
  } else if (sw.tokenOutputs && sw.tokenOutputs.length === 1) {
    const to = sw.tokenOutputs[0];
    tokenOutMint = to.mint;
    tokenOutDecimals = to.rawTokenAmount.decimals;
    tokenOutAmount = normalizeAmount(to.rawTokenAmount.tokenAmount, to.rawTokenAmount.decimals);
  } else if (sw.tokenOutputs && sw.tokenOutputs.length > 1) {
    // Multiple token outputs — ambiguous, skip
    return null;
  } else {
    return null; // No output detected
  }

  return makeEvent({
    timestamp: tx.timestamp,
    tx_hash: tx.signature,
    source: tx.source || 'UNKNOWN',
    token_in_mint: tokenInMint,
    token_in_amount: tokenInAmount,
    token_in_decimals: tokenInDecimals,
    token_out_mint: tokenOutMint,
    token_out_amount: tokenOutAmount,
    token_out_decimals: tokenOutDecimals,
    extraction_method: 'events_swap',
    raw_index: rawIndex,
  });
}

// ---------------------------------------------------------------------------
// Fallback path: tokenTransfers
// ---------------------------------------------------------------------------

function extractFromTokenTransfers(tx, rawIndex) {
  const transfers = tx.tokenTransfers || [];
  const nativeTransfers = tx.nativeTransfers || [];

  // Classify wallet-direction token transfers
  const sent = [];     // wallet sent these tokens
  const received = []; // wallet received these tokens

  for (const tt of transfers) {
    if (tt.fromUserAccount === WALLET) {
      sent.push(tt);
    } else if (tt.toUserAccount === WALLET) {
      received.push(tt);
    }
  }

  // Also check native SOL transfers
  let nativeSent = 0;
  let nativeReceived = 0;
  for (const nt of nativeTransfers) {
    if (nt.fromUserAccount === WALLET) nativeSent += nt.amount;
    if (nt.toUserAccount === WALLET) nativeReceived += nt.amount;
  }

  let tokenInMint, tokenInAmount, tokenInDecimals;
  let tokenOutMint, tokenOutAmount, tokenOutDecimals;

  // --- Determine token_in ---
  if (sent.length === 1 && nativeSent === 0) {
    // Single token sent
    tokenInMint = sent[0].mint;
    tokenInAmount = sent[0].tokenAmount;
    // Derive decimals from raw data if available, otherwise from accountData
    tokenInDecimals = guessDecimals(tx, sent[0].mint, sent[0].tokenAmount);
  } else if (sent.length === 0 && nativeSent > 0) {
    // Only SOL sent (but SOL doesn't appear as wrapped in tokenTransfers here)
    // This shouldn't happen in fallback path since wrapped SOL shows as token
    return null;
  } else if (sent.length === 1 && nativeSent > 0) {
    // Token sent + some native SOL (probably fees) — use the token as input
    tokenInMint = sent[0].mint;
    tokenInAmount = sent[0].tokenAmount;
    tokenInDecimals = guessDecimals(tx, sent[0].mint, sent[0].tokenAmount);
  } else {
    // Ambiguous: 0 or 2+ tokens sent
    return null;
  }

  // --- Determine token_out ---
  if (received.length === 1) {
    tokenOutMint = received[0].mint;
    tokenOutAmount = received[0].tokenAmount;
    tokenOutDecimals = guessDecimals(tx, received[0].mint, received[0].tokenAmount);
  } else {
    // Ambiguous
    return null;
  }

  // Sanity: in and out should be different tokens
  if (tokenInMint === tokenOutMint) return null;

  return makeEvent({
    timestamp: tx.timestamp,
    tx_hash: tx.signature,
    source: tx.source || 'UNKNOWN',
    token_in_mint: tokenInMint,
    token_in_amount: tokenInAmount,
    token_in_decimals: tokenInDecimals,
    token_out_mint: tokenOutMint,
    token_out_amount: tokenOutAmount,
    token_out_decimals: tokenOutDecimals,
    extraction_method: 'token_transfers',
    raw_index: rawIndex,
  });
}

/**
 * Guess decimals for a token from accountData tokenBalanceChanges.
 * tokenTransfers already give decimal-normalized amounts,
 * but we want to record the decimals metadata.
 */
function guessDecimals(tx, mint, _amount) {
  // SOL wrapped
  if (mint === SOL_MINT) return SOL_DECIMALS;

  // Search accountData for tokenBalanceChanges with matching mint
  for (const ad of (tx.accountData || [])) {
    for (const tbc of (ad.tokenBalanceChanges || [])) {
      if (tbc.mint === mint && tbc.rawTokenAmount?.decimals !== undefined) {
        return tbc.rawTokenAmount.decimals;
      }
    }
  }

  return null; // Unknown
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const rawPath = resolve(ROOT, 'data', 'raw', 'helius_transactions.jsonl');
const outPath = resolve(ROOT, 'data', 'normalized', 'events.jsonl');

const lines = readFileSync(rawPath, 'utf-8').trim().split('\n');
console.log(`Loaded ${lines.length} raw transactions`);

const events = [];
const stats = {
  total_raw: lines.length,
  filtered_not_swap: 0,
  filtered_errored: 0,
  filtered_ambiguous: 0,
  by_method: {},
  by_source: {},
};

for (let i = 0; i < lines.length; i++) {
  const tx = JSON.parse(lines[i]);

  // Filter non-SWAPs
  if (tx.type !== 'SWAP') {
    stats.filtered_not_swap++;
    continue;
  }

  // Filter failed transactions
  if (tx.transactionError) {
    stats.filtered_errored++;
    continue;
  }

  let event = null;

  // Primary path
  if (tx.events?.swap) {
    event = extractFromSwapEvent(tx, i);
  }

  // Fallback path
  if (!event) {
    event = extractFromTokenTransfers(tx, i);
  }

  if (!event) {
    stats.filtered_ambiguous++;
    continue;
  }

  events.push(event);

  // Stats
  stats.by_method[event.extraction_method] = (stats.by_method[event.extraction_method] || 0) + 1;
  stats.by_source[event.source] = (stats.by_source[event.source] || 0) + 1;
}

// Write output
writeFileSync(outPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

// Report
console.log(`\n=== Phase 2 — Normalization Report ===`);
console.log(`Raw transactions:     ${stats.total_raw}`);
console.log(`Filtered (not SWAP):  ${stats.filtered_not_swap}`);
console.log(`Filtered (errored):   ${stats.filtered_errored}`);
console.log(`Filtered (ambiguous): ${stats.filtered_ambiguous}`);
console.log(`Normalized events:    ${events.length}`);
console.log(`\nBy extraction method:`);
for (const [k, v] of Object.entries(stats.by_method).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}
console.log(`\nBy source/DEX:`);
for (const [k, v] of Object.entries(stats.by_source).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}
console.log(`\nOutput: ${outPath}`);

// Sample lines
console.log(`\n=== Sample Events (first 5) ===`);
for (let i = 0; i < Math.min(5, events.length); i++) {
  console.log(JSON.stringify(events[i], null, 2));
}
