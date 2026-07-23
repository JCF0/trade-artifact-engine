#!/usr/bin/env node

import { createHash, randomUUID } from 'crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, resolve } from 'path';
import { pathToFileURL } from 'url';

import {
  buildReceiptEconomicsIndex,
  buildReceiptEconomicsSidecar,
  getReceiptEconomicsPaths,
  listReceiptEconomicsSidecarFiles,
  readReceiptEconomics,
  rebuildReceiptEconomicsIndex,
  serializeReceiptEconomicsSidecar,
  writeReceiptEconomicsSidecar,
  ReceiptEconomicsError,
} from './receipt-economics-store.mjs';
import {
  readReceiptArchiveBundle,
  stableJson,
} from './archive-store.mjs';
import { verifyReceipt } from '../ledger/receipt-verifier.mjs';

const RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const RECOVERY_METHODS = new Set([
  'retained_canonical_receipt',
  'hash_matched_regeneration',
]);
const VERIFIER_GATE_FIELDS = [
  'hash_valid',
  'schema_valid',
  'consistency_valid',
  'pass',
];

function economicsError(code, message, details = {}) {
  return new ReceiptEconomicsError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function candidateKey(candidate, index) {
  return typeof candidate?.receipt_hash === 'string'
    ? candidate.receipt_hash
    : `<candidate_${String(index).padStart(6, '0')}>`;
}

function appendError(errors, key, code) {
  if (!errors.has(key)) errors.set(key, new Set());
  errors.get(key).add(code);
}

function errorObject(errors) {
  return Object.fromEntries(
    [...errors.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, codes]) => [key, [...codes].sort()]),
  );
}

function assertCandidateGate(candidate) {
  if (!isPlainObject(candidate)) {
    throw economicsError('invalid_candidate', 'candidate must be an object');
  }
  if (!RECEIPT_HASH_PATTERN.test(candidate.receipt_hash)) {
    throw economicsError('malformed_receipt_hash', 'receipt_hash must be a 64-character lowercase hex string');
  }
  if (!RECOVERY_METHODS.has(candidate.recovery_method)) {
    throw economicsError('invalid_recovery_method', `unsupported recovery method: ${candidate.recovery_method}`);
  }
  if (!isPlainObject(candidate.canonical_receipt)) {
    throw economicsError('invalid_canonical_receipt', 'canonical_receipt must be an object');
  }
  if (candidate.canonical_receipt.receipt_type !== 'closed_position') {
    throw economicsError('receipt_type_not_eligible', 'receipt_type must be closed_position');
  }
  if (candidate.canonical_receipt.verification_status !== 'verified') {
    throw economicsError('verification_status_not_eligible', 'verification_status must be verified');
  }
  if (candidate.canonical_receipt.receipt_hash !== candidate.receipt_hash) {
    throw economicsError('candidate_receipt_hash_mismatch', 'canonical_receipt.receipt_hash must equal candidate receipt_hash');
  }
  if (!isPlainObject(candidate.verification_result)) {
    throw economicsError('missing_verification_result', 'persisted verification_result must be an object');
  }
  if (candidate.verification_result.receipt_hash !== candidate.receipt_hash) {
    throw economicsError('verification_receipt_hash_mismatch', 'verification_result.receipt_hash must equal candidate receipt_hash');
  }
  for (const field of VERIFIER_GATE_FIELDS) {
    if (candidate.verification_result[field] !== true) {
      throw economicsError('verification_gate_failed', `${field} must be true`, { gate: field });
    }
  }
  if (!Array.isArray(candidate.verification_result.rule_violations)
      || candidate.verification_result.rule_violations.length !== 0) {
    throw economicsError('verification_gate_failed', 'rule_violations must be an empty array', { gate: 'rule_violations' });
  }
}

function assertArchiveOverlap(canonicalReceipt, archiveBundle) {
  if (archiveBundle.receipt_hash !== canonicalReceipt.receipt_hash) {
    throw economicsError('archive_hash_mismatch', 'archive hash must equal candidate receipt hash');
  }
  for (const [field, archivedValue] of Object.entries(archiveBundle.canonical_receipt_record)) {
    if (!Object.hasOwn(canonicalReceipt, field)
        || stableJson(canonicalReceipt[field]) !== stableJson(archivedValue)) {
      throw economicsError('archive_overlap_mismatch', `candidate field does not match archive: ${field}`, { field });
    }
  }
}

