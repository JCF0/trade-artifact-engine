/**
 * Pipeline — Quote Normalizer
 *
 * Detects mixed-quote positions and normalizes all quote amounts
 * into a single denomination (SOL primary, USD secondary).
 *
 * Uses Jupiter Price API v2 (free, no key required) for conversion.
 *
 * Design rules:
 * - Never fabricate a value. If conversion rate is unavailable → warn, don't guess.
 * - Preserve original raw quote amounts on each leg (display-only).
 * - Clearly label normalized values as estimates with fetch timestamp.
 * - Single-quote positions pass through unchanged (no API call needed).
 */
import { SOL_MINT, USDC_MINT, USDT_MINT, QUOTE_MINTS, SYMS } from './constants.mjs';

// ═══════════════════════════════════════════════════════════════
// Jupiter Price API v2
// ═══════════════════════════════════════════════════════════════

const JUPITER_QUOTE_API = 'https://api.jup.ag/swap/v1/quote';
const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';

// Rate cache with TTL (5 minutes)
const RATE_TTL_MS = 5 * 60 * 1000;
const rateCache = new Map(); // mint → { rate, solUsd, fetchedAt }

/**
 * Get cached rate if still within TTL.
 * @param {string} mint
 * @returns {{ rate: number, solUsd: number|null } | null}
 */
function getCachedRate(mint) {
  const entry = rateCache.get(mint);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > RATE_TTL_MS) {
    rateCache.delete(mint);
    return null;
  }
  return { rate: entry.rate, solUsd: entry.solUsd };
}

/**
 * Store rate in cache with current timestamp.
 */
function setCachedRate(mint, rate, solUsd) {
  rateCache.set(mint, { rate, solUsd, fetchedAt: Date.now() });
}

// Known decimals for quote mints
const QUOTE_DECIMALS = {
  [SOL_MINT]: 9,
  [USDC_MINT]: 6,
  [USDT_MINT]: 6,
};

/**
 * Fetch conversion rate for a token → SOL using Jupiter swap quote.
 * Uses a small reference amount to get the rate.
 *
 * @param {string} mint - Source token mint
 * @returns {Promise<number|null>} Rate: how much SOL per 1 unit of token. Null if unavailable.
 */
async function fetchRateViQuote(mint) {
  const decimals = QUOTE_DECIMALS[mint];
  if (decimals == null) return null;

  // Use 1 unit of the token as reference amount
  const atomicAmount = Math.pow(10, decimals);
  const url = `${JUPITER_QUOTE_API}?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${atomicAmount}&slippageBps=50`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.outAmount) return null;

    // outAmount is in lamports (9 decimals)
    const solOut = parseInt(data.outAmount) / 1e9;
    return solOut; // rate: 1 unit of token = this many SOL
  } catch {
    return null;
  }
}

/**
 * Fetch SOL/USD price from CoinGecko (free, no key).
 * @returns {Promise<number|null>}
 */
