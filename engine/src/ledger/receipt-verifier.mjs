/**
 * Receipt Verifier — B3
 *
 * Pure function: v1.2 receipt records → verification results.
 *
 * Recomputes receipt_hash, validates schema, checks type-specific
 * field constraints, verifies status/disclosure consistency,
 * and enforces valuation boundary rules (V-* from C1).
 *
 * This module does NOT:
 *   - Fix or modify receipts (report-only)
 *   - Create, promote, or filter candidates
 *   - Touch v1.1 receipts
 *   - Render PNGs, mint NFTs, or upload metadata
 *   - Fetch live prices or normalize to USD
 *   - Use Date.now() — fully deterministic
 */

import { computeReceiptHash } from './receipt-promotion.mjs';
import { validateReceiptValuation } from './valuation.mjs';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const VALID_RECEIPT_TYPES = new Set([
  'closed_position',
  'realized_partial',
  'open_snapshot',
]);

const VALID_VERIFICATION_STATUSES = new Set([
  'verified',
  'verified_partial',
  'verified_snapshot',
  'unverified',
]);

const DISQUALIFYING_FLAGS = new Set([
  'partial_history',
  'unsupported_inventory',
  'mixed_quote',
]);

const DISPLAY_STATUS_MAP = {
  verified:          'Verified Closed Position',
  verified_partial:  'Verified Partial (Position Open)',
  verified_snapshot: 'Verified Snapshot (No PnL Claim)',
  unverified:        'Unverified — See Limitations',
};

const PNL_TYPE_MAP = {
  closed_position:  'realized_closed',
  realized_partial: 'realized_partial',
  open_snapshot:    'none',
};

const PRICE_SOURCE_MAP = {
  closed_position:  'on_chain_swaps',
  realized_partial: 'on_chain_swaps',
  open_snapshot:    'none',
};

// Matches position-ledger dust constants for CP-6 validation.
// Using total_bought_qty as peak proxy (always >= actual peak).
const DUST_ABS = 0.001;
const DUST_PCT = 0.001;

// ═══════════════════════════════════════════════════════════════
// Expected disclosure derivation (for C-20)
// ═══════════════════════════════════════════════════════════════

/**
 * Derive the complete set of disclosures that SHOULD exist
 * given a receipt_type and flags. Used for the inverse check (C-20).
 */
function deriveExpectedDisclosures(receiptType, flags) {
  const expected = new Set(['no_usd_normalization']);

  if (receiptType === 'realized_partial') {
    expected.add('position_open');
  }
  if (receiptType === 'open_snapshot') {
    expected.add('no_pnl_claim');
    expected.add('no_live_price');
  }

  if (flags.includes('mixed_quote'))               expected.add('mixed_quote_currencies');
  if (flags.includes('partial_history'))            expected.add('partial_trade_history');
  if (flags.includes('unsupported_inventory'))      expected.add('unsupported_inventory');
  if (flags.includes('external_transfer_possible')) expected.add('external_transfer_possible');

  return expected;
}

// ═══════════════════════════════════════════════════════════════
// verifyReceipt
// ═══════════════════════════════════════════════════════════════

/**
 * Verify a single v1.2 receipt record.
 *
 * Pure function: no I/O, no Date.now(), fully deterministic.
 *
 * @param {object} receipt - Canonical v1.2 receipt from promoteReceiptCandidates
 * @returns {VerificationResult}
 */