function buildRecoverySidecar(candidate, archiveBundle) {
  assertCandidateGate(candidate);
  assertArchiveOverlap(candidate.canonical_receipt, archiveBundle);

  const deterministicVerification = verifyReceipt(candidate.canonical_receipt);
  if (!deterministicVerification.hash_valid
      || deterministicVerification.recomputed_hash !== candidate.receipt_hash) {
    throw economicsError('recomputed_receipt_hash_mismatch', 'candidate does not reproduce the exact published receipt hash', {
      recomputed_hash: deterministicVerification.recomputed_hash,
    });
  }
  if (!deterministicVerification.schema_valid
      || !deterministicVerification.consistency_valid
      || !deterministicVerification.pass
      || deterministicVerification.rule_violations.length !== 0) {
    throw economicsError('deterministic_verification_failed', 'deterministic verifyReceipt() did not pass');
  }
  if (stableJson(candidate.verification_result) !== stableJson(deterministicVerification)) {
    throw economicsError('verification_result_mismatch', 'persisted verification_result must exactly match deterministic verifyReceipt()');
  }

  return buildReceiptEconomicsSidecar(candidate.canonical_receipt, {
    archiveBundle,
    recoveryMethod: candidate.recovery_method,
  });
}

function inspectExisting(sidecar, options) {
  const { receiptsDir } = getReceiptEconomicsPaths(options);
  const path = resolve(receiptsDir, `${sidecar.receipt_hash}.json`);
  if (!existsSync(path)) return { status: 'would_write', path };
  if (readFileSync(path, 'utf8') !== serializeReceiptEconomicsSidecar(sidecar)) {
    return { status: 'conflict', path };
  }
  return { status: 'unchanged', path };
}

function restoreIndex(indexPath, existed, bytes) {
  if (existed) {
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, bytes);
  } else if (existsSync(indexPath)) {
    unlinkSync(indexPath);
  }
}

function publishStagedSidecar(sidecar, stagedPath, targetPath) {
  const proposedBytes = serializeReceiptEconomicsSidecar(sidecar);
  const identity = statSync(stagedPath);
  mkdirSync(dirname(targetPath), { recursive: true });
  try {
    linkSync(stagedPath, targetPath);
    return { status: 'written', path: targetPath, device: identity.dev, inode: identity.ino };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (readFileSync(targetPath, 'utf8') !== proposedBytes) {
      throw economicsError(
        'receipt_economics_conflict',
        'same receipt_hash has different economics sidecar bytes',
        { receipt_hash: sidecar.receipt_hash },
      );
    }
    return { status: 'unchanged', path: targetPath };
  }
}

function stillOwnsPublishedPath(publication) {
  if (!existsSync(publication.path)) return false;
  const current = statSync(publication.path);
  return current.dev === publication.device && current.ino === publication.inode;
}

function acquireRecoveryLock(economicsRoot) {
  const parent = dirname(economicsRoot);
  mkdirSync(parent, { recursive: true });
  const lockPath = resolve(parent, `.${basename(economicsRoot)}.receipt-economics-recovery.lock`);
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw economicsError(
        'receipt_economics_recovery_locked',
        'another receipt economics recovery write is already in progress for this economics root',
      );
    }
    throw error;
  }
  return lockPath;
}

function expectedEconomicsIndexBytes(options) {
  const sidecars = listReceiptEconomicsSidecarFiles(options).map(path => (
    readReceiptEconomics(basename(path, '.json'), options).sidecar
  ));
  return stableJson(buildReceiptEconomicsIndex(sidecars));
}

