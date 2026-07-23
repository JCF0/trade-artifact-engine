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
import { join } from 'path';
import { tmpdir } from 'os';
import { Worker } from 'worker_threads';

import {
  loadCandidatesFile,
  main,
  parseCandidateBytes,
  recoverReceiptEconomics,
} from './recover-receipt-economics.mjs';
import {
  buildReceiptArchiveBundle,
  readReceiptArchiveBundle,
  rebuildReceiptArchiveIndex,
  writeReceiptArchiveBundle,
} from './archive-store.mjs';
import {
  buildReceiptEconomicsSidecar,
  writeReceiptEconomicsSidecar,
  ReceiptEconomicsError,
} from './receipt-economics-store.mjs';
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

function makeReceipt(overrides = {}) {
  const receipt = {
    receipt_id: 'art_v12_cp_RAY_0',
    receipt_version: '1.2.0',
    receipt_type: 'closed_position',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    token_mint: 'RAYTESTMINT12345678901234567890123456789012345',
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'trade-artifact-recovery-'));
  const archiveRoot = join(root, 'archive');
  const economicsRoot = join(root, 'economics');
  const receipt = makeReceipt();
  writeReceiptArchiveBundle(buildReceiptArchiveBundle(receipt), { archiveRoot });
  const candidate = {
    receipt_hash: receipt.receipt_hash,
    canonical_receipt: receipt,
    verification_result: verifyReceipt(receipt),
    recovery_method: 'retained_canonical_receipt',
  };
  return { root, archiveRoot, economicsRoot, receipt, candidate };
}

function addCandidate(item, overrides = {}, recoveryMethod = 'hash_matched_regeneration') {
  const receipt = makeReceipt({
    receipt_id: 'art_v12_cp_SECOND_1',
    token_mint: 'SECONDTESTMINT12345678901234567890123456789012',
    segment_index: 1,
    first_event_at: 1700010000,
    last_event_at: 1700010456,
    hold_time_seconds: 456,
    entry_tx_hashes: ['second-entry'],
    exit_tx_hashes: ['second-exit'],
    num_buys: 1,
    num_sells: 1,
    ...overrides,
  });
  writeReceiptArchiveBundle(buildReceiptArchiveBundle(receipt), { archiveRoot: item.archiveRoot });
  return {
    receipt,
    candidate: {
      receipt_hash: receipt.receipt_hash,
      canonical_receipt: receipt,
      verification_result: verifyReceipt(receipt),
      recovery_method: recoveryMethod,
    },
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof ReceiptEconomicsError && error.code === code);
}

function candidateWithUnknownTarget(item, canonicalOverrides = {}) {
  const targetHash = 'd'.repeat(64);
  return {
    receipt_hash: targetHash,
    canonical_receipt: {
      ...item.receipt,
      ...canonicalOverrides,
      receipt_hash: targetHash,
    },
    verification_result: {
      ...item.candidate.verification_result,
      receipt_hash: targetHash,
      recomputed_hash: targetHash,
    },
    recovery_method: 'hash_matched_regeneration',
  };
}

function errorCodes(summary, receiptHash) {
  return summary.error_codes_by_candidate_hash[receiptHash] ?? [];
}

function directoryDigest(root) {
  if (!existsSync(root)) return null;
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else files.push(path);
    }
  }
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    hash.update(path.slice(root.length));
    hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}

