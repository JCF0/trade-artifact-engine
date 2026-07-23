export class ShareCardHtmlError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ShareCardHtmlError';
    this.code = code;
    this.details = details;
  }
}

const ROOT_KEYS = Object.freeze([
  'share_card_version',
  'identity',
  'status',
  'hero',
  'trade_summary',
  'accounting_summary',
  'proof',
  'badges',
  'disclosure',
  'links',
  'display',
  'formatting',
]);
const DISPLAY_KEYS = Object.freeze([
  'pair',
  'realized_pnl_quote',
  'realized_pnl_pct',
  'avg_entry_quote_price',
  'avg_exit_quote_price',
  'quantity_closed',
  'entry_cost_quote',
  'exit_proceeds_quote',
  'opened_at',
  'closed_at',
  'duration',
  'receipt_hash_short',
]);
const EXPECTED_BADGES = Object.freeze([
  'Closed Position',
  'Verified',
  'Raw Quote',
  'Receipt Scoped',
]);
const DISCLOSURE = 'Receipt-scoped only. Raw quote only. Not wallet or portfolio performance.';
const RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MACHINE_ROOT_PATTERN = /^(root|home|users|tmp|var|etc|proc|dev|sys|usr|opt|run|mnt|private|srv|boot|lib|lib64|bin|sbin|media|volumes|applications|library|system)(\/|$)/i;
const DIRECTIONS = Object.freeze(['positive', 'negative', 'flat']);

function fail(code, message, details = {}) {
  throw new ShareCardHtmlError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDataProperties(value, context, code = 'invalid_formatted_share_card') {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(code, `${context} must contain only string-keyed data properties`);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(code, `${context}.${key} must be a data property`);
    }
  }
}

function assertExactKeys(value, expectedKeys, context) {
  if (!isPlainObject(value)) {
    fail('invalid_formatted_share_card', `${context} must be a plain object`);
  }
  assertDataProperties(value, context);
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalid_formatted_share_card', `${context} has unexpected or missing fields`, {
      actual_keys: actual,
      expected_keys: expected,
    });
  }
}

function assertArray(value, expected, context) {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length > 0) {
    fail('invalid_formatted_share_card', `${context} is invalid`);
  }
  assertDataProperties(value, context);
  if (Object.getOwnPropertyNames(value)
      .filter(key => key !== 'length')
      .some((key, index) => key !== String(index))
    || value.length !== expected.length
    || value.some((item, index) => item !== expected[index])) {
    fail('invalid_formatted_share_card', `${context} is invalid`);
  }
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertText(value, field, code = 'invalid_formatted_share_card') {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(code, `${field} must be a non-empty trimmed string`, { field });
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || hasUnpairedSurrogate(value)) {
    fail('unsafe_html_value', `${field} cannot be represented safely in HTML`, { field });
  }
}

function assertDisplayText(value, field) {
  assertText(value, field, 'invalid_display_value');
}

function assertFiniteNumber(value, field, { nonnegative = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonnegative && value < 0)) {
    fail('invalid_formatted_share_card', `${field} must be a finite${nonnegative ? ' non-negative' : ''} number`, { field });
  }
}

function assertSafeInteger(value, field, { nonnegative = false } = {}) {
  if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) {
    fail('invalid_formatted_share_card', `${field} must be a safe${nonnegative ? ' non-negative' : ''} integer`, { field });
  }
}

function decodeBounded(value, { rejectEncodedStructure = false } = {}) {
  let decoded = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (rejectEncodedStructure && /%(?:2e|2f|5c)/i.test(decoded)) return null;
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  try {
    return decodeURIComponent(decoded) === decoded ? decoded : null;
  } catch {
    return null;
  }
}

