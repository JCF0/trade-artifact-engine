function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLinks(links) {
  return [
    ['Proof', links.proof_api_path],
    ['Verifier', links.verifier_api_path],
    ['Card JSON', links.card_api_path],
    ['Card Preview', links.card_preview_path],
    ['Hosted Preview', links.hosted_preview_path],
  ].map(([label, href]) => `<a href="${escapeHtml(href || '')}">${escapeHtml(label)}</a>`).join('');
}

export function renderProofGalleryHtml(galleryView) {
  if (!galleryView || typeof galleryView !== 'object') {
    throw new TypeError('galleryView is required');
  }

  const items = Array.isArray(galleryView.items) ? galleryView.items : [];
  const disclosures = Array.isArray(galleryView.disclosures) ? galleryView.disclosures : [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(galleryView.title || 'Artifact Sample Gallery')}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #efe7d8;
      --panel: #fffaf4;
      --border: #d6c7b0;
      --ink: #1f1b16;
      --muted: #6b5c4b;
      --accent: #8a5f32;
      --soft: #f3e7d7;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, #f7f0e5 0%, var(--bg) 100%); color: var(--ink); font-family: Georgia, 'Times New Roman', serif; }
    main { max-width: 1100px; margin: 0 auto; padding: 28px 18px 40px; }
    header { margin-bottom: 22px; }
    h1 { margin: 0 0 10px; font-size: 34px; }
    .subtitle { color: var(--muted); margin: 0 0 14px; }
    .disclosures { color: var(--muted); padding-left: 20px; margin: 0; }
    .empty { background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 28px; font-size: 18px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    article { background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 18px; box-shadow: 0 16px 36px rgba(32, 24, 15, 0.08); }
    .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 10px; }
    .hash { font-size: 20px; font-weight: 700; margin-bottom: 14px; }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; margin: 0 0 16px; }
    dt { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    dd { margin: 4px 0 0; font-size: 14px; overflow-wrap: anywhere; }
    .field { background: var(--soft); border: 1px solid var(--border); border-radius: 12px; padding: 12px; }
    nav { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
    nav a { color: var(--accent); text-decoration: none; font-weight: 700; border: 1px solid var(--border); background: #fff; border-radius: 999px; padding: 8px 12px; }
    nav a:hover { text-decoration: underline; }
    @media (max-width: 640px) { dl { grid-template-columns: 1fr; } h1 { font-size: 28px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(galleryView.title || 'Artifact Sample Gallery')}</h1>
      <p class="subtitle">${escapeHtml(galleryView.subtitle || 'Selected sample receipts only. Not a portfolio statement.')}</p>
      <ul class="disclosures">${disclosures.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    </header>
    ${items.length === 0 ? `<section class="empty">No sample receipts are currently available.</section>` : `<section class="grid">${items.map(item => `
      <article>
        <div class="eyebrow">${escapeHtml(item.token_display || 'Not available')}</div>
        <div class="hash">${escapeHtml(item.receipt_hash_short || 'Not available')}</div>
        <dl>
          <div class="field"><dt>Receipt ID</dt><dd>${escapeHtml(item.receipt_id || 'Not available')}</dd></div>
          <div class="field"><dt>Receipt Type</dt><dd>${escapeHtml(item.receipt_type || 'Not available')}</dd></div>
          <div class="field"><dt>Display Status</dt><dd>${escapeHtml(item.display_status || 'Not available')}</dd></div>
          <div class="field"><dt>Verification Status</dt><dd>${escapeHtml(item.verification_status || 'Not available')}</dd></div>
          <div class="field"><dt>Valuation Status</dt><dd>${escapeHtml(item.valuation_status || 'Not available')}</dd></div>
          <div class="field"><dt>Trust Level</dt><dd>${escapeHtml(item.trust?.current_label || 'Not available')}</dd></div>
        </dl>
        <nav>${renderLinks(item.links || {})}</nav>
      </article>`).join('')}</section>`}
  </main>
</body>
</html>`;
}