test('exact published-hash candidate is accepted and dry-run writes nothing', () => {
  const item = fixture();
  try {
    const summary = recoverReceiptEconomics({
      candidates: [item.candidate],
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
    });
    assert.deepEqual(summary, {
      status: 'ok',
      mode: 'dry-run',
      candidates_discovered: 1,
      eligible: 1,
      rejected: 0,
      would_write: 1,
      written: 0,
      unchanged: 0,
      conflicts: 0,
      error_codes_by_candidate_hash: {},
    });
    assert.equal(existsSync(item.economicsRoot), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('one changed economic value and one changed transaction hash are rejected by exact hash recomputation', () => {
  const item = fixture();
  try {
    for (const mutate of [
      receipt => { receipt.realized_pnl_quote += 0.000001; },
      receipt => { receipt.entry_tx_hashes[0] = 'changed-entry'; },
    ]) {
      const candidate = structuredClone(item.candidate);
      mutate(candidate.canonical_receipt);
      const summary = recoverReceiptEconomics({ candidates: [candidate], archiveRoot: item.archiveRoot });
      assert.equal(summary.eligible, 0);
      assert.deepEqual(errorCodes(summary, item.receipt.receipt_hash), ['recomputed_receipt_hash_mismatch']);
    }
    assert.equal(existsSync(item.economicsRoot), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('verifier failure and persisted verifier mismatch are rejected', () => {
  const item = fixture();
  try {
    const failedVerifier = structuredClone(item.candidate);
    failedVerifier.verification_result.pass = false;
    let summary = recoverReceiptEconomics({ candidates: [failedVerifier], archiveRoot: item.archiveRoot });
    assert.deepEqual(errorCodes(summary, item.receipt.receipt_hash), ['verification_gate_failed']);

    const mismatchedVerifier = structuredClone(item.candidate);
    mismatchedVerifier.verification_result.receipt_id = 'different-persisted-id';
    summary = recoverReceiptEconomics({ candidates: [mismatchedVerifier], archiveRoot: item.archiveRoot });
    assert.deepEqual(errorCodes(summary, item.receipt.receipt_hash), ['verification_result_mismatch']);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('candidate-hash-only receipt-ID-only and event-bound-only matches cannot select an archive target', () => {
  const item = fixture();
  try {
    const cases = [
      candidateWithUnknownTarget(item, {
        receipt_id: 'different-id',
        first_event_at: 1800000000,
        last_event_at: 1800000123,
        candidate_hash: item.receipt.candidate_hash,
      }),
      candidateWithUnknownTarget(item, {
        receipt_id: item.receipt.receipt_id,
        candidate_hash: 'e'.repeat(64),
        first_event_at: 1800000000,
        last_event_at: 1800000123,
      }),
      candidateWithUnknownTarget(item, {
        receipt_id: 'different-id',
        candidate_hash: 'e'.repeat(64),
        first_event_at: item.receipt.first_event_at,
        last_event_at: item.receipt.last_event_at,
      }),
    ];
    for (const candidate of cases) {
      const summary = recoverReceiptEconomics({ candidates: [candidate], archiveRoot: item.archiveRoot });
      assert.equal(summary.eligible, 0);
      assert.deepEqual(errorCodes(summary, candidate.receipt_hash), ['zero_target_matches']);
    }
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('zero exact target matches duplicate target candidates and wrong recovery method reject deterministically', () => {
  const item = fixture();
  try {
    const missing = candidateWithUnknownTarget(item, {
      receipt_id: 'no-match',
      candidate_hash: 'e'.repeat(64),
      first_event_at: 1800000000,
      last_event_at: 1800000001,
    });
    let summary = recoverReceiptEconomics({ candidates: [missing], archiveRoot: item.archiveRoot });
    assert.deepEqual(errorCodes(summary, missing.receipt_hash), ['zero_target_matches']);

    summary = recoverReceiptEconomics({
      candidates: [item.candidate, structuredClone(item.candidate)],
      archiveRoot: item.archiveRoot,
    });
    assert.equal(summary.rejected, 2);
    assert.deepEqual(errorCodes(summary, item.receipt.receipt_hash), ['duplicate_target_candidates']);

    const wrongMethod = { ...item.candidate, recovery_method: 'manual_recovery' };
    summary = recoverReceiptEconomics({ candidates: [wrongMethod], archiveRoot: item.archiveRoot });
    assert.deepEqual(errorCodes(summary, item.receipt.receipt_hash), ['invalid_recovery_method']);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('changed overlapping archive field is rejected even when it is not receipt-hash-bound', () => {
  const item = fixture();
  try {
    const candidate = structuredClone(item.candidate);
    candidate.canonical_receipt.receipt_id = 'different-receipt-id';
    candidate.verification_result = verifyReceipt(candidate.canonical_receipt);
    const summary = recoverReceiptEconomics({ candidates: [candidate], archiveRoot: item.archiveRoot });
    assert.deepEqual(errorCodes(summary, item.receipt.receipt_hash), ['archive_overlap_mismatch']);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('write requires an explicit economics root and an identical existing sidecar is unchanged', () => {
  const item = fixture();
  try {
    expectCode(
      () => recoverReceiptEconomics({ candidates: [item.candidate], archiveRoot: item.archiveRoot, write: true }),
      'explicit_economics_root_required',
    );
    let summary = recoverReceiptEconomics({
      candidates: [item.candidate],
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
      write: true,
    });
    assert.equal(summary.written, 1);
    const sidecarPath = join(item.economicsRoot, 'receipts', `${item.receipt.receipt_hash}.json`);
    const indexPath = join(item.economicsRoot, 'index.json');
    const before = [readFileSync(sidecarPath, 'utf8'), readFileSync(indexPath, 'utf8')];

    summary = recoverReceiptEconomics({
      candidates: [structuredClone(item.candidate)],
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
      write: true,
    });
    assert.equal(summary.written, 0);
    assert.equal(summary.unchanged, 1);
    assert.deepEqual([readFileSync(sidecarPath, 'utf8'), readFileSync(indexPath, 'utf8')], before);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('an existing recovery lock fails closed before any economics write', () => {
  const item = fixture();
  try {
    const lockPath = join(item.root, '.economics.receipt-economics-recovery.lock');
    mkdirSync(lockPath);
    expectCode(
      () => recoverReceiptEconomics({
        candidates: [item.candidate],
        archiveRoot: item.archiveRoot,
        economicsRoot: item.economicsRoot,
        write: true,
      }),
      'receipt_economics_recovery_locked',
    );
    assert.equal(existsSync(item.economicsRoot), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('all existing-sidecar conflicts are preflighted before any batch write', () => {
  const item = fixture();
  try {
    const second = addCandidate(item);
    const archiveBundle = readReceiptArchiveBundle(second.receipt.receipt_hash, { archiveRoot: item.archiveRoot });
    const conflicting = buildReceiptEconomicsSidecar(second.receipt, {
      archiveBundle,
      recoveryMethod: 'retained_canonical_receipt',
    });
    writeReceiptEconomicsSidecar(conflicting, {
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
    });
    const conflictPath = join(item.economicsRoot, 'receipts', `${second.receipt.receipt_hash}.json`);
    const conflictBefore = readFileSync(conflictPath, 'utf8');

    const summary = recoverReceiptEconomics({
      candidates: [item.candidate, second.candidate],
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
      write: true,
    });
    assert.equal(summary.status, 'conflict');
    assert.equal(summary.conflicts, 1);
    assert.equal(summary.written, 0);
    assert.deepEqual(errorCodes(summary, second.receipt.receipt_hash), ['receipt_economics_conflict']);
    assert.equal(existsSync(join(item.economicsRoot, 'receipts', `${item.receipt.receipt_hash}.json`)), false);
    assert.equal(readFileSync(conflictPath, 'utf8'), conflictBefore);
    assert.equal(existsSync(join(item.economicsRoot, 'index.json')), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('a failure after sidecar publication rolls back the newly written batch', () => {
  const item = fixture();
  try {
    const orphanHash = 'f'.repeat(64);
    const orphanPath = join(item.economicsRoot, 'receipts', `${orphanHash}.json`);
    mkdirSync(join(item.economicsRoot, 'receipts'), { recursive: true });
    writeFileSync(orphanPath, '{ corrupt orphan', 'utf8');

    assert.throws(() => recoverReceiptEconomics({
      candidates: [item.candidate],
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
      write: true,
    }));
    assert.equal(existsSync(join(item.economicsRoot, 'receipts', `${item.receipt.receipt_hash}.json`)), false);
    assert.equal(readFileSync(orphanPath, 'utf8'), '{ corrupt orphan');
    assert.equal(existsSync(join(item.economicsRoot, 'index.json')), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('report ordering and sidecar bytes are deterministic and contain no operational provenance', () => {
  const item = fixture();
  try {
    const second = addCandidate(item);
    const candidates = [item.candidate, second.candidate];
    const firstReport = recoverReceiptEconomics({ candidates, archiveRoot: item.archiveRoot });
    const secondReport = recoverReceiptEconomics({
      candidates: structuredClone(candidates).reverse(),
      archiveRoot: item.archiveRoot,
    });
    assert.deepEqual(secondReport, firstReport);

    const roots = [join(item.root, 'windows-like'), join(item.root, 'linux-like')];
    for (const economicsRoot of roots) {
      recoverReceiptEconomics({ candidates, archiveRoot: item.archiveRoot, economicsRoot, write: true });
    }
    for (const candidate of candidates) {
      const relative = join('receipts', `${candidate.receipt_hash}.json`);
      const left = readFileSync(join(roots[0], relative), 'utf8');
      const right = readFileSync(join(roots[1], relative), 'utf8');
      assert.equal(left, right);
      assert.ok(!left.includes(item.root));
      assert.ok(!left.includes('hostname'));
      assert.ok(!left.includes('provider_url'));
      assert.ok(!left.includes('generated_at'));
      const sidecar = JSON.parse(left);
      assert.deepEqual(Object.keys(sidecar.provenance).sort(), ['canonical_projection_hash', 'recovery_method']);
      assert.ok(['retained_canonical_receipt', 'hash_matched_regeneration'].includes(sidecar.provenance.recovery_method));
    }
    assert.equal(readFileSync(join(roots[0], 'index.json'), 'utf8'), readFileSync(join(roots[1], 'index.json'), 'utf8'));
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('no network operation occurs and raw input metadata cannot enter sidecar bytes', () => {
  const item = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network/fetch forbidden'); };
  try {
    const candidate = structuredClone(item.candidate);
    candidate.canonical_receipt.raw_transactions = [{ body: 'RAW_TRANSACTION_SENTINEL' }];
    candidate.canonical_receipt.source_path = '/private/recovery/candidate.json';
    candidate.canonical_receipt.hostname = 'recovery-host';
    candidate.canonical_receipt.provider_url = 'https://provider.invalid';
    candidate.canonical_receipt.generated_at = '2099-01-01T00:00:00.000Z';
    const summary = recoverReceiptEconomics({
      candidates: [candidate],
      archiveRoot: item.archiveRoot,
      economicsRoot: item.economicsRoot,
      write: true,
    });
    assert.equal(summary.written, 1);
    const bytes = readFileSync(join(item.economicsRoot, 'receipts', `${item.receipt.receipt_hash}.json`), 'utf8');
    for (const sentinel of ['RAW_TRANSACTION_SENTINEL', '/private/recovery', 'recovery-host', 'provider.invalid', '2099-01-01']) {
      assert.ok(!bytes.includes(sentinel), sentinel);
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('archive-v1 bytes and index remain unchanged and production engine/data is never an implicit write target', () => {
  const item = fixture();
  try {
    rebuildReceiptArchiveIndex({ archiveRoot: item.archiveRoot });
    const archiveBefore = directoryDigest(item.archiveRoot);
    const productionRoot = join('engine', 'data', 'inventory', 'receipt-economics-v1');
    const productionBefore = directoryDigest(productionRoot);

    recoverReceiptEconomics({ candidates: [item.candidate], archiveRoot: item.archiveRoot });

    assert.equal(directoryDigest(item.archiveRoot), archiveBefore);
    assert.equal(directoryDigest(productionRoot), productionBefore);
    assert.equal(existsSync(item.economicsRoot), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('JSON arrays JSON objects and JSONL candidate files parse as local candidate records', () => {
  const item = fixture();
  try {
    assert.deepEqual(parseCandidateBytes(Buffer.from(JSON.stringify([item.candidate]))), [item.candidate]);
    assert.deepEqual(parseCandidateBytes(Buffer.from(JSON.stringify(item.candidate))), [item.candidate]);
    assert.deepEqual(parseCandidateBytes(Buffer.from(`${JSON.stringify(item.candidate)}\n${JSON.stringify(item.candidate)}\n`)), [item.candidate, item.candidate]);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('candidate loader rejects URLs and harness source has no network provider pipeline upload mint or signing integration', () => {
  expectCode(() => loadCandidatesFile('https://provider.invalid/ray.json'), 'local_candidates_file_required');
  expectCode(() => loadCandidatesFile('file:///tmp/ray.json'), 'local_candidates_file_required');

  const source = readFileSync(new URL('./recover-receipt-economics.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    /\bfetch\s*\(/,
    /from ['"](?:https?|node:https|node:http)/,
    /from ['"].*scanner\.mjs/,
    /from ['"].*pipeline/,
    /from ['"].*(?:upload|mint|sign)/,
    /(?:@solana|helius|jupiter|raydium)/i,
  ]) {
    assert.equal(forbidden.test(source), false, String(forbidden));
  }
});

await asyncTest('concurrent different-byte recovery batches publish once without deleting the winner', async () => {
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { recoverReceiptEconomics } = await import(workerData.moduleUrl);
      const state = new Int32Array(workerData.shared);
      Atomics.add(state, 0, 1);
      Atomics.notify(state, 0);
      Atomics.wait(state, 1, 0);
      try {
        const summary = recoverReceiptEconomics({
          candidates: [workerData.candidate],
          archiveRoot: workerData.archiveRoot,
          economicsRoot: workerData.economicsRoot,
          write: true,
        });
        parentPort.postMessage({ kind: summary.written === 1 ? 'written' : summary.status });
      } catch (error) {
        parentPort.postMessage({
          kind: error.code === 'receipt_economics_conflict' ? 'conflict' : (error.code ?? error.name),
        });
      }
    })();
  `;
  const moduleUrl = new URL('./recover-receipt-economics.mjs', import.meta.url).href;

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const item = fixture();
    try {
      const alternative = { ...item.candidate, recovery_method: 'hash_matched_regeneration' };
      const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const state = new Int32Array(shared);
      const workers = [item.candidate, alternative].map(candidate => new Worker(workerSource, {
        eval: true,
        workerData: {
          moduleUrl,
          candidate,
          archiveRoot: item.archiveRoot,
          economicsRoot: item.economicsRoot,
          shared,
        },
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

      const kinds = results.map(result => result.kind);
      assert.equal(kinds.filter(kind => kind === 'written').length, 1);
      assert.ok(kinds.some(kind => ['conflict', 'receipt_economics_recovery_locked'].includes(kind)));
      const sidecarPath = join(item.economicsRoot, 'receipts', `${item.receipt.receipt_hash}.json`);
      assert.equal(existsSync(sidecarPath), true);
      const stored = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      assert.ok(['retained_canonical_receipt', 'hash_matched_regeneration'].includes(stored.provenance.recovery_method));
      const index = JSON.parse(readFileSync(join(item.economicsRoot, 'index.json'), 'utf8'));
      assert.deepEqual(index.receipts.map(entry => entry.receipt_hash), [item.receipt.receipt_hash]);
      assert.deepEqual(readdirSync(item.root).filter(name => name.includes('.recovery.') && name.endsWith('.tmp')), []);
      assert.deepEqual(readdirSync(item.root).filter(name => name.endsWith('.receipt-economics-recovery.lock')), []);
    } finally {
      rmSync(item.root, { recursive: true, force: true });
    }
  }
});

await asyncTest('CLI defaults to dry-run and write requires an explicit economics root', async () => {
  const item = fixture();
  try {
    const candidatesPath = join(item.root, 'ray-candidate.json');
    writeFileSync(candidatesPath, `${JSON.stringify(item.candidate)}\n`, 'utf8');
    let stdout = '';
    let stderr = '';
    let code = await main({
      argv: ['--candidates', candidatesPath, '--archive-root', item.archiveRoot],
      stdout: { write: chunk => { stdout += chunk; } },
      stderr: { write: chunk => { stderr += chunk; } },
    });
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.ok(stdout.includes('mode: dry-run'));
    assert.ok(stdout.includes('candidates_discovered: 1'));
    assert.equal(existsSync(item.economicsRoot), false);

    stdout = '';
    stderr = '';
    code = await main({
      argv: ['--candidates', candidatesPath, '--archive-root', item.archiveRoot, '--write'],
      stdout: { write: chunk => { stdout += chunk; } },
      stderr: { write: chunk => { stderr += chunk; } },
    });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.equal(stderr, 'receipt_economics_recovery_failed: explicit_economics_root_required\n');
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

console.log(`\nReceipt economics recovery tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
