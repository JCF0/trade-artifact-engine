#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readReceiptArchiveBundle, stableJson } from '../inventory/archive-store.mjs';
import { readReceiptEconomics, ReceiptEconomicsError } from '../inventory/receipt-economics-store.mjs';
import { verifyReceipt } from '../ledger/receipt-verifier.mjs';
import { buildReceiptPackageV1 } from './builder.mjs';
import { createReceiptPackageFsStore, ReceiptPackageStoreError } from './fs-package-store.mjs';
import {
  ARCHIVE_FIELDS,
  ARCHIVE_RECORD_VERSION,
  CANONICAL_RECEIPT_FIELDS,
  ECONOMICS_FIELDS,
  ECONOMICS_VERSION,
  RECEIPT_HASH_PATTERN,
  validateCanonicalReceiptInputV1,
  validateVerificationResultV1,
} from './schema.mjs';
import { canonicalJson, serializeReceiptPackageV1, sha256CanonicalJson } from './serialize.mjs';
import { RECEIPT_PACKAGE_PROFILES_V1 } from './profiles.mjs';

const CANDIDATE_FIELDS = Object.freeze([
  'receipt_hash', 'canonical_receipt', 'verification_result', 'recovery_method',
]);
const CONTENT_MEMBER_NAMES = Object.freeze([
  'canonical-receipt.json', 'verification.json', 'archive-record.json', 'economics.json',
]);

export class ReceiptPackageMigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReceiptPackageMigrationError';
    this.code = code;
    this.details = details;
    Object.assign(this, details);
  }
}

function fail(code, message, details = {}, cause) {
  const error = new ReceiptPackageMigrationError(code, message, details);
  if (cause !== undefined) error.cause = cause;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactJsonEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function appendError(errors, key, code) {
  if (!errors.has(key)) errors.set(key, new Set());
  errors.get(key).add(code);
}

function errorReport(errors) {
  return Object.fromEntries([...errors.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, codes]) => [key, [...codes].sort()]));
}

function normalizeCandidateFile(value, index) {
  const descriptor = typeof value === 'string' ? { path: value } : value;
  if (!isObject(descriptor)) fail('invalid_candidate_file', 'candidateFiles entries must be local path strings or descriptors');
  const keys = Object.keys(descriptor);
  if (!keys.every(key => ['path', 'expectedSha256'].includes(key)) || !keys.includes('path')) {
    fail('invalid_candidate_file', 'candidate file descriptor accepts only path and expectedSha256');
  }
  if (typeof descriptor.path !== 'string' || descriptor.path.length === 0) {
    fail('invalid_candidate_file', 'candidate file path must be a non-empty string', { candidate_index: index });
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(descriptor.path) || /^file:/i.test(descriptor.path)) {
    fail('local_candidate_file_required', 'candidate file must be a local filesystem path', { candidate_index: index });
  }
  if (!descriptor.path.toLowerCase().endsWith('.json')) {
    fail('candidate_json_file_required', 'candidate file must have a .json suffix', { candidate_index: index });
  }
  if (descriptor.expectedSha256 !== undefined
      && (typeof descriptor.expectedSha256 !== 'string' || !RECEIPT_HASH_PATTERN.test(descriptor.expectedSha256))) {
    fail('invalid_expected_candidate_sha256', 'expectedSha256 must be a lowercase SHA-256 digest', { candidate_index: index });
  }
  return { path: resolve(descriptor.path), expectedSha256: descriptor.expectedSha256 };
}

