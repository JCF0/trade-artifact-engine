import assert from 'assert';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import http from 'http';
import { join, relative } from 'path';

import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';

let pass = 0;
let fail = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  PASS ${name}`);
    })
    .catch(error => {
      fail += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error.message}`);
    });
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

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, res => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    }).on('error', reject);
  });
}

function listTree(root, current = root, entries = []) {
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stats = statSync(path);
    entries.push({
      path: relative(root, path),
      isDirectory: stats.isDirectory(),
      size: stats.isFile() ? stats.size : null,
    });
    if (stats.isDirectory()) {
      listTree(root, path, entries);
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

const fixture = createInventoryFixture();
writeManifest(fixture.root, [fixture.hashes.receiptBHash, fixture.hashes.receiptAHash]);
process.env.TRADE_ARTIFACT_TEST = '1';
process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async (...args) => {
  fetchCalls += 1;
  if (typeof originalFetch === 'function') {
    return originalFetch(...args);
  }
  throw new Error(`Unexpected fetch call: ${String(args[0])}`);
};

const { app } = await import('./server.mjs');
const server = await new Promise((resolve, reject) => {
  const listener = app.listen(0, () => resolve(listener));
  listener.on('error', reject);
});
const port = server.address().port;

try {
  await test('API returns 200 JSON for /api/gallery', async () => {
    const response = await httpGet(port, '/api/gallery');
    assert.equal(response.status, 200);
    assert.equal(response.body.gallery_type, 'artifact_sample_gallery');
    assert.equal(response.body.count, 2);
    assert.equal(response.body.items[0].receipt_hash, fixture.hashes.receiptBHash);
  });

  await test('API returns 200 HTML for /api/gallery/preview', async () => {
    const response = await httpGet(port, '/api/gallery/preview?wallet_display=redacted');
    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].includes('text/html'));
    assert.ok(response.body.includes('<!DOCTYPE html>'));
    assert.ok(response.body.includes('Artifact Sample Gallery'));
  });

  await test('API returns 400 for invalid wallet_display on gallery routes', async () => {
    const jsonResponse = await httpGet(port, '/api/gallery?wallet_display=bad');
    const htmlResponse = await httpGet(port, '/api/gallery/preview?wallet_display=bad');
    assert.equal(jsonResponse.status, 400);
    assert.equal(jsonResponse.body.error, 'Invalid wallet_display: bad');
    assert.equal(htmlResponse.status, 400);
    assert.equal(htmlResponse.body.error, 'Invalid wallet_display: bad');
  });

  await test('API creates no files or directories during request handling', async () => {
    const before = listTree(fixture.root);
    const response = await httpGet(port, '/api/gallery?receipt_type=closed_position');
    const after = listTree(fixture.root);
    assert.equal(response.status, 200);
    assert.deepEqual(before, after);
  });

  await test('API performs no network or write behavior', async () => {
    const fetchCallsBefore = fetchCalls;
    const response = await httpGet(port, '/api/gallery/preview');
    assert.equal(response.status, 200);
    assert.equal(fetchCalls, fetchCallsBefore);
  });

  await test('legacy receipts are not surfaced by default', async () => {
    const response = await httpGet(port, '/api/gallery');
    assert.equal(response.status, 200);
    assert.ok(!response.body.items.some(item => item.receipt_hash === fixture.hashes.legacyHash));
  });

  await test('empty gallery returns and renders cleanly', async () => {
    writeManifest(fixture.root, ['9'.repeat(64)]);
    const jsonResponse = await httpGet(port, '/api/gallery');
    const htmlResponse = await httpGet(port, '/api/gallery/preview');
    assert.equal(jsonResponse.status, 200);
    assert.equal(jsonResponse.body.empty, true);
    assert.equal(jsonResponse.body.count, 0);
    assert.ok(htmlResponse.body.includes('No sample receipts are currently available.'));
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  removeInventoryFixture(fixture.root);
  delete process.env.TRADE_ARTIFACT_TEST;
  delete process.env.TRADE_ARTIFACT_INVENTORY_ROOT;
  globalThis.fetch = originalFetch;
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
