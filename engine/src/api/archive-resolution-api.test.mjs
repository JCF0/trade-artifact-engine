#!/usr/bin/env node

import assert from 'assert';
import http from 'http';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { buildInventorySnapshot, getInventoryReceipt } from '../inventory/inventory.mjs';
import { buildReceiptArchiveBundle, writeReceiptArchiveBundle } from '../inventory/archive-store.mjs';
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
      console.log(`       ${error.stack || error.message}`);
    });
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeManifest(root, receiptHash) {
  writeJson(join(root, 'samples', 'historical-receipt-board.manifest.json'), {
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
    },
    entries: [{
      receipt_hash: receiptHash,
      display_name: 'Archived Receipt',
      participant_ref: 'local-archived-receipt',
      selection_note: 'Archive-backed test receipt.',
    }],
  });
}

function currentRecord(root, receiptHash) {
  return getInventoryReceipt(receiptHash, { engineRoot: root });
}

function archiveRecord(root, record) {
  writeReceiptArchiveBundle(buildReceiptArchiveBundle(record), { engineRoot: root });
}

function makeArchivedRecord(root, sourceHash, targetHash, overrides = {}) {
  const source = currentRecord(root, sourceHash);
  return {
    ...source,
    receipt_hash: targetHash,
    receipt_id: overrides.receipt_id || `art_v12_cp_${targetHash.slice(0, 8)}_0`,
    receipt_type: overrides.receipt_type || 'closed_position',
    verification_status: overrides.verification_status || 'verified',
    display_status: overrides.display_status || 'Verified Closed Position',
    position_status: overrides.position_status || 'closed',
    token_mint: overrides.token_mint || 'ARCHIVED_TOKEN',
    hash_valid: overrides.hash_valid ?? true,
    recomputed_hash: targetHash,
    verifier_passed: overrides.verifier_passed ?? true,
    verifier_schema_valid: overrides.verifier_schema_valid ?? true,
    verifier_consistency_valid: overrides.verifier_consistency_valid ?? true,
    proof_summary: {
      verification_status: overrides.verification_status || 'verified',
      violations: overrides.violations ?? 0,
    },
    ...overrides.extraFields,
  };
}

function assertArchiveRelativeDiagnosticPath(diagnostic, receiptHash, root) {
  assert.equal(diagnostic.path, 'receipts/' + receiptHash + '.json');
  assert.ok(!diagnostic.path.includes('\\'));
  assert.ok(!diagnostic.path.includes(root));
  assert.ok(!/^[A-Za-z]:/.test(diagnostic.path));
  assert.ok(!diagnostic.path.startsWith('/'));
}

const archivedHash = '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341';
const corruptHash = '9'.repeat(64);

process.env.TRADE_ARTIFACT_TEST = '1';
const { app } = await import('./server.mjs');
const server = await new Promise((resolve, reject) => {
  const listener = app.listen(0, () => resolve(listener));
  listener.on('error', reject);
});
const port = server.address().port;

