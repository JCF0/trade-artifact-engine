import { createHash, randomUUID } from 'crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, resolve } from 'path';

import {
  readReceiptArchiveBundle,
  validateReceiptArchiveBundle,
  ReceiptArchiveError,
} from './archive-store.mjs';
import { DEFAULT_ENGINE_ROOT } from './scanner.mjs';
import { verifyReceipt } from '../ledger/receipt-verifier.mjs';

export const RECEIPT_ECONOMICS_VERSION = 'receipt_economics_v1';
export const RECEIPT_ECONOMICS_INDEX_VERSION = 'receipt_economics_index_v1';
export const DEFAULT_RECEIPT_ECONOMICS_RELATIVE_DIR = 'data/inventory/receipt-economics-v1';

const RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const TOP_LEVEL_FIELDS = new Set([
  'economics_version',
  'receipt_hash',
  'receipt_version',
  'receipt_type',
  'hash_bound_fields',
  'canonical_derived_fields',
  'verification',
  'provenance',
]);
const HASH_BOUND_FIELDS = Object.freeze([
  'segment_index',
  'entry_tx_hashes',
  'exit_tx_hashes',
  'total_bought_qty',
  'total_bought_quote',
  'avg_buy_quote_price',
  'total_sold_qty',
  'total_sold_quote',
  'avg_sell_quote_price',
  'allocated_cost_basis_quote',
  'remaining_qty',
  'remaining_cost_basis_quote',
  'realized_pnl_quote',
  'realized_pnl_pct',
  'accounting_method',
]);
const DERIVED_FIELDS = Object.freeze(['hold_time_seconds', 'num_buys', 'num_sells']);
const HASH_BOUND_FIELD_SET = new Set(HASH_BOUND_FIELDS);
const DERIVED_FIELD_SET = new Set(DERIVED_FIELDS);
const VERIFICATION_FIELDS = new Set([
  'recomputed_hash',
  'hash_valid',
  'schema_valid',
  'consistency_valid',
  'pass',
  'rule_violations',
]);
const PROVENANCE_FIELDS = new Set(['recovery_method', 'canonical_projection_hash']);
const RECOVERY_METHODS = new Set([
  'retained_canonical_receipt',
  'hash_matched_regeneration',
  'current_canonical_import',
]);
const REQUIRED_FINITE_FIELDS = [
  'total_bought_qty',
  'total_bought_quote',
  'avg_buy_quote_price',
  'remaining_qty',
  'remaining_cost_basis_quote',
];
const NULLABLE_FINITE_FIELDS = [
  'total_sold_qty',
  'total_sold_quote',
  'avg_sell_quote_price',
  'allocated_cost_basis_quote',
  'realized_pnl_quote',
  'realized_pnl_pct',
];
const FORBIDDEN_KEYS = new Set([
  'raw', 'raw_transaction', 'raw_transactions', 'transaction_body', 'transaction_bodies',
  'helius_transaction', 'helius_transactions', 'tokentransfers', 'nativetransfers', 'instructions',
  'path', 'local_path', 'source_path', 'absolute_path', 'engine_root',
  'host', 'hostname', 'username', 'user',
  'provider_url', 'rpc_url', 'api_url', 'url',
  'generated_at', 'imported_at', 'created_at', 'updated_at', 'runtime_timestamp',
  'process_id', 'pid',
]);

export class ReceiptEconomicsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReceiptEconomicsError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortStable(value) {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!isPlainObject(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortStable(value[key]);
  return sorted;
}

function stableJson(value) {
  return `${JSON.stringify(sortStable(value), null, 2)}\n`;
}

function stableHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fail(code, message, details = {}) {
  throw new ReceiptEconomicsError(code, message, details);
}

function assertReceiptHash(value, context) {
  if (typeof value !== 'string' || !RECEIPT_HASH_PATTERN.test(value)) {
    fail('malformed_receipt_hash', `${context} must be a 64-character lowercase hex string`, { [context]: value });
  }
}

function assertNoForbiddenKeys(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoForbiddenKeys(child, [...path, String(index)]));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (FORBIDDEN_KEYS.has(normalizedKey) || normalizedKey.endsWith('_path')) {
      fail('forbidden_sidecar_key', `forbidden sidecar key: ${[...path, key].join('.')}`, {
        key,
        path: [...path, key],
      });
    }
    assertNoForbiddenKeys(child, [...path, key]);
  }
}

function assertExactFields(object, allowed, code, context) {
  if (!isPlainObject(object)) fail(code, `${context} must be an object`);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(code, `${context} contains unexpected field: ${key}`, { field: key });
  }
  for (const key of allowed) {
    if (!Object.hasOwn(object, key)) fail(code, `${context} is missing required field: ${key}`, { field: key });
  }
}

