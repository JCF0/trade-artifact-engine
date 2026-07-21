import { renderBrandHeader, renderFaviconLink, renderPublicDemoStyles } from '../public-demo/visual-system.mjs';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCoverageTime(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed * 1000).toISOString();
}

function renderCoverageStatement(coverage) {
  if (!coverage || typeof coverage !== 'object') return '';
  const openedAt = formatCoverageTime(coverage.position_episode?.opened_at);
  const closedAt = formatCoverageTime(coverage.position_episode?.closed_at);
  const bounds = openedAt && closedAt
    ? `Receipt event bounds: ${openedAt} to ${closedAt}.`
    : 'Receipt event bounds incomplete.';
  const selectionLine = coverage.publication_context?.selection_mode === 'publisher_selected'
    ? '<p>Publisher-selected board entry.</p>'
    : '';

  return `<section class="coverage-statement scope-panel" aria-label="Coverage Statement">
      <h3>Coverage Statement</h3>
      <p>Receipt-scoped coverage only.</p>
      <p>${escapeHtml(bounds)}</p>
      <p>Raw quote only. No USD normalization.</p>
      ${selectionLine}
      <p>Not wallet, trader, portfolio, or track-record coverage.</p>
    </section>`;
}

function renderValue(value) {
  if (value == null || value === '') return 'Not available';
  return escapeHtml(value);
}

function humanizeReceiptType(value) {
  if (value === 'closed_position') return 'Closed Position';
  return renderValue(value).replace(/_/g, ' ');
}

function humanizeValuation(value) {
  if (value === 'raw_quote') return 'Raw Quote';
  return renderValue(value).replace(/_/g, ' ');
}

