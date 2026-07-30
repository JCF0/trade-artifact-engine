import { fail, ReceiptPackageError } from './errors.mjs';
import { RECEIPT_PACKAGE_FETCH_PROFILE_V1 } from './profiles.mjs';

export { ReceiptPackageError };
export const PACKAGE_VERSION = 'receipt_package_v1';
export const ARCHIVE_RECORD_VERSION = 'receipt_package_archive_record_v1';
export const ECONOMICS_VERSION = 'receipt_package_economics_v1';
export const RECEIPT_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const PACKAGE_MEMBER_NAMES = Object.freeze([
  'manifest.json', 'canonical-receipt.json', 'verification.json', 'archive-record.json', 'economics.json',
]);
export const CONTENT_MEMBER_NAMES = Object.freeze(PACKAGE_MEMBER_NAMES.slice(1));

export const ECONOMICS_FIELDS = Object.freeze([
  'segment_index', 'accounting_method', 'entry_tx_hashes', 'exit_tx_hashes',
  'total_bought_qty', 'total_bought_quote', 'avg_buy_quote_price',
  'total_sold_qty', 'total_sold_quote', 'avg_sell_quote_price',
  'allocated_cost_basis_quote', 'remaining_qty', 'remaining_cost_basis_quote',
  'realized_pnl_quote', 'realized_pnl_pct', 'hold_time_seconds', 'num_buys', 'num_sells',
]);
export const OPERATIONAL_RECEIPT_FIELDS = Object.freeze([
  'candidate_hash', 'source', 'promoted_at', 'promoted_from',
]);
export const CANONICAL_RECEIPT_FIELDS = Object.freeze([
  'receipt_hash', 'receipt_id', 'receipt_version', 'receipt_type', 'token_mint', 'wallet', 'chain',
  'segment_index', 'verification_status', 'display_status', 'accounting_method', 'quote_mint', 'quote_symbol',
  'valuation_status', 'total_bought_qty', 'total_bought_quote', 'avg_buy_quote_price', 'total_sold_qty',
  'total_sold_quote', 'avg_sell_quote_price', 'allocated_cost_basis_quote', 'remaining_qty',
  'remaining_cost_basis_quote', 'realized_pnl_quote', 'realized_pnl_pct', 'unrealized_pnl_quote',
  'unrealized_pnl_pct', 'position_status', 'first_event_at', 'last_event_at', 'snapshot_at', 'hold_time_seconds',
  'entry_tx_hashes', 'exit_tx_hashes', 'num_buys', 'num_sells', 'limitations', 'flags',
  'ledger_accounting_version',
]);
export const PROMOTION_RECEIPT_FIELDS = Object.freeze([...CANONICAL_RECEIPT_FIELDS, ...OPERATIONAL_RECEIPT_FIELDS]);
export const ARCHIVE_FIELDS = Object.freeze(CANONICAL_RECEIPT_FIELDS.filter(key => !ECONOMICS_FIELDS.includes(key)));
export const PROMOTION_ARCHIVE_FIELDS = Object.freeze([...ARCHIVE_FIELDS, ...OPERATIONAL_RECEIPT_FIELDS]);
export const ECONOMICS_RECORD_FIELDS = Object.freeze([
  'receipt_hash', 'receipt_version', 'receipt_type', ...ECONOMICS_FIELDS,
]);
export const VERIFICATION_FIELDS = Object.freeze([
  'receipt_id', 'receipt_hash', 'recomputed_hash', 'hash_valid', 'rule_violations', 'schema_valid', 'consistency_valid', 'pass',
]);
export const FETCH_PROFILE = RECEIPT_PACKAGE_FETCH_PROFILE_V1;
export const VERSION_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_v[1-9][0-9]*$/;
export const INPUT_COMMITMENT_FIELDS = Object.freeze([
  'fetch_profile', 'normalization_profile', 'reconstruction_engine_version', 'accounting_method_version',
]);

