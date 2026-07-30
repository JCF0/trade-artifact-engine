#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildReceiptArchiveIndex,
  readReceiptArchiveBundlesWithDiagnostics,
  rebuildReceiptArchiveIndex,
  stableJson,
  writeReceiptArchiveBundle,
} from './archive-store.mjs';
import { readReceiptPackageInventory } from './package-inventory.mjs';
import {
  buildReceiptEconomicsIndex,
  listReceiptEconomicsSidecarFiles,
  rebuildReceiptEconomicsIndex,
  serializeReceiptEconomicsSidecar,
  validateReceiptEconomicsSidecar,
  writeReceiptEconomicsSidecar,
} from './receipt-economics-store.mjs';
import {
  buildArchiveV1CompatibilityBundleFromPackage,
  buildEconomicsV1CompatibilitySidecarFromPackage,
  ReceiptCompatibilityProjectionError,
} from './receipt-compatibility-projections.mjs';

export {
  buildArchiveV1CompatibilityBundleFromPackage,
  buildEconomicsV1CompatibilitySidecarFromPackage,
  ReceiptCompatibilityProjectionError,
} from './receipt-compatibility-projections.mjs';

function fail(code, message, details = {}, cause) {
  throw new ReceiptCompatibilityProjectionError(code, message, details, cause);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function requireExplicitRoot(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('compatibility_conflict', `an explicit ${label} is required`);
  }
  try {
    return await realpath(resolve(value));
  } catch (cause) {
    fail('compatibility_conflict', `${label} must resolve to a pre-existing root`, {}, cause);
  }
}

async function requireEmptyOutputRoot(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('explicit_output_root_required', `write mode requires an explicit ${label}`);
  }
  const root = resolve(value);
  let stat;
  try {
    stat = await lstat(root);
  } catch (cause) {
    fail('explicit_output_root_required', `${label} must be a pre-existing directory`, {}, cause);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('explicit_output_root_required', `${label} must be a pre-existing non-symlink directory`);
  }
  if ((await readdir(root)).length !== 0) {
    fail('output_root_not_empty', `${label} must be empty`, { root });
  }
  return realpath(root);
}

function pathsOverlap(left, right) {
  const rel = relative(left, right);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function assertOutputIsolation(outputs, inputs) {
  if (outputs.archive === outputs.economics
      || pathsOverlap(outputs.archive, outputs.economics)
      || pathsOverlap(outputs.economics, outputs.archive)) {
    fail('compatibility_conflict', 'archive and economics output roots must be distinct non-overlapping directories');
  }
  for (const output of Object.values(outputs)) {
    for (const input of Object.values(inputs)) {
      if (pathsOverlap(output, input) || pathsOverlap(input, output)) {
        fail('compatibility_conflict', 'output roots must not overlap source roots', { output_root: output });
      }
    }
  }
}

async function readEconomicsSidecars(archivesByHash, economicsRoot) {
  const sidecars = [];
  for (const path of listReceiptEconomicsSidecarFiles({ economicsRoot })) {
    const receiptHash = basename(path, '.json');
    try {
      const sidecar = JSON.parse(await readFile(path, 'utf8'));
      sidecars.push(validateReceiptEconomicsSidecar(sidecar, {
        receiptHash,
        archiveBundle: archivesByHash.get(receiptHash),
      }).sidecar);
    } catch (cause) {
      fail('legacy_economics_invalid', 'legacy economics-v1 record failed validation', {
        receipt_hash: receiptHash,
        economics_error_code: cause?.code || 'legacy_economics_read_failed',
      }, cause);
    }
  }
  return sidecars;
}

async function buildProjectionSet(inputs) {
  const packageRead = await readReceiptPackageInventory({ packageRoot: inputs.package });
  if (packageRead.diagnostics.length > 0) {
    const diagnostic = packageRead.diagnostics[0];
    fail('package_projection_invalid', 'authoritative package store contains an invalid package', {
      receipt_hash: diagnostic.receipt_hash,
      package_error_code: diagnostic.reason,
    });
  }

  const legacyArchiveRead = readReceiptArchiveBundlesWithDiagnostics({ archiveRoot: inputs.archive });
  if (legacyArchiveRead.diagnostics.length > 0) {
    const diagnostic = legacyArchiveRead.diagnostics[0];
    fail('legacy_archive_invalid', 'legacy archive-v1 record failed validation', {
      path: diagnostic.path,
      archive_error_code: diagnostic.code,
    });
  }
  const archivesByHash = new Map(legacyArchiveRead.bundles.map(bundle => [bundle.receipt_hash, bundle]));
  const packageHashes = new Set();
  const projectedEconomicsByHash = new Map();

  for (const entry of packageRead.entries) {
    const receiptHash = entry.receipt_hash;
    if (packageHashes.has(receiptHash)) {
      fail('compatibility_conflict', 'multiple authoritative packages have the same receipt hash', { receipt_hash: receiptHash });
    }
    packageHashes.add(receiptHash);
    const archive = buildArchiveV1CompatibilityBundleFromPackage(entry.receipt_package);
    const economics = buildEconomicsV1CompatibilitySidecarFromPackage(entry.receipt_package);
    const existingArchive = archivesByHash.get(receiptHash);
    if (existingArchive && stableJson(existingArchive) !== stableJson(archive)) {
      fail('package_archive_projection_mismatch', 'package-derived archive-v1 bytes differ from existing compatibility bytes', {
        receipt_hash: receiptHash,
      });
    }
    archivesByHash.set(receiptHash, archive);
    projectedEconomicsByHash.set(receiptHash, economics);
  }

  const legacyEconomics = await readEconomicsSidecars(archivesByHash, inputs.economics);
  const economicsByHash = new Map(legacyEconomics.map(sidecar => [sidecar.receipt_hash, sidecar]));
  for (const [receiptHash, economics] of projectedEconomicsByHash) {
    const existingEconomics = economicsByHash.get(receiptHash);
    if (existingEconomics
        && serializeReceiptEconomicsSidecar(existingEconomics) !== serializeReceiptEconomicsSidecar(economics)) {
      fail('package_economics_projection_mismatch', 'package-derived economics-v1 bytes differ from existing compatibility bytes', {
        receipt_hash: receiptHash,
      });
    }
    economicsByHash.set(receiptHash, economics);
  }

  for (const sidecar of economicsByHash.values()) {
    if (!archivesByHash.has(sidecar.receipt_hash)) {
      fail('legacy_economics_invalid', 'economics-v1 record has no validated archive-v1 record', {
        receipt_hash: sidecar.receipt_hash,
      });
    }
  }

  const archives = [...archivesByHash.values()].sort((a, b) => compareText(a.receipt_hash, b.receipt_hash));
  const economics = [...economicsByHash.values()].sort((a, b) => compareText(a.receipt_hash, b.receipt_hash));
  const legacyArchiveBytesByHash = new Map();
  for (const bundle of legacyArchiveRead.bundles) {
    if (!packageHashes.has(bundle.receipt_hash)) {
      legacyArchiveBytesByHash.set(
        bundle.receipt_hash,
        await readFile(join(inputs.archive, 'receipts', `${bundle.receipt_hash}.json`)),
      );
    }
  }
  return {
    archives,
    economics,
    packageHashes,
    legacyArchiveBytesByHash,
    legacyFallback: archives.filter(bundle => !packageHashes.has(bundle.receipt_hash)).length,
  };
}

async function filesDigest(root) {
  const files = [];
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => compareText(a.name, b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else files.push([relative(root, child).split('\\').join('/'), await readFile(child)]);
    }
  }
  await walk(root);
  const hash = createHash('sha256');
  for (const [path, bytes] of files) hash.update(path).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}