function hasMachineReferenceInSuffix(value) {
  const suffixIndex = value.search(/[?#]/);
  if (suffixIndex === -1) return false;
  const suffix = value.slice(suffixIndex).replace(/\\/g, '/');
  return /(?:^|[?&#=])(?:file:\/\/|(?:\.\.\/|\/)+(?:root|home|users|tmp|var|etc|proc|dev|sys|usr|opt|run|mnt|private|srv|boot|lib|lib64|bin|sbin|media|volumes|applications|library|system)(?:\/|$)|\/?[A-Za-z]:\/)/i.test(suffix);
}

function pathSegmentsHaveTraversal(pathname, { allowLeading = false } = {}) {
  const segments = pathname.split('/');
  if (!allowLeading) return segments.includes('..');
  let index = 0;
  while (index < segments.length && ['', '.', '..'].includes(segments[index])) index += 1;
  return segments.slice(index).includes('..');
}

function isMachinePath(rawValue, decodedPath) {
  const normalized = decodedPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  let index = 0;
  while (index < segments.length && ['', '.', '..'].includes(segments[index])) index += 1;
  const relativeTarget = segments.slice(index).join('/');
  const rootedOrTraversed = index > 0;
  return /^[A-Za-z]:[\\/]/.test(rawValue)
    || /^[A-Za-z]:\//.test(normalized)
    || /^\/[A-Za-z]:\//.test(normalized)
    || rawValue.startsWith('\\\\')
    || (rootedOrTraversed && MACHINE_ROOT_PATTERN.test(relativeTarget))
    || (rootedOrTraversed && /^[A-Za-z]:\//.test(relativeTarget));
}

function assertSafeModelLink(value, field) {
  assertText(value, field, 'invalid_link');
  if (typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || /[\u0000-\u001f\u007f\\\s]/.test(value)
    || value.startsWith('#')
    || value.startsWith('?')
    || value.startsWith('//')) {
    fail('invalid_link', `${field} must be an explicit safe destination`, { field });
  }
  const rawPath = value.split(/[?#]/, 1)[0];
  const decodedPath = decodeBounded(rawPath, { rejectEncodedStructure: true });
  const decodedValue = decodeBounded(value);
  if (!rawPath || decodedPath === null
    || decodedValue === null
    || /%(?:2e|2f|5c)/i.test(rawPath)
    || pathSegmentsHaveTraversal(rawPath, { allowLeading: true })
    || pathSegmentsHaveTraversal(decodedPath, { allowLeading: true })
    || hasMachineReferenceInSuffix(decodedValue)) {
    fail('invalid_link', `${field} contains unsafe path structure`, { field });
  }
  if (/^https:/i.test(value)) {
    if (!/^https:\/\//i.test(value)) fail('invalid_link', `${field} must be an absolute HTTPS URL`, { field });
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail('invalid_link', `${field} must be a valid HTTPS URL`, { field });
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      fail('invalid_link', `${field} must be credential-free HTTPS`, { field });
    }
    return;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decodedPath)
    || isMachinePath(value, decodedPath)) {
    fail('invalid_link', `${field} must be a safe relative destination`, { field });
  }
}

function assertSafeLogoLink(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || /[\u0000-\u001f\u007f\\]/.test(value)
    || value.startsWith('#')
    || value.startsWith('?')
    || value.startsWith('//')) {
    fail('invalid_logo_link', 'logo_href must be an explicit safe local path');
  }
  const rawPath = value.split(/[?#]/, 1)[0];
  const decodedPath = decodeBounded(rawPath);
  const decodedValue = decodeBounded(value);
  if (!rawPath || decodedPath === null
    || decodedValue === null
    || pathSegmentsHaveTraversal(rawPath)
    || pathSegmentsHaveTraversal(decodedPath)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decodedPath)
    || isMachinePath(value, decodedPath)
    || hasMachineReferenceInSuffix(decodedValue)) {
    fail('invalid_logo_link', 'logo_href must be a traversal-free local relative or root-relative path');
  }
  assertText(value, 'logo_href', 'invalid_logo_link');
}

function validateFormattedModel(model) {
  if (!isPlainObject(model)) {
    fail('invalid_formatted_share_card', 'formatted Share Card must be a plain object');
  }
  assertExactKeys(model, ROOT_KEYS, 'formattedShareCardViewModel');
  if (model.share_card_version !== 'share_card_v1') {
    fail('unsupported_share_card_version', 'renderer requires share_card_version share_card_v1');
  }
  assertExactKeys(model.formatting, ['number_format_version', 'date_format_version'], 'formatting');
  if (model.formatting.number_format_version !== 'artifact_number_v1'
    || model.formatting.date_format_version !== 'artifact_utc_date_v1') {
    fail('unsupported_formatting_profile', 'renderer requires Artifact v1 number and UTC date profiles');
  }

  assertExactKeys(model.identity, [
    'receipt_hash', 'receipt_hash_short', 'receipt_id', 'base_asset', 'quote_asset', 'pair_display',
  ], 'identity');
  assertExactKeys(model.status, ['position', 'verification', 'verification_label'], 'status');
  assertExactKeys(model.hero, ['realized_pnl_quote', 'realized_pnl_pct'], 'hero');
  assertExactKeys(model.hero.realized_pnl_quote, ['value', 'quote_symbol', 'direction'], 'hero.realized_pnl_quote');
  assertExactKeys(model.hero.realized_pnl_pct, ['value', 'direction'], 'hero.realized_pnl_pct');
  assertExactKeys(model.trade_summary, [
    'avg_entry_quote_price', 'avg_exit_quote_price', 'opened_at', 'closed_at', 'hold_time_seconds',
  ], 'trade_summary');
  assertExactKeys(model.accounting_summary, [
    'quantity_closed', 'entry_cost_quote', 'exit_proceeds_quote', 'accounting_method', 'num_buys', 'num_sells',
  ], 'accounting_summary');
  assertExactKeys(model.proof, [
    'receipt_id', 'receipt_hash', 'receipt_hash_short', 'quote_scope', 'receipt_scope',
  ], 'proof');
  assertExactKeys(model.links, ['proof_href', 'verifier_href'], 'links');
  assertExactKeys(model.display, DISPLAY_KEYS, 'display');

  const baseAsset = model.identity.base_asset;
  if (!isPlainObject(baseAsset)) fail('invalid_formatted_share_card', 'identity.base_asset must be a plain object');
  assertDataProperties(baseAsset, 'identity.base_asset');
  if (baseAsset.display_kind === 'symbol') {
    assertExactKeys(baseAsset, [
      'mint', 'display', 'display_kind', 'symbol', ...(Object.hasOwn(baseAsset, 'name') ? ['name'] : []),
    ], 'identity.base_asset');
  } else if (baseAsset.display_kind === 'mint_prefix') {
    assertExactKeys(baseAsset, ['mint', 'display', 'display_kind'], 'identity.base_asset');
  } else {
    fail('invalid_formatted_share_card', 'identity.base_asset has an unsupported display kind');
  }
  assertExactKeys(model.identity.quote_asset, ['mint', 'symbol'], 'identity.quote_asset');

  for (const [field, value] of Object.entries({
    'identity.receipt_id': model.identity.receipt_id,
    'identity.base_asset.mint': baseAsset.mint,
    'identity.base_asset.display': baseAsset.display,
    'identity.quote_asset.mint': model.identity.quote_asset.mint,
    'identity.quote_asset.symbol': model.identity.quote_asset.symbol,
    'identity.pair_display': model.identity.pair_display,
    'accounting_summary.accounting_method': model.accounting_summary.accounting_method,
  })) assertText(value, field);
  if (baseAsset.display_kind === 'symbol') {
    assertText(baseAsset.symbol, 'identity.base_asset.symbol');
    if (baseAsset.name !== undefined) assertText(baseAsset.name, 'identity.base_asset.name');
  }

  const receiptHash = model.identity.receipt_hash;
  const expectedHashShort = typeof receiptHash === 'string'
    ? `${receiptHash.slice(0, 12)}...${receiptHash.slice(-12)}`
    : '';
  if (!RECEIPT_HASH_PATTERN.test(receiptHash || '')
    || model.identity.receipt_hash_short !== expectedHashShort
    || model.proof.receipt_id !== model.identity.receipt_id
    || model.proof.receipt_hash !== receiptHash
    || model.proof.receipt_hash_short !== expectedHashShort
    || model.proof.quote_scope !== 'raw_quote'
    || model.proof.receipt_scope !== 'receipt_only'
    || model.status.position !== 'closed'
    || model.status.verification !== 'verified'
    || model.status.verification_label !== 'Verified by Artifact'
    || model.disclosure !== DISCLOSURE
    || model.identity.pair_display !== `${baseAsset.display}/${model.identity.quote_asset.symbol}`
    || (baseAsset.display_kind === 'symbol' && baseAsset.symbol !== baseAsset.display)
    || model.hero.realized_pnl_quote.quote_symbol !== model.identity.quote_asset.symbol
    || model.display.pair !== model.identity.pair_display
    || model.display.receipt_hash_short !== expectedHashShort) {
    fail('invalid_formatted_share_card', 'formatted Share Card identity, status, proof, or display bindings are inconsistent');
  }

  assertArray(model.badges, EXPECTED_BADGES, 'badges');
  for (const [field, value] of Object.entries(model.display)) assertDisplayText(value, `display.${field}`);
  assertText(model.identity.receipt_id, 'identity.receipt_id');
  assertText(model.proof.receipt_hash_short, 'proof.receipt_hash_short');
  assertText(model.disclosure, 'disclosure');

  for (const [field, value] of Object.entries({
    'hero.realized_pnl_quote.value': model.hero.realized_pnl_quote.value,
    'hero.realized_pnl_pct.value': model.hero.realized_pnl_pct.value,
  })) assertFiniteNumber(value, field);
  for (const [field, value] of Object.entries({
    'trade_summary.avg_entry_quote_price': model.trade_summary.avg_entry_quote_price,
    'trade_summary.avg_exit_quote_price': model.trade_summary.avg_exit_quote_price,
    'accounting_summary.quantity_closed': model.accounting_summary.quantity_closed,
    'accounting_summary.entry_cost_quote': model.accounting_summary.entry_cost_quote,
    'accounting_summary.exit_proceeds_quote': model.accounting_summary.exit_proceeds_quote,
  })) assertFiniteNumber(value, field, { nonnegative: true });
  assertSafeInteger(model.trade_summary.opened_at, 'trade_summary.opened_at');
  assertSafeInteger(model.trade_summary.closed_at, 'trade_summary.closed_at');
  if (model.trade_summary.opened_at < -62167219200 || model.trade_summary.opened_at > 253402300799
    || model.trade_summary.closed_at < -62167219200 || model.trade_summary.closed_at > 253402300799) {
    fail('invalid_formatted_share_card', 'trade summary timestamps must be within four-digit UTC years');
  }
  assertSafeInteger(model.trade_summary.hold_time_seconds, 'trade_summary.hold_time_seconds', { nonnegative: true });
  assertSafeInteger(model.accounting_summary.num_buys, 'accounting_summary.num_buys', { nonnegative: true });
  assertSafeInteger(model.accounting_summary.num_sells, 'accounting_summary.num_sells', { nonnegative: true });

  const quoteDirection = model.hero.realized_pnl_quote.direction;
  const percentDirection = model.hero.realized_pnl_pct.direction;
  if (!DIRECTIONS.includes(quoteDirection)
    || !DIRECTIONS.includes(percentDirection)
    || quoteDirection !== (model.hero.realized_pnl_quote.value > 0 ? 'positive' : model.hero.realized_pnl_quote.value < 0 ? 'negative' : 'flat')
    || percentDirection !== (model.hero.realized_pnl_pct.value > 0 ? 'positive' : model.hero.realized_pnl_pct.value < 0 ? 'negative' : 'flat')) {
    fail('invalid_formatted_share_card', 'formatted Share Card directions are inconsistent with retained canonical values');
  }

  assertSafeModelLink(model.links.proof_href, 'proof_href');
  assertSafeModelLink(model.links.verifier_href, 'verifier_href');
  return { quoteDirection, percentDirection };
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderLink(href, text, ariaLabel, className) {
  const rel = /^https:\/\//i.test(href) ? ' rel="noopener noreferrer"' : '';
  return `<a class="${className}" href="${escapeHtml(href)}"${rel} aria-label="${escapeHtml(ariaLabel)}">${escapeHtml(text)}</a>`;
}

function statistic(label, value) {
  return `        <div class="stat"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

export function renderShareCardHtml(formattedShareCardViewModel, options = {}) {
  if (!isPlainObject(options)) {
    fail('invalid_formatted_share_card', 'renderer options must be a plain object');
  }
  assertDataProperties(options, 'renderer options');
  const optionKeys = Object.getOwnPropertyNames(options);
  if (optionKeys.length > 1 || optionKeys.some(key => key !== 'logo_href')) {
    fail('invalid_formatted_share_card', 'renderer options contain unsupported fields');
  }
  assertSafeLogoLink(options.logo_href);
  const { quoteDirection, percentDirection } = validateFormattedModel(formattedShareCardViewModel);
  const model = formattedShareCardViewModel;
  const display = model.display;
  const receiptId = model.identity.receipt_id;
  const proofLink = renderLink(
    model.links.proof_href,
    'View Proof',
    `View proof for receipt ${receiptId}`,
    'proof-link proof-link--primary',
  );
  const verifierLink = renderLink(
    model.links.verifier_href,
    'Verify Receipt',
    `Verify receipt ${receiptId}`,
    'proof-link proof-link--secondary',
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Artifact Verified Receipt — ${escapeHtml(display.pair)}</title>
  <style>
    :root {
      color-scheme: light;
      --navy: #071527;
      --navy-2: #0b2442;
      --blue: #1b7cff;
      --blue-soft: #e8f1ff;
      --surface: #ffffff;
      --muted-surface: #f1f5f9;
      --border: #d8e1ee;
      --text: #111827;
      --muted-text: #5b6678;
      --verified: #16803c;
      --verified-soft: #e8f7ee;
      --negative: #b42318;
      --negative-soft: #feeceb;
      --flat: #475467;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--muted-surface); }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      color: var(--text);
      overflow: hidden;
    }
    .share-card {
      width: 1200px;
      height: 630px;
      aspect-ratio: 1200 / 630;
      overflow: hidden;
      background: var(--surface);
      border: 1px solid var(--border);
      display: grid;
      grid-template-rows: 112px 1fr 150px;
      transform-origin: top left;
    }
    .card-header {
      background: var(--navy);
      color: var(--surface);
      padding: 24px 42px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 28px;
      border-bottom: 6px solid var(--blue);
    }
    .brand-block, .header-badges, .proof-actions { display: flex; align-items: center; }
    .brand-block { gap: 18px; min-width: 0; }
    .artifact-logo { width: 54px; height: 54px; object-fit: contain; flex: 0 0 auto; }
    .product-name { margin: 0 0 3px; font-size: 20px; font-weight: 750; letter-spacing: .02em; }
    h1 { margin: 0; font-size: 31px; line-height: 1.05; letter-spacing: -.025em; }
    .header-badges { justify-content: flex-end; gap: 12px; flex-wrap: wrap; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      border-radius: 999px;
      padding: 7px 13px;
      font-size: 14px;
      line-height: 1;
      font-weight: 750;
      white-space: nowrap;
      border: 1px solid rgba(255,255,255,.35);
    }
    .closed-badge { color: var(--surface); background: var(--navy-2); }
    .verification-badge { color: var(--verified); background: var(--verified-soft); border-color: #a7dfb9; }
    .verification-badge::before { content: "✓"; margin-right: 7px; font-weight: 900; }
    .card-body {
      padding: 26px 42px 22px;
      display: grid;
      grid-template-columns: 420px 1fr;
      gap: 34px;
      min-height: 0;
    }
    .hero-panel {
      background: var(--navy-2);
      color: var(--surface);
      border-radius: 18px;
      padding: 28px 30px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      border-left: 8px solid var(--flat);
    }
    .hero--positive .hero-panel { border-left-color: var(--verified); }
    .hero--negative .hero-panel { border-left-color: var(--negative); }
    .hero--flat .hero-panel { border-left-color: var(--flat); }
    .scope-badge { align-self: flex-start; color: var(--navy-2); background: var(--blue-soft); border-color: #b8d4ff; }
    .hero-label { margin: 18px 0 8px; color: #cbd8e8; font-size: 16px; font-weight: 700; }
    .hero-value { margin: 0; font-size: 44px; line-height: 1.03; font-weight: 820; letter-spacing: -.035em; }
    .hero-percent { margin: 10px 0 0; font-size: 28px; line-height: 1; font-weight: 760; }
    .hero--positive .hero-value, .hero-percent.pnl--positive { color: #65d28a; }
    .hero--negative .hero-value, .hero-percent.pnl--negative { color: #ff8d86; }
    .hero--flat .hero-value, .hero-percent.pnl--flat { color: #d0d5dd; }
    .stats-panel { display: grid; grid-template-rows: auto auto; gap: 18px; align-content: center; }
    .stats-section h2 {
      margin: 0 0 10px;
      color: var(--navy-2);
      font-size: 15px;
      line-height: 1;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .stats-grid { margin: 0; display: grid; gap: 10px; }
    .stats-grid--primary { grid-template-columns: repeat(5, minmax(0, 1fr)); }
    .stats-grid--secondary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .stat { min-width: 0; padding: 13px 14px; background: var(--muted-surface); border: 1px solid var(--border); border-radius: 12px; }
    .stat dt { margin: 0 0 7px; color: var(--muted-text); font-size: 12px; line-height: 1.15; font-weight: 700; }
    .stat dd { margin: 0; color: var(--text); font-size: 15px; line-height: 1.2; font-weight: 760; overflow-wrap: anywhere; }
    .proof-footer {
      background: var(--blue-soft);
      border-top: 1px solid var(--border);
      padding: 18px 42px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: center;
    }
    .proof-grid { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(250px, 1fr); gap: 8px 24px; }
    .proof-item { min-width: 0; }
    .proof-label { display: block; color: var(--muted-text); font-size: 11px; font-weight: 750; text-transform: uppercase; letter-spacing: .07em; }
    .proof-value {
      display: block;
      margin-top: 3px;
      color: var(--navy-2);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.25;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .proof-disclosure { grid-column: 1 / -1; margin: 2px 0 0; color: var(--muted-text); font-size: 12px; font-weight: 650; }
    .receipt-badge { margin-left: 8px; color: var(--navy-2); background: var(--surface); border-color: #a9c8f5; vertical-align: middle; }
    .proof-actions { gap: 10px; }
    .proof-link {
      display: inline-flex;
      min-height: 42px;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      padding: 10px 15px;
      font-size: 14px;
      font-weight: 780;
      text-decoration: none;
      white-space: nowrap;
      border: 2px solid var(--blue);
    }
    .proof-link:focus-visible { outline: 3px solid var(--text); outline-offset: 3px; }
    .proof-link--primary { color: var(--surface); background: var(--blue); }
    .proof-link--secondary { color: var(--navy-2); background: var(--surface); }
    @media (min-width: 801px) and (max-width: 1199px) {
      .share-card { transform: scale(calc(100vw / 1200px)); }
    }
    @media (max-width: 800px) {
      html, body { width: 100%; }
      body { overflow-x: hidden; overflow-y: auto; }
      .share-card {
        width: 100%;
        height: auto;
        aspect-ratio: auto;
        overflow: visible;
        display: block;
        transform: none;
      }
      .card-header {
        padding: 22px 20px;
        align-items: flex-start;
        flex-direction: column;
        gap: 16px;
      }
      .header-badges { justify-content: flex-start; }
      .card-body {
        padding: 22px 18px;
        grid-template-columns: 1fr;
        gap: 20px;
      }
      .hero-panel { min-height: 240px; padding: 28px 24px; }
      .hero-value { font-size: 42px; }
      .hero-percent { font-size: 28px; }
      .stats-panel { gap: 20px; }
      .stats-grid--primary, .stats-grid--secondary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .proof-footer {
        padding: 22px 18px 26px;
        grid-template-columns: 1fr;
        gap: 20px;
      }
      .proof-grid { grid-template-columns: 1fr; gap: 14px; }
      .proof-disclosure { grid-column: 1; line-height: 1.45; }
      .proof-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .proof-link { min-height: 48px; white-space: normal; text-align: center; }
    }
    @media (max-width: 430px) {
      .artifact-logo { width: 48px; height: 48px; }
      h1 { font-size: 28px; }
      .header-badges { gap: 8px; }
      .badge { font-size: 13px; }
      .hero-value { font-size: 38px; }
      .stat { padding: 12px; }
      .stat dd { font-size: 14px; }
      .proof-actions { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="share-card hero--${quoteDirection}" data-share-card-version="share_card_v1" aria-labelledby="share-card-title">
    <header class="card-header">
      <div class="brand-block">
        <img class="artifact-logo" src="${escapeHtml(options.logo_href)}" alt="Artifact logo" width="54" height="54">
        <div>
          <p class="product-name">Artifact</p>
          <h1 id="share-card-title">${escapeHtml(display.pair)}</h1>
        </div>
      </div>
      <div class="header-badges" aria-label="Position and verification status">
        <span class="badge closed-badge">Closed Position</span>
        <span class="badge verification-badge">Verified by Artifact</span>
      </div>
    </header>
    <div class="card-body">
      <section class="hero-panel" aria-labelledby="realized-pnl-heading">
        <span class="badge scope-badge">Raw Quote</span>
        <h2 class="hero-label" id="realized-pnl-heading">Realized PnL</h2>
        <p class="hero-value">${escapeHtml(display.realized_pnl_quote)}</p>
        <p class="hero-percent pnl--${percentDirection}" aria-label="Realized PnL percentage">${escapeHtml(display.realized_pnl_pct)}</p>
      </section>
      <div class="stats-panel">
        <section class="stats-section" aria-labelledby="primary-statistics-heading">
          <h2 id="primary-statistics-heading">Position Details</h2>
          <dl class="stats-grid stats-grid--primary">
${statistic('Average Entry', display.avg_entry_quote_price)}
${statistic('Average Exit', display.avg_exit_quote_price)}
${statistic('Opened', display.opened_at)}
${statistic('Closed', display.closed_at)}
${statistic('Duration', display.duration)}
          </dl>
        </section>
        <section class="stats-section" aria-labelledby="secondary-statistics-heading">
          <h2 id="secondary-statistics-heading">Receipt Totals</h2>
          <dl class="stats-grid stats-grid--secondary">
${statistic('Quantity Closed', display.quantity_closed)}
${statistic('Entry Cost', display.entry_cost_quote)}
${statistic('Exit Proceeds', display.exit_proceeds_quote)}
          </dl>
        </section>
      </div>
    </div>
    <footer class="proof-footer" aria-label="Receipt proof">
      <div class="proof-grid">
        <div class="proof-item">
          <span class="proof-label">Receipt ID <span class="badge receipt-badge">Receipt Scoped</span></span>
          <span class="proof-value">${escapeHtml(receiptId)}</span>
        </div>
        <div class="proof-item">
          <span class="proof-label">Receipt Hash</span>
          <span class="proof-value">${escapeHtml(display.receipt_hash_short)}</span>
        </div>
        <p class="proof-disclosure">${DISCLOSURE}</p>
      </div>
      <nav class="proof-actions" aria-label="Receipt proof actions">
        ${proofLink}
        ${verifierLink}
      </nav>
    </footer>
  </main>
</body>
</html>
`;
}
