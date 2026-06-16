/**
 * Receipt Preview HTML — D2
 *
 * Pure function: D1 preview objects → self-contained HTML string.
 *
 * This module does NOT:
 *   - Access or modify receipts directly
 *   - Recompute any receipt/preview fields
 *   - Fetch prices or convert to USD
 *   - Render PNGs, mint NFTs, or upload metadata
 *   - Use Date.now() or perform I/O
 */

// ═══════════════════════════════════════════════════════════════
// HTML escaping
// ═══════════════════════════════════════════════════════════════

/**
 * Escape a string for safe HTML insertion.
 * All data-derived strings MUST pass through this before embedding.
 * @param {*} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════
// Status → CSS class / border color
// ═══════════════════════════════════════════════════════════════

const STATUS_CSS = {
  verified:          'status-verified',
  verified_partial:  'status-partial',
  verified_snapshot: 'status-snapshot',
  unverified:        'status-unverified',
};

// ═══════════════════════════════════════════════════════════════
// Card renderer
// ═══════════════════════════════════════════════════════════════

function renderCard(preview) {
  const e = escapeHtml;
  const statusClass = STATUS_CSS[preview.proof?.verification_status] || 'status-unverified';
  const pnlClass = preview.pnl?.is_profit ? 'profit' : 'loss';
  const isSnapshot = preview.receipt_type === 'open_snapshot';

  let pnlSection = '';
  if (preview.pnl?.has_pnl) {
    pnlSection = `
    <div class="section pnl">
      <div class="pnl-pct ${pnlClass}">${e(preview.pnl.realized_pnl_pct_display)}</div>
      <div class="pnl-abs">${e(preview.pnl.realized_pnl_display)}</div>
    </div>`;
  }

  let statsRows = '';
  statsRows += stat('Avg Entry', preview.stats?.avg_buy_price);
  if (!isSnapshot) {
    statsRows += stat('Avg Exit', preview.stats?.avg_sell_price);
  }
  statsRows += stat('Cost Basis', preview.stats?.cost_basis);
  if (!isSnapshot) {
    statsRows += stat('Proceeds', preview.stats?.exit_proceeds);
  }
  if (preview.receipt_type !== 'closed_position' && preview.stats?.remaining_qty != null) {
    statsRows += stat('Remaining', preview.stats.remaining_qty);
  }
  statsRows += stat('Hold Time', preview.stats?.hold_time);
  statsRows += stat('Trades', preview.stats?.trades);

  let disclosureItems = '';
  if (preview.valuation?.disclosures?.length > 0) {
    disclosureItems = preview.valuation.disclosures
      .map(d => `<li>\u26a0\ufe0f ${e(d)}</li>`)
      .join('\n        ');
  }

  let timeRange = e(preview.time?.first_event || '');
  if (preview.time?.last_event && preview.time.last_event !== '\u2014') {
    timeRange += ` \u2192 ${e(preview.time.last_event)}`;
  }
  let snapshotLine = '';
  if (preview.time?.snapshot_at && preview.time.snapshot_at !== '\u2014') {
    snapshotLine = `<div class="time-snapshot">Snapshot: ${e(preview.time.snapshot_at)}</div>`;
  }

  return `
  <div class="card ${statusClass}">
    <div class="card-header">
      <span class="status-label">${e(preview.display_status)}</span>
      <span class="receipt-id">${e(preview.receipt_id)}</span>
    </div>

    <div class="pair-label">${e(preview.header?.token_display)} / ${e(preview.header?.quote_symbol)} \u00b7 ${e(preview.header?.chain)} \u00b7 ${e(preview.header?.wallet_short)}</div>

    ${pnlSection}

    <div class="section stats">
      ${statsRows}
    </div>

    <div class="section valuation">
      <div class="valuation-label">${e(preview.valuation?.currency_label)}</div>
      <ul class="disclosures">
        ${disclosureItems}
      </ul>
    </div>

    <div class="section proof">
      <div class="hash">Receipt Hash: <code>${e(preview.proof?.receipt_hash_short)}</code></div>
      <div class="hash">Candidate Hash: <code>${e(preview.proof?.candidate_hash_short)}</code></div>
      <div class="accounting">${e(preview.proof?.accounting_method)}</div>
    </div>

    <div class="section time">
      <span>${timeRange}</span>
      ${snapshotLine}
    </div>
  </div>`;
}

function stat(label, value) {
  return `<div class="stat"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>\n      `;
}

// ═══════════════════════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════════════════════

const CSS = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f1419; color: #e1e8ed; font-family: -apple-system, "Segoe UI", Arial, sans-serif; padding: 24px; }
    header { max-width: 800px; margin: 0 auto 24px; }
    header h1 { font-size: 20px; font-weight: 600; }
    header p { color: #8899a6; font-size: 13px; margin-top: 4px; }
    .card { max-width: 800px; margin: 0 auto 20px; background: #1a1f2e; border-radius: 12px; padding: 20px 24px; border-left: 4px solid #556677; }
    .card.status-verified { border-left-color: #00c076; }
    .card.status-partial { border-left-color: #f0a030; }
    .card.status-snapshot { border-left-color: #4a90d9; }
    .card.status-unverified { border-left-color: #ff4d4d; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .status-label { font-weight: 600; font-size: 15px; }
    .receipt-id { color: #556677; font-size: 12px; font-family: "Consolas", "Courier New", monospace; }
    .pair-label { color: #8899a6; font-size: 14px; margin-bottom: 12px; }
    .section { margin-top: 12px; padding-top: 12px; border-top: 1px solid #2a3040; }
    .pnl { text-align: center; }
    .pnl-pct { font-size: 32px; font-weight: 700; }
    .pnl-pct.profit { color: #00c076; }
    .pnl-pct.loss { color: #ff4d4d; }
    .pnl-abs { font-size: 14px; color: #8899a6; margin-top: 4px; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
    .stat .label { display: block; color: #8899a6; font-size: 11px; text-transform: uppercase; }
    .stat .value { display: block; color: #e1e8ed; font-size: 14px; font-weight: 500; }
    .valuation-label { color: #f0a030; font-size: 13px; font-weight: 500; }
    .disclosures { list-style: none; margin-top: 6px; padding: 0; }
    .disclosures li { color: #8899a6; font-size: 12px; margin-top: 3px; }
    .proof { font-family: "Consolas", "Courier New", monospace; font-size: 12px; color: #556677; }
    .proof div { margin-top: 2px; }
    .proof code { color: #8899a6; }
    .accounting { font-size: 11px; margin-top: 4px; }
    .time { font-size: 12px; color: #556677; }
    .time-snapshot { margin-top: 2px; }
`;

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

/**
 * Render D1 preview objects into a self-contained HTML string.
 *
 * Pure function: no I/O, no Date.now().
 *
 * @param {object[]} previews - Array of D1 preview objects from buildReceiptPreviews
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] - ISO-8601 timestamp for the header
 * @returns {string} Complete HTML document
 */
export function renderPreviewsHtml(previews, opts = {}) {
  const generatedAt = escapeHtml(opts.generatedAt || '');
  const count = previews.length;

  const cards = previews.map(p => renderCard(p)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>v1.2 Receipt Previews</title>
  <style>${CSS}</style>
</head>
<body>
  <header>
    <h1>v1.2 Receipt Previews</h1>
    <p>${count} receipt${count !== 1 ? 's' : ''} \u00b7 Generated ${generatedAt}</p>
  </header>
${cards}
</body>
</html>`;
}
