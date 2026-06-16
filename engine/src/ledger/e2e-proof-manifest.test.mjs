/**
 * End-to-End Proof Manifest Tests — F
 *
 * Tests for proof status derivation, manifest entry building,
 * summary status, and batch processing. No upload, no mint, no network.
 */

import {
  deriveProofStatus,
  deriveSummaryStatus,
  buildManifestEntry,
  buildE2EProofManifest,
} from './e2e-proof-manifest.mjs';

// ═══════════════════════════════════════════════════════════════
// Test harness
// ═══════════════════════════════════════════════════════════════

const _tests = [];
let _passed = 0;
let _failed = 0;
let _total = 0;

function t(name, fn) { _tests.push({ name, fn }); }
function assert(condition, msg) { if (!condition) throw new Error(msg || 'assertion failed'); }

// ═══════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════

function makeReceipt(id, type) {
  return {
    receipt_id: id || 'art_v12_cp_TEST_0',
    receipt_type: type || 'closed_position',
    receipt_hash: 'a'.repeat(64),
    candidate_hash: 'c'.repeat(64),
    verification_status: 'verified',
    valuation_status: 'raw_quote',
    quote_symbol: 'SOL',
  };
}

function makeVerifyResult(receiptId, pass) {
  return {
    receipt_id: receiptId,
    pass,
    rule_violations: pass ? [] : [{ rule: 'S-1', message: 'test', severity: 'error' }],
  };
}

function makeUploadResult(receiptId, complete) {
  if (!complete) return null;
  return {
    receipt_id: receiptId,
    upload_status: 'complete',
    final_image_uri: 'https://gateway.irys.xyz/img_001',
    final_metadata_uri: 'https://gateway.irys.xyz/meta_002',
  };
}

function makeMintResult(receiptId, minted) {
  if (!minted) return null;
  return {
    receipt_id: receiptId,
    mint_status: 'minted',
    mint_address: 'MINT_ADDR_123',
    token_account: 'TOKEN_ACCT_456',
    transaction_signature: 'TX_SIG_789',
    network: 'devnet',
    token_standard: 'token_2022',
    transferability: 'non_transferable_extension',
    metadata_linkage: 'manifest_only',
    proof_wallet_pubkey: 'PROOF_WALLET',
    mint_authority_pubkey: 'MINT_AUTH',
  };
}

function makeImageArtifact(receiptId) {
  return {
    receipt_id: receiptId,
    artifact_type: 'svg',
    local_path: `data/debug/receipt-images-v12/${receiptId}.svg`,
    artifact_hash: 'sha256:' + 'b'.repeat(64),
  };
}

function makeValuationCtx() {
  return {
    valuation_status: 'raw_quote',
    has_no_usd_normalization_disclosure: true,
    quote_is_usd_stable: false,
  };
}

