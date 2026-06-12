/**
 * Receipt Candidate Generator — B1
 *
 * Pure function: ledger output → receipt candidate objects.
 *
 * Candidate types:
 *   - closed_position:   fully closed position from ledger closedSegments
 *   - realized_partial:  open position with some realized PnL (partial sells)
 *   - open_snapshot:     open position with no sells (pure hold)
 *
 * Candidates are NOT receipts. They describe what *could* become a receipt
 * when a later promotion step (B2/C) explicitly converts them.
 *
 * This module does NOT:
 *   - Call computeVerificationHash or buildReceipts (v1.1)
 *   - Render PNGs, mint NFTs, or upload metadata
 *   - Fetch live prices or normalize to USD
 *   - Use Date.now() — all timestamps are explicit or derived from events
 *
 * Wallet assumption: the pipeline is single-wallet by construction.
 * The wallet parameter is trusted from the caller. If a future multi-wallet
 * mode is added, validation must happen at the normalizer level.
 */

import { createHash } from 'crypto';

const CANDIDATE_VERSION = '1.2.0';
const DEFAULT_CHAIN = 'solana';
const ACCOUNTING_METHOD = 'weighted_average_position_accounting_v1';

// Flags that downgrade both eligibility fields to false
const DISQUALIFYING_FLAGS = new Set([
  'partial_history',
  'unsupported_inventory',
  'mixed_quote',
]);

// ═══════════════════════════════════════════════════════════════
// Canonical hash
// ═══════════════════════════════════════════════════════════════

/**
 * Compute candidate_hash from the canonical economic payload.
 *
 * Includes full economic state + flags (which affect eligibility meaning).
 * Excludes: warnings (derived from flags+type, human-readable only),
 *           candidate_hash itself, eligibility booleans (derived).
 *
 * @param {object} fields - Canonical fields for hashing
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function computeCandidateHash(fields) {
  const payload = JSON.stringify([
    fields.candidate_type,
    fields.candidate_version,
    fields.wallet,
    fields.chain,
    fields.token_mint,
    fields.quote_mint,
    fields.quote_symbol,
    fields.valuation_status,
    fields.segment_index,
    fields.first_event_at,
    fields.last_event_at,
    fields.entry_tx_hashes,     // pre-sorted by caller
    fields.exit_tx_hashes,      // pre-sorted by caller
    fields.total_bought_qty,
    fields.total_bought_quote,
    fields.total_sold_qty,
    fields.total_sold_quote,
    fields.allocated_cost_basis_quote,
    fields.remaining_qty,
    fields.remaining_cost_basis_quote,
    fields.realized_pnl_quote,
    fields.realized_pnl_pct,
    fields.flags,               // sorted array
    fields.accounting_method,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

// ═══════════════════════════════════════════════════════════════
// Warning derivation
// ═══════════════════════════════════════════════════════════════

/**
 * Derive human-readable warnings from flags and candidate type.
 * Warnings are NOT included in the candidate hash.
 */
function deriveWarnings(flags, candidateType) {
  const warnings = [];

  // Flag-derived warnings (apply to all types)
  if (flags.includes('mixed_quote'))              warnings.push('mixed_quote_not_verified');
  if (flags.includes('partial_history'))           warnings.push('partial_history_pnl_unreliable');
  if (flags.includes('unsupported_inventory'))     warnings.push('unsupported_inventory_detected');
  if (flags.includes('external_transfer_possible')) warnings.push('external_transfer_possible');

  // Type-derived warnings
  if (candidateType === 'realized_partial') {
    warnings.push('position_still_open');
  }
  if (candidateType === 'open_snapshot') {
    warnings.push('no_realized_pnl');
    warnings.push('snapshot_no_live_price');
  }

  return warnings;
}

// ═══════════════════════════════════════════════════════════════
// Eligibility
// ═══════════════════════════════════════════════════════════════

/**
 * Compute eligibility flags for a candidate.
 *
 * Disqualifying flags (partial_history, unsupported_inventory, mixed_quote)
 * set both eligibility fields to false regardless of type.
 */
