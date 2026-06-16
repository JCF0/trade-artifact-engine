/**
 * Live Upload Integration Tests — E6
 *
 * Tests gate logic, final metadata generation, idempotency,
 * result entries, and mock upload flow. No real Irys calls.
 */

import {
  checkUploadGates,
  buildFinalMetadata,
  hashFinalMetadata,
  shouldSkipUpload,
  buildUploadResultEntry,
  buildPartialResultEntry,
  uploadSingleReceipt,
} from './live-upload.mjs';
import { buildMetadataTemplate } from './upload-package.mjs';
import { buildReceiptMetadata } from './receipt-metadata.mjs';
import { buildReceiptPreview } from './receipt-preview.mjs';
import { SOL_MINT } from '../pipeline/constants.mjs';

// ═══════════════════════════════════════════════════════════════
// Test harness
// ═══════════════════════════════════════════════════════════════

let _passed = 0;
let _failed = 0;
let _total = 0;

function test(name, fn) {
  _total++;
  Promise.resolve().then(fn).then(() => {
    _passed++;
  }).catch(e => {
    _failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
  });
}

// Async test runner
async function runTests() {
  // We need to await all tests - use a sequential approach
  const tests = [];
  const originalTest = globalThis._testFn;

  // Redefine test to collect
  const testEntries = [];
  globalThis._addTest = (name, fn) => testEntries.push({ name, fn });

  // Run collection phase then execution phase below
  return testEntries;
}

// Simpler approach: synchronous + async test support
let _tests = [];
function t(name, fn) { _tests.push({ name, fn }); }

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

// ═══════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════

function allGatesOpts() {
  return {
    ledgerDebug: true,
    uploadLive: true,
    uploadConfirm: true,
    uploadEnabled: 'true',
    keypairPath: '/path/to/keypair.json',
    keypairFileExists: true,
    network: 'devnet',
    uploadMax: 1,
    uploadReceiptId: null,
  };
}

function makeReceipt() {
  return {
    receipt_id: 'art_v12_xx_TESTMINT_0',
    receipt_version: '1.2.0',
    receipt_type: 'closed_position',
    token_mint: 'TESTMINT1234567890123456789012345678901234abcd',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana', segment_index: 0,
    receipt_hash: 'a'.repeat(64),
    verification_status: 'verified',
    display_status: 'Verified Closed Position',
    accounting_method: 'weighted_average_position_accounting_v1',
    quote_mint: SOL_MINT, quote_symbol: 'SOL',
    valuation_status: 'raw_quote',
    total_bought_qty: 1000, total_bought_quote: 10, avg_buy_quote_price: 0.01,
    total_sold_qty: 1000, total_sold_quote: 15, avg_sell_quote_price: 0.015,
    allocated_cost_basis_quote: 10, remaining_qty: 0, remaining_cost_basis_quote: 0,
    realized_pnl_quote: 5, realized_pnl_pct: 50,
    first_event_at: 1700000000, last_event_at: 1700100000,
    snapshot_at: null, hold_time_seconds: 100000,
    entry_tx_hashes: ['aaaa1111'], exit_tx_hashes: ['bbbb2222'],
    num_buys: 1, num_sells: 1,
    candidate_hash: 'c'.repeat(64),
    limitations: {
      receipt_scope: 'closed_position', pnl_type: 'realized_closed',
      price_source: 'on_chain_swaps', valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    },
    flags: [],
  };
}

function makeTemplate() {
  const receipt = makeReceipt();
  const preview = buildReceiptPreview(receipt);
  const metadata = buildReceiptMetadata(receipt, preview);
  return buildMetadataTemplate(metadata, {
    local_path: 'data/debug/receipt-images-v12/art_v12_xx_TESTMINT_0.svg',
    content_type: 'image/svg+xml',
    artifact_hash: 'sha256:' + 'b'.repeat(64),
  });
}

