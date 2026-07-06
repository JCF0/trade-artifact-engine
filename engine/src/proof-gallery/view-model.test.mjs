import assert from 'assert';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofGalleryView } from './view-model.mjs';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

function writeManifest(root, receiptHashes) {
  const samplesDir = join(root, 'samples');
  mkdirSync(samplesDir, { recursive: true });
  writeFileSync(join(samplesDir, 'sample-gallery.manifest.json'), `${JSON.stringify({
    version: '1.0.0',
    title: 'Artifact Sample Gallery',
    receipt_hashes: receiptHashes,
  }, null, 2)}\n`, 'utf8');
}

const fixture = createInventoryFixture();

try {
  writeManifest(fixture.root, [
    fixture.hashes.receiptBHash,
    '9'.repeat(64),
    fixture.hashes.receiptAHash,
  ]);

  test('gallery view-model returns compact gallery shape for known curated receipts', () => {
    const gallery = buildProofGalleryView({ engineRoot: fixture.root });
    assert.deepEqual(Object.keys(gallery), [
      'gallery_type',
      'title',
      'subtitle',
      'count',
      'empty',
      'disclosures',
      'items',
    ]);
    assert.equal(gallery.gallery_type, 'artifact_sample_gallery');
    assert.equal(gallery.empty, false);
    assert.equal(gallery.count, 2);
  });

  test('manifest order is preserved and unknown manifest hashes are ignored', () => {
    const gallery = buildProofGalleryView({ engineRoot: fixture.root });
    assert.deepEqual(gallery.items.map(item => item.receipt_hash), [
      fixture.hashes.receiptBHash,
      fixture.hashes.receiptAHash,
    ]);
  });

  test('item fields include receipt id/hash/type/display/trust/token fallback/disclosures/links', () => {
    const gallery = buildProofGalleryView({ engineRoot: fixture.root });
    const item = gallery.items[0];
    assert.equal(item.receipt_hash_short, 'bbbbbbbb...bbbbbbbb');
    assert.equal(item.receipt_id, 'art_v12_os_TEST_1');
    assert.equal(item.receipt_type, 'open_snapshot');
    assert.equal(item.display_status, 'Verified Snapshot (No PnL Claim)');
    assert.equal(item.valuation_status, 'raw_quote');
    assert.equal(item.token_display, 'TEST_TOK...');
    assert.equal(item.trust.current_label, 'Rule Verified');
    assert.ok(item.disclosures.includes('Selected receipt only. Not a portfolio statement.'));
    assert.equal(item.links.proof_api_path, `/api/proof/${fixture.hashes.receiptBHash}`);
    assert.equal(item.links.verifier_api_path, `/api/verifier/${fixture.hashes.receiptBHash}`);
    assert.equal(item.links.card_api_path, `/api/proof/${fixture.hashes.receiptBHash}/card`);
    assert.equal(item.links.card_preview_path, `/api/proof/${fixture.hashes.receiptBHash}/card/preview`);
    assert.equal(item.links.hosted_preview_path, `/api/proof/${fixture.hashes.receiptBHash}/hosted-preview`);
  });

  test('wallet_display works and does not mutate source gallery data shape', () => {
    const gallery = buildProofGalleryView({
      engineRoot: fixture.root,
      walletDisplayMode: 'redacted',
    });
    const fresh = buildProofGalleryView({ engineRoot: fixture.root });
    assert.equal(gallery.items[0].receipt_hash, fresh.items[0].receipt_hash);
    assert.equal(gallery.items[0].token_display, fresh.items[0].token_display);
    assert.deepEqual(fresh.items.map(item => item.receipt_hash), [
      fixture.hashes.receiptBHash,
      fixture.hashes.receiptAHash,
    ]);
  });


  test('fallback inventory order is stable if manifest is absent', () => {
    const noManifestFixture = createInventoryFixture();
    try {
      const gallery = buildProofGalleryView({ engineRoot: noManifestFixture.root });
      assert.deepEqual(gallery.items.map(item => item.receipt_hash), [
        noManifestFixture.hashes.receiptAHash,
        noManifestFixture.hashes.receiptBHash,
      ]);
    } finally {
      removeInventoryFixture(noManifestFixture.root);
    }
  });

  test('empty gallery renders cleanly', () => {
    writeManifest(fixture.root, ['9'.repeat(64)]);
    const gallery = buildProofGalleryView({ engineRoot: fixture.root });
    assert.equal(gallery.empty, true);
    assert.equal(gallery.count, 0);
    assert.deepEqual(gallery.items, []);
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);