const FORBIDDEN_FIELDS = new Set([
  '__proto__', 'prototype', 'constructor', 'job_id', 'runtime_timestamp', 'generated_at', 'created_at', 'updated_at',
  'hostname', 'host', 'machine', 'machine_path', 'evidence_path', 'path', 'local_path', 'source_path', 'absolute_path',
  'engine_root', 'local_source_directory', 'provider_url', 'api_url', 'rpc_url', 'api_key', 'api_key_identity',
  'secret', 'token', 'password', 'retry_count', 'git_commit', 'raw', 'raw_transaction', 'raw_transactions',
  'raw_transaction_body', 'raw_transaction_bodies', 'transaction_body', 'transaction_bodies', 'provider_response',
  'upload', 'upload_status', 'uploaded_at', 'mint', 'mint_status', 'minted_at', 'signing', 'signing_state', 'signature',
]);

function pathText(path) { return path.length ? path.join('.') : '<root>'; }
function descriptorEntries(value) {
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length) fail('symbol_key_not_allowed', `symbol keys are not allowed at ${pathText([])}`);
  return Object.entries(Object.getOwnPropertyDescriptors(value));
}

export function assertPlainJsonValue(value, path = [], seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('invalid_json_number', `non-finite numbers and negative zero are not allowed at ${pathText(path)}`);
    return;
  }
  if (typeof value !== 'object') fail('unsupported_json_value', `unsupported JSON value at ${pathText(path)}`, { type: typeof value });
  if (seen.has(value)) fail('cyclic_value_not_allowed', `cyclic values are not allowed at ${pathText(path)}`);
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) fail('custom_prototype_not_allowed', `custom array prototype at ${pathText(path)}`);
    const entries = descriptorEntries(value).filter(([key]) => key !== 'length');
    if (entries.length !== value.length || entries.some(([key], index) => key !== String(index))) fail('sparse_array_not_allowed', `arrays must be dense and have no named properties at ${pathText(path)}`);
    for (const [key, descriptor] of entries) {
      if (!Object.hasOwn(descriptor, 'value')) fail('accessor_not_allowed', `accessors are not allowed at ${pathText([...path, key])}`);
      assertPlainJsonValue(descriptor.value, [...path, key], seen);
    }
  } else {
    if (prototype !== Object.prototype) fail('custom_prototype_not_allowed', `custom object prototype at ${pathText(path)}`);
    for (const [key, descriptor] of descriptorEntries(value)) {
      if (!descriptor.enumerable) fail('non_enumerable_field_not_allowed', `non-enumerable fields are not allowed at ${pathText([...path, key])}`);
      if (!Object.hasOwn(descriptor, 'value')) fail('accessor_not_allowed', `accessors are not allowed at ${pathText([...path, key])}`);
      assertPlainJsonValue(descriptor.value, [...path, key], seen);
    }
  }
  seen.delete(value);
}

