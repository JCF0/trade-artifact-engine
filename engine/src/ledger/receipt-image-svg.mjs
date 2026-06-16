/**
 * Receipt Image SVG — E3
 *
 * Pure function: D1 preview objects → self-contained static SVG strings.
 *
 * This module does NOT:
 *   - Upload to Arweave/Irys or any storage
 *   - Mint anything on-chain
 *   - Create or load keypairs
 *   - Read .env / secrets
 *   - Call Solana RPC or Metaplex/UMI
 *   - Modify receipts, metadata scaffolds, or mint plans
 *   - Include <script>, foreignObject, external images/fonts, or JS
 *   - Use Date.now() or perform I/O
 *
 * SVGs are static, self-contained, and XML-safe.
 */

// ═══════════════════════════════════════════════════════════════
// SVG/XML escaping
// ═══════════════════════════════════════════════════════════════

/**
 * Escape a string for safe SVG/XML text insertion.
 * @param {*} str
 * @returns {string}
 */
export function escapeSvg(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════
// Filename sanitization
// ═══════════════════════════════════════════════════════════════

const SAFE_FILENAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Sanitize a receipt_id for use as a filename.
 * Only allows [A-Za-z0-9_-]. Rejects anything else.
 * @param {string} id
 * @returns {string} Safe filename (without extension)
 * @throws {Error} If id contains disallowed characters
 */
export function sanitizeFilename(id) {
  if (!id || typeof id !== 'string') {
    throw new Error('receipt_id must be a non-empty string');
  }
  if (!SAFE_FILENAME_RE.test(id)) {
    throw new Error(`receipt_id contains unsafe characters for filename: "${id}"`);
  }
  return id;
}

// ═══════════════════════════════════════════════════════════════
// Color constants
// ═══════════════════════════════════════════════════════════════

const STATUS_COLORS = {
  verified:          '#00c076',
  verified_partial:  '#f0a030',
  verified_snapshot: '#4a90d9',
  unverified:        '#ff4d4d',
};

const PROFIT_COLOR = '#00c076';
const LOSS_COLOR = '#ff4d4d';

// ═══════════════════════════════════════════════════════════════
// SVG renderer
// ═══════════════════════════════════════════════════════════════

/**
 * Render a D1 preview object into a self-contained static SVG string.
 *
 * Pure function: no I/O, no Date.now().
 *
 * @param {object} preview - D1 preview object from buildReceiptPreview
 * @returns {string} Complete SVG document
 */
export function renderReceiptSvg(preview) {
  const e = escapeSvg;
  const W = 800;
  const H = 520;

  const verStatus = preview.proof?.verification_status || 'unverified';
  const accentColor = STATUS_COLORS[verStatus] || STATUS_COLORS.unverified;
  const hasPnl = preview.pnl?.has_pnl === true;
  const pnlColor = preview.pnl?.is_profit ? PROFIT_COLOR : LOSS_COLOR;
  const isSnapshot = preview.receipt_type === 'open_snapshot';

  // Build text sections
  const sections = [];
  let y = 0;

  // ── Background + border ──
  sections.push(`<rect width="${W}" height="${H}" rx="12" fill="#1a1f2e"/>`);
  sections.push(`<rect x="0" y="0" width="4" height="${H}" rx="2" fill="${accentColor}"/>`);

  // ── Header ──
  y = 36;
  sections.push(text(24, y, e(preview.display_status), { size: 15, weight: 600, fill: '#e1e8ed' }));
  sections.push(text(W - 24, y, e(preview.receipt_id), { size: 11, fill: '#556677', anchor: 'end', font: 'monospace' }));

  // ── Pair label ──
  y = 60;
  const pairStr = `${e(preview.header?.token_display)} / ${e(preview.header?.quote_symbol)} \u00b7 ${e(preview.header?.chain)} \u00b7 ${e(preview.header?.wallet_short)}`;
  sections.push(text(24, y, pairStr, { size: 13, fill: '#8899a6' }));

  // ── Divider ──
  y = 74;
  sections.push(`<line x1="24" y1="${y}" x2="${W - 24}" y2="${y}" stroke="#2a3040" stroke-width="1"/>`);

  // ── PnL hero (if has_pnl) ──
  if (hasPnl) {
    y = 118;
    sections.push(text(W / 2, y, e(preview.pnl.realized_pnl_pct_display), { size: 40, weight: 700, fill: pnlColor, anchor: 'middle' }));
    y = 144;
    sections.push(text(W / 2, y, e(preview.pnl.realized_pnl_display), { size: 15, fill: '#8899a6', anchor: 'middle' }));
    y = 162;
  } else {
    // Snapshot notice
    y = 118;
    sections.push(text(W / 2, y, 'Snapshot \u2014 No PnL Claim', { size: 18, weight: 600, fill: '#4a90d9', anchor: 'middle' }));
    y = 142;
  }

  // ── Divider ──
  sections.push(`<line x1="24" y1="${y}" x2="${W - 24}" y2="${y}" stroke="#2a3040" stroke-width="1"/>`);

  // ── Stats grid ──
  const col1 = 24;
  const col2 = W / 2 + 12;
  y += 24;

  sections.push(statBlock(col1, y, 'Avg Entry', e(preview.stats?.avg_buy_price)));
  if (!isSnapshot) {
    sections.push(statBlock(col2, y, 'Avg Exit', e(preview.stats?.avg_sell_price)));
  }

  y += 44;
  sections.push(statBlock(col1, y, 'Cost Basis', e(preview.stats?.cost_basis)));
  if (!isSnapshot) {
    sections.push(statBlock(col2, y, 'Proceeds', e(preview.stats?.exit_proceeds)));
  }

  y += 44;
  if (preview.receipt_type !== 'closed_position' && preview.stats?.remaining_qty != null) {
    sections.push(statBlock(col1, y, 'Remaining', e(String(preview.stats.remaining_qty))));
  } else {
    sections.push(statBlock(col1, y, 'Hold Time', e(preview.stats?.hold_time)));
  }
  sections.push(statBlock(col2, y, 'Trades', e(preview.stats?.trades)));

  if (preview.receipt_type !== 'closed_position' && preview.stats?.remaining_qty != null) {
    y += 44;
    sections.push(statBlock(col1, y, 'Hold Time', e(preview.stats?.hold_time)));
  }

  // ── Divider ──
  y += 44;
  sections.push(`<line x1="24" y1="${y}" x2="${W - 24}" y2="${y}" stroke="#2a3040" stroke-width="1"/>`);

  // ── Valuation ──
  y += 18;
  const valLabel = e(preview.valuation?.currency_label || 'raw_quote');
  sections.push(text(24, y, `Valuation: ${valLabel}`, { size: 11, fill: '#f0a030' }));

  // Disclosures (first 3 max to fit)
  const disclosures = preview.valuation?.disclosures || [];
  const maxDisc = Math.min(disclosures.length, 3);
  for (let i = 0; i < maxDisc; i++) {
    y += 15;
    sections.push(text(24, y, `\u26a0\ufe0f ${e(disclosures[i])}`, { size: 10, fill: '#8899a6' }));
  }
  if (disclosures.length > 3) {
    y += 15;
    sections.push(text(24, y, `+ ${disclosures.length - 3} more`, { size: 10, fill: '#556677' }));
  }

  // ── Divider ──
  y += 18;
  sections.push(`<line x1="24" y1="${y}" x2="${W - 24}" y2="${y}" stroke="#2a3040" stroke-width="1"/>`);

  // ── Proof footer ──
  y += 16;
  sections.push(text(24, y, `Receipt Hash: ${e(preview.proof?.receipt_hash_short)}   Candidate Hash: ${e(preview.proof?.candidate_hash_short)}`, { size: 10, fill: '#556677', font: 'monospace' }));
  y += 14;
  sections.push(text(24, y, e(preview.proof?.accounting_method), { size: 10, fill: '#556677', font: 'monospace' }));

  const inner = sections.join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0f1419"/>
  ${inner}
</svg>`;
}

// ═══════════════════════════════════════════════════════════════
// SVG helpers
// ═══════════════════════════════════════════════════════════════

function text(x, y, content, opts = {}) {
  const size = opts.size || 14;
  const weight = opts.weight || 400;
  const fill = opts.fill || '#e1e8ed';
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : '';
  const fontFamily = opts.font === 'monospace'
    ? '"Consolas","Courier New",monospace'
    : '-apple-system,"Segoe UI",Arial,sans-serif';
  return `<text x="${x}" y="${y}" font-family='${fontFamily}' font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor}>${content}</text>`;
}

function statBlock(x, y, label, value) {
  return [
    `<text x="${x}" y="${y}" font-family='-apple-system,"Segoe UI",Arial,sans-serif' font-size="10" font-weight="400" fill="#8899a6" text-transform="uppercase">${label}</text>`,
    `<text x="${x}" y="${y + 16}" font-family='-apple-system,"Segoe UI",Arial,sans-serif' font-size="13" font-weight="500" fill="#e1e8ed">${value}</text>`,
  ].join('\n  ');
}

// ═══════════════════════════════════════════════════════════════
// Batch
// ═══════════════════════════════════════════════════════════════

/**
 * Render SVGs for an array of D1 previews.
 *
 * @param {object[]} previews
 * @returns {string[]} Array of SVG strings
 */
export function renderReceiptSvgBatch(previews) {
  return previews.map(p => renderReceiptSvg(p));
}