function assertFiniteNumber(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid_economics_field', `${field} must be ${nullable ? 'null or ' : ''}a finite number`, { field, value });
  }
}

function assertTxHashes(value, field) {
  if (!Array.isArray(value) || value.some(hash => typeof hash !== 'string' || hash.length === 0)) {
    fail('invalid_economics_field', `${field} must be an array of non-empty transaction hash strings`, { field });
  }
}

function validateEconomicsSchema(hashBound, derived) {
  assertExactFields(hashBound, HASH_BOUND_FIELD_SET, 'unexpected_hash_bound_field', 'hash_bound_fields');
  assertExactFields(derived, DERIVED_FIELD_SET, 'unexpected_derived_field', 'canonical_derived_fields');
  if (!Number.isInteger(hashBound.segment_index) || hashBound.segment_index < 0) {
    fail('invalid_economics_field', 'segment_index must be a non-negative integer', { field: 'segment_index' });
  }
  assertTxHashes(hashBound.entry_tx_hashes, 'entry_tx_hashes');
  assertTxHashes(hashBound.exit_tx_hashes, 'exit_tx_hashes');
  for (const field of REQUIRED_FINITE_FIELDS) assertFiniteNumber(hashBound[field], field);
  for (const field of NULLABLE_FINITE_FIELDS) assertFiniteNumber(hashBound[field], field, { nullable: true });
  if (typeof hashBound.accounting_method !== 'string' || hashBound.accounting_method.length === 0) {
    fail('invalid_economics_field', 'accounting_method must be a non-empty string', { field: 'accounting_method' });
  }
  if (!Number.isFinite(derived.hold_time_seconds) || derived.hold_time_seconds < 0) {
    fail('invalid_economics_field', 'hold_time_seconds must be a non-negative finite number', { field: 'hold_time_seconds' });
  }
  for (const field of ['num_buys', 'num_sells']) {
    if (!Number.isInteger(derived[field]) || derived[field] < 0) {
      fail('invalid_economics_field', `${field} must be a non-negative integer`, { field });
    }
  }
}

function validateArchive(archiveBundle, sidecar) {
  if (!archiveBundle) fail('missing_archive_bundle', 'corresponding receipt_archive_v1 bundle is required', { receipt_hash: sidecar.receipt_hash });
  try {
    validateReceiptArchiveBundle(archiveBundle);
  } catch (error) {
    if (error instanceof ReceiptArchiveError && [
      'inventory_record_hash_mismatch', 'canonical_receipt_hash_mismatch',
      'canonical_receipt_record_invalid', 'source_hash_mismatch',
    ].includes(error.code)) {
      fail('archive_overlap_mismatch', 'receipt_archive_v1 canonical and inventory fields do not agree', {
        receipt_hash: sidecar.receipt_hash,
        archive_error_code: error.code,
      });
    }
    fail('invalid_archive_bundle', 'receipt_archive_v1 bundle failed validation', {
      receipt_hash: sidecar.receipt_hash,
      archive_error_code: error?.code || 'invalid_archive_bundle',
    });
  }
  if (archiveBundle.receipt_hash !== sidecar.receipt_hash) {
    fail('archive_hash_mismatch', 'archive receipt_hash must match sidecar receipt_hash', {
      receipt_hash: sidecar.receipt_hash,
      archive_receipt_hash: archiveBundle.receipt_hash,
    });
  }
  const canonical = archiveBundle.canonical_receipt_record;
  if (canonical.receipt_version !== sidecar.receipt_version || canonical.receipt_type !== sidecar.receipt_type) {
    fail('archive_overlap_mismatch', 'sidecar receipt version and type must match receipt_archive_v1', {
      receipt_hash: sidecar.receipt_hash,
    });
  }
}

function reconstructUnchecked(sidecar, archiveBundle) {
  return {
    ...clone(archiveBundle.canonical_receipt_record),
    ...clone(sidecar.hash_bound_fields),
    ...clone(sidecar.canonical_derived_fields),
  };
}

