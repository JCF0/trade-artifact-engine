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
  await test('GET /api/proof/:receiptHash returns 200 for known receipt', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.receipt.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(response.body.receipt.verification_status, 'verified');
  });


  await test('proof detail and verifier expose deep-equal core coverage statements', async () => {
    const proofResponse = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}`);
    const verifierResponse = await httpGet(port, `/api/verifier/${fixture.hashes.receiptAHash}`);

    assert.equal(proofResponse.status, 200);
    assert.equal(verifierResponse.status, 200);
    assert.equal(proofResponse.body.coverage_statement.coverage_statement_version, 'receipt_coverage_v1');
    assert.equal(proofResponse.body.coverage_statement.publication_context, null);
    assert.equal(proofResponse.body.coverage_statement.valuation_basis.usd_normalized, false);
    assert.deepEqual(proofResponse.body.coverage_statement, verifierResponse.body.coverage_statement);
  });

  await test('GET /api/proof/:receiptHash returns 404 for unknown receipt', async () => {
    const unknownHash = '9'.repeat(64);
    const response = await httpGet(port, `/api/proof/${unknownHash}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, `No proof detail found for receipt_hash: ${unknownHash}`);
  });

  await test('proof detail response includes expected top-level sections', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptBHash}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body), [
      'receipt',
      'verification',
      'coverage_statement',
      'valuation',
      'proof_lifecycle',
      'artifacts',
      'legacy',
      'links',
      'trust',
      'flags_and_limitations',
    ]);
  });

  await test('proof detail route does not use legacy verification_hash lookup by default', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.legacyHash}`);
    assert.equal(response.status, 404);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  removeInventoryFixture(fixture.root);
  delete process.env.TRADE_ARTIFACT_TEST;
  delete process.env.TRADE_ARTIFACT_INVENTORY_ROOT;
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
