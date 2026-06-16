/**
 * Mint Plan Tests — E2
 *
 * Tests for mint-readiness plan generation from v1.2 receipts
 * + E1 metadata scaffolds.
 */

import { buildMintPlan, buildMintPlanBatch } from './mint-plan.mjs';
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
  try {
    fn();
    _passed++;
  } catch (e) {
    _failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

// ═══════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════

function makeReceipt(type, overrides = {}) {
  const base = {
    receipt_id: `art_v12_xx_TESTMINT_0`,
    receipt_version: '1.2.0',
    receipt_type: type,
    token_mint: 'TESTMINT1234567890123456789012345678901234abcd',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    segment_index: 0,
    receipt_hash: 'a'.repeat(64),
    verification_status: null,
    display_status: null,
    accounting_method: 'weighted_average_position_accounting_v1',
    quote_mint: SOL_MINT,
    quote_symbol: 'SOL',
    valuation_status: 'raw_quote',
    total_bought_qty: 1000,
    total_bought_quote: 10,
    avg_buy_quote_price: 0.01,
    total_sold_qty: null,
    total_sold_quote: null,
    avg_sell_quote_price: null,
    allocated_cost_basis_quote: null,
    remaining_qty: null,
    remaining_cost_basis_quote: 0,
    realized_pnl_quote: null,
    realized_pnl_pct: null,
    first_event_at: 1700000000,
    last_event_at: 1700100000,
    snapshot_at: null,
    hold_time_seconds: null,
    entry_tx_hashes: ['aaaa1111'],
    exit_tx_hashes: [],
    num_buys: 1,
    num_sells: 0,
    candidate_hash: 'c'.repeat(64),
    limitations: {
      receipt_scope: type,
      pnl_type: 'none',
      price_source: 'none',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    },
    flags: [],
  };

  if (type === 'closed_position') {
    base.total_sold_qty = 1000;
    base.total_sold_quote = 15;
    base.avg_sell_quote_price = 0.015;
    base.allocated_cost_basis_quote = 10;
    base.remaining_qty = 0;
    base.realized_pnl_quote = 5;
    base.realized_pnl_pct = 50;
    base.hold_time_seconds = 100000;
    base.exit_tx_hashes = ['bbbb2222'];
    base.num_sells = 1;
    base.verification_status = 'verified';
    base.display_status = 'Verified Closed Position';
    base.limitations.pnl_type = 'realized_closed';
    base.limitations.price_source = 'on_chain_swaps';
  } else if (type === 'realized_partial') {
    base.total_sold_qty = 500;
    base.total_sold_quote = 7.5;
    base.avg_sell_quote_price = 0.015;
    base.allocated_cost_basis_quote = 5;
    base.remaining_qty = 500;
    base.realized_pnl_quote = 2.5;
    base.realized_pnl_pct = 50;
    base.hold_time_seconds = 100000;
    base.exit_tx_hashes = ['bbbb2222'];
    base.num_sells = 1;
    base.verification_status = 'verified_partial';
    base.display_status = 'Verified Partial (Position Open)';
    base.limitations.pnl_type = 'realized_partial';
    base.limitations.price_source = 'on_chain_swaps';
    base.limitations.disclosures = ['no_usd_normalization', 'position_open'];
  } else if (type === 'open_snapshot') {
    base.remaining_qty = 1000;
    base.remaining_cost_basis_quote = 10;
    base.snapshot_at = 1700200000;
    base.verification_status = 'verified_snapshot';
    base.display_status = 'Verified Snapshot (No PnL Claim)';
    base.limitations.disclosures = ['no_usd_normalization', 'no_pnl_claim', 'no_live_price'];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'limitations' && value && typeof value === 'object') {
      base.limitations = { ...base.limitations, ...value };
    } else {
      base[key] = value;
    }
  }

  return base;
}

function makePlan(type, opts = {}, receiptOverrides = {}) {
  const receipt = makeReceipt(type, receiptOverrides);
  const preview = buildReceiptPreview(receipt);
  const metadata = buildReceiptMetadata(receipt, preview);
  return { plan: buildMintPlan(receipt, metadata, opts), receipt, metadata };
}

// ═══════════════════════════════════════════════════════════════
// DEFAULT BLOCKED STATE (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Default blocked state ──');