function computeEligibility(flags, candidateType) {
  const hasDisqualifier = flags.some(f => DISQUALIFYING_FLAGS.has(f));

  if (hasDisqualifier) {
    return {
      eligible_for_verified_receipt: false,
      eligible_for_closed_position_receipt: false,
    };
  }

  switch (candidateType) {
    case 'closed_position':
      return {
        eligible_for_verified_receipt: true,
        eligible_for_closed_position_receipt: true,
      };
    case 'realized_partial':
      return {
        eligible_for_verified_receipt: true,
        eligible_for_closed_position_receipt: false,
      };
    case 'open_snapshot':
      return {
        eligible_for_verified_receipt: true,
        eligible_for_closed_position_receipt: false,
      };
    default:
      return {
        eligible_for_verified_receipt: false,
        eligible_for_closed_position_receipt: false,
      };
  }
}

// ═══════════════════════════════════════════════════════════════
// Tx hash extraction
// ═══════════════════════════════════════════════════════════════

/**
 * Extract sorted entry/exit tx hashes and counts from ledger events.
 */
function extractTxInfo(events) {
  const entryHashes = [];
  const exitHashes = [];
  let numBuys = 0;
  let numSells = 0;

  for (const ev of events) {
    if (ev.action === 'buy') {
      entryHashes.push(ev.tx_hash);
      numBuys++;
    } else if (ev.action === 'sell') {
      exitHashes.push(ev.tx_hash);
      numSells++;
    }
  }

  return {
    entry_tx_hashes: entryHashes.sort(),
    exit_tx_hashes: exitHashes.sort(),
    num_buys: numBuys,
    num_sells: numSells,
  };
}

// ═══════════════════════════════════════════════════════════════
// Candidate builder (single position)
// ═══════════════════════════════════════════════════════════════

/**
 * Build a single receipt candidate from a finalized ledger position.
 *
 * @param {object} position - Finalized position from ledger (closedSegment or positionsByMint entry)
 * @param {string} candidateType - "closed_position" | "realized_partial" | "open_snapshot"
 * @param {string} wallet - Wallet address (trusted from caller)
 * @param {object} opts - { chain?, snapshotAt? }
 * @returns {object} Receipt candidate
 */
