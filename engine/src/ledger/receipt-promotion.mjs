/**
 * Receipt Promotion — B2
 *
 * Pure function: B1 receipt candidates → canonical v1.2 receipt records.
 *
 * Every candidate is promoted 1:1. Disqualified candidates become "unverified"
 * receipts with limitations explaining why. No candidates are filtered out.
 *
 * This module does NOT:
 *   - Touch v1.1 receipts (pipeline/receipt.mjs)
 *   - Render PNGs, mint NFTs, or upload metadata
 *   - Fetch live prices or normalize to USD
 *   - Use Date.now() — all timestamps are explicit or derived
 */

import { createHash } from 'crypto';

const RECEIPT_VERSION = '1.2.0';

// Flags that force verification_status to "unverified"
const DISQUALIFYING_FLAGS = new Set([
  'partial_history',
  'unsupported_inventory',
  'mixed_quote',
]);

// ═══════════════════════════════════════════════════════════════
// Verification status
// ═══════════════════════════════════════════════════════════════

/**
 * Determine verification_status from candidate type and flags.
 */
function computeVerificationStatus(candidateType, flags) {
  const hasDisqualifier = flags.some(f => DISQUALIFYING_FLAGS.has(f));

  if (hasDisqualifier) return 'unverified';

  switch (candidateType) {
    case 'closed_position':    return 'verified';
    case 'realized_partial':   return 'verified_partial';
    case 'open_snapshot':      return 'verified_snapshot';
    default:                   return 'unverified';
  }
}

/**
 * Map verification_status to human-readable display_status.
 */
