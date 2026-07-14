#!/usr/bin/env node

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildReceiptArchiveBundle,
  readReceiptArchiveBundle,
  rebuildReceiptArchiveIndex,
  writeReceiptArchiveBundle,
  ReceiptArchiveError,
} from './archive-store.mjs';

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

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'trade-artifact-archive-'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function makeRecord(receiptHash, overrides = {}) {
  return {
    receipt_hash: receiptHash,
    receipt_id: overrides.receipt_id || `art_v12_cp_${receiptHash.slice(0, 6)}_0`,
    receipt_version: '1.2.0',
    receipt_type: 'closed_position',
    wallet: overrides.wallet || 'TEST_WALLET',
    chain: 'solana',
    token_mint: overrides.token_mint || 'TEST_TOKEN',
    quote_mint: 'TEST_QUOTE',
    quote_symbol: 'USDC',
    candidate_hash: overrides.candidate_hash || 'c'.repeat(64),
    verification_status: overrides.verification_status || 'verified',
    display_status: 'Verified Closed Position',
    valuation_status: 'raw_quote',
    position_status: 'closed',
    first_event_at: 1700000000,
    last_event_at: 1700000300,
    snapshot_at: null,
    flags: [],
    limitations: {
      receipt_scope: 'closed_position',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    },
    hash_valid: true,
    recomputed_hash: receiptHash,
    verifier_passed: true,
    verifier_schema_valid: true,
    verifier_consistency_valid: true,
    verifier_rule_violations: [],
    valuation_valid: true,
    valuation_context: {
      valuation_currency: 'raw_quote',
      quote_is_usd_stable: true,
      violations: [],
    },
    image_status: 'rendered',
    image_artifact_path: `data/debug/receipt-images-v12/${receiptHash}.svg`,
    image_artifact_hash: `sha256:${receiptHash.slice(0, 8)}`,
    metadata_name: `Trade Receipt ${receiptHash.slice(0, 8)}`,
    metadata_template_path: null,
    resolved_metadata_path: null,
    final_metadata_path: null,
    upload_status: null,
    upload_mode: null,
    upload_network: null,
    final_image_uri: null,
    final_metadata_uri: null,
    uploaded_at: null,
    uploader_pubkey: null,
    mint_ready: false,
    mint_blockers: ['explicit_mint_approval_required'],
    mint_required_steps: [],
    mint_status: null,
    mint_network: null,
    metadata_uri: null,
    image_uri: null,
    external_url: null,
    proof_wallet_pubkey: null,
    mint_authority_pubkey: null,
    mint_address: null,
    token_account: null,
    transaction_signature: null,
    minted_at: null,
    proof_summary: {
      verification_status: overrides.verification_status || 'verified',
      violations: 0,
    },
    ...overrides.extraFields,
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

function tempFiles(root) {
  const receiptsDir = join(archiveRoot(root), 'receipts');
  const rootDir = archiveRoot(root);
  const names = [];
  if (existsSync(receiptsDir)) names.push(...readdirSync(receiptsDir).filter(name => name.includes('.tmp')));
  if (existsSync(rootDir)) names.push(...readdirSync(rootDir).filter(name => name.includes('.tmp')));
  return names;
}

function assertArchiveError(fn, code) {
  assert.throws(fn, error => error instanceof ReceiptArchiveError && error.code === code);
}

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);

test('two receipts from separate synthetic runs coexist', () => {
  const root = makeRoot();
  try {
    const bundleA = buildReceiptArchiveBundle(makeRecord(hashB, { token_mint: 'TOKEN_B' }), { provenance: { run_label: 'run-b' } });
    const bundleB = buildReceiptArchiveBundle(makeRecord(hashA, { token_mint: 'TOKEN_A' }), { provenance: { run_label: 'run-a' } });

    writeReceiptArchiveBundle(bundleA, { archiveRoot: archiveRoot(root) });
    writeReceiptArchiveBundle(bundleB, { archiveRoot: archiveRoot(root) });
    const { index } = rebuildReceiptArchiveIndex({ archiveRoot: archiveRoot(root) });

    assert.equal(index.receipt_count, 2);
    assert.deepEqual(index.receipts.map(entry => entry.receipt_hash), [hashA, hashB]);
    assert.equal(readReceiptArchiveBundle(hashA, { archiveRoot: archiveRoot(root) }).inventory_record.token_mint, 'TOKEN_A');
  } finally {
    cleanup(root);
  }
});

test('bundle and index output are byte-stable', () => {
  const root = makeRoot();
  try {
    const bundle = buildReceiptArchiveBundle(makeRecord(hashA));
    writeReceiptArchiveBundle(bundle, { archiveRoot: archiveRoot(root) });
    rebuildReceiptArchiveIndex({ archiveRoot: archiveRoot(root) });
    const firstBundleBytes = readFileSync(bundlePath(root, hashA), 'utf8');
    const firstIndexBytes = readFileSync(indexPath(root), 'utf8');

    rmSync(archiveRoot(root), { recursive: true, force: true });
    writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA)), { archiveRoot: archiveRoot(root) });
    rebuildReceiptArchiveIndex({ archiveRoot: archiveRoot(root) });

    assert.equal(readFileSync(bundlePath(root, hashA), 'utf8'), firstBundleBytes);
    assert.equal(readFileSync(indexPath(root), 'utf8'), firstIndexBytes);
  } finally {
    cleanup(root);
  }
});

