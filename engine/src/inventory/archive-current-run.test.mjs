#!/usr/bin/env node

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

import {
  importCurrentRunToReceiptArchive,
  main,
} from './archive-current-run.mjs';
import { ReceiptArchiveError } from './archive-store.mjs';

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

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'trade-artifact-archive-import-'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeSnapshot(engineRoot, receipt, { malformed = false, includeRaw = false, legacyReceipt = null } = {}) {
  const debugDir = join(engineRoot, 'data', 'debug');
  mkdirSync(debugDir, { recursive: true });

  if (malformed) {
    writeFileSync(join(debugDir, 'ledger-receipts-v12.json'), '{ malformed json', 'utf8');
    return;
  }

  const receipts = receipt ? [receipt] : [];
  writeJson(join(debugDir, 'ledger-receipts-v12.json'), receipts);
  writeJson(join(debugDir, 'ledger-verify-v12.json'), {
    total: receipts.length,
    passed: receipts.length,
    failed: 0,
    results: receipts.map(item => ({
      receipt_id: item.receipt_id,
      receipt_hash: item.receipt_hash,
      recomputed_hash: item.receipt_hash,
      hash_valid: true,
      rule_violations: [],
      schema_valid: true,
      consistency_valid: true,
      pass: true,
    })),
  });
  writeJson(join(debugDir, 'ledger-valuations-v12.json'), {
    contexts: receipts.map(item => ({
      receipt_id: item.receipt_id,
      valuation_status: 'raw_quote',
      valuation_currency: 'raw_quote',
      quote_is_usd_stable: true,
      valid: true,
      violations: [],
    })),
  });
  writeJson(join(debugDir, 'v12-proof-pipeline-summary.json'), {
    receipts: receipts.map(item => ({
      receipt_id: item.receipt_id,
      receipt_type: item.receipt_type,
      token_mint: item.token_mint,
      verification_status: item.verification_status,
      receipt_hash: item.receipt_hash,
      candidate_hash: item.candidate_hash,
      hash_valid: true,
      violations: 0,
    })),
  });

  if (includeRaw) {
    const rawDir = join(engineRoot, 'data', 'raw');
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, 'helius_transactions.jsonl'), '{"wallet":"SHOULD_NOT_COPY","signature":"RAW_TX"}\n', 'utf8');
  }

  if (legacyReceipt) {
    const receiptsDir = join(engineRoot, 'data', 'receipts');
    mkdirSync(receiptsDir, { recursive: true });
    writeFileSync(join(receiptsDir, 'receipts.jsonl'), `${JSON.stringify(legacyReceipt)}\n`, 'utf8');
  }
}

function makeReceipt(receiptHash, overrides = {}) {
  return {
    receipt_id: overrides.receipt_id || `art_v12_cp_${receiptHash.slice(0, 6)}_0`,
    receipt_version: overrides.receipt_version || '1.2.0',
    receipt_type: 'closed_position',
    token_mint: overrides.token_mint || 'TOKEN',
    wallet: overrides.wallet || 'WALLET_SHOULD_NOT_PRINT',
    chain: 'solana',
    segment_index: 0,
    receipt_hash: receiptHash,
    verification_status: overrides.verification_status || 'verified',
    display_status: 'Verified Closed Position',
    accounting_method: 'weighted_average_position_accounting_v1',
    quote_mint: 'USDC_MINT',
    quote_symbol: 'USDC',
    valuation_status: 'raw_quote',
    position_status: 'closed',
    first_event_at: 1700000000,
    last_event_at: 1700000300,
    snapshot_at: null,
    limitations: {
      receipt_scope: 'closed_position',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    },
    flags: [],
    candidate_hash: overrides.candidate_hash || 'd'.repeat(64),
  };
}

function archiveRoot(root) {
  return join(root, 'archive');
}

function bundlePath(root, receiptHash) {
  return join(archiveRoot(root), 'receipts', `${receiptHash}.json`);
}

function indexPath(root) {
  return join(archiveRoot(root), 'index.json');
}

function readIndex(root) {
  return JSON.parse(readFileSync(indexPath(root), 'utf8'));
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      if (entry.isFile()) out.push(path);
    }
  }
  return out.sort();
}