export function assertNoForbiddenFields(value, path = []) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      const containsUrl = /[a-z][a-z0-9+.-]*:\/\//i.test(value);
      const containsAbsolutePath = /(?:[a-z]:[\\/][^\s]+|\\\\[^\\\s]+\\[^\s]+|\/[^/\s]+(?:\/[^/\s]+)+|(?:^|[=\s"'(\[])\/[^/\s]+)/i.test(value);
      if (containsUrl || containsAbsolutePath) fail('forbidden_value', `URL or absolute path value is not allowed at ${pathText(path)}`);
    }
    return;
  }
  for (const [key, descriptor] of descriptorEntries(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const normalized = key.toLowerCase();
    if (FORBIDDEN_FIELDS.has(normalized) || normalized.endsWith('_path') || normalized.endsWith('_url')) {
      fail('forbidden_field', `forbidden field at ${pathText([...path, key])}`, { field: key, path: [...path, key] });
    }
    if (Object.hasOwn(descriptor, 'value')) assertNoForbiddenFields(descriptor.value, [...path, key]);
  }
}

export function assertExactFields(value, fields, context) {
  assertPlainJsonValue(value, [context]);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_object', `${context} must be a plain object`);
  assertNoForbiddenFields(value, [context]);
  const expected = new Set(fields);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail('unknown_field', `${context} contains unknown field: ${key}`, { context, field: key });
  for (const key of fields) if (!Object.hasOwn(value, key)) fail('missing_field', `${context} is missing field: ${key}`, { context, field: key });
}

export function assertReceiptHash(value, context = 'receipt_hash') {
  if (typeof value !== 'string' || !RECEIPT_HASH_PATTERN.test(value)) fail('malformed_receipt_hash', `${context} must be a 64-character lowercase SHA-256 hex digest`);
}
function assertNonemptyString(value, field) { if (typeof value !== 'string' || value.length === 0) fail('invalid_field', `${field} must be a non-empty string`, { field }); }
function assertFinite(value, field, nullable = false) { if (nullable && value === null) return; if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_field', `${field} must be ${nullable ? 'null or ' : ''}a finite number`, { field }); }
function assertStringArray(value, field) { if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) fail('invalid_field', `${field} must be an array of non-empty strings`, { field }); }

export function validateCanonicalReceiptV1(receipt) {
  assertExactFields(receipt, CANONICAL_RECEIPT_FIELDS, 'canonical_receipt');
  assertReceiptHash(receipt.receipt_hash);
  if (receipt.receipt_version !== '1.2.0') fail('unsupported_receipt_version', 'receipt_version must be 1.2.0');
  if (receipt.receipt_type !== 'closed_position') fail('unsupported_receipt_type', 'v1 requires receipt_type closed_position');
  if (receipt.verification_status !== 'verified' || receipt.position_status !== 'closed') fail('receipt_status_invalid', 'v1 requires closed_position and verified/closed status');
  for (const field of ['receipt_id','token_mint','wallet','chain','display_status','accounting_method','quote_mint','quote_symbol','valuation_status','ledger_accounting_version']) assertNonemptyString(receipt[field], field);
  if (!Number.isInteger(receipt.segment_index) || receipt.segment_index < 0) fail('invalid_field', 'segment_index must be a non-negative integer');
  for (const field of ['total_bought_qty','total_bought_quote','avg_buy_quote_price','total_sold_qty','total_sold_quote','avg_sell_quote_price','allocated_cost_basis_quote','remaining_qty','remaining_cost_basis_quote','realized_pnl_quote','realized_pnl_pct','first_event_at','last_event_at','hold_time_seconds']) assertFinite(receipt[field], field);
  for (const field of ['unrealized_pnl_quote','unrealized_pnl_pct','snapshot_at']) assertFinite(receipt[field], field, true);
  for (const field of ['num_buys','num_sells']) if (!Number.isInteger(receipt[field]) || receipt[field] < 0) fail('invalid_field', `${field} must be a non-negative integer`);
  assertStringArray(receipt.entry_tx_hashes, 'entry_tx_hashes'); assertStringArray(receipt.exit_tx_hashes, 'exit_tx_hashes'); assertStringArray(receipt.flags, 'flags');
  assertExactFields(receipt.limitations, ['receipt_scope','pnl_type','price_source','valuation_currency','disclosures'], 'canonical_receipt.limitations');
  if (receipt.limitations.receipt_scope !== 'closed_position'
      || receipt.limitations.pnl_type !== 'realized_closed'
      || receipt.limitations.price_source !== 'on_chain_swaps'
      || receipt.limitations.valuation_currency !== 'raw_quote') {
    fail('invalid_field', 'limitations must describe a raw-quote verified closed position');
  }
  assertStringArray(receipt.limitations.disclosures, 'limitations.disclosures');
  if (receipt.hold_time_seconds !== receipt.last_event_at - receipt.first_event_at
      || receipt.num_buys !== receipt.entry_tx_hashes.length
      || receipt.num_sells !== receipt.exit_tx_hashes.length
      || receipt.receipt_id !== `art_v12_cp_${receipt.token_mint.slice(0, 8)}_${receipt.segment_index}`
      || receipt.display_status !== 'Verified Closed Position'
      || receipt.ledger_accounting_version !== receipt.accounting_method) {
    fail('derived_field_mismatch', 'receipt ID, display status, hold time, transaction counts, and ledger accounting version must be exactly derived from stable receipt facts');
  }
  if (receipt.unrealized_pnl_quote !== null || receipt.unrealized_pnl_pct !== null || receipt.snapshot_at !== null) {
    fail('invalid_field', 'closed-position unrealized PnL and snapshot fields must be null');
  }
  return true;
}
function hasExactKeys(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function stableProjection(value, fields) {
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}
export function validateCanonicalReceiptInputV1(receipt) {
  if (hasExactKeys(receipt, CANONICAL_RECEIPT_FIELDS)) return validateCanonicalReceiptV1(receipt);
  assertExactFields(receipt, PROMOTION_RECEIPT_FIELDS, 'canonical_receipt_input');
  assertReceiptHash(receipt.candidate_hash, 'candidate_hash');
  assertNonemptyString(receipt.source, 'source');
  assertNonemptyString(receipt.promoted_from, 'promoted_from');
  assertFinite(receipt.promoted_at, 'promoted_at');
  return validateCanonicalReceiptV1(stableProjection(receipt, CANONICAL_RECEIPT_FIELDS));
}
export function validateArchiveRecordV1(record) {
  assertExactFields(record, ['archive_record_version', ...ARCHIVE_FIELDS], 'archive_record');
  if (record.archive_record_version !== ARCHIVE_RECORD_VERSION) fail('unsupported_archive_record_version', `archive_record_version must be ${ARCHIVE_RECORD_VERSION}`);
  assertReceiptHash(record.receipt_hash); return true;
}
export function validateArchiveRecordInputV1(record) {
  if (hasExactKeys(record, ['archive_record_version', ...ARCHIVE_FIELDS])) return validateArchiveRecordV1(record);
  assertExactFields(record, ['archive_record_version', ...PROMOTION_ARCHIVE_FIELDS], 'archive_record_input');
  if (record.archive_record_version !== ARCHIVE_RECORD_VERSION) fail('unsupported_archive_record_version', `archive_record_version must be ${ARCHIVE_RECORD_VERSION}`);
  assertReceiptHash(record.receipt_hash);
  assertReceiptHash(record.candidate_hash, 'candidate_hash');
  assertNonemptyString(record.source, 'source');
  assertNonemptyString(record.promoted_from, 'promoted_from');
  assertFinite(record.promoted_at, 'promoted_at');
  return true;
}
export function validateEconomicsRecordV1(record) {
  assertExactFields(record, ['economics_version', ...ECONOMICS_RECORD_FIELDS], 'economics_record');
  if (record.economics_version !== ECONOMICS_VERSION) fail('unsupported_economics_version', `economics_version must be ${ECONOMICS_VERSION}`);
  assertReceiptHash(record.receipt_hash); return true;
}
export function validateVerificationResultV1(result) {
  assertExactFields(result, VERIFICATION_FIELDS, 'verification_result');
  assertReceiptHash(result.receipt_hash); assertReceiptHash(result.recomputed_hash, 'recomputed_hash');
  if (!Array.isArray(result.rule_violations)) fail('invalid_verification_result', 'rule_violations must be an array');
  return true;
}
export function validateInputCommitmentV1(input) {
  assertExactFields(input, INPUT_COMMITMENT_FIELDS, 'input_commitment');
  for (const field of INPUT_COMMITMENT_FIELDS) assertNonemptyString(input[field], field);
  if (input.fetch_profile !== FETCH_PROFILE) fail('invalid_field', `fetch_profile must be ${FETCH_PROFILE}`);
  for (const field of ['normalization_profile', 'reconstruction_engine_version', 'accounting_method_version']) {
    if (!VERSION_IDENTIFIER_PATTERN.test(input[field])) fail('invalid_field', `${field} must be a stable versioned identifier`);
  }
  return true;
}
