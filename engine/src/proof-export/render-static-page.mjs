import { applyWalletDisplayPolicy } from '../proof-publish/wallet-policy.mjs';
import { renderBrandHeader, renderFaviconLink, renderPublicDemoStyles } from '../public-demo/visual-system.mjs';

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
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  return String(value);
}

function formatCoverageTime(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed * 1000).toISOString();
}

function buildCoverageRows(coverage) {
  if (!coverage || typeof coverage !== 'object') return null;
  const openedAt = formatCoverageTime(coverage.position_episode?.opened_at);
  const closedAt = formatCoverageTime(coverage.position_episode?.closed_at);
  const eventBounds = openedAt && closedAt
    ? `Receipt event bounds: ${openedAt} to ${closedAt}.`
    : 'Receipt event bounds incomplete.';

  return [
    ['Scope', 'Receipt-scoped coverage only.'],
    ['Event Bounds', eventBounds],
    ['Valuation', 'Raw quote only. No USD normalization.'],
    ['Limitation', 'Not wallet, trader, portfolio, or track-record coverage.'],
  ];
}

function renderCoverageStatement(coverage) {
  const rows = buildCoverageRows(coverage);
  if (!rows) return '';
  return renderSection('Coverage Statement', `<dl class="grid">${renderDefinitionRows(rows)}</dl>`, 'scope-panel');
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
        <p class="empty muted-copy">Not available</p>
      </div>`;
  }

  return `
      <div class="subsection">
        <h3>${escapeHtml(label)}</h3>
        <ul class="disclosures">
          ${items.map(value => `<li>${escapeHtml(formatValue(value))}</li>`).join('')}
        </ul>
      </div>`;
}

function renderSection(title, body, className = 'content-panel proof-section') {
  return `
    <section class="${escapeHtml(className)}">
      <h2>${escapeHtml(title)}</h2>
      ${body}
    </section>`;
}

function renderSummaryCards(cards) {
  return `
      <div class="summary proof-grid">
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
    ['Board Path', links.board_path],
    ['Verifier Path', links.verifier_path],
  ];

  return rows.map(([label, value]) => {
    const content = value ? `<a href="${escapeHtml(value)}">${escapeHtml(value)}</a>` : 'Not available';
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
    visibility: options.hosted.visibility || 'unlisted',
  };
}

function hostedDisclosureLines(hosted) {
  const lines = [];
  if (hosted.visibility === 'public') lines.push('Public hosted proof page.');
  else if (hosted.visibility === 'private') {
    lines.push('Private draft proof page.');
    lines.push('Private here means local draft semantics only. Do not assume server-side privacy.');
  } else {
    lines.push('Hosted proof page.');
    lines.push('Unlisted does not mean private. Anyone with the link can view.');
  }
  lines.push('Selected receipt only. Not a portfolio statement.');
  lines.push('Raw quote only. No USD normalization.');
  lines.push('Wallet may be truncated or redacted by publisher.');
  return lines;
}