function tempFiles(root) {
  return walkFiles(archiveRoot(root)).filter(path => path.includes('.tmp'));
}

function archiveText(root) {
  return walkFiles(archiveRoot(root)).map(path => readFileSync(path, 'utf8')).join('\n');
}

function assertArchiveError(fn, code) {
  assert.throws(fn, error => error instanceof ReceiptArchiveError && error.code === code);
}

const jupHash = '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca';
const rayHash = '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341';
const zHash = 'f'.repeat(64);

await testAsync('run A import creates one JUP-like bundle and index', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  try {
    writeSnapshot(engineA, makeReceipt(jupHash, { token_mint: 'JUP' }), { includeRaw: true });
    const summary = importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root) });

    assert.equal(summary.records_discovered, 1);
    assert.equal(summary.imported, 1);
    assert.equal(summary.unchanged, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.index_receipt_count, 1);
    assert.ok(existsSync(bundlePath(root, jupHash)));
    assert.deepEqual(readIndex(root).receipts.map(entry => entry.receipt_hash), [jupHash]);
  } finally {
    cleanup(root);
  }
});

await testAsync('run B from separate snapshot adds RAY-like bundle without removing run A', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  const engineB = join(root, 'engine-b');
  try {
    writeSnapshot(engineA, makeReceipt(jupHash, { token_mint: 'JUP' }));
    writeSnapshot(engineB, makeReceipt(rayHash, { token_mint: 'RAY' }));

    importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root) });
    const summary = importCurrentRunToReceiptArchive({ engineRoot: engineB, archiveRoot: archiveRoot(root) });

    assert.equal(summary.records_discovered, 1);
    assert.equal(summary.imported, 1);
    assert.equal(summary.index_receipt_count, 2);
    assert.ok(existsSync(bundlePath(root, jupHash)));
    assert.ok(existsSync(bundlePath(root, rayHash)));
    assert.deepEqual(readIndex(root).receipts.map(entry => entry.receipt_hash), [rayHash, jupHash].sort());
  } finally {
    cleanup(root);
  }
});

await testAsync('repeating either import is a deterministic no-op', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  const engineB = join(root, 'engine-b');
  try {
    writeSnapshot(engineA, makeReceipt(jupHash, { token_mint: 'JUP' }));
    writeSnapshot(engineB, makeReceipt(rayHash, { token_mint: 'RAY' }));

    importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root), runLabel: 'first-label' });
    importCurrentRunToReceiptArchive({ engineRoot: engineB, archiveRoot: archiveRoot(root) });
    const before = readFileSync(indexPath(root), 'utf8');
    const repeatA = importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root), runLabel: 'different-label' });
    const repeatB = importCurrentRunToReceiptArchive({ engineRoot: engineB, archiveRoot: archiveRoot(root) });

    assert.equal(repeatA.imported, 0);
    assert.equal(repeatA.unchanged, 1);
    assert.equal(repeatB.imported, 0);
    assert.equal(repeatB.unchanged, 1);
    assert.equal(readFileSync(indexPath(root), 'utf8'), before);
  } finally {
    cleanup(root);
  }
});

await testAsync('conflict is detected before valid index replacement or partial new writes', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  const engineConflict = join(root, 'engine-conflict');
  try {
    writeSnapshot(engineA, makeReceipt(jupHash, { token_mint: 'JUP' }));
    importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root) });
    const priorIndex = readFileSync(indexPath(root), 'utf8');

    const debugDir = join(engineConflict, 'data', 'debug');
    mkdirSync(debugDir, { recursive: true });
    writeJson(join(debugDir, 'ledger-receipts-v12.json'), [
      makeReceipt(jupHash, { token_mint: 'JUP_CHANGED' }),
      makeReceipt(zHash, { token_mint: 'NEW_TOKEN' }),
    ]);
    writeJson(join(debugDir, 'ledger-verify-v12.json'), { results: [] });

    assertArchiveError(
      () => importCurrentRunToReceiptArchive({ engineRoot: engineConflict, archiveRoot: archiveRoot(root) }),
      'receipt_hash_conflict'
    );
    assert.equal(readFileSync(indexPath(root), 'utf8'), priorIndex);
    assert.equal(existsSync(bundlePath(root, zHash)), false);
  } finally {
    cleanup(root);
  }
});

