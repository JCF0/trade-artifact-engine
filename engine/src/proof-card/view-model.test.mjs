import assert from 'assert';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofCardView } from './view-model.mjs';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

const fixture = createInventoryFixture();

try {
  const receipt = getInventoryReceipt(fixture.hashes.receiptAHash, {
    engineRoot: fixture.root,
    includeExcluded: false,
  });
  const proofDetail = buildProofDetailView(receipt);

  test('proof-card view-model returns compact card shape for known receipt', () => {
    const card = buildProofCardView(proofDetail);
    assert.deepEqual(Object.keys(card), [
      'card_type',
      'title',
      'subtitle',
      'receipt',
      'trust',
      'verification',
      'summary_fields',
      'pnl_summary',
      'coverage_summary',
      'disclosures',
      'links',
    ]);
    assert.equal(card.card_type, 'artifact_proof_card');
    assert.equal(card.title, 'Artifact Proof');
    assert.equal(card.subtitle, 'Selected receipt summary');
    assert.equal(card.receipt.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(card.receipt.receipt_hash_short, `aaaaaaaa...aaaaaaaa`);
  });

  test('trust and disclosures are included from Slice 1', () => {
    const card = buildProofCardView(proofDetail);
    assert.deepEqual(card.trust, {
      current_level: 4,
      current_code: 'source_anchored',
      current_label: 'Source Anchored',
    });
    assert.ok(card.disclosures.includes('Selected receipt only. Not a portfolio statement.'));
    assert.ok(card.disclosures.includes('Raw quote only. No USD normalization.'));
    assert.ok(card.disclosures.includes('Source anchors make this proof correlatable and should not be treated as private.'));
  });


  test('coverage_summary is derived from existing coverage_statement only', () => {
    const card = buildProofCardView(proofDetail);
    assert.deepEqual(card.coverage_summary, {
      heading: 'Coverage Statement',
      scope: 'Receipt-scoped coverage only.',
      event_bounds: 'Receipt event bounds: 2023-11-14T22:13:20.000Z to 2023-11-14T22:18:20.000Z.',
      valuation: 'Raw quote only. No USD normalization.',
      limitation: 'Not wallet, trader, portfolio, or track-record coverage.',
    });
  });

  test('coverage_summary renders incomplete bounds deterministically', () => {
    const clone = structuredClone(proofDetail);
    clone.coverage_statement.position_episode.opened_at = null;
    clone.coverage_statement.position_episode.closed_at = null;
    const card = buildProofCardView(clone);
    assert.equal(card.coverage_summary.event_bounds, 'Receipt event bounds incomplete.');
  });

  test('coverage_summary omits internal codes, verifier diagnostics, wallet, PnL, upload, mint, and signing fields', () => {
    const card = buildProofCardView(proofDetail);
    const serialized = JSON.stringify(card.coverage_summary).toLowerCase();
    assert.ok(!serialized.includes('coverage_codes'));
    assert.ok(!serialized.includes('verifier'));
    assert.ok(!serialized.includes('test_wallet'));
    assert.ok(!serialized.includes('wallet_address'));
    assert.ok(!serialized.includes('pnl'));
    assert.ok(!serialized.includes('usd_value'));
    assert.ok(!serialized.includes('usd_amount'));
    assert.ok(!serialized.includes('upload'));
    assert.ok(!serialized.includes('mint'));
    assert.ok(!serialized.includes('signing'));
  });

  test('verification_status, hash_valid, and verifier_passed remain distinct', () => {
    const card = buildProofCardView(proofDetail);
    assert.equal(card.receipt.verification_status, 'verified');
    assert.equal(card.verification.hash_valid, true);
    assert.equal(card.verification.verifier_passed, true);
    assert.equal(card.verification.verification_status, undefined);
  });

  test('token_display falls back to shortened token_mint when no symbol exists', () => {
    const card = buildProofCardView(proofDetail);
    assert.equal(card.receipt.token_display, 'TEST_TOK...');
    assert.equal(card.receipt.token_mint, 'TEST_TOKEN_A');
  });

  test('pnl_summary is null when proof-detail lacks canonical raw-quote pnl fields', () => {
    const card = buildProofCardView(proofDetail);
    assert.equal(card.pnl_summary, null);
  });

  test('wallet display mode works and does not mutate source proof detail', () => {
    const clone = structuredClone(proofDetail);
    clone.receipt.wallet = 'TESTWALLET12345678901234567890123456789012345';
    const originalWallet = clone.receipt.wallet;
    const truncated = buildProofCardView(clone, { walletDisplayMode: 'truncated' });
    const redacted = buildProofCardView(clone, { walletDisplayMode: 'redacted' });
    assert.equal(truncated.receipt.wallet_display_mode, 'truncated');
    assert.equal(redacted.receipt.wallet_display_mode, 'redacted');
    assert.equal(truncated.receipt.wallet, 'TESTWA...2345');
    assert.equal(redacted.receipt.wallet, '[redacted]');
    assert.equal(clone.receipt.wallet, originalWallet);
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);