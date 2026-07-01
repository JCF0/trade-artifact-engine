import assert from 'assert';
import http from 'http';

import {
  createInventoryFixture,
  removeInventoryFixture,
} from '../inventory/test-fixtures.mjs';

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
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    }).on('error', reject);
  });
}

const fixture = createInventoryFixture();
process.env.TRADE_ARTIFACT_TEST = '1';
process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;

const { app } = await import('./server.mjs');
const server = await new Promise((resolve, reject) => {
  const listener = app.listen(0, () => resolve(listener));
  listener.on('error', reject);
});
const port = server.address().port;

try {
  await test('GET /inventory returns v1.2 receipts keyed by receipt_hash', async () => {
    const response = await httpGet(port, '/inventory');
    assert.equal(response.status, 200);
    assert.equal(response.body.counts.receipts, 2);
    assert.equal(response.body.receipts[0].receipt_hash.length, 64);
    assert.equal(response.body.legacy_receipts.length, 0);
  });

  await test('GET /inventory supports filtering without mixing proof lifecycle fields', async () => {
    const response = await httpGet(port, '/inventory?mint_status=minted');
    assert.equal(response.status, 200);
    assert.equal(response.body.counts.receipts, 1);
    assert.equal(response.body.receipts[0].mint_status, 'minted');
    assert.equal(response.body.receipts[0].hash_valid, true);
    assert.equal(response.body.receipts[0].verification_status, 'verified');
  });

  await test('GET /inventory/:receiptHash returns a single receipt', async () => {
    const response = await httpGet(port, `/inventory/${fixture.hashes.receiptBHash}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.receipt.receipt_hash, fixture.hashes.receiptBHash);
    assert.equal(response.body.receipt.valuation_status, 'raw_quote');
  });

  await test('GET /inventory/:receiptHash returns 404 for unknown receipt_hash', async () => {
    const response = await httpGet(port, `/inventory/${'9'.repeat(64)}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, `No inventory receipt found for receipt_hash: ${'9'.repeat(64)}`);
  });

  await test('GET /inventory/legacy stays separate and excludes test data by default', async () => {
    const response = await httpGet(port, '/inventory/legacy');
    assert.equal(response.status, 200);
    assert.equal(response.body.count, 1);
    assert.equal(response.body.legacy_receipts[0].verification_hash, fixture.hashes.legacyHash);
  });

  await test('GET /inventory/legacy/:verificationHash returns 404 for unknown legacy verification_hash', async () => {
    const unknownHash = '8'.repeat(64);
    const response = await httpGet(port, `/inventory/legacy/${unknownHash}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, `No legacy receipt found for verification_hash: ${unknownHash}`);
  });

  await test('GET /inventory/legacy can include excluded directories explicitly', async () => {
    const response = await httpGet(port, '/inventory/legacy?include_excluded=true');
    assert.equal(response.status, 200);
    assert.equal(response.body.count, 4);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  removeInventoryFixture(fixture.root);
  delete process.env.TRADE_ARTIFACT_TEST;
  delete process.env.TRADE_ARTIFACT_INVENTORY_ROOT;
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
