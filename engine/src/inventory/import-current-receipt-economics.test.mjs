#!/usr/bin/env node

import assert from 'assert';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

import {
  buildCurrentReceiptEconomicsSidecar,
  importCurrentReceiptEconomics,
  main,
} from './import-current-receipt-economics.mjs';
import {
  readReceiptEconomics,
  serializeReceiptEconomicsSidecar,
  ReceiptEconomicsError,
} from './receipt-economics-store.mjs';
import {
  readReceiptArchiveBundle,
  stableJson,
} from './archive-store.mjs';
import { importCurrentRunToReceiptArchive } from './archive-current-run.mjs';
import { computeReceiptHash } from '../ledger/receipt-promotion.mjs';
import { verifyReceipt } from '../ledger/receipt-verifier.mjs';

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

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'trade-artifact-current-economics-'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeCanonicalReceipt(overrides = {}) {
  const receipt = {
    receipt_id: 'art_v12_cp_TESTMINT_0',
    receipt_version: '1.2.0',
    receipt_type: 'closed_position',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    token_mint: 'TESTMINT1234567890123456789012345678901234abcd',
    segment_index: 0,
    quote_mint: 'So11111111111111111111111111111111111111112',
    quote_symbol: 'SOL',
    candidate_hash: 'c'.repeat(64),
    verification_status: 'verified',
    display_status: 'Verified Closed Position',
    valuation_status: 'raw_quote',
    position_status: 'closed',
    first_event_at: 1700000000,
    last_event_at: 1700000123,
    snapshot_at: null,
    entry_tx_hashes: ['entry-one', 'entry-two'],
    exit_tx_hashes: ['exit-one'],
    total_bought_qty: 123.456789,
    total_bought_quote: 7.654321,
    avg_buy_quote_price: 0.06200000615600005,
    total_sold_qty: 123.456789,
    total_sold_quote: 9.876543,
    avg_sell_quote_price: 0.08000000064800001,
    allocated_cost_basis_quote: 7.654321,
    remaining_qty: 0,
    remaining_cost_basis_quote: 0,
    realized_pnl_quote: 2.222222,
    realized_pnl_pct: 29.03225938967863,
    accounting_method: 'weighted_average_position_accounting_v1',
    hold_time_seconds: 123,
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

function writeCurrentArtifacts(engineRoot, receipts, verificationResults = receipts.map(verifyReceipt)) {
  const debugRoot = join(engineRoot, 'data', 'debug');
  writeJson(join(debugRoot, 'ledger-receipts-v12.json'), receipts);
  writeJson(join(debugRoot, 'ledger-verify-v12.json'), {
    total: verificationResults.length,
    passed: verificationResults.filter(result => result.pass).length,
    failed: verificationResults.filter(result => !result.pass).length,
    results: verificationResults,
  });
  writeJson(join(debugRoot, 'ledger-valuations-v12.json'), { contexts: [] });
  writeJson(join(debugRoot, 'v12-proof-pipeline-summary.json'), { receipts: [] });
}

function fixture() {
  const root = tempRoot();
  const engineRoot = join(root, 'engine');
  const archiveRoot = join(root, 'archive');
  const economicsRoot = join(root, 'economics');
  const receipt = makeCanonicalReceipt();
  const verificationResult = verifyReceipt(receipt);
  writeCurrentArtifacts(engineRoot, [receipt], [verificationResult]);
  importCurrentRunToReceiptArchive({ engineRoot, archiveRoot });
  const archiveBundle = readReceiptArchiveBundle(receipt.receipt_hash, { archiveRoot });
  return { root, engineRoot, archiveRoot, economicsRoot, receipt, verificationResult, archiveBundle };
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function expectEconomicsCode(fn, code) {
  assert.throws(fn, error => error instanceof ReceiptEconomicsError && error.code === code);
}

test('verified canonical closed-position receipt builds a byte-stable sidecar by copying every economics field', () => {
  const item = fixture();
  try {
    const sidecar = buildCurrentReceiptEconomicsSidecar(item.receipt, {
      verificationResult: item.verificationResult,
      archiveBundle: item.archiveBundle,
    });
    const repeat = buildCurrentReceiptEconomicsSidecar(structuredClone(item.receipt), {
      verificationResult: structuredClone(item.verificationResult),
      archiveBundle: structuredClone(item.archiveBundle),
    });

    assert.equal(serializeReceiptEconomicsSidecar(sidecar), serializeReceiptEconomicsSidecar(repeat));
    for (const field of ECONOMICS_FIELDS) {
      const actual = Object.hasOwn(sidecar.hash_bound_fields, field)
        ? sidecar.hash_bound_fields[field]
        : sidecar.canonical_derived_fields[field];
      assert.deepStrictEqual(actual, item.receipt[field], field);
    }
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('import is dry-run by default and explicit write creates one sidecar plus deterministic index without changing archive bytes', () => {
  const item = fixture();
  try {
    const archiveReceiptPath = join(item.archiveRoot, 'receipts', `${item.receipt.receipt_hash}.json`);
    const archiveIndexPath = join(item.archiveRoot, 'index.json');
    const archiveBefore = [hashFile(archiveReceiptPath), hashFile(archiveIndexPath)];

    const dryRun = importCurrentReceiptEconomics({
      engineRoot: item.engineRoot,
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
    });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.would_write, 1);
    assert.equal(existsSync(item.economicsRoot), false);

    const written = importCurrentReceiptEconomics({
      engineRoot: item.engineRoot,
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
      write: true,
    });
    assert.equal(written.written, 1);
    assert.equal(written.unchanged, 0);
    assert.equal(written.index_receipt_count, 1);

    const indexBytes = readFileSync(join(item.economicsRoot, 'index.json'), 'utf8');
    const index = JSON.parse(indexBytes);
    assert.equal(index.receipt_count, 1);
    assert.deepEqual(index.receipts.map(entry => entry.receipt_hash), [item.receipt.receipt_hash]);
    assert.equal(indexBytes, stableJson(index));
    assert.ok(!indexBytes.includes(item.root));

    const stored = readReceiptEconomics(item.receipt.receipt_hash, {
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
    });
    assert.equal(stored.verification.pass, true);
    assert.deepEqual([hashFile(archiveReceiptPath), hashFile(archiveIndexPath)], archiveBefore);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('every missing or altered verifier gate rejects the receipt and writes no output', () => {
  const item = fixture();
  try {
    const cases = [
      [null, 'missing_verification_result'],
      [{ ...item.verificationResult, receipt_hash: 'f'.repeat(64) }, 'verification_receipt_hash_mismatch'],
      [{ ...item.verificationResult, hash_valid: false }, 'verification_gate_failed'],
      [{ ...item.verificationResult, schema_valid: false }, 'verification_gate_failed'],
      [{ ...item.verificationResult, consistency_valid: false }, 'verification_gate_failed'],
      [{ ...item.verificationResult, pass: false }, 'verification_gate_failed'],
      [{ ...item.verificationResult, rule_violations: [{ rule: 'TEST' }] }, 'verification_gate_failed'],
    ];
    for (const [verificationResult, code] of cases) {
      expectEconomicsCode(
        () => buildCurrentReceiptEconomicsSidecar(item.receipt, {
          verificationResult,
          archiveBundle: item.archiveBundle,
        }),
        code,
      );
    }

    writeCurrentArtifacts(item.engineRoot, [item.receipt], [{ ...item.verificationResult, pass: false }]);
    const summary = importCurrentReceiptEconomics({
      engineRoot: item.engineRoot,
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
      write: true,
    });
    assert.equal(summary.eligible, 0);
    assert.equal(summary.rejected, 1);
    assert.equal(existsSync(item.economicsRoot), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('partial snapshot and unverified receipts are rejected before sidecar construction', () => {
  const item = fixture();
  try {
    for (const [overrides, code] of [
      [{ receipt_type: 'realized_partial', verification_status: 'verified_partial' }, 'receipt_type_not_eligible'],
      [{ receipt_type: 'open_snapshot', verification_status: 'verified_snapshot' }, 'receipt_type_not_eligible'],
      [{ verification_status: 'unverified' }, 'verification_status_not_eligible'],
    ]) {
      const receipt = makeCanonicalReceipt(overrides);
      expectEconomicsCode(
        () => buildCurrentReceiptEconomicsSidecar(receipt, {
          verificationResult: verifyReceipt(receipt),
          archiveBundle: item.archiveBundle,
        }),
        code,
      );
    }
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('canonical accounting values are preserved even when they are arithmetically inconsistent', () => {
  const root = tempRoot();
  const engineRoot = join(root, 'engine');
  const archiveRoot = join(root, 'archive');
  try {
    const receipt = makeCanonicalReceipt({
      avg_buy_quote_price: 41.25,
      avg_sell_quote_price: 0.0000007,
      allocated_cost_basis_quote: -1234.5,
      realized_pnl_quote: 987654.321,
      realized_pnl_pct: -777.125,
    });
    const verificationResult = verifyReceipt(receipt);
    assert.equal(verificationResult.pass, true);
    writeCurrentArtifacts(engineRoot, [receipt], [verificationResult]);
    importCurrentRunToReceiptArchive({ engineRoot, archiveRoot });
    const archiveBundle = readReceiptArchiveBundle(receipt.receipt_hash, { archiveRoot });
    const sidecar = buildCurrentReceiptEconomicsSidecar(receipt, { verificationResult, archiveBundle });

    for (const field of ['avg_buy_quote_price', 'avg_sell_quote_price', 'allocated_cost_basis_quote', 'realized_pnl_quote', 'realized_pnl_pct']) {
      assert.strictEqual(sidecar.hash_bound_fields[field], receipt[field], field);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate import is unchanged and leaves sidecar and index bytes unchanged', () => {
  const item = fixture();
  try {
    const options = {
      engineRoot: item.engineRoot,
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
      write: true,
    };
    importCurrentReceiptEconomics(options);
    const sidecarPath = join(item.economicsRoot, 'receipts', `${item.receipt.receipt_hash}.json`);
    const indexPath = join(item.economicsRoot, 'index.json');
    const before = [readFileSync(sidecarPath, 'utf8'), readFileSync(indexPath, 'utf8')];
    const repeat = importCurrentReceiptEconomics(options);

    assert.equal(repeat.written, 0);
    assert.equal(repeat.unchanged, 1);
    assert.deepEqual([readFileSync(sidecarPath, 'utf8'), readFileSync(indexPath, 'utf8')], before);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('conflicting existing sidecar fails closed without changing its bytes or creating an index', () => {
  const item = fixture();
  try {
    const sidecar = buildCurrentReceiptEconomicsSidecar(item.receipt, {
      verificationResult: item.verificationResult,
      archiveBundle: item.archiveBundle,
    });
    const conflict = structuredClone(sidecar);
    conflict.provenance.recovery_method = 'retained_canonical_receipt';
    const sidecarPath = join(item.economicsRoot, 'receipts', `${item.receipt.receipt_hash}.json`);
    mkdirSync(dirname(sidecarPath), { recursive: true });
    writeFileSync(sidecarPath, serializeReceiptEconomicsSidecar(conflict), 'utf8');
    const before = readFileSync(sidecarPath, 'utf8');

    expectEconomicsCode(
      () => importCurrentReceiptEconomics({
        engineRoot: item.engineRoot,
        archiveRoot: item.archiveRoot,
        economicsRoot: item.economicsRoot,
        write: true,
      }),
      'receipt_economics_conflict',
    );
    assert.equal(readFileSync(sidecarPath, 'utf8'), before);
    assert.equal(existsSync(join(item.economicsRoot, 'index.json')), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('write mode requires an explicit economics root', () => {
  const item = fixture();
  try {
    expectEconomicsCode(
      () => importCurrentReceiptEconomics({
        engineRoot: item.engineRoot,
        archiveRoot: item.archiveRoot,
        write: true,
      }),
      'explicit_economics_root_required',
    );
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('only canonical sidecar fields are copied and no path timestamp raw history or network operation appears', () => {
  const item = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network not allowed'); };
  try {
    const receipt = {
      ...item.receipt,
      raw_transactions: [{ secret: 'RAW_HISTORY_SENTINEL' }],
      source_path: 'C:\\machine\\private\\receipt.json',
      generated_at: '2099-01-01T00:00:00.000Z',
    };
    const sidecar = buildCurrentReceiptEconomicsSidecar(receipt, {
      verificationResult: item.verificationResult,
      archiveBundle: item.archiveBundle,
    });
    const bytes = serializeReceiptEconomicsSidecar(sidecar);
    assert.ok(!bytes.includes('RAW_HISTORY_SENTINEL'));
    assert.ok(!bytes.includes('machine'));
    assert.ok(!bytes.includes('2099-01-01'));
    assert.ok(!bytes.includes('upload'));
    assert.ok(!bytes.includes('mint'));
    assert.ok(!bytes.includes('signing'));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('Windows-like and Linux-like output roots produce identical sidecar and index bytes', () => {
  const item = fixture();
  try {
    const windowsRoot = join(item.root, 'C:\\checkout\\economics');
    const linuxRoot = join(item.root, 'home', 'user', 'checkout', 'economics');
    for (const economicsRoot of [windowsRoot, linuxRoot]) {
      importCurrentReceiptEconomics({
        engineRoot: item.engineRoot,
        archiveRoot: item.archiveRoot,
        economicsRoot,
        write: true,
      });
    }
    for (const path of [join('receipts', `${item.receipt.receipt_hash}.json`), 'index.json']) {
      assert.equal(readFileSync(join(windowsRoot, path), 'utf8'), readFileSync(join(linuxRoot, path), 'utf8'));
    }
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

await asyncTest('CLI defaults to dry-run and rejects write without explicit output', async () => {
  const item = fixture();
  try {
    let stdout = '';
    let stderr = '';
    const dryCode = await main({
      argv: ['--engine-root', item.engineRoot, '--archive-root', item.archiveRoot],
      stdout: { write: chunk => { stdout += chunk; } },
      stderr: { write: chunk => { stderr += chunk; } },
    });
    assert.equal(dryCode, 0);
    assert.equal(stderr, '');
    assert.ok(stdout.includes('mode: dry-run'));
    assert.equal(existsSync(item.economicsRoot), false);

    stdout = '';
    stderr = '';
    const writeCode = await main({
      argv: ['--write', '--engine-root', item.engineRoot, '--archive-root', item.archiveRoot],
      stdout: { write: chunk => { stdout += chunk; } },
      stderr: { write: chunk => { stderr += chunk; } },
    });
    assert.equal(writeCode, 1);
    assert.equal(stdout, '');
    assert.equal(stderr, 'receipt_economics_import_failed: explicit_economics_root_required\n');
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

console.log(`\nCurrent receipt economics import tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
