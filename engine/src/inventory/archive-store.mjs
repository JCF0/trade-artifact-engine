import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';

import { DEFAULT_ENGINE_ROOT } from './scanner.mjs';

export const RECEIPT_ARCHIVE_VERSION = 'receipt_archive_v1';
export const RECEIPT_ARCHIVE_INDEX_VERSION = 'receipt_archive_index_v1';
export const DEFAULT_RECEIPT_ARCHIVE_RELATIVE_DIR = 'data/inventory/receipt-archive-v1';

const RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PORTABILITY_EXCLUDED_KEYS = new Set([
  'image_artifact_path',
  'metadata_template_path',
  'resolved_metadata_path',
  'final_metadata_path',
  'local_path',
  'source_path',
  'absolute_path',
  'engine_root',
  'generated_at',
  'imported_at',
  'created_at',
  'updated_at',
]);

const RAW_DATA_KEYS = new Set([
  'raw',
  'raw_transaction',
  'raw_transactions',
  'helius_transaction',
  'helius_transactions',
  'tokenTransfers',
  'nativeTransfers',
  'instructions',
]);

const CANONICAL_RECEIPT_FIELDS = [
  'receipt_hash',
  'receipt_id',
  'receipt_version',
  'receipt_type',
  'wallet',
  'chain',
  'token_mint',
  'quote_mint',
  'quote_symbol',
  'candidate_hash',
  'verification_status',
  'display_status',
  'valuation_status',
  'position_status',
  'first_event_at',
  'last_event_at',
  'snapshot_at',
  'flags',
  'limitations',
];

export class ReceiptArchiveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReceiptArchiveError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stableJson(value) {
  return `${JSON.stringify(sortStable(value), null, 2)}\n`;
}

function sortStable(value) {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!isPlainObject(value)) return value;

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortStable(value[key]);
  }
  return sorted;
}

function stableHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function cloneStable(value) {
  return JSON.parse(stableJson(value));
}

function assertReceiptHash(receiptHash, context = 'receipt_hash') {
  if (typeof receiptHash !== 'string' || !RECEIPT_HASH_PATTERN.test(receiptHash)) {
    throw new ReceiptArchiveError('malformed_receipt_hash', `${context} must be a 64-character lowercase hex string`, { receipt_hash: receiptHash });
  }
}

function assertNoRawWalletData(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawWalletData(item, [...path, String(index)]));
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (RAW_DATA_KEYS.has(key)) {
      throw new ReceiptArchiveError('raw_wallet_data_not_allowed', `raw wallet transaction data is not allowed in receipt archive bundles: ${[...path, key].join('.')}`, { key, path: [...path, key] });
    }
    assertNoRawWalletData(child, [...path, key]);
  }
}

function normalizePortableInventoryRecord(value) {
  if (Array.isArray(value)) return value.map(normalizePortableInventoryRecord);
  if (!isPlainObject(value)) return value;

  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (PORTABILITY_EXCLUDED_KEYS.has(key)) continue;
    normalized[key] = normalizePortableInventoryRecord(child);
  }
  return normalized;
}

function buildCanonicalReceiptRecord(inventoryRecord) {
  const canonical = {};
  for (const field of CANONICAL_RECEIPT_FIELDS) {
    if (Object.hasOwn(inventoryRecord, field)) canonical[field] = inventoryRecord[field];
  }
  return cloneStable(canonical);
}

export function getReceiptArchivePaths({
  engineRoot = DEFAULT_ENGINE_ROOT,
  archiveRoot,
} = {}) {
  const rootDir = archiveRoot ? resolve(archiveRoot) : resolve(engineRoot, DEFAULT_RECEIPT_ARCHIVE_RELATIVE_DIR);
  return {
    rootDir,
    receiptsDir: resolve(rootDir, 'receipts'),
    indexPath: resolve(rootDir, 'index.json'),
  };
}