function validateDerived(sidecar, archiveBundle) {
  const hashBound = sidecar.hash_bound_fields;
  const derived = sidecar.canonical_derived_fields;
  const canonical = archiveBundle.canonical_receipt_record;
  const expectedHoldTime = canonical.last_event_at - canonical.first_event_at;
  if (derived.hold_time_seconds !== expectedHoldTime) {
    fail('derived_hold_time_mismatch', 'hold_time_seconds must equal last_event_at - first_event_at', {
      expected: expectedHoldTime,
      actual: derived.hold_time_seconds,
    });
  }
  if (derived.num_buys !== hashBound.entry_tx_hashes.length) {
    fail('derived_buy_count_mismatch', 'num_buys must equal entry_tx_hashes.length', {
      expected: hashBound.entry_tx_hashes.length,
      actual: derived.num_buys,
    });
  }
  if (derived.num_sells !== hashBound.exit_tx_hashes.length) {
    fail('derived_sell_count_mismatch', 'num_sells must equal exit_tx_hashes.length', {
      expected: hashBound.exit_tx_hashes.length,
      actual: derived.num_sells,
    });
  }
}

function verificationProjection(verification) {
  return {
    recomputed_hash: verification.recomputed_hash,
    hash_valid: verification.hash_valid,
    schema_valid: verification.schema_valid,
    consistency_valid: verification.consistency_valid,
    pass: verification.pass,
    rule_violations: clone(verification.rule_violations),
  };
}

function archiveOptions(options) {
  return { engineRoot: options.engineRoot, archiveRoot: options.archiveRoot };
}

function loadArchive(receiptHash, options) {
  try {
    return readReceiptArchiveBundle(receiptHash, archiveOptions(options));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('missing_archive_bundle', 'corresponding receipt_archive_v1 bundle is required', { receipt_hash: receiptHash });
    }
    if (error instanceof SyntaxError) {
      fail('invalid_archive_bundle', 'receipt_archive_v1 bundle is not valid JSON', {
        receipt_hash: receiptHash,
        archive_error_code: 'corrupt_archive_bundle',
      });
    }
    if (error instanceof ReceiptArchiveError) {
      if ([
        'inventory_record_hash_mismatch',
        'canonical_receipt_hash_mismatch',
        'canonical_receipt_record_invalid',
        'source_hash_mismatch',
      ].includes(error.code)) {
        fail('archive_overlap_mismatch', 'receipt_archive_v1 canonical and inventory fields do not agree', {
          receipt_hash: receiptHash,
          archive_error_code: error.code,
        });
      }
      fail('invalid_archive_bundle', 'receipt_archive_v1 bundle failed validation', {
        receipt_hash: receiptHash,
        archive_error_code: error.code,
      });
    }
    throw error;
  }
}

export function serializeReceiptEconomicsSidecar(sidecar) {
  return stableJson(sidecar);
}

export function getReceiptEconomicsPaths({ engineRoot = DEFAULT_ENGINE_ROOT, economicsRoot } = {}) {
  const rootDir = economicsRoot ? resolve(economicsRoot) : resolve(engineRoot, DEFAULT_RECEIPT_ECONOMICS_RELATIVE_DIR);
  return {
    rootDir,
    receiptsDir: resolve(rootDir, 'receipts'),
    indexPath: resolve(rootDir, 'index.json'),
  };
}