function buildCandidate(position, candidateType, wallet, opts = {}) {
  const chain = opts.chain || DEFAULT_CHAIN;
  const flags = [...(position.flags || [])].sort();
  const txInfo = extractTxInfo(position.events || []);

  // Type-dependent fields
  const isSnapshot = candidateType === 'open_snapshot';
  const holdTimeSeconds = (!isSnapshot && position.first_event_at && position.last_event_at)
    ? position.last_event_at - position.first_event_at
    : null;

  let snapshotAt = null;
  if (isSnapshot) {
    snapshotAt = opts.snapshotAt ?? position.last_event_at;
  }

  // Candidate ID
  const mintPrefix = position.token_mint.slice(0, 8);
  const candidateId = `lrc_${candidateType}_${mintPrefix}_${position.segment_index}`;

  // Eligibility + warnings
  const eligibility = computeEligibility(flags, candidateType);
  const warnings = deriveWarnings(flags, candidateType);

  // Hash payload fields
  const hashFields = {
    candidate_type: candidateType,
    candidate_version: CANDIDATE_VERSION,
    wallet,
    chain,
    token_mint: position.token_mint,
    quote_mint: position.quote_mint,
    quote_symbol: position.quote_symbol,
    valuation_status: 'raw_quote',
    segment_index: position.segment_index,
    first_event_at: position.first_event_at,
    last_event_at: position.last_event_at,
    entry_tx_hashes: txInfo.entry_tx_hashes,
    exit_tx_hashes: txInfo.exit_tx_hashes,
    total_bought_qty: position.total_bought_qty,
    total_bought_quote: position.total_bought_quote,
    total_sold_qty: isSnapshot ? null : position.total_sold_qty,
    total_sold_quote: isSnapshot ? null : position.total_sold_quote,
    allocated_cost_basis_quote: isSnapshot ? null : position.allocated_cost_basis_quote,
    remaining_qty: position.remaining_qty,
    remaining_cost_basis_quote: position.remaining_cost_basis_quote,
    realized_pnl_quote: isSnapshot ? null : position.realized_pnl_quote,
    realized_pnl_pct: isSnapshot ? null : position.realized_pnl_pct,
    flags,
    accounting_method: position.accounting_method_version || ACCOUNTING_METHOD,
  };

  const candidateHash = computeCandidateHash(hashFields);

  return {
    // Identity
    candidate_id: candidateId,
    candidate_type: candidateType,
    candidate_version: CANDIDATE_VERSION,

    // Position reference
    token_mint: position.token_mint,
    wallet,
    chain,
    segment_index: position.segment_index,

    // Accounting
    accounting_method: position.accounting_method_version || ACCOUNTING_METHOD,
    quote_mint: position.quote_mint,
    quote_symbol: position.quote_symbol,
    valuation_status: 'raw_quote',

    // Buy side
    total_bought_qty: position.total_bought_qty,
    total_bought_quote: position.total_bought_quote,
    avg_buy_quote_price: position.avg_buy_quote_price,

    // Sell side
    total_sold_qty: isSnapshot ? null : position.total_sold_qty,
    total_sold_quote: isSnapshot ? null : position.total_sold_quote,
    avg_sell_quote_price: isSnapshot ? null : position.avg_sell_quote_price,

    // Cost basis
    allocated_cost_basis_quote: isSnapshot ? null : position.allocated_cost_basis_quote,
    remaining_qty: position.remaining_qty,
    remaining_cost_basis_quote: position.remaining_cost_basis_quote,

    // PnL
    realized_pnl_quote: isSnapshot ? null : position.realized_pnl_quote,
    realized_pnl_pct: isSnapshot ? null : position.realized_pnl_pct,
    unrealized_pnl_quote: null,
    unrealized_pnl_pct: null,

    // Position state
    status: position.status,

    // Time
    first_event_at: position.first_event_at,
    last_event_at: position.last_event_at,
    snapshot_at: snapshotAt,
    hold_time_seconds: holdTimeSeconds,

    // Tx references
    entry_tx_hashes: txInfo.entry_tx_hashes,
    exit_tx_hashes: txInfo.exit_tx_hashes,
    num_buys: txInfo.num_buys,
    num_sells: txInfo.num_sells,

    // Eligibility
    receipt_scope: candidateType,
    eligible_for_verified_receipt: eligibility.eligible_for_verified_receipt,
    eligible_for_closed_position_receipt: eligibility.eligible_for_closed_position_receipt,

    // Integrity
    candidate_hash: candidateHash,
    flags,
    warnings,

    // Provenance
    source: 'position_ledger_v1',
    ledger_accounting_version: position.accounting_method_version || ACCOUNTING_METHOD,
  };
}

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

/**
 * Generate receipt candidates from ledger output.
 *
 * Pure function: no I/O, no Date.now(), fully deterministic.
 *
 * @param {object} ledgerResult - Return value of buildPositionLedger
 * @param {string} wallet - Wallet address (trusted, single-wallet pipeline)
 * @param {object} [opts]
 * @param {number} [opts.snapshotAt] - Epoch seconds for open_snapshot candidates.
 *                                      Falls back to position.last_event_at if omitted.
 * @param {string} [opts.chain="solana"]
 * @returns {object[]} Array of receipt candidate objects
 */
export function generateReceiptCandidates(ledgerResult, wallet, opts = {}) {
  const candidates = [];

  // 1. Closed segments → closed_position candidates
  for (const segment of ledgerResult.closedSegments) {
    if (segment.total_bought_qty > 0 && segment.total_sold_qty > 0) {
      candidates.push(buildCandidate(segment, 'closed_position', wallet, opts));
    }
  }

  // 2. Open positions → realized_partial or open_snapshot
  for (const [, position] of ledgerResult.positionsByMint) {
    if (position.status !== 'open' && position.status !== 'partial_history') continue;

    if (position.total_sold_qty > 0) {
      // Has some sells → realized_partial
      candidates.push(buildCandidate(position, 'realized_partial', wallet, opts));
    } else {
      // No sells → open_snapshot
      candidates.push(buildCandidate(position, 'open_snapshot', wallet, opts));
    }
  }

  return candidates;
}