async function stageTrees(projections, outputRoots) {
  const token = randomUUID();
  const stages = {
    archive: join(dirname(outputRoots.archive), `.${basename(outputRoots.archive)}.${token}.tmp`),
    economics: join(dirname(outputRoots.economics), `.${basename(outputRoots.economics)}.${token}.tmp`),
  };
  try {
    await mkdir(stages.archive, { mode: 0o700 });
    await mkdir(stages.economics, { mode: 0o700 });
    await mkdir(join(stages.archive, 'receipts'));
    for (const bundle of projections.archives) {
      const legacyBytes = projections.legacyArchiveBytesByHash.get(bundle.receipt_hash);
      if (legacyBytes) {
        await writeFile(join(stages.archive, 'receipts', `${bundle.receipt_hash}.json`), legacyBytes);
      } else {
        writeReceiptArchiveBundle(bundle, { archiveRoot: stages.archive });
      }
    }
    rebuildReceiptArchiveIndex({ archiveRoot: stages.archive });
    for (const sidecar of projections.economics) {
      writeReceiptEconomicsSidecar(sidecar, {
        receiptHash: sidecar.receipt_hash,
        archiveRoot: stages.archive,
        economicsRoot: stages.economics,
      });
    }
    rebuildReceiptEconomicsIndex({ archiveRoot: stages.archive, economicsRoot: stages.economics });

    const stagedArchives = readReceiptArchiveBundlesWithDiagnostics({ archiveRoot: stages.archive });
    if (stagedArchives.diagnostics.length > 0
        || stableJson(stagedArchives.bundles) !== stableJson(projections.archives)) {
      throw new Error('staged archive tree failed complete readback');
    }
    const stagedArchiveMap = new Map(stagedArchives.bundles.map(bundle => [bundle.receipt_hash, bundle]));
    const stagedEconomics = await readEconomicsSidecars(stagedArchiveMap, stages.economics);
    const expectedArchiveIndex = stableJson(buildReceiptArchiveIndex(projections.archives));
    const expectedEconomicsIndex = serializeReceiptEconomicsSidecar(buildReceiptEconomicsIndex(projections.economics));
    if (await readFile(join(stages.archive, 'index.json'), 'utf8') !== expectedArchiveIndex) {
      throw new Error('staged archive index failed complete readback');
    }
    for (const [receiptHash, expectedBytes] of projections.legacyArchiveBytesByHash) {
      const actualBytes = await readFile(join(stages.archive, 'receipts', `${receiptHash}.json`));
      if (!actualBytes.equals(expectedBytes)) throw new Error(`staged legacy archive bytes changed: ${receiptHash}`);
    }
    for (const sidecar of projections.economics) {
      const actualBytes = await readFile(join(stages.economics, 'receipts', `${sidecar.receipt_hash}.json`), 'utf8');
      if (actualBytes !== serializeReceiptEconomicsSidecar(sidecar)) {
        throw new Error(`staged economics sidecar bytes changed: ${sidecar.receipt_hash}`);
      }
    }
    if (await readFile(join(stages.economics, 'index.json'), 'utf8') !== expectedEconomicsIndex
        || serializeReceiptEconomicsSidecar(buildReceiptEconomicsIndex(stagedEconomics)) !== expectedEconomicsIndex) {
      throw new Error('staged economics tree failed complete readback');
    }
    return {
      stages,
      treeHashes: {
        archive: await filesDigest(stages.archive),
        economics: await filesDigest(stages.economics),
      },
    };
  } catch (cause) {
    await Promise.all(Object.values(stages).map(path => rm(path, { recursive: true, force: true })));
    fail('compatibility_publication_failed', 'compatibility trees could not be staged and validated', {}, cause);
  }
}

