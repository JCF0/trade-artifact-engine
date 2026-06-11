/**
 * Centralized rounding helpers for the Position Ledger.
 *
 * These mirror the conventions already used throughout the Artifact engine:
 *   - toPrecision(12) for prices and monetary amounts
 *   - toFixed(10)     for token quantities
 *   - toPrecision(6)  for percentages
 *
 * Existing v1.1 modules are NOT refactored to use these — that is a
 * separate cleanup task. The ledger uses these from the start.
 */

/**
 * Round a price or monetary amount to 12 significant digits.
 * @param {number} n
 * @returns {number}
 */
export function roundPrice(n) {
  if (n === 0 || !Number.isFinite(n)) return 0;
  return parseFloat(n.toPrecision(12));
}

/**
 * Round a token quantity to 10 decimal places.
 * @param {number} n
 * @returns {number}
 */
export function roundQty(n) {
  if (!Number.isFinite(n)) return 0;
  return parseFloat(n.toFixed(10));
}

/**
 * Round a percentage to 6 significant digits.
 * @param {number} n
 * @returns {number}
 */
export function roundPct(n) {
  if (n === 0 || !Number.isFinite(n)) return 0;
  return parseFloat(n.toPrecision(6));
}
