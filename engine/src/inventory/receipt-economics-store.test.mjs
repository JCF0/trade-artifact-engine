#!/usr/bin/env node

import assert from 'assert';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { Worker } from 'worker_threads';

import {
  buildReceiptEconomicsSidecar,
  getReceiptEconomicsPaths,
  readReceiptEconomics,
  reconstructCanonicalReceipt,
  serializeReceiptEconomicsSidecar,
  validateReceiptEconomicsSidecar,
  writeReceiptEconomicsSidecar,
  ReceiptEconomicsError,
} from './receipt-economics-store.mjs';
import {
  buildReceiptArchiveBundle,
  readReceiptArchiveBundle,
  stableJson,
  validateReceiptArchiveBundle,
  writeReceiptArchiveBundle,
} from './archive-store.mjs';
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
    console.error(error?.stack ?? error);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack ?? error);
  }
}

function clone(value) {
  return structuredClone(value);
}

function makeReceipt(overrides = {}) {
  const receipt = {
    receipt_id: 'art_v12_cp_TESTMINT_2',
    receipt_version: '1.2.0',
    receipt_type: 'closed_position',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    token_mint: 'TESTMINT1234567890123456789012345678901234abcd',
    segment_index: 2,
    quote_mint: 'So11111111111111111111111111111111111111112',
    quote_symbol: 'SOL',
    candidate_hash: 'c'.repeat(64),
    verification_status: 'verified',
    display_status: 'Verified Closed Position',
    valuation_status: 'raw_quote',
    position_status: 'closed',
    first_event_at: 1700000000,
    last_event_at: 1700100000,
    snapshot_at: null,
    entry_tx_hashes: ['entry111', 'entry222'],
    exit_tx_hashes: ['exit111'],
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
    hold_time_seconds: 100000,
    num_buys: 2,
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

const ECONOMICS_FIELDS = [
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

function makeArchive(receipt = makeReceipt()) {
  const reduced = {};
  for (const key of [
    'receipt_hash', 'receipt_id', 'receipt_version', 'receipt_type', 'wallet',
    'chain', 'token_mint', 'quote_mint', 'quote_symbol', 'candidate_hash',
    'verification_status', 'display_status', 'valuation_status',
    'position_status', 'first_event_at', 'last_event_at', 'snapshot_at',
    'flags', 'limitations',
  ]) reduced[key] = clone(receipt[key]);
  return buildReceiptArchiveBundle(reduced);
}

function makeFixture() {
  const receipt = makeReceipt();
  const archive = makeArchive(receipt);
  const sidecar = buildReceiptEconomicsSidecar(receipt, {
    archiveBundle: archive,
    recoveryMethod: 'current_canonical_import',
  });
  return { receipt, archive, sidecar };
}

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof ReceiptEconomicsError && error.code === code);
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'trade-artifact-economics-'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('valid sidecar reconstructs the canonical receipt and existing verifier passes', () => {
  const { receipt, archive, sidecar } = makeFixture();
  const validated = validateReceiptEconomicsSidecar(sidecar, {
    receiptHash: receipt.receipt_hash,
    archiveBundle: archive,
  });
  const reconstructed = reconstructCanonicalReceipt(sidecar, {
    receiptHash: receipt.receipt_hash,
    archiveBundle: archive,
  });

  assert.equal(validated.verification.pass, true);
  assert.equal(validated.verification.hash_valid, true);
  assert.equal(validated.verification.recomputed_hash, receipt.receipt_hash);
  assert.deepEqual(reconstructed, receipt);
  assert.deepEqual([...Object.keys(sidecar.hash_bound_fields), ...Object.keys(sidecar.canonical_derived_fields)].sort(), [...ECONOMICS_FIELDS].sort());
  assert.ok(Object.isFrozen(validated.economics));
  assert.ok(Object.isFrozen(reconstructed));
});

test('altered economic value fails receipt hash validation', () => {
  const { receipt, archive, sidecar } = makeFixture();
  const altered = clone(sidecar);
  altered.hash_bound_fields.realized_pnl_quote += 1;
  expectCode(
    () => validateReceiptEconomicsSidecar(altered, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
    'receipt_hash_mismatch',
  );
});

test('altered transaction hash fails receipt hash validation', () => {
  const { receipt, archive, sidecar } = makeFixture();
  const altered = clone(sidecar);
  altered.hash_bound_fields.entry_tx_hashes[0] = 'different-entry';
  expectCode(
    () => validateReceiptEconomicsSidecar(altered, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
    'receipt_hash_mismatch',
  );
});

test('altered segment index or accounting method fails receipt hash validation', () => {
  for (const [field, value] of [['segment_index', 3], ['accounting_method', 'fifo_v1']]) {
    const { receipt, archive, sidecar } = makeFixture();
    const altered = clone(sidecar);
    altered.hash_bound_fields[field] = value;
    expectCode(
      () => validateReceiptEconomicsSidecar(altered, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
      'receipt_hash_mismatch',
    );
  }
});

test('wrong filename identity and top-level hash fail deterministically', () => {
  const { receipt, archive, sidecar } = makeFixture();
  expectCode(
    () => validateReceiptEconomicsSidecar(sidecar, { receiptHash: 'a'.repeat(64), archiveBundle: archive }),
    'filename_hash_mismatch',
  );

  const altered = clone(sidecar);
  altered.receipt_hash = 'b'.repeat(64);
  expectCode(
    () => validateReceiptEconomicsSidecar(altered, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
    'filename_hash_mismatch',
  );
});

test('stored verifier result and canonical projection hash must agree', () => {
  const { receipt, archive, sidecar } = makeFixture();
  const alteredVerification = clone(sidecar);
  alteredVerification.verification.hash_valid = false;
  expectCode(
    () => validateReceiptEconomicsSidecar(alteredVerification, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
    'verification_record_mismatch',
  );

  const alteredProjection = clone(sidecar);
  alteredProjection.provenance.canonical_projection_hash = 'a'.repeat(64);
  expectCode(
    () => validateReceiptEconomicsSidecar(alteredProjection, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
    'canonical_projection_hash_mismatch',
  );
});

test('recovery provenance is a fixed enum with no operational identity', () => {
  const { receipt, archive, sidecar } = makeFixture();
  assert.equal(sidecar.provenance.recovery_method, 'current_canonical_import');
  const altered = clone(sidecar);
  altered.provenance.recovery_method = 'manual_backfill';
  expectCode(
    () => validateReceiptEconomicsSidecar(altered, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
    'invalid_recovery_method',
  );
});

test('archive overlap mismatch fails before economics are exposed', () => {
  const { receipt, archive, sidecar } = makeFixture();
  const alteredArchive = clone(archive);
  alteredArchive.inventory_record.wallet = 'DIFFERENT_WALLET';
  expectCode(
    () => validateReceiptEconomicsSidecar(sidecar, { receiptHash: receipt.receipt_hash, archiveBundle: alteredArchive }),
    'archive_overlap_mismatch',
  );
});

test('orphan sidecar and missing archive bundle fail closed', () => {
  const root = tempRoot();
  try {
    const { sidecar } = makeFixture();
    const economicsRoot = join(root, 'economics');
    const paths = getReceiptEconomicsPaths({ economicsRoot });
    mkdirSync(paths.receiptsDir, { recursive: true });
    writeFileSync(join(paths.receiptsDir, `${sidecar.receipt_hash}.json`), serializeReceiptEconomicsSidecar(sidecar));

    expectCode(
      () => readReceiptEconomics(sidecar.receipt_hash, { economicsRoot, archiveRoot: join(root, 'missing-archive') }),
      'missing_archive_bundle',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt archive bundle has a deterministic fail-closed error code', () => {
  const root = tempRoot();
  try {
    const { sidecar } = makeFixture();
    const archiveRoot = join(root, 'archive');
    const economicsRoot = join(root, 'economics');
    mkdirSync(join(archiveRoot, 'receipts'), { recursive: true });
    mkdirSync(join(economicsRoot, 'receipts'), { recursive: true });
    writeFileSync(join(archiveRoot, 'receipts', `${sidecar.receipt_hash}.json`), '{ corrupt archive', 'utf8');
    writeFileSync(join(economicsRoot, 'receipts', `${sidecar.receipt_hash}.json`), serializeReceiptEconomicsSidecar(sidecar));

    expectCode(
      () => readReceiptEconomics(sidecar.receipt_hash, { economicsRoot, archiveRoot }),
      'invalid_archive_bundle',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file-backed archive overlap mismatch uses the same deterministic code', () => {
  const root = tempRoot();
  try {
    const { archive, sidecar } = makeFixture();
    const archiveRoot = join(root, 'archive');
    const economicsRoot = join(root, 'economics');
    writeReceiptArchiveBundle(archive, { archiveRoot });
    mkdirSync(join(economicsRoot, 'receipts'), { recursive: true });
    writeFileSync(join(economicsRoot, 'receipts', `${sidecar.receipt_hash}.json`), serializeReceiptEconomicsSidecar(sidecar));

    const archivePath = join(archiveRoot, 'receipts', `${sidecar.receipt_hash}.json`);
    const alteredArchive = JSON.parse(readFileSync(archivePath, 'utf8'));
    alteredArchive.inventory_record.wallet = 'DIFFERENT_WALLET';
    writeFileSync(archivePath, stableJson(alteredArchive), 'utf8');

    expectCode(
      () => readReceiptEconomics(sidecar.receipt_hash, { economicsRoot, archiveRoot }),
      'archive_overlap_mismatch',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing and corrupt economics files have deterministic error codes', () => {
  const root = tempRoot();
  try {
    const { archive, sidecar } = makeFixture();
    const archiveRoot = join(root, 'archive');
    const economicsRoot = join(root, 'economics');
    writeReceiptArchiveBundle(archive, { archiveRoot });

    expectCode(
      () => readReceiptEconomics(sidecar.receipt_hash, { economicsRoot, archiveRoot }),
      'missing_economics_sidecar',
    );

    mkdirSync(join(economicsRoot, 'receipts'), { recursive: true });
    writeFileSync(join(economicsRoot, 'receipts', `${sidecar.receipt_hash}.json`), '{ corrupt economics', 'utf8');
    expectCode(
      () => readReceiptEconomics(sidecar.receipt_hash, { economicsRoot, archiveRoot }),
      'corrupt_economics_sidecar',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write validates non-JSON numeric values before serialization', () => {
  const root = tempRoot();
  try {
    const { archive, sidecar } = makeFixture();
    const archiveRoot = join(root, 'archive');
    const economicsRoot = join(root, 'economics');
    writeReceiptArchiveBundle(archive, { archiveRoot });
    const malformed = clone(sidecar);
    malformed.hash_bound_fields.realized_pnl_quote = 5n;

    expectCode(
      () => writeReceiptEconomicsSidecar(malformed, { archiveRoot, economicsRoot }),
      'invalid_economics_field',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('NaN infinity and malformed numeric values fail schema validation', () => {
  for (const value of [NaN, Infinity, -Infinity, '5']) {
    const { receipt, archive, sidecar } = makeFixture();
    const altered = clone(sidecar);
    altered.hash_bound_fields.realized_pnl_quote = value;
    expectCode(
      () => validateReceiptEconomicsSidecar(altered, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
      'invalid_economics_field',
    );
  }
});

test('derived hold time and transaction counts are checked', () => {
  for (const [field, value, code] of [
    ['hold_time_seconds', 999, 'derived_hold_time_mismatch'],
    ['num_buys', 1, 'derived_buy_count_mismatch'],
    ['num_sells', 2, 'derived_sell_count_mismatch'],
  ]) {
    const { receipt, archive, sidecar } = makeFixture();
    const altered = clone(sidecar);
    altered.canonical_derived_fields[field] = value;
    expectCode(
      () => validateReceiptEconomicsSidecar(altered, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
      code,
    );
  }
});

test('raw transaction path host username runtime timestamp and provider URL keys fail', () => {
  for (const key of ['raw_transaction', 'source_path', 'host', 'username', 'generated_at', 'provider_url']) {
    const { receipt, archive, sidecar } = makeFixture();
    const altered = clone(sidecar);
    altered.hash_bound_fields[key] = key === 'raw_transaction' ? { body: 'raw' } : 'forbidden';
    expectCode(
      () => validateReceiptEconomicsSidecar(altered, { receiptHash: receipt.receipt_hash, archiveBundle: archive }),
      'forbidden_sidecar_key',
    );
  }
});

test('serialization is deterministic byte-stable with sorted keys and one LF', () => {
  const { sidecar } = makeFixture();
  const reordered = {
    receipt_hash: sidecar.receipt_hash,
    verification: Object.fromEntries(Object.entries(sidecar.verification).reverse()),
    receipt_version: sidecar.receipt_version,
    receipt_type: sidecar.receipt_type,
    provenance: Object.fromEntries(Object.entries(sidecar.provenance).reverse()),
    hash_bound_fields: Object.fromEntries(Object.entries(sidecar.hash_bound_fields).reverse()),
    economics_version: sidecar.economics_version,
    canonical_derived_fields: Object.fromEntries(Object.entries(sidecar.canonical_derived_fields).reverse()),
  };
  const first = serializeReceiptEconomicsSidecar(sidecar);
  const second = serializeReceiptEconomicsSidecar(reordered);

  assert.equal(first, second);
  assert.ok(first.endsWith('\n'));
  assert.ok(!first.endsWith('\n\n'));
  assert.ok(!first.includes('\r'));
});

test('Windows and Linux checkout roots produce byte-identical sidecars', () => {
  const root = tempRoot();
  try {
    const { receipt, archive, sidecar } = makeFixture();
    const archiveRoot = join(root, 'archive');
    writeReceiptArchiveBundle(archive, { archiveRoot });
    const windowsRoot = join(root, 'C:\\checkout\\economics');
    const linuxRoot = join(root, 'home', 'user', 'checkout', 'economics');

    writeReceiptEconomicsSidecar(sidecar, { receiptHash: receipt.receipt_hash, archiveRoot, economicsRoot: windowsRoot });
    writeReceiptEconomicsSidecar(sidecar, { receiptHash: receipt.receipt_hash, archiveRoot, economicsRoot: linuxRoot });

    const windowsBytes = readFileSync(join(windowsRoot, 'receipts', `${receipt.receipt_hash}.json`), 'utf8');
    const linuxBytes = readFileSync(join(linuxRoot, 'receipts', `${receipt.receipt_hash}.json`), 'utf8');
    assert.equal(windowsBytes, linuxBytes);
    assert.ok(!windowsBytes.includes(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identical existing sidecar is a no-op and conflicting bytes fail closed', () => {
  const root = tempRoot();
  try {
    const { receipt, archive, sidecar } = makeFixture();
    const archiveRoot = join(root, 'archive');
    const economicsRoot = join(root, 'economics');
    writeReceiptArchiveBundle(archive, { archiveRoot });

    const first = writeReceiptEconomicsSidecar(sidecar, { receiptHash: receipt.receipt_hash, archiveRoot, economicsRoot });
    const second = writeReceiptEconomicsSidecar(sidecar, { receiptHash: receipt.receipt_hash, archiveRoot, economicsRoot });
    assert.equal(first.status, 'written');
    assert.equal(second.status, 'unchanged');

    const conflict = clone(sidecar);
    conflict.provenance.recovery_method = 'retained_canonical_receipt';
    expectCode(
      () => writeReceiptEconomicsSidecar(conflict, { receiptHash: receipt.receipt_hash, archiveRoot, economicsRoot }),
      'receipt_economics_conflict',
    );
    assert.deepEqual(readdirSync(join(economicsRoot, 'receipts')).filter(name => name.includes('.tmp')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await asyncTest('concurrent worker writers publish once and report every different-byte loser as conflict', async () => {
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { writeReceiptEconomicsSidecar } = await import(workerData.moduleUrl);
      const state = new Int32Array(workerData.shared);
      Atomics.add(state, 0, 1);
      Atomics.notify(state, 0);
      Atomics.wait(state, 1, 0);
      try {
        const result = writeReceiptEconomicsSidecar(workerData.sidecar, workerData.options);
        parentPort.postMessage({ kind: result.status });
      } catch (error) {
        parentPort.postMessage({ kind: 'error', code: error.code ?? error.name });
      }
    })();
  `;
  const moduleUrl = new URL('./receipt-economics-store.mjs', import.meta.url).href;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const root = tempRoot();
    try {
      const { receipt, archive, sidecar } = makeFixture();
      const archiveRoot = join(root, 'archive');
      const economicsRoot = join(root, 'economics');
      writeReceiptArchiveBundle(archive, { archiveRoot });
      const conflict = buildReceiptEconomicsSidecar(receipt, {
        archiveBundle: archive,
        recoveryMethod: 'retained_canonical_receipt',
      });
      const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const state = new Int32Array(shared);
      const options = { receiptHash: receipt.receipt_hash, archiveRoot, economicsRoot };
      const workers = [sidecar, conflict].map(candidate => new Worker(workerSource, {
        eval: true,
        workerData: { moduleUrl, sidecar: candidate, options, shared },
      }));
      const pending = workers.map(worker => new Promise((resolveMessage, rejectMessage) => {
        worker.once('message', resolveMessage);
        worker.once('error', rejectMessage);
      }));

      while (Atomics.load(state, 0) < 2) {
        await new Promise(resolveWait => setTimeout(resolveWait, 1));
      }
      Atomics.store(state, 1, 1);
      Atomics.notify(state, 1, 2);
      const results = await Promise.all(pending);
      assert.deepEqual(
        results.map(result => result.kind === 'error' ? result.code : result.kind).sort(),
        ['receipt_economics_conflict', 'written'],
      );
      assert.deepEqual(readdirSync(join(economicsRoot, 'receipts')).filter(name => name.includes('.tmp')), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('read API returns only validated immutable economics', () => {
  const root = tempRoot();
  try {
    const { receipt, archive, sidecar } = makeFixture();
    const archiveRoot = join(root, 'archive');
    const economicsRoot = join(root, 'economics');
    writeReceiptArchiveBundle(archive, { archiveRoot });
    writeReceiptEconomicsSidecar(sidecar, { receiptHash: receipt.receipt_hash, archiveRoot, economicsRoot });

    const result = readReceiptEconomics(receipt.receipt_hash, { archiveRoot, economicsRoot });
    assert.equal(result.verification.pass, true);
    assert.equal(result.canonical_receipt.receipt_hash, receipt.receipt_hash);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.economics));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all receipt_archive_v1 fixtures remain readable and byte-unchanged', () => {
  const fixtureRoot = resolve('receipt-archive-v1');
  const receiptsDir = join(fixtureRoot, 'receipts');
  const indexPath = join(fixtureRoot, 'index.json');
  const fixtureFiles = readdirSync(receiptsDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  assert.ok(fixtureFiles.length > 0);

  const before = new Map([
    [indexPath, readFileSync(indexPath)],
    ...fixtureFiles.map(name => {
      const path = join(receiptsDir, name);
      return [path, readFileSync(path)];
    }),
  ]);

  for (const name of fixtureFiles) {
    const receiptHash = name.replace(/\.json$/, '');
    const bundle = readReceiptArchiveBundle(receiptHash, { archiveRoot: fixtureRoot });
    assert.equal(validateReceiptArchiveBundle(bundle), true);
    assert.equal(stableJson(bundle), before.get(join(receiptsDir, name)).toString('utf8'));
  }

  for (const [path, bytes] of before) {
    assert.equal(sha256(readFileSync(path)), sha256(bytes));
  }
});

console.log(`\nReceipt economics store tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