export function buildReceiptArchiveBundle(inventoryRecord, {
  provenance = {},
} = {}) {
  if (!isPlainObject(inventoryRecord)) {
    throw new ReceiptArchiveError('invalid_inventory_record', 'inventory record must be an object');
  }

  const receiptHash = inventoryRecord.receipt_hash;
  assertReceiptHash(receiptHash);
  assertNoRawWalletData(inventoryRecord);

  const normalizedInventoryRecord = cloneStable(normalizePortableInventoryRecord(inventoryRecord));
  const canonicalReceiptRecord = buildCanonicalReceiptRecord(normalizedInventoryRecord);
  if (canonicalReceiptRecord.receipt_hash !== receiptHash) {
    throw new ReceiptArchiveError('canonical_receipt_hash_mismatch', 'canonical receipt record hash identity does not match inventory record receipt_hash', {
      receipt_hash: receiptHash,
      canonical_receipt_hash: canonicalReceiptRecord.receipt_hash,
    });
  }

  return cloneStable({
    archive_version: RECEIPT_ARCHIVE_VERSION,
    receipt_hash: receiptHash,
    receipt_id: normalizedInventoryRecord.receipt_id ?? null,
    canonical_receipt_record: canonicalReceiptRecord,
    inventory_record: normalizedInventoryRecord,
    provenance: {
      source: 'scanner_normalized_inventory_record',
      run_label: null,
      source_record_hashes: {
        canonical_receipt_record: stableHash(canonicalReceiptRecord),
        inventory_record: stableHash(normalizedInventoryRecord),
      },
      source_paths: [],
    },
  });
}

export function validateReceiptArchiveBundle(bundle) {
  if (!isPlainObject(bundle)) {
    throw new ReceiptArchiveError('invalid_archive_bundle', 'archive bundle must be an object');
  }
  if (bundle.archive_version !== RECEIPT_ARCHIVE_VERSION) {
    throw new ReceiptArchiveError('unsupported_archive_version', `unsupported archive bundle version: ${bundle.archive_version}`);
  }

  assertReceiptHash(bundle.receipt_hash);
  if (!isPlainObject(bundle.inventory_record)) {
    throw new ReceiptArchiveError('invalid_inventory_record', 'archive bundle inventory_record must be an object', { receipt_hash: bundle.receipt_hash });
  }
  if (!isPlainObject(bundle.canonical_receipt_record)) {
    throw new ReceiptArchiveError('invalid_canonical_receipt_record', 'archive bundle canonical_receipt_record must be an object', { receipt_hash: bundle.receipt_hash });
  }
  assertNoRawWalletData(bundle);

  if (stableJson(normalizePortableInventoryRecord(bundle.inventory_record)) !== stableJson(bundle.inventory_record)) {
    throw new ReceiptArchiveError('inventory_record_not_portable', 'archive bundle inventory_record contains non-portable path or runtime metadata fields', { receipt_hash: bundle.receipt_hash });
  }

  if (bundle.inventory_record.receipt_hash !== bundle.receipt_hash) {
    throw new ReceiptArchiveError('inventory_record_hash_mismatch', 'inventory_record.receipt_hash must match bundle receipt_hash', { receipt_hash: bundle.receipt_hash });
  }
  if (bundle.canonical_receipt_record.receipt_hash !== bundle.receipt_hash) {
    throw new ReceiptArchiveError('canonical_receipt_hash_mismatch', 'canonical_receipt_record.receipt_hash must match bundle receipt_hash', { receipt_hash: bundle.receipt_hash });
  }

  const expectedCanonical = buildCanonicalReceiptRecord(bundle.inventory_record);
  if (stableJson(expectedCanonical) !== stableJson(bundle.canonical_receipt_record)) {
    throw new ReceiptArchiveError('canonical_receipt_record_invalid', 'canonical_receipt_record must match canonical fields derived from inventory_record', { receipt_hash: bundle.receipt_hash });
  }

  const sourceHashes = bundle.provenance?.source_record_hashes;
  if (!isPlainObject(sourceHashes)) {
    throw new ReceiptArchiveError('missing_source_record_hashes', 'archive bundle provenance.source_record_hashes is required', { receipt_hash: bundle.receipt_hash });
  }
  if (sourceHashes.canonical_receipt_record !== stableHash(bundle.canonical_receipt_record)) {
    throw new ReceiptArchiveError('source_hash_mismatch', 'canonical receipt source hash mismatch', { receipt_hash: bundle.receipt_hash, field: 'canonical_receipt_record' });
  }
  if (sourceHashes.inventory_record !== stableHash(bundle.inventory_record)) {
    throw new ReceiptArchiveError('source_hash_mismatch', 'inventory record source hash mismatch', { receipt_hash: bundle.receipt_hash, field: 'inventory_record' });
  }

  return true;
}

