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
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
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
  await test('GET /api/verifier/:receiptHash returns 200 with compact verifier shape', async () => {
    const response = await httpGet(port, `/api/verifier/${fixture.hashes.receiptAHash}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body), [
      'receipt_hash',
      'receipt_id',
      'receipt_type',
      'valuation_status',
      'coverage_statement',
      'verification',
      'trust',
      'disclosures',
      'instructions',
    ]);
    assert.equal(response.body.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(response.body.receipt_id, 'art_v12_cp_TEST_0');
    assert.equal(response.body.receipt_type, 'closed_position');
    assert.equal(response.body.valuation_status, 'raw_quote');
    assert.deepEqual(response.body.verification, {
      recomputed_hash: fixture.hashes.receiptAHash,
      hash_valid: true,
      verifier_passed: true,
      verifier_schema_valid: true,
      verifier_consistency_valid: true,
      verifier_rule_violations: [],
    });
  });


  await test('GET /api/verifier/:receiptHash exposes core coverage statement', async () => {
    const response = await httpGet(port, `/api/verifier/${fixture.hashes.receiptAHash}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.coverage_statement.coverage_statement_version, 'receipt_coverage_v1');
    assert.equal(response.body.coverage_statement.scope.scope_type, 'receipt');
    assert.equal(response.body.coverage_statement.publication_context, null);
    assert.equal(response.body.coverage_statement.valuation_basis.valuation_status, 'raw_quote');
    assert.equal(response.body.coverage_statement.valuation_basis.usd_normalized, false);
  });

  await test('GET /api/verifier/:receiptHash includes trust and disclosures', async () => {
    const response = await httpGet(port, `/api/verifier/${fixture.hashes.receiptAHash}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.trust, {
      current_level: 4,
      current_code: 'source_anchored',
      current_label: 'Source Anchored',
    });
    assert.ok(response.body.disclosures.includes('Selected receipt only. Not a portfolio statement.'));
    assert.ok(response.body.disclosures.includes('Raw quote only. No USD normalization.'));
    assert.ok(response.body.disclosures.includes('Hosted, unlisted, and private labels describe display or distribution choices only. They do not increase proof strength.'));
    assert.ok(response.body.instructions.summary.includes('does not rerun the ledger verifier'));
    assert.equal(response.body.instructions.mode, 'local_inventory_backed');
    assert.equal(response.body.instructions.proof_api_path, `/api/proof/${fixture.hashes.receiptAHash}`);
    assert.equal(response.body.instructions.inventory_api_path, `/inventory/${fixture.hashes.receiptAHash}`);
    assert.equal(response.body.instructions.local_command_template, 'node engine/src/verify/verify-receipt.mjs <receipt.json>');
  });

  await test('GET /api/verifier/:receiptHash returns 404 for unknown well-formed hash', async () => {
    const unknownHash = '9'.repeat(64);
    const response = await httpGet(port, `/api/verifier/${unknownHash}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, `No verifier record found for receipt_hash: ${unknownHash}`);
  });

  await test('GET /api/verifier/:receiptHash returns 400 for malformed receipt_hash', async () => {
    const response = await httpGet(port, '/api/verifier/not-a-hash');
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Malformed receipt_hash: not-a-hash');
  });

  await test('GET /api/verifier/:receiptHash returns 400 for uppercase 64-char receipt_hash', async () => {
    const uppercaseHash = 'A'.repeat(64);
    const response = await httpGet(port, `/api/verifier/${uppercaseHash}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, `Malformed receipt_hash: ${uppercaseHash}`);
  });

  await test('GET /api/verifier/:receiptHash does not resolve legacy verification_hash values', async () => {
    const response = await httpGet(port, `/api/verifier/${fixture.hashes.legacyHash}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, `No verifier record found for receipt_hash: ${fixture.hashes.legacyHash}`);
  });

  await test('GET /api/verifier/:receiptHash does not create files or use network', async () => {
    const before = listTree(fixture.root);
    const fetchCallsBefore = fetchCalls;
    const response = await httpGet(port, `/api/verifier/${fixture.hashes.receiptBHash}`);
    const after = listTree(fixture.root);

    assert.equal(response.status, 200);
    assert.deepEqual(before, after);
    assert.equal(fetchCalls, fetchCallsBefore);
  });

  await test('GET /api/verifier/:receiptHash keeps verifier fields distinct from lifecycle/status fields', async () => {
    const response = await httpGet(port, `/api/verifier/${fixture.hashes.receiptBHash}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.verification.verification_status, undefined);
    assert.equal(response.body.verification.upload_status, undefined);
    assert.equal(response.body.verification.mint_status, undefined);
    assert.equal(response.body.receipt_type, 'open_snapshot');
    assert.equal(response.body.valuation_status, 'raw_quote');
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
