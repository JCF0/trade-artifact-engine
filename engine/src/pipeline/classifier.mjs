/**
 * Pipeline â€” Transaction Classifier
 *
 * Classifies every transaction into an explicit bucket.
 * No silent drops. Every tx gets a classification.
 *
 * Classifications:
 *   classified         â€” clean swap with one quote-mint side, fully processable
 *   token_to_token     â€” swap where neither side is a known quote mint
 *   quote_to_quote     â€” swap between two quote mints (e.g., SOLâ†’USDC)
 *   multi_leg          â€” swap with multiple token inputs or outputs
 *   unsupported_swap   â€” identified as swap but extraction failed
 *   errored            â€” transaction had an error on-chain
 *   non_swap           â€” not a swap transaction (transfer, NFT mint, etc.)
 *   unknown            â€” can't determine what this transaction is
 *
 * The classifier wraps the existing normalizer and reconstructor,
 * adding classification metadata without changing their behavior.
 */
import { QUOTE_MINTS, SYMS, SOL_MINT } from './constants.mjs';
import {
  aggregateSameMintInputsFromSwapEvent,
  aggregateSameMintInputsFromWalletTransfers,
} from './same-mint-input-aggregation.mjs';

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Classification types
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export const CLASSIFICATION = {
  CLASSIFIED: 'classified',
  TOKEN_TO_TOKEN: 'token_to_token',
  QUOTE_TO_QUOTE: 'quote_to_quote',
  MULTI_LEG: 'multi_leg',
  UNSUPPORTED_SWAP: 'unsupported_swap',
  ERRORED: 'errored',
  NON_SWAP: 'non_swap',
  UNKNOWN: 'unknown',
};

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// classifyTransaction â€” single tx classification
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * Classify a single raw Helius transaction.
 *
 * @param {object} tx - Raw Helius transaction
 * @param {number} index - Index in the batch
 * @param {string} wallet - Wallet address
 * @param {Set<string>} dexPrograms - Known DEX program IDs
 * @returns {object} { classification, reason, tx_hash, timestamp, type, swap_detail? }
 */
