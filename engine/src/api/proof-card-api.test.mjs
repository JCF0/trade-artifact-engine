import assert from 'assert';
import { readdirSync, statSync } from 'fs';
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
  await test('GET /api/proof/:receiptHash/card returns 200 for known receipt', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/card`);
    assert.equal(response.status, 200);
    assert.equal(response.body.card_type, 'artifact_proof_card');
    assert.equal(response.body.receipt.receipt_hash, fixture.hashes.receiptAHash);
  });

  await test('GET /api/proof/:receiptHash/card/preview returns standalone HTML', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/card/preview?wallet_display=truncated`);
    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].includes('text/html'));
    assert.ok(response.body.includes('<!DOCTYPE html>'));
    assert.ok(response.body.includes('Artifact Proof'));
  });

  await test('API card routes return 404 for unknown well-formed hash', async () => {
    const unknownHash = '9'.repeat(64);
    const card = await httpGet(port, `/api/proof/${unknownHash}/card`);
    const preview = await httpGet(port, `/api/proof/${unknownHash}/card/preview`);
    assert.equal(card.status, 404);
    assert.equal(preview.status, 404);
  });

  await test('API card routes return 400 for malformed hash', async () => {
    const card = await httpGet(port, '/api/proof/not-a-hash/card');
    const preview = await httpGet(port, '/api/proof/not-a-hash/card/preview');
    assert.equal(card.status, 400);
    assert.equal(preview.status, 400);
  });

  await test('API card routes do not use legacy verification_hash fallback', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.legacyHash}/card`);
    assert.equal(response.status, 404);
  });

  await test('API card routes create no files or directories and make no network calls', async () => {
    const before = listTree(fixture.root);
    const fetchCallsBefore = fetchCalls;
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptBHash}/card/preview?wallet_display=redacted`);
    const after = listTree(fixture.root);
    assert.equal(response.status, 200);
    assert.deepEqual(before, after);
    assert.equal(fetchCalls, fetchCallsBefore);
  });
}
finally {
  await new Promise(resolve => server.close(resolve));
  removeInventoryFixture(fixture.root);
  delete process.env.TRADE_ARTIFACT_TEST;
  delete process.env.TRADE_ARTIFACT_INVENTORY_ROOT;
  globalThis.fetch = originalFetch;
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);