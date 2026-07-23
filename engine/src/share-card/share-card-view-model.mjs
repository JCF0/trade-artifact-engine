export const SHARE_CARD_VERSION = 'share_card_v1';
export const SHARE_CARD_BADGES = Object.freeze([
  'Closed Position',
  'Verified',
  'Raw Quote',
  'Receipt Scoped',
]);
export const SHARE_CARD_DISCLOSURE = 'Receipt-scoped only. Raw quote only. Not wallet or portfolio performance.';

export class ShareCardEligibilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ShareCardEligibilityError';
    this.code = code;
    this.details = details;
  }
}

const RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MACHINE_ROOT_PATTERN = /^(root|home|users|tmp|var|etc|proc|dev|sys|usr|opt|run|mnt|private|srv|boot|lib|lib64|bin|sbin|media|volumes|applications|library|system)(\/|$)/i;
const REQUIRED_ECONOMICS_NUMBERS = Object.freeze([
  'total_sold_qty',
  'total_sold_quote',
  'avg_buy_quote_price',
  'avg_sell_quote_price',
  'allocated_cost_basis_quote',
  'realized_pnl_quote',
  'realized_pnl_pct',
  'hold_time_seconds',
  'num_buys',
  'num_sells',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message, details = {}) {
  throw new ShareCardEligibilityError(code, message, details);
}

function assertExactKeys(value, expectedKeys, code, context) {
  if (!isPlainObject(value)) fail(code, `${context} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${context} has unexpected or missing fields`, {
      actual_keys: actual,
      expected_keys: expected,
    });
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function assertReceiptFields(receipt) {
  if (!RECEIPT_HASH_PATTERN.test(receipt.receipt_hash || '')
    || !isNonEmptyString(receipt.receipt_id)
    || !isNonEmptyString(receipt.token_mint)) {
    fail('invalid_receipt_identity', 'receipt hash, id, and full token mint are required');
  }
  if (!isNonEmptyString(receipt.quote_mint) || !isNonEmptyString(receipt.quote_symbol)) {
    fail('invalid_quote_asset', 'canonical quote mint and symbol are required');
  }
  if (!Number.isFinite(receipt.first_event_at) || !Number.isFinite(receipt.last_event_at)) {
    fail('invalid_event_bounds', 'finite receipt event bounds are required');
  }
}

function assertCanonicalEconomics(fields) {
  if (!isPlainObject(fields)) {
    fail('invalid_canonical_economics', 'canonical economics fields are required');
  }
  for (const field of REQUIRED_ECONOMICS_NUMBERS) {
    if (!Number.isFinite(fields[field])) {
      fail('invalid_canonical_economics', `canonical economics field ${field} must be a finite number`, { field });
    }
  }
  if (fields.hold_time_seconds < 0
    || !Number.isInteger(fields.num_buys) || fields.num_buys < 0
    || !Number.isInteger(fields.num_sells) || fields.num_sells < 0
    || !isNonEmptyString(fields.accounting_method)) {
    fail('invalid_canonical_economics', 'canonical accounting fields are invalid');
  }
}

function assertTokenDisplayMetadata(metadata, tokenMint) {
  if (!isPlainObject(metadata) || metadata.mint !== tokenMint) {
    fail('token_metadata_mismatch', 'token display metadata mint must exactly match the receipt token mint');
  }
  if (!isNonEmptyString(metadata.display)
    || !['symbol', 'mint_prefix'].includes(metadata.display_kind)) {
    fail('invalid_token_metadata', 'token display metadata must provide a typed non-empty display');
  }
  if (metadata.display_kind === 'symbol'
    && (!isNonEmptyString(metadata.symbol) || metadata.symbol !== metadata.display)) {
    fail('invalid_token_metadata', 'symbol display metadata must expose its exact symbol as display');
  }
  if (metadata.display_kind === 'symbol'
    && metadata.name !== undefined && !isNonEmptyString(metadata.name)) {
    fail('invalid_token_metadata', 'token display name must be a non-empty string when present');
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

function assertSafeLink(value, code, field) {
  const rawPath = typeof value === 'string' ? value.split(/[?#]/, 1)[0] : '';
  const decodedPath = decodeSafePath(rawPath);
  if (!isNonEmptyString(value)
    || /[\u0000-\u001f\u007f\\]/.test(value)
    || /\s/.test(value)
    || decodedPath === null
    || hasUnsafeRelativeTraversal(rawPath)
    || value.startsWith('#')
    || value.startsWith('?')
    || value.startsWith('//')) {
    fail(code, `${field} must be an explicit safe relative or HTTPS destination`);
  }

  if (/^https:/i.test(value)) {
    if (!/^https:\/\//i.test(value)) {
      fail(code, `${field} must use an absolute HTTPS URL`);
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail(code, `${field} must be a valid HTTPS destination`);
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      fail(code, `${field} must be credential-free HTTPS`);
    }
    return;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decodedPath)) {
    fail(code, `${field} uses a forbidden URL scheme`);
  }
  if (!rawPath || isMachinePath(value, decodedPath)) {
    fail(code, `${field} must identify a relative destination without embedded traversal`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function direction(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'flat';
}

function shortenReceiptHash(value) {
  return `${value.slice(0, 12)}...${value.slice(-12)}`;
}

export function buildShareCardViewModel(inventoryReceipt, options = {}) {
  assertExactKeys(options, ['tokenDisplayMetadata', 'links'], 'invalid_options', 'Share Card options');
  const { tokenDisplayMetadata, links } = options;
  assertExactKeys(links, ['proof_href', 'verifier_href'], 'invalid_options', 'Share Card links');

  if (inventoryReceipt?.receipt_type !== 'closed_position') {
    throw new ShareCardEligibilityError('receipt_type_not_eligible', 'Share Card v1 requires a closed-position receipt');
  }
  if (inventoryReceipt.verification_status !== 'verified'
    || inventoryReceipt.display_status !== 'Verified Closed Position') {
    throw new ShareCardEligibilityError('receipt_not_verified', 'Share Card v1 requires verified display status');
  }
  if (inventoryReceipt.canonical_economics?.status !== 'verified'
    || inventoryReceipt.canonical_economics?.source !== 'receipt_economics_v1') {
    throw new ShareCardEligibilityError('canonical_economics_not_verified', 'Share Card v1 requires verified canonical receipt economics');
  }

  assertReceiptFields(inventoryReceipt);
  assertTokenDisplayMetadata(tokenDisplayMetadata, inventoryReceipt.token_mint);
  assertSafeLink(links.proof_href, 'invalid_proof_link', 'proof_href');
  assertSafeLink(links.verifier_href, 'invalid_verifier_link', 'verifier_href');

  const fields = inventoryReceipt.canonical_economics.fields;
  assertCanonicalEconomics(fields);
  const receiptHashShort = shortenReceiptHash(inventoryReceipt.receipt_hash);
  const baseAsset = {
    mint: inventoryReceipt.token_mint,
    display: tokenDisplayMetadata.display,
    display_kind: tokenDisplayMetadata.display_kind,
    ...(tokenDisplayMetadata.display_kind === 'symbol' ? {
      symbol: tokenDisplayMetadata.symbol,
      ...(tokenDisplayMetadata.name === undefined ? {} : { name: tokenDisplayMetadata.name }),
    } : {}),
  };

  return deepFreeze({
    share_card_version: SHARE_CARD_VERSION,
    identity: {
      receipt_hash: inventoryReceipt.receipt_hash,
      receipt_hash_short: receiptHashShort,
      receipt_id: inventoryReceipt.receipt_id,
      base_asset: baseAsset,
      quote_asset: {
        mint: inventoryReceipt.quote_mint,
        symbol: inventoryReceipt.quote_symbol,
      },
      pair_display: `${tokenDisplayMetadata.display}/${inventoryReceipt.quote_symbol}`,
    },
    status: {
      position: 'closed',
      verification: 'verified',
      verification_label: 'Verified by Artifact',
    },
    hero: {
      realized_pnl_quote: {
        value: fields.realized_pnl_quote,
        quote_symbol: inventoryReceipt.quote_symbol,
        direction: direction(fields.realized_pnl_quote),
      },
      realized_pnl_pct: {
        value: fields.realized_pnl_pct,
        direction: direction(fields.realized_pnl_pct),
      },
    },
    trade_summary: {
      avg_entry_quote_price: fields.avg_buy_quote_price,
      avg_exit_quote_price: fields.avg_sell_quote_price,
      opened_at: inventoryReceipt.first_event_at,
      closed_at: inventoryReceipt.last_event_at,
      hold_time_seconds: fields.hold_time_seconds,
    },
    accounting_summary: {
      quantity_closed: fields.total_sold_qty,
      entry_cost_quote: fields.allocated_cost_basis_quote,
      exit_proceeds_quote: fields.total_sold_quote,
      accounting_method: fields.accounting_method,
      num_buys: fields.num_buys,
      num_sells: fields.num_sells,
    },
    proof: {
      receipt_id: inventoryReceipt.receipt_id,
      receipt_hash: inventoryReceipt.receipt_hash,
      receipt_hash_short: receiptHashShort,
      quote_scope: 'raw_quote',
      receipt_scope: 'receipt_only',
    },
    badges: [...SHARE_CARD_BADGES],
    disclosure: SHARE_CARD_DISCLOSURE,
    links: {
      proof_href: links.proof_href,
      verifier_href: links.verifier_href,
    },
  });
}