export function verifyReceipt(receipt) {
  const violations = [];

  function viol(rule, message, severity = 'error') {
    violations.push({ rule, message, severity });
  }

  // ═══ HASH recomputation ═══
  const hashFields = {
    receipt_version:            receipt.receipt_version,
    receipt_type:               receipt.receipt_type,
    wallet:                     receipt.wallet,
    chain:                      receipt.chain,
    token_mint:                 receipt.token_mint,
    segment_index:              receipt.segment_index,
    quote_mint:                 receipt.quote_mint,
    quote_symbol:               receipt.quote_symbol,
    valuation_status:           receipt.valuation_status,
    first_event_at:             receipt.first_event_at,
    last_event_at:              receipt.last_event_at,
    entry_tx_hashes:            receipt.entry_tx_hashes,
    exit_tx_hashes:             receipt.exit_tx_hashes,
    total_bought_qty:           receipt.total_bought_qty,
    total_bought_quote:         receipt.total_bought_quote,
    avg_buy_quote_price:        receipt.avg_buy_quote_price,
    total_sold_qty:             receipt.total_sold_qty,
    total_sold_quote:           receipt.total_sold_quote,
    avg_sell_quote_price:       receipt.avg_sell_quote_price,
    allocated_cost_basis_quote: receipt.allocated_cost_basis_quote,
    remaining_qty:              receipt.remaining_qty,
    remaining_cost_basis_quote: receipt.remaining_cost_basis_quote,
    realized_pnl_quote:         receipt.realized_pnl_quote,
    realized_pnl_pct:           receipt.realized_pnl_pct,
    flags:                      receipt.flags,
    accounting_method:          receipt.accounting_method,
    verification_status:        receipt.verification_status,
  };

  const recomputed = computeReceiptHash(hashFields);
  const hashValid = receipt.receipt_hash === recomputed;
  if (!hashValid) {
    viol('HASH', `receipt_hash mismatch: got ${receipt.receipt_hash?.slice(0, 16)}…, expected ${recomputed.slice(0, 16)}…`);
  }

  // ═══ SCHEMA validation (S-*) ═══

  if (receipt.receipt_version !== '1.2.0')
    viol('S-1', `receipt_version must be "1.2.0", got "${receipt.receipt_version}"`);

  if (!VALID_RECEIPT_TYPES.has(receipt.receipt_type))
    viol('S-2', `receipt_type invalid: "${receipt.receipt_type}"`);

  if (typeof receipt.receipt_hash !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.receipt_hash))
    viol('S-3', 'receipt_hash must be 64-char hex string');

  if (typeof receipt.wallet !== 'string' || receipt.wallet.length === 0)
    viol('S-4', 'wallet must be non-empty string');

  if (typeof receipt.chain !== 'string' || receipt.chain.length === 0)
    viol('S-5', 'chain must be non-empty string');

  if (typeof receipt.token_mint !== 'string' || receipt.token_mint.length === 0)
    viol('S-6', 'token_mint must be non-empty string');

  if (!Number.isInteger(receipt.segment_index) || receipt.segment_index < 0)
    viol('S-7', `segment_index must be non-negative integer, got ${receipt.segment_index}`);

  if (typeof receipt.first_event_at !== 'number' || receipt.first_event_at <= 0)
    viol('S-8', `first_event_at must be positive number, got ${receipt.first_event_at}`);

  if (typeof receipt.last_event_at !== 'number' || receipt.last_event_at < receipt.first_event_at)
    viol('S-9', `last_event_at (${receipt.last_event_at}) must be >= first_event_at (${receipt.first_event_at})`);

  if (typeof receipt.total_bought_qty !== 'number' || receipt.total_bought_qty <= 0)
    viol('S-10', `total_bought_qty must be > 0, got ${receipt.total_bought_qty}`);

  if (typeof receipt.total_bought_quote !== 'number' || receipt.total_bought_quote <= 0)
    viol('S-11', `total_bought_quote must be > 0, got ${receipt.total_bought_quote}`);

  if (typeof receipt.avg_buy_quote_price !== 'number' || receipt.avg_buy_quote_price <= 0)
    viol('S-12', `avg_buy_quote_price must be > 0, got ${receipt.avg_buy_quote_price}`);

  if (!Array.isArray(receipt.flags)) {
    viol('S-13', 'flags must be a sorted array');
  } else {
    for (let i = 1; i < receipt.flags.length; i++) {
      if (receipt.flags[i] < receipt.flags[i - 1]) {
        viol('S-13', `flags not sorted: "${receipt.flags[i - 1]}" > "${receipt.flags[i]}" at index ${i}`);
        break;
      }
    }
  }

  if (typeof receipt.accounting_method !== 'string' || receipt.accounting_method.length === 0)
    viol('S-14', 'accounting_method must be non-empty string');

  if (!VALID_VERIFICATION_STATUSES.has(receipt.verification_status))
    viol('S-15', `verification_status invalid: "${receipt.verification_status}"`);

  if (!receipt.limitations || typeof receipt.limitations !== 'object')
    viol('S-16', 'limitations object must exist');

  // ═══ TYPE-SPECIFIC validation ═══
  const type = receipt.receipt_type;

  if (type === 'closed_position') {
    if (receipt.total_sold_qty == null || receipt.total_sold_qty <= 0)
      viol('CP-1', `total_sold_qty must be > 0, got ${receipt.total_sold_qty}`);

    if (receipt.total_sold_quote == null || receipt.total_sold_quote <= 0)
      viol('CP-2', `total_sold_quote must be > 0, got ${receipt.total_sold_quote}`);

    if (receipt.allocated_cost_basis_quote == null)
      viol('CP-3', 'allocated_cost_basis_quote must not be null');

    if (receipt.realized_pnl_quote == null)
      viol('CP-4', 'realized_pnl_quote must not be null');

    if (receipt.realized_pnl_pct == null)
      viol('CP-5', 'realized_pnl_pct must not be null');

    // CP-6: remaining_qty ~0 (within ledger dust threshold)
    // Uses total_bought_qty as peak proxy (always >= actual peak)
    if (typeof receipt.remaining_qty === 'number') {
      const dustThreshold = Math.max(DUST_ABS, DUST_PCT * (receipt.total_bought_qty || 0));
      if (Math.abs(receipt.remaining_qty) > dustThreshold) {
        viol('CP-6', `remaining_qty must be within dust for closed position, got ${receipt.remaining_qty} (threshold ${dustThreshold})`);
      }
    }

    if (!Array.isArray(receipt.exit_tx_hashes) || receipt.exit_tx_hashes.length === 0)
      viol('CP-7', 'exit_tx_hashes must be non-empty');

    if (!Array.isArray(receipt.entry_tx_hashes) || receipt.entry_tx_hashes.length === 0)
      viol('CP-8', 'entry_tx_hashes must be non-empty');

    if (receipt.hold_time_seconds == null || receipt.hold_time_seconds < 0)
      viol('CP-9', `hold_time_seconds must be >= 0, got ${receipt.hold_time_seconds}`);

    if (receipt.snapshot_at !== null)
      viol('CP-10', `snapshot_at must be null for closed_position, got ${receipt.snapshot_at}`);
  }

  if (type === 'realized_partial') {
    if (receipt.total_sold_qty == null || receipt.total_sold_qty <= 0)
      viol('RP-1', `total_sold_qty must be > 0, got ${receipt.total_sold_qty}`);

    if (receipt.realized_pnl_quote == null)
      viol('RP-2', 'realized_pnl_quote must not be null');

    if (typeof receipt.remaining_qty !== 'number' || receipt.remaining_qty <= 0)
      viol('RP-3', `remaining_qty must be > 0 (position still open), got ${receipt.remaining_qty}`);

    if (!Array.isArray(receipt.exit_tx_hashes) || receipt.exit_tx_hashes.length === 0)
      viol('RP-4', 'exit_tx_hashes must be non-empty');

    if (!Array.isArray(receipt.entry_tx_hashes) || receipt.entry_tx_hashes.length === 0)
      viol('RP-5', 'entry_tx_hashes must be non-empty');

    if (receipt.snapshot_at !== null)
      viol('RP-6', `snapshot_at must be null for realized_partial, got ${receipt.snapshot_at}`);
  }

  if (type === 'open_snapshot') {
    if (receipt.total_sold_qty !== null)
      viol('OS-1', `total_sold_qty must be null, got ${receipt.total_sold_qty}`);

    if (receipt.total_sold_quote !== null)
      viol('OS-2', `total_sold_quote must be null, got ${receipt.total_sold_quote}`);

    if (receipt.avg_sell_quote_price !== null)
      viol('OS-3', `avg_sell_quote_price must be null, got ${receipt.avg_sell_quote_price}`);

    if (receipt.allocated_cost_basis_quote !== null)
      viol('OS-4', `allocated_cost_basis_quote must be null, got ${receipt.allocated_cost_basis_quote}`);

    if (receipt.realized_pnl_quote !== null)
      viol('OS-5', `realized_pnl_quote must be null, got ${receipt.realized_pnl_quote}`);

    if (receipt.realized_pnl_pct !== null)
      viol('OS-6', `realized_pnl_pct must be null, got ${receipt.realized_pnl_pct}`);

    if (!Array.isArray(receipt.exit_tx_hashes) || receipt.exit_tx_hashes.length !== 0)
      viol('OS-7', `exit_tx_hashes must be empty, got length ${receipt.exit_tx_hashes?.length}`);

    if (!Array.isArray(receipt.entry_tx_hashes) || receipt.entry_tx_hashes.length === 0)
      viol('OS-8', 'entry_tx_hashes must be non-empty');

    if (typeof receipt.remaining_qty !== 'number' || receipt.remaining_qty <= 0)
      viol('OS-9', `remaining_qty must be > 0, got ${receipt.remaining_qty}`);

    if (receipt.snapshot_at == null)
      viol('OS-10', 'snapshot_at must not be null for open_snapshot');
  }

  // ═══ CONSISTENCY validation (C-*) ═══
  const flags = Array.isArray(receipt.flags) ? receipt.flags : [];
  const hasDisqualifier = flags.some(f => DISQUALIFYING_FLAGS.has(f));

  // C-1 to C-4: verification_status ↔ type + flags
  if (type === 'closed_position' && !hasDisqualifier && receipt.verification_status !== 'verified')
    viol('C-1', `closed_position without disqualifying flags must be "verified", got "${receipt.verification_status}"`);

  if (type === 'realized_partial' && !hasDisqualifier && receipt.verification_status !== 'verified_partial')
    viol('C-2', `realized_partial without disqualifying flags must be "verified_partial", got "${receipt.verification_status}"`);

  if (type === 'open_snapshot' && !hasDisqualifier && receipt.verification_status !== 'verified_snapshot')
    viol('C-3', `open_snapshot without disqualifying flags must be "verified_snapshot", got "${receipt.verification_status}"`);

  if (hasDisqualifier && receipt.verification_status !== 'unverified')
    viol('C-4', `receipt with disqualifying flags must be "unverified", got "${receipt.verification_status}"`);

  // C-5 to C-20: limitations consistency
  const lim = receipt.limitations;
  if (lim && typeof lim === 'object') {
    // C-5: receipt_scope
    if (lim.receipt_scope !== type)
      viol('C-5', `limitations.receipt_scope must match receipt_type "${type}", got "${lim.receipt_scope}"`);

    // C-6/C-7/C-8: pnl_type
    const expectedPnlType = PNL_TYPE_MAP[type];
    if (expectedPnlType !== undefined && lim.pnl_type !== expectedPnlType) {
      const ruleId = type === 'closed_position' ? 'C-6'
                   : type === 'realized_partial' ? 'C-7'
                   : 'C-8';
      viol(ruleId, `limitations.pnl_type must be "${expectedPnlType}" for ${type}, got "${lim.pnl_type}"`);
    }

    // C-9/C-10: price_source
    const expectedPriceSource = PRICE_SOURCE_MAP[type];
    if (expectedPriceSource !== undefined && lim.price_source !== expectedPriceSource) {
      const ruleId = type === 'open_snapshot' ? 'C-9' : 'C-10';
      viol(ruleId, `limitations.price_source must be "${expectedPriceSource}" for ${type}, got "${lim.price_source}"`);
    }

    // Disclosure checks
    const disclosures = Array.isArray(lim.disclosures) ? lim.disclosures : [];
    const disclosureSet = new Set(disclosures);

    // C-11: no_usd_normalization always
    if (!disclosureSet.has('no_usd_normalization'))
      viol('C-11', 'limitations.disclosures must include "no_usd_normalization"');

    // C-12: realized_partial → position_open
    if (type === 'realized_partial' && !disclosureSet.has('position_open'))
      viol('C-12', 'realized_partial must include "position_open" in disclosures');

    // C-13a/C-13b: open_snapshot → no_pnl_claim + no_live_price
    if (type === 'open_snapshot') {
      if (!disclosureSet.has('no_pnl_claim'))
        viol('C-13a', 'open_snapshot must include "no_pnl_claim" in disclosures');
      if (!disclosureSet.has('no_live_price'))
        viol('C-13b', 'open_snapshot must include "no_live_price" in disclosures');
    }

    // C-14 to C-17: flag → disclosure
    if (flags.includes('mixed_quote') && !disclosureSet.has('mixed_quote_currencies'))
      viol('C-14', 'flag "mixed_quote" requires "mixed_quote_currencies" in disclosures');

    if (flags.includes('partial_history') && !disclosureSet.has('partial_trade_history'))
      viol('C-15', 'flag "partial_history" requires "partial_trade_history" in disclosures');

    if (flags.includes('unsupported_inventory') && !disclosureSet.has('unsupported_inventory'))
      viol('C-16', 'flag "unsupported_inventory" requires "unsupported_inventory" in disclosures');

    if (flags.includes('external_transfer_possible') && !disclosureSet.has('external_transfer_possible'))
      viol('C-17', 'flag "external_transfer_possible" requires "external_transfer_possible" in disclosures');

    // C-18: display_status ↔ verification_status
    const expectedDisplay = DISPLAY_STATUS_MAP[receipt.verification_status];
    if (expectedDisplay && receipt.display_status !== expectedDisplay)
      viol('C-18', `display_status must be "${expectedDisplay}", got "${receipt.display_status}"`);

    // C-19: valuation_currency
    if (lim.valuation_currency !== 'raw_quote')
      viol('C-19', `limitations.valuation_currency must be "raw_quote", got "${lim.valuation_currency}"`);

    // C-20: no phantom disclosures
    const expectedDisclosures = deriveExpectedDisclosures(type, flags);
    for (const d of disclosures) {
      if (!expectedDisclosures.has(d)) {
        viol('C-20', `unexpected disclosure "${d}" — not derivable from type "${type}" and flags [${flags.join(', ')}]`);
      }
    }
  }

  // ═══ VALUATION validation (V-*) ═══
  const valuationResult = validateReceiptValuation(receipt);
  for (const v of valuationResult.violations) {
    viol(v.rule, v.message);
  }

  // ═══ Compute summary flags ═══
  const errors = violations.filter(v => v.severity === 'error');
  const schemaValid = !errors.some(e =>
    e.rule.startsWith('S-') || e.rule.startsWith('CP-') ||
    e.rule.startsWith('RP-') || e.rule.startsWith('OS-')
  );
  const consistencyValid = !errors.some(e => e.rule.startsWith('C-') || e.rule.startsWith('V-'));

  return {
    receipt_id: receipt.receipt_id,
    receipt_hash: receipt.receipt_hash,
    recomputed_hash: recomputed,
    hash_valid: hashValid,
    rule_violations: violations,
    schema_valid: schemaValid,
    consistency_valid: consistencyValid,
    pass: errors.length === 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// verifyReceiptBatch
// ═══════════════════════════════════════════════════════════════

/**
 * Verify an array of v1.2 receipts, return a summary report.
 *
 * @param {object[]} receipts
 * @returns {VerificationReport}
 */
export function verifyReceiptBatch(receipts) {
  const results = receipts.map(r => verifyReceipt(r));

  const byType = { closed_position: 0, realized_partial: 0, open_snapshot: 0 };
  const byStatus = {};

  for (const r of receipts) {
    if (byType[r.receipt_type] !== undefined) byType[r.receipt_type]++;
    byStatus[r.verification_status] = (byStatus[r.verification_status] || 0) + 1;
  }

  const failures = results.filter(r => !r.pass);

  return {
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    by_type: byType,
    by_status: byStatus,
    results,
    failures,
  };
}