await testAsync('malformed current snapshot fails closed', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  const malformed = join(root, 'engine-malformed');
  try {
    writeSnapshot(engineA, makeReceipt(jupHash, { token_mint: 'JUP' }));
    importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root) });
    const priorIndex = readFileSync(indexPath(root), 'utf8');

    writeSnapshot(malformed, null, { malformed: true });
    assert.throws(() => importCurrentRunToReceiptArchive({ engineRoot: malformed, archiveRoot: archiveRoot(root) }), SyntaxError);
    assert.equal(readFileSync(indexPath(root), 'utf8'), priorIndex);
  } finally {
    cleanup(root);
  }
});

await testAsync('non-v1.2 and legacy records are ignored deterministically', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  try {
    writeSnapshot(engineA, makeReceipt(zHash, { receipt_version: '1.1.0' }), {
      legacyReceipt: { receipt_id: 'legacy_1', verification_hash: '1'.repeat(64) },
    });
    const summary = importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root) });

    assert.equal(summary.records_discovered, 0);
    assert.equal(summary.ignored_non_v12, 1);
    assert.equal(summary.imported, 0);
    assert.equal(summary.index_receipt_count, 0);
    assert.deepEqual(readIndex(root).receipts, []);
  } finally {
    cleanup(root);
  }
});

await testAsync('archive index remains hash-sorted', async () => {
  const root = makeRoot();
  try {
    for (const [name, hash] of [['engine-z', zHash], ['engine-ray', rayHash], ['engine-jup', jupHash]]) {
      const engineRoot = join(root, name);
      writeSnapshot(engineRoot, makeReceipt(hash));
      importCurrentRunToReceiptArchive({ engineRoot, archiveRoot: archiveRoot(root) });
    }

    assert.deepEqual(readIndex(root).receipts.map(entry => entry.receipt_hash), [rayHash, jupHash, zHash].sort());
  } finally {
    cleanup(root);
  }
});

await testAsync('no raw files are copied into archive', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  try {
    writeSnapshot(engineA, makeReceipt(jupHash, { token_mint: 'JUP' }), { includeRaw: true });
    importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root) });

    const files = walkFiles(archiveRoot(root)).map(path => path.replace(/\\/g, '/'));
    assert.ok(!files.some(path => path.includes('/raw/')));
    assert.ok(!archiveText(root).includes('SHOULD_NOT_COPY'));
    assert.ok(!archiveText(root).includes('RAW_TX'));
  } finally {
    cleanup(root);
  }
});

await testAsync('no network upload mint or signing calls occur', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call not allowed'); };
  try {
    writeSnapshot(engineA, makeReceipt(jupHash, { token_mint: 'JUP' }));
    const summary = importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root) });
    assert.equal(summary.index_receipt_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup(root);
  }
});

await testAsync('no temp files remain after successful execution', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  try {
    writeSnapshot(engineA, makeReceipt(jupHash, { token_mint: 'JUP' }));
    importCurrentRunToReceiptArchive({ engineRoot: engineA, archiveRoot: archiveRoot(root) });
    assert.deepEqual(tempFiles(root), []);
  } finally {
    cleanup(root);
  }
});

await testAsync('CLI returns deterministic summary without wallet or receipt contents', async () => {
  const root = makeRoot();
  const engineA = join(root, 'engine-a');
  try {
    writeSnapshot(engineA, makeReceipt(jupHash, { token_mint: 'JUP', wallet: 'SENSITIVE_WALLET' }));
    let stdout = '';
    let stderr = '';
    const code = await main({
      argv: ['--engine-root', engineA, '--archive-root', archiveRoot(root), '--run-label', 'demo'],
      stdout: { write: chunk => { stdout += chunk; } },
      stderr: { write: chunk => { stderr += chunk; } },
    });

    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.ok(stdout.includes('records_discovered: 1'));
    assert.ok(stdout.includes('imported: 1'));
    assert.ok(!stdout.includes('SENSITIVE_WALLET'));
    assert.ok(!stdout.includes(jupHash));
  } finally {
    cleanup(root);
  }
});

console.log(`\nReceipt archive import tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

