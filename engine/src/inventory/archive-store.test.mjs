#!/usr/bin/env node

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildReceiptArchiveBundle,
  readReceiptArchiveBundle,
  rebuildReceiptArchiveIndex,
  stableJson,
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


function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function portablePathVariantRecord(receiptHash, variant) {
  const record = makeRecord(receiptHash, {
    extraFields: {
      generated_at: variant.generated_at,
      imported_at: variant.imported_at,
      created_at: variant.created_at,
      updated_at: variant.updated_at,
      absolute_path: variant.absolute_path,
      engine_root: variant.engine_root,
    },
  });
  record.image_artifact_path = variant.image_artifact_path;
  record.metadata_template_path = variant.metadata_template_path;
  record.resolved_metadata_path = variant.resolved_metadata_path;
  record.final_metadata_path = variant.final_metadata_path;
  return record;
}

test('Windows-style and POSIX-style paths produce byte-identical bundles', () => {
  const windowsRecord = portablePathVariantRecord(hashA, {
    image_artifact_path: 'C:\\checkout\\engine\\data\\debug\\receipt-images-v12\\a.svg',
    metadata_template_path: 'C:\\checkout\\engine\\data\\debug\\metadata-packages-v12\\a.json',
    resolved_metadata_path: 'C:\\checkout\\engine\\data\\debug\\upload-dry-run-v12\\a.json',
    final_metadata_path: 'C:\\checkout\\engine\\data\\debug\\upload-results-v12\\a.json',
    absolute_path: 'C:\\checkout\\engine\\data\\debug\\ledger-receipts-v12.json',
    engine_root: 'C:\\checkout\\engine',
    generated_at: '2026-07-14T00:00:00.000Z',
    imported_at: '2026-07-14T00:00:01.000Z',
    created_at: '2026-07-14T00:00:02.000Z',
    updated_at: '2026-07-14T00:00:03.000Z',
  });
  const posixRecord = portablePathVariantRecord(hashA, {
    image_artifact_path: '/home/user/checkout/engine/data/debug/receipt-images-v12/a.svg',
    metadata_template_path: '/home/user/checkout/engine/data/debug/metadata-packages-v12/a.json',
    resolved_metadata_path: '/home/user/checkout/engine/data/debug/upload-dry-run-v12/a.json',
    final_metadata_path: '/home/user/checkout/engine/data/debug/upload-results-v12/a.json',
    absolute_path: '/home/user/checkout/engine/data/debug/ledger-receipts-v12.json',
    engine_root: '/home/user/checkout/engine',
    generated_at: '2026-07-15T00:00:00.000Z',
    imported_at: '2026-07-15T00:00:01.000Z',
    created_at: '2026-07-15T00:00:02.000Z',
    updated_at: '2026-07-15T00:00:03.000Z',
  });

  assert.equal(stableJson(buildReceiptArchiveBundle(windowsRecord)), stableJson(buildReceiptArchiveBundle(posixRecord)));
});

test('absolute paths and different checkout roots do not enter archived identity', () => {
  const bundle = buildReceiptArchiveBundle(portablePathVariantRecord(hashA, {
    image_artifact_path: 'D:\\different\\root\\image.svg',
    metadata_template_path: '/different/root/template.json',
    resolved_metadata_path: '/different/root/resolved.json',
    final_metadata_path: '/different/root/final.json',
    absolute_path: '/different/root/ledger.json',
    engine_root: '/different/root/engine',
    generated_at: '2026-07-14T00:00:00.000Z',
    imported_at: '2026-07-14T00:00:00.000Z',
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
  }));
  const text = stableJson(bundle);

  assert.ok(!text.includes('different'));
  assert.ok(!Object.hasOwn(bundle.inventory_record, 'image_artifact_path'));
  assert.ok(!Object.hasOwn(bundle.inventory_record, 'metadata_template_path'));
  assert.ok(!Object.hasOwn(bundle.inventory_record, 'resolved_metadata_path'));
  assert.ok(!Object.hasOwn(bundle.inventory_record, 'final_metadata_path'));
  assert.ok(!Object.hasOwn(bundle.inventory_record, 'absolute_path'));
  assert.ok(!Object.hasOwn(bundle.inventory_record, 'engine_root'));
});

test('runtime-only generated timestamps do not affect identity', () => {
  const first = buildReceiptArchiveBundle(makeRecord(hashA, {
    extraFields: { generated_at: '2026-07-14T00:00:00.000Z', imported_at: '2026-07-14T00:01:00.000Z' },
  }));
  const second = buildReceiptArchiveBundle(makeRecord(hashA, {
    extraFields: { generated_at: '2026-07-15T00:00:00.000Z', imported_at: '2026-07-15T00:01:00.000Z' },
  }));

  assert.equal(stableJson(first), stableJson(second));
  assert.ok(!Object.hasOwn(first.inventory_record, 'generated_at'));
  assert.ok(!Object.hasOwn(first.inventory_record, 'imported_at'));
});

