import assert from 'assert';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildReceiptBoardView } from './view-model.mjs';

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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeManifest(root, manifest) {
  const samplesDir = join(root, 'samples');
  mkdirSync(samplesDir, { recursive: true });
  writeJson(join(samplesDir, 'historical-receipt-board.manifest.json'), manifest);
}

function baseManifest(entries, ranking = {}) {
  return {
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
  };
}

function manifestEntry(receiptHash, overrides = {}) {
  return {
    receipt_hash: receiptHash,
    display_name: overrides.display_name || 'Entry 1',
    participant_ref: overrides.participant_ref || 'local-entry-1',
    selection_note: overrides.selection_note || 'Demo receipt selected by publisher.',
  };
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
    if (stats.isDirectory()) listTree(root, path, entries);
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function mutateVerifyResult(root, receiptHash, patch) {
  const path = join(root, 'data', 'debug', 'ledger-verify-v12.json');
  const verify = readJson(path);
  verify.results = verify.results.map(result => (
    result.receipt_hash === receiptHash ? { ...result, ...patch } : result
  ));
  writeJson(path, verify);
}

function mutateReceipt(root, receiptHash, patch) {
  const path = join(root, 'data', 'debug', 'ledger-receipts-v12.json');
  const receipts = readJson(path).map(receipt => (
    receipt.receipt_hash === receiptHash ? { ...receipt, ...patch } : receipt
  ));
  writeJson(path, receipts);
}

const fixture = createInventoryFixture();
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async (...args) => {
  fetchCalls += 1;
  if (typeof originalFetch === 'function') return originalFetch(...args);
  throw new Error(`Unexpected fetch call: ${String(args[0])}`);
};

try {
  await test('builds board view-model from tracked manifest and canonical inventory', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.board_type, 'artifact_historical_verified_receipt_board');
    assert.equal(board.title, 'Historical Verified Receipt Board');
    assert.equal(board.subtitle, 'Selected historical receipts only. Not a trader leaderboard.');
    assert.equal(board.selection_scope.mode, 'publisher_selected');
    assert.equal(board.ranking.metric, 'trust_then_time');
    assert.equal(board.count, 1);
    assert.equal(board.empty, false);
    assert.equal(board.rows[0].receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(board.excluded_entries.length, 0);
  });

  await test('ranks receipt entries by trust, time, then hash without trader or wallet ranking', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash, { display_name: 'Older Stronger' }),
      manifestEntry(fixture.hashes.receiptBHash, { display_name: 'Newer Weaker' }),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.deepEqual(board.rows.map(row => row.receipt_hash), [
      fixture.hashes.receiptAHash,
      fixture.hashes.receiptBHash,
    ]);
    assert.deepEqual(board.rows.map(row => row.rank), [1, 2]);
    for (const row of board.rows) {
      assert.ok(!Object.hasOwn(row, 'wallet'));
      assert.ok(!Object.hasOwn(row, 'trader'));
      assert.ok(!Object.hasOwn(row, 'profile'));
      assert.ok(!Object.hasOwn(row, 'portfolio'));
      assert.ok(!Object.hasOwn(row, 'skill'));
    }
  });

  await test('preserves display_name and participant_ref as row labels only', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash, {
        display_name: 'Publisher Label',
        participant_ref: 'opaque-local-ref',
        selection_note: 'Selected for deterministic test coverage.',
      }),
    ]));

    const row = buildReceiptBoardView({ engineRoot: fixture.root }).rows[0];

    assert.equal(row.display_name, 'Publisher Label');
    assert.equal(row.participant_ref, 'opaque-local-ref');
    assert.equal(row.selection_note, 'Selected for deterministic test coverage.');
    assert.ok(!Object.hasOwn(row, 'account'));
    assert.ok(!Object.hasOwn(row, 'identity'));
  });

  await test('trust_then_time ranking is stable and deterministic with hash tie-breaker', () => {
    mutateReceipt(fixture.root, fixture.hashes.receiptAHash, {
      last_event_at: 1700000800,
    });
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptBHash),
      manifestEntry(fixture.hashes.receiptAHash),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.deepEqual(board.rows.map(row => row.receipt_hash), [
      fixture.hashes.receiptAHash,
      fixture.hashes.receiptBHash,
    ]);
  });

  await test('malformed receipt hashes go to excluded_entries', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry('not-a-hash'),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.empty, true);
    assert.equal(board.rows.length, 0);
    assert.equal(board.excluded_entries[0].reason, 'malformed_receipt_hash');
  });

  await test('unknown receipt hashes go to excluded_entries', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry('9'.repeat(64)),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.rows.length, 0);
    assert.equal(board.excluded_entries[0].reason, 'missing_receipt');
  });

  await test('hash_invalid entries go to excluded_entries', () => {
    mutateVerifyResult(fixture.root, fixture.hashes.receiptAHash, { hash_valid: false });
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.rows.length, 0);
    assert.equal(board.excluded_entries[0].reason, 'hash_invalid');
    mutateVerifyResult(fixture.root, fixture.hashes.receiptAHash, { hash_valid: true });
  });

  await test('verifier_failed entries go to excluded_entries', () => {
    mutateVerifyResult(fixture.root, fixture.hashes.receiptAHash, { pass: false });
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.rows.length, 0);
    assert.equal(board.excluded_entries[0].reason, 'verifier_failed');
    mutateVerifyResult(fixture.root, fixture.hashes.receiptAHash, { pass: true });
  });

  await test('schema_invalid entries go to excluded_entries', () => {
    mutateVerifyResult(fixture.root, fixture.hashes.receiptAHash, { schema_valid: false });
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.rows.length, 0);
    assert.equal(board.excluded_entries[0].reason, 'schema_invalid');
    mutateVerifyResult(fixture.root, fixture.hashes.receiptAHash, { schema_valid: true });
  });

  await test('consistency_invalid entries go to excluded_entries', () => {
    mutateVerifyResult(fixture.root, fixture.hashes.receiptAHash, { consistency_valid: false });
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.rows.length, 0);
    assert.equal(board.excluded_entries[0].reason, 'consistency_invalid');
    mutateVerifyResult(fixture.root, fixture.hashes.receiptAHash, { consistency_valid: true });
  });

  await test('unsupported metric excludes rows instead of silently ranking', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash),
    ], { metric: 'raw_quote_pnl_pct', pnl_scope: 'raw_quote' }));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.rows.length, 0);
    assert.equal(board.excluded_entries[0].reason, 'unsupported_metric');
    assert.equal(board.ranking.metric, 'raw_quote_pnl_pct');
  });

  await test('legacy verification_hash does not resolve', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.legacyHash),
    ]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.rows.length, 0);
    assert.equal(board.excluded_entries[0].reason, 'missing_receipt');
  });

  await test('disclosures include required anti-overclaim language', () => {
    writeManifest(fixture.root, baseManifest([]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.ok(board.disclosures.includes('Ranks selected receipts only. Not traders, wallets, portfolios, or skill.'));
    assert.ok(board.disclosures.includes('Selected receipt only. Not a portfolio statement.'));
    assert.ok(board.disclosures.includes('Raw quote only. No USD normalization.'));
    assert.ok(board.disclosures.includes('Publisher-selected sample set unless an explicit coverage scope is supplied.'));
    assert.ok(board.disclosures.includes('No live trading, prize eligibility, anti-wash-trading, or full-track-record claim.'));
  });

  await test('links point to existing proof, verifier, card, card-preview, and hosted-preview routes', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash),
    ]));

    const row = buildReceiptBoardView({ engineRoot: fixture.root }).rows[0];

    assert.equal(row.links.proof_api_path, `/api/proof/${fixture.hashes.receiptAHash}`);
    assert.equal(row.links.verifier_api_path, `/api/verifier/${fixture.hashes.receiptAHash}`);
    assert.equal(row.links.card_api_path, `/api/proof/${fixture.hashes.receiptAHash}/card`);
    assert.equal(row.links.card_preview_path, `/api/proof/${fixture.hashes.receiptAHash}/card/preview`);
    assert.equal(row.links.hosted_preview_path, `/api/proof/${fixture.hashes.receiptAHash}/hosted-preview`);
  });

  await test('no PnL, USD, performance, or skill fields appear', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash),
    ]));

    const serialized = JSON.stringify(buildReceiptBoardView({ engineRoot: fixture.root }));

    assert.ok(!serialized.includes('realized_pnl'));
    assert.ok(!serialized.includes('pnl_pct'));
    assert.ok(!serialized.includes('usd'));
    assert.ok(!serialized.includes('performance'));
    assert.ok(!serialized.includes('best_trader'));
  });

  await test('empty board returns empty true with no rows', () => {
    writeManifest(fixture.root, baseManifest([]));

    const board = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.equal(board.count, 0);
    assert.equal(board.empty, true);
    assert.deepEqual(board.rows, []);
  });

  await test('view-model performs no writes or network calls', () => {
    writeManifest(fixture.root, baseManifest([
      manifestEntry(fixture.hashes.receiptAHash),
    ]));
    const before = listTree(fixture.root);
    const fetchCallsBefore = fetchCalls;

    const board = buildReceiptBoardView({ engineRoot: fixture.root });
    const after = listTree(fixture.root);

    assert.equal(board.count, 1);
    assert.deepEqual(before, after);
    assert.equal(fetchCalls, fetchCallsBefore);
  });
} finally {
  removeInventoryFixture(fixture.root);
  globalThis.fetch = originalFetch;
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
