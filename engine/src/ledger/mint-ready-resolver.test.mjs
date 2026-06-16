/**
 * Mint-Ready Resolver Tests — E8
 *
 * Tests for upload freshness, blocker resolution, summary counts,
 * and batch processing. No upload, no mint, no network calls.
 */

import {
  checkUploadFreshness,
  resolveMintPlan,
  resolveMintPlanBatch,
} from './mint-ready-resolver.mjs';
import { buildMintPlan } from './mint-plan.mjs';
import { buildReceiptMetadata } from './receipt-metadata.mjs';
import { buildReceiptPreview } from './receipt-preview.mjs';
import { SOL_MINT } from '../pipeline/constants.mjs';

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

const IMG_HASH = 'sha256:' + 'b'.repeat(64);
const TMPL_HASH = 'sha256:' + 'd'.repeat(64);

function makeReceipt(id) {
  return {
    receipt_id: id || 'art_v12_cp_TESTMINT_0',
    receipt_version: '1.2.0', receipt_type: 'closed_position',
    token_mint: 'TESTMINT1234567890123456789012345678901234abcd',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana', segment_index: 0,
    receipt_hash: 'a'.repeat(64), verification_status: 'verified',
    display_status: 'Verified Closed Position',
    accounting_method: 'weighted_average_position_accounting_v1',
    quote_mint: SOL_MINT, quote_symbol: 'SOL', valuation_status: 'raw_quote',
    total_bought_qty: 1000, total_bought_quote: 10, avg_buy_quote_price: 0.01,
    total_sold_qty: 1000, total_sold_quote: 15, avg_sell_quote_price: 0.015,
    allocated_cost_basis_quote: 10, remaining_qty: 0, remaining_cost_basis_quote: 0,
    realized_pnl_quote: 5, realized_pnl_pct: 50,
    first_event_at: 1700000000, last_event_at: 1700100000,
    snapshot_at: null, hold_time_seconds: 100000,
    entry_tx_hashes: ['aaaa1111'], exit_tx_hashes: ['bbbb2222'],
    num_buys: 1, num_sells: 1, candidate_hash: 'c'.repeat(64),
    limitations: {
      receipt_scope: 'closed_position', pnl_type: 'realized_closed',
      price_source: 'on_chain_swaps', valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    },
    flags: [],
  };
}

function makeMetadata(receipt) {
  const r = receipt || makeReceipt();
  return buildReceiptMetadata(r, buildReceiptPreview(r));
}

