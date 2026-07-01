function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatValue(value) {
  if (value == null || value === '') return 'Not available';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function formatTime(value) {
  if (value == null || value === '') return 'Not available';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return String(value);
}

function renderDefinitionRows(rows) {
  return rows.map(([label, value]) => `
        <div class="field">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>`).join('');
}

function renderList(label, values) {
  const items = Array.isArray(values) ? values.filter(value => value != null && value !== '') : [];
  if (items.length === 0) {
    return `
      <div class="subsection">
        <h3>${escapeHtml(label)}</h3>
        <p class="empty">Not available</p>
      </div>`;
  }

  return `
      <div class="subsection">
        <h3>${escapeHtml(label)}</h3>
        <ul>
          ${items.map(value => `<li>${escapeHtml(formatValue(value))}</li>`).join('')}
        </ul>
      </div>`;
}

function renderSection(title, body) {
  return `
    <section>
      <h2>${escapeHtml(title)}</h2>
      ${body}
    </section>`;
}

function renderLinks(links) {
  const rows = [
    ['Inventory Path', links.inventory_path],
    ['Inventory API Path', links.inventory_api_path],
    ['Proof API Path', links.proof_api_path],
    ['Legacy Path', links.legacy_path],
  ];

  return rows.map(([label, value]) => {
    const content = value
      ? `<a href="${escapeHtml(value)}">${escapeHtml(value)}</a>`
      : 'Not available';
    return `
        <div class="field">
          <dt>${escapeHtml(label)}</dt>
          <dd>${content}</dd>
        </div>`;
  }).join('');
}

export function renderStaticProofPage(proofDetail, options = {}) {
  if (!proofDetail || typeof proofDetail !== 'object') {
    throw new TypeError('proofDetail is required');
  }

  const generatedAt = options.generatedAt || new Date().toISOString();
  const pageTitle = options.title || `Trade Artifact Static Proof - ${proofDetail.receipt?.receipt_id || 'Selected Receipt'}`;

  const receiptRows = [
    ['Receipt ID', formatValue(proofDetail.receipt?.receipt_id)],
    ['Receipt Hash', formatValue(proofDetail.receipt?.receipt_hash)],
    ['Receipt Version', formatValue(proofDetail.receipt?.receipt_version)],
    ['Receipt Type', formatValue(proofDetail.receipt?.receipt_type)],
    ['Verification Status', formatValue(proofDetail.receipt?.verification_status)],
    ['Display Status', formatValue(proofDetail.receipt?.display_status)],
    ['Wallet', formatValue(proofDetail.receipt?.wallet)],
    ['Chain', formatValue(proofDetail.receipt?.chain)],
    ['Token Mint', formatValue(proofDetail.receipt?.token_mint)],
    ['Quote Mint', formatValue(proofDetail.receipt?.quote_mint)],
    ['Quote Symbol', formatValue(proofDetail.receipt?.quote_symbol)],
    ['Candidate Hash', formatValue(proofDetail.receipt?.candidate_hash)],
    ['Valuation Status', formatValue(proofDetail.receipt?.valuation_status)],
    ['Position Status', formatValue(proofDetail.receipt?.position_status)],
    ['First Event At', formatTime(proofDetail.receipt?.first_event_at)],
    ['Last Event At', formatTime(proofDetail.receipt?.last_event_at)],
    ['Snapshot At', formatTime(proofDetail.receipt?.snapshot_at)],
  ];

  const verificationRows = [
    ['Verification Status', formatValue(proofDetail.verification?.verification_status)],
    ['Hash Valid', formatValue(proofDetail.verification?.hash_valid)],
    ['Recomputed Hash', formatValue(proofDetail.verification?.recomputed_hash)],
    ['Verifier Passed', formatValue(proofDetail.verification?.verifier_passed)],
    ['Schema Valid', formatValue(proofDetail.verification?.verifier_schema_valid)],
    ['Consistency Valid', formatValue(proofDetail.verification?.verifier_consistency_valid)],
    ['Proof Summary Status', formatValue(proofDetail.verification?.proof_summary?.verification_status)],
    ['Proof Summary Violations', formatValue(proofDetail.verification?.proof_summary?.violations)],
  ];

  const valuationRows = [
    ['Valuation Status', formatValue(proofDetail.valuation?.valuation_status)],
    ['Valuation Valid', formatValue(proofDetail.valuation?.valuation_valid)],
    ['Valuation Currency', formatValue(proofDetail.valuation?.valuation_context?.valuation_currency)],
    ['Quote Is USD Stable', formatValue(proofDetail.valuation?.valuation_context?.quote_is_usd_stable)],
  ];

  const lifecycleRows = [
    ['Image Status', formatValue(proofDetail.proof_lifecycle?.image_status)],
    ['Upload Status', formatValue(proofDetail.proof_lifecycle?.upload_status)],
    ['Upload Mode', formatValue(proofDetail.proof_lifecycle?.upload_mode)],
    ['Upload Network', formatValue(proofDetail.proof_lifecycle?.upload_network)],
    ['Uploaded At', formatTime(proofDetail.proof_lifecycle?.uploaded_at)],
    ['Uploader Pubkey', formatValue(proofDetail.proof_lifecycle?.uploader_pubkey)],
    ['Mint Ready', formatValue(proofDetail.proof_lifecycle?.mint_ready)],
    ['Mint Status', formatValue(proofDetail.proof_lifecycle?.mint_status)],
    ['Mint Network', formatValue(proofDetail.proof_lifecycle?.mint_network)],
    ['Proof Wallet Pubkey', formatValue(proofDetail.proof_lifecycle?.proof_wallet_pubkey)],
    ['Mint Authority Pubkey', formatValue(proofDetail.proof_lifecycle?.mint_authority_pubkey)],
    ['Mint Address', formatValue(proofDetail.proof_lifecycle?.mint_address)],
    ['Token Account', formatValue(proofDetail.proof_lifecycle?.token_account)],
    ['Transaction Signature', formatValue(proofDetail.proof_lifecycle?.transaction_signature)],
    ['Minted At', formatTime(proofDetail.proof_lifecycle?.minted_at)],
  ];

  const artifactRows = [
    ['Image Artifact Path', formatValue(proofDetail.artifacts?.image_artifact_path)],
    ['Image Artifact Hash', formatValue(proofDetail.artifacts?.image_artifact_hash)],
    ['Metadata Name', formatValue(proofDetail.artifacts?.metadata_name)],
    ['Metadata Template Path', formatValue(proofDetail.artifacts?.metadata_template_path)],
    ['Resolved Metadata Path', formatValue(proofDetail.artifacts?.resolved_metadata_path)],
    ['Final Metadata Path', formatValue(proofDetail.artifacts?.final_metadata_path)],
    ['Final Image URI', formatValue(proofDetail.artifacts?.final_image_uri)],
    ['Final Metadata URI', formatValue(proofDetail.artifacts?.final_metadata_uri)],
    ['Metadata URI', formatValue(proofDetail.artifacts?.metadata_uri)],
    ['Image URI', formatValue(proofDetail.artifacts?.image_uri)],
    ['External URL', formatValue(proofDetail.artifacts?.external_url)],
  ];

  const limitationRows = [
    ['Limitations', formatValue(proofDetail.flags_and_limitations?.limitations)],
    ['Raw Quote Disclosure', formatValue(proofDetail.flags_and_limitations?.raw_quote_only_disclosure)],
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f1e8;
      --surface: #fffdf8;
      --border: #d6cfc2;
      --text: #1d1b18;
      --muted: #625b52;
      --accent: #7c3f00;
      --ok: #17633a;
      --warn: #9a6700;
      --bad: #9b2226;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: Georgia, 'Times New Roman', serif; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px 48px; }
    header, section, footer { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 18px; }
    h1, h2, h3 { margin: 0 0 12px; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    h3 { font-size: 14px; color: var(--muted); }
    p { margin: 0 0 10px; line-height: 1.5; }
    .lede { color: var(--muted); }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
    .summary-card { border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: #fffaf1; }
    .summary-card strong { display: block; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
    .summary-card span { font-size: 18px; font-weight: 600; }
    .summary-card.verification-status { border-left: 6px solid var(--accent); }
    .summary-card.hash-check { border-left: 6px solid var(--ok); }
    .summary-card.lifecycle { border-left: 6px solid var(--warn); }
    dl.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 0; }
    .field { border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: #fffaf1; }
    dt { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 6px; }
    dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; white-space: pre-wrap; }
    .subsection { margin-top: 16px; }
    ul { margin: 8px 0 0 20px; padding: 0; }
    li { margin-bottom: 6px; overflow-wrap: anywhere; }
    .empty { color: var(--muted); }
    a { color: var(--accent); overflow-wrap: anywhere; }
    .notice { border: 1px solid var(--accent); background: #fff6e8; border-radius: 8px; padding: 14px; }
    .footer-notes p { margin-bottom: 8px; }
    @media print {
      body { background: #ffffff; }
      header, section, footer { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(pageTitle)}</h1>
      <p class="lede">Selected receipt only. This static proof page is a local export scaffold, not hosted proof delivery.</p>
      <p class="lede">Generated at ${escapeHtml(generatedAt)}</p>
      <div class="summary">
        <div class="summary-card verification-status">
          <strong>Verification Status</strong>
          <span>${escapeHtml(formatValue(proofDetail.receipt?.verification_status))}</span>
        </div>
        <div class="summary-card hash-check">
          <strong>Hash Valid / Verifier Passed</strong>
          <span>${escapeHtml(formatValue(proofDetail.verification?.hash_valid))} / ${escapeHtml(formatValue(proofDetail.verification?.verifier_passed))}</span>
        </div>
        <div class="summary-card lifecycle">
          <strong>Proof Lifecycle</strong>
          <span>${escapeHtml(formatValue(proofDetail.proof_lifecycle?.upload_status))} / ${escapeHtml(formatValue(proofDetail.proof_lifecycle?.mint_status))}</span>
        </div>
      </div>
    </header>

    ${renderSection('Receipt', `<dl class="grid">${renderDefinitionRows(receiptRows)}</dl>`)}
    ${renderSection('Verification', `<dl class="grid">${renderDefinitionRows(verificationRows)}</dl>${renderList('Verifier Rule Violations', proofDetail.verification?.verifier_rule_violations)}`)}
    ${renderSection('Valuation', `<div class="notice"><p>${escapeHtml(formatValue(proofDetail.valuation?.disclosure_text))}</p></div><dl class="grid">${renderDefinitionRows(valuationRows)}</dl>${renderList('Valuation Violations', proofDetail.valuation?.valuation_context?.violations)}`)}
    ${renderSection('Proof Lifecycle', `<dl class="grid">${renderDefinitionRows(lifecycleRows)}</dl>${renderList('Mint Blockers', proofDetail.proof_lifecycle?.mint_blockers)}${renderList('Mint Required Steps', proofDetail.proof_lifecycle?.mint_required_steps)}`)}
    ${renderSection('Artifacts', `<dl class="grid">${renderDefinitionRows(artifactRows)}</dl>`)}
    ${renderSection('Flags & Limitations', `<dl class="grid">${renderDefinitionRows(limitationRows)}</dl>${renderList('Flags', proofDetail.flags_and_limitations?.flags)}${renderList('Disclosures', proofDetail.flags_and_limitations?.disclosures)}`)}
    ${renderSection('Links', `<dl class="grid">${renderLinks(proofDetail.links || {})}</dl>`)}

    <footer class="footer-notes">
      <p>Raw quote only. No USD normalization.</p>
      <p>Selected receipt only. This page does not represent a portfolio-wide statement.</p>
      <p>Local export scaffold only. No hosting, upload, minting, or signing is performed by this artifact.</p>
    </footer>
  </main>
</body>
</html>`;
}