async function publishTrees(stages, outputs) {
  let archivePublished = false;
  try {
    await rename(stages.archive, outputs.archive);
    archivePublished = true;
    await rename(stages.economics, outputs.economics);
  } catch (cause) {
    const rollbackErrors = [];
    if (archivePublished) {
      try {
        await rename(outputs.archive, stages.archive);
        await mkdir(outputs.archive);
        if ((await readdir(outputs.archive)).length !== 0) throw new Error('restored archive output root is not empty');
      } catch (rollbackCause) {
        rollbackErrors.push(rollbackCause);
      }
    }
    if (rollbackErrors.length === 0) {
      await Promise.all(Object.values(stages).map(path => rm(path, { recursive: true, force: true })));
    }
    fail('compatibility_publication_failed', 'atomic compatibility-tree publication failed', {
      partial_publication: rollbackErrors.length > 0,
      rollback_errors: rollbackErrors.map(error => error?.message || String(error)),
    }, cause);
  }
}

export async function rebuildReceiptCompatibilityViewsV1({
  packageRoot,
  legacyArchiveRoot,
  legacyEconomicsRoot,
  outputArchiveRoot,
  outputEconomicsRoot,
  write = false,
} = {}) {
  const [packageInputRoot, archiveInputRoot, economicsInputRoot] = await Promise.all([
    requireExplicitRoot(packageRoot, 'packageRoot'),
    requireExplicitRoot(legacyArchiveRoot, 'legacyArchiveRoot'),
    requireExplicitRoot(legacyEconomicsRoot, 'legacyEconomicsRoot'),
  ]);
  const inputs = {
    package: packageInputRoot,
    archive: archiveInputRoot,
    economics: economicsInputRoot,
  };
  const projections = await buildProjectionSet(inputs);
  const summary = {
    mode: write ? 'write' : 'dry-run',
    package_backed: projections.packageHashes.size,
    legacy_fallback: projections.legacyFallback,
    archive_outputs: projections.archives.length,
    economics_outputs: projections.economics.length,
    conflicts: 0,
    rejected: 0,
    receipt_hashes: projections.archives.map(bundle => bundle.receipt_hash),
    archive_index: buildReceiptArchiveIndex(projections.archives),
    economics_index: buildReceiptEconomicsIndex(projections.economics),
  };
  if (!write) return deepFreeze(summary);

  const outputs = {
    archive: await requireEmptyOutputRoot(outputArchiveRoot, 'outputArchiveRoot'),
    economics: await requireEmptyOutputRoot(outputEconomicsRoot, 'outputEconomicsRoot'),
  };
  assertOutputIsolation(outputs, inputs);
  const staged = await stageTrees(projections, outputs);
  await publishTrees(staged.stages, outputs);
  return deepFreeze({ ...summary, tree_hashes: staged.treeHashes });
}

function parseArgs(argv) {
  const options = { write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--package-root') options.packageRoot = argv[++index];
    else if (arg === '--legacy-archive-root') options.legacyArchiveRoot = argv[++index];
    else if (arg === '--legacy-economics-root') options.legacyEconomicsRoot = argv[++index];
    else if (arg === '--output-archive-root') options.outputArchiveRoot = argv[++index];
    else if (arg === '--output-economics-root') options.outputEconomicsRoot = argv[++index];
    else if (arg === '--write') options.write = true;
    else fail('compatibility_conflict', `unsupported argument: ${arg}`);
  }
  return options;
}

export async function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const summary = await rebuildReceiptCompatibilityViewsV1(parseArgs(argv));
    stdout.write(stableJson(summary));
    return summary.conflicts === 0 && summary.rejected === 0 ? 0 : 1;
  } catch (error) {
    stderr.write(`${error?.code || 'compatibility_projection_failed'}: ${error?.message || error}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