function sameCanonicalReceipt(a, b) {
  return stableJson(a.canonical_receipt_record) === stableJson(b.canonical_receipt_record);
}

function sameBundle(a, b) {
  return stableJson(a) === stableJson(b);
}

function bundlePathFor(receiptsDir, receiptHash) {
  return resolve(receiptsDir, `${receiptHash}.json`);
}

function atomicWriteJson(targetPath, value) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.tmp`);
  try {
    writeFileSync(tempPath, stableJson(value), 'utf8');
    renameSync(tempPath, targetPath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function receiptRelativePath(rootDir, absPath) {
  return relative(rootDir, absPath).split('\\').join('/');
}

export function writeReceiptArchiveBundle(bundle, options = {}) {
  validateReceiptArchiveBundle(bundle);
  const { rootDir, receiptsDir } = getReceiptArchivePaths(options);
  const targetPath = bundlePathFor(receiptsDir, bundle.receipt_hash);

  if (existsSync(targetPath)) {
    const existing = readReceiptArchiveBundle(bundle.receipt_hash, options);
    if (!sameCanonicalReceipt(existing, bundle)) {
      throw new ReceiptArchiveError('receipt_hash_conflict', 'same receipt_hash has a different canonical receipt record', { receipt_hash: bundle.receipt_hash });
    }
    if (!sameBundle(existing, bundle)) {
      throw new ReceiptArchiveError('receipt_archive_bundle_conflict', 'same receipt_hash has different archived non-canonical data; conflicts are not resolved silently', { receipt_hash: bundle.receipt_hash });
    }
    return {
      status: 'unchanged',
      receipt_hash: bundle.receipt_hash,
      path: targetPath,
      warnings: collectReceiptIdWarnings(rootDir, bundle),
    };
  }

  atomicWriteJson(targetPath, bundle);
  return {
    status: 'written',
    receipt_hash: bundle.receipt_hash,
    path: targetPath,
    warnings: collectReceiptIdWarnings(rootDir, bundle),
  };
}

export function readReceiptArchiveBundle(receiptHash, options = {}) {
  assertReceiptHash(receiptHash);
  const { receiptsDir } = getReceiptArchivePaths(options);
  const path = bundlePathFor(receiptsDir, receiptHash);
  const bundle = readJsonFile(path);
  validateReceiptArchiveBundle(bundle);
  return bundle;
}

export function listReceiptArchiveBundleFiles(options = {}) {
  const { receiptsDir } = getReceiptArchivePaths(options);
  if (!existsSync(receiptsDir)) return [];
  return readdirSync(receiptsDir)
    .filter(name => RECEIPT_HASH_PATTERN.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
    .sort()
    .map(name => resolve(receiptsDir, name));
}

export function readReceiptArchiveBundles(options = {}) {
  return listReceiptArchiveBundleFiles(options).map(path => {
    const bundle = readJsonFile(path);
    validateReceiptArchiveBundle(bundle);
    return bundle;
  });
}

export function readReceiptArchiveBundlesWithDiagnostics(options = {}) {
  const bundles = [];
  const diagnostics = [];
  for (const path of listReceiptArchiveBundleFiles(options)) {
    try {
      const bundle = readJsonFile(path);
      validateReceiptArchiveBundle(bundle);
      bundles.push(bundle);
    } catch (error) {
      diagnostics.push({
        code: error instanceof ReceiptArchiveError ? error.code : 'corrupt_archive_bundle',
        path: path.split('\\\\').join('/'),
        message: error instanceof SyntaxError ? 'archive bundle is not valid JSON' : (error?.message || String(error)),
      });
    }
  }
  return { bundles, diagnostics };
}

function collectReceiptIdWarnings(rootDir, additionalBundle = null) {
  const warnings = [];
  const byReceiptId = new Map();
  const bundles = [];
  const receiptsDir = resolve(rootDir, 'receipts');

  if (existsSync(receiptsDir)) {
    for (const path of listReceiptArchiveBundleFiles({ archiveRoot: rootDir })) {
      try {
        bundles.push(readJsonFile(path));
      } catch {
        // Corrupt bundle warnings are emitted by rebuild; import warnings should not mask write success.
      }
    }
  }
  if (additionalBundle) bundles.push(additionalBundle);

  for (const bundle of bundles) {
    const receiptId = bundle?.receipt_id;
    const receiptHash = bundle?.receipt_hash;
    if (typeof receiptId !== 'string' || typeof receiptHash !== 'string') continue;
    if (!byReceiptId.has(receiptId)) byReceiptId.set(receiptId, new Set());
    byReceiptId.get(receiptId).add(receiptHash);
  }

  for (const [receiptId, hashes] of [...byReceiptId.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (hashes.size <= 1) continue;
    warnings.push({
      code: 'receipt_id_multiple_hashes',
      receipt_id: receiptId,
      receipt_hashes: [...hashes].sort(),
    });
  }
  return warnings;
}

export function buildReceiptArchiveIndex(bundles, { rootDir } = {}) {
  const sortedBundles = [...bundles].sort((a, b) => a.receipt_hash.localeCompare(b.receipt_hash));
  const warnings = collectReceiptIdWarningsFromBundles(sortedBundles);

  return cloneStable({
    archive_version: RECEIPT_ARCHIVE_VERSION,
    index_version: RECEIPT_ARCHIVE_INDEX_VERSION,
    receipt_count: sortedBundles.length,
    receipts: sortedBundles.map(bundle => ({
      receipt_hash: bundle.receipt_hash,
      receipt_id: bundle.receipt_id ?? null,
      receipt_type: bundle.inventory_record?.receipt_type ?? null,
      verification_status: bundle.inventory_record?.verification_status ?? null,
      canonical_receipt_record_hash: bundle.provenance.source_record_hashes.canonical_receipt_record,
      bundle_path: rootDir ? receiptRelativePath(rootDir, bundlePathFor(resolve(rootDir, 'receipts'), bundle.receipt_hash)) : `receipts/${bundle.receipt_hash}.json`,
    })),
    warnings,
  });
}

function collectReceiptIdWarningsFromBundles(bundles) {
  const byReceiptId = new Map();
  for (const bundle of bundles) {
    const receiptId = bundle.receipt_id;
    if (typeof receiptId !== 'string' || receiptId.length === 0) continue;
    if (!byReceiptId.has(receiptId)) byReceiptId.set(receiptId, new Set());
    byReceiptId.get(receiptId).add(bundle.receipt_hash);
  }

  return [...byReceiptId.entries()]
    .filter(([, hashes]) => hashes.size > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([receiptId, hashes]) => ({
      code: 'receipt_id_multiple_hashes',
      receipt_id: receiptId,
      receipt_hashes: [...hashes].sort(),
    }));
}

export function rebuildReceiptArchiveIndex(options = {}) {
  const { rootDir, indexPath } = getReceiptArchivePaths(options);
  const bundles = readReceiptArchiveBundles(options);
  const index = buildReceiptArchiveIndex(bundles, { rootDir });
  atomicWriteJson(indexPath, index);
  return {
    status: 'rebuilt',
    path: indexPath,
    index,
  };
}
