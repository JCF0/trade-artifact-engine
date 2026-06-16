/**
 * Valuation Schema — C1
 *
 * Formalizes the valuation boundary for v1.2 receipts.
 *
 * Defines valuation statuses (active vs reserved), USD-stable mint
 * classification, and validation rules that enforce the current
 * `raw_quote` truthfulness contract.
 *
 * This module does NOT:
 *   - Fetch prices or convert SOL→USD
 *   - Add real USD PnL fields to receipts
 *   - Modify receipt hashes or schemas
 *   - Render, mint, or upload anything
 *   - Change any existing module's behavior
 *
 * Key design rule:
 *   `quote_is_usd_stable: true` for USDC/USDT is contextual metadata only.
 *   It must NOT imply `usd_normalized`, real USD PnL, or any departure
 *   from the `raw_quote` valuation contract.
 */

import { USDC_MINT, USDT_MINT } from '../pipeline/constants.mjs';

// ═══════════════════════════════════════════════════════════════
// Valuation statuses
// ═══════════════════════════════════════════════════════════════

/**
 * Active valuation statuses — valid for real receipts today.
 *
 * Currently only `raw_quote`: all PnL is denominated in the trade's
 * native quote currency with no USD normalization.
 */
export const ACTIVE_VALUATION_STATUSES = new Set([
  'raw_quote',
]);

/**
 * Reserved valuation statuses — recognized by schema for future
 * design iteration and testing, but NOT valid for real receipts.
 *
 * These exist so valuation context builders and validators can
 * distinguish "known future status" from "garbage string" without
 * accepting them as production-ready.
 */
const RESERVED_VALUATION_STATUSES = new Set([
  'usd_normalized',
  'usd_estimated',
  'usd_partial',
]);

/**
 * All known valuation statuses (active + reserved).
 */
export const VALUATION_STATUSES = new Set([
  ...ACTIVE_VALUATION_STATUSES,
  ...RESERVED_VALUATION_STATUSES,
]);

// ═══════════════════════════════════════════════════════════════
// USD-stable mints
// ═══════════════════════════════════════════════════════════════

/**
 * Mints whose quote values are contextually 1:1 with USD.
 *
 * This is metadata for downstream consumers — it does NOT change
 * valuation_status, does NOT imply usd_normalized, and does NOT
 * add any USD PnL fields.
 */
export const USD_STABLE_MINTS = new Set([
  USDC_MINT,
  USDT_MINT,
]);

// ═══════════════════════════════════════════════════════════════
// Status checks
// ═══════════════════════════════════════════════════════════════

/**
 * Is this an active (production-valid) valuation status?
 * @param {string} status
 * @returns {boolean}
 */
export function isActiveValuationStatus(status) {
  return ACTIVE_VALUATION_STATUSES.has(status);
}

/**
 * Is this a reserved (future, not yet production-valid) valuation status?
 * @param {string} status
 * @returns {boolean}
 */
export function isReservedValuationStatus(status) {
  return RESERVED_VALUATION_STATUSES.has(status);
}

/**
 * Is this mint a known USD-stable token?
 * @param {string} mint
 * @returns {boolean}
 */
export function isUsdStableMint(mint) {
  return USD_STABLE_MINTS.has(mint);
}

// ═══════════════════════════════════════════════════════════════
// USD field names (for validation)
// ═══════════════════════════════════════════════════════════════

/**
 * Receipt fields with `_usd` suffix that must be null under raw_quote.
 */
const USD_FIELDS = [
  'unrealized_pnl_usd',
  'realized_pnl_usd',
  'total_pnl_usd',
  'entry_price_usd',
  'exit_price_usd',
  'current_price_usd',
];

// ═══════════════════════════════════════════════════════════════
// buildValuationContext
// ═══════════════════════════════════════════════════════════════

/**
 * Build a valuation context object from a receipt.
 *
 * The context captures valuation-relevant metadata for downstream
 * consumers without modifying the receipt itself.
 *
 * @param {object} receipt - A v1.2 receipt record
 * @returns {object} Valuation context
 */
export function buildValuationContext(receipt) {
  const quoteMint = receipt.quote_mint;
  const quoteSymbol = receipt.quote_symbol;
  const valuationStatus = receipt.valuation_status;
  const quoteIsUsdStable = isUsdStableMint(quoteMint || '');

  return {
    valuation_status: valuationStatus,
    valuation_currency: receipt.limitations?.valuation_currency ?? null,
    quote_mint: quoteMint,
    quote_symbol: quoteSymbol,
    quote_is_usd_stable: quoteIsUsdStable,
    has_no_usd_normalization_disclosure: Array.isArray(receipt.limitations?.disclosures)
      ? receipt.limitations.disclosures.includes('no_usd_normalization')
      : false,
    receipt_type: receipt.receipt_type,
    receipt_version: receipt.receipt_version,
  };
}