test('genuine event upload and mint timestamps remain preserved and differences conflict', () => {
  const root = makeRoot();
  try {
    const firstRecord = makeRecord(hashA, {
      extraFields: {
        uploaded_at: '2026-07-01T00:01:00.000Z',
        minted_at: '2026-07-01T00:02:00.000Z',
      },
    });
    const secondRecord = makeRecord(hashA, {
      extraFields: {
        uploaded_at: '2026-07-02T00:01:00.000Z',
        minted_at: '2026-07-01T00:02:00.000Z',
      },
    });
    const bundle = buildReceiptArchiveBundle(firstRecord);

    assert.equal(bundle.inventory_record.first_event_at, 1700000000);
    assert.equal(bundle.inventory_record.last_event_at, 1700000300);
    assert.equal(bundle.inventory_record.uploaded_at, '2026-07-01T00:01:00.000Z');
    assert.equal(bundle.inventory_record.minted_at, '2026-07-01T00:02:00.000Z');

    writeReceiptArchiveBundle(bundle, { archiveRoot: archiveRoot(root) });
    assertArchiveError(
      () => writeReceiptArchiveBundle(buildReceiptArchiveBundle(secondRecord), { archiveRoot: archiveRoot(root) }),
      'receipt_archive_bundle_conflict'
    );
  } finally {
    cleanup(root);
  }
});

test('verifier valuation and lifecycle differences remain explicit conflicts', () => {
  const root = makeRoot();
  try {
    writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA)), { archiveRoot: archiveRoot(root) });

    assertArchiveError(
      () => writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA, { extraFields: { verifier_passed: false } })), { archiveRoot: archiveRoot(root) }),
      'receipt_archive_bundle_conflict'
    );
    assertArchiveError(
      () => writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA, { extraFields: { valuation_context: { valuation_currency: 'raw_quote', quote_is_usd_stable: false, violations: ['changed'] } } })), { archiveRoot: archiveRoot(root) }),
      'receipt_archive_bundle_conflict'
    );
    assertArchiveError(
      () => writeReceiptArchiveBundle(buildReceiptArchiveBundle(makeRecord(hashA, { extraFields: { upload_status: 'complete' } })), { archiveRoot: archiveRoot(root) }),
      'receipt_archive_bundle_conflict'
    );
  } finally {
    cleanup(root);
  }
});

test('portable equivalent duplicate imports remain no-ops', () => {
  const root = makeRoot();
  try {
    const first = portablePathVariantRecord(hashA, {
      image_artifact_path: 'C:\\root\\image.svg',
      metadata_template_path: 'C:\\root\\template.json',
      resolved_metadata_path: 'C:\\root\\resolved.json',
      final_metadata_path: 'C:\\root\\final.json',
      absolute_path: 'C:\\root\\source.json',
      engine_root: 'C:\\root',
      generated_at: '2026-07-14T00:00:00.000Z',
      imported_at: '2026-07-14T00:00:00.000Z',
      created_at: '2026-07-14T00:00:00.000Z',
      updated_at: '2026-07-14T00:00:00.000Z',
    });
    const second = portablePathVariantRecord(hashA, {
      image_artifact_path: '/other/root/image.svg',
      metadata_template_path: '/other/root/template.json',
      resolved_metadata_path: '/other/root/resolved.json',
      final_metadata_path: '/other/root/final.json',
      absolute_path: '/other/root/source.json',
      engine_root: '/other/root',
      generated_at: '2026-07-15T00:00:00.000Z',
      imported_at: '2026-07-15T00:00:00.000Z',
      created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z',
    });

    assert.equal(writeReceiptArchiveBundle(buildReceiptArchiveBundle(first), { archiveRoot: archiveRoot(root) }).status, 'written');
    assert.equal(writeReceiptArchiveBundle(buildReceiptArchiveBundle(second), { archiveRoot: archiveRoot(root) }).status, 'unchanged');
  } finally {
    cleanup(root);
  }
});

test('source scanner record is not mutated by archive normalization', () => {
  const record = portablePathVariantRecord(hashA, {
    image_artifact_path: 'C:\\root\\image.svg',
    metadata_template_path: 'C:\\root\\template.json',
    resolved_metadata_path: 'C:\\root\\resolved.json',
    final_metadata_path: 'C:\\root\\final.json',
    absolute_path: 'C:\\root\\source.json',
    engine_root: 'C:\\root',
    generated_at: '2026-07-14T00:00:00.000Z',
    imported_at: '2026-07-14T00:00:00.000Z',
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
  });
  const before = clone(record);

  buildReceiptArchiveBundle(record);

  assert.deepEqual(record, before);
});
console.log(`\nReceipt archive store tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