export function recoverReceiptEconomics({
  candidates,
  archiveRoot,
  economicsRoot,
  write = false,
} = {}) {
  if (!Array.isArray(candidates)) {
    throw economicsError('invalid_candidates', 'candidates must be an array');
  }
  if (typeof archiveRoot !== 'string' || archiveRoot.length === 0) {
    throw economicsError('explicit_archive_root_required', '--archive-root is required');
  }
  if (write && (typeof economicsRoot !== 'string' || economicsRoot.length === 0)) {
    throw economicsError('explicit_economics_root_required', '--economics-root is required with --write');
  }

  const resolvedArchiveRoot = resolve(archiveRoot);
  const resolvedEconomicsRoot = economicsRoot ? resolve(economicsRoot) : undefined;
  const economicsOptions = {
    archiveRoot: resolvedArchiveRoot,
    economicsRoot: resolvedEconomicsRoot,
  };
  const errors = new Map();
  const duplicateHashes = new Set();
  const counts = new Map();

  for (const candidate of candidates) {
    if (RECEIPT_HASH_PATTERN.test(candidate?.receipt_hash)) {
      counts.set(candidate.receipt_hash, (counts.get(candidate.receipt_hash) || 0) + 1);
    }
  }
  for (const [receiptHash, count] of counts) {
    if (count !== 1) duplicateHashes.add(receiptHash);
  }

  const eligible = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const key = candidateKey(candidate, index);
    if (duplicateHashes.has(candidate?.receipt_hash)) {
      appendError(errors, key, 'duplicate_target_candidates');
      continue;
    }
    try {
      assertCandidateGate(candidate);
      let archiveBundle;
      try {
        archiveBundle = readReceiptArchiveBundle(candidate.receipt_hash, {
          archiveRoot: resolvedArchiveRoot,
        });
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw economicsError('zero_target_matches', 'no archive-v1 receipt exists for the exact candidate hash');
        }
        throw error;
      }
      const sidecar = buildRecoverySidecar(candidate, archiveBundle);
      eligible.push({ candidate, sidecar });
    } catch (error) {
      appendError(errors, key, error instanceof ReceiptEconomicsError
        ? error.code
        : (error?.code === 'ENOENT' ? 'zero_target_matches' : 'invalid_archive_bundle'));
    }
  }

  eligible.sort((a, b) => a.sidecar.receipt_hash.localeCompare(b.sidecar.receipt_hash));
  const lockPath = write && eligible.length > 0
    ? acquireRecoveryLock(resolvedEconomicsRoot)
    : null;
  try {
    const inspected = eligible.map(item => ({
    ...item,
    existing: resolvedEconomicsRoot
      ? inspectExisting(item.sidecar, economicsOptions)
      : { status: 'would_write' },
  }));
  const conflicts = inspected.filter(item => item.existing.status === 'conflict');
  for (const item of conflicts) {
    appendError(errors, item.sidecar.receipt_hash, 'receipt_economics_conflict');
  }

  const summary = {
    status: conflicts.length > 0 ? 'conflict' : 'ok',
    mode: write ? 'write' : 'dry-run',
    candidates_discovered: candidates.length,
    eligible: eligible.length,
    rejected: candidates.length - eligible.length,
    would_write: write ? 0 : inspected.filter(item => item.existing.status === 'would_write').length,
    written: 0,
    unchanged: inspected.filter(item => item.existing.status === 'unchanged').length,
    conflicts: conflicts.length,
    error_codes_by_candidate_hash: errorObject(errors),
  };

  if (!write || conflicts.length > 0 || eligible.length === 0) return summary;

  const { indexPath } = getReceiptEconomicsPaths(economicsOptions);
  const indexExisted = existsSync(indexPath);
  const indexBytes = indexExisted ? readFileSync(indexPath) : null;
  const stagingRoot = resolve(
    dirname(resolvedEconomicsRoot),
    `.${basename(resolvedEconomicsRoot)}.recovery.${process.pid}.${randomUUID()}.tmp`,
  );
  const publications = [];
  let indexRebuildStarted = false;
  let proposedIndexBytes = null;
  try {
    for (const item of inspected) {
      writeReceiptEconomicsSidecar(item.sidecar, {
        archiveRoot: resolvedArchiveRoot,
        economicsRoot: stagingRoot,
      });
    }
    for (const item of inspected) {
      const stagedPath = resolve(stagingRoot, 'receipts', `${item.sidecar.receipt_hash}.json`);
      const result = publishStagedSidecar(item.sidecar, stagedPath, item.existing.path);
      if (result.status === 'written') publications.push(result);
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    proposedIndexBytes = expectedEconomicsIndexBytes(economicsOptions);
    indexRebuildStarted = true;
    rebuildReceiptEconomicsIndex(economicsOptions);
  } catch (error) {
    const rollbackErrors = [];
    for (const publication of publications.reverse()) {
      try {
        if (stillOwnsPublishedPath(publication)) unlinkSync(publication.path);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (indexRebuildStarted) {
      try {
        const currentIndexBytes = existsSync(indexPath) ? readFileSync(indexPath) : null;
        const indexIsOriginal = indexBytes === null
          ? currentIndexBytes === null
          : currentIndexBytes !== null && indexBytes.equals(currentIndexBytes);
        const indexIsProposed = currentIndexBytes !== null
          && currentIndexBytes.toString('utf8') === proposedIndexBytes;
        if (!indexIsOriginal && indexIsProposed) {
          restoreIndex(indexPath, indexExisted, indexBytes);
        } else if (!indexIsOriginal) {
          throw economicsError(
            'receipt_economics_index_ownership_lost',
            'index changed during recovery; refusing to overwrite bytes not owned by this invocation',
          );
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw economicsError(
        'receipt_economics_rollback_failed',
        'recovery failed and one or more rollback operations also failed',
        {
          cause_code: error?.code || error?.name || 'receipt_economics_write_failed',
          rollback_error_codes: rollbackErrors.map(item => item?.code || item?.name || 'rollback_failed').sort(),
        },
      );
    }
    throw error;
  }

    summary.written = publications.length;
    summary.unchanged = inspected.length - publications.length;
    return summary;
  } finally {
    if (lockPath) rmSync(lockPath, { recursive: true, force: true });
  }
}

export function parseCandidateBytes(bytes) {
  const text = bytes.toString('utf8').trim();
  if (text.length === 0) return [];
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw economicsError('invalid_candidates_file', 'JSON candidate input must be an array');
    return parsed;
  }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.candidates)) return parsed.candidates;
      return [parsed];
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return text.split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

export function loadCandidatesFile(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw economicsError('explicit_candidates_file_required', '--candidates is required');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || /^file:/i.test(path)) {
    throw economicsError('local_candidates_file_required', '--candidates must be a local filesystem path');
  }
  const bytes = readFileSync(resolve(path));
  return {
    candidates: parseCandidateBytes(bytes),
    input_digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

function parseArgs(argv) {
  const args = { write: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--candidates') args.candidatesPath = argv[++index];
    else if (arg === '--archive-root') args.archiveRoot = argv[++index];
    else if (arg === '--economics-root') args.economicsRoot = argv[++index];
    else throw economicsError('invalid_argument', `Unsupported argument: ${arg}`);
  }
  return args;
}

function printUsage(stdout) {
  stdout.write([
    'Usage: node engine/src/inventory/recover-receipt-economics.mjs --candidates <json-or-jsonl> --archive-root <path> [--economics-root <path>]',
    '       node engine/src/inventory/recover-receipt-economics.mjs --candidates <json-or-jsonl> --archive-root <path> --write --economics-root <path>',
    '',
    'Dry-run is the default. Candidate input must be a local JSON or JSONL file.',
    'Writes require an explicit --economics-root. No pipeline, network, upload, mint, or signing operation is performed.',
    '',
  ].join('\n'));
}

function formatSummary(summary, inputDigest) {
  return [
    `mode: ${summary.mode}`,
    `input_digest: ${inputDigest}`,
    `candidates_discovered: ${summary.candidates_discovered}`,
    `eligible: ${summary.eligible}`,
    `rejected: ${summary.rejected}`,
    `would_write: ${summary.would_write}`,
    `written: ${summary.written}`,
    `unchanged: ${summary.unchanged}`,
    `conflicts: ${summary.conflicts}`,
    `error_codes_by_candidate_hash: ${JSON.stringify(summary.error_codes_by_candidate_hash)}`,
  ].join('\n');
}

export async function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      printUsage(stdout);
      return 0;
    }
    const loaded = loadCandidatesFile(args.candidatesPath);
    const summary = recoverReceiptEconomics({
      candidates: loaded.candidates,
      archiveRoot: args.archiveRoot,
      economicsRoot: args.economicsRoot,
      write: args.write,
    });
    stdout.write(`${formatSummary(summary, loaded.input_digest)}\n`);
    return summary.conflicts > 0 ? 1 : 0;
  } catch (error) {
    const code = error instanceof ReceiptEconomicsError ? error.code : 'receipt_economics_recovery_failed';
    stderr.write(`receipt_economics_recovery_failed: ${code}\n`);
    return ['invalid_argument', 'explicit_candidates_file_required'].includes(code) ? 2 : 1;
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) process.exit(await main());
