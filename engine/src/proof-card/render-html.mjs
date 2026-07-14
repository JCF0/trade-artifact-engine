function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCoverageSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const rows = [
    ['Scope', summary.scope],
    ['Event Bounds', summary.event_bounds],
    ['Valuation', summary.valuation],
    ['Limitation', summary.limitation],
  ];
  return `<section class="coverage-summary" aria-label="Coverage Statement">
        <h2>${escapeHtml(summary.heading || 'Coverage Statement')}</h2>
        <dl class="metrics">
          ${rows.map(([label, value]) => `
          <div class="metric">
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(value || 'Not available')}</dd>
          </div>`).join('')}
        </dl>
      </section>`;
}

function renderList(items) {
  return items.map(item => `<li>${escapeHtml(item)}</li>`).join('');
}

export function renderProofCardHtml(cardView) {
  if (!cardView || typeof cardView !== 'object') {
    throw new TypeError('cardView is required');
  }

  const receipt = cardView.receipt || {};
  const trust = cardView.trust || {};
  const verification = cardView.verification || {};
  const links = cardView.links || {};
  const summaryFields = Array.isArray(cardView.summary_fields) ? cardView.summary_fields : [];
  const disclosures = Array.isArray(cardView.disclosures) ? cardView.disclosures : [];
  const coverageSummary = cardView.coverage_summary || null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(cardView.title || 'Artifact Proof')}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #efe6d7;
      --panel: #fffaf3;
      --border: #d2c3ad;
      --ink: #1f1a14;
      --muted: #65594c;
      --accent: #8b5e34;
      --accent-soft: #f1e4d4;
      --ok: #1d5d43;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: radial-gradient(circle at top, #f8f1e7 0%, var(--bg) 55%, #e3d4bf 100%);
      color: var(--ink);
      font-family: Georgia, 'Times New Roman', serif;
    }
    article {
      width: min(100%, 760px);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 22px;
      box-shadow: 0 20px 60px rgba(44, 30, 15, 0.12);
      overflow: hidden;
    }
    .hero {
      padding: 28px 28px 20px;
      background: linear-gradient(135deg, #f8efe2 0%, #fdf9f3 55%, #f0e0ca 100%);
      border-bottom: 1px solid var(--border);
    }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 12px;
    }
    h1 {
      margin: 0;
      font-size: 34px;
      line-height: 1.05;
    }
    .subtitle {
      margin: 10px 0 0;
      color: var(--muted);
      font-size: 16px;
    }
    .token-band {
      margin-top: 18px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .token-display {
      font-size: 22px;
      font-weight: 700;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 7px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.7);
      font-size: 13px;
      color: var(--muted);
    }
    .content {
      padding: 22px 28px 28px;
      display: grid;
      gap: 18px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .metric {
      background: var(--accent-soft);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
    }
    .metric dt {
      margin: 0 0 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
    }
    .metric dd {
      margin: 0;
      font-size: 17px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .hash-row, .footer-row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      align-items: center;
    }
    .hash-card {
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: #fff;
      flex: 1 1 320px;
    }
    .hash-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .hash-value {
      font-size: 20px;
      font-weight: 700;
    }
    .verifier-link {
      color: var(--accent);
      text-decoration: none;
      font-weight: 700;
    }
    .verifier-link:hover { text-decoration: underline; }
    .disclosures {
      margin: 0;
      padding-left: 20px;
      color: var(--muted);
    }
    .status-inline {
      color: var(--ok);
      font-weight: 700;
    }
    @media (max-width: 640px) {
      body { padding: 14px; }
      .hero, .content { padding-left: 18px; padding-right: 18px; }
      h1 { font-size: 28px; }
      .token-display { font-size: 20px; }
    }
  </style>
</head>
<body>
  <article>
    <section class="hero">
      <div class="eyebrow">${escapeHtml(cardView.card_type || 'artifact_proof_card')}</div>
      <h1>${escapeHtml(cardView.title || 'Artifact Proof')}</h1>
      <p class="subtitle">${escapeHtml(cardView.subtitle || 'Selected receipt summary')}</p>
      <div class="token-band">
        <div class="token-display">${escapeHtml(receipt.token_display || 'Not available')}</div>
        <div class="pill">${escapeHtml(receipt.receipt_type || 'Not available')}</div>
        <div class="pill">${escapeHtml(receipt.valuation_status || 'Not available')}</div>
      </div>
    </section>
    <section class="content">
      <dl class="metrics">
        ${summaryFields.map(field => `
        <div class="metric">
          <dt>${escapeHtml(field.label || '')}</dt>
          <dd>${escapeHtml(field.value == null || field.value === '' ? 'Not available' : field.value)}</dd>
        </div>`).join('')}
      </dl>
      <div class="metrics">
        <div class="metric">
          <dt>Hash Valid</dt>
          <dd>${escapeHtml(verification.hash_valid === true ? 'Yes' : verification.hash_valid === false ? 'No' : 'Not available')}</dd>
        </div>
        <div class="metric">
          <dt>Verifier Passed</dt>
          <dd>${escapeHtml(verification.verifier_passed === true ? 'Yes' : verification.verifier_passed === false ? 'No' : 'Not available')}</dd>
        </div>
        <div class="metric">
          <dt>Wallet Display</dt>
          <dd>${escapeHtml(receipt.wallet_display_mode || 'full')}</dd>
        </div>
        <div class="metric">
          <dt>Wallet</dt>
          <dd>${escapeHtml(receipt.wallet || 'Not available')}</dd>
        </div>
      </div>
      ${renderCoverageSummary(coverageSummary)}
      <div class="hash-row">
        <div class="hash-card">
          <div class="hash-label">Receipt Hash</div>
          <div class="hash-value">${escapeHtml(receipt.receipt_hash_short || 'Not available')}</div>
        </div>
        <a class="verifier-link" href="${escapeHtml(links.verifier_api_path || '')}">${escapeHtml(links.verifier_api_path || 'Not available')}</a>
      </div>
      <div class="footer-row">
        <div><strong class="status-inline">${escapeHtml(trust.current_label || 'Not available')}</strong></div>
        <div>${escapeHtml(receipt.display_status || 'Not available')}</div>
      </div>
      <ul class="disclosures">
        ${renderList(disclosures)}
      </ul>
    </section>
  </article>
</body>
</html>`;
}