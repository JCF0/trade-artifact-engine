#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import {
  buildReceiptEconomicsSidecar,
  getReceiptEconomicsPaths,
  rebuildReceiptEconomicsIndex,
  serializeReceiptEconomicsSidecar,
  writeReceiptEconomicsSidecar,
  ReceiptEconomicsError,
} from './receipt-economics-store.mjs';
import { readReceiptArchiveBundle } from './archive-store.mjs';
import {
  DEFAULT_ENGINE_ROOT,
  scanV12ReceiptArtifacts,
} from './scanner.mjs';

const VERIFICATION_GATE_FIELDS = [
  ['hash_valid', true],
  ['schema_valid', true],
  ['consistency_valid', true],
  ['pass', true],
];

function economicsError(code, message, details = {}) {
  return new ReceiptEconomicsError(code, message, details);
}

function assertCurrentReceiptGate(canonicalReceipt, verificationResult) {
  if (!canonicalReceipt || typeof canonicalReceipt !== 'object' || Array.isArray(canonicalReceipt)) {
    throw economicsError('invalid_canonical_receipt', 'canonical receipt must be an object');
  }
  if (canonicalReceipt.receipt_type !== 'closed_position') {
    throw economicsError('receipt_type_not_eligible', 'receipt_type must be closed_position');
  }
  if (canonicalReceipt.verification_status !== 'verified') {
    throw economicsError('verification_status_not_eligible', 'verification_status must be verified');
  }
  if (!verificationResult || typeof verificationResult !== 'object' || Array.isArray(verificationResult)) {
    throw economicsError('missing_verification_result', 'a successful verifier result is required');
  }
  if (verificationResult.receipt_hash !== canonicalReceipt.receipt_hash) {
    throw economicsError('verification_receipt_hash_mismatch', 'verifier result receipt_hash must match the canonical receipt');
  }
  for (const [field, expected] of VERIFICATION_GATE_FIELDS) {
    if (verificationResult[field] !== expected) {
      throw economicsError('verification_gate_failed', `${field} must be true`, { gate: field });
    }
  }
  if (!Array.isArray(verificationResult.rule_violations) || verificationResult.rule_violations.length !== 0) {
    throw economicsError('verification_gate_failed', 'rule_violations must be an empty array', { gate: 'rule_violations' });
  }
}

function assertVerifierMatchesSidecar(verificationResult, sidecar) {
  for (const field of ['recomputed_hash', 'hash_valid', 'schema_valid', 'consistency_valid', 'pass', 'rule_violations']) {
    const expected = JSON.stringify(sidecar.verification[field]);
    const actual = JSON.stringify(verificationResult[field]);
    if (actual !== expected) {
      throw economicsError('verification_result_mismatch', `persisted verifier field does not match deterministic verification: ${field}`, { field });
    }
  }
}

export function buildCurrentReceiptEconomicsSidecar(canonicalReceipt, {
  verificationResult,
  archiveBundle,
} = {}) {
  assertCurrentReceiptGate(canonicalReceipt, verificationResult);
  const sidecar = buildReceiptEconomicsSidecar(canonicalReceipt, {
    archiveBundle,
    recoveryMethod: 'current_canonical_import',
  });
  assertVerifierMatchesSidecar(verificationResult, sidecar);
  return sidecar;
}

function existingStatus(sidecar, options) {
  const { receiptsDir } = getReceiptEconomicsPaths(options);
  const path = resolve(receiptsDir, `${sidecar.receipt_hash}.json`);
  if (!existsSync(path)) return 'would_write';
  if (readFileSync(path, 'utf8') !== serializeReceiptEconomicsSidecar(sidecar)) {
    throw economicsError(
      'receipt_economics_conflict',
      'same receipt_hash has different economics sidecar bytes',
      { receipt_hash: sidecar.receipt_hash },
    );
  }
  return 'unchanged';
}