test('all 6 blockers present by default', () => {
  const { plan } = makePlan('closed_position');
  assert(plan.mint_blockers.length === 6, `expected 6 blockers, got ${plan.mint_blockers.length}: [${plan.mint_blockers.join(', ')}]`);
  assert(plan.mint_blockers.includes('image_not_rendered'));
  assert(plan.mint_blockers.includes('metadata_not_uploaded'));
  assert(plan.mint_blockers.includes('metadata_uri_missing'));
  assert(plan.mint_blockers.includes('proof_wallet_missing'));
  assert(plan.mint_blockers.includes('mint_authority_missing'));
  assert(plan.mint_blockers.includes('explicit_mint_approval_required'));
});

test('mint_ready=false by default', () => {
  const { plan } = makePlan('closed_position');
  assert(plan.mint_ready === false, 'should be false');
});

test('_mint_scaffold.status=blocked by default', () => {
  const { plan } = makePlan('closed_position');
  assert(plan._mint_scaffold.status === 'blocked', `got ${plan._mint_scaffold.status}`);
  assert(plan._mint_scaffold.version === '1.0.0');
  assert(typeof plan._mint_scaffold.notes === 'string' && plan._mint_scaffold.notes.length > 0);
});

// ═══════════════════════════════════════════════════════════════
// PER-TYPE PLANS (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Per-type plans ──');

test('closed_position produces valid plan', () => {
  const { plan } = makePlan('closed_position');
  assert(plan.receipt_type === 'closed_position');
  assert(plan.verification_status === 'verified');
});

test('realized_partial produces valid plan', () => {
  const { plan } = makePlan('realized_partial');
  assert(plan.receipt_type === 'realized_partial');
  assert(plan.verification_status === 'verified_partial');
});

test('open_snapshot produces valid plan', () => {
  const { plan } = makePlan('open_snapshot');
  assert(plan.receipt_type === 'open_snapshot');
  assert(plan.verification_status === 'verified_snapshot');
});

// ═══════════════════════════════════════════════════════════════
// PROOF REFERENCES (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Proof references ──');

test('receipt_hash and candidate_hash correct', () => {
  const { plan } = makePlan('closed_position');
  assert(plan.receipt_hash === 'a'.repeat(64), 'receipt_hash');
  assert(plan.candidate_hash === 'c'.repeat(64), 'candidate_hash');
  assert(plan.receipt_version === '1.2.0');
});

test('metadata_scaffold_ref matches metadata name', () => {
  const { plan, metadata } = makePlan('closed_position');
  assert(plan.metadata_scaffold_ref === metadata.name, `got ${plan.metadata_scaffold_ref}`);
});

// ═══════════════════════════════════════════════════════════════
// NETWORK / STANDARD (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Network / standard ──');

test('default network is devnet', () => {
  const { plan } = makePlan('closed_position');
  assert(plan.network === 'devnet', `got ${plan.network}`);
  assert(plan.token_standard === 'metaplex_token_metadata_v3');
  assert(plan.proof_nft_type === 'non_transferable');
});

test('opts.network override works', () => {
  const { plan } = makePlan('closed_position', { network: 'mainnet-beta' });
  assert(plan.network === 'mainnet-beta', `got ${plan.network}`);
});

// ═══════════════════════════════════════════════════════════════
// BLOCKER RESOLUTION (4 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Blocker resolution ──');

test('imageUri resolves image_not_rendered', () => {
  const { plan } = makePlan('closed_position', { imageUri: 'https://arweave.net/abc123' });
  assert(!plan.mint_blockers.includes('image_not_rendered'), 'should not have image blocker');
  assert(plan.image_uri === 'https://arweave.net/abc123');
});

test('metadataUri resolves metadata_not_uploaded + metadata_uri_missing', () => {
  const { plan } = makePlan('closed_position', { metadataUri: 'https://arweave.net/meta456' });
  assert(!plan.mint_blockers.includes('metadata_not_uploaded'), 'should not have upload blocker');
  assert(!plan.mint_blockers.includes('metadata_uri_missing'), 'should not have uri blocker');
  assert(plan.metadata_uri === 'https://arweave.net/meta456');
});

test('proofWalletPubkey + mintAuthorityPubkey resolve their blockers', () => {
  const { plan } = makePlan('closed_position', {
    proofWalletPubkey: 'PROOF_WALLET_PUBKEY_1234',
    mintAuthorityPubkey: 'MINT_AUTH_PUBKEY_5678',
  });
  assert(!plan.mint_blockers.includes('proof_wallet_missing'));
  assert(!plan.mint_blockers.includes('mint_authority_missing'));
  assert(plan.proof_wallet_pubkey === 'PROOF_WALLET_PUBKEY_1234');
  assert(plan.mint_authority_pubkey === 'MINT_AUTH_PUBKEY_5678');
});

