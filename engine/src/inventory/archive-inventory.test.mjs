#!/usr/bin/env node

import assert from 'assert';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { buildInventorySnapshot, getInventoryReceipt, getLegacyInventoryReceipt } from './inventory.mjs';
import { buildReceiptArchiveBundle, writeReceiptArchiveBundle } from './archive-store.mjs';
import {
  buildReceiptEconomicsSidecar,
  writeReceiptEconomicsSidecar,
} from './receipt-economics-store.mjs';
import { createInventoryFixture, removeInventoryFixture } from './test-fixtures.mjs';
import { buildReceiptBoardView } from '../receipt-board/view-model.mjs';
import { computeReceiptHash } from '../ledger/receipt-promotion.mjs';

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

const economicsFields = [
  'segment_index',
  'entry_tx_hashes',
  'exit_tx_hashes',
  'total_bought_qty',
  'total_bought_quote',
  'avg_buy_quote_price',
  'total_sold_qty',
  'total_sold_quote',
  'avg_sell_quote_price',
  'allocated_cost_basis_quote',
  'remaining_qty',
  'remaining_cost_basis_quote',
  'realized_pnl_quote',
  'realized_pnl_pct',
  'accounting_method',
  'hold_time_seconds',
  'num_buys',
  'num_sells',
];

function makeCanonicalReceipt(label, overrides = {}) {
  const receipt = {
    receipt_id: `art_v12_cp_${label}_0`,
    receipt_version: '1.2.0',
    receipt_type: 'closed_position',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    token_mint: `${label}_TOKEN_MINT`,
    segment_index: 0,
    quote_mint: 'So11111111111111111111111111111111111111112',
    quote_symbol: 'SOL',
    candidate_hash: 'c'.repeat(64),
    verification_status: 'verified',
    display_status: 'Verified Closed Position',
    valuation_status: 'raw_quote',
    position_status: 'closed',
    first_event_at: 1700000000,
    last_event_at: 1700000300,
    snapshot_at: null,
    entry_tx_hashes: [`${label}-entry`],
    exit_tx_hashes: [`${label}-exit`],
    total_bought_qty: 1000,
    total_bought_quote: 10,
    avg_buy_quote_price: 0.01,
    total_sold_qty: 1000,
    total_sold_quote: 15,
    avg_sell_quote_price: 0.015,
    allocated_cost_basis_quote: 10,
    remaining_qty: 0,
    remaining_cost_basis_quote: 0,
    realized_pnl_quote: 5,
    realized_pnl_pct: 50,
    accounting_method: 'weighted_average_position_accounting_v1',
    hold_time_seconds: 300,
    num_buys: 1,
    num_sells: 1,
    flags: [],
    limitations: {
      receipt_scope: 'closed_position',
      pnl_type: 'realized_closed',
      price_source: 'on_chain_swaps',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    },
    ...overrides,
  };
  receipt.receipt_hash = computeReceiptHash(receipt);
  return receipt;
}

function archiveRecordWithEconomics(root, canonicalReceipt) {
  const inventoryRecord = Object.fromEntries(Object.entries(canonicalReceipt)
    .filter(([key]) => !economicsFields.includes(key)));
  Object.assign(inventoryRecord, {
    hash_valid: true,
    recomputed_hash: canonicalReceipt.receipt_hash,
    verifier_passed: true,
    verifier_schema_valid: true,
    verifier_consistency_valid: true,
    verifier_rule_violations: [],
    proof_summary: { verification_status: 'verified', violations: 0 },
  });
  const archiveBundle = buildReceiptArchiveBundle(inventoryRecord);
  writeReceiptArchiveBundle(archiveBundle, { engineRoot: root });
  const sidecar = buildReceiptEconomicsSidecar(canonicalReceipt, {
    archiveBundle,
    recoveryMethod: 'hash_matched_regeneration',
  });
  writeReceiptEconomicsSidecar(sidecar, { engineRoot: root });
  return { archiveBundle, sidecar };
}

