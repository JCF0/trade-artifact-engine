import { applyWalletDisplayPolicy } from '../proof-publish/wallet-policy.mjs';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
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

function renderSummaryCards(cards) {
  return `
      <div class="summary">
        ${cards.map(card => `
        <div class="summary-card ${escapeHtml(card.className)}">
          <strong>${escapeHtml(card.label)}</strong>
          <span>${escapeHtml(card.value)}</span>
        </div>`).join('')}
      </div>`;
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

function getHostedContext(options = {}) {
  if (!options.hosted || typeof options.hosted !== 'object') return null;

  return {
    walletDisplayMode: options.hosted.walletDisplayMode || 'truncated',
  };
}

export function renderStaticProofPage(proofDetail, options = {}) {
  if (!proofDetail || typeof proofDetail !== 'object') {
    throw new TypeError('proofDetail is required');
  }

  const hosted = getHostedContext(options);
  const renderedProofDetail = hosted
    ? applyWalletDisplayPolicy(proofDetail, { mode: hosted.walletDisplayMode })
    : proofDetail;
  const generatedAt = options.generatedAt || new Date().toISOString();
  const pageTitle = options.title || `Trade Artifact Static Proof - ${renderedProofDetail.receipt?.receipt_id || 'Selected Receipt'}`;

  const receiptRows = [
    ['Receipt ID', formatValue(renderedProofDetail.receipt?.receipt_id)],
    ['Receipt Hash', formatValue(renderedProofDetail.receipt?.receipt_hash)],
    ['Receipt Version', formatValue(renderedProofDetail.receipt?.receipt_version)],
    ['Receipt Type', formatValue(renderedProofDetail.receipt?.receipt_type)],
    ['Verification Status', formatValue(renderedProofDetail.receipt?.verification_status)],
    ['Display Status', formatValue(renderedProofDetail.receipt?.display_status)],
    ['Wallet', formatValue(renderedProofDetail.receipt?.wallet)],
    ['Chain', formatValue(renderedProofDetail.receipt?.chain)],
    ['Token Mint', formatValue(renderedProofDetail.receipt?.token_mint)],
    ['Quote Mint', formatValue(renderedProofDetail.receipt?.quote_mint)],
    ['Quote Symbol', formatValue(renderedProofDetail.receipt?.quote_symbol)],
    ['Candidate Hash', formatValue(renderedProofDetail.receipt?.candidate_hash)],
    ['Valuation Status', formatValue(renderedProofDetail.receipt?.valuation_status)],
    ['Position Status', formatValue(renderedProofDetail.receipt?.position_status)],
    ['First Event At', formatTime(renderedProofDetail.receipt?.first_event_at)],
    ['Last Event At', formatTime(renderedProofDetail.receipt?.last_event_at)],
    ['Snapshot At', formatTime(renderedProofDetail.receipt?.snapshot_at)],
  ];

  const verificationRows = [
    ['Verification Status', formatValue(renderedProofDetail.verification?.verification_status)],
    ['Hash Valid', formatValue(renderedProofDetail.verification?.hash_valid)],
    ['Recomputed Hash', formatValue(renderedProofDetail.verification?.recomputed_hash)],
    ['Verifier Passed', formatValue(renderedProofDetail.verification?.verifier_passed)],
    ['Schema Valid', formatValue(renderedProofDetail.verification?.verifier_schema_valid)],
    ['Consistency Valid', formatValue(renderedProofDetail.verification?.verifier_consistency_valid)],
    ['Proof Summary Status', formatValue(renderedProofDetail.verification?.proof_summary?.verification_status)],
    ['Proof Summary Violations', formatValue(renderedProofDetail.verification?.proof_summary?.violations)],
  ];

  const valuationRows = [
    ['Valuation Status', formatValue(renderedProofDetail.valuation?.valuation_status)],
    ['Valuation Valid', formatValue(renderedProofDetail.valuation?.valuation_valid)],
    ['Valuation Currency', formatValue(renderedProofDetail.valuation?.valuation_context?.valuation_currency)],
    ['Quote Is USD Stable', formatValue(renderedProofDetail.valuation?.valuation_context?.quote_is_usd_stable)],
  ];

  const lifecycleRows = [
    ['Image Status', formatValue(renderedProofDetail.proof_lifecycle?.image_status)],
    ['Upload Status', formatValue(renderedProofDetail.proof_lifecycle?.upload_status)],
    ['Upload Mode', formatValue(renderedProofDetail.proof_lifecycle?.upload_mode)],
    ['Upload Network', formatValue(renderedProofDetail.proof_lifecycle?.upload_network)],
    ['Uploaded At', formatTime(renderedProofDetail.proof_lifecycle?.uploaded_at)],
    ['Uploader Pubkey', formatValue(renderedProofDetail.proof_lifecycle?.uploader_pubkey)],
    ['Mint Ready', formatValue(renderedProofDetail.proof_lifecycle?.mint_ready)],
    ['Mint Status', formatValue(renderedProofDetail.proof_lifecycle?.mint_status)],
    ['Mint Network', formatValue(renderedProofDetail.proof_lifecycle?.mint_network)],
    ['Proof Wallet Pubkey', formatValue(renderedProofDetail.proof_lifecycle?.proof_wallet_pubkey)],
    ['Mint Authority Pubkey', formatValue(renderedProofDetail.proof_lifecycle?.mint_authority_pubkey)],
    ['Mint Address', formatValue(renderedProofDetail.proof_lifecycle?.mint_address)],
    ['Token Account', formatValue(renderedProofDetail.proof_lifecycle?.token_account)],
    ['Transaction Signature', formatValue(renderedProofDetail.proof_lifecycle?.transaction_signature)],
    ['Minted At', formatTime(renderedProofDetail.proof_lifecycle?.minted_at)],
  ];

  const artifactRows = [
    ['Image Artifact Path', formatValue(renderedProofDetail.artifacts?.image_artifact_path)],
    ['Image Artifact Hash', formatValue(renderedProofDetail.artifacts?.image_artifact_hash)],
    ['Metadata Name', formatValue(renderedProofDetail.artifacts?.metadata_name)],
    ['Metadata Template Path', formatValue(renderedProofDetail.artifacts?.metadata_template_path)],
    ['Resolved Metadata Path', formatValue(renderedProofDetail.artifacts?.resolved_metadata_path)],
    ['Final Metadata Path', formatValue(renderedProofDetail.artifacts?.final_metadata_path)],
    ['Final Image URI', formatValue(renderedProofDetail.artifacts?.final_image_uri)],
    ['Final Metadata URI', formatValue(renderedProofDetail.artifacts?.final_metadata_uri)],
    ['Metadata URI', formatValue(renderedProofDetail.artifacts?.metadata_uri)],
    ['Image URI', formatValue(renderedProofDetail.artifacts?.image_uri)],
    ['External URL', formatValue(renderedProofDetail.artifacts?.external_url)],
  ];

  const limitationRows = [
    ['Limitations', formatValue(renderedProofDetail.flags_and_limitations?.limitations)],
    ['Raw Quote Disclosure', formatValue(renderedProofDetail.flags_and_limitations?.raw_quote_only_disclosure)],
  ];

  const summaryCards = hosted
    ? [
        {
          className: 'verification-status',
          label: 'Verification Status',
          value: formatValue(renderedProofDetail.receipt?.verification_status),
        },
        {
          className: 'hash-check',
          label: 'Hash Valid',
          value: formatValue(renderedProofDetail.verification?.hash_valid),
        },
        {
          className: 'verifier-check',
          label: 'Verifier Passed',
          value: formatValue(renderedProofDetail.verification?.verifier_passed),
        },
        {
          className: 'lifecycle',
          label: 'Proof Lifecycle',
          value: `${formatValue(renderedProofDetail.proof_lifecycle?.upload_status)} / ${formatValue(renderedProofDetail.proof_lifecycle?.mint_status)}`,
        },
      ]
    : [
        {
          className: 'verification-status',
          label: 'Verification Status',
          value: formatValue(renderedProofDetail.receipt?.verification_status),
        },
        {
          className: 'hash-check',
          label: 'Hash Valid / Verifier Passed',
          value: `${formatValue(renderedProofDetail.verification?.hash_valid)} / ${formatValue(renderedProofDetail.verification?.verifier_passed)}`,
        },
        {
          className: 'lifecycle',
          label: 'Proof Lifecycle',
          value: `${formatValue(renderedProofDetail.proof_lifecycle?.upload_status)} / ${formatValue(renderedProofDetail.proof_lifecycle?.mint_status)}`,
        },
      ];

  const headerLede = hosted
    ? 'Hosted proof page.'
    : 'Selected receipt only. This static proof page is a local export scaffold, not hosted proof delivery.';

  const disclosureNotice = hosted
    ? `
      <div class="notice">
        <p>Hosted proof page.</p>
        <p>Unlisted does not mean private. Anyone with the link can view.</p>
        <p>Selected receipt only. Not a portfolio statement.</p>
        <p>Raw quote only. No USD normalization.</p>
        <p>Wallet may be truncated or redacted by publisher.</p>
        <p>Wallet display mode: ${escapeHtml(formatValue(hosted.walletDisplayMode))}.</p>
      </div>`
    : '';

  const footerNotes = hosted
    ? `
      <p>Hosted proof page.</p>
      <p>Unlisted does not mean private. Anyone with the link can view.</p>
      <p>Selected receipt only. Not a portfolio statement.</p>
      <p>Raw quote only. No USD normalization.</p>
      <p>Wallet may be truncated or redacted by publisher.</p>`
    : `
      <p>Raw quote only. No USD normalization.</p>
      <p>Selected receipt only. This page does not represent a portfolio-wide statement.</p>
      <p>Local export scaffold only. No hosting, upload, minting, or signing is performed by this artifact.</p>`;

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
    .summary-card.verifier-check { border-left: 6px solid #245b8f; }
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
      <p class="lede">${escapeHtml(headerLede)}</p>
      <p class="lede">Generated at ${escapeHtml(generatedAt)}</p>
      ${disclosureNotice}
      ${renderSummaryCards(summaryCards)}
    </header>

    ${renderSection('Receipt', `<dl class="grid">${renderDefinitionRows(receiptRows)}</dl>`)}
    ${renderSection('Verification', `<dl class="grid">${renderDefinitionRows(verificationRows)}</dl>${renderList('Verifier Rule Violations', renderedProofDetail.verification?.verifier_rule_violations)}`)}
    ${renderSection('Valuation', `<div class="notice"><p>${escapeHtml(formatValue(renderedProofDetail.valuation?.disclosure_text))}</p></div><dl class="grid">${renderDefinitionRows(valuationRows)}</dl>${renderList('Valuation Violations', renderedProofDetail.valuation?.valuation_context?.violations)}`)}
    ${renderSection('Proof Lifecycle', `<dl class="grid">${renderDefinitionRows(lifecycleRows)}</dl>${renderList('Mint Blockers', renderedProofDetail.proof_lifecycle?.mint_blockers)}${renderList('Mint Required Steps', renderedProofDetail.proof_lifecycle?.mint_required_steps)}`)}
    ${renderSection('Artifacts', `<dl class="grid">${renderDefinitionRows(artifactRows)}</dl>`)}
    ${renderSection('Flags & Limitations', `<dl class="grid">${renderDefinitionRows(limitationRows)}</dl>${renderList('Flags', renderedProofDetail.flags_and_limitations?.flags)}${renderList('Disclosures', renderedProofDetail.flags_and_limitations?.disclosures)}`)}
    ${renderSection('Links', `<dl class="grid">${renderLinks(renderedProofDetail.links || {})}</dl>`)}

    <footer class="footer-notes">
      ${footerNotes}
    </footer>
  </main>
</body>
</html>`;
}

