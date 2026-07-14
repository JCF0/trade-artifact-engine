#!/usr/bin/env node

import assert from 'assert';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { buildInventorySnapshot, getInventoryReceipt, getLegacyInventoryReceipt } from './inventory.mjs';
import { buildReceiptArchiveBundle, writeReceiptArchiveBundle } from './archive-store.mjs';
import { createInventoryFixture, removeInventoryFixture } from './test-fixtures.mjs';
import { buildReceiptBoardView } from '../receipt-board/view-model.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mutateReceipt(root, originalHash, patch) {
  const path = join(root, 'data', 'debug', 'ledger-receipts-v12.json');
  const receipts = readJson(path).map(receipt => receipt.receipt_hash === originalHash ? { ...receipt, ...patch } : receipt);
  writeJson(path, receipts);
}

function mutateVerify(root, originalHash, patch) {
  const path = join(root, 'data', 'debug', 'ledger-verify-v12.json');
  const verify = readJson(path);
  verify.results = verify.results.map(result => result.receipt_hash === originalHash ? { ...result, ...patch } : result);
  writeJson(path, verify);
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

function archiveRecord(root, record) {
  writeReceiptArchiveBundle(buildReceiptArchiveBundle(record), { engineRoot: root });
}

function currentRecord(root, receiptHash) {
  return getInventoryReceipt(receiptHash, { engineRoot: root });
}

const jupHash = '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca';
const rayHash = '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341';
const zHash = 'f'.repeat(64);

test('current JUP-like snapshot plus archived RAY-like receipt returns both', () => {
  const fixture = createInventoryFixture();
  try {
    mutateReceipt(fixture.root, fixture.hashes.receiptAHash, {
      receipt_hash: jupHash,
      receipt_id: 'art_v12_cp_JUP_0',
      token_mint: 'JUP_TOKEN',
    });
    mutateVerify(fixture.root, fixture.hashes.receiptAHash, {
      receipt_hash: jupHash,
      receipt_id: 'art_v12_cp_JUP_0',
      recomputed_hash: jupHash,
    });
    const rayRecord = {
      ...currentRecord(fixture.root, fixture.hashes.receiptBHash),
      receipt_hash: rayHash,
      receipt_id: 'art_v12_cp_RAY_0',
      receipt_type: 'closed_position',
      token_mint: 'RAY_TOKEN',
      verification_status: 'verified',
      display_status: 'Verified Closed Position',
      proof_summary: { verification_status: 'verified', violations: 0 },
    };
    archiveRecord(fixture.root, rayRecord);

    const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });

    assert.ok(snapshot.receipts.some(receipt => receipt.receipt_hash === jupHash));
    assert.ok(snapshot.receipts.some(receipt => receipt.receipt_hash === rayHash));
    assert.equal(snapshot.archive.included, true);
    assert.equal(snapshot.archive.counts.bundles_read, 1);
    assert.deepEqual(snapshot.archive.diagnostics, []);
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('archive-only receipt resolves when enabled', () => {
  const fixture = createInventoryFixture();
  try {
    const archived = { ...currentRecord(fixture.root, fixture.hashes.receiptAHash), receipt_hash: rayHash, receipt_id: 'art_v12_cp_RAY_0' };
    archiveRecord(fixture.root, archived);

    assert.equal(getInventoryReceipt(rayHash, { engineRoot: fixture.root }), null);
    assert.equal(getInventoryReceipt(rayHash, { engineRoot: fixture.root, includeArchive: true }).receipt_hash, rayHash);
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('archive is ignored when option is false or omitted', () => {
  const fixture = createInventoryFixture();
  try {
    archiveRecord(fixture.root, { ...currentRecord(fixture.root, fixture.hashes.receiptAHash), receipt_hash: rayHash, receipt_id: 'art_v12_cp_RAY_0' });

    assert.equal(buildInventorySnapshot({ engineRoot: fixture.root }).counts.receipts, 2);
    assert.equal(buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: false }).counts.receipts, 2);
    assert.equal(buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true }).counts.receipts, 3);
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('identical current and archive receipt dedupes to one entry', () => {
  const fixture = createInventoryFixture();
  try {
    archiveRecord(fixture.root, currentRecord(fixture.root, fixture.hashes.receiptAHash));
    const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });

    assert.equal(snapshot.receipts.filter(receipt => receipt.receipt_hash === fixture.hashes.receiptAHash).length, 1);
    assert.deepEqual(snapshot.archive.diagnostics, []);
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('canonical conflict reports and excludes conflicting record', () => {
  const fixture = createInventoryFixture();
  try {
    const record = currentRecord(fixture.root, fixture.hashes.receiptAHash);
    archiveRecord(fixture.root, { ...record, token_mint: 'DIFFERENT_CANONICAL_TOKEN' });
    const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });

    assert.equal(snapshot.receipts.some(receipt => receipt.receipt_hash === fixture.hashes.receiptAHash), false);
    assert.equal(snapshot.archive.diagnostics[0].code, 'receipt_hash_conflict');
    assert.equal(snapshot.archive.diagnostics[0].receipt_hash, fixture.hashes.receiptAHash);
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('materially different proof state reports conflict', () => {
  const fixture = createInventoryFixture();
  try {
    const record = currentRecord(fixture.root, fixture.hashes.receiptAHash);
    archiveRecord(fixture.root, { ...record, verifier_passed: false });
    const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });

    assert.equal(snapshot.receipts.some(receipt => receipt.receipt_hash === fixture.hashes.receiptAHash), false);
    assert.equal(snapshot.archive.diagnostics[0].code, 'receipt_archive_bundle_conflict');
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('corrupt bundle produces diagnostics without partial or duplicate inventory', () => {
  const fixture = createInventoryFixture();
  try {
    mkdirSync(join(fixture.root, 'data', 'inventory', 'receipt-archive-v1', 'receipts'), { recursive: true });
    writeFileSync(join(fixture.root, 'data', 'inventory', 'receipt-archive-v1', 'receipts', `${zHash}.json`), '{ corrupt json', 'utf8');

    const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });

    assert.equal(snapshot.counts.receipts, 2);
    assert.equal(snapshot.archive.counts.bundles_read, 0);
    assert.equal(snapshot.archive.diagnostics[0].code, 'corrupt_archive_bundle');
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('non-verified archived receipt remains in inventory but gains no board eligibility', () => {
  const fixture = createInventoryFixture();
  try {
    const archived = {
      ...currentRecord(fixture.root, fixture.hashes.receiptAHash),
      receipt_hash: rayHash,
      receipt_id: 'art_v12_cp_RAY_0',
      verification_status: 'unverified',
      proof_summary: { verification_status: 'unverified', violations: 1 },
    };
    archiveRecord(fixture.root, archived);
    writeManifest(fixture.root, rayHash);

    const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });
    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(snapshot.receipts.some(receipt => receipt.receipt_hash === rayHash), true);
    assert.equal(board.rows.some(row => row.receipt_hash === rayHash), false);
    assert.equal(board.excluded_entries[0].reason, 'missing_receipt');
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('legacy verification hash does not resolve v1.2 receipt', () => {
  const fixture = createInventoryFixture();
  try {
    archiveRecord(fixture.root, { ...currentRecord(fixture.root, fixture.hashes.receiptAHash), receipt_hash: rayHash, receipt_id: 'art_v12_cp_RAY_0' });

    assert.equal(getLegacyInventoryReceipt(rayHash, { engineRoot: fixture.root, includeArchive: true }), null);
    assert.equal(getInventoryReceipt(fixture.hashes.legacyHash, { engineRoot: fixture.root, includeArchive: true }), null);
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('board-facing structures do not expose new wallet fields from archive integration', () => {
  const fixture = createInventoryFixture();
  try {
    archiveRecord(fixture.root, { ...currentRecord(fixture.root, fixture.hashes.receiptAHash), receipt_hash: rayHash, receipt_id: 'art_v12_cp_RAY_0' });
    writeManifest(fixture.root, fixture.hashes.receiptAHash);

    const board = buildReceiptBoardView({ engineRoot: fixture.root });
    const serialized = JSON.stringify(board);

    assert.equal(board.rows.length, 1);
    assert.ok(!Object.hasOwn(board.rows[0], 'wallet'));
    assert.ok(!serialized.includes('proof_wallet_pubkey'));
    assert.ok(!serialized.includes('mint_authority_pubkey'));
    assert.ok(!serialized.includes('token_account'));
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

console.log(`\nArchive-backed inventory tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

