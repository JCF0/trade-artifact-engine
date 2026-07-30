#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  buildInventorySnapshot,
  getLegacyInventoryReceipt,
  getInventoryReceipt,
  getInventoryReceiptSource,
  listLegacyInventory,
} from './inventory.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofVerifierView } from '../proof-verifier/view-model.mjs';
import { resolveTokenDisplayMetadata } from '../display-metadata/token-display-registry.mjs';
import { buildShareCardViewModel } from '../share-card/share-card-view-model.mjs';
import { formatShareCardViewModel } from '../share-card/share-card-format.mjs';
import { buildReceiptBoardView } from '../receipt-board/view-model.mjs';
import {
  buildReceiptArchiveBundle,
  readReceiptArchiveBundle,
  stableJson,
} from './archive-store.mjs';

const ENGINE_ROOT = resolve('engine');
const PACKAGE_ROOT = '/root/artifact-data/receipt-packages-v1';
const ARCHIVE_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-archive-v1');
const ECONOMICS_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-economics-v1');
const JUP_HASH = '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca';
const RAY_HASH = '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341';

const options = {
  engineRoot: ENGINE_ROOT,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
  includeArchive: true,
  includeLegacy: false,
  includeExcluded: false,
};

async function makeCompatibilityCopies(prefix) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const packageRoot = join(parent, 'packages');
  const archiveRoot = join(parent, 'archive');
  const economicsRoot = join(parent, 'economics');
  await cp(PACKAGE_ROOT, packageRoot, { recursive: true });
  await cp(ARCHIVE_ROOT, archiveRoot, { recursive: true });
  await cp(ECONOMICS_ROOT, economicsRoot, { recursive: true });
  return { parent, packageRoot, archiveRoot, economicsRoot };
}

const legacy = buildInventorySnapshot(options);
const packageFirst = await buildInventorySnapshot({ ...options, packageRoot: PACKAGE_ROOT });

const withoutGeneratedAt = snapshot => ({ ...snapshot, generated_at: '<normalized>' });
assert.deepEqual(withoutGeneratedAt(packageFirst), withoutGeneratedAt(legacy));
assert.equal(
  JSON.stringify(withoutGeneratedAt(packageFirst)),
  JSON.stringify(withoutGeneratedAt(legacy)),
);
assert.equal(packageFirst.receipts.length, 66);
assert.equal(getInventoryReceiptSource(packageFirst, JUP_HASH), 'receipt_package_v1');
assert.equal(getInventoryReceiptSource(packageFirst, RAY_HASH), 'receipt_package_v1');
assert.deepEqual(
  await getInventoryReceipt(JUP_HASH, { ...options, packageRoot: PACKAGE_ROOT }),
  packageFirst.receipts.find(receipt => receipt.receipt_hash === JUP_HASH),
);
assert.deepEqual(
  await listLegacyInventory({ ...options, packageRoot: PACKAGE_ROOT }),
  listLegacyInventory(options),
);
assert.equal(
  await getLegacyInventoryReceipt('missing', { ...options, packageRoot: PACKAGE_ROOT }),
  null,
);
assert.equal(packageFirst.receipts.filter(receipt => (
  getInventoryReceiptSource(packageFirst, receipt.receipt_hash) === 'receipt_archive_v1'
)).length, 64);

for (const hash of [JUP_HASH, RAY_HASH]) {
  const before = legacy.receipts.find(receipt => receipt.receipt_hash === hash);
  const after = packageFirst.receipts.find(receipt => receipt.receipt_hash === hash);
  assert.deepEqual(after, before);
  assert.deepEqual(buildProofDetailView(after), buildProofDetailView(before));
  assert.deepEqual(buildProofVerifierView(after), buildProofVerifierView(before));
  const links = { proof_href: `proof/${hash}`, verifier_href: `verifier/${hash}` };
  const beforeCard = formatShareCardViewModel(buildShareCardViewModel(before, {
    tokenDisplayMetadata: resolveTokenDisplayMetadata(before.token_mint),
    links,
  }));
  const afterCard = formatShareCardViewModel(buildShareCardViewModel(after, {
    tokenDisplayMetadata: resolveTokenDisplayMetadata(after.token_mint),
    links,
  }));
  assert.deepEqual(afterCard, beforeCard);
  assert.equal(after.canonical_economics.status, 'verified');
}

const serialized = JSON.stringify(packageFirst);
assert.equal(serialized.includes(PACKAGE_ROOT), false);
assert.equal(serialized.includes('package_digest'), false);
assert.equal(serialized.includes('receipt_package_v1'), false);

const legacyBoard = buildReceiptBoardView(options);
const packageFirstBoard = await buildReceiptBoardView({ ...options, packageRoot: PACKAGE_ROOT });
assert.deepEqual(packageFirstBoard, legacyBoard);

