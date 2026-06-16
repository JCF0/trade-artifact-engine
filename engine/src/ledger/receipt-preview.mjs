/**
 * Receipt Preview — D1
 *
 * Pure view-model formatter: canonical v1.2 receipts → display-ready
 * preview objects with embedded markdown.
 *
 * This module does NOT:
 *   - Modify or mutate receipts
 *   - Change receipt hashes or schemas
 *   - Fetch prices or convert to USD
 *   - Render PNGs, mint NFTs, or upload metadata
 *   - Use Date.now() or perform I/O
 *   - Invent token symbols — uses receipt data or mint fallback
 */

// ═══════════════════════════════════════════════════════════════
// Format helpers (exported for testing)
// ═══════════════════════════════════════════════════════════════

/**
 * Shorten a wallet address: first 6 + ... + last 4.
 * @param {string} addr
 * @returns {string}
 */
export function shortWallet(addr) {
  if (!addr || addr.length < 12) return addr || '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

/**
 * Shorten a hex hash: first 12 + ...
 * @param {string} hash
 * @returns {string}
 */
export function shortHash(hash) {
  if (!hash || hash.length <= 16) return hash || '';
  return hash.slice(0, 12) + '...';
}

/**
 * Format a price with quote symbol.
 * @param {number|null} price
 * @param {string} quoteSym
 * @returns {string}
 */
export function formatPrice(price, quoteSym) {
  if (price == null) return '—';
  if (price < 0.0001) return `${price.toExponential(4)} ${quoteSym}`;
  if (price < 1) return `${price.toFixed(6)} ${quoteSym}`;
  return `${price.toFixed(4)} ${quoteSym}`;
}

/**
 * Format a PnL value with sign and quote symbol.
 * @param {number|null} pnl
 * @param {string} quoteSym
 * @returns {string}
 */
export function formatPnl(pnl, quoteSym) {
  if (pnl == null) return '—';
  const sign = pnl >= 0 ? '+' : '';
  if (Math.abs(pnl) < 0.0001 && pnl !== 0) return `${sign}${pnl.toExponential(3)} ${quoteSym}`;
  return `${sign}${pnl.toFixed(6)} ${quoteSym}`;
}

/**
 * Format a PnL percentage with sign.
 * @param {number|null} pct
 * @returns {string}
 */
export function formatPnlPct(pct) {
  if (pct == null) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(3)}%`;
}

/**
 * Format hold time in human-readable units.
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatHoldTime(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hrs`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

/**
 * Format epoch seconds as UTC datetime string.
 * @param {number|null} ts
 * @returns {string}
 */
export function formatDate(ts) {
  if (ts == null) return '—';
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
}

/**
 * Derive a display symbol for a token. Uses the receipt's own fields,
 * never invents symbols. Falls back to shortened mint.
 * @param {string|null} symbol - From receipt field (e.g. quote_symbol)
 * @param {string|null} mint - Token mint address
 * @returns {string}
 */
export function tokenDisplay(symbol, mint) {
  if (symbol && symbol.length > 0 && symbol !== 'MIXED') return symbol;
  if (mint && mint.length >= 8) return mint.slice(0, 8) + '...';
  return 'UNKNOWN';
}

// ═══════════════════════════════════════════════════════════════
// Disclosure human-readable mapping
// ═══════════════════════════════════════════════════════════════

const DISCLOSURE_LABELS = {
  no_usd_normalization:        'No USD normalization — PnL is in raw quote currency, not USD',
  position_open:               'Position still open — partial PnL only',
  no_pnl_claim:                'No sells — snapshot only, no PnL claim',
  no_live_price:               'No live price data',
  mixed_quote_currencies:      'Mixed quote currencies — verification limited',
  partial_trade_history:       'Partial trade history — PnL may be unreliable',
  unsupported_inventory:       'Unsupported inventory detected',
  external_transfer_possible:  'External transfers may affect accuracy',
};

function humanDisclosure(code) {
  return DISCLOSURE_LABELS[code] || code;
}

// ═══════════════════════════════════════════════════════════════
// Status display
// ═══════════════════════════════════════════════════════════════

const STATUS_ICONS = {
  verified:          '✅',
  verified_partial:  '⏳',
  verified_snapshot: '📸',
  unverified:        '❌',
};

const STATUS_LABELS = {
  verified:          'Verified Closed Position',
  verified_partial:  'Verified Partial (Position Open)',
  verified_snapshot: 'Verified Snapshot (No PnL Claim)',
  unverified:        'Unverified — See Limitations',
};

// ═══════════════════════════════════════════════════════════════
// USD-stable mints (for display label only — no semantic change)
// ═══════════════════════════════════════════════════════════════

const USD_STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// ═══════════════════════════════════════════════════════════════
// buildReceiptPreview
// ═══════════════════════════════════════════════════════════════

/**
 * Build a display-ready preview from a canonical v1.2 receipt.
 *
 * Pure function: no I/O, no Date.now(), fully deterministic.
 * Does not modify the receipt.
 *
 * @param {object} receipt - Canonical v1.2 receipt record
 * @returns {object} Preview view-model with embedded markdown
 */
export function buildReceiptPreview(receipt) {
  const quoteSym = tokenDisplay(receipt.quote_symbol, receipt.quote_mint);
  const tokenSym = tokenDisplay(null, receipt.token_mint);
  const walletShort = shortWallet(receipt.wallet);
  const quoteIsUsdStable = USD_STABLE_MINTS.has(receipt.quote_mint || '');

  const verificationStatus = receipt.verification_status || 'unverified';
  const statusIcon = STATUS_ICONS[verificationStatus] || '❓';
  const statusLabel = receipt.display_status
    || STATUS_LABELS[verificationStatus]
    || 'Unknown Status';

  const hasPnl = receipt.realized_pnl_quote != null;
  const isProfit = hasPnl && receipt.realized_pnl_quote >= 0;

  // ── Header ──
  const header = {
    token_mint: receipt.token_mint,
    token_display: tokenSym,
    quote_symbol: quoteSym,
    quote_mint: receipt.quote_mint,
    chain: receipt.chain,
    wallet: receipt.wallet,
    wallet_short: walletShort,
  };

  // ── PnL ──
  const pnl = {
    realized_pnl_quote: receipt.realized_pnl_quote,
    realized_pnl_pct: receipt.realized_pnl_pct,
    realized_pnl_display: formatPnl(receipt.realized_pnl_quote, quoteSym),
    realized_pnl_pct_display: formatPnlPct(receipt.realized_pnl_pct),
    is_profit: isProfit,
    has_pnl: hasPnl,
  };

  // ── Stats ──
  const numBuys = receipt.num_buys ?? 0;
  const numSells = receipt.num_sells ?? 0;
  const buyLabel = numBuys === 1 ? 'buy' : 'buys';
  const sellLabel = numSells === 1 ? 'sell' : 'sells';

  const stats = {
    avg_buy_price: formatPrice(receipt.avg_buy_quote_price, quoteSym),
    avg_sell_price: formatPrice(receipt.avg_sell_quote_price, quoteSym),
    cost_basis: formatPrice(receipt.total_bought_quote, quoteSym),
    exit_proceeds: formatPrice(receipt.total_sold_quote, quoteSym),
    remaining_qty: receipt.remaining_qty != null ? String(receipt.remaining_qty) : '—',
    hold_time: formatHoldTime(receipt.hold_time_seconds),
    trades: `${numBuys} ${buyLabel} / ${numSells} ${sellLabel}`,
    num_buys: numBuys,
    num_sells: numSells,
  };

  // ── Valuation ──
  let currencyLabel = `Raw Quote (${quoteSym})`;
  if (quoteIsUsdStable) {
    currencyLabel = `Raw Quote (${quoteSym}) — USD-stable quote asset, but still raw quote; no historical USD normalization applied`;
  }

  const disclosureCodes = Array.isArray(receipt.limitations?.disclosures)
    ? receipt.limitations.disclosures
    : [];
  const disclosureLabels = disclosureCodes.map(humanDisclosure);

  const valuation = {
    status: receipt.valuation_status || 'raw_quote',
    currency_label: currencyLabel,
    quote_is_usd_stable: quoteIsUsdStable,
    disclosures: disclosureLabels,
    disclosure_codes: disclosureCodes,
  };

  // ── Limitations ──
  const lim = receipt.limitations || {};
  const limitations = {
    receipt_scope: lim.receipt_scope || receipt.receipt_type,
    pnl_type: lim.pnl_type || null,
    price_source: lim.price_source || null,
    disclosure_count: disclosureCodes.length,
  };

  // ── Proof ──
  const proof = {
    receipt_hash: receipt.receipt_hash || '',
    receipt_hash_short: shortHash(receipt.receipt_hash),
    candidate_hash: receipt.candidate_hash || '',
    candidate_hash_short: shortHash(receipt.candidate_hash),
    verification_status: verificationStatus,
    accounting_method: receipt.accounting_method || '',
  };

  // ── Time ──
  const time = {
    first_event: formatDate(receipt.first_event_at),
    last_event: formatDate(receipt.last_event_at),
    snapshot_at: formatDate(receipt.snapshot_at),
    hold_time_seconds: receipt.hold_time_seconds,
  };

  // ── Markdown ──
  const markdown = renderMarkdown({
    receipt, statusIcon, statusLabel, header, pnl, stats,
    valuation, limitations, proof, time, tokenSym, quoteSym,
  });

  return {
    receipt_id: receipt.receipt_id,
    display_status: statusLabel,
    receipt_type: receipt.receipt_type,
    receipt_version: receipt.receipt_version,
    header,
    pnl,
    stats,
    valuation,
    limitations,
    proof,
    time,
    markdown,
  };
}

// ═══════════════════════════════════════════════════════════════
// Markdown renderer
// ═══════════════════════════════════════════════════════════════

function renderMarkdown(ctx) {
  const {
    receipt, statusIcon, statusLabel, header, pnl, stats,
    valuation, proof, time, tokenSym, quoteSym,
  } = ctx;

  const lines = [];

  // Title
  lines.push(`## ${statusIcon} ${statusLabel}`);
  lines.push(`**${tokenSym} / ${quoteSym}** · ${header.chain} · ${header.wallet_short}`);
  lines.push('');

  // PnL (only if has_pnl)
  if (pnl.has_pnl) {
    lines.push('### PnL');
    lines.push(`${pnl.realized_pnl_pct_display} · ${pnl.realized_pnl_display}`);
    lines.push('');
  }

  // Stats
  lines.push('### Stats');
  lines.push(`Avg Entry: ${stats.avg_buy_price}`);
  if (receipt.receipt_type !== 'open_snapshot') {
    lines.push(`Avg Exit:  ${stats.avg_sell_price}`);
  }
  lines.push(`Cost Basis: ${stats.cost_basis}`);
  if (receipt.receipt_type !== 'open_snapshot') {
    lines.push(`Proceeds:   ${stats.exit_proceeds}`);
  }
  if (receipt.remaining_qty != null && receipt.receipt_type !== 'closed_position') {
    lines.push(`Remaining:  ${stats.remaining_qty}`);
  }
  if (time.hold_time_seconds != null) {
    lines.push(`Hold Time:  ${stats.hold_time}`);
  }
  lines.push(`Trades:     ${stats.trades}`);
  lines.push('');

  // Time
  lines.push('### Time');
  lines.push(`First event: ${time.first_event}`);
  lines.push(`Last event:  ${time.last_event}`);
  if (receipt.snapshot_at != null) {
    lines.push(`Snapshot:    ${time.snapshot_at}`);
  }
  lines.push('');

  // Valuation
  lines.push('### Valuation');
  lines.push(`Status: ${valuation.status}`);
  lines.push(`Currency: ${valuation.currency_label}`);
  for (const d of valuation.disclosures) {
    lines.push(`⚠️ ${d}`);
  }
  lines.push('');

  // Proof
  lines.push('### Proof');
  lines.push(`Receipt Hash:   ${proof.receipt_hash_short}`);
  lines.push(`Candidate Hash: ${proof.candidate_hash_short}`);
  lines.push(`Accounting:     ${proof.accounting_method}`);
  lines.push(`Receipt ID:     ${receipt.receipt_id}`);
  lines.push('');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// Batch preview
// ═══════════════════════════════════════════════════════════════

/**
 * Build previews for an array of v1.2 receipts.
 *
 * @param {object[]} receipts
 * @returns {object[]} Array of preview view-models
 */
export function buildReceiptPreviews(receipts) {
  return receipts.map(r => buildReceiptPreview(r));
}
