import assert from 'assert';
import http from 'http';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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
const receiptsPath = join(fixture.root, 'data', 'debug', 'ledger-receipts-v12.json');
const receipts = JSON.parse(readFileSync(receiptsPath, 'utf8'));
receipts[0].wallet = 'TESTWALLET12345678901234567890123456789012345';
writeFileSync(receiptsPath, `${JSON.stringify(receipts, null, 2)}\n`, 'utf8');

process.env.TRADE_ARTIFACT_TEST = '1';
process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;

const { app } = await import('./server.mjs');
const server = await new Promise((resolve, reject) => {
  const listener = app.listen(0, () => resolve(listener));
  listener.on('error', reject);
});
const port = server.address().port;

try {
  await test('hosted-preview returns 200 HTML for known receipt_hash', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview`);
    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].includes('text/html'));
    assert.ok(response.body.includes('<!DOCTYPE html>'));
  });

  await test('hosted-preview returns 404 for unknown receipt_hash', async () => {
    const unknownHash = '9'.repeat(64);
    const response = await httpGet(port, `/api/proof/${unknownHash}/hosted-preview`);
    assert.equal(response.status, 404);
    assert.equal(JSON.parse(response.body).error, `No hosted proof preview found for receipt_hash: ${unknownHash}`);
  });

  await test('hosted-preview returns 400 for invalid visibility', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview?visibility=secret`);
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error, 'Invalid visibility: secret');
  });

  await test('hosted-preview returns 400 for invalid wallet_display', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview?wallet_display=masked`);
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error, 'Invalid wallet_display: masked');
  });

  await test('hosted-preview returns 400 for invalid base_url', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview?base_url=example.com`);
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error, 'base_url must start with http:// or https://');
  });

  await test('hosted-preview unlisted framing is correct', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview?visibility=unlisted`);
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('Hosted proof page.'));
    assert.ok(response.body.includes('Unlisted does not mean private. Anyone with the link can view.'));
  });

  await test('hosted-preview public framing is correct', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview?visibility=public`);
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('Public hosted proof page.'));
    assert.ok(!response.body.includes('Unlisted does not mean private. Anyone with the link can view.'));
  });

  await test('hosted-preview private framing is correct', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview?visibility=private`);
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('Private draft proof page.'));
    assert.ok(response.body.includes('Private here means local draft semantics only. Do not assume server-side privacy.'));
  });

  await test('hosted-preview truncated wallet does not leak full wallet', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview?wallet_display=truncated`);
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('TESTWA...2345'));
    assert.ok(!response.body.includes('TESTWALLET12345678901234567890123456789012345'));
  });

  await test('hosted-preview redacted wallet does not leak full wallet', async () => {
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview?wallet_display=redacted`);
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('[redacted]'));
    assert.ok(!response.body.includes('TESTWALLET12345678901234567890123456789012345'));
  });

  await test('hosted-preview creates no files or directories', async () => {
    const publishedPath = join(fixture.root, 'data', 'published');
    const draftsPath = join(fixture.root, 'data', 'drafts');
    assert.equal(existsSync(publishedPath), false);
    assert.equal(existsSync(draftsPath), false);
    const response = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview?visibility=public&wallet_display=redacted`);
    assert.equal(response.status, 200);
    assert.equal(existsSync(publishedPath), false);
    assert.equal(existsSync(draftsPath), false);
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  removeInventoryFixture(fixture.root);
  delete process.env.TRADE_ARTIFACT_TEST;
  delete process.env.TRADE_ARTIFACT_INVENTORY_ROOT;
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