const packageOnly = await makeCompatibilityCopies('artifact-package-only-inventory-');
try {
  const { packageRoot, archiveRoot, economicsRoot } = packageOnly;
  await rm(join(archiveRoot, 'receipts', `${JUP_HASH}.json`));
  await rm(join(economicsRoot, 'receipts', `${JUP_HASH}.json`));

  const fallbackOnly = buildInventorySnapshot({
    ...options,
    archiveRoot,
    economicsRoot,
  });
  assert.equal(fallbackOnly.receipts.some(receipt => receipt.receipt_hash === JUP_HASH), false);

  const withPackage = await buildInventorySnapshot({
    ...options,
    packageRoot,
    archiveRoot,
    economicsRoot,
  });
  const packageOnlyJup = withPackage.receipts.find(receipt => receipt.receipt_hash === JUP_HASH);
  assert.ok(packageOnlyJup);
  assert.equal(getInventoryReceiptSource(withPackage, JUP_HASH), 'receipt_package_v1');
  assert.equal(packageOnlyJup.receipt_id, 'art_v12_cp_JUPyiwrY_0');
  assert.equal(packageOnlyJup.hash_valid, true);
  assert.equal(packageOnlyJup.verifier_passed, true);
  assert.equal(packageOnlyJup.canonical_economics.fields.realized_pnl_quote, 8287.838847);
} finally {
  await rm(packageOnly.parent, { recursive: true, force: true });
}

const malformed = await makeCompatibilityCopies('artifact-package-malformed-inventory-');
try {
  await writeFile(join(malformed.packageRoot, JUP_HASH, 'verification.json'), '{ malformed package');
  const snapshot = await buildInventorySnapshot({ ...options, ...malformed });
  assert.equal(snapshot.receipts.some(receipt => receipt.receipt_hash === JUP_HASH), false);
  assert.ok(snapshot.archive.diagnostics.some(item => (
    item.code === 'receipt_package_excluded'
    && item.receipt_hash === JUP_HASH
    && item.reason === 'committed_package_invalid'
  )));
  await assert.rejects(
    buildInventorySnapshot({
      engineRoot: options.engineRoot,
      packageRoot: malformed.packageRoot,
      includeArchive: false,
    }),
    error => error.code === 'receipt_package_excluded'
      && error.receipt_hash === JUP_HASH
      && error.reason === 'committed_package_invalid',
  );
} finally {
  await rm(malformed.parent, { recursive: true, force: true });
}

const archiveConflict = await makeCompatibilityCopies('artifact-package-archive-conflict-');
try {
  const bundle = readReceiptArchiveBundle(JUP_HASH, { archiveRoot: archiveConflict.archiveRoot });
  const conflicting = buildReceiptArchiveBundle({
    ...bundle.inventory_record,
    display_status: 'Conflicting legacy display status',
  });
  await writeFile(
    join(archiveConflict.archiveRoot, 'receipts', `${JUP_HASH}.json`),
    stableJson(conflicting),
  );
  const snapshot = await buildInventorySnapshot({ ...options, ...archiveConflict });
  assert.equal(snapshot.receipts.some(receipt => receipt.receipt_hash === JUP_HASH), false);
  assert.ok(snapshot.archive.diagnostics.some(item => (
    item.code === 'receipt_package_excluded'
    && item.receipt_hash === JUP_HASH
    && item.reason === 'package_legacy_overlap_mismatch'
  )));
} finally {
  await rm(archiveConflict.parent, { recursive: true, force: true });
}

const economicsConflict = await makeCompatibilityCopies('artifact-package-economics-conflict-');
try {
  const economicsPath = join(economicsConflict.economicsRoot, 'receipts', `${JUP_HASH}.json`);
  const sidecar = JSON.parse(await readFile(economicsPath, 'utf8'));
  sidecar.hash_bound_fields.realized_pnl_quote += 1;
  await writeFile(economicsPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  const snapshot = await buildInventorySnapshot({ ...options, ...economicsConflict });
  assert.equal(snapshot.receipts.some(receipt => receipt.receipt_hash === JUP_HASH), false);
  assert.ok(snapshot.archive.diagnostics.some(item => (
    item.code === 'receipt_package_excluded'
    && item.receipt_hash === JUP_HASH
    && item.reason === 'package_legacy_economics_mismatch'
  )));
} finally {
  await rm(economicsConflict.parent, { recursive: true, force: true });
}

const corruptArchive = await makeCompatibilityCopies('artifact-package-corrupt-archive-');
try {
  await writeFile(
    join(corruptArchive.archiveRoot, 'receipts', `${JUP_HASH}.json`),
    '{ corrupt archive',
  );
  await rm(join(corruptArchive.economicsRoot, 'receipts', `${JUP_HASH}.json`));
  const snapshot = await buildInventorySnapshot({ ...options, ...corruptArchive });
  assert.equal(snapshot.receipts.some(receipt => receipt.receipt_hash === JUP_HASH), false);
  assert.ok(snapshot.archive.diagnostics.some(item => (
    item.code === 'receipt_package_excluded'
    && item.receipt_hash === JUP_HASH
    && item.reason === 'package_legacy_overlap_mismatch'
  )));
} finally {
  await rm(corruptArchive.parent, { recursive: true, force: true });
}

console.log('package-first inventory integration: PASS');
