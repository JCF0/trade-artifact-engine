export const SHARE_CARD_NUMBER_FORMAT_VERSION = 'artifact_number_v1';
export const SHARE_CARD_DATE_FORMAT_VERSION = 'artifact_utc_date_v1';

export class ShareCardFormatError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ShareCardFormatError';
    this.code = code;
    this.details = details;
  }
}

const MACHINE_ROOT_PATTERN = /^(root|home|users|tmp|var|etc|proc|dev|sys|usr|opt|run|mnt|private|srv|boot|lib|lib64|bin|sbin|media|volumes|applications|library|system)(\/|$)/i;

function fail(code, message, details = {}) {
  throw new ShareCardFormatError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyDisplay(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function assertExactKeys(value, expectedKeys, context) {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    fail('invalid_share_card_model', `${context} must be a plain string-keyed object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalid_share_card_model', `${context} has unexpected or missing fields`, {
      actual_keys: actual,
      expected_keys: expected,
    });
  }
}

function hasUnsafeRelativeTraversal(pathname) {
  const segments = pathname.split('/');
  let index = 0;
  while (index < segments.length && ['', '.', '..'].includes(segments[index])) index += 1;
  return segments.slice(index).includes('..');
}

function decodeSafePath(pathname) {
  let decoded = pathname;
  for (let depth = 0; depth < 5; depth += 1) {
    if (/%(?:2e|2f|5c)/i.test(decoded)) return null;
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded.includes('%') ? null : decoded;
}

function isMachinePath(value, decodedPath) {
  const segments = decodedPath.split('/');
  let targetIndex = 0;
  while (targetIndex < segments.length
    && (segments[targetIndex] === '' || segments[targetIndex] === '.' || segments[targetIndex] === '..')) {
    targetIndex += 1;
  }
  const relativeTarget = segments.slice(targetIndex).join('/');
  const rootedOrTraversed = targetIndex > 0;
  return /^[A-Za-z]:[\\/]/.test(value)
    || /^[A-Za-z]:\//.test(decodedPath)
    || /^\/[A-Za-z]:\//.test(decodedPath)
    || value.startsWith('\\\\')
    || (rootedOrTraversed && MACHINE_ROOT_PATTERN.test(relativeTarget))
    || (rootedOrTraversed && /^[A-Za-z]:\//.test(relativeTarget));
}

function assertSafeModelLink(value, field) {
  const rawPath = typeof value === 'string' ? value.split(/[?#]/, 1)[0] : '';
  const decodedPath = decodeSafePath(rawPath);
  if (!isNonEmptyDisplay(value)
    || /[\u0000-\u001f\u007f\\]/.test(value)
    || /\s/.test(value)
    || decodedPath === null
    || hasUnsafeRelativeTraversal(rawPath)
    || value.startsWith('#')
    || value.startsWith('?')
    || value.startsWith('//')) {
    fail('invalid_share_card_model', `${field} is not a safe Share Card destination`);
  }

  if (/^https:/i.test(value)) {
    if (!/^https:\/\//i.test(value)) {
      fail('invalid_share_card_model', `${field} must use an absolute HTTPS URL`);
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail('invalid_share_card_model', `${field} must be a valid HTTPS destination`);
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      fail('invalid_share_card_model', `${field} must be credential-free HTTPS`);
    }
    return;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decodedPath)
    || !rawPath
    || isMachinePath(value, decodedPath)) {
    fail('invalid_share_card_model', `${field} is not a safe relative destination`);
  }
}

function assertFiniteNumber(value, field, { nonnegative = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonnegative && value < 0)) {
    fail('invalid_numeric_value', `${field} must be a finite${nonnegative ? ' non-negative' : ''} number`, { field });
  }
}

function assertTimestamp(value, field) {
  if (!Number.isSafeInteger(value)) {
    fail('invalid_timestamp', `${field} must be a safe integer Unix timestamp`, { field });
  }
  const date = new Date(value * 1000);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) {
    fail('invalid_timestamp', `${field} is outside the artifact UTC date range`, { field });
  }
  return date;
}

function assertDuration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid_duration', 'hold_time_seconds must be a non-negative safe integer');
  }
}

function stableClone(value, path = 'shareCardViewModel') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    assertFiniteNumber(value, path);
    return value;
  }
  if (Array.isArray(value)) return value.map((child, index) => stableClone(child, `${path}[${index}]`));
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
    fail('invalid_share_card_model', `${path} contains an unsupported value`);
  }
  const clone = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid_share_card_model', `${path}.${key} must be a data property`);
    }
    Object.defineProperty(clone, key, {
      value: stableClone(descriptor.value, `${path}.${key}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return clone;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function numberToPlainParts(value) {
  const source = Math.abs(Object.is(value, -0) ? 0 : value).toString().toLowerCase();
  const [coefficient, exponentText] = source.split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const point = coefficient.indexOf('.');
  const digits = coefficient.replace('.', '');
  const decimalPosition = (point === -1 ? coefficient.length : point) + exponent;

  if (decimalPosition <= 0) {
    return { integer: '0', fraction: `${'0'.repeat(-decimalPosition)}${digits}` };
  }
  if (decimalPosition >= digits.length) {
    return { integer: `${digits}${'0'.repeat(decimalPosition - digits.length)}`, fraction: '' };
  }
  return {
    integer: digits.slice(0, decimalPosition),
    fraction: digits.slice(decimalPosition),
  };
}

function roundUnsigned(value, precision) {
  const { integer, fraction } = numberToPlainParts(value);
  const paddedFraction = fraction.padEnd(precision + 1, '0');
  const retained = paddedFraction.slice(0, precision);
  const roundUp = paddedFraction[precision] >= '5';
  let scaled = BigInt(`${integer}${retained}` || '0');
  if (roundUp) scaled += 1n;

  let digits = scaled.toString();
  if (precision === 0) return { integer: digits, fraction: '' };
  digits = digits.padStart(precision + 1, '0');
  return {
    integer: digits.slice(0, -precision),
    fraction: digits.slice(-precision),
  };
}

function groupInteger(integer) {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatFixedUnsigned(value, precision) {
  const rounded = roundUnsigned(value, precision);
  return `${groupInteger(rounded.integer)}.${rounded.fraction}`;
}

function formatVariableUnsigned(value, precision) {
  const rounded = roundUnsigned(value, precision);
  const fraction = rounded.fraction.replace(/0+$/, '');
  return `${groupInteger(rounded.integer)}${fraction ? `.${fraction}` : ''}`;
}

function isDisplayedZero(value) {
  return !/[1-9]/.test(value);
}

function pnlSign(value) {
  if (value > 0) return '+';
  if (value < 0) return '-';
  return '';
}

function pnlDirection(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'flat';
}

function formatSignedFixed(value, precision) {
  return `${pnlSign(value)}${formatFixedUnsigned(value, precision)}`;
}

function formatPrice(value) {
  const absolute = Math.abs(value);
  let precision = absolute < 1 ? 6 : absolute < 1000 ? 4 : 2;
  let formatted = formatVariableUnsigned(value, precision);
  while (value !== 0 && isDisplayedZero(formatted) && precision < 12) {
    precision += 1;
    formatted = formatVariableUnsigned(value, precision);
  }
  if (value !== 0 && isDisplayedZero(formatted)) {
    fail('invalid_numeric_value', 'nonzero price cannot be represented within twelve decimal places');
  }
  return formatted;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatUtcDate(date) {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  return `${year}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const afterDays = seconds % 86400;
  const hours = Math.floor(afterDays / 3600);
  const afterHours = afterDays % 3600;
  const minutes = Math.floor(afterHours / 60);
  const remainingSeconds = afterHours % 60;

  if (days > 0) return `${days}d ${pad2(hours)}h ${pad2(minutes)}m ${pad2(remainingSeconds)}s`;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(remainingSeconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad2(remainingSeconds)}s`;
  return `${remainingSeconds}s`;
}

function assertShareCardShape(model) {
  assertExactKeys(model, [
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
  ], 'shareCardViewModel');
  assertExactKeys(model.identity, [
    'receipt_hash',
    'receipt_hash_short',
    'receipt_id',
    'base_asset',
    'quote_asset',
    'pair_display',
  ], 'identity');
  assertExactKeys(model.status, ['position', 'verification', 'verification_label'], 'status');
  assertExactKeys(model.hero, ['realized_pnl_quote', 'realized_pnl_pct'], 'hero');
  assertExactKeys(model.hero.realized_pnl_quote, ['value', 'quote_symbol', 'direction'], 'hero.realized_pnl_quote');
  assertExactKeys(model.hero.realized_pnl_pct, ['value', 'direction'], 'hero.realized_pnl_pct');
  assertExactKeys(model.trade_summary, [
    'avg_entry_quote_price',
    'avg_exit_quote_price',
    'opened_at',
    'closed_at',
    'hold_time_seconds',
  ], 'trade_summary');
  assertExactKeys(model.accounting_summary, [
    'quantity_closed',
    'entry_cost_quote',
    'exit_proceeds_quote',
    'accounting_method',
    'num_buys',
    'num_sells',
  ], 'accounting_summary');
  assertExactKeys(model.proof, [
    'receipt_id',
    'receipt_hash',
    'receipt_hash_short',
    'quote_scope',
    'receipt_scope',
  ], 'proof');
  assertExactKeys(model.links, ['proof_href', 'verifier_href'], 'links');

  const baseAsset = model.identity.base_asset;
  if (!isPlainObject(baseAsset)) {
    fail('invalid_asset_display', 'identity.base_asset must be an object');
  }
  if (baseAsset.display_kind === 'symbol') {
    assertExactKeys(baseAsset, [
      'mint',
      'display',
      'display_kind',
      'symbol',
      ...(Object.hasOwn(baseAsset, 'name') ? ['name'] : []),
    ], 'identity.base_asset');
  } else if (baseAsset.display_kind === 'mint_prefix') {
    assertExactKeys(baseAsset, ['mint', 'display', 'display_kind'], 'identity.base_asset');
  } else {
    fail('invalid_asset_display', 'identity.base_asset has an unsupported display kind');
  }
  assertExactKeys(model.identity.quote_asset, ['mint', 'symbol'], 'identity.quote_asset');

  const receiptHash = model.identity.receipt_hash;
  const expectedHashShort = typeof receiptHash === 'string'
    ? `${receiptHash.slice(0, 12)}...${receiptHash.slice(-12)}`
    : '';
  if (!/^[a-f0-9]{64}$/.test(receiptHash || '')
    || model.identity.receipt_hash_short !== expectedHashShort
    || !isNonEmptyDisplay(model.identity.receipt_id)
    || model.proof.receipt_hash !== receiptHash
    || model.proof.receipt_hash_short !== expectedHashShort
    || model.proof.receipt_id !== model.identity.receipt_id
    || model.proof.quote_scope !== 'raw_quote'
    || model.proof.receipt_scope !== 'receipt_only'
    || model.status.position !== 'closed'
    || model.status.verification !== 'verified'
    || model.status.verification_label !== 'Verified by Artifact'
    || !isNonEmptyDisplay(model.accounting_summary.accounting_method)
    || !Number.isSafeInteger(model.accounting_summary.num_buys)
    || model.accounting_summary.num_buys < 0
    || !Number.isSafeInteger(model.accounting_summary.num_sells)
    || model.accounting_summary.num_sells < 0
    || !Array.isArray(model.badges)
    || model.badges.length !== 4
    || Object.getOwnPropertySymbols(model.badges).length > 0
    || Object.keys(model.badges).some((key, index) => key !== String(index))
    || model.badges.some((badge, index) => badge !== [
      'Closed Position',
      'Verified',
      'Raw Quote',
      'Receipt Scoped',
    ][index])
    || model.disclosure !== 'Receipt-scoped only. Raw quote only. Not wallet or portfolio performance.'
    || !isNonEmptyDisplay(model.links.proof_href)
    || !isNonEmptyDisplay(model.links.verifier_href)) {
    fail('invalid_share_card_model', 'Share Card v1 identity, status, proof, or disclosure fields are inconsistent');
  }
}

function readFormattingInputs(model) {
  if (!isPlainObject(model) || model.share_card_version !== 'share_card_v1') {
    fail('invalid_share_card_model', 'formatter requires share_card_version share_card_v1');
  }
  assertShareCardShape(model);
  assertSafeModelLink(model.links.proof_href, 'proof_href');
  assertSafeModelLink(model.links.verifier_href, 'verifier_href');

  const baseAsset = model.identity?.base_asset;
  const quoteAsset = model.identity?.quote_asset;
  if (!isPlainObject(baseAsset)
    || !isNonEmptyDisplay(baseAsset.mint)
    || !isNonEmptyDisplay(baseAsset.display)
    || !['symbol', 'mint_prefix'].includes(baseAsset.display_kind)
    || (baseAsset.display_kind === 'symbol'
      && (!isNonEmptyDisplay(baseAsset.symbol) || baseAsset.symbol !== baseAsset.display))
    || (baseAsset.display_kind === 'symbol'
      && baseAsset.name !== undefined && !isNonEmptyDisplay(baseAsset.name))
    || (baseAsset.display_kind === 'mint_prefix'
      && (Object.hasOwn(baseAsset, 'symbol') || Object.hasOwn(baseAsset, 'name')))
    || !isPlainObject(quoteAsset)
    || !isNonEmptyDisplay(quoteAsset.mint)
    || !isNonEmptyDisplay(quoteAsset.symbol)) {
    fail('invalid_asset_display', 'base and quote assets require valid typed display values');
  }

  const quoteSymbol = quoteAsset.symbol;
  const expectedPair = `${baseAsset.display}/${quoteSymbol}`;
  if (model.identity.pair_display !== expectedPair
    || model.hero?.realized_pnl_quote?.quote_symbol !== quoteSymbol
    || !isNonEmptyDisplay(model.identity.receipt_hash_short)) {
    fail('invalid_asset_display', 'Share Card asset display values are inconsistent');
  }

  const values = {
    realizedPnlQuote: model.hero?.realized_pnl_quote?.value,
    realizedPnlPct: model.hero?.realized_pnl_pct?.value,
    avgEntryQuotePrice: model.trade_summary?.avg_entry_quote_price,
    avgExitQuotePrice: model.trade_summary?.avg_exit_quote_price,
    quantityClosed: model.accounting_summary?.quantity_closed,
    entryCostQuote: model.accounting_summary?.entry_cost_quote,
    exitProceedsQuote: model.accounting_summary?.exit_proceeds_quote,
  };
  for (const [field, value] of Object.entries(values)) {
    const canBeSigned = field === 'realizedPnlQuote' || field === 'realizedPnlPct';
    assertFiniteNumber(value, field, { nonnegative: !canBeSigned });
  }
  if (model.hero.realized_pnl_quote.direction !== pnlDirection(values.realizedPnlQuote)
    || model.hero.realized_pnl_pct.direction !== pnlDirection(values.realizedPnlPct)) {
    fail('invalid_share_card_model', 'Share Card PnL directions are inconsistent with canonical values');
  }

  const openedAt = assertTimestamp(model.trade_summary?.opened_at, 'opened_at');
  const closedAt = assertTimestamp(model.trade_summary?.closed_at, 'closed_at');
  assertDuration(model.trade_summary?.hold_time_seconds);

  return {
    ...values,
    baseDisplay: baseAsset.display,
    quoteSymbol,
    pair: expectedPair,
    receiptHashShort: model.identity.receipt_hash_short,
    openedAt,
    closedAt,
    durationSeconds: model.trade_summary.hold_time_seconds,
  };
}

export function formatShareCardViewModel(shareCardViewModel, options = {}) {
  if (!isPlainObject(options) || Object.getOwnPropertySymbols(options).length > 0) {
    fail('invalid_share_card_model', 'formatting options must be a plain string-keyed object');
  }
  const optionKeys = Object.keys(options);
  if (optionKeys.some(key => !['number_format_version', 'date_format_version'].includes(key))) {
    fail('invalid_share_card_model', 'formatting options contain unsupported fields');
  }
  const numberFormatVersion = options.number_format_version ?? SHARE_CARD_NUMBER_FORMAT_VERSION;
  const dateFormatVersion = options.date_format_version ?? SHARE_CARD_DATE_FORMAT_VERSION;
  if (numberFormatVersion !== SHARE_CARD_NUMBER_FORMAT_VERSION) {
    fail('unsupported_number_format_version', `unsupported number format version: ${numberFormatVersion}`);
  }
  if (dateFormatVersion !== SHARE_CARD_DATE_FORMAT_VERSION) {
    fail('unsupported_date_format_version', `unsupported date format version: ${dateFormatVersion}`);
  }

  const inputs = readFormattingInputs(shareCardViewModel);
  const clone = stableClone(shareCardViewModel);
  return deepFreeze({
    ...clone,
    display: {
      pair: inputs.pair,
      realized_pnl_quote: `${formatSignedFixed(inputs.realizedPnlQuote, 2)} ${inputs.quoteSymbol}`,
      realized_pnl_pct: `${formatSignedFixed(inputs.realizedPnlPct, 2)}%`,
      avg_entry_quote_price: `${formatPrice(inputs.avgEntryQuotePrice)} ${inputs.quoteSymbol}`,
      avg_exit_quote_price: `${formatPrice(inputs.avgExitQuotePrice)} ${inputs.quoteSymbol}`,
      quantity_closed: `${formatVariableUnsigned(inputs.quantityClosed, 6)} ${inputs.baseDisplay}`,
      entry_cost_quote: `${formatFixedUnsigned(inputs.entryCostQuote, 2)} ${inputs.quoteSymbol}`,
      exit_proceeds_quote: `${formatFixedUnsigned(inputs.exitProceedsQuote, 2)} ${inputs.quoteSymbol}`,
      opened_at: formatUtcDate(inputs.openedAt),
      closed_at: formatUtcDate(inputs.closedAt),
      duration: formatDuration(inputs.durationSeconds),
      receipt_hash_short: inputs.receiptHashShort,
    },
    formatting: {
      number_format_version: numberFormatVersion,
      date_format_version: dateFormatVersion,
    },
  });
}