// ═══════════════════════════════════════════════════════════════
// validateReceiptValuation
// ═══════════════════════════════════════════════════════════════

/**
 * Validate a receipt's valuation fields against the current contract.
 *
 * Only active valuation statuses pass. Reserved statuses are recognized
 * (reported as 'reserved_status' violation, not 'unknown_status') but
 * still fail validation — they are not production-ready.
 *
 * @param {object} receipt - A v1.2 receipt record
 * @returns {{ valid: boolean, violations: Array<{ rule: string, message: string }> }}
 */
export function validateReceiptValuation(receipt) {
  const violations = [];

  function viol(rule, message) {
    violations.push({ rule, message });
  }

  const status = receipt.valuation_status;

  // V-1: valuation_status must be an active status
  if (!isActiveValuationStatus(status)) {
    if (isReservedValuationStatus(status)) {
      viol('V-1', `valuation_status "${status}" is reserved for future use, not valid for receipts`);
    } else {
      viol('V-1', `valuation_status "${status}" is not a recognized valuation status`);
    }
  }

  // raw_quote-specific rules (only checked when status claims raw_quote)
  if (status === 'raw_quote') {
    // V-2: limitations.valuation_currency must be 'raw_quote'
    if (receipt.limitations?.valuation_currency !== 'raw_quote') {
      viol('V-2', `limitations.valuation_currency must be "raw_quote" when valuation_status is "raw_quote", got "${receipt.limitations?.valuation_currency}"`);
    }

    // V-3: must have no_usd_normalization disclosure
    const disclosures = receipt.limitations?.disclosures;
    if (!Array.isArray(disclosures) || !disclosures.includes('no_usd_normalization')) {
      viol('V-3', 'raw_quote requires "no_usd_normalization" in limitations.disclosures');
    }

    // V-4: no non-null _usd fields
    for (const field of USD_FIELDS) {
      if (receipt[field] != null) {
        viol('V-4', `raw_quote forbids non-null USD field "${field}", got ${receipt[field]}`);
      }
    }

    // V-5: quote_mint must be non-empty
    if (typeof receipt.quote_mint !== 'string' || receipt.quote_mint.length === 0) {
      viol('V-5', 'raw_quote requires non-empty quote_mint');
    }

    // V-6: quote_symbol must be non-empty
    if (typeof receipt.quote_symbol !== 'string' || receipt.quote_symbol.length === 0) {
      viol('V-6', 'raw_quote requires non-empty quote_symbol');
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ═══════════════════════════════════════════════════════════════
// validateValuationContext
// ═══════════════════════════════════════════════════════════════

/**
 * Validate a valuation context object (as returned by buildValuationContext).
 *
 * This is a lighter check on the context structure itself, not the full
 * receipt. Reserved statuses are recognized (not "unknown") but reported
 * as not active.
 *
 * @param {object} ctx - Valuation context from buildValuationContext
 * @returns {{ valid: boolean, violations: Array<{ rule: string, message: string }> }}
 */
export function validateValuationContext(ctx) {
  const violations = [];

  function viol(rule, message) {
    violations.push({ rule, message });
  }

  if (!ctx || typeof ctx !== 'object') {
    viol('VC-1', 'valuation context must be a non-null object');
    return { valid: false, violations };
  }

  const status = ctx.valuation_status;

  // VC-2: valuation_status must be a known status (active or reserved)
  if (!VALUATION_STATUSES.has(status)) {
    viol('VC-2', `valuation_status "${status}" is not a recognized valuation status`);
  } else if (isReservedValuationStatus(status)) {
    viol('VC-2', `valuation_status "${status}" is reserved for future use, not active`);
  }

  // VC-3: valuation_currency must match valuation_status for raw_quote
  if (status === 'raw_quote' && ctx.valuation_currency !== 'raw_quote') {
    viol('VC-3', `valuation_currency must be "raw_quote" when valuation_status is "raw_quote", got "${ctx.valuation_currency}"`);
  }

  // VC-4: raw_quote requires no_usd_normalization disclosure
  if (status === 'raw_quote' && ctx.has_no_usd_normalization_disclosure !== true) {
    viol('VC-4', 'raw_quote requires no_usd_normalization disclosure');
  }

  // VC-5: quote_mint must be non-empty string
  if (typeof ctx.quote_mint !== 'string' || ctx.quote_mint.length === 0) {
    viol('VC-5', 'quote_mint must be a non-empty string');
  }

  // VC-6: quote_symbol must be non-empty string
  if (typeof ctx.quote_symbol !== 'string' || ctx.quote_symbol.length === 0) {
    viol('VC-6', 'quote_symbol must be a non-empty string');
  }

  // VC-7: quote_is_usd_stable must be boolean
  if (typeof ctx.quote_is_usd_stable !== 'boolean') {
    viol('VC-7', `quote_is_usd_stable must be boolean, got ${typeof ctx.quote_is_usd_stable}`);
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