async function fetchSolUsd() {
  try {
    const res = await fetch(`${COINGECKO_API}?ids=solana&vs_currencies=usd`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.solana?.usd || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Detection
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a position has mixed quote mints across its legs.
 * @param {object} position - Position object from buildPositions
 * @returns {{ mixed: boolean, quote_mints: string[] }}
 */
export function detectMixedQuotes(position) {
  const quoteMints = new Set();
  for (const leg of position.legs) {
    if (leg.quote_mint) quoteMints.add(leg.quote_mint);
  }
  return {
    mixed: quoteMints.size > 1,
    quote_mints: [...quoteMints],
  };
}

// ═══════════════════════════════════════════════════════════════
// Normalization
// ═══════════════════════════════════════════════════════════════

/**
 * Conversion rates between quote mints.
 * Key: source_mint, Value: { rate_to_sol, source }
 *
 * SOL → SOL: rate = 1
 * USDC → SOL: rate = Jupiter price (USDC priced in SOL)
 * USDT → SOL: rate = Jupiter price (USDT priced in SOL)
 */
async function buildConversionRates(quoteMints) {
  const rates = new Map();
  rates.set(SOL_MINT, { rate_to_sol: 1, source: 'identity' });

  // Which non-SOL mints need pricing?
  const needPricing = quoteMints.filter(m => m !== SOL_MINT);
  if (needPricing.length === 0) return { rates, sol_usd: null, fetchedAt: null };

  const fetchedAt = new Date().toISOString();

  // Check TTL cache first
  const needFetch = [];
  let cachedSolUsd = null;
  for (const mint of needPricing) {
    const cached = getCachedRate(mint);
    if (cached) {
      rates.set(mint, { rate_to_sol: cached.rate, source: 'jupiter_swap_quote (cached)' });
      if (cached.solUsd) cachedSolUsd = cached.solUsd;
    } else {
      needFetch.push(mint);
    }
  }

  let solUsd = cachedSolUsd;

  // Only fetch what's not cached
  if (needFetch.length > 0) {
    const ratePromises = needFetch.map(async (mint) => {
      const rate = await fetchRateViQuote(mint);
      return { mint, rate };
    });

    const solUsdPromise = solUsd ? Promise.resolve(solUsd) : fetchSolUsd();
    const [rateResults, fetchedSolUsd] = await Promise.all([
      Promise.all(ratePromises),
      solUsdPromise,
    ]);

    solUsd = fetchedSolUsd || solUsd;

    for (const { mint, rate } of rateResults) {
      if (rate != null && rate > 0) {
        rates.set(mint, { rate_to_sol: rate, source: 'jupiter_swap_quote' });
        setCachedRate(mint, rate, solUsd);
      }
    }
  }

  return { rates, sol_usd: solUsd, fetchedAt };
}

/**
 * Normalize a position's quote amounts to SOL denomination.
 *
 * Returns a new position object with:
 * - normalized_legs: legs with quote_amount_sol, quote_amount_usd
 * - normalized PnL metrics
 * - normalization metadata (rates, timestamp, confidence)
 * - warnings if any leg couldn't be converted
 *
 * Does NOT modify the original position object.
 *
 * @param {object} position - Position from buildPositions
 * @returns {Promise<object>} Normalized position with metadata
 */
export async function normalizePosition(position) {
  const detection = detectMixedQuotes(position);

  // Single-quote positions: skip normalization, just annotate
  if (!detection.mixed) {
    const singleQuote = detection.quote_mints[0] || SOL_MINT;
    return {
      ...position,
      normalization: {
        required: false,
        primary_quote: singleQuote,
        primary_quote_sym: SYMS[singleQuote] || singleQuote.slice(0, 8),
        mixed_quotes: false,
      },
    };
  }

  // Mixed quotes — fetch conversion rates
  const { rates, sol_usd: solUsd, fetchedAt } = await buildConversionRates(detection.quote_mints);

  const warnings = [];
  const normalizedLegs = [];
  let costBasisSol = 0;
  let proceedsSol = 0;
  let totalBought = 0;
  let totalSold = 0;
  let allConverted = true;

  for (const leg of position.legs) {
    const quoteMint = leg.quote_mint;
    const rateInfo = rates.get(quoteMint);

    const normalizedLeg = {
      ...leg,
      raw_quote_amount: leg.quote_amount,
      raw_quote_mint: quoteMint,
      raw_quote_sym: SYMS[quoteMint] || quoteMint?.slice(0, 8) || 'UNKNOWN',
    };

    if (!rateInfo) {
      // Cannot convert — flag it
      allConverted = false;
      normalizedLeg.quote_amount_sol = null;
      normalizedLeg.quote_amount_usd = null;
      normalizedLeg.conversion_failed = true;
      warnings.push({
        type: 'conversion_unavailable',
        leg_tx: leg.tx_hash,
        quote_mint: quoteMint,
        message: `No conversion rate for ${SYMS[quoteMint] || quoteMint?.slice(0, 8)} → SOL`,
      });
    } else {
      const solAmount = leg.quote_amount * rateInfo.rate_to_sol;
      normalizedLeg.quote_amount_sol = solAmount;
      normalizedLeg.quote_amount_usd = solUsd ? solAmount * solUsd : null;
      normalizedLeg.conversion_rate = rateInfo.rate_to_sol;
      normalizedLeg.conversion_source = rateInfo.source;

      if (leg.action === 'buy') {
        costBasisSol += solAmount;
        totalBought += leg.amount;
      } else {
        proceedsSol += solAmount;
        totalSold += leg.amount;
      }
    }

    normalizedLegs.push(normalizedLeg);
  }

  // Compute normalized PnL — respect open positions (no exits → null PnL)
  const isOpen = position.pnl_display_type === 'unrealized_unavailable';
  const avgEntrySol = totalBought > 0 ? costBasisSol / totalBought : 0;
  const avgExitSol = totalSold > 0 ? proceedsSol / totalSold : 0;
  const realizedPnlSol = isOpen ? null : proceedsSol - costBasisSol;
  const realizedPnlPct = isOpen ? null : (costBasisSol > 0 ? ((proceedsSol - costBasisSol) / costBasisSol) * 100 : 0);

  // Confidence assessment
  let confidence;
  if (!allConverted) {
    confidence = 'low';
    warnings.push({
      type: 'incomplete_normalization',
      message: 'Some legs could not be converted — PnL is partial',
    });
  } else if (detection.quote_mints.includes(USDC_MINT) || detection.quote_mints.includes(USDT_MINT)) {
    // Stablecoin conversion uses current SOL price, not trade-time
    confidence = 'estimated';
    warnings.push({
      type: 'price_drift_possible',
      message: 'Stablecoin legs converted at current SOL price, not trade-time price. PnL is an estimate.',
    });
  } else {
    confidence = 'high';
  }

  return {
    ...position,

    // Normalized metrics (in SOL)
    normalized_avg_entry: parseFloat(avgEntrySol.toPrecision(12)),
    normalized_avg_exit: totalSold > 0 ? parseFloat(avgExitSol.toPrecision(12)) : null,
    normalized_cost_basis: parseFloat(costBasisSol.toPrecision(12)),
    normalized_proceeds: parseFloat(proceedsSol.toPrecision(12)),
    normalized_realized_pnl: realizedPnlSol != null ? parseFloat(realizedPnlSol.toPrecision(12)) : null,
    normalized_realized_pnl_pct: realizedPnlPct != null ? parseFloat(realizedPnlPct.toPrecision(6)) : null,

    // USD equivalents (if available)
    normalized_cost_basis_usd: solUsd ? parseFloat((costBasisSol * solUsd).toPrecision(8)) : null,
    normalized_proceeds_usd: solUsd ? parseFloat((proceedsSol * solUsd).toPrecision(8)) : null,
    normalized_realized_pnl_usd: (solUsd && realizedPnlSol != null) ? parseFloat((realizedPnlSol * solUsd).toPrecision(8)) : null,

    // Metadata
    normalization: {
      required: true,
      mixed_quotes: true,
      quote_mints: detection.quote_mints,
      quote_mint_syms: detection.quote_mints.map(m => SYMS[m] || m.slice(0, 8)),
      target_denomination: 'SOL',
      confidence,
      sol_usd_rate: solUsd,
      rates: Object.fromEntries([...rates].map(([k, v]) => [SYMS[k] || k.slice(0, 8), v])),
      fetched_at: fetchedAt,
      warnings,
    },

    // Preserve original + add normalized legs
    legs: normalizedLegs,
  };
}

/**
 * Batch-normalize an array of positions.
 * Only calls Jupiter API for positions that actually need it.
 *
 * @param {object[]} positions
 * @returns {Promise<object[]>}
 */
export async function normalizePositions(positions) {
  const results = [];
  for (const pos of positions) {
    results.push(await normalizePosition(pos));
  }
  return results;
}
