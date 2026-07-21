export const PUBLIC_DEMO_ASSET_BASE = 'assets/';
export const PUBLIC_DEMO_PROOF_ASSET_BASE = '../../assets/';

export function renderPublicDemoStyles() {
  return `
    :root {
      color-scheme: light;
      --page: #f6f8fb;
      --surface: #ffffff;
      --surface-muted: #f1f5f9;
      --navy: #071527;
      --navy-2: #0b2442;
      --blue: #1b7cff;
      --blue-soft: #e8f1ff;
      --border: #d8e1ee;
      --text: #111827;
      --muted: #5b6678;
      --verified: #16803c;
      --verified-soft: #e8f7ee;
      --warning: #9a6700;
      --warning-soft: #fff7df;
      --shadow: 0 14px 40px rgba(7, 21, 39, 0.08);
      --font-ui: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--page); color: var(--text); font-family: var(--font-ui); }
    a { color: var(--blue); overflow-wrap: anywhere; }
    .page-shell { width: min(1120px, 100%); margin: 0 auto; padding: 24px 20px 56px; }
    .brand-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 28px; }
    .brand-lockup { display: inline-flex; align-items: center; gap: 12px; min-width: 0; color: var(--navy); text-decoration: none; }
    .brand-logo { width: 38px; height: 38px; object-fit: contain; flex: 0 0 auto; }
    .brand-wordmark { font-weight: 800; font-size: 20px; letter-spacing: 0; }
    .primary-nav { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .nav-link, .button-link { min-height: 40px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-radius: 999px; border: 1px solid var(--border); padding: 9px 14px; background: var(--surface); color: var(--navy); text-decoration: none; font-weight: 700; font-size: 14px; }
    .button-link.primary { background: var(--blue); border-color: var(--blue); color: #ffffff; box-shadow: 0 10px 22px rgba(27, 124, 255, 0.22); }
    .button-link.secondary { background: var(--surface); color: var(--navy); }
    .hero-panel, .content-panel, .proof-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); }
    .hero-panel { padding: 30px; margin-bottom: 18px; border-top: 4px solid var(--blue); }
    .eyebrow { margin: 0 0 10px; color: var(--blue); font-size: 12px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
    h1 { margin: 0; color: var(--navy); font-size: clamp(34px, 5vw, 56px); line-height: 1; letter-spacing: 0; }
    h2 { margin: 0 0 14px; color: var(--navy); font-size: 20px; line-height: 1.2; letter-spacing: 0; }
    h3 { margin: 0 0 10px; color: var(--navy-2); font-size: 14px; line-height: 1.25; letter-spacing: 0; }
    p { margin: 0 0 10px; line-height: 1.55; }
    .lead { margin-top: 16px; color: var(--navy-2); font-size: 20px; line-height: 1.45; max-width: 760px; }
    .explain, .subtitle, .muted-copy { color: var(--muted); max-width: 820px; }
    .supporting-line { color: var(--muted); font-weight: 700; }
    .badge-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid var(--border); padding: 6px 10px; background: var(--surface-muted); color: var(--navy-2); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge.verified { background: var(--verified-soft); border-color: rgba(22, 128, 60, 0.25); color: var(--verified); }
    .badge.blue { background: var(--blue-soft); border-color: rgba(27, 124, 255, 0.25); color: var(--blue); }
    .badge.warning { background: var(--warning-soft); border-color: rgba(154, 103, 0, 0.22); color: var(--warning); }
    .scope-panel, .notice { border: 1px solid var(--border); border-radius: 12px; background: var(--surface-muted); padding: 16px; color: var(--muted); }
    .scope-panel { margin-top: 18px; }
    .scope-panel h2, .scope-panel h3 { margin-bottom: 10px; }
    .scope-panel ul, .disclosures { margin: 0; padding-left: 20px; }
    .scope-panel li, .disclosures li { margin: 6px 0; line-height: 1.45; }
    .proof-grid, .field-grid, dl.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin: 0; }
    .field, .metric, .summary-card { border: 1px solid var(--border); border-radius: 10px; padding: 13px; background: var(--surface); min-width: 0; }
    dt, .label, .summary-card strong, .hash-label { display: block; margin: 0 0 6px; color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
    dd, .technical, .hash-value { margin: 0; color: var(--navy); font-family: var(--font-mono); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }
    .rows { display: grid; gap: 16px; margin-top: 18px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    section { scroll-margin-top: 18px; }
    @media (max-width: 720px) {
      .page-shell { padding: 18px 14px 40px; }
      .brand-header { align-items: flex-start; flex-direction: column; margin-bottom: 20px; }
      .primary-nav { justify-content: flex-start; width: 100%; }
      .hero-panel { padding: 22px 18px; }
      h1 { font-size: 34px; }
      .lead { font-size: 18px; }
      .button-link, .nav-link { width: 100%; }
      .proof-grid, .field-grid, dl.grid { grid-template-columns: 1fr; }
    }
    @media print {
      body { background: #ffffff; }
      .brand-header, .hero-panel, .content-panel, .proof-card, section, footer { box-shadow: none; break-inside: avoid; }
    }`;
}

export function renderBrandHeader({ assetBasePath = '', current = 'board', backHref = null } = {}) {
  const logo = assetBasePath ? `${assetBasePath}artifact-logo-header.png` : null;
  const brand = logo
    ? `<a class="brand-lockup" href="${backHref || './index.html'}"><img class="brand-logo" src="${logo}" alt="Artifact"><span class="brand-wordmark">Artifact</span></a>`
    : `<a class="brand-lockup" href="${backHref || './index.html'}"><span class="brand-wordmark">Artifact</span></a>`;
  const nav = current === 'proof' && backHref
    ? `<a class="nav-link" href="${backHref}">Back to Receipt Board</a>`
    : `<a class="nav-link" href="${backHref || './index.html'}">Receipt Board</a>`;
  return `<header class="brand-header">${brand}<nav class="primary-nav" aria-label="Primary navigation">${nav}</nav></header>`;
}

export function renderFaviconLink(assetBasePath = '') {
  return assetBasePath ? `<link rel="icon" type="image/png" href="${assetBasePath}favicon.png">` : '';
}