function computeDisplayStatus(verificationStatus) {
  switch (verificationStatus) {
    case 'verified':           return 'Verified Closed Position';
    case 'verified_partial':   return 'Verified Partial (Position Open)';
    case 'verified_snapshot':  return 'Verified Snapshot (No PnL Claim)';
    case 'unverified':         return 'Unverified — See Limitations';
    default:                   return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════
// Limitations / disclosures
// ═══════════════════════════════════════════════════════════════

/**
 * Build the structured limitations block for a receipt.
 */
function buildLimitations(candidateType, flags) {
  // Receipt scope
  const receipt_scope = candidateType;

  // PnL type
  let pnl_type;
  switch (candidateType) {
    case 'closed_position':  pnl_type = 'realized_closed';  break;
    case 'realized_partial': pnl_type = 'realized_partial';  break;
    case 'open_snapshot':    pnl_type = 'none';              break;
    default:                 pnl_type = 'none';
  }

  // Price source
  const price_source = candidateType === 'open_snapshot' ? 'none' : 'on_chain_swaps';

  // Disclosures
  const disclosures = [];

  // Global disclosure — always present
  disclosures.push('no_usd_normalization');

  // Type-specific disclosures
  if (candidateType === 'realized_partial') {
    disclosures.push('position_open');
  }
  if (candidateType === 'open_snapshot') {
    disclosures.push('no_pnl_claim');
    disclosures.push('no_live_price');
  }

  // Flag-derived disclosures
  if (flags.includes('mixed_quote'))               disclosures.push('mixed_quote_currencies');
  if (flags.includes('partial_history'))            disclosures.push('partial_trade_history');
  if (flags.includes('unsupported_inventory'))      disclosures.push('unsupported_inventory');
  if (flags.includes('external_transfer_possible')) disclosures.push('external_transfer_possible');

  return {
    receipt_scope,
    pnl_type,
    price_source,
    valuation_currency: 'raw_quote',
    disclosures,
  };
}

// ═══════════════════════════════════════════════════════════════
// Receipt hash
// ═══════════════════════════════════════════════════════════════

/**
 * Compute receipt_hash from canonical payload.
 *
 * Distinct from both v1.1 verification_hash and B1 candidate_hash:
 *   - Includes receipt_version "1.2.0" (v1.1 uses "1.0")
 *   - Includes receipt_type (B1 uses candidate_type)
 *   - Includes verification_status (neither v1.1 nor B1 have this)
 *   - Different field ordering
 *
 * Excludes: display_status (derived), limitations (derived from flags+type),
 *           promoted_at (operational), candidate_hash (traceability only).
 */
export function computeReceiptHash(fields) {
  const payload = JSON.stringify([
    // Schema identity
    fields.receipt_version,
    fields.receipt_type,

    // Core identity
    fields.wallet,
    fields.chain,
    fields.token_mint,
    fields.segment_index,

    // Quote context
    fields.quote_mint,
    fields.quote_symbol,
    fields.valuation_status,

    // Time boundaries
    fields.first_event_at,
    fields.last_event_at,

    // Transaction proof
    fields.entry_tx_hashes,      // pre-sorted
    fields.exit_tx_hashes,       // pre-sorted

    // Full economic state
    fields.total_bought_qty,
    fields.total_bought_quote,
    fields.avg_buy_quote_price,
    fields.total_sold_qty,
    fields.total_sold_quote,
    fields.avg_sell_quote_price,
    fields.allocated_cost_basis_quote,
    fields.remaining_qty,
    fields.remaining_cost_basis_quote,
    fields.realized_pnl_quote,
    fields.realized_pnl_pct,

    // Integrity metadata
    fields.flags,                // sorted
    fields.accounting_method,
    fields.verification_status,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

// ═══════════════════════════════════════════════════════════════
// Receipt ID generation
// ═══════════════════════════════════════════════════════════════

const TYPE_SHORT = {
  closed_position:  'cp',
  realized_partial: 'rp',
  open_snapshot:    'os',
};

function generateReceiptId(candidateType, tokenMint, segmentIndex) {
  const typeShort = TYPE_SHORT[candidateType] || 'xx';
  const mintPrefix = tokenMint.slice(0, 8);
  return `art_v12_${typeShort}_${mintPrefix}_${segmentIndex}`;
}

// ═══════════════════════════════════════════════════════════════
// Single receipt promotion
// ═══════════════════════════════════════════════════════════════

/**
 * Promote a single B1 candidate into a v1.2 receipt record.
 *
 * @param {object} candidate - B1 receipt candidate
 * @param {object} opts - { promotedAt?: number }
 * @returns {object} Canonical v1.2 receipt record
 */
function promoteCandidate(candidate, opts = {}) {
  const flags = [...(candidate.flags || [])].sort();
  const candidateType = candidate.candidate_type;

  const verificationStatus = computeVerificationStatus(candidateType, flags);
  const displayStatus = computeDisplayStatus(verificationStatus);
  const limitations = buildLimitations(candidateType, flags);

  const promotedAt = opts.promotedAt ?? candidate.last_event_at;

  const receiptId = generateReceiptId(candidateType, candidate.token_mint, candidate.segment_index);

  // Hash payload
  const hashFields = {
    receipt_version: RECEIPT_VERSION,
    receipt_type: candidateType,
    wallet: candidate.wallet,
    chain: candidate.chain,
    token_mint: candidate.token_mint,
    segment_index: candidate.segment_index,
    quote_mint: candidate.quote_mint,
    quote_symbol: candidate.quote_symbol,
    valuation_status: 'raw_quote',
    first_event_at: candidate.first_event_at,
    last_event_at: candidate.last_event_at,
    entry_tx_hashes: candidate.entry_tx_hashes,
    exit_tx_hashes: candidate.exit_tx_hashes,
    total_bought_qty: candidate.total_bought_qty,
    total_bought_quote: candidate.total_bought_quote,
    avg_buy_quote_price: candidate.avg_buy_quote_price,
    total_sold_qty: candidate.total_sold_qty,
    total_sold_quote: candidate.total_sold_quote,
    avg_sell_quote_price: candidate.avg_sell_quote_price,
    allocated_cost_basis_quote: candidate.allocated_cost_basis_quote,
    remaining_qty: candidate.remaining_qty,
    remaining_cost_basis_quote: candidate.remaining_cost_basis_quote,
    realized_pnl_quote: candidate.realized_pnl_quote,
    realized_pnl_pct: candidate.realized_pnl_pct,
    flags,
    accounting_method: candidate.accounting_method,
    verification_status: verificationStatus,
  };

  const receiptHash = computeReceiptHash(hashFields);

  return {
    // Identity
    receipt_id: receiptId,
    receipt_version: RECEIPT_VERSION,
    receipt_type: candidateType,

    // Position reference
    token_mint: candidate.token_mint,
    wallet: candidate.wallet,
    chain: candidate.chain,
    segment_index: candidate.segment_index,

    // Verification
    receipt_hash: receiptHash,
    verification_status: verificationStatus,
    display_status: displayStatus,

    // Accounting
    accounting_method: candidate.accounting_method,
    quote_mint: candidate.quote_mint,
    quote_symbol: candidate.quote_symbol,
    valuation_status: 'raw_quote',

    // Buy side
    total_bought_qty: candidate.total_bought_qty,
    total_bought_quote: candidate.total_bought_quote,
    avg_buy_quote_price: candidate.avg_buy_quote_price,

    // Sell side
    total_sold_qty: candidate.total_sold_qty,
    total_sold_quote: candidate.total_sold_quote,
    avg_sell_quote_price: candidate.avg_sell_quote_price,

    // Cost basis
    allocated_cost_basis_quote: candidate.allocated_cost_basis_quote,
    remaining_qty: candidate.remaining_qty,
    remaining_cost_basis_quote: candidate.remaining_cost_basis_quote,

    // PnL
    realized_pnl_quote: candidate.realized_pnl_quote,
    realized_pnl_pct: candidate.realized_pnl_pct,
    unrealized_pnl_quote: null,
    unrealized_pnl_pct: null,

    // Position state
    position_status: candidate.status,

    // Time
    first_event_at: candidate.first_event_at,
    last_event_at: candidate.last_event_at,
    snapshot_at: candidate.snapshot_at,
    hold_time_seconds: candidate.hold_time_seconds,

    // Tx references
    entry_tx_hashes: candidate.entry_tx_hashes,
    exit_tx_hashes: candidate.exit_tx_hashes,
    num_buys: candidate.num_buys,
    num_sells: candidate.num_sells,

    // Limitations
    limitations,

    // Integrity
    flags,
    candidate_hash: candidate.candidate_hash,

    // Provenance
    source: 'position_ledger_v1',
    promoted_at: promotedAt,
    promoted_from: candidate.candidate_id,
    ledger_accounting_version: candidate.ledger_accounting_version,
  };
}

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

/**
 * Promote receipt candidates into canonical v1.2 receipt records.
 *
 * Pure function: no I/O, no Date.now(), fully deterministic.
 * Every candidate is promoted 1:1. No filtering.
 *
 * @param {object[]} candidates - B1 receipt candidates from generateReceiptCandidates
 * @param {object} [opts]
 * @param {number} [opts.promotedAt] - Epoch seconds for promoted_at field.
 *                                      Falls back to candidate.last_event_at if omitted.
 * @returns {object[]} Array of canonical v1.2 receipt records
 */
export function promoteReceiptCandidates(candidates, opts = {}) {
  return candidates.map(c => promoteCandidate(c, opts));
}
