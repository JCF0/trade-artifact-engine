#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildInventorySnapshot,
  getInventoryReceiptProofSource,
} from '../inventory/inventory.mjs';
import { readReceiptPackageInventory } from '../inventory/package-inventory.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofVerifierView } from '../proof-verifier/view-model.mjs';
import { resolveTokenDisplayMetadata } from '../display-metadata/token-display-registry.mjs';
import { formatShareCardViewModel } from '../share-card/share-card-format.mjs';
import { renderShareCardHtml } from '../share-card/share-card-html.mjs';
import { buildShareCardViewModel } from '../share-card/share-card-view-model.mjs';
import { buildPublicDemoBundle, writePublicDemoBundle } from '../public-demo/site-bundle.mjs';
import { runPublicDemoPredeployCheck } from '../public-demo/predeploy-check.mjs';
import { parseArgs as parsePublicDemoArgs } from '../public-demo/cli.mjs';
import { runCli as runProofPublishCli } from '../proof-publish/cli.mjs';
import { runCli as runProofExportCli } from '../proof-export/cli.mjs';
import { renderStaticProofPage } from '../proof-export/render-static-page.mjs';
import { buildReceiptPackageV1 } from '../receipt-package/builder.mjs';
import { makeFixture } from '../receipt-package/fixtures.test-helper.mjs';
import { createReceiptPackageFsStore } from '../receipt-package/fs-package-store.mjs';
import {
  buildPackageNativeProofSourceV1,
  proofSourceInventoryRecord,
  resolveReceiptProofSourceV1,
} from './package-native-proof-source.mjs';

const ENGINE_ROOT = resolve('engine');
const PACKAGE_ROOT = '/root/artifact-data/receipt-packages-v1';
const ARCHIVE_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-archive-v1');
const ECONOMICS_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-economics-v1');
const JUP_HASH = '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca';
const RAY_HASH = '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341';
const LEGACY_HASH = '7efb88297aa3b19dc050cf8e573949cc629aea04138171cc9842653b7d78c1b6';

const packageRead = await readReceiptPackageInventory({ packageRoot: PACKAGE_ROOT });
const jupPackage = packageRead.entries.find(entry => entry.receipt_hash === JUP_HASH).receipt_package;
const source = buildPackageNativeProofSourceV1(jupPackage);
assert.deepEqual(Object.keys(source), [
  'source_version',
  'receipt_hash',
  'inventory_record',
  'canonical_receipt',
  'verification_result',
  'canonical_economics',
]);
assert.equal(source.source_version, 'package_native_proof_source_v1');
assert.equal(source.receipt_hash, JUP_HASH);
assert.equal(source.inventory_record.receipt_id, 'art_v12_cp_JUPyiwrY_0');
assert.equal(source.verification_result, source.verification_result);
assert.equal(source.verification_result.pass, true);
assert.equal(source.canonical_economics.fields.realized_pnl_quote, 8287.838847);
assert.equal(source.canonical_economics.fields.realized_pnl_pct, 16.6661);
assert.deepEqual(Object.keys(source.canonical_economics), ['status', 'source', 'fields']);
assert.equal(source.canonical_economics.source, 'receipt_package_v1');
assert.equal(Object.hasOwn(source.canonical_economics, 'recovery_method'), false);
assert.deepEqual(source.inventory_record.canonical_economics, source.canonical_economics);
assert.equal(Object.isFrozen(source), true);
assert.equal(Object.isFrozen(source.inventory_record), true);
assert.equal(Object.isFrozen(source.canonical_receipt.limitations), true);
assert.equal(Object.isFrozen(source.verification_result.rule_violations), true);
assert.equal(Object.isFrozen(source.canonical_economics.fields.entry_tx_hashes), true);

const legacySnapshot = buildInventorySnapshot({
  engineRoot: ENGINE_ROOT,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
  includeArchive: true,
});
const legacyJup = legacySnapshot.receipts.find(receipt => receipt.receipt_hash === JUP_HASH);
const cardOptions = {
  tokenDisplayMetadata: resolveTokenDisplayMetadata(source.inventory_record.token_mint),
  links: { proof_href: `proof/${JUP_HASH}`, verifier_href: `verifier/${JUP_HASH}` },
};

