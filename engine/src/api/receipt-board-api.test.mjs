import assert from 'assert';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
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

function writeManifest(root, entries, ranking = {}) {
  const samplesDir = join(root, 'samples');
  mkdirSync(samplesDir, { recursive: true });
  writeFileSync(join(samplesDir, 'historical-receipt-board.manifest.json'), `${JSON.stringify({
    version: '1.0.0',
    board_id: 'historical_verified_receipt_board_demo',
    title: 'Historical Verified Receipt Board',
    subtitle: 'Selected historical receipts only. Not a trader leaderboard.',
    selection_scope: {
      mode: 'publisher_selected',
      statement: 'Publisher-selected sample receipts for local prototype demonstration.',
    },
    ranking: {
      metric: 'trust_then_time',
      direction: 'desc',
      rank_subject: 'receipt',
      pnl_scope: 'none',
      ...ranking,
    },
    entries,
  }, null, 2)}\n`, 'utf8');
}

function entry(receiptHash, displayName = 'Entry 1') {
  return {
    receipt_hash: receiptHash,
    display_name: displayName,
    participant_ref: 'local-entry-1',
    selection_note: 'Demo receipt selected by publisher.',
  };
}

function mutateReceipt(root, receiptHash, patch) {
  const path = join(root, 'data', 'debug', 'ledger-receipts-v12.json');
  const receipts = JSON.parse(readFileSync(path, 'utf8')).map(receipt => (
    receipt.receipt_hash === receiptHash ? { ...receipt, ...patch } : receipt
  ));
  writeFileSync(path, JSON.stringify(receipts, null, 2) + '\n', 'utf8');
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

function assertNoOverclaimLanguage(value) {
  const normalized = String(value).toLowerCase();
  assert.ok(!normalized.includes('best trader'));
  assert.ok(!normalized.includes('top wallet'));
  assert.ok(!normalized.includes('wallet rank'));
  assert.ok(!normalized.includes('winner'));
  assert.ok(!normalized.includes('performance'));
  assert.ok(!normalized.includes('track record'));
  assert.ok(normalized.includes('not a trader leaderboard'));
  assert.ok(normalized.includes('not traders, wallets, portfolios, or skill'));
}

const fixture = createInventoryFixture();
writeManifest(fixture.root, [
  entry(fixture.hashes.receiptAHash),
  entry('9'.repeat(64), 'Missing Entry'),
]);
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
  await test('GET /api/receipt-board returns 200 JSON board view-model', async () => {
    const response = await httpGet(port, '/api/receipt-board');

    assert.equal(response.status, 200);
    assert.equal(response.body.board_type, 'artifact_historical_verified_receipt_board');
    assert.equal(response.body.title, 'Historical Verified Receipt Board');
    assert.equal(response.body.ranking.metric, 'trust_then_time');
    assert.equal(response.body.ranking.pnl_scope, 'none');
    assert.equal(response.body.rows.length, 1);
    assert.equal(response.body.rows[0].receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(response.body.excluded_entries.length, 1);
    assert.equal(response.body.excluded_entries[0].reason, 'missing_receipt');
    assert.ok(response.body.disclosures.includes('Ranks selected receipts only. Not traders, wallets, portfolios, or skill.'));
  });

  await test('GET /api/receipt-board/preview returns 200 HTML', async () => {
    const response = await httpGet(port, '/api/receipt-board/preview');

    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].includes('text/html'));
    assert.ok(response.body.includes('<!DOCTYPE html>'));
    assert.ok(response.body.includes('Receipt entries only'));
    assert.ok(response.body.includes('Ranks selected receipts only. Not traders, wallets, portfolios, or skill.'));
  });

  await test('preview avoids overclaim language except explicit negative disclaimers', async () => {
    const response = await httpGet(port, '/api/receipt-board/preview');

    assert.equal(response.status, 200);
    assertNoOverclaimLanguage(response.body);
  });

  await test('invalid wallet_display returns 400 on both routes', async () => {
    const jsonResponse = await httpGet(port, '/api/receipt-board?wallet_display=bad');
    const htmlResponse = await httpGet(port, '/api/receipt-board/preview?wallet_display=bad');

    assert.equal(jsonResponse.status, 400);
    assert.equal(jsonResponse.body.error, 'Invalid wallet_display: bad');
    assert.equal(htmlResponse.status, 400);
    assert.equal(htmlResponse.body.error, 'Invalid wallet_display: bad');
  });

  await test('legacy verification_hash does not resolve', async () => {
    writeManifest(fixture.root, [
      entry(fixture.hashes.legacyHash, 'Legacy Only'),
    ]);

    const response = await httpGet(port, '/api/receipt-board');

    assert.equal(response.status, 200);
    assert.equal(response.body.rows.length, 0);
    assert.equal(response.body.excluded_entries[0].reason, 'missing_receipt');
  });

  await test('route creates no files or directories during request handling', async () => {
    writeManifest(fixture.root, [
      entry(fixture.hashes.receiptAHash),
    ]);
    const before = listTree(fixture.root);
    const response = await httpGet(port, '/api/receipt-board/preview?limit=1&offset=0');
    const after = listTree(fixture.root);

    assert.equal(response.status, 200);
    assert.deepEqual(before, after);
  });

  await test('route performs no network or fetch calls', async () => {
    const fetchCallsBefore = fetchCalls;
    const response = await httpGet(port, '/api/receipt-board');

    assert.equal(response.status, 200);
    assert.equal(fetchCalls, fetchCallsBefore);
  });

  await test('empty and missing entries stay safe', async () => {
    writeManifest(fixture.root, []);
    const emptyResponse = await httpGet(port, '/api/receipt-board');
    writeManifest(fixture.root, [
      entry('8'.repeat(64), 'Missing Entry'),
    ]);
    const missingResponse = await httpGet(port, '/api/receipt-board');

    assert.equal(emptyResponse.status, 200);
    assert.equal(emptyResponse.body.empty, true);
    assert.deepEqual(emptyResponse.body.rows, []);
    assert.equal(missingResponse.status, 200);
    assert.equal(missingResponse.body.rows.length, 0);
    assert.equal(missingResponse.body.excluded_entries[0].reason, 'missing_receipt');
  });

  await test('include_excluded=false hides excluded entries', async () => {
    writeManifest(fixture.root, [
      entry('7'.repeat(64), 'Missing Entry'),
    ]);

    const response = await httpGet(port, '/api/receipt-board?include_excluded=false');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.excluded_entries, []);
  });

  await test('limit and offset page ranked rows', async () => {
    mutateReceipt(fixture.root, fixture.hashes.receiptBHash, { verification_status: 'verified' });
    writeManifest(fixture.root, [
      entry(fixture.hashes.receiptAHash, 'Entry A'),
      entry(fixture.hashes.receiptBHash, 'Entry B'),
    ]);

    const response = await httpGet(port, '/api/receipt-board?limit=1&offset=1');

    assert.equal(response.status, 200);
    assert.equal(response.body.rows.length, 1);
    assert.equal(response.body.count, 1);
  });

  await test('JSON route does not include PnL, USD value, or performance fields', async () => {
    writeManifest(fixture.root, [
      entry(fixture.hashes.receiptAHash),
    ]);
    const response = await httpGet(port, '/api/receipt-board');
    const serialized = JSON.stringify(response.body).toLowerCase();

    assert.equal(response.status, 200);
    assert.ok(!serialized.includes('realized_pnl'));
    assert.ok(!serialized.includes('pnl_pct'));
    assert.ok(!serialized.includes('usd_value'));
    assert.ok(!serialized.includes('usd_return'));
    assert.ok(!serialized.includes('performance'));
  });

  await test('HTML route does not include lifecycle, upload, mint, transaction, or artifact fields', async () => {
    const response = await httpGet(port, '/api/receipt-board/preview');
    const normalized = response.body.toLowerCase();

    assert.equal(response.status, 200);
    assert.ok(!normalized.includes('lifecycle'));
    assert.ok(!normalized.includes('upload'));
    assert.ok(!normalized.includes('mint address'));
    assert.ok(!normalized.includes('transaction signature'));
    assert.ok(!normalized.includes('token account'));
    assert.ok(!normalized.includes('proof wallet'));
    assert.ok(!normalized.includes('mint authority'));
    assert.ok(!normalized.includes('artifact uri'));
  });

  await test('wallet_display redacted and truncated do not leak wallet data', async () => {
    writeManifest(fixture.root, [
      entry(fixture.hashes.receiptAHash),
    ]);

    const redacted = await httpGet(port, '/api/receipt-board?wallet_display=redacted');
    const truncated = await httpGet(port, '/api/receipt-board/preview?wallet_display=truncated');

    assert.equal(redacted.status, 200);
    assert.equal(truncated.status, 200);
    assert.ok(!JSON.stringify(redacted.body).includes('TEST_WALLET'));
    assert.ok(!truncated.body.includes('TEST_WALLET'));
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