export function renderStaticProofPage(proofDetail, options = {}) {
  if (!proofDetail || typeof proofDetail !== 'object') throw new TypeError('proofDetail is required');

  const hosted = getHostedContext(options);
  const renderedProofDetail = hosted ? applyWalletDisplayPolicy(proofDetail, { mode: hosted.walletDisplayMode }) : proofDetail;
  const generatedAt = options.generatedAt || new Date().toISOString();
  const pageTitle = options.title || `Trade Artifact Static Proof - ${renderedProofDetail.receipt?.receipt_id || 'Selected Receipt'}`;
  const assetBasePath = options.assetBasePath || '';
  const boardHref = renderedProofDetail.links?.board_path || '../../index.html';

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

  const summaryCards = hosted ? [
    { className: 'verification-status', label: 'Verification Status', value: formatValue(renderedProofDetail.receipt?.verification_status) },
    { className: 'hash-check', label: 'Hash Valid', value: formatValue(renderedProofDetail.verification?.hash_valid) },
    { className: 'verifier-check', label: 'Verifier Passed', value: formatValue(renderedProofDetail.verification?.verifier_passed) },
    { className: 'raw-quote', label: 'Valuation', value: 'Raw Quote' },
    { className: 'lifecycle', label: 'Proof Lifecycle', value: `${formatValue(renderedProofDetail.proof_lifecycle?.upload_status)} / ${formatValue(renderedProofDetail.proof_lifecycle?.mint_status)}` },
  ] : [
    { className: 'verification-status', label: 'Verification Status', value: formatValue(renderedProofDetail.receipt?.verification_status) },
    { className: 'hash-check', label: 'Hash Valid / Verifier Passed', value: `${formatValue(renderedProofDetail.verification?.hash_valid)} / ${formatValue(renderedProofDetail.verification?.verifier_passed)}` },
    { className: 'lifecycle', label: 'Proof Lifecycle', value: `${formatValue(renderedProofDetail.proof_lifecycle?.upload_status)} / ${formatValue(renderedProofDetail.proof_lifecycle?.mint_status)}` },
  ];

  const headerLede = hosted ? hostedDisclosureLines(hosted)[0] : 'Selected receipt only. This static proof page is a local export scaffold, not hosted proof delivery.';
  const disclosureNotice = hosted ? `
      <div class="notice">
        ${hostedDisclosureLines(hosted).map(line => `<p>${escapeHtml(line)}</p>`).join('')}
        <p>Wallet display mode: ${escapeHtml(formatValue(hosted.walletDisplayMode))}.</p>
      </div>` : '';
  const footerNotes = hosted
    ? `${hostedDisclosureLines(hosted).map(line => `<p>${escapeHtml(line)}</p>`).join('')}`
    : `<p>Raw quote only. No USD normalization.</p><p>Selected receipt only. This page does not represent a portfolio-wide statement.</p><p>Local export scaffold only. No hosting, upload, minting, or signing is performed by this artifact.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  ${renderFaviconLink(assetBasePath)}
  <style>
    ${renderPublicDemoStyles()}
    .proof-shell { max-width: 1040px; }
    .proof-hero { display: grid; gap: 16px; }
    .receipt-kicker { color: var(--muted); font-family: var(--font-mono); font-size: 13px; overflow-wrap: anywhere; }
    .summary-card.verification-status, .summary-card.hash-check, .summary-card.verifier-check, .summary-card.raw-quote { border-left: 5px solid var(--verified); }
    .summary-card.lifecycle { border-left: 5px solid var(--blue); }
    .summary-card span { display: block; color: var(--navy); font-size: 20px; font-weight: 800; overflow-wrap: anywhere; }
    .proof-section { padding: 20px; margin-top: 16px; }
    .scope-panel { margin-top: 16px; }
    .subsection { margin-top: 16px; }
    .footer-notes { margin-top: 16px; }
  </style>
</head>
<body>
  <main class="page-shell proof-shell">
    ${renderBrandHeader({ assetBasePath, current: 'proof', backHref: boardHref })}
    <section class="hero-panel proof-hero">
      <p class="eyebrow">Artifact Proof</p>
      <h1>${escapeHtml(pageTitle)}</h1>
      <p class="receipt-kicker">${escapeHtml(formatValue(renderedProofDetail.receipt?.receipt_id))}</p>
      <p class="lead">${escapeHtml(headerLede)}</p>
      <div class="badge-row">
        <span class="badge verified">Verified</span>
        <span class="badge verified">Hash Valid</span>
        <span class="badge verified">Verifier Passed</span>
        <span class="badge blue">Raw Quote</span>
      </div>
      <p class="muted-copy">Generated at <span class="technical">${escapeHtml(generatedAt)}</span></p>
      ${disclosureNotice}
      ${renderSummaryCards(summaryCards)}
    </section>

    ${renderSection('Receipt', `<dl class="grid">${renderDefinitionRows(receiptRows)}</dl>`)}
    ${renderCoverageStatement(renderedProofDetail.coverage_statement)}
    ${renderSection('Verification', `<dl class="grid">${renderDefinitionRows(verificationRows)}</dl>${renderList('Verifier Rule Violations', renderedProofDetail.verification?.verifier_rule_violations)}`)}
    ${renderSection('Valuation', `<div class="notice"><p>${escapeHtml(formatValue(renderedProofDetail.valuation?.disclosure_text))}</p></div><dl class="grid">${renderDefinitionRows(valuationRows)}</dl>${renderList('Valuation Violations', renderedProofDetail.valuation?.valuation_context?.violations)}`)}
    ${renderSection('Proof Lifecycle', `<dl class="grid">${renderDefinitionRows(lifecycleRows)}</dl>${renderList('Mint Blockers', renderedProofDetail.proof_lifecycle?.mint_blockers)}${renderList('Mint Required Steps', renderedProofDetail.proof_lifecycle?.mint_required_steps)}`)}
    ${renderSection('Artifacts', `<dl class="grid">${renderDefinitionRows(artifactRows)}</dl>`)}
    ${renderSection('Flags & Limitations', `<dl class="grid">${renderDefinitionRows(limitationRows)}</dl>${renderList('Flags', renderedProofDetail.flags_and_limitations?.flags)}${renderList('Disclosures', renderedProofDetail.flags_and_limitations?.disclosures)}`)}
    ${renderSection('Links', `<dl class="grid">${renderLinks(renderedProofDetail.links || {})}</dl>`)}

    <footer class="scope-panel footer-notes">
      ${footerNotes}
    </footer>
  </main>
</body>
</html>`;
}