const resolvedPackage = await resolveReceiptProofSourceV1({
  receiptHash: JUP_HASH,
  packageRoot: PACKAGE_ROOT,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
});
assert.equal(resolvedPackage.source_version, 'package_native_proof_source_v1');
assert.deepEqual(resolvedPackage.canonical_economics, source.canonical_economics);
assert.equal(resolvedPackage.canonical_economics.source, 'receipt_package_v1');
assert.equal(Object.hasOwn(resolvedPackage.canonical_economics, 'recovery_method'), false);
assert.equal(resolvedPackage.inventory_record.canonical_economics.source, 'receipt_economics_v1');
assert.equal(resolvedPackage.inventory_record.canonical_economics.recovery_method, 'hash_matched_regeneration');
assert.equal(proofSourceInventoryRecord(resolvedPackage).canonical_economics.source, 'receipt_package_v1');
assert.equal(Object.hasOwn(proofSourceInventoryRecord(resolvedPackage).canonical_economics, 'recovery_method'), false);
assert.deepEqual(buildProofDetailView(resolvedPackage), buildProofDetailView(legacyJup));
assert.deepEqual(buildProofVerifierView(resolvedPackage), buildProofVerifierView(legacyJup));
const packageCard = buildShareCardViewModel(resolvedPackage, cardOptions);
const legacyCard = buildShareCardViewModel(legacyJup, cardOptions);
assert.deepEqual(packageCard, legacyCard);
assert.deepEqual(formatShareCardViewModel(packageCard), formatShareCardViewModel(legacyCard));
assert.equal(
  renderShareCardHtml(formatShareCardViewModel(packageCard), { logo_href: '/assets/artifact-logo-header.png' }),
  renderShareCardHtml(formatShareCardViewModel(legacyCard), { logo_href: '/assets/artifact-logo-header.png' }),
);

const resolvedLegacy = await resolveReceiptProofSourceV1({
  receiptHash: LEGACY_HASH,
  packageRoot: PACKAGE_ROOT,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
});
assert.equal(resolvedLegacy.receipt_hash, LEGACY_HASH);
assert.equal(resolvedLegacy.source_version, undefined);
assert.deepEqual(resolvedLegacy, legacySnapshot.receipts.find(receipt => receipt.receipt_hash === LEGACY_HASH));

const publicDemoOptions = {
  engineRoot: ENGINE_ROOT,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
};
assert.throws(
  () => parsePublicDemoArgs(['--dry-run', '--package-root', PACKAGE_ROOT]),
  /requires explicit --engine-root, --archive-root, and --economics-root/,
);
const legacyPublicDemo = buildPublicDemoBundle(publicDemoOptions);
const packagePublicDemo = await buildPublicDemoBundle({ ...publicDemoOptions, packageRoot: PACKAGE_ROOT });
assert.deepEqual(packagePublicDemo.files, legacyPublicDemo.files);
assert.equal(JSON.stringify(packagePublicDemo.files), JSON.stringify(legacyPublicDemo.files));
const packageSnapshot = await buildInventorySnapshot({
  ...publicDemoOptions,
  packageRoot: PACKAGE_ROOT,
  includeArchive: true,
});
for (const receiptHash of [JUP_HASH, RAY_HASH]) {
  const compatibilityReceipt = packageSnapshot.receipts.find(receipt => receipt.receipt_hash === receiptHash);
  const authoritativeSource = getInventoryReceiptProofSource(packageSnapshot, receiptHash);
  assert.equal(compatibilityReceipt.canonical_economics.source, 'receipt_economics_v1');
  assert.equal(compatibilityReceipt.canonical_economics.recovery_method, 'hash_matched_regeneration');
  assert.equal(authoritativeSource.canonical_economics.source, 'receipt_package_v1');
  assert.equal(Object.hasOwn(authoritativeSource.canonical_economics, 'recovery_method'), false);
}

function captureText() {
  let value = '';
  return { stream: { write(chunk) { value += String(chunk); } }, read: () => value };
}
const packagePublishOut = captureText();
const packagePublishErr = captureText();
assert.equal(await runProofPublishCli([
  '--receipt-hash', JUP_HASH,
  '--dry-run',
  '--engine-root', ENGINE_ROOT,
  '--package-root', PACKAGE_ROOT,
  '--archive-root', ARCHIVE_ROOT,
  '--economics-root', ECONOMICS_ROOT,
], { stdout: packagePublishOut.stream, stderr: packagePublishErr.stream, env: {} }), 0);
assert.ok(packagePublishOut.read().includes(`receipt_hash: ${JUP_HASH}`));
assert.equal(packagePublishErr.read(), '');