export function classifyTransaction(tx, index, wallet, dexPrograms) {
  const base = {
    tx_hash: tx.signature,
    timestamp: tx.timestamp,
    helius_type: tx.type,
    raw_index: index,
  };

  // 1. Errored transactions
  if (tx.transactionError) {
    return { ...base, classification: CLASSIFICATION.ERRORED, reason: 'on-chain transaction error' };
  }

  // 2. Check if this is a swap
  const isSwapType = tx.type === 'SWAP';
  const touchesDex = txTouchesDex(tx, dexPrograms);
  const hasSwapEvent = !!(tx.events?.swap);

  if (!isSwapType && !touchesDex) {
    return { ...base, classification: CLASSIFICATION.NON_SWAP, reason: `helius_type=${tx.type}` };
  }

  // It's swap-related â€” try to extract the swap details
  const swapDetail = extractSwapDetail(tx, wallet);

  if (!swapDetail) {
    // Swap-related but couldn't extract clean input/output
    if (hasSwapEvent) {
      const sw = tx.events.swap;
      const numInputs = (sw.tokenInputs?.length || 0) + (sw.nativeInput ? 1 : 0);
      const numOutputs = (sw.tokenOutputs?.length || 0) + (sw.nativeOutput ? 1 : 0);
      if (numInputs > 1 || numOutputs > 1) {
        return {
          ...base,
          classification: CLASSIFICATION.MULTI_LEG,
          reason: `${numInputs} inputs, ${numOutputs} outputs`,
          inputs: numInputs,
          outputs: numOutputs,
        };
      }
    }
    return { ...base, classification: CLASSIFICATION.UNSUPPORTED_SWAP, reason: 'swap extraction failed' };
  }

  // We have a clean swap. Now classify by mint types.
  const inIsQuote = QUOTE_MINTS.has(swapDetail.token_in_mint);
  const outIsQuote = QUOTE_MINTS.has(swapDetail.token_out_mint);

  if (inIsQuote && outIsQuote) {
    return {
      ...base,
      classification: CLASSIFICATION.QUOTE_TO_QUOTE,
      reason: `${symOf(swapDetail.token_in_mint)}â†’${symOf(swapDetail.token_out_mint)}`,
      swap_detail: swapDetail,
    };
  }

  if (!inIsQuote && !outIsQuote) {
    return {
      ...base,
      classification: CLASSIFICATION.TOKEN_TO_TOKEN,
      reason: `${symOf(swapDetail.token_in_mint)}â†’${symOf(swapDetail.token_out_mint)} (no quote mint)`,
      swap_detail: swapDetail,
    };
  }

  // One side is quote, one is token â€” fully classified
  return {
    ...base,
    classification: CLASSIFICATION.CLASSIFIED,
    reason: inIsQuote
      ? `BUY ${symOf(swapDetail.token_out_mint)} with ${symOf(swapDetail.token_in_mint)}`
      : `SELL ${symOf(swapDetail.token_in_mint)} for ${symOf(swapDetail.token_out_mint)}`,
    swap_detail: swapDetail,
  };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// classifyAll â€” batch classification with coverage stats
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * Classify all transactions for a wallet.
 *
 * @param {object[]} rawTxns - Raw Helius transactions
 * @param {string} wallet - Wallet address
 * @param {Set<string>} dexPrograms - Known DEX program IDs
 * @returns {{ classifications: object[], coverage: object }}
 */
export function classifyAll(rawTxns, wallet, dexPrograms) {
  const classifications = [];
  const counts = {};

  for (const key of Object.values(CLASSIFICATION)) {
    counts[key] = 0;
  }

  for (let i = 0; i < rawTxns.length; i++) {
    const result = classifyTransaction(rawTxns[i], i, wallet, dexPrograms);
    classifications.push(result);
    counts[result.classification] = (counts[result.classification] || 0) + 1;
  }

  const total = rawTxns.length;
  const swapRelated = total - counts[CLASSIFICATION.NON_SWAP] - counts[CLASSIFICATION.ERRORED];
  const fullyClassified = counts[CLASSIFICATION.CLASSIFIED];

  const coverage = {
    total_transactions: total,
    swap_related: swapRelated,
    fully_classified: fullyClassified,
    coverage_pct: total > 0 ? parseFloat(((fullyClassified / total) * 100).toFixed(1)) : 0,
    swap_coverage_pct: swapRelated > 0 ? parseFloat(((fullyClassified / swapRelated) * 100).toFixed(1)) : 0,
    breakdown: { ...counts },
    unprocessable: {
      token_to_token: counts[CLASSIFICATION.TOKEN_TO_TOKEN],
      quote_to_quote: counts[CLASSIFICATION.QUOTE_TO_QUOTE],
      multi_leg: counts[CLASSIFICATION.MULTI_LEG],
      unsupported_swap: counts[CLASSIFICATION.UNSUPPORTED_SWAP],
      unknown: counts[CLASSIFICATION.UNKNOWN],
    },
  };

  return { classifications, coverage };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// formatCoverageReport â€” human-readable summary
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * Format a coverage report as a human-readable string.
 * @param {object} coverage - Coverage object from classifyAll
 * @returns {string}
 */
export function formatCoverageReport(coverage) {
  const c = coverage;
  const b = c.breakdown;
  const lines = [
    `â”€â”€ Coverage Report â”€â”€`,
    `  Total transactions:    ${c.total_transactions}`,
    `  Swap-related:          ${c.swap_related}`,
    `  Fully classified:      ${c.fully_classified} (${c.coverage_pct}% of all, ${c.swap_coverage_pct}% of swaps)`,
    ``,
    `  Breakdown:`,
    `    classified:          ${b.classified}`,
    `    token_to_token:      ${b.token_to_token}`,
    `    quote_to_quote:      ${b.quote_to_quote}`,
    `    multi_leg:           ${b.multi_leg}`,
    `    unsupported_swap:    ${b.unsupported_swap}`,
    `    errored:             ${b.errored}`,
    `    non_swap:            ${b.non_swap}`,
    `    unknown:             ${b.unknown}`,
  ];

  const unproc = c.unprocessable;
  const unprocTotal = unproc.token_to_token + unproc.quote_to_quote + unproc.multi_leg + unproc.unsupported_swap + unproc.unknown;
  if (unprocTotal > 0) {
    lines.push(``);
    lines.push(`  âš ï¸  ${unprocTotal} swap(s) not processable:`);
    if (unproc.token_to_token > 0) lines.push(`    â€¢ ${unproc.token_to_token} token-to-token (no quote mint on either side)`);
    if (unproc.quote_to_quote > 0) lines.push(`    â€¢ ${unproc.quote_to_quote} quote-to-quote (e.g., SOLâ†”USDC)`);
    if (unproc.multi_leg > 0)      lines.push(`    â€¢ ${unproc.multi_leg} multi-leg (multiple inputs/outputs)`);
    if (unproc.unsupported_swap > 0) lines.push(`    â€¢ ${unproc.unsupported_swap} unsupported swap (extraction failed)`);
    if (unproc.unknown > 0)        lines.push(`    â€¢ ${unproc.unknown} unknown`);
  }

  return lines.join('\n');
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Helpers (shared with ingest.mjs logic, duplicated to avoid circular deps)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function txTouchesDex(tx, dexPrograms) {
  for (const ix of (tx.instructions || [])) {
    if (dexPrograms.has(ix.programId)) return true;
    for (const inner of (ix.innerInstructions || [])) {
      if (dexPrograms.has(inner.programId)) return true;
    }
  }
  return false;
}

function extractSwapDetail(tx, wallet) {
  // Primary: Helius events.swap
  if (tx.events?.swap) {
    const sw = tx.events.swap;
    let inMint, inAmt, inDec, outMint, outAmt, outDec;

    if (sw.nativeInput) {
      inMint = SOL_MINT; inDec = 9; inAmt = Number(sw.nativeInput.amount) / 1e9;
    } else if (sw.tokenInputs?.length === 1) {
      const ti = sw.tokenInputs[0];
      inMint = ti.mint; inDec = ti.rawTokenAmount?.decimals ?? null;
      inAmt = Number(ti.rawTokenAmount.tokenAmount) / Math.pow(10, inDec || 0);
    }

    if (sw.nativeOutput) {
      outMint = SOL_MINT; outDec = 9; outAmt = Number(sw.nativeOutput.amount) / 1e9;
    } else if (sw.tokenOutputs?.length === 1) {
      const to = sw.tokenOutputs[0];
      outMint = to.mint; outDec = to.rawTokenAmount?.decimals ?? null;
      outAmt = Number(to.rawTokenAmount.tokenAmount) / Math.pow(10, outDec || 0);
    }

    if (inMint && outMint) {
      return { token_in_mint: inMint, token_in_amount: inAmt, token_in_decimals: inDec, token_out_mint: outMint, token_out_amount: outAmt, token_out_decimals: outDec };
    }

    const aggregated = aggregateSameMintInputsFromSwapEvent(sw);
    return aggregated.ok ? aggregated.event_fields : null;
  }

  // Fallback: token-transfer analysis
  const sent = (tx.tokenTransfers || []).filter(t => t.fromUserAccount === wallet);
  const recv = (tx.tokenTransfers || []).filter(t => t.toUserAccount === wallet);

  let nativeSent = 0, nativeRecv = 0;
  for (const nt of (tx.nativeTransfers || [])) {
    if (nt.fromUserAccount === wallet) nativeSent += nt.amount;
    if (nt.toUserAccount === wallet) nativeRecv += nt.amount;
  }
  const netNative = nativeRecv - nativeSent;

  if (sent.length === 1 && recv.length === 1 && sent[0].mint !== recv[0].mint) {
    return {
      token_in_mint: sent[0].mint || SOL_MINT,
      token_in_amount: Math.abs(sent[0].tokenAmount),
      token_in_decimals: null,
      token_out_mint: recv[0].mint || SOL_MINT,
      token_out_amount: Math.abs(recv[0].tokenAmount),
      token_out_decimals: null,
    };
  }

  const aggregated = aggregateSameMintInputsFromWalletTransfers(tx, wallet);
  if (aggregated.ok) return aggregated.event_fields;

  if (sent.length === 1 && recv.length === 0 && netNative > 0) {
    const solReceived = netNative / 1e9;
    if (solReceived >= 0.001) {
      return {
        token_in_mint: sent[0].mint,
        token_in_amount: Math.abs(sent[0].tokenAmount),
        token_in_decimals: null,
        token_out_mint: SOL_MINT,
        token_out_amount: solReceived,
        token_out_decimals: 9,
      };
    }
  }

  if (sent.length === 0 && recv.length === 1 && netNative < 0) {
    const solSent = Math.abs(netNative) / 1e9;
    if (solSent >= 0.001) {
      return {
        token_in_mint: SOL_MINT,
        token_in_amount: solSent,
        token_in_decimals: 9,
        token_out_mint: recv[0].mint,
        token_out_amount: Math.abs(recv[0].tokenAmount),
        token_out_decimals: null,
      };
    }
  }

  return null;
}

function symOf(mint) {
  return SYMS[mint] || mint?.slice(0, 8) || '???';
}