function renderDisclosures(disclosures) {
  return disclosures.map(item => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderLinks(links = {}) {
  const primary = links.proof_api_path
    ? `<a class="button-link primary" href="${escapeHtml(links.proof_api_path)}">View Receipt</a>`
    : '';
  const verifier = links.verifier_api_path
    ? `<a class="button-link secondary" href="${escapeHtml(links.verifier_api_path)}">Inspect Verifier</a>`
    : '';
  const technical = [
    ['Card JSON', links.card_api_path],
    ['Card Preview', links.card_preview_path],
    ['Hosted Preview', links.hosted_preview_path],
  ]
    .filter(([, href]) => typeof href === 'string' && href.length > 0)
    .map(([label, href]) => `<a class="button-link secondary" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
    .join('');
  return `${primary}${verifier}${technical}`;
}

function renderRow(row) {
  return `<article class="proof-card receipt-entry">
    <div class="receipt-card-top">
      <div class="rank-block">
        <span class="label">Receipt Rank</span>
        <strong>${renderValue(row.rank)}</strong>
      </div>
      <div class="entry-copy">
        <div class="badge-row compact">
          <span class="badge verified">Verified</span>
          <span class="badge blue">${humanizeValuation(row.valuation_status)}</span>
          <span class="badge blue">Coverage Scoped</span>
          <span class="badge">${humanizeReceiptType(row.receipt_type)}</span>
        </div>
        <h2>${renderValue(row.display_name)}</h2>
        ${row.participant_ref ? `<p class="participant-ref muted-copy">Entry reference: <span class="technical">${renderValue(row.participant_ref)}</span></p>` : ''}
        ${row.selection_note ? `<p class="selection-note muted-copy">${renderValue(row.selection_note)}</p>` : ''}
      </div>
    </div>
    <dl class="fields field-grid">
      <div class="field"><dt>Receipt</dt><dd>${renderValue(row.receipt_hash_short)}</dd></div>
      <div class="field"><dt>Receipt Type</dt><dd>${renderValue(row.receipt_type)}</dd></div>
      <div class="field"><dt>Token</dt><dd>${renderValue(row.token_display)}</dd></div>
      <div class="field"><dt>Verification</dt><dd>${renderValue(row.verification_status)}</dd></div>
      <div class="field"><dt>Valuation</dt><dd>${renderValue(row.valuation_status)}</dd></div>
      <div class="field"><dt>Trust</dt><dd>${renderValue(row.trust?.current_label)}</dd></div>
      <div class="field"><dt>Ranking Metric</dt><dd>${renderValue(row.ranking_metric?.display)}</dd></div>
    </dl>
    ${renderCoverageStatement(row.coverage_statement)}
    <nav class="links actions" aria-label="Receipt actions">${renderLinks(row.links)}</nav>
  </article>`;
}

function renderExcludedEntry(entry) {
  return `<li>
    <strong>${renderValue(entry.display_name)}</strong>
    <span class="technical">${renderValue(entry.receipt_hash)}</span>
    <em>${renderValue(entry.reason)}</em>
  </li>`;
}

export function renderReceiptBoardHtml(boardView, options = {}) {
  if (!boardView || typeof boardView !== 'object') {
    throw new TypeError('boardView is required');
  }

  const rows = Array.isArray(boardView.rows) ? boardView.rows : [];
  const excludedEntries = Array.isArray(boardView.excluded_entries) ? boardView.excluded_entries : [];
  const disclosures = Array.isArray(boardView.disclosures) ? boardView.disclosures : [];
  const assetBasePath = options.assetBasePath || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${renderValue(boardView.title || 'Historical Verified Receipt Board')}</title>
  ${renderFaviconLink(assetBasePath)}
  <style>
    ${renderPublicDemoStyles()}
    .receipt-card-top { display: grid; grid-template-columns: 104px 1fr; gap: 18px; align-items: start; }
    .rank-block { min-height: 104px; display: grid; align-content: center; justify-items: center; border-radius: 12px; background: linear-gradient(180deg, var(--navy) 0%, var(--navy-2) 100%); color: #ffffff; }
    .rank-block .label { color: rgba(255,255,255,0.72); text-align: center; }
    .rank-block strong { font-size: 40px; line-height: 1; }
    .proof-card { padding: 18px; display: grid; gap: 16px; }
    .entry-copy h2 { margin-top: 12px; margin-bottom: 8px; font-size: 26px; }
    .compact { margin-top: 0; }
    .links { border-top: 1px solid var(--border); padding-top: 14px; }
    .empty, .excluded { margin-top: 18px; padding: 18px; }
    .excluded ul { margin: 0; padding-left: 20px; color: var(--muted); }
    .excluded li { margin: 8px 0; overflow-wrap: anywhere; }
    .excluded span, .excluded em { display: block; }
    @media (max-width: 720px) {
      .receipt-card-top { grid-template-columns: 1fr; }
      .rank-block { min-height: auto; padding: 16px; justify-items: start; }
      .rank-block strong { font-size: 32px; }
    }
  </style>
</head>
<body>
  <main class="page-shell">
    ${renderBrandHeader({ assetBasePath, current: 'board', backHref: './index.html' })}
    <section class="hero-panel">
      <p class="eyebrow">Receipt entries only</p>
      <h1>${renderValue(boardView.title || 'Historical Verified Receipt Board')}</h1>
      <p class="lead">Verifiable receipts for on-chain trades.</p>
      <p class="explain">Artifact reconstructs supported Solana spot positions and publishes independently inspectable proof&mdash;with the limits shown.</p>
      <p class="supporting-line">Publisher-selected verified receipts. Receipt-ranked, not trader-ranked.</p>
      <div class="badge-row">
        <span class="badge blue">Scope: ${renderValue(boardView.selection_scope?.mode || 'publisher_selected')}</span>
        <span class="badge">Rank subject: ${renderValue(boardView.ranking?.rank_subject || 'receipt')}</span>
        <span class="badge">Metric: ${renderValue(boardView.ranking?.metric || 'trust_then_time')}</span>
        <span class="badge blue">Raw Quote</span>
      </div>
      <section class="scope-panel" aria-label="Scope and limitations">
        <h2>Scope and limitations</h2>
        ${boardView.subtitle ? `<p class="muted-copy">${renderValue(boardView.subtitle)}</p>` : ''}
        <ul class="disclosures">${renderDisclosures(disclosures)}</ul>
      </section>
    </section>
    ${rows.length === 0 ? '<section class="content-panel empty">No verified receipt entries are currently available for this board.</section>' : `<section class="rows">${rows.map(renderRow).join('')}</section>`}
    ${excludedEntries.length === 0 ? '' : `<section class="content-panel excluded" aria-label="Excluded entries">
      <h2>Excluded entries</h2>
      <ul>${excludedEntries.map(renderExcludedEntry).join('')}</ul>
    </section>`}
  </main>
</body>
</html>`;
}

export { escapeHtml };