const packageExportOut = captureText();
const packageExportErr = captureText();
assert.equal(await runProofExportCli([
  '--receipt-hash', JUP_HASH,
  '--stdout',
  '--engine-root', ENGINE_ROOT,
  '--package-root', PACKAGE_ROOT,
  '--archive-root', ARCHIVE_ROOT,
  '--economics-root', ECONOMICS_ROOT,
], { stdout: packageExportOut.stream, stderr: packageExportErr.stream, env: {} }), 0);
assert.equal(
  packageExportOut.read().replace(/Generated at <span class="technical">[^<]+<\/span>/, 'Generated at'),
  renderStaticProofPage(buildProofDetailView(source))
    .replace(/Generated at <span class="technical">[^<]+<\/span>/, 'Generated at'),
);
assert.equal(packageExportErr.read(), '');

const tempRoot = await mkdtemp(join(tmpdir(), 'artifact-package-proof-source-'));
try {
  const packageRoot = join(tempRoot, 'packages');
  const archiveRoot = join(tempRoot, 'archive');
  const economicsRoot = join(tempRoot, 'economics');
  await Promise.all([
    cp(PACKAGE_ROOT, packageRoot, { recursive: true }),
    cp(ARCHIVE_ROOT, archiveRoot, { recursive: true }),
    cp(ECONOMICS_ROOT, economicsRoot, { recursive: true }),
  ]);

  const publicDemoRoot = join(tempRoot, 'public-demo');
  writePublicDemoBundle(packagePublicDemo, { outRoot: publicDemoRoot });
  const packagePredeploy = await runPublicDemoPredeployCheck({
    root: publicDemoRoot,
    buildOptions: {
      engineRoot: ENGINE_ROOT,
      packageRoot: PACKAGE_ROOT,
      archiveRoot: ARCHIVE_ROOT,
      economicsRoot: ECONOMICS_ROOT,
    },
  });
  assert.equal(packagePredeploy.ok, true);

  const economicsPath = join(economicsRoot, 'receipts', `${JUP_HASH}.json`);
  const relocatedSource = await resolveReceiptProofSourceV1({
    receiptHash: JUP_HASH,
    packageRoot,
    archiveRoot,
    economicsRoot,
  });
  assert.deepEqual(relocatedSource.canonical_economics, source.canonical_economics);
  assert.equal(relocatedSource.inventory_record.canonical_economics.source, 'receipt_economics_v1');

  const economicsBytes = await readFile(economicsPath, 'utf8');
  await rm(economicsPath);
  const sourceWithoutLegacyEconomics = await resolveReceiptProofSourceV1({
    receiptHash: JUP_HASH,
    packageRoot,
    archiveRoot,
    economicsRoot,
  });
  assert.deepEqual(sourceWithoutLegacyEconomics.canonical_economics, source.canonical_economics);
  assert.deepEqual(sourceWithoutLegacyEconomics.inventory_record.canonical_economics, source.canonical_economics);
  assert.deepEqual(buildProofDetailView(sourceWithoutLegacyEconomics), buildProofDetailView(source));
  assert.deepEqual(buildProofVerifierView(sourceWithoutLegacyEconomics), buildProofVerifierView(source));
  const cardWithoutLegacyEconomics = buildShareCardViewModel(sourceWithoutLegacyEconomics, cardOptions);
  assert.deepEqual(cardWithoutLegacyEconomics, packageCard);
  const noSidecarSerialized = JSON.stringify({
    source: sourceWithoutLegacyEconomics,
    proof: buildProofDetailView(sourceWithoutLegacyEconomics),
    verifier: buildProofVerifierView(sourceWithoutLegacyEconomics),
    card: cardWithoutLegacyEconomics,
  });
  assert.equal(noSidecarSerialized.includes('hash_matched_regeneration'), false);
  assert.equal(noSidecarSerialized.includes('recovery_method'), false);
  await writeFile(economicsPath, economicsBytes);

  const economics = JSON.parse(economicsBytes);
  economics.provenance.recovery_method = 'current_canonical_import';
  await writeFile(economicsPath, `${JSON.stringify(economics, null, 2)}\n`);
  const alternateCompatibilityProvenance = await resolveReceiptProofSourceV1({
    receiptHash: JUP_HASH, packageRoot, archiveRoot, economicsRoot,
  });
  assert.deepEqual(alternateCompatibilityProvenance.canonical_economics, source.canonical_economics);
  assert.equal(alternateCompatibilityProvenance.inventory_record.canonical_economics.recovery_method, 'current_canonical_import');
  assert.equal(Object.hasOwn(alternateCompatibilityProvenance.canonical_economics, 'recovery_method'), false);

  economics.provenance.recovery_method = 'hash_matched_regeneration';
  economics.hash_bound_fields.realized_pnl_quote += 1;
  await writeFile(economicsPath, `${JSON.stringify(economics, null, 2)}\n`);
  await assert.rejects(
    resolveReceiptProofSourceV1({ receiptHash: JUP_HASH, packageRoot, archiveRoot, economicsRoot }),
    error => error.code === 'receipt_package_legacy_overlap_mismatch'
      && error.message === 'receipt package and legacy compatibility records disagree'
      && error.cause === undefined
      && !JSON.stringify(error).includes(tempRoot),
  );

  await writeFile(economicsPath, economicsBytes);
  const archivePath = join(archiveRoot, 'receipts', `${JUP_HASH}.json`);
  const archiveBytes = await readFile(archivePath, 'utf8');
  const archive = JSON.parse(archiveBytes);
  archive.inventory_record.token_symbol = 'MISMATCH';
  await writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`);
  await assert.rejects(
    resolveReceiptProofSourceV1({ receiptHash: JUP_HASH, packageRoot, archiveRoot, economicsRoot }),
    error => error.code === 'receipt_package_legacy_overlap_mismatch'
      && error.cause === undefined
      && !JSON.stringify(error).includes(tempRoot),
  );

  await writeFile(archivePath, archiveBytes);
  await writeFile(join(packageRoot, JUP_HASH, 'verification.json'), '{ corrupt\n');
  await assert.rejects(
    resolveReceiptProofSourceV1({ receiptHash: JUP_HASH, packageRoot, archiveRoot, economicsRoot }),
    error => error.code === 'receipt_package_proof_source_invalid'
      && error.cause === undefined
      && !JSON.stringify(error).includes(tempRoot),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const syntheticRoot = await mkdtemp(join(tmpdir(), 'artifact-package-proof-source-synthetic-'));
try {
  const packageRoot = join(syntheticRoot, 'packages');
  const archiveRoot = join(syntheticRoot, 'archive');
  const economicsRoot = join(syntheticRoot, 'economics');
  const syntheticPackage = buildReceiptPackageV1(makeFixture());
  const syntheticHash = syntheticPackage['manifest.json'].receipt_hash;
  await mkdir(packageRoot, { mode: 0o700 });
  const store = createReceiptPackageFsStore({ root: packageRoot });
  const staged = await store.stage(syntheticPackage);
  await store.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest });

  const syntheticSource = await resolveReceiptProofSourceV1({
    receiptHash: syntheticHash,
    packageRoot,
    archiveRoot,
    economicsRoot,
  });
  assert.equal(syntheticSource.canonical_economics.source, 'receipt_package_v1');
  assert.equal(Object.hasOwn(syntheticSource.canonical_economics, 'recovery_method'), false);
  assert.deepEqual(syntheticSource.inventory_record.canonical_economics, syntheticSource.canonical_economics);
  const syntheticOptions = {
    tokenDisplayMetadata: resolveTokenDisplayMetadata(syntheticSource.inventory_record.token_mint),
    links: { proof_href: `proof/${syntheticHash}`, verifier_href: `verifier/${syntheticHash}` },
  };
  const syntheticOutputs = {
    proof: buildProofDetailView(syntheticSource),
    verifier: buildProofVerifierView(syntheticSource),
    card: buildShareCardViewModel(syntheticSource, syntheticOptions),
  };
  const syntheticSerialized = JSON.stringify(syntheticOutputs);
  assert.equal(syntheticSerialized.includes('hash_matched_regeneration'), false);
  assert.equal(syntheticSerialized.includes('recovery_method'), false);
} finally {
  await rm(syntheticRoot, { recursive: true, force: true });
}

await assert.rejects(
  resolveReceiptProofSourceV1({
    receiptHash: 'f'.repeat(64),
    packageRoot: PACKAGE_ROOT,
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
  }),
  error => error.code === 'receipt_proof_source_not_found',
);

const serialized = JSON.stringify({
  proof: buildProofDetailView(source),
  verifier: buildProofVerifierView(source),
  card: packageCard,
});
for (const forbidden of [PACKAGE_ROOT, 'package_digest', 'manifest.json', 'verification.json', 'economics.json']) {
  assert.equal(serialized.includes(forbidden), false);
}
for (const signature of [
  ...source.canonical_economics.fields.entry_tx_hashes,
  ...source.canonical_economics.fields.exit_tx_hashes,
]) {
  assert.equal(JSON.stringify(packageCard).includes(signature), false);
}

console.log('package-native proof source: PASS');