export function validateReceiptEconomicsSidecar(sidecar, {
  receiptHash = sidecar?.receipt_hash,
  archiveBundle,
} = {}) {
  if (!isPlainObject(sidecar)) fail('invalid_sidecar', 'receipt economics sidecar must be an object');
  assertNoForbiddenKeys(sidecar);
  assertExactFields(sidecar, TOP_LEVEL_FIELDS, 'unexpected_sidecar_field', 'sidecar');
  if (sidecar.economics_version !== RECEIPT_ECONOMICS_VERSION) {
    fail('unsupported_economics_version', `unsupported economics version: ${sidecar.economics_version}`);
  }
  assertReceiptHash(sidecar.receipt_hash, 'receipt_hash');
  assertReceiptHash(receiptHash, 'filename_receipt_hash');
  if (sidecar.receipt_hash !== receiptHash) {
    fail('filename_hash_mismatch', 'filename receipt hash must match top-level receipt_hash', {
      filename_receipt_hash: receiptHash,
      receipt_hash: sidecar.receipt_hash,
    });
  }
  if (sidecar.receipt_version !== '1.2.0') {
    fail('unsupported_receipt_version', `unsupported receipt version: ${sidecar.receipt_version}`);
  }
  if (typeof sidecar.receipt_type !== 'string' || sidecar.receipt_type.length === 0) {
    fail('invalid_receipt_type', 'receipt_type must be a non-empty string');
  }

  validateArchive(archiveBundle, sidecar);
  validateEconomicsSchema(sidecar.hash_bound_fields, sidecar.canonical_derived_fields);
  validateDerived(sidecar, archiveBundle);
  assertExactFields(sidecar.verification, VERIFICATION_FIELDS, 'invalid_verification_record', 'verification');
  assertExactFields(sidecar.provenance, PROVENANCE_FIELDS, 'invalid_provenance', 'provenance');
  if (!RECOVERY_METHODS.has(sidecar.provenance.recovery_method)) {
    fail('invalid_recovery_method', `unsupported recovery method: ${sidecar.provenance.recovery_method}`);
  }
  assertReceiptHash(sidecar.provenance.canonical_projection_hash, 'canonical_projection_hash');

  const canonicalReceipt = reconstructUnchecked(sidecar, archiveBundle);
  const verification = verifyReceipt(canonicalReceipt);
  if (!verification.hash_valid || verification.recomputed_hash !== sidecar.receipt_hash) {
    fail('receipt_hash_mismatch', 'reconstructed canonical receipt does not match receipt_hash', {
      receipt_hash: sidecar.receipt_hash,
      recomputed_hash: verification.recomputed_hash,
    });
  }
  if (!verification.pass || !verification.schema_valid || !verification.consistency_valid) {
    fail('receipt_verification_failed', 'reconstructed canonical receipt failed existing verifyReceipt()', {
      receipt_hash: sidecar.receipt_hash,
      hash_valid: verification.hash_valid,
      schema_valid: verification.schema_valid,
      consistency_valid: verification.consistency_valid,
      verifier_pass: verification.pass,
      violation_rules: verification.rule_violations.map(item => item.rule),
    });
  }
  const expectedVerification = verificationProjection(verification);
  if (stableJson(sidecar.verification) !== stableJson(expectedVerification)) {
    fail('verification_record_mismatch', 'stored verification must equal the existing verifier result', {
      receipt_hash: sidecar.receipt_hash,
    });
  }
  const expectedProjectionHash = stableHash(canonicalReceipt);
  if (sidecar.provenance.canonical_projection_hash !== expectedProjectionHash) {
    fail('canonical_projection_hash_mismatch', 'canonical projection hash does not match reconstructed receipt', {
      receipt_hash: sidecar.receipt_hash,
      expected: expectedProjectionHash,
      actual: sidecar.provenance.canonical_projection_hash,
    });
  }

  return deepFreeze({
    sidecar: clone(sidecar),
    economics: { ...clone(sidecar.hash_bound_fields), ...clone(sidecar.canonical_derived_fields) },
    canonical_receipt: canonicalReceipt,
    verification: clone(verification),
  });
}

export function buildReceiptEconomicsSidecar(canonicalReceipt, {
  archiveBundle,
  recoveryMethod,
} = {}) {
  if (!isPlainObject(canonicalReceipt)) fail('invalid_canonical_receipt', 'canonical receipt must be an object');
  if (!RECOVERY_METHODS.has(recoveryMethod)) {
    fail('invalid_recovery_method', `unsupported recovery method: ${recoveryMethod}`);
  }
  const hashBound = {};
  const derived = {};
  for (const field of HASH_BOUND_FIELDS) hashBound[field] = clone(canonicalReceipt[field]);
  for (const field of DERIVED_FIELDS) derived[field] = clone(canonicalReceipt[field]);
  const partial = {
    economics_version: RECEIPT_ECONOMICS_VERSION,
    receipt_hash: canonicalReceipt.receipt_hash,
    receipt_version: canonicalReceipt.receipt_version,
    receipt_type: canonicalReceipt.receipt_type,
    hash_bound_fields: hashBound,
    canonical_derived_fields: derived,
  };
  const reconstructed = reconstructUnchecked(partial, archiveBundle);
  const verification = verifyReceipt(reconstructed);
  const sidecar = {
    ...partial,
    verification: verificationProjection(verification),
    provenance: {
      recovery_method: recoveryMethod,
      canonical_projection_hash: stableHash(reconstructed),
    },
  };
  validateReceiptEconomicsSidecar(sidecar, {
    receiptHash: canonicalReceipt.receipt_hash,
    archiveBundle,
  });
  return deepFreeze(clone(sidecar));
}

export function reconstructCanonicalReceipt(sidecar, options = {}) {
  return validateReceiptEconomicsSidecar(sidecar, options).canonical_receipt;
}

function sidecarPath(receiptHash, options) {
  return resolve(getReceiptEconomicsPaths(options).receiptsDir, `${receiptHash}.json`);
}

function publishExclusive(targetPath, bytes) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, bytes, { encoding: 'utf8', flag: 'wx' });
    try {
      linkSync(tempPath, targetPath);
      return 'written';
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return 'exists';
    }
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function compareExisting(targetPath, proposedBytes, receiptHash) {
  const existingBytes = readFileSync(targetPath, 'utf8');
  if (existingBytes !== proposedBytes) {
    fail('receipt_economics_conflict', 'same receipt_hash has different economics sidecar bytes', {
      receipt_hash: receiptHash,
    });
  }
}

