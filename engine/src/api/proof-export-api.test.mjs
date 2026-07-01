import assert from 'assert';
import http from 'http';

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
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
      }));
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
  await test('GET /api/proof/:receiptHash/export returns 200 HTML for known receipt', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/export`);
    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].includes('text/html'));
    assert.ok(response.body.includes('<!DOCTYPE html>'));
    assert.ok(response.body.includes('Selected receipt only.'));
    assert.ok(response.body.includes('Raw quote only. No USD normalization.'));
  });

  await test('GET /api/proof/:receiptHash/export returns 404 for unknown receipt', async () => {
    const unknownHash = '9'.repeat(64);
    const response = await httpGet(port, `/api/proof/${unknownHash}/export`);
    assert.equal(response.status, 404);
    assert.equal(JSON.parse(response.body).error, `No proof detail export found for receipt_hash: ${unknownHash}`);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  removeInventoryFixture(fixture.root);
  delete process.env.TRADE_ARTIFACT_TEST;
  delete process.env.TRADE_ARTIFACT_INVENTORY_ROOT;
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