function makePackageEntry() {
  return {
    receipt_id: 'art_v12_xx_TESTMINT_0',
    receipt_hash: 'a'.repeat(64),
    candidate_hash: 'c'.repeat(64),
    metadata_template_path: 'data/debug/metadata-packages-v12/art_v12_xx_TESTMINT_0.metadata.template.json',
    metadata_template_hash: 'sha256:' + 'd'.repeat(64),
    image_artifact_path: 'data/debug/receipt-images-v12/art_v12_xx_TESTMINT_0.svg',
    image_artifact_hash: 'sha256:' + 'b'.repeat(64),
    image_content_type: 'image/svg+xml',
  };
}

function mockUploader(imageId, metaId) {
  let callCount = 0;
  return {
    calls: [],
    uploadFile(path, opts) {
      callCount++;
      this.calls.push({ path, opts });
      if (callCount === 1) return Promise.resolve({ id: imageId || 'img_irys_001' });
      return Promise.resolve({ id: metaId || 'meta_irys_002' });
    },
  };
}

function failingUploader(failOn) {
  let callCount = 0;
  return {
    uploadFile(path, opts) {
      callCount++;
      if (callCount === failOn) return Promise.reject(new Error('upload_failed'));
      return Promise.resolve({ id: `ok_${callCount}` });
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// GATE CHECKS (6 tests)
// ═══════════════════════════════════════════════════════════════

t('gates: all gates pass', () => {
  const { allowed, blockers } = checkUploadGates(allGatesOpts());
  assert(allowed === true, `should be allowed, blockers: [${blockers.join(', ')}]`);
  assert(blockers.length === 0);
});

t('gates: missing --upload-live blocks', () => {
  const opts = { ...allGatesOpts(), uploadLive: false };
  const { allowed, blockers } = checkUploadGates(opts);
  assert(allowed === false);
  assert(blockers.includes('missing_upload_live_flag'));
});

t('gates: missing --upload-confirm blocks even with --upload-live', () => {
  const opts = { ...allGatesOpts(), uploadConfirm: false };
  const { allowed, blockers } = checkUploadGates(opts);
  assert(allowed === false);
  assert(blockers.includes('missing_upload_confirm_flag'));
});

t('gates: missing UPLOAD_ENABLED blocks', () => {
  const opts = { ...allGatesOpts(), uploadEnabled: undefined };
  const { allowed, blockers } = checkUploadGates(opts);
  assert(allowed === false);
  assert(blockers.includes('upload_enabled_not_true'));
});

t('gates: missing keypair path blocks', () => {
  const opts = { ...allGatesOpts(), keypairPath: undefined };
  const { allowed, blockers } = checkUploadGates(opts);
  assert(allowed === false);
  assert(blockers.includes('irys_keypair_path_not_defined'));
});

t('gates: no receipt limit blocks', () => {
  const opts = { ...allGatesOpts(), uploadMax: null, uploadReceiptId: null };
  const { allowed, blockers } = checkUploadGates(opts);
  assert(allowed === false);
  assert(blockers.includes('no_receipt_limit_set'));
});

// ═══════════════════════════════════════════════════════════════
// FINAL METADATA (3 tests)
// ═══════════════════════════════════════════════════════════════

t('final metadata: placeholders replaced with real URIs', () => {
  const tmpl = makeTemplate();
  const { metadata } = buildFinalMetadata(tmpl, 'https://gateway.irys.xyz/img001', null);
  assert(metadata.image === 'https://gateway.irys.xyz/img001', `got ${metadata.image}`);
  assert(metadata.properties.files[0].uri === 'https://gateway.irys.xyz/img001');
  assert(metadata.external_url === null);
});

t('final metadata: strips all scaffold/template/dry-run blocks', () => {
  const tmpl = makeTemplate();
  tmpl._scaffold = { test: true };
  tmpl._dry_run = { test: true };
  const { metadata } = buildFinalMetadata(tmpl, 'https://gateway.irys.xyz/img001', null);
  assert(!metadata._template, 'no _template');
  assert(!metadata._scaffold, 'no _scaffold');
  assert(!metadata._dry_run, 'no _dry_run');
  assert(!metadata._upload_scaffold, 'no _upload_scaffold');
  assert(!metadata._mint_scaffold, 'no _mint_scaffold');
});

t('final metadata: files[0].uri is real URI', () => {
  const tmpl = makeTemplate();
  const { metadata } = buildFinalMetadata(tmpl, 'https://gateway.irys.xyz/abc', null);
  assert(typeof metadata.properties.files[0].uri === 'string');
  assert(metadata.properties.files[0].uri.startsWith('https://'));
});

// ═══════════════════════════════════════════════════════════════
// IDEMPOTENCY (3 tests)
// ═══════════════════════════════════════════════════════════════

t('idempotency: no existing result → do not skip', () => {
  const { skip } = shouldSkipUpload(null, 'sha256:aaa', 'sha256:bbb');
  assert(skip === false);
});

t('idempotency: matching source hashes → skip', () => {
  const existing = {
    upload_status: 'complete',
    final_image_uri: 'https://gateway.irys.xyz/img',
    final_metadata_uri: 'https://gateway.irys.xyz/meta',
    source_image_artifact_hash: 'sha256:aaa',
    source_metadata_template_hash: 'sha256:bbb',
  };
  const { skip, reason } = shouldSkipUpload(existing, 'sha256:aaa', 'sha256:bbb');
  assert(skip === true, `should skip, reason: ${reason}`);
});

t('idempotency: changed image hash → do not skip', () => {
  const existing = {
    upload_status: 'complete',
    final_image_uri: 'https://gateway.irys.xyz/img',
    final_metadata_uri: 'https://gateway.irys.xyz/meta',
    source_image_artifact_hash: 'sha256:old',
    source_metadata_template_hash: 'sha256:bbb',
  };
  const { skip, reason } = shouldSkipUpload(existing, 'sha256:new', 'sha256:bbb');
  assert(skip === false);
  assert(reason === 'image_artifact_changed');
});

// ═══════════════════════════════════════════════════════════════
// RESULT ENTRY (2 tests)
// ═══════════════════════════════════════════════════════════════

t('result entry: has all required fields', () => {
  const entry = buildUploadResultEntry({
    receiptId: 'test_001',
    receiptHash: 'a'.repeat(64),
    candidateHash: 'c'.repeat(64),
    imageArtifactPath: 'path/to/img.svg',
    imageArtifactHash: 'sha256:img',
    metadataTemplatePath: 'path/to/tmpl.json',
    metadataTemplateHash: 'sha256:tmpl',
    finalMetadataPath: 'path/to/final.json',
    finalMetadataHash: 'sha256:final',
    finalImageUri: 'https://gateway.irys.xyz/img',
    finalMetadataUri: 'https://gateway.irys.xyz/meta',
    network: 'devnet',
    uploadedAt: '2026-06-16T08:00:00Z',
    uploaderPubkey: 'PUBKEY123',
  });
  assert(entry.receipt_id === 'test_001');
  assert(entry.upload_mode === 'live');
  assert(entry.upload_status === 'complete');
  assert(entry.uploader_pubkey === 'PUBKEY123');
  assert(entry.source_image_artifact_hash === 'sha256:img');
  assert(entry.source_metadata_template_hash === 'sha256:tmpl');
  assert(entry.final_metadata_hash === 'sha256:final');
});

t('result entry: no secrets, no env values, no keypair bytes', () => {
  const entry = buildUploadResultEntry({
    receiptId: 'test', receiptHash: 'h', candidateHash: 'c',
    imageArtifactPath: 'p', imageArtifactHash: 'h', metadataTemplatePath: 'p',
    metadataTemplateHash: 'h', finalMetadataPath: 'p', finalMetadataHash: 'h',
    finalImageUri: 'u', finalMetadataUri: 'u',
    network: 'devnet', uploaderPubkey: 'PUB',
  });
  const str = JSON.stringify(entry);
  assert(!str.includes('PRIVATE'), 'no PRIVATE');
  assert(!str.includes('SECRET'), 'no SECRET');
  assert(!str.includes('keypair'), 'no keypair reference');
  assert(!str.includes('.env'), 'no .env reference');
});

// ═══════════════════════════════════════════════════════════════
// MOCK UPLOAD SUCCESS (2 tests)
// ═══════════════════════════════════════════════════════════════

t('mock upload: success creates expected result', async () => {
  const pkg = makePackageEntry();
  const tmpl = makeTemplate();
  const uploader = mockUploader('img_001', 'meta_002');

  const output = await uploadSingleReceipt(pkg, tmpl, uploader, {
    network: 'devnet',
    uploaderPubkey: 'TEST_PUBKEY',
  });

  assert(output.result, 'should have result');
  assert(output.result.upload_status === 'complete', `got ${output.result.upload_status}`);
  assert(output.result.final_image_uri === 'https://gateway.irys.xyz/img_001');
  assert(output.result.final_metadata_uri === 'https://gateway.irys.xyz/meta_002');
  assert(output.result.uploader_pubkey === 'TEST_PUBKEY');
  assert(output.finalMetadata, 'should have finalMetadata');
  assert(typeof output.finalMetadata.image === 'string', 'image should be string');
  assert(!output.finalMetadata._template, 'no _template in final');
});

t('mock upload: uploader called twice (image + metadata)', async () => {
  const uploader = mockUploader();
  await uploadSingleReceipt(makePackageEntry(), makeTemplate(), uploader);
  assert(uploader.calls.length === 2, `expected 2 calls, got ${uploader.calls.length}`);
});

// ═══════════════════════════════════════════════════════════════
// PARTIAL FAILURE (2 tests)
// ═══════════════════════════════════════════════════════════════

t('partial failure: image upload fails → failed status', async () => {
  const uploader = failingUploader(1); // fail on first call
  const result = await uploadSingleReceipt(makePackageEntry(), makeTemplate(), uploader);
  assert(result.upload_status === 'failed', `got ${result.upload_status}`);
  assert(result.final_image_uri === null);
  assert(result.error_message === 'upload_failed');
});

t('partial failure: metadata upload fails → partial_image_only', async () => {
  const uploader = failingUploader(2); // fail on second call
  const result = await uploadSingleReceipt(makePackageEntry(), makeTemplate(), uploader);
  assert(result.upload_status === 'partial_image_only', `got ${result.upload_status}`);
  assert(result.final_image_uri !== null, 'image should be uploaded');
  assert(result.final_metadata_uri === null);
});

// ═══════════════════════════════════════════════════════════════
// RECEIPT LIMIT GATE (1 test)
// ═══════════════════════════════════════════════════════════════

t('gates: --upload-receipt-id satisfies receipt limit', () => {
  const opts = { ...allGatesOpts(), uploadMax: null, uploadReceiptId: 'art_v12_xx_TESTMINT_0' };
  const { allowed } = checkUploadGates(opts);
  assert(allowed === true, 'receipt-id should satisfy limit');
});

// ═══════════════════════════════════════════════════════════════
// Run all tests
// ═══════════════════════════════════════════════════════════════

console.log('\n── Gate checks ──');
console.log('── Final metadata ──');
console.log('── Idempotency ──');
console.log('── Result entry ──');
console.log('── Mock upload ──');
console.log('── Partial failure ──');
console.log('── Receipt limit ──');

async function run() {
  for (const { name, fn } of _tests) {
    _total++;
    try {
      await fn();
      _passed++;
    } catch (e) {
      _failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`        ${e.message}`);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Live Upload: ${_passed}/${_total} passed, ${_failed} failed`);
  console.log(`${'='.repeat(50)}`);

  process.exit(_failed > 0 ? 1 : 0);
}

run();