try {
  await test('archived-only verified receipt resolves on every proof surface', async () => {
    const fixture = createInventoryFixture();
    process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;
    try {
      archiveRecord(fixture.root, makeArchivedRecord(fixture.root, fixture.hashes.receiptAHash, archivedHash));

      const proof = await httpGet(port, `/api/proof/${archivedHash}`);
      const verifier = await httpGet(port, `/api/verifier/${archivedHash}`);
      const card = await httpGet(port, `/api/proof/${archivedHash}/card`);
      const cardPreview = await httpGet(port, `/api/proof/${archivedHash}/card/preview`);
      const exported = await httpGet(port, `/api/proof/${archivedHash}/export`);
      const hosted = await httpGet(port, `/api/proof/${archivedHash}/hosted-preview`);

      assert.equal(proof.status, 200);
      assert.equal(proof.body.receipt.receipt_hash, archivedHash);
      assert.equal(verifier.status, 200);
      assert.equal(verifier.body.receipt_hash, archivedHash);
      assert.equal(card.status, 200);
      assert.equal(card.body.receipt.receipt_hash, archivedHash);
      assert.equal(cardPreview.status, 200);
      assert.ok(cardPreview.headers['content-type'].includes('text/html'));
      assert.equal(exported.status, 200);
      assert.ok(exported.headers['content-type'].includes('text/html'));
      assert.equal(hosted.status, 200);
      assert.ok(hosted.headers['content-type'].includes('text/html'));
      assert.deepEqual(proof.body.coverage_statement, verifier.body.coverage_statement);
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('receipt board resolves archived verified closed-position receipt', async () => {
    const fixture = createInventoryFixture();
    process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;
    try {
      archiveRecord(fixture.root, makeArchivedRecord(fixture.root, fixture.hashes.receiptAHash, archivedHash));
      writeManifest(fixture.root, archivedHash);

      const board = await httpGet(port, '/api/receipt-board');
      const preview = await httpGet(port, '/api/receipt-board/preview');

      assert.equal(board.status, 200);
      assert.equal(board.body.rows.length, 1);
      assert.equal(board.body.rows[0].receipt_hash, archivedHash);
      assert.equal(board.body.rows[0].verification_status, 'verified');
      assert.equal(board.body.rows[0].coverage_statement.publication_context.surface, 'historical_receipt_board');
      assert.equal(board.body.excluded_entries.length, 0);
      assert.equal(preview.status, 200);
      assert.ok(preview.body.includes('Archived Receipt'));
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('archived unverified receipt remains excluded from board', async () => {
    const fixture = createInventoryFixture();
    process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;
    try {
      archiveRecord(fixture.root, makeArchivedRecord(fixture.root, fixture.hashes.receiptAHash, archivedHash, {
        verification_status: 'unverified',
        display_status: 'Unverified - See Limitations',
        violations: 1,
      }));
      writeManifest(fixture.root, archivedHash);

      const board = await httpGet(port, '/api/receipt-board');

      assert.equal(board.status, 200);
      assert.equal(board.body.rows.length, 0);
      assert.equal(board.body.excluded_entries[0].reason, 'verification_status_not_board_eligible');
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('corrupt archive receipt returns 404 and board missing_receipt without crashing', async () => {
    const fixture = createInventoryFixture();
    process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;
    try {
      mkdirSync(join(fixture.root, 'data', 'inventory', 'receipt-archive-v1', 'receipts'), { recursive: true });
      writeFileSync(join(fixture.root, 'data', 'inventory', 'receipt-archive-v1', 'receipts', `${corruptHash}.json`), '{ corrupt json', 'utf8');
      writeManifest(fixture.root, corruptHash);

      const proof = await httpGet(port, `/api/proof/${corruptHash}`);
      const card = await httpGet(port, `/api/proof/${corruptHash}/card`);
      const board = await httpGet(port, '/api/receipt-board');
      const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });

      assert.equal(proof.status, 404);
      assert.equal(card.status, 404);
      assert.equal(board.status, 200);
      assert.equal(board.body.rows.length, 0);
      assert.equal(board.body.excluded_entries[0].reason, 'missing_receipt');
      assert.equal(snapshot.archive.diagnostics[0].code, 'corrupt_archive_bundle');
      assertArchiveRelativeDiagnosticPath(snapshot.archive.diagnostics[0], corruptHash, fixture.root);
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('conflicting archive receipt returns 404 and board missing_receipt without crashing', async () => {
    const fixture = createInventoryFixture();
    process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;
    try {
      const current = currentRecord(fixture.root, fixture.hashes.receiptAHash);
      archiveRecord(fixture.root, { ...current, verifier_passed: false });
      writeManifest(fixture.root, fixture.hashes.receiptAHash);

      const proof = await httpGet(port, `/api/proof/${fixture.hashes.receiptAHash}`);
      const verifier = await httpGet(port, `/api/verifier/${fixture.hashes.receiptAHash}`);
      const board = await httpGet(port, '/api/receipt-board');
      const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });

      assert.equal(proof.status, 404);
      assert.equal(verifier.status, 404);
      assert.equal(board.status, 200);
      assert.equal(board.body.rows.length, 0);
      assert.equal(board.body.excluded_entries[0].reason, 'missing_receipt');
      assert.equal(snapshot.archive.diagnostics[0].code, 'receipt_archive_bundle_conflict');
      assertArchiveRelativeDiagnosticPath(snapshot.archive.diagnostics[0], fixture.hashes.receiptAHash, fixture.root);
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('default inventory API counts and query behavior remain unchanged', async () => {
    const fixture = createInventoryFixture();
    process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;
    try {
      archiveRecord(fixture.root, makeArchivedRecord(fixture.root, fixture.hashes.receiptAHash, archivedHash));

      const inventory = await httpGet(port, '/api/inventory');
      const inventoryWithQuery = await httpGet(port, '/api/inventory?include_archive=true');
      const directInventory = await httpGet(port, `/inventory/${archivedHash}`);
      const proof = await httpGet(port, `/api/proof/${archivedHash}`);

      assert.equal(inventory.status, 200);
      assert.equal(inventory.body.counts.receipts, 2);
      assert.ok(!Object.hasOwn(inventory.body, 'archive'));
      assert.equal(inventoryWithQuery.status, 200);
      assert.equal(inventoryWithQuery.body.counts.receipts, 2);
      assert.ok(!Object.hasOwn(inventoryWithQuery.body, 'archive'));
      assert.equal(directInventory.status, 404);
      assert.equal(proof.status, 200);
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('board rows expose no new wallet profile or portfolio fields', async () => {
    const fixture = createInventoryFixture();
    process.env.TRADE_ARTIFACT_INVENTORY_ROOT = fixture.root;
    try {
      archiveRecord(fixture.root, makeArchivedRecord(fixture.root, fixture.hashes.receiptAHash, archivedHash));
      writeManifest(fixture.root, archivedHash);

      const board = await httpGet(port, '/api/receipt-board');
      const serialized = JSON.stringify(board.body).toLowerCase();

      assert.equal(board.status, 200);
      assert.equal(board.body.rows.length, 1);
      assert.ok(!Object.hasOwn(board.body.rows[0], 'wallet'));
      assert.ok(!Object.hasOwn(board.body.rows[0], 'profile'));
      assert.ok(!Object.hasOwn(board.body.rows[0], 'portfolio'));
      assert.ok(!serialized.includes('proof_wallet_pubkey'));
      assert.ok(!serialized.includes('mint_authority_pubkey'));
      assert.ok(!serialized.includes('token_account'));
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  delete process.env.TRADE_ARTIFACT_TEST;
  delete process.env.TRADE_ARTIFACT_INVENTORY_ROOT;
}

console.log(`\nArchive resolution API tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