test('duplicate import is a no-op', () => {
  const root = makeRoot();
  try {
    const bundle = buildReceiptArchiveBundle(makeRecord(hashA));
    const first = writeReceiptArchiveBundle(bundle, { archiveRoot: archiveRoot(root) });
    const second = writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA)), { archiveRoot: archiveRoot(root) });

    assert.equal(first.status, 'written');
    assert.equal(second.status, 'unchanged');
    assert.deepEqual(second.warnings, []);
  } finally {
    cleanup(root);
  }
});

test('same hash with different canonical receipt fails closed', () => {
  const root = makeRoot();
  try {
    writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA, { token_mint: 'TOKEN_A' })), { archiveRoot: archiveRoot(root) });
    assertArchiveError(
      () => writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA, { token_mint: 'TOKEN_CHANGED' })), { archiveRoot: archiveRoot(root) }),
      'receipt_hash_conflict'
    );
  } finally {
    cleanup(root);
  }
});

test('same receipt_id with different hashes warns but succeeds', () => {
  const root = makeRoot();
  try {
    const receiptId = 'art_v12_cp_SHARED_0';
    const first = writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA, { receipt_id: receiptId })), { archiveRoot: archiveRoot(root) });
    const second = writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashB, { receipt_id: receiptId })), { archiveRoot: archiveRoot(root) });
    const { index } = rebuildReceiptArchiveIndex({ archiveRoot: archiveRoot(root) });

    assert.deepEqual(first.warnings, []);
    assert.equal(second.status, 'written');
    assert.equal(second.warnings[0].code, 'receipt_id_multiple_hashes');
    assert.deepEqual(second.warnings[0].receipt_hashes, [hashA, hashB]);
    assert.equal(index.warnings[0].code, 'receipt_id_multiple_hashes');
  } finally {
    cleanup(root);
  }
});

test('corrupt bundle prevents index replacement', () => {
  const root = makeRoot();
  try {
    writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA)), { archiveRoot: archiveRoot(root) });
    rebuildReceiptArchiveIndex({ archiveRoot: archiveRoot(root) });
    const previousIndex = readFileSync(indexPath(root), 'utf8');

    mkdirSync(join(archiveRoot(root), 'receipts'), { recursive: true });
    writeFileSync(bundlePath(root, hashB), '{ corrupt json', 'utf8');

    assert.throws(() => rebuildReceiptArchiveIndex({ archiveRoot: archiveRoot(root) }), SyntaxError);
    assert.equal(readFileSync(indexPath(root), 'utf8'), previousIndex);
  } finally {
    cleanup(root);
  }
});

test('index order is hash ascending', () => {
  const root = makeRoot();
  try {
    for (const hash of [hashC, hashA, hashB]) {
      writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hash)), { archiveRoot: archiveRoot(root) });
    }
    const { index } = rebuildReceiptArchiveIndex({ archiveRoot: archiveRoot(root) });
    assert.deepEqual(index.receipts.map(entry => entry.receipt_hash), [hashA, hashB, hashC]);
  } finally {
    cleanup(root);
  }
});

test('raw wallet transaction data is rejected', () => {
  assertArchiveError(
    () => buildReceiptArchiveBundle(makeRecord(hashA, { extraFields: { raw_transactions: [{ signature: 'tx' }] } })),
    'raw_wallet_data_not_allowed'
  );
});

test('no network upload mint or signing activity is performed', () => {
  const root = makeRoot();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call not allowed'); };
  try {
    writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA)), { archiveRoot: archiveRoot(root) });
    rebuildReceiptArchiveIndex({ archiveRoot: archiveRoot(root) });
    assert.ok(existsSync(bundlePath(root, hashA)));
  } finally {
    globalThis.fetch = originalFetch;
    cleanup(root);
  }
});

test('no temp files remain after successful writes', () => {
  const root = makeRoot();
  try {
    writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA)), { archiveRoot: archiveRoot(root) });
    rebuildReceiptArchiveIndex({ archiveRoot: archiveRoot(root) });
    assert.deepEqual(tempFiles(root), []);
  } finally {
    cleanup(root);
  }
});

console.log(`\nReceipt archive store tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