export function writeReceiptEconomicsSidecar(sidecar, options = {}) {
  const receiptHash = options.receiptHash ?? sidecar?.receipt_hash;
  assertReceiptHash(receiptHash, 'filename_receipt_hash');
  const archiveBundle = loadArchive(receiptHash, options);
  validateReceiptEconomicsSidecar(sidecar, { receiptHash, archiveBundle });

  const targetPath = sidecarPath(receiptHash, options);
  const proposedBytes = serializeReceiptEconomicsSidecar(sidecar);
  if (existsSync(targetPath)) {
    compareExisting(targetPath, proposedBytes, receiptHash);
    return { status: 'unchanged', receipt_hash: receiptHash, path: targetPath };
  }

  const status = publishExclusive(targetPath, proposedBytes);
  if (status === 'exists') {
    compareExisting(targetPath, proposedBytes, receiptHash);
    return { status: 'unchanged', receipt_hash: receiptHash, path: targetPath };
  }
  return { status: 'written', receipt_hash: receiptHash, path: targetPath };
}

export function readReceiptEconomics(receiptHash, options = {}) {
  assertReceiptHash(receiptHash, 'filename_receipt_hash');
  const archiveBundle = loadArchive(receiptHash, options);
  const path = sidecarPath(receiptHash, options);
  let sidecar;
  try {
    sidecar = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail('missing_economics_sidecar', 'receipt economics sidecar does not exist', { receipt_hash: receiptHash });
    }
    if (error instanceof SyntaxError) {
      fail('corrupt_economics_sidecar', 'receipt economics sidecar is not valid JSON', { receipt_hash: receiptHash });
    }
    throw error;
  }
  return validateReceiptEconomicsSidecar(sidecar, { receiptHash, archiveBundle });
}

export function readValidatedReceiptEconomicsWithDiagnostics(options = {}) {
  const entries = [];
  const diagnostics = [];

  for (const path of listReceiptEconomicsSidecarFiles(options)) {
    const receiptHash = basename(path, '.json');
    try {
      const validated = readReceiptEconomics(receiptHash, options);
      entries.push({
        receipt_hash: receiptHash,
        recovery_method: validated.sidecar.provenance.recovery_method,
        economics: clone(validated.economics),
      });
    } catch (error) {
      diagnostics.push({
        code: 'canonical_economics_excluded',
        receipt_hash: receiptHash,
        source: RECEIPT_ECONOMICS_VERSION,
        reason: error instanceof ReceiptEconomicsError
          ? error.code
          : 'receipt_economics_read_failed',
      });
    }
  }

  return deepFreeze({ entries, diagnostics });
}

export function listReceiptEconomicsSidecarFiles(options = {}) {
  const { receiptsDir } = getReceiptEconomicsPaths(options);
  if (!existsSync(receiptsDir)) return [];
  return readdirSync(receiptsDir)
    .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map(name => resolve(receiptsDir, name));
}

export function buildReceiptEconomicsIndex(sidecars) {
  const sorted = [...sidecars].sort((a, b) => a.receipt_hash.localeCompare(b.receipt_hash));
  return sortStable({
    economics_version: RECEIPT_ECONOMICS_VERSION,
    index_version: RECEIPT_ECONOMICS_INDEX_VERSION,
    receipt_count: sorted.length,
    receipts: sorted.map(sidecar => ({
      receipt_hash: sidecar.receipt_hash,
      receipt_version: sidecar.receipt_version,
      receipt_type: sidecar.receipt_type,
      canonical_projection_hash: sidecar.provenance.canonical_projection_hash,
      sidecar_path: `receipts/${sidecar.receipt_hash}.json`,
    })),
  });
}

function replaceJsonIfChanged(targetPath, value) {
  const bytes = stableJson(value);
  if (existsSync(targetPath) && readFileSync(targetPath, 'utf8') === bytes) return 'unchanged';
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, bytes, { encoding: 'utf8', flag: 'wx' });
    renameSync(tempPath, targetPath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return 'written';
}

export function rebuildReceiptEconomicsIndex(options = {}) {
  const sidecars = listReceiptEconomicsSidecarFiles(options).map(path => {
    const receiptHash = basename(path, '.json');
    return readReceiptEconomics(receiptHash, options).sidecar;
  });
  const index = buildReceiptEconomicsIndex(sidecars);
  const { indexPath } = getReceiptEconomicsPaths(options);
  const status = replaceJsonIfChanged(indexPath, index);
  return { status, path: indexPath, index };
}
