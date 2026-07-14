#!/usr/bin/env node

import { existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { buildInventorySnapshot } from './inventory.mjs';
import {
  buildReceiptArchiveBundle,
  getReceiptArchivePaths,
  readReceiptArchiveBundle,
  rebuildReceiptArchiveIndex,
  stableJson,
  validateReceiptArchiveBundle,
  writeReceiptArchiveBundle,
  ReceiptArchiveError,
} from './archive-store.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    engineRoot: undefined,
    archiveRoot: undefined,
    runLabel: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--engine-root') {
      args.engineRoot = resolve(argv[++index] || '');
    } else if (arg === '--archive-root') {
      args.archiveRoot = resolve(argv[++index] || '');
    } else if (arg === '--run-label') {
      args.runLabel = argv[++index] || null;
    } else {
      throw new ReceiptArchiveError('invalid_argument', `Unsupported argument: ${arg}`);
    }
  }

  return args;
}

function printUsage(stdout = process.stdout) {
  stdout.write([
    'Usage: node engine/src/inventory/archive-current-run.mjs [--engine-root <path>] [--archive-root <path>] [--run-label <label>]',
    '',
    'Imports the current fixed v1.2 debug inventory snapshot into the local receipt archive.',
    'No network, upload, mint, signing, raw-history copy, manifest edit, or board integration is performed.',
    '',
  ].join('\n'));
}

function isV12InventoryRecord(record) {
  return typeof record?.receipt_hash === 'string'
    && typeof record?.receipt_version === 'string'
    && record.receipt_version.startsWith('1.2');
}

function bundlePathExists(bundle, options) {
  const { receiptsDir } = getReceiptArchivePaths(options);
  return existsSync(resolve(receiptsDir, `${bundle.receipt_hash}.json`));
}

function compareBundles(existing, next) {
  if (stableJson(existing.canonical_receipt_record) !== stableJson(next.canonical_receipt_record)) {
    throw new ReceiptArchiveError('receipt_hash_conflict', 'same receipt_hash has a different canonical receipt record', { receipt_hash: next.receipt_hash });
  }
  if (stableJson(existing) !== stableJson(next)) {
    throw new ReceiptArchiveError('receipt_archive_bundle_conflict', 'same receipt_hash has different archived non-canonical data; conflicts are not resolved silently', { receipt_hash: next.receipt_hash });
  }
}

function prebuildBundles(records) {
  const byHash = new Map();
  const bundles = [];

  for (const record of records) {
    const bundle = buildReceiptArchiveBundle(record, {
      provenance: {
        source: 'current_v12_debug_snapshot',
      },
    });
    validateReceiptArchiveBundle(bundle);

    const previous = byHash.get(bundle.receipt_hash);
    if (previous) {
      if (stableJson(previous) !== stableJson(bundle)) {
        throw new ReceiptArchiveError('duplicate_receipt_hash_in_current_snapshot', 'current snapshot contains conflicting duplicate receipt_hash records', { receipt_hash: bundle.receipt_hash });
      }
      continue;
    }

    byHash.set(bundle.receipt_hash, bundle);
    bundles.push(bundle);
  }

  return bundles.sort((a, b) => a.receipt_hash.localeCompare(b.receipt_hash));
}

function preflightExistingArchive(bundles, options) {
  for (const bundle of bundles) {
    if (!bundlePathExists(bundle, options)) continue;
    const existing = readReceiptArchiveBundle(bundle.receipt_hash, options);
    compareBundles(existing, bundle);
  }
}

export function importCurrentRunToReceiptArchive(options = {}) {
  const engineRoot = options.engineRoot ? resolve(options.engineRoot) : undefined;
  const archiveRoot = options.archiveRoot ? resolve(options.archiveRoot) : undefined;
  const archiveOptions = { engineRoot, archiveRoot };

  const snapshot = buildInventorySnapshot({
    engineRoot,
    includeLegacy: false,
    includeExcluded: false,
  });

  const allRecords = Array.isArray(snapshot.receipts) ? snapshot.receipts : [];
  const records = allRecords.filter(isV12InventoryRecord);
  const ignoredNonV12 = allRecords.length - records.length;
  const bundles = prebuildBundles(records);

  preflightExistingArchive(bundles, archiveOptions);

  let imported = 0;
  let unchanged = 0;
  let failed = 0;
  const warnings = [];

  for (const bundle of bundles) {
    try {
      const result = writeReceiptArchiveBundle(bundle, archiveOptions);
      if (result.status === 'written') imported += 1;
      if (result.status === 'unchanged') unchanged += 1;
      warnings.push(...(Array.isArray(result.warnings) ? result.warnings : []));
    } catch (error) {
      failed += 1;
      throw error;
    }
  }

  const rebuilt = rebuildReceiptArchiveIndex(archiveOptions);

  return {
    status: 'ok',
    records_discovered: records.length,
    ignored_non_v12: ignoredNonV12,
    imported,
    unchanged,
    failed,
    index_receipt_count: rebuilt.index.receipt_count,
    warnings: dedupeWarnings(warnings),
  };
}

function dedupeWarnings(warnings) {
  const unique = new Map();
  for (const warning of warnings) {
    unique.set(stableJson(warning), warning);
  }
  return [...unique.values()].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

function formatSummary(summary) {
  return [
    `records_discovered: ${summary.records_discovered}`,
    `imported: ${summary.imported}`,
    `unchanged: ${summary.unchanged}`,
    `failed: ${summary.failed}`,
    `index_receipt_count: ${summary.index_receipt_count}`,
    `ignored_non_v12: ${summary.ignored_non_v12}`,
    `warnings: ${summary.warnings.length}`,
  ].join('\n');
}

export async function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      printUsage(stdout);
      return 0;
    }

    const summary = importCurrentRunToReceiptArchive({
      engineRoot: args.engineRoot,
      archiveRoot: args.archiveRoot,
      runLabel: args.runLabel,
    });
    stdout.write(`${formatSummary(summary)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ReceiptArchiveError ? error.code : 'archive_import_failed';
    stderr.write(`archive_current_run_failed: ${code}\n`);
    return error instanceof ReceiptArchiveError && error.code === 'invalid_argument' ? 2 : 1;
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exit(await main());
}