async function loadCandidateFile(descriptor, index) {
  let handle;
  let bytes;
  try {
    handle = await open(descriptor.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) fail('local_candidate_file_required', 'candidate path must name a regular local file', { candidate_index: index });
    bytes = await handle.readFile();
  } catch (error) {
    if (error instanceof ReceiptPackageMigrationError) throw error;
    fail('candidate_file_read_failed', 'candidate file could not be read', { candidate_index: index }, error);
  } finally {
    await handle?.close().catch(() => {});
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (descriptor.expectedSha256 !== undefined && digest !== descriptor.expectedSha256) {
    fail('candidate_sha256_mismatch', 'candidate file SHA-256 does not match the expected digest', {
      candidate_index: index,
      expected_sha256: descriptor.expectedSha256,
      actual_sha256: digest,
    });
  }
  let candidate;
  try {
    candidate = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail('candidate_json_invalid', 'candidate file is not valid JSON', { candidate_index: index }, error);
  }
  if (Array.isArray(candidate)) {
    fail('candidate_json_invalid', 'each candidate file must contain exactly one recovery candidate', { candidate_index: index });
  }
  return { candidate, candidateSha256: digest, index };
}

function assertCandidate(candidate) {
  if (!isObject(candidate)) fail('invalid_candidate', 'recovery candidate must be an object');
  const keys = Object.keys(candidate);
  if (keys.length !== CANDIDATE_FIELDS.length || CANDIDATE_FIELDS.some(field => !Object.hasOwn(candidate, field))) {
    fail('invalid_candidate', 'recovery candidate must contain the complete exact recovery-candidate fields');
  }
  if (!RECEIPT_HASH_PATTERN.test(candidate.receipt_hash)) fail('malformed_receipt_hash', 'candidate receipt_hash is malformed');
  if (candidate.recovery_method !== 'hash_matched_regeneration'
      && candidate.recovery_method !== 'retained_canonical_receipt') {
    fail('invalid_recovery_method', 'candidate recovery_method is not an accepted recovery method');
  }
  validateCanonicalReceiptInputV1(candidate.canonical_receipt);
  validateVerificationResultV1(candidate.verification_result);
  if (candidate.canonical_receipt.receipt_hash !== candidate.receipt_hash) {
    fail('candidate_receipt_hash_mismatch', 'canonical receipt hash must equal candidate receipt hash');
  }
  if (candidate.verification_result.receipt_hash !== candidate.receipt_hash) {
    fail('verification_receipt_hash_mismatch', 'verification receipt hash must equal candidate receipt hash');
  }
}

function assertVerification(candidate) {
  const deterministic = verifyReceipt(candidate.canonical_receipt);
  if (deterministic.recomputed_hash !== candidate.receipt_hash || !deterministic.hash_valid) {
    fail('published_receipt_hash_mismatch', 'candidate does not exactly reproduce the published receipt hash');
  }
  if (!deterministic.schema_valid || !deterministic.consistency_valid || !deterministic.pass
      || deterministic.rule_violations.length !== 0) {
    fail('deterministic_verification_failed', 'deterministic verifyReceipt() did not pass every gate with zero violations');
  }
  if (!exactJsonEqual(deterministic, candidate.verification_result)) {
    fail('verification_result_mismatch', 'persisted verifier result differs from deterministic verifyReceipt()');
  }
  return deterministic;
}

function assertArchiveOverlap(canonical, archiveBundle) {
  for (const record of [archiveBundle.canonical_receipt_record, archiveBundle.inventory_record]) {
    for (const [field, archivedValue] of Object.entries(record)) {
      if (!Object.hasOwn(canonical, field)) continue;
      if (!exactJsonEqual(canonical[field], archivedValue)) {
        fail('archive_overlap_mismatch', `candidate field differs from validated archive field: ${field}`, { field });
      }
    }
  }
}

function assertEconomicsCompatibility(candidate, validatedEconomics) {
  const canonical = candidate.canonical_receipt;
  if (validatedEconomics.sidecar.provenance.recovery_method !== candidate.recovery_method) {
    fail(
      'economics_recovery_method_mismatch',
      'candidate recovery method differs from validated economics provenance',
    );
  }
  for (const [field, value] of Object.entries(validatedEconomics.economics)) {
    if (!Object.hasOwn(canonical, field) || !exactJsonEqual(canonical[field], value)) {
      fail('economics_compatibility_mismatch', `candidate field differs from validated economics field: ${field}`, { field });
    }
  }
  if (!exactJsonEqual(validatedEconomics.verification, verifyReceipt(canonical))) {
    fail('economics_verification_mismatch', 'validated economics verifier output differs from the candidate receipt');
  }
}

function project(source, fields) {
  return Object.fromEntries(fields.map(field => [field, structuredClone(source[field])]));
}

function packageHashes(receiptPackage) {
  const memberHashes = Object.fromEntries([
    ...CONTENT_MEMBER_NAMES.map(name => [name, receiptPackage['manifest.json'].members[name].sha256]),
    ['manifest.json', sha256CanonicalJson(receiptPackage['manifest.json'])],
  ].sort(([left], [right]) => compareText(left, right)));
  return {
    packageDigest: receiptPackage['manifest.json'].package_digest,
    memberHashes,
  };
}

function mapCompatibilityReadError(error, store) {
  if (error?.code === 'ENOENT') return store === 'archive' ? 'missing_archive_record' : 'missing_economics_record';
  if (store === 'economics' && error instanceof ReceiptEconomicsError) {
    if (error.code === 'missing_archive_bundle') return 'missing_archive_record';
    if (error.code === 'missing_economics_sidecar') return 'missing_economics_record';
    if (error.code === 'corrupt_economics_sidecar') return 'corrupt_economics_record';
    return error.code === 'invalid_archive_bundle' ? 'corrupt_archive_record' : 'corrupt_economics_record';
  }
  return store === 'archive' ? 'corrupt_archive_record' : 'corrupt_economics_record';
}

function buildPackage(candidate, archiveBundle, validatedEconomics, deterministicVerification) {
  assertArchiveOverlap(candidate.canonical_receipt, archiveBundle);
  assertEconomicsCompatibility(candidate, validatedEconomics);
  const archiveRecord = {
    archive_record_version: ARCHIVE_RECORD_VERSION,
    ...project(candidate.canonical_receipt, ARCHIVE_FIELDS),
  };
  const economicsRecord = {
    economics_version: ECONOMICS_VERSION,
    receipt_hash: candidate.receipt_hash,
    receipt_version: candidate.canonical_receipt.receipt_version,
    receipt_type: candidate.canonical_receipt.receipt_type,
    ...project(candidate.canonical_receipt, ECONOMICS_FIELDS),
  };
  return buildReceiptPackageV1({
    canonicalReceipt: candidate.canonical_receipt,
    verificationResult: deterministicVerification,
    archiveRecord,
    economicsRecord,
    inputCommitment: {
      ...RECEIPT_PACKAGE_PROFILES_V1,
      accounting_method_version: candidate.canonical_receipt.accounting_method,
    },
  });
}

async function requirePreexistingPackageRoot(packageRoot) {
  let stat;
  try {
    stat = await lstat(packageRoot);
  } catch (error) {
    fail('package_root_must_preexist', 'write mode requires an explicit pre-existing package root', {}, error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('package_root_must_preexist', 'package root must be a pre-existing non-symlink directory');
  }
}

export async function migrateRecoveredReceiptPackagesV1({
  candidateFiles,
  archiveRoot,
  economicsRoot,
  packageRoot,
  write = false,
} = {}) {
  if (!Array.isArray(candidateFiles) || candidateFiles.length === 0) {
    fail('explicit_candidate_files_required', 'candidateFiles must be a non-empty array');
  }
  if (typeof archiveRoot !== 'string' || archiveRoot.length === 0) {
    fail('explicit_archive_root_required', 'an explicit archiveRoot is required');
  }
  if (typeof economicsRoot !== 'string' || economicsRoot.length === 0) {
    fail('explicit_economics_root_required', 'an explicit economicsRoot is required');
  }
  if (write && (typeof packageRoot !== 'string' || packageRoot.length === 0)) {
    fail('explicit_package_root_required', 'write mode requires an explicit packageRoot');
  }
  const resolvedArchiveRoot = resolve(archiveRoot);
  const resolvedEconomicsRoot = resolve(economicsRoot);
  const resolvedPackageRoot = typeof packageRoot === 'string' && packageRoot.length > 0 ? resolve(packageRoot) : undefined;
  if (write) await requirePreexistingPackageRoot(resolvedPackageRoot);

  const descriptors = candidateFiles.map(normalizeCandidateFile);
  const loaded = await Promise.all(descriptors.map(loadCandidateFile));
  const counts = new Map();
  for (const item of loaded) {
    const hash = item.candidate?.receipt_hash;
    if (typeof hash === 'string' && RECEIPT_HASH_PATTERN.test(hash)) counts.set(hash, (counts.get(hash) || 0) + 1);
  }
  const duplicates = new Set([...counts].filter(([, count]) => count !== 1).map(([hash]) => hash));
  const errors = new Map();
  const eligible = [];

  for (const item of loaded) {
    const candidate = item.candidate;
    const key = RECEIPT_HASH_PATTERN.test(candidate?.receipt_hash)
      ? candidate.receipt_hash
      : `<candidate_${String(item.index).padStart(6, '0')}>`;
    if (duplicates.has(candidate?.receipt_hash)) {
      appendError(errors, key, 'duplicate_candidate');
      continue;
    }
    try {
      assertCandidate(candidate);
      const deterministicVerification = assertVerification(candidate);
      let archiveBundle;
      try {
        archiveBundle = readReceiptArchiveBundle(candidate.receipt_hash, { archiveRoot: resolvedArchiveRoot });
      } catch (error) {
        fail(mapCompatibilityReadError(error, 'archive'), 'validated archive record could not be loaded', {}, error);
      }
      let validatedEconomics;
      try {
        validatedEconomics = readReceiptEconomics(candidate.receipt_hash, {
          archiveRoot: resolvedArchiveRoot,
          economicsRoot: resolvedEconomicsRoot,
        });
      } catch (error) {
        fail(mapCompatibilityReadError(error, 'economics'), 'validated economics record could not be loaded', {}, error);
      }
      const receiptPackage = buildPackage(candidate, archiveBundle, validatedEconomics, deterministicVerification);
      eligible.push({ receiptHash: candidate.receipt_hash, receiptPackage, ...packageHashes(receiptPackage) });
    } catch (error) {
      appendError(errors, key, error instanceof ReceiptPackageMigrationError ? error.code : (error?.code || 'candidate_rejected'));
    }
  }
  eligible.sort((left, right) => compareText(left.receiptHash, right.receiptHash));

  const store = resolvedPackageRoot ? createReceiptPackageFsStore({ root: resolvedPackageRoot }) : undefined;
  const statuses = [];
  for (const item of eligible) {
    if (!store) {
      statuses.push({ ...item, status: 'would_write' });
      continue;
    }
    let inspection;
    try {
      inspection = await store.inspect(item.receiptHash);
    } catch (error) {
      if (error instanceof ReceiptPackageStoreError) fail(error.code, 'package root inspection failed', { receipt_hash: item.receiptHash }, error);
      throw error;
    }
    if (inspection.status === 'absent') statuses.push({ ...item, status: 'would_write' });
    else if (inspection.package_digest === item.packageDigest) statuses.push({ ...item, status: 'unchanged' });
    else {
      statuses.push({ ...item, status: 'conflict' });
      appendError(errors, item.receiptHash, 'package_store_conflict');
    }
  }

  const summary = {
    mode: write ? 'write' : 'dry-run',
    candidates_discovered: loaded.length,
    eligible: eligible.length,
    rejected: loaded.length - eligible.length,
    would_write: write ? 0 : statuses.filter(item => item.status === 'would_write').length,
    committed: 0,
    unchanged: statuses.filter(item => item.status === 'unchanged').length,
    conflicts: statuses.filter(item => item.status === 'conflict').length,
    receipt_hashes: eligible.map(item => item.receiptHash),
    package_digests: Object.fromEntries(eligible.map(item => [item.receiptHash, item.packageDigest])),
    member_hashes: Object.fromEntries(eligible.map(item => [item.receiptHash, item.memberHashes])),
    error_codes_by_candidate: errorReport(errors),
  };
  if (!write || summary.rejected > 0 || summary.conflicts > 0) return summary;

  const stagedEntries = [];
  async function abortActiveStages(entries) {
    for (const entry of [...entries].reverse()) {
      if (entry.finalized) continue;
      try {
        await store.abort(entry.staged.stagingHandle);
        entry.finalized = true;
      } catch (error) {
        appendError(errors, entry.item.receiptHash, error?.code || 'abort_failed');
      }
    }
  }
  const pending = statuses.filter(entry => entry.status === 'would_write');
  for (const item of pending) {
    try {
      const staged = await store.stage(item.receiptPackage);
      const entry = { item, staged, finalized: false };
      stagedEntries.push(entry);
      await store.validateStage(staged.stagingHandle);
    } catch (error) {
      appendError(errors, item.receiptHash, error?.code || 'package_staging_failed');
      await abortActiveStages(stagedEntries);
      summary.error_codes_by_candidate = errorReport(errors);
      return summary;
    }
  }

  for (const entry of stagedEntries) {
    const { item, staged } = entry;
    let result;
    try {
      result = await store.commit(staged.stagingHandle, { expectedPackageDigest: item.packageDigest });
      entry.finalized = true;
    } catch (error) {
      if (error instanceof ReceiptPackageStoreError && error.code === 'commit_unknown') {
        try {
          const reconciled = await store.inspect(item.receiptHash);
          if (reconciled.status === 'committed' && reconciled.package_digest === item.packageDigest) {
            result = reconciled;
            entry.finalized = true;
          }
        } catch {
          // Preserve commit_unknown as the deterministic reconciliation result below.
        }
      }
      if (!result) {
        const code = error?.code || 'package_publication_failed';
        appendError(errors, item.receiptHash, code);
        if (code === 'package_store_conflict') summary.conflicts += 1;
        await abortActiveStages(stagedEntries);
        summary.error_codes_by_candidate = errorReport(errors);
        return summary;
      }
    }
    if (result.status === 'committed') summary.committed += 1;
    else if (result.status === 'unchanged') summary.unchanged += 1;
  }
  summary.error_codes_by_candidate = errorReport(errors);
  return summary;
}

function parseArgs(argv) {
  const args = { candidateFiles: [], write: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--candidates') args.candidateFiles.push(argv[++index]);
    else if (arg === '--archive-root') args.archiveRoot = argv[++index];
    else if (arg === '--economics-root') args.economicsRoot = argv[++index];
    else if (arg === '--package-root') args.packageRoot = argv[++index];
    else fail('invalid_argument', `unsupported argument: ${arg}`);
  }
  return args;
}

function usage(stdout) {
  stdout.write([
    'Usage: node engine/src/receipt-package/migrate-recovered-packages.mjs --candidates <file> [--candidates <file> ...] --archive-root <path> --economics-root <path>',
    '       node engine/src/receipt-package/migrate-recovered-packages.mjs --candidates <file> [--candidates <file> ...] --archive-root <path> --economics-root <path> --write --package-root <explicit-pre-existing-path>',
    '',
    'Dry-run is the default. Inputs are local recovery-candidate JSON files only.',
    'The tool performs no acquisition, network, archive/economics mutation, inventory integration, upload, mint, or signing.',
    '',
  ].join('\n'));
}

export async function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      usage(stdout);
      return 0;
    }
    const summary = await migrateRecoveredReceiptPackagesV1(args);
    stdout.write(canonicalJson(summary));
    return summary.rejected === 0
      && summary.conflicts === 0
      && Object.keys(summary.error_codes_by_candidate).length === 0 ? 0 : 1;
  } catch (error) {
    const code = error instanceof ReceiptPackageMigrationError ? error.code : 'receipt_package_migration_failed';
    stderr.write(`receipt_package_migration_failed: ${code}\n`);
    return ['invalid_argument', 'explicit_candidate_files_required', 'explicit_archive_root_required', 'explicit_economics_root_required', 'explicit_package_root_required'].includes(code) ? 2 : 1;
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) process.exit(await main());
