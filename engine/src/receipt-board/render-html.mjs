function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderValue(value) {
  if (value == null || value === '') return 'Not available';
  return escapeHtml(value);
}

function renderDisclosures(disclosures) {
  return disclosures.map(item => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderLinks(links = {}) {
  return [
    ['Proof', links.proof_api_path],
    ['Verifier', links.verifier_api_path],
    ['Card JSON', links.card_api_path],
    ['Card Preview', links.card_preview_path],
    ['Hosted Preview', links.hosted_preview_path],
  ]
    .filter(([, href]) => typeof href === 'string' && href.length > 0)
    .map(([label, href]) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
    .join('');
}

function renderRow(row) {
  return `<article class="receipt-entry">
    <div class="rank-block">
      <span class="label">Receipt Rank</span>
      <strong>${renderValue(row.rank)}</strong>
    </div>
    <div class="entry-copy">
      <h2>${renderValue(row.display_name)}</h2>
      ${row.participant_ref ? `<p class="participant-ref">Entry reference: ${renderValue(row.participant_ref)}</p>` : ''}
      ${row.selection_note ? `<p class="selection-note">${renderValue(row.selection_note)}</p>` : ''}
    </div>
    <dl class="fields">
      <div><dt>Receipt</dt><dd>${renderValue(row.receipt_hash_short)}</dd></div>
      <div><dt>Receipt Type</dt><dd>${renderValue(row.receipt_type)}</dd></div>
      <div><dt>Token</dt><dd>${renderValue(row.token_display)}</dd></div>
      <div><dt>Verification</dt><dd>${renderValue(row.verification_status)}</dd></div>
      <div><dt>Valuation</dt><dd>${renderValue(row.valuation_status)}</dd></div>
      <div><dt>Trust</dt><dd>${renderValue(row.trust?.current_label)}</dd></div>
      <div><dt>Ranking Metric</dt><dd>${renderValue(row.ranking_metric?.display)}</dd></div>
    </dl>
    <nav class="links">${renderLinks(row.links)}</nav>
  </article>`;
}

function renderExcludedEntry(entry) {
  return `<li>
    <strong>${renderValue(entry.display_name)}</strong>
    <span>${renderValue(entry.receipt_hash)}</span>
    <em>${renderValue(entry.reason)}</em>
  </li>`;
}

export function renderReceiptBoardHtml(boardView) {
  if (!boardView || typeof boardView !== 'object') {
    throw new TypeError('boardView is required');
  }

  const rows = Array.isArray(boardView.rows) ? boardView.rows : [];
  const excludedEntries = Array.isArray(boardView.excluded_entries) ? boardView.excluded_entries : [];
  const disclosures = Array.isArray(boardView.disclosures) ? boardView.disclosures : [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${renderValue(boardView.title || 'Historical Verified Receipt Board')}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #efe9dc;
      --panel: #fffaf2;
      --ink: #1d1a15;
      --muted: #675e51;
      --border: #d7c8b2;
      --accent: #75542f;
      --soft: #f4eadb;
      --excluded: #f7e4d9;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at 12% 8%, rgba(255, 250, 242, 0.96), transparent 34%),
        linear-gradient(180deg, #f8f1e6 0%, var(--bg) 100%);
      color: var(--ink);
      font-family: Georgia, 'Times New Roman', serif;
    }
    main { width: min(1120px, 100%); margin: 0 auto; padding: 30px 18px 42px; }
    header { margin-bottom: 22px; }
    .eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(30px, 5vw, 48px); line-height: 1.02; }
    .subtitle { margin: 12px 0 16px; color: var(--muted); font-size: 17px; }
    .disclosures {
      margin: 0;
      padding: 16px 18px 16px 34px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: rgba(255, 250, 242, 0.82);
      color: var(--muted);
    }
    .board-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 18px 0 0;
    }
    .pill {
      border: 1px solid var(--border);
      background: var(--soft);
      border-radius: 999px;
      padding: 8px 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .rows { display: grid; gap: 16px; margin-top: 22px; }
    .receipt-entry {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 16px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 18px;
      box-shadow: 0 18px 42px rgba(41, 31, 18, 0.08);
    }
    .rank-block {
      min-height: 96px;
      display: grid;
      align-content: center;
      justify-items: center;
      border-radius: 18px;
      background: linear-gradient(180deg, #f6ead8 0%, #ead9bf 100%);
      border: 1px solid var(--border);
    }
    .rank-block .label { color: var(--muted); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; text-align: center; }
    .rank-block strong { font-size: 38px; line-height: 1; margin-top: 8px; }
    .entry-copy h2 { margin: 0; font-size: 24px; }
    .participant-ref, .selection-note { margin: 8px 0 0; color: var(--muted); overflow-wrap: anywhere; }
    .fields {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
      margin: 0;
    }
    .fields div {
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--soft);
    }
    dt { color: var(--muted); font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; }
    dd { margin: 5px 0 0; overflow-wrap: anywhere; }
    .links { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 10px; }
    .links a {
      color: var(--accent);
      text-decoration: none;
      font-weight: 700;
      border: 1px solid var(--border);
      background: #fff;
      border-radius: 999px;
      padding: 8px 12px;
    }
    .links a:hover { text-decoration: underline; }
    .empty, .excluded {
      margin-top: 22px;
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 18px;
      background: var(--panel);
    }
    .excluded { background: var(--excluded); }
    .excluded h2 { margin: 0 0 12px; font-size: 21px; }
    .excluded ul { margin: 0; padding-left: 20px; color: var(--muted); }
    .excluded li { margin: 8px 0; overflow-wrap: anywhere; }
    .excluded span, .excluded em { display: block; }
    @media (max-width: 680px) {
      .receipt-entry { grid-template-columns: 1fr; }
      .rank-block { min-height: auto; padding: 18px; }
      .fields { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Receipt entries only</p>
      <h1>${renderValue(boardView.title || 'Historical Verified Receipt Board')}</h1>
      <p class="subtitle">${renderValue(boardView.subtitle || 'Selected historical receipts only. Not a trader leaderboard.')}</p>
      <ul class="disclosures">${renderDisclosures(disclosures)}</ul>
      <div class="board-meta">
        <span class="pill">Rank subject: ${renderValue(boardView.ranking?.rank_subject || 'receipt')}</span>
        <span class="pill">Metric: ${renderValue(boardView.ranking?.metric || 'trust_then_time')}</span>
        <span class="pill">Scope: ${renderValue(boardView.selection_scope?.mode || 'publisher_selected')}</span>
      </div>
    </header>
    ${rows.length === 0 ? '<section class="empty">No verified receipt entries are currently available for this board.</section>' : `<section class="rows">${rows.map(renderRow).join('')}</section>`}
    ${excludedEntries.length === 0 ? '' : `<section class="excluded" aria-label="Excluded entries">
      <h2>Excluded entries</h2>
      <ul>${excludedEntries.map(renderExcludedEntry).join('')}</ul>
    </section>`}
  </main>
</body>
</html>`;
}

export { escapeHtml };
