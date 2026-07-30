#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolve } from 'node:path';

import { buildInventorySnapshot } from '../inventory/inventory.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofVerifierView } from '../proof-verifier/view-model.mjs';
import { buildProofGalleryView } from '../proof-gallery/view-model.mjs';
import { app, createApp } from './server.mjs';

const ENGINE_ROOT = resolve('engine');
const PACKAGE_ROOT = '/root/artifact-data/receipt-packages-v1';
const ARCHIVE_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-archive-v1');
const ECONOMICS_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-economics-v1');
const JUP_HASH = '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca';

const configuredApp = createApp({
  engineRoot: ENGINE_ROOT,
  packageRoot: PACKAGE_ROOT,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
});
assert.notEqual(configuredApp, app);
for (const key of ['engineRoot', 'archiveRoot', 'economicsRoot']) {
  const options = {
    engineRoot: ENGINE_ROOT,
    packageRoot: PACKAGE_ROOT,
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
  };
  delete options[key];
  assert.throws(() => createApp(options), TypeError);
}
function get(port, path) {
  return new Promise((resolveResponse, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolveResponse({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

const legacySnapshot = buildInventorySnapshot({
  engineRoot: ENGINE_ROOT,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
  includeArchive: true,
});
const legacyJup = legacySnapshot.receipts.find(receipt => receipt.receipt_hash === JUP_HASH);
const packageSnapshot = await buildInventorySnapshot({
  engineRoot: ENGINE_ROOT,
  packageRoot: PACKAGE_ROOT,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
  includeExcluded: false,
});
const packageJup = packageSnapshot.receipts.find(receipt => receipt.receipt_hash === JUP_HASH);
const packageGallery = await buildProofGalleryView({
  engineRoot: ENGINE_ROOT,
  packageRoot: PACKAGE_ROOT,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
});
const listener = await new Promise((resolveListener, reject) => {
  const candidate = configuredApp.listen(0, '127.0.0.1', () => resolveListener(candidate));
  candidate.on('error', reject);
});
try {
  const proof = await get(listener.address().port, `/api/proof/${JUP_HASH}`);
  const verifier = await get(listener.address().port, `/api/verifier/${JUP_HASH}`);
  const inventory = await get(listener.address().port, '/api/inventory');
  const inventoryReceipt = await get(listener.address().port, `/inventory/${JUP_HASH}`);
  const gallery = await get(listener.address().port, '/api/gallery');
  const malformedProof = await get(listener.address().port, '/api/proof/not-a-hash');
  const malformedHosted = await get(listener.address().port, '/api/proof/not-a-hash/hosted-preview');
  const malformedExport = await get(listener.address().port, '/api/proof/not-a-hash/export');
  assert.equal(proof.status, 200);
  assert.equal(verifier.status, 200);
  assert.deepEqual(JSON.parse(proof.body), buildProofDetailView(legacyJup));
  assert.deepEqual(JSON.parse(verifier.body), buildProofVerifierView(legacyJup));
  const inventoryBody = JSON.parse(inventory.body);
  const expectedInventory = structuredClone(packageSnapshot);
  delete inventoryBody.generated_at;
  delete expectedInventory.generated_at;
  assert.deepEqual(inventoryBody, expectedInventory);
  assert.deepEqual(JSON.parse(inventoryReceipt.body), { receipt: packageJup });
  assert.deepEqual(JSON.parse(gallery.body), packageGallery);
  assert.equal(malformedProof.status, 400);
  assert.equal(malformedHosted.status, 400);
  assert.equal(malformedExport.status, 400);
  for (const value of [PACKAGE_ROOT, 'package_digest', 'manifest.json', 'verification.json']) {
    assert.equal(`${proof.body}\n${verifier.body}`.includes(value), false);
  }
} finally {
  await new Promise(resolveClose => listener.close(resolveClose));
}

console.log('package-native API/app builder: PASS');