function makeMintReadyPlan(receiptId, uploadUsed, blockers) {
  return {
    receipt_id: receiptId,
    upload_result_used: uploadUsed,
    mint_blockers: blockers || [],
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. Verified + uploaded + minted → PROVEN
// ═══════════════════════════════════════════════════════════════

t('PROVEN: verified + uploaded + minted', () => {
  const status = deriveProofStatus({ verified: true, uploaded: true, minted: true });
  assert(status === 'PROVEN', `got ${status}`);
});

t('PROVEN entry: has mint details', () => {
  const entry = buildManifestEntry({
    receipt: makeReceipt('r1'),
    verifyResult: makeVerifyResult('r1', true),
    valuationCtx: makeValuationCtx(),
    previewGenerated: true,
    htmlPreviewGenerated: true,
    imageArtifact: makeImageArtifact('r1'),
    metadataScaffoldExists: true,
    metadataTemplateExists: true,
    uploadResult: makeUploadResult('r1', true),
    mintReadyPlan: makeMintReadyPlan('r1', true, []),
    mintResult: makeMintResult('r1', true),
  });
  assert(entry.proof_status === 'PROVEN');
  assert(entry.mint.mint_address === 'MINT_ADDR_123');
  assert(entry.mint.token_account === 'TOKEN_ACCT_456');
  assert(entry.mint.transaction_signature === 'TX_SIG_789');
  assert(entry.mint.token_standard === 'token_2022');
  assert(entry.mint.transferability === 'non_transferable_extension');
  assert(entry.mint.metadata_linkage === 'manifest_only');
  assert(entry.verification.pass === true);
  assert(entry.upload.image_uri !== null);
  assert(entry.upload.metadata_uri !== null);
});

// ═══════════════════════════════════════════════════════════════
// 2. Verified + uploaded + no mint → UPLOADED_NOT_MINTED
// ═══════════════════════════════════════════════════════════════

t('UPLOADED_NOT_MINTED: verified + uploaded + no mint', () => {
  const status = deriveProofStatus({ verified: true, uploaded: true, minted: false });
  assert(status === 'UPLOADED_NOT_MINTED', `got ${status}`);
});

// ═══════════════════════════════════════════════════════════════
// 3. Verified + no upload → VERIFIED_NOT_UPLOADED
// ═══════════════════════════════════════════════════════════════

t('VERIFIED_NOT_UPLOADED: verified + no upload + no mint', () => {
  const status = deriveProofStatus({ verified: true, uploaded: false, minted: false });
  assert(status === 'VERIFIED_NOT_UPLOADED', `got ${status}`);
});

// ═══════════════════════════════════════════════════════════════
// 4. Failed verification → UNVERIFIED
// ═══════════════════════════════════════════════════════════════

t('UNVERIFIED: failed verification', () => {
  const status = deriveProofStatus({ verified: false, uploaded: false, minted: false });
  assert(status === 'UNVERIFIED', `got ${status}`);
});

t('UNVERIFIED entry: verification.pass=false', () => {
  const entry = buildManifestEntry({
    receipt: makeReceipt('r1'),
    verifyResult: makeVerifyResult('r1', false),
    valuationCtx: null,
    previewGenerated: true,
    htmlPreviewGenerated: true,
    imageArtifact: null,
    metadataScaffoldExists: false,
    metadataTemplateExists: false,
    uploadResult: null,
    mintReadyPlan: null,
    mintResult: null,
  });
  assert(entry.proof_status === 'UNVERIFIED');
  assert(entry.verification.pass === false);
  assert(entry.verification.violations === 1);
});

// ═══════════════════════════════════════════════════════════════
// 5. Mixed batch → PARTIAL
// ═══════════════════════════════════════════════════════════════

t('summary: mixed batch → PARTIAL', () => {
  const status = deriveSummaryStatus(['PROVEN', 'VERIFIED_NOT_UPLOADED', 'VERIFIED_NOT_UPLOADED']);
  assert(status === 'PARTIAL', `got ${status}`);
});

// ═══════════════════════════════════════════════════════════════
// 6. All proven → FULL
// ═══════════════════════════════════════════════════════════════

t('summary: all proven → FULL', () => {
  const status = deriveSummaryStatus(['PROVEN', 'PROVEN']);
  assert(status === 'FULL', `got ${status}`);
});

// ═══════════════════════════════════════════════════════════════
// 7. None proven → NONE
// ═══════════════════════════════════════════════════════════════

t('summary: none proven → NONE', () => {
  const status = deriveSummaryStatus(['VERIFIED_NOT_UPLOADED', 'UPLOADED_NOT_MINTED']);
  assert(status === 'NONE', `got ${status}`);
});

t('summary: has UNVERIFIED → FAIL', () => {
  const status = deriveSummaryStatus(['PROVEN', 'UNVERIFIED']);
  assert(status === 'FAIL', `got ${status}`);
});

// ═══════════════════════════════════════════════════════════════
// 8. Summary counts correct
// ═══════════════════════════════════════════════════════════════

t('summary counts: correct for mixed batch', () => {
  const receipts = [makeReceipt('r1'), makeReceipt('r2'), makeReceipt('r3')];
  const verifyReport = {
    results: [
      makeVerifyResult('r1', true),
      makeVerifyResult('r2', true),
      makeVerifyResult('r3', true),
    ],
  };
  const uploadMap = new Map([['r1', makeUploadResult('r1', true)]]);
  const mintMap = new Map([['r1', makeMintResult('r1', true)]]);
  const mintReadyMap = new Map([
    ['r1', makeMintReadyPlan('r1', true, [])],
    ['r2', makeMintReadyPlan('r2', false, ['image_not_rendered'])],
  ]);

  const manifest = buildE2EProofManifest({
    wallet: 'TEST_WALLET', chain: 'solana', network: 'devnet',
    receipts,
    verifyReport,
    valuationContexts: [makeValuationCtx(), makeValuationCtx(), makeValuationCtx()],
    previewsGenerated: true,
    htmlPreviewGenerated: true,
    imageArtifacts: [makeImageArtifact('r1'), makeImageArtifact('r2'), makeImageArtifact('r3')],
    metadataScaffoldsExist: true,
    metadataTemplatesExist: true,
    uploadResultsMap: uploadMap,
    mintReadyPlansMap: mintReadyMap,
    mintResultsMap: mintMap,
  });

  assert(manifest.summary.verified_count === 3, `verified: ${manifest.summary.verified_count}`);
  assert(manifest.summary.uploaded_count === 1, `uploaded: ${manifest.summary.uploaded_count}`);
  assert(manifest.summary.minted_count === 1, `minted: ${manifest.summary.minted_count}`);
  assert(manifest.summary.fully_proven_count === 1, `proven: ${manifest.summary.fully_proven_count}`);
  assert(manifest.summary.status === 'PARTIAL', `status: ${manifest.summary.status}`);
  assert(manifest.receipt_count === 3);
});

// ═══════════════════════════════════════════════════════════════
// 9. Minted receipt includes all mint fields
// ═══════════════════════════════════════════════════════════════

t('minted receipt: all mint fields present', () => {
  const entry = buildManifestEntry({
    receipt: makeReceipt('r1'),
    verifyResult: makeVerifyResult('r1', true),
    valuationCtx: makeValuationCtx(),
    previewGenerated: true, htmlPreviewGenerated: true,
    imageArtifact: makeImageArtifact('r1'),
    metadataScaffoldExists: true, metadataTemplateExists: true,
    uploadResult: makeUploadResult('r1', true),
    mintReadyPlan: makeMintReadyPlan('r1', true, []),
    mintResult: makeMintResult('r1', true),
  });
  assert(entry.mint.mint_address);
  assert(entry.mint.token_account);
  assert(entry.mint.transaction_signature);
  assert(entry.mint.token_standard === 'token_2022');
  assert(entry.mint.transferability === 'non_transferable_extension');
  assert(entry.mint.network === 'devnet');
});

// ═══════════════════════════════════════════════════════════════
// 10. Non-uploaded receipt: null URIs, no fake failure
// ═══════════════════════════════════════════════════════════════

t('non-uploaded receipt: null URIs, status not_uploaded', () => {
  const entry = buildManifestEntry({
    receipt: makeReceipt('r1'),
    verifyResult: makeVerifyResult('r1', true),
    valuationCtx: makeValuationCtx(),
    previewGenerated: true, htmlPreviewGenerated: true,
    imageArtifact: makeImageArtifact('r1'),
    metadataScaffoldExists: true, metadataTemplateExists: true,
    uploadResult: null,
    mintReadyPlan: null,
    mintResult: null,
  });
  assert(entry.upload.status === 'not_uploaded');
  assert(entry.upload.image_uri === null);
  assert(entry.upload.metadata_uri === null);
  assert(entry.mint.status === 'not_minted');
  assert(entry.proof_status === 'VERIFIED_NOT_UPLOADED');
});

// ═══════════════════════════════════════════════════════════════
// 11. No secrets in manifest
// ═══════════════════════════════════════════════════════════════

t('no secrets in manifest output', () => {
  const manifest = buildE2EProofManifest({
    wallet: 'TEST_WALLET', chain: 'solana', network: 'devnet',
    receipts: [makeReceipt('r1')],
    verifyReport: { results: [makeVerifyResult('r1', true)] },
    valuationContexts: [makeValuationCtx()],
    previewsGenerated: true, htmlPreviewGenerated: true,
    imageArtifacts: [makeImageArtifact('r1')],
    metadataScaffoldsExist: true, metadataTemplatesExist: true,
    uploadResultsMap: new Map([['r1', makeUploadResult('r1', true)]]),
    mintReadyPlansMap: new Map(),
    mintResultsMap: new Map([['r1', makeMintResult('r1', true)]]),
  });
  const str = JSON.stringify(manifest);
  assert(!str.includes('PRIVATE'), 'no PRIVATE');
  assert(!str.includes('SECRET'), 'no SECRET');
  assert(!str.includes('.env'), 'no .env');
  assert(!str.includes('keypair'), 'no keypair');
});

// ═══════════════════════════════════════════════════════════════
// 12. Empty batch → valid manifest
// ═══════════════════════════════════════════════════════════════

t('empty batch: valid manifest with NONE status', () => {
  const manifest = buildE2EProofManifest({
    wallet: 'W', chain: 'solana', network: 'devnet',
    receipts: [],
    verifyReport: { results: [] },
    valuationContexts: [],
    previewsGenerated: false, htmlPreviewGenerated: false,
    imageArtifacts: [],
    metadataScaffoldsExist: false, metadataTemplatesExist: false,
    uploadResultsMap: new Map(),
    mintReadyPlansMap: new Map(),
    mintResultsMap: new Map(),
  });
  assert(manifest.receipt_count === 0);
  assert(manifest.summary.status === 'NONE');
  assert(manifest.receipts.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════

console.log('\n-- E2E proof manifest tests --');

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
  console.log(`E2E Proof Manifest: ${_passed}/${_total} passed, ${_failed} failed`);
  console.log(`${'='.repeat(50)}`);
  process.exit(_failed > 0 ? 1 : 0);
}

run();