function makeCompleteUploadResult(receiptId) {
  return {
    receipt_id: receiptId || 'art_v12_cp_TESTMINT_0',
    upload_status: 'complete',
    source_image_artifact_hash: IMG_HASH,
    source_metadata_template_hash: TMPL_HASH,
    final_image_uri: 'https://gateway.irys.xyz/img_001',
    final_metadata_uri: 'https://gateway.irys.xyz/meta_002',
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. Complete + fresh upload resolves upload blockers
// ═══════════════════════════════════════════════════════════════

t('complete + fresh: resolves upload blockers', () => {
  const receipt = makeReceipt();
  const metadata = makeMetadata(receipt);
  const upload = makeCompleteUploadResult();
  const plan = resolveMintPlan(receipt, metadata, upload, IMG_HASH, TMPL_HASH);

  assert(!plan.mint_blockers.includes('image_not_rendered'), 'image blocker resolved');
  assert(!plan.mint_blockers.includes('metadata_not_uploaded'), 'upload blocker resolved');
  assert(!plan.mint_blockers.includes('metadata_uri_missing'), 'uri blocker resolved');
  assert(plan.resolved_blockers.includes('image_not_rendered'), 'should list as resolved');
  assert(plan.resolved_blockers.includes('metadata_not_uploaded'));
  assert(plan.resolved_blockers.includes('metadata_uri_missing'));
  assert(plan.upload_fresh === true);
  assert(plan.upload_result_used === true);
  assert(plan.final_image_uri === 'https://gateway.irys.xyz/img_001');
  assert(plan.final_metadata_uri === 'https://gateway.irys.xyz/meta_002');

  // Remaining blockers
  assert(plan.mint_blockers.includes('proof_wallet_missing'));
  assert(plan.mint_blockers.includes('mint_authority_missing'));
  assert(plan.mint_blockers.includes('explicit_mint_approval_required'));
  assert(plan.mint_ready === false);
});

// ═══════════════════════════════════════════════════════════════
// 2. No upload result keeps all upload blockers
// ═══════════════════════════════════════════════════════════════

t('no upload result: all 6 blockers remain', () => {
  const receipt = makeReceipt();
  const plan = resolveMintPlan(receipt, makeMetadata(receipt), null, IMG_HASH, TMPL_HASH);
  assert(plan.mint_blockers.length === 6, `expected 6, got ${plan.mint_blockers.length}`);
  assert(plan.upload_status === 'not_uploaded');
  assert(plan.upload_result_used === false);
  assert(plan.final_image_uri === null);
});

// ═══════════════════════════════════════════════════════════════
// 3. Stale image hash keeps upload blockers
// ═══════════════════════════════════════════════════════════════

t('stale image hash: upload blockers remain', () => {
  const upload = makeCompleteUploadResult();
  const plan = resolveMintPlan(makeReceipt(), makeMetadata(), upload, 'sha256:different', TMPL_HASH);
  assert(plan.mint_blockers.includes('image_not_rendered'));
  assert(plan.mint_blockers.includes('metadata_uri_missing'));
  assert(plan.upload_result_used === false);
  assert(plan.upload_fresh === false);
});

// ═══════════════════════════════════════════════════════════════
// 4. Stale template hash keeps upload blockers
// ═══════════════════════════════════════════════════════════════

t('stale template hash: upload blockers remain', () => {
  const upload = makeCompleteUploadResult();
  const plan = resolveMintPlan(makeReceipt(), makeMetadata(), upload, IMG_HASH, 'sha256:different');
  assert(plan.mint_blockers.includes('metadata_not_uploaded'));
  assert(plan.upload_result_used === false);
  assert(plan.upload_fresh === false);
});

// ═══════════════════════════════════════════════════════════════
// 5. Partial image-only keeps upload blockers
// ═══════════════════════════════════════════════════════════════

t('partial_image_only: upload blockers remain', () => {
  const upload = {
    ...makeCompleteUploadResult(),
    upload_status: 'partial_image_only',
    final_metadata_uri: null,
  };
  const plan = resolveMintPlan(makeReceipt(), makeMetadata(), upload, IMG_HASH, TMPL_HASH);
  assert(plan.mint_blockers.includes('image_not_rendered'));
  assert(plan.upload_result_used === false);
  assert(plan.upload_status === 'partial_image_only');
});

// ═══════════════════════════════════════════════════════════════
// 6. Failed upload keeps upload blockers
// ═══════════════════════════════════════════════════════════════

t('failed upload: upload blockers remain', () => {
  const upload = { ...makeCompleteUploadResult(), upload_status: 'failed', final_image_uri: null, final_metadata_uri: null };
  const plan = resolveMintPlan(makeReceipt(), makeMetadata(), upload, IMG_HASH, TMPL_HASH);
  assert(plan.mint_blockers.length === 6);
  assert(plan.upload_result_used === false);
});

// ═══════════════════════════════════════════════════════════════
// 7. uploaded_but_local_write_failed is URI-usable but not complete
// ═══════════════════════════════════════════════════════════════

t('uploaded_but_local_write_failed: URI-usable, not complete', () => {
  const upload = { ...makeCompleteUploadResult(), upload_status: 'uploaded_but_local_write_failed' };
  const plan = resolveMintPlan(makeReceipt(), makeMetadata(), upload, IMG_HASH, TMPL_HASH);

  // URI-usable: upload blockers resolved
  assert(!plan.mint_blockers.includes('image_not_rendered'));
  assert(!plan.mint_blockers.includes('metadata_uri_missing'));
  assert(plan.upload_result_used === true);
  assert(plan.final_image_uri !== null);

  // But not counted as fresh/complete
  assert(plan.upload_fresh === false, 'should not be fresh');
  assert(plan.upload_status === 'uploaded_but_local_write_failed');
});

// ═══════════════════════════════════════════════════════════════
// 8. Full theoretical opts → mint_ready true (pure function only)
// ═══════════════════════════════════════════════════════════════

t('full opts: mint_ready true in pure function', () => {
  const upload = makeCompleteUploadResult();
  const plan = resolveMintPlan(makeReceipt(), makeMetadata(), upload, IMG_HASH, TMPL_HASH, {
    proofWalletPubkey: 'PROOF_WALLET',
    mintAuthorityPubkey: 'MINT_AUTH',
    approved: true,
  });
  assert(plan.mint_ready === true, `expected true, blockers: [${plan.mint_blockers.join(', ')}]`);
  assert(plan.mint_blockers.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// 9. blockers_summary aggregates correctly
// ═══════════════════════════════════════════════════════════════

t('blockers_summary: correct aggregation', () => {
  const r1 = makeReceipt('r1');
  const r2 = makeReceipt('r2');
  const m1 = makeMetadata(r1);
  const m2 = makeMetadata(r2);
  const uploadMap = new Map();
  uploadMap.set('r1', makeCompleteUploadResult('r1'));
  // r2 has no upload
  const pkgMap = new Map();
  pkgMap.set('r1', { image_artifact_hash: IMG_HASH, metadata_template_hash: TMPL_HASH });
  pkgMap.set('r2', { image_artifact_hash: IMG_HASH, metadata_template_hash: TMPL_HASH });

  const { summary } = resolveMintPlanBatch([r1, r2], [m1, m2], uploadMap, pkgMap);
  assert(summary.receipt_count === 2);
  assert(summary.upload_complete_count === 1, `expected 1, got ${summary.upload_complete_count}`);
  assert(summary.mint_blocked_count === 2, 'both should be blocked (no wallet/auth/approval)');
  assert(summary.mint_ready_count === 0);
  // r1 has 3 blockers (wallet/auth/approval), r2 has 6 blockers
  assert(summary.blockers_summary.proof_wallet_missing === 2, 'both missing wallet');
  assert(summary.blockers_summary.image_not_rendered === 1, 'only r2 missing image');
});

// ═══════════════════════════════════════════════════════════════
// 10. Source hash verification true/false
// ═══════════════════════════════════════════════════════════════

t('checkUploadFreshness: complete + matching hashes → fresh', () => {
  const upload = makeCompleteUploadResult();
  const { fresh, uriUsable } = checkUploadFreshness(upload, IMG_HASH, TMPL_HASH);
  assert(fresh === true);
  assert(uriUsable === true);
});

t('checkUploadFreshness: mismatched image → not fresh', () => {
  const upload = makeCompleteUploadResult();
  const { fresh, uriUsable, reason } = checkUploadFreshness(upload, 'sha256:wrong', TMPL_HASH);
  assert(fresh === false);
  assert(uriUsable === false);
  assert(reason === 'image_hash_stale');
});

// ═══════════════════════════════════════════════════════════════
// 11. Batch multiple receipts
// ═══════════════════════════════════════════════════════════════

t('batch: multiple receipts processed', () => {
  const receipts = [makeReceipt('r1'), makeReceipt('r2'), makeReceipt('r3')];
  const metas = receipts.map(r => makeMetadata(r));
  const uploadMap = new Map();
  uploadMap.set('r1', makeCompleteUploadResult('r1'));
  const pkgMap = new Map();
  for (const r of receipts) pkgMap.set(r.receipt_id, { image_artifact_hash: IMG_HASH, metadata_template_hash: TMPL_HASH });

  const { plans, summary } = resolveMintPlanBatch(receipts, metas, uploadMap, pkgMap);
  assert(plans.length === 3);
  assert(summary.upload_complete_count === 1);
  assert(summary.upload_uri_usable_count === 1);
});

// ═══════════════════════════════════════════════════════════════
// 12. Empty batch
// ═══════════════════════════════════════════════════════════════

t('batch: empty arrays', () => {
  const { plans, summary } = resolveMintPlanBatch([], [], new Map(), new Map());
  assert(plans.length === 0);
  assert(summary.receipt_count === 0);
});

// ═══════════════════════════════════════════════════════════════
// 13. Original E2 mint plan output not mutated
// ═══════════════════════════════════════════════════════════════

t('E2 mint plan not mutated by resolver', () => {
  const receipt = makeReceipt();
  const metadata = makeMetadata(receipt);
  const originalPlan = buildMintPlan(receipt, metadata);
  const originalBlockers = [...originalPlan.mint_blockers];

  // Resolve with upload
  const upload = makeCompleteUploadResult();
  resolveMintPlan(receipt, metadata, upload, IMG_HASH, TMPL_HASH);

  // Check original plan wasn't mutated
  const freshPlan = buildMintPlan(receipt, metadata);
  assert(freshPlan.mint_blockers.length === originalBlockers.length, 'E2 blockers unchanged');
  assert(JSON.stringify(freshPlan.mint_blockers) === JSON.stringify(originalBlockers));
});

// ═══════════════════════════════════════════════════════════════
// 14. upload_uri_usable_count separates from upload_complete_count
// ═══════════════════════════════════════════════════════════════

t('uploaded_but_local_write_failed: uri_usable but not complete count', () => {
  const receipt = makeReceipt('r1');
  const meta = makeMetadata(receipt);
  const upload = { ...makeCompleteUploadResult('r1'), upload_status: 'uploaded_but_local_write_failed' };
  const uploadMap = new Map([['r1', upload]]);
  const pkgMap = new Map([['r1', { image_artifact_hash: IMG_HASH, metadata_template_hash: TMPL_HASH }]]);

  const { summary } = resolveMintPlanBatch([receipt], [meta], uploadMap, pkgMap);
  assert(summary.upload_complete_count === 0, 'should not count as complete');
  assert(summary.upload_uri_usable_count === 1, 'should count as uri_usable');
});

// ═══════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════

console.log('\n-- Mint-ready resolver tests --');

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
  console.log(`Mint-Ready Resolver: ${_passed}/${_total} passed, ${_failed} failed`);
  console.log(`${'='.repeat(50)}`);
  process.exit(_failed > 0 ? 1 : 0);
}

run();