function expectedCanonicalEconomics(sidecar) {
  return {
    status: 'verified',
    source: 'receipt_economics_v1',
    recovery_method: sidecar.provenance.recovery_method,
    fields: Object.fromEntries(economicsFields.map(field => [
      field,
      Object.hasOwn(sidecar.hash_bound_fields, field)
        ? sidecar.hash_bound_fields[field]
        : sidecar.canonical_derived_fields[field],
    ])),
  };
}
function assertArchiveRelativeDiagnosticPath(diagnostic, receiptHash, root) {
  assert.equal(diagnostic.path, 'receipts/' + receiptHash + '.json');
  assert.ok(!diagnostic.path.includes('\\\\'));
  assert.ok(!diagnostic.path.includes(root));
  assert.ok(!/^[A-Za-z]:/.test(diagnostic.path));
  assert.ok(!diagnostic.path.startsWith('/'));
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
    assertArchiveRelativeDiagnosticPath(snapshot.archive.diagnostics[0], fixture.hashes.receiptAHash, fixture.root);
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
    assertArchiveRelativeDiagnosticPath(snapshot.archive.diagnostics[0], fixture.hashes.receiptAHash, fixture.root);
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
    assertArchiveRelativeDiagnosticPath(snapshot.archive.diagnostics[0], zHash, fixture.root);
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
    assert.equal(board.excluded_entries[0].reason, 'verification_status_not_board_eligible');
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

test('valid JUP-like and RAY-like sidecars join by receipt_hash with exact validated economics', () => {
  const fixture = createInventoryFixture();
  try {
    const fixtures = [
      archiveRecordWithEconomics(fixture.root, makeCanonicalReceipt('JUP')),
      archiveRecordWithEconomics(fixture.root, makeCanonicalReceipt('RAY', {
        total_bought_quote: 25,
        total_sold_quote: 27.5,
        allocated_cost_basis_quote: 25,
        realized_pnl_quote: 2.5,
        realized_pnl_pct: 10,
      })),
    ];

    const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });
    for (const { sidecar } of fixtures) {
      const receipt = snapshot.receipts.find(item => item.receipt_hash === sidecar.receipt_hash);
      assert.ok(receipt);
      assert.deepEqual(receipt.canonical_economics, expectedCanonicalEconomics(sidecar));
      assert.deepEqual(Object.keys(receipt.canonical_economics.fields), economicsFields);
    }
    assert.deepEqual(snapshot.archive.diagnostics, []);
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('archive receipt without sidecar remains byte-for-byte unchanged at record level', () => {
  const fixture = createInventoryFixture();
  try {
    const archived = { ...currentRecord(fixture.root, fixture.hashes.receiptAHash), receipt_hash: rayHash, receipt_id: 'art_v12_cp_RAY_0' };
    archiveRecord(fixture.root, archived);

    const receipt = getInventoryReceipt(rayHash, { engineRoot: fixture.root, includeArchive: true });
    assert.deepEqual(receipt, buildReceiptArchiveBundle(archived).inventory_record);
    assert.equal(Object.hasOwn(receipt, 'canonical_economics'), false);
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('corrupt altered conflicting and orphan sidecars expose no economics and emit deterministic diagnostics', () => {
  for (const scenario of ['corrupt', 'altered', 'conflicting', 'orphan']) {
    const fixture = createInventoryFixture();
    try {
      const canonical = makeCanonicalReceipt(scenario.toUpperCase());
      const { sidecar } = archiveRecordWithEconomics(fixture.root, canonical);
      const sidecarPath = join(fixture.root, 'data', 'inventory', 'receipt-economics-v1', 'receipts', `${canonical.receipt_hash}.json`);
      const archivePath = join(fixture.root, 'data', 'inventory', 'receipt-archive-v1', 'receipts', `${canonical.receipt_hash}.json`);

      if (scenario === 'corrupt') {
        writeFileSync(sidecarPath, '{ corrupt economics', 'utf8');
      } else if (scenario === 'altered') {
        const altered = structuredClone(sidecar);
        altered.hash_bound_fields.realized_pnl_quote += 1;
        writeJson(sidecarPath, altered);
      } else if (scenario === 'conflicting') {
        const conflicting = structuredClone(sidecar);
        conflicting.receipt_hash = 'd'.repeat(64);
        writeJson(sidecarPath, conflicting);
      } else {
        unlinkSync(archivePath);
      }

      const snapshot = buildInventorySnapshot({ engineRoot: fixture.root, includeArchive: true });
      const receipt = snapshot.receipts.find(item => item.receipt_hash === canonical.receipt_hash);
      assert.equal(Boolean(receipt?.canonical_economics), false);
      assert.deepEqual(snapshot.archive.diagnostics.filter(item => item.code === 'canonical_economics_excluded'), [{
        code: 'canonical_economics_excluded',
        receipt_hash: canonical.receipt_hash,
        source: 'receipt_economics_v1',
        reason: {
          corrupt: 'corrupt_economics_sidecar',
          altered: 'receipt_hash_mismatch',
          conflicting: 'filename_hash_mismatch',
          orphan: 'missing_archive_bundle',
        }[scenario],
      }]);
    } finally {
      removeInventoryFixture(fixture.root);
    }
  }
});

test('validated economics do not change existing board or proof eligibility behavior', () => {
  const fixture = createInventoryFixture();
  try {
    const canonical = makeCanonicalReceipt('BOARD');
    const inventoryRecord = Object.fromEntries(Object.entries(canonical)
      .filter(([key]) => !economicsFields.includes(key)));
    Object.assign(inventoryRecord, {
      hash_valid: true,
      recomputed_hash: canonical.receipt_hash,
      verifier_passed: true,
      verifier_schema_valid: true,
      verifier_consistency_valid: true,
      verifier_rule_violations: [],
      proof_summary: { verification_status: 'verified', violations: 0 },
    });
    archiveRecord(fixture.root, inventoryRecord);
    writeManifest(fixture.root, canonical.receipt_hash);
    const before = buildReceiptBoardView({ engineRoot: fixture.root });

    const archiveBundle = buildReceiptArchiveBundle(inventoryRecord);
    const sidecar = buildReceiptEconomicsSidecar(canonical, {
      archiveBundle,
      recoveryMethod: 'hash_matched_regeneration',
    });
    writeReceiptEconomicsSidecar(sidecar, { engineRoot: fixture.root });
    const after = buildReceiptBoardView({ engineRoot: fixture.root });

    assert.deepEqual(after, before);
    assert.equal(after.rows.length, 1);
  } finally {
    removeInventoryFixture(fixture.root);
  }
});

test('checkout roots produce deterministic path-free canonical economics output', () => {
  const windowsFixture = createInventoryFixture();
  const linuxFixture = createInventoryFixture();
  try {
    const canonical = makeCanonicalReceipt('PORTABLE');
    archiveRecordWithEconomics(windowsFixture.root, canonical);
    archiveRecordWithEconomics(linuxFixture.root, canonical);

    const windowsReceipt = getInventoryReceipt(canonical.receipt_hash, {
      engineRoot: windowsFixture.root,
      includeArchive: true,
    });
    const linuxReceipt = getInventoryReceipt(canonical.receipt_hash, {
      engineRoot: linuxFixture.root,
      includeArchive: true,
    });
    const windowsBytes = JSON.stringify(windowsReceipt.canonical_economics);
    const linuxBytes = JSON.stringify(linuxReceipt.canonical_economics);

    assert.equal(windowsBytes, linuxBytes);
    assert.equal(windowsBytes.includes(windowsFixture.root), false);
    assert.equal(linuxBytes.includes(linuxFixture.root), false);
    assert.equal(windowsBytes.includes('\\\\'), false);
  } finally {
    removeInventoryFixture(windowsFixture.root);
    removeInventoryFixture(linuxFixture.root);
  }
});

test('production archive-backed JUP and RAY expose their exact recovered economics without raw expansion', () => {
  const snapshot = buildInventorySnapshot({ engineRoot: resolve('engine'), includeArchive: true });
  const expected = new Map([
    [jupHash, { total_bought_quote: 49728.694003, total_sold_quote: 58016.53285, realized_pnl_quote: 8287.838847, realized_pnl_pct: 16.6661 }],
    [rayHash, { total_bought_quote: 25000, total_sold_quote: 27347.717902, realized_pnl_quote: 2347.717902, realized_pnl_pct: 9.39087 }],
  ]);

  for (const [receiptHash, summary] of expected) {
    const receipt = snapshot.receipts.find(item => item.receipt_hash === receiptHash);
    assert.ok(receipt);
    assert.equal(receipt.canonical_economics.status, 'verified');
    assert.equal(receipt.canonical_economics.source, 'receipt_economics_v1');
    assert.equal(receipt.canonical_economics.recovery_method, 'hash_matched_regeneration');
    for (const [field, value] of Object.entries(summary)) {
      assert.equal(receipt.canonical_economics.fields[field], value);
    }
    assert.deepEqual(Object.keys(receipt.canonical_economics.fields), economicsFields);
    const serialized = JSON.stringify(receipt.canonical_economics).toLowerCase();
    for (const forbidden of ['raw_transaction', 'provider_url', 'source_path', 'wallet_profile', 'portfolio']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }
});

console.log(`\nArchive-backed inventory tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