function countRejections(rejections) {
  const counts = {};
  for (const rejection of rejections) counts[rejection.code] = (counts[rejection.code] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function importCurrentReceiptEconomics({
  engineRoot = DEFAULT_ENGINE_ROOT,
  archiveRoot,
  economicsRoot,
  write = false,
} = {}) {
  if (write && (typeof economicsRoot !== 'string' || economicsRoot.length === 0)) {
    throw economicsError('explicit_economics_root_required', '--economics-root/--output is required with --write');
  }

  const resolvedEngineRoot = resolve(engineRoot);
  const resolvedArchiveRoot = archiveRoot ? resolve(archiveRoot) : undefined;
  const resolvedEconomicsRoot = economicsRoot ? resolve(economicsRoot) : undefined;
  const scan = scanV12ReceiptArtifacts({ engineRoot: resolvedEngineRoot });
  const receipts = [...scan.receipts].sort((a, b) => String(a?.receipt_hash || '').localeCompare(String(b?.receipt_hash || '')));
  const candidates = [];
  const rejections = [];

  for (const receipt of receipts) {
    const verificationResult = scan.verifyByHash.get(receipt?.receipt_hash);
    try {
      assertCurrentReceiptGate(receipt, verificationResult);
      const archiveBundle = readReceiptArchiveBundle(receipt.receipt_hash, {
        engineRoot: resolvedEngineRoot,
        archiveRoot: resolvedArchiveRoot,
      });
      const sidecar = buildCurrentReceiptEconomicsSidecar(receipt, {
        verificationResult,
        archiveBundle,
      });
      candidates.push(sidecar);
    } catch (error) {
      if (error instanceof ReceiptEconomicsError && [
        'receipt_type_not_eligible',
        'verification_status_not_eligible',
        'missing_verification_result',
        'verification_receipt_hash_mismatch',
        'verification_gate_failed',
        'verification_result_mismatch',
      ].includes(error.code)) {
        rejections.push({ code: error.code });
        continue;
      }
      throw error;
    }
  }

  const economicsOptions = {
    engineRoot: resolvedEngineRoot,
    archiveRoot: resolvedArchiveRoot,
    economicsRoot: resolvedEconomicsRoot,
  };
  const statuses = candidates.map(sidecar => (
    resolvedEconomicsRoot ? existingStatus(sidecar, economicsOptions) : 'would_write'
  ));

  if (!write) {
    return {
      status: 'ok',
      mode: 'dry-run',
      records_discovered: receipts.length,
      eligible: candidates.length,
      rejected: rejections.length,
      rejection_counts: countRejections(rejections),
      would_write: statuses.filter(status => status === 'would_write').length,
      unchanged: statuses.filter(status => status === 'unchanged').length,
      written: 0,
      index_receipt_count: null,
    };
  }

  let written = 0;
  let unchanged = 0;
  for (const sidecar of candidates) {
    const result = writeReceiptEconomicsSidecar(sidecar, economicsOptions);
    if (result.status === 'written') written += 1;
    if (result.status === 'unchanged') unchanged += 1;
  }

  const rebuilt = candidates.length > 0
    ? rebuildReceiptEconomicsIndex(economicsOptions)
    : null;
  return {
    status: 'ok',
    mode: 'write',
    records_discovered: receipts.length,
    eligible: candidates.length,
    rejected: rejections.length,
    rejection_counts: countRejections(rejections),
    would_write: 0,
    written,
    unchanged,
    index_receipt_count: rebuilt?.index.receipt_count ?? null,
  };
}

function parseArgs(argv) {
  const args = { write: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--engine-root') args.engineRoot = argv[++index];
    else if (arg === '--archive-root') args.archiveRoot = argv[++index];
    else if (arg === '--economics-root' || arg === '--output') args.economicsRoot = argv[++index];
    else throw economicsError('invalid_argument', `Unsupported argument: ${arg}`);
  }
  if (args.write && args.dryRun) throw economicsError('invalid_argument', '--write and --dry-run are mutually exclusive');
  return args;
}

function printUsage(stdout) {
  stdout.write([
    'Usage: node engine/src/inventory/import-current-receipt-economics.mjs [--dry-run] [--engine-root <path>] [--archive-root <path>] [--economics-root <path>]',
    '       node engine/src/inventory/import-current-receipt-economics.mjs --write --economics-root <path> [--engine-root <path>] [--archive-root <path>]',
    '',
    'Reads canonical receipts from data/debug/ledger-receipts-v12.json and verifier results from data/debug/ledger-verify-v12.json.',
    'Dry-run is the default. Writes require an explicit --economics-root (or --output).',
    'No archive writes, network, upload, mint, signing, raw-history copy, or accounting recomputation is performed.',
    '',
  ].join('\n'));
}

function formatSummary(summary) {
  return [
    `mode: ${summary.mode}`,
    `records_discovered: ${summary.records_discovered}`,
    `eligible: ${summary.eligible}`,
    `rejected: ${summary.rejected}`,
    `would_write: ${summary.would_write}`,
    `written: ${summary.written}`,
    `unchanged: ${summary.unchanged}`,
    `index_receipt_count: ${summary.index_receipt_count ?? 'not_written'}`,
  ].join('\n');
}

export async function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      printUsage(stdout);
      return 0;
    }
    const summary = importCurrentReceiptEconomics(args);
    stdout.write(`${formatSummary(summary)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ReceiptEconomicsError ? error.code : 'receipt_economics_import_failed';
    stderr.write(`receipt_economics_import_failed: ${code}\n`);
    return code === 'invalid_argument' ? 2 : 1;
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) process.exit(await main());
