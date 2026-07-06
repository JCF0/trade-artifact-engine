import assert from 'assert';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofGalleryView } from './view-model.mjs';
import { renderProofGalleryHtml } from './render-html.mjs';

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
  writeManifest(fixture.root, [fixture.hashes.receiptAHash, fixture.hashes.receiptBHash]);

  test('HTML includes title, collection disclaimer, per-item fields, and all required links', () => {
    const html = renderProofGalleryHtml(buildProofGalleryView({ engineRoot: fixture.root }));
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('Artifact Sample Gallery'));
    assert.ok(html.includes('Selected sample receipts only. Not a portfolio statement.'));
    assert.ok(html.includes('Receipt ID'));
    assert.ok(html.includes('Trust Level'));
    assert.ok(html.includes(`/api/proof/${fixture.hashes.receiptAHash}`));
    assert.ok(html.includes(`/api/verifier/${fixture.hashes.receiptAHash}`));
    assert.ok(html.includes(`/api/proof/${fixture.hashes.receiptAHash}/card`));
    assert.ok(html.includes(`/api/proof/${fixture.hashes.receiptAHash}/card/preview`));
    assert.ok(html.includes(`/api/proof/${fixture.hashes.receiptAHash}/hosted-preview`));
  });

  test('HTML does not include ranking, leaderboard, or profile language', () => {
    const html = renderProofGalleryHtml(buildProofGalleryView({ engineRoot: fixture.root }));
    assert.ok(!html.includes('leaderboard'));
    assert.ok(!html.includes('ranking'));
    assert.ok(!html.includes('profile'));
    assert.ok(!html.includes('account page'));
    assert.ok(!html.includes('wallet totals'));
  });

  test('HTML has no scripts, external css, or external assets', () => {
    const html = renderProofGalleryHtml(buildProofGalleryView({ engineRoot: fixture.root }));
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('<link rel='));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('src="http'));
  });

  test('empty gallery renders cleanly', () => {
    writeManifest(fixture.root, ['9'.repeat(64)]);
    const html = renderProofGalleryHtml(buildProofGalleryView({ engineRoot: fixture.root }));
    assert.ok(html.includes('No sample receipts are currently available.'));
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);