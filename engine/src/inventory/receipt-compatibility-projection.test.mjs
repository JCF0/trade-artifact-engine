#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import {
  readReceiptArchiveBundle,
  readReceiptArchiveBundles,
  stableJson,
} from './archive-store.mjs';
import {
  readReceiptEconomics,
  serializeReceiptEconomicsSidecar,
} from './receipt-economics-store.mjs';
import { createReceiptPackageFsStore } from '../receipt-package/fs-package-store.mjs';
import {
  buildArchiveV1CompatibilityBundleFromPackage,
  buildEconomicsV1CompatibilitySidecarFromPackage,
  ReceiptCompatibilityProjectionError,
} from './receipt-compatibility-projections.mjs';
import {
  rebuildReceiptCompatibilityViewsV1,
} from './receipt-compatibility-projection.mjs';

const PACKAGE_ROOT = '/root/artifact-data/receipt-packages-v1';
const ARCHIVE_ROOT = resolve('engine/data/inventory/receipt-archive-v1');
const ECONOMICS_ROOT = resolve('engine/data/inventory/receipt-economics-v1');
const HASHES = Object.freeze([
  '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
  '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
]);

async function packageByHash(hash) {
  return createReceiptPackageFsStore({ root: PACKAGE_ROOT }).readCommitted(hash);
}

async function tree(root) {
  const files = {};
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else files[relative(root, child).split('\\').join('/')] = await readFile(child, 'utf8');
    }
  }
  await walk(root);
  return files;
}

function digestFiles(files) {
  const hash = createHash('sha256');
  for (const [path, bytes] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path).update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}

function assertCode(code) {
  return error => error instanceof ReceiptCompatibilityProjectionError && error.code === code;
}

for (const hash of HASHES) {
  const receiptPackage = await packageByHash(hash);
  const archive = buildArchiveV1CompatibilityBundleFromPackage(receiptPackage);
  const economics = buildEconomicsV1CompatibilitySidecarFromPackage(receiptPackage);
  const productionArchiveBytes = await readFile(join(ARCHIVE_ROOT, 'receipts', `${hash}.json`), 'utf8');
  const productionEconomicsBytes = await readFile(join(ECONOMICS_ROOT, 'receipts', `${hash}.json`), 'utf8');

  assert.equal(stableJson(archive), productionArchiveBytes, `${hash} archive projection bytes`);
  assert.equal(serializeReceiptEconomicsSidecar(economics), productionEconomicsBytes, `${hash} economics projection bytes`);
  assert.deepEqual(readReceiptArchiveBundle(hash, { archiveRoot: ARCHIVE_ROOT }), archive);
  assert.deepEqual(readReceiptEconomics(hash, {
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
  }).sidecar, economics);

  const serialized = `${stableJson(archive)}${serializeReceiptEconomicsSidecar(economics)}`;
  for (const forbidden of [
    PACKAGE_ROOT, 'package_digest', 'receipt_package_v1', 'manifest.json',
    'archive-record.json', 'economics.json', 'provider_url', 'raw_transaction',
    'job_id', 'machine_path',
  ]) assert.equal(serialized.includes(forbidden), false, `${hash} leaked ${forbidden}`);
  assert.equal(archive.inventory_record.uploaded_at, null);
  assert.equal(archive.inventory_record.minted_at, null);
  assert.equal(archive.inventory_record.transaction_signature, null);

  const changedEconomics = structuredClone(receiptPackage);
  changedEconomics['economics.json'].realized_pnl_quote += 1;
  assert.throws(
    () => buildEconomicsV1CompatibilitySidecarFromPackage(changedEconomics),
    assertCode('package_projection_invalid'),
  );
  const changedVerification = structuredClone(receiptPackage);
  changedVerification['verification.json'].pass = false;
  assert.throws(
    () => buildArchiveV1CompatibilityBundleFromPackage(changedVerification),
    assertCode('package_projection_invalid'),
  );
}

const dry = await rebuildReceiptCompatibilityViewsV1({
  packageRoot: PACKAGE_ROOT,
  legacyArchiveRoot: ARCHIVE_ROOT,
  legacyEconomicsRoot: ECONOMICS_ROOT,
});
assert.deepEqual({
  mode: dry.mode,
  package_backed: dry.package_backed,
  legacy_fallback: dry.legacy_fallback,
  archive_outputs: dry.archive_outputs,
  economics_outputs: dry.economics_outputs,
  conflicts: dry.conflicts,
  rejected: dry.rejected,
}, {
  mode: 'dry-run',
  package_backed: 2,
  legacy_fallback: 64,
  archive_outputs: 66,
  economics_outputs: 2,
  conflicts: 0,
  rejected: 0,
});

const workspace = await mkdtemp(join(tmpdir(), 'artifact-v112-compatibility-test-'));
try {
  const archiveA = join(workspace, 'a', 'archive-v1');
  const economicsA = join(workspace, 'a', 'economics-v1');
  const archiveB = join(workspace, 'b', 'archive-v1');
  const economicsB = join(workspace, 'b', 'economics-v1');
  for (const root of [archiveA, economicsA, archiveB, economicsB]) await mkdir(root, { recursive: true });

  const writtenA = await rebuildReceiptCompatibilityViewsV1({
    packageRoot: PACKAGE_ROOT,
    legacyArchiveRoot: ARCHIVE_ROOT,
    legacyEconomicsRoot: ECONOMICS_ROOT,
    outputArchiveRoot: archiveA,
    outputEconomicsRoot: economicsA,
    write: true,
  });
  const writtenB = await rebuildReceiptCompatibilityViewsV1({
    packageRoot: PACKAGE_ROOT,
    legacyArchiveRoot: ARCHIVE_ROOT,
    legacyEconomicsRoot: ECONOMICS_ROOT,
    outputArchiveRoot: archiveB,
    outputEconomicsRoot: economicsB,
    write: true,
  });
  assert.equal(writtenA.mode, 'write');
  assert.equal(writtenA.archive_outputs, 66);
  assert.equal(writtenA.economics_outputs, 2);
  assert.deepEqual(writtenB.tree_hashes, writtenA.tree_hashes);
  assert.deepEqual(await tree(archiveB), await tree(archiveA));
  assert.deepEqual(await tree(economicsB), await tree(economicsA));
  assert.deepEqual(await tree(archiveA), await tree(ARCHIVE_ROOT));
  assert.deepEqual(await tree(economicsA), await tree(ECONOMICS_ROOT));
  assert.equal(readReceiptArchiveBundles({ archiveRoot: archiveA }).length, 66);
  for (const hash of HASHES) readReceiptEconomics(hash, { archiveRoot: archiveA, economicsRoot: economicsA });
  assert.equal((await readdir(join(economicsA, 'receipts'))).length, 2);
  assert.equal(writtenA.tree_hashes.archive, digestFiles(await tree(archiveA)));
  assert.equal(writtenA.tree_hashes.economics, digestFiles(await tree(economicsA)));

  await assert.rejects(rebuildReceiptCompatibilityViewsV1({
    packageRoot: PACKAGE_ROOT,
    legacyArchiveRoot: ARCHIVE_ROOT,
    legacyEconomicsRoot: ECONOMICS_ROOT,
    write: true,
  }), assertCode('explicit_output_root_required'));

  const nonemptyArchive = join(workspace, 'nonempty', 'archive-v1');
  const emptyEconomics = join(workspace, 'nonempty', 'economics-v1');
  await mkdir(nonemptyArchive, { recursive: true });
  await mkdir(emptyEconomics, { recursive: true });
  await writeFile(join(nonemptyArchive, 'sentinel'), 'retain');
  await assert.rejects(rebuildReceiptCompatibilityViewsV1({
    packageRoot: PACKAGE_ROOT,
    legacyArchiveRoot: ARCHIVE_ROOT,
    legacyEconomicsRoot: ECONOMICS_ROOT,
    outputArchiveRoot: nonemptyArchive,
    outputEconomicsRoot: emptyEconomics,
    write: true,
  }), assertCode('output_root_not_empty'));

  const aliasedArchiveSource = join(workspace, 'aliased-archive-source');
  const aliasedEconomicsSource = join(workspace, 'aliased-economics-source');
  await cp(ARCHIVE_ROOT, aliasedArchiveSource, { recursive: true });
  await cp(ECONOMICS_ROOT, aliasedEconomicsSource, { recursive: true });
  await mkdir(join(aliasedArchiveSource, 'unsafe-output'));
  await mkdir(join(aliasedEconomicsSource, 'unsafe-output'));
  const archiveAlias = join(workspace, 'archive-parent-alias');
  const economicsAlias = join(workspace, 'economics-parent-alias');
  await symlink(aliasedArchiveSource, archiveAlias, 'dir');
  await symlink(aliasedEconomicsSource, economicsAlias, 'dir');
  await assert.rejects(rebuildReceiptCompatibilityViewsV1({
    packageRoot: PACKAGE_ROOT,
    legacyArchiveRoot: aliasedArchiveSource,
    legacyEconomicsRoot: aliasedEconomicsSource,
    outputArchiveRoot: join(archiveAlias, 'unsafe-output'),
    outputEconomicsRoot: join(economicsAlias, 'unsafe-output'),
    write: true,
  }), assertCode('compatibility_conflict'));
  assert.equal(await readFile(join(nonemptyArchive, 'sentinel'), 'utf8'), 'retain');

  const conflictArchive = join(workspace, 'conflict-archive');
  await cp(ARCHIVE_ROOT, conflictArchive, { recursive: true });
  const hash = HASHES[0];
  const path = join(conflictArchive, 'receipts', `${hash}.json`);
  const conflict = JSON.parse(await readFile(path, 'utf8'));
  conflict.inventory_record.display_status = 'Conflicting compatibility value';
  conflict.canonical_receipt_record.display_status = 'Conflicting compatibility value';
  // Rebuild the source hashes so this is a valid archive-v1 record, but not the package projection.
  const stableHash = value => createHash('sha256').update(stableJson(value)).digest('hex');
  conflict.provenance.source_record_hashes.canonical_receipt_record = stableHash(conflict.canonical_receipt_record);
  conflict.provenance.source_record_hashes.inventory_record = stableHash(conflict.inventory_record);
  await writeFile(path, stableJson(conflict));
  await assert.rejects(rebuildReceiptCompatibilityViewsV1({
    packageRoot: PACKAGE_ROOT,
    legacyArchiveRoot: conflictArchive,
    legacyEconomicsRoot: ECONOMICS_ROOT,
  }), assertCode('package_archive_projection_mismatch'));

  const conflictEconomics = join(workspace, 'conflict-economics');
  await cp(ECONOMICS_ROOT, conflictEconomics, { recursive: true });
  const economicsPath = join(conflictEconomics, 'receipts', `${hash}.json`);
  const economicsConflict = JSON.parse(await readFile(economicsPath, 'utf8'));
  economicsConflict.provenance.recovery_method = 'retained_canonical_receipt';
  await writeFile(economicsPath, `${JSON.stringify(economicsConflict, null, 2)}\n`);
  await assert.rejects(rebuildReceiptCompatibilityViewsV1({
    packageRoot: PACKAGE_ROOT,
    legacyArchiveRoot: ARCHIVE_ROOT,
    legacyEconomicsRoot: conflictEconomics,
  }), assertCode('package_economics_projection_mismatch'));

  const reversedPackages = join(workspace, 'packages-reversed');
  await mkdir(reversedPackages);
  for (const hash of [...HASHES].reverse()) await cp(join(PACKAGE_ROOT, hash), join(reversedPackages, hash), { recursive: true });
  const reversedArchive = join(workspace, 'archive-reversed');
  const reversedEconomics = join(workspace, 'economics-reversed');
  await mkdir(join(reversedArchive, 'receipts'), { recursive: true });
  await mkdir(join(reversedEconomics, 'receipts'), { recursive: true });
  for (const name of (await readdir(join(ARCHIVE_ROOT, 'receipts'))).sort().reverse()) {
    await cp(join(ARCHIVE_ROOT, 'receipts', name), join(reversedArchive, 'receipts', name));
  }
  for (const name of (await readdir(join(ECONOMICS_ROOT, 'receipts'))).sort().reverse()) {
    await cp(join(ECONOMICS_ROOT, 'receipts', name), join(reversedEconomics, 'receipts', name));
  }
  await cp(join(ARCHIVE_ROOT, 'index.json'), join(reversedArchive, 'index.json'));
  await cp(join(ECONOMICS_ROOT, 'index.json'), join(reversedEconomics, 'index.json'));
  const reverseArchive = join(workspace, 'reverse', 'archive-v1');
  const reverseEconomics = join(workspace, 'reverse', 'economics-v1');
  await mkdir(reverseArchive, { recursive: true });
  await mkdir(reverseEconomics, { recursive: true });
  const writeB = await rebuildReceiptCompatibilityViewsV1({
    packageRoot: reversedPackages,
    legacyArchiveRoot: reversedArchive,
    legacyEconomicsRoot: reversedEconomics,
    outputArchiveRoot: reverseArchive,
    outputEconomicsRoot: reverseEconomics,
    write: true,
  });
  assert.deepEqual(writeB.tree_hashes, writtenA.tree_hashes);

  const noncanonicalLegacy = join(workspace, 'legacy-noncanonical');
  await cp(ARCHIVE_ROOT, noncanonicalLegacy, { recursive: true });
  const fallbackName = (await readdir(join(noncanonicalLegacy, 'receipts')))
    .find(name => !HASHES.includes(name.slice(0, -5)));
  const fallbackPath = join(noncanonicalLegacy, 'receipts', fallbackName);
  const fallbackBytes = `${JSON.stringify(JSON.parse(await readFile(fallbackPath, 'utf8')))}\n`;
  await writeFile(fallbackPath, fallbackBytes);
  const retainedArchive = join(workspace, 'retained', 'archive-v1');
  const retainedEconomics = join(workspace, 'retained', 'economics-v1');
  await mkdir(retainedArchive, { recursive: true });
  await mkdir(retainedEconomics, { recursive: true });
  await rebuildReceiptCompatibilityViewsV1({
    packageRoot: PACKAGE_ROOT,
    legacyArchiveRoot: noncanonicalLegacy,
    legacyEconomicsRoot: ECONOMICS_ROOT,
    outputArchiveRoot: retainedArchive,
    outputEconomicsRoot: retainedEconomics,
    write: true,
  });
  assert.equal(await readFile(join(retainedArchive, 'receipts', fallbackName), 'utf8'), fallbackBytes);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

const source = await readFile(new URL('./receipt-compatibility-projection.mjs', import.meta.url), 'utf8');
const pureSource = await readFile(new URL('./receipt-compatibility-projections.mjs', import.meta.url), 'utf8');
assert.equal(pureSource.includes('node:fs'), false, 'pure projection module imports filesystem access');
assert.equal(pureSource.includes('node:http'), false, 'pure projection module imports network access');
for (const forbiddenImport of [
  'archive-current-run', 'import-current-receipt-economics', 'scanner.mjs',
  'debug-snapshot', 'irys', 'provider', 'upload-', 'mint-', 'signing',
]) assert.equal(source.includes(forbiddenImport), false, `forbidden dependency: ${forbiddenImport}`);

console.log('receipt compatibility projection/rebuild: PASS');