test('all opts provided → mint_ready=true, 0 blockers, status=ready', () => {
  const { plan } = makePlan('closed_position', {
    imageUri: 'https://arweave.net/img',
    metadataUri: 'https://arweave.net/meta',
    proofWalletPubkey: 'PROOF',
    mintAuthorityPubkey: 'AUTH',
    approved: true,
    approvedBy: 'human',
  });
  assert(plan.mint_ready === true, 'should be ready');
  assert(plan.mint_blockers.length === 0, `expected 0 blockers, got ${plan.mint_blockers.length}`);
  assert(plan._mint_scaffold.status === 'ready', `got ${plan._mint_scaffold.status}`);
});

// ═══════════════════════════════════════════════════════════════
// REQUIRED STEPS (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Required steps ──');

test('6 steps present by default, all not_started', () => {
  const { plan } = makePlan('closed_position');
  assert(plan.required_before_mint.length === 6, `expected 6 steps, got ${plan.required_before_mint.length}`);
  assert(plan.required_before_mint.every(s => s.status === 'not_started'), 'all should be not_started');
});

test('resolved opts produce done steps', () => {
  const { plan } = makePlan('closed_position', {
    imageUri: 'https://arweave.net/img',
    metadataUri: 'https://arweave.net/meta',
    proofWalletPubkey: 'PROOF',
    mintAuthorityPubkey: 'AUTH',
    approved: true,
    approvedBy: 'tester',
  });
  assert(plan.required_before_mint.every(s => s.status === 'done'), 'all should be done');
  const approvalStep = plan.required_before_mint.find(s => s.step === 'explicit_approval');
  assert(approvalStep.approved_by === 'tester', `got ${approvalStep.approved_by}`);
});

// ═══════════════════════════════════════════════════════════════
// METADATA_URI vs EXTERNAL_URL separation (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── metadata_uri vs external_url ──');

test('externalUrl populates external_url but NOT metadata_uri', () => {
  const { plan } = makePlan('closed_position', {
    externalUrl: 'https://tradeartifact.xyz/receipt/123',
  });
  assert(plan.external_url === 'https://tradeartifact.xyz/receipt/123');
  assert(plan.metadata_uri === null, 'metadata_uri should still be null');
  assert(plan.mint_blockers.includes('metadata_uri_missing'), 'metadata_uri_missing should still be a blocker');
});

test('metadata.external_url is separate from metadata_uri', () => {
  // Default metadata has external_url: null, but even if it had one,
  // metadata_uri should remain null without opts.metadataUri
  const { plan } = makePlan('closed_position');
  assert(plan.metadata_uri === null);
  assert(plan.mint_blockers.includes('metadata_uri_missing'));
});

// ═══════════════════════════════════════════════════════════════
// DETERMINISM (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Determinism ──');

test('same inputs → identical plan', () => {
  const receipt = makeReceipt('closed_position');
  const preview = buildReceiptPreview(receipt);
  const metadata = buildReceiptMetadata(receipt, preview);
  const p1 = buildMintPlan(receipt, metadata);
  const p2 = buildMintPlan(receipt, metadata);
  assert(JSON.stringify(p1) === JSON.stringify(p2), 'should be identical');
});

// ═══════════════════════════════════════════════════════════════
// BATCH (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Batch ──');

test('batch: multiple receipts', () => {
  const types = ['closed_position', 'realized_partial', 'open_snapshot'];
  const receipts = types.map(t => makeReceipt(t));
  const previews = receipts.map(r => buildReceiptPreview(r));
  const metadataList = receipts.map((r, i) => buildReceiptMetadata(r, previews[i]));
  const plans = buildMintPlanBatch(receipts, metadataList);
  assert(plans.length === 3, `expected 3, got ${plans.length}`);
  assert(plans.every(p => p.mint_ready === false), 'all should be blocked');
  assert(plans.every(p => p.mint_blockers.length === 6), 'all should have 6 blockers');
});

test('batch: empty arrays', () => {
  const plans = buildMintPlanBatch([], []);
  assert(plans.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Mint Plan: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
