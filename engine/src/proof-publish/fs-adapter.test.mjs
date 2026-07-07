import assert from 'assert';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildPublishBundle } from './publish-bundle.mjs';
import { planBundleWrite, resolvePublishTarget, writeBundleToDisk } from './fs-adapter.mjs';

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

function expectedSuffix(...segments) {
  return join(...segments);
}

const fixture = createInventoryFixture();

try {
  const record = getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root });
  const proofDetail = buildProofDetailView(record);
  const bundle = buildPublishBundle(proofDetail, { generatedAt: '2026-07-03T00:00:00.000Z' });

  test('fs adapter computes published/p/<slug> for unlisted and public', () => {
    const unlisted = resolvePublishTarget({ slug: bundle.slug, visibility: 'unlisted', engineRoot: fixture.root });
    const pub = resolvePublishTarget({ slug: bundle.slug, visibility: 'public', engineRoot: fixture.root });
    assert.ok(unlisted.targetDir.endsWith(expectedSuffix('data', 'published', 'p', bundle.slug)));
    assert.equal(pub.targetDir, unlisted.targetDir);
  });

  test('fs adapter computes drafts/p/<slug> for private', () => {
    const plan = resolvePublishTarget({ slug: bundle.slug, visibility: 'private', engineRoot: fixture.root });
    assert.ok(plan.targetDir.endsWith(expectedSuffix('data', 'drafts', 'p', bundle.slug)));
  });

  test('dry-run planning creates no files or directories', () => {
    const plan = planBundleWrite(bundle, { engineRoot: fixture.root });
    assert.equal(plan.targetExists, false);
    assert.equal(existsSync(plan.targetDir), false);
  });

  test('write creates exactly index.html, proof.json, manifest.json', () => {
    const root = join(tmpdir(), `trade-artifact-fs-write-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const result = writeBundleToDisk(bundle, { outRoot: root, visibility: 'unlisted' });
      assert.deepEqual(readdirSync(result.targetDir).sort(), ['index.html', 'manifest.json', 'proof.json']);
      assert.ok(readFileSync(result.filePaths['index.html'], 'utf8').includes('Hosted proof page.'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('existing target fails without --force', () => {
    const root = join(tmpdir(), `trade-artifact-fs-conflict-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const initial = writeBundleToDisk(bundle, { outRoot: root, visibility: 'unlisted' });
      assert.throws(() => writeBundleToDisk(bundle, { outRoot: root, visibility: 'unlisted' }), /--force/);
      assert.deepEqual(readdirSync(initial.targetDir).sort(), ['index.html', 'manifest.json', 'proof.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('force overwrites only the 3 managed files', () => {
    const root = join(tmpdir(), `trade-artifact-fs-force-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const initial = writeBundleToDisk(bundle, { outRoot: root, visibility: 'unlisted' });
      writeFileSync(initial.filePaths['index.html'], 'stale html', 'utf8');
      writeFileSync(initial.filePaths['proof.json'], 'stale proof', 'utf8');
      writeFileSync(initial.filePaths['manifest.json'], 'stale manifest', 'utf8');
      writeFileSync(join(initial.targetDir, 'extra.txt'), 'keep me', 'utf8');

      writeBundleToDisk(bundle, { outRoot: root, visibility: 'unlisted', force: true });

      assert.ok(readFileSync(initial.filePaths['index.html'], 'utf8').includes('Hosted proof page.'));
      assert.ok(readFileSync(initial.filePaths['proof.json'], 'utf8').includes('"publish"'));
      assert.ok(readFileSync(initial.filePaths['manifest.json'], 'utf8').includes('"bundle_version"'));
      assert.equal(readFileSync(join(initial.targetDir, 'extra.txt'), 'utf8'), 'keep me');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);


