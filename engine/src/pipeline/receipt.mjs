/**
 * Pipeline — Receipt Generator (v1.1)
 *
 * Generates receipts from closed cycles (verified) or custom positions.
 *
 * VERIFIED PATH: Unchanged from v1.
 *   Hash = sha256([wallet, chain, token_mint, sorted_entry_hashes,
 *          sorted_exit_hashes, entry_price_avg, exit_price_avg,
 *          accounting_method, receipt_version, status])
 *
 * CUSTOM PATH: New in v1.1.
 *   Hash = sha256([...same canonical fields..., receipt_type,
 *          base_position_hash, sorted_removed_legs])
 *   Custom receipts always produce a different hash from verified.
 *
 * Status byte mapping (engine convention, program untouched):
 *   0 = verified
 *   1 = verified_mixed_quote
 *   2 = custom
 *   3 = custom_mixed_quote
 */
import { createHash } from 'crypto';
import { CHAIN, ACCOUNTING_METHOD, RECEIPT_VERSION } from './constants.mjs';

// ═══════════════════════════════════════════════════════════════
// Status byte mapping
// ═══════════════════════════════════════════════════════════════

export const STATUS_BYTE = {
  verified: 0,
  verified_mixed_quote: 1,
  custom: 2,
  custom_mixed_quote: 3,
};

export function statusToByte(status) {
  return STATUS_BYTE[status] ?? 0;
}

// ═══════════════════════════════════════════════════════════════
// Verified receipt hash (UNCHANGED from v1)
// ═══════════════════════════════════════════════════════════════

/**
 * Compute verification hash for a verified receipt.
 * Formula is IDENTICAL to v1 — do not modify.
 */
export function computeVerificationHash({ wallet, chain, token_mint, entry_txs, exit_txs, entry_price_avg, exit_price_avg, accounting_method, receipt_version, status }) {
  const entryHashes = entry_txs.map(t => t.tx_hash).sort();
  const exitHashes = exit_txs.map(t => t.tx_hash).sort();
  const payload = JSON.stringify([wallet, chain, token_mint, entryHashes, exitHashes, entry_price_avg, exit_price_avg, accounting_method, receipt_version, status]);
  return createHash('sha256').update(payload).digest('hex');
}

// ═══════════════════════════════════════════════════════════════
// Custom receipt hash (NEW in v1.1)
// ═══════════════════════════════════════════════════════════════

/**
 * Compute hash for a custom receipt.
 * Includes all verified canonical fields PLUS:
 *   - receipt_type ("custom")
 *   - base_position_hash (the verified position's hash)
 *   - removed_legs (sorted tx hashes)
 *
 * This guarantees the custom hash is always different from the verified hash
 * for the same underlying data, because the extra fields are always present.
 */
export function computeCustomHash({ wallet, chain, token_mint, entry_txs, exit_txs, entry_price_avg, exit_price_avg, accounting_method, receipt_version, status, receipt_type, base_position_hash, removed_legs }) {
  const entryHashes = entry_txs.map(t => t.tx_hash).sort();
  const exitHashes = exit_txs.map(t => t.tx_hash).sort();
  const sortedRemovedLegs = [...removed_legs].sort();
  const payload = JSON.stringify([
    wallet, chain, token_mint, entryHashes, exitHashes,
    entry_price_avg, exit_price_avg, accounting_method, receipt_version, status,
    receipt_type, base_position_hash, sortedRemovedLegs,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

// ═══════════════════════════════════════════════════════════════
// buildReceipts — VERIFIED PATH (unchanged from v1)
// ═══════════════════════════════════════════════════════════════

/**
 * Build verified receipts from closed cycles.
 * This function is IDENTICAL to v1 — same inputs produce same hashes.
 *
 * @param {object[]} closedCycles - Cycles with status 'closed'
 * @param {string} wallet - Wallet address
 * @returns {object[]} Receipt objects with verification_hash
 */
export function buildReceipts(closedCycles, wallet) {
  const receipts = [];
  let receiptNum = 0;

  for (const cycle of closedCycles) {
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
    const hashPayload = JSON.stringify([wallet, CHAIN, cycle.base_mint, entryHashes, exitHashes, entryAvg, exitAvg, ACCOUNTING_METHOD, RECEIPT_VERSION, receiptStatus]);
    const verificationHash = createHash('sha256').update(hashPayload).digest('hex');

    const receiptId = `receipt_${String(receiptNum).padStart(4, '0')}_${cycle.base_mint.slice(0, 8)}`;
    const receipt = {
      receipt_id: receiptId, receipt_version: RECEIPT_VERSION, cycle_id: cycle.cycle_id,
      wallet, chain: CHAIN, token_mint: cycle.base_mint, status: receiptStatus,
      receipt_type: 'verified',
      status_byte: statusToByte(receiptStatus),
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

  return receipts;
}

// ═══════════════════════════════════════════════════════════════
// buildPositionReceipt — from position object (NEW in v1.1)
// ═══════════════════════════════════════════════════════════════

/**
 * Build a verified receipt from a position object.
 * Uses the same WACB accounting as buildReceipts.
 *
 * @param {object} position - Position object from position-builder
 * @param {object} opts
 * @param {number} [opts.receiptNum=1] - Receipt number for ID generation
 * @returns {object} Verified receipt
 */
export function buildPositionReceipt(position, { receiptNum = 1 } = {}) {
  const totalBought = position.entries.reduce((s, t) => s + t.amount, 0);
  const totalSold = position.exits.reduce((s, t) => s + t.amount, 0);
  const costBasis = position.entries.reduce((s, t) => s + t.quote_amount, 0);
  const exitProceeds = position.exits.reduce((s, t) => s + t.quote_amount, 0);
  const entryAvg = totalBought > 0 ? costBasis / totalBought : 0;
  const exitAvg = totalSold > 0 ? exitProceeds / totalSold : 0;
  const pnl = exitProceeds - costBasis;
  const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

  // Derive quote currency from all legs
  const quoteMintSet = new Set();
  for (const tx of [...position.entries, ...position.exits]) {
    if (tx.quote_mint) quoteMintSet.add(tx.quote_mint);
  }
  const quoteMints = [...quoteMintSet];
  const quoteCurrency = quoteMints.length === 1 ? quoteMints[0] : 'MIXED';
  const receiptStatus = quoteMints.length === 1 ? 'verified' : 'verified_mixed_quote';

  const stripTx = t => ({ tx_hash: t.tx_hash, timestamp: t.timestamp, amount: t.amount, quote_amount: t.quote_amount });
  const entryTxs = position.entries.map(stripTx);
  const exitTxs = position.exits.map(stripTx);

  const verificationHash = computeVerificationHash({
    wallet: position.wallet, chain: CHAIN, token_mint: position.token,
    entry_txs: entryTxs, exit_txs: exitTxs,
    entry_price_avg: entryAvg, exit_price_avg: exitAvg,
    accounting_method: ACCOUNTING_METHOD, receipt_version: RECEIPT_VERSION,
    status: receiptStatus,
  });

  const receiptId = `receipt_${String(receiptNum).padStart(4, '0')}_${position.token.slice(0, 8)}`;

  return {
    receipt_id: receiptId, receipt_version: RECEIPT_VERSION,
    position_id: position.position_id,
    wallet: position.wallet, chain: CHAIN, token_mint: position.token,
    status: receiptStatus,
    receipt_type: 'verified',
    status_byte: statusToByte(receiptStatus),
    is_custom: false,
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
    remaining_balance: parseFloat((totalBought - totalSold).toFixed(10)),
    num_buys: entryTxs.length, num_sells: exitTxs.length,
    num_cycles: position.num_cycles,
    opened_at: position.start_time,
    closed_at: position.end_time,
    hold_time_seconds: position.duration_sec,
    entry_txs: entryTxs, exit_txs: exitTxs,
    _hash_inputs: { raw_entry_price_avg: entryAvg, raw_exit_price_avg: exitAvg },
    generated_at: Math.floor(Date.now() / 1000),
    verification_hash: verificationHash,
  };
}

// ═══════════════════════════════════════════════════════════════
// buildCustomReceipt — from custom position (NEW in v1.1)
// ═══════════════════════════════════════════════════════════════

/**
 * Build a custom receipt from a custom position.
 *
 * Custom receipts:
 *   - Use a different hash formula (includes receipt_type + base_position_hash + removed_legs)
 *   - Are marked receipt_type: 'custom'
 *   - Include removed_legs and base_position_hash for transparency
 *   - Include integrity warnings when economics are clearly edited
 *   - Never carry a "verified" badge
 *
 * @param {object} customPosition - Custom position from buildCustomPosition
 * @param {string} baseVerifiedHash - The verification_hash of the base verified receipt
 * @param {object} opts
 * @param {number} [opts.receiptNum=1] - Receipt number for ID generation
 * @returns {object} Custom receipt
 */
export function buildCustomReceipt(customPosition, baseVerifiedHash, { receiptNum = 1 } = {}) {
  const totalBought = customPosition.entries.reduce((s, t) => s + t.amount, 0);
  const totalSold = customPosition.exits.reduce((s, t) => s + t.amount, 0);
  const costBasis = customPosition.entries.reduce((s, t) => s + t.quote_amount, 0);
  const exitProceeds = customPosition.exits.reduce((s, t) => s + t.quote_amount, 0);
  const entryAvg = totalBought > 0 ? costBasis / totalBought : 0;
  const exitAvg = totalSold > 0 ? exitProceeds / totalSold : 0;
  const pnl = exitProceeds - costBasis;
  const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

  // Derive quote currency
  const quoteMintSet = new Set();
  for (const tx of [...customPosition.entries, ...customPosition.exits]) {
    if (tx.quote_mint) quoteMintSet.add(tx.quote_mint);
  }
  const quoteMints = [...quoteMintSet];
  const quoteCurrency = quoteMints.length === 1 ? quoteMints[0] : 'MIXED';
  const isMixed = quoteMints.length !== 1;
  const receiptStatus = isMixed ? 'custom_mixed_quote' : 'custom';

  const stripTx = t => ({ tx_hash: t.tx_hash, timestamp: t.timestamp, amount: t.amount, quote_amount: t.quote_amount });
  const entryTxs = customPosition.entries.map(stripTx);
  const exitTxs = customPosition.exits.map(stripTx);

  const sortedRemovedLegs = [...customPosition.removed_legs].sort();

  // Custom hash: includes receipt_type + base_position_hash + removed_legs
  const customHash = computeCustomHash({
    wallet: customPosition.wallet, chain: CHAIN, token_mint: customPosition.token,
    entry_txs: entryTxs, exit_txs: exitTxs,
    entry_price_avg: entryAvg, exit_price_avg: exitAvg,
    accounting_method: ACCOUNTING_METHOD, receipt_version: RECEIPT_VERSION,
    status: receiptStatus,
    receipt_type: 'custom',
    base_position_hash: baseVerifiedHash,
    removed_legs: sortedRemovedLegs,
  });

  // ── Integrity warnings ──
  const warnings = [];

  if (totalSold > totalBought * 1.001) {
    warnings.push(`sold_exceeds_bought: total_sold (${totalSold.toFixed(6)}) > total_bought (${totalBought.toFixed(6)}) — entry legs were removed`);
  }

  if (totalBought > 0 && totalSold === 0) {
    warnings.push('no_exits: all exit legs were removed — no realized PnL');
  }

  if (totalSold > 0 && totalBought === 0) {
    warnings.push('no_entries: all entry legs were removed — cost basis is zero');
  }

  if (entryTxs.length === 0 && exitTxs.length > 0) {
    warnings.push('orphaned_exits: exits exist without any entries');
  }

  if (Math.abs(pnlPct) > 200) {
    warnings.push(`extreme_pnl: ${pnlPct.toFixed(1)}% — likely due to removed legs distorting economics`);
  }

  const receiptId = `receipt_${String(receiptNum).padStart(4, '0')}_${customPosition.token.slice(0, 8)}_custom`;

  const receipt = {
    receipt_id: receiptId, receipt_version: RECEIPT_VERSION,
    position_id: customPosition.position_id,
    base_position_id: customPosition.base_position_id,
    base_position_hash: baseVerifiedHash,
    wallet: customPosition.wallet, chain: CHAIN, token_mint: customPosition.token,
    status: receiptStatus,
    receipt_type: 'custom',
    status_byte: statusToByte(receiptStatus),
    is_custom: true,
    removed_legs: sortedRemovedLegs,
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
    remaining_balance: parseFloat((totalBought - totalSold).toFixed(10)),
    num_buys: entryTxs.length, num_sells: exitTxs.length,
    num_cycles: customPosition.num_cycles,
    opened_at: customPosition.start_time,
    closed_at: customPosition.end_time,
    hold_time_seconds: customPosition.duration_sec,
    entry_txs: entryTxs, exit_txs: exitTxs,
    _hash_inputs: { raw_entry_price_avg: entryAvg, raw_exit_price_avg: exitAvg },
    generated_at: Math.floor(Date.now() / 1000),
    verification_hash: customHash,
  };

  // Only include warnings if there are any
  if (warnings.length > 0) {
    receipt.integrity_warnings = warnings;
  }

  return receipt;
}
