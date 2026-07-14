import assert from 'assert';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofVerifierView } from '../proof-verifier/view-model.mjs';
import { buildProofDetailView, RAW_QUOTE_DISCLOSURE_TEXT } from './view-model.mjs';

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


function assertNoForbiddenCoverageFields(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  assert.ok(!serialized.includes('test_wallet'));
  assert.ok(!serialized.includes('wallet_address'));
  assert.ok(!serialized.includes('realized_pnl'));
  assert.ok(!serialized.includes('pnl_pct'));
  assert.ok(!serialized.includes('usd_amount'));
  assert.ok(!serialized.includes('usd_value'));
  assert.ok(!serialized.includes('normalized_valuation'));
  assert.ok(!serialized.includes('participant_total'));
  assert.ok(!serialized.includes('profile'));
  assert.ok(!serialized.includes('nansen'));
  assert.ok(!serialized.includes('upload'));
  assert.ok(!serialized.includes('mint_address'));
  assert.ok(!serialized.includes('transaction_signature'));
  assert.ok(!serialized.includes('signing'));
}
const fixture = createInventoryFixture();

try {
  const knownRecord = getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root });
  const snapshotRecord = getInventoryReceipt(fixture.hashes.receiptBHash, { engineRoot: fixture.root });

  test('view-model maps known inventory record into expected sections', () => {
    const detail = buildProofDetailView(knownRecord);
    assert.deepEqual(Object.keys(detail), [
      'receipt',
      'verification',
      'coverage_statement',
      'valuation',
      'proof_lifecycle',
      'artifacts',
      'legacy',
      'links',
      'trust',
      'flags_and_limitations',
    ]);
    assert.equal(detail.receipt.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(detail.links.proof_api_path, `/api/proof/${fixture.hashes.receiptAHash}`);
  });

  test('view-model preserves raw_quote and explicit disclosure text', () => {
    const detail = buildProofDetailView(knownRecord);
    assert.equal(detail.receipt.valuation_status, 'raw_quote');
    assert.equal(detail.valuation.valuation_status, 'raw_quote');
    assert.equal(detail.valuation.disclosure_text, RAW_QUOTE_DISCLOSURE_TEXT);
    assert.equal(detail.flags_and_limitations.raw_quote_only_disclosure, RAW_QUOTE_DISCLOSURE_TEXT);
    assert.ok(detail.flags_and_limitations.shared_surface_disclosures.includes('Selected receipt only. Not a portfolio statement.'));
    assert.ok(detail.flags_and_limitations.shared_surface_disclosures.includes('Raw quote only. No USD normalization.'));
  });


  test('adds core receipt coverage statement without publication context', () => {
    const detail = buildProofDetailView(knownRecord);
    assert.equal(detail.coverage_statement.coverage_statement_version, 'receipt_coverage_v1');
    assert.equal(detail.coverage_statement.coverage_status, 'complete');
    assert.equal(detail.coverage_statement.scope.scope_type, 'receipt');
    assert.equal(detail.coverage_statement.publication_context, null);
    assert.equal(detail.coverage_statement.receipt.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(detail.coverage_statement.valuation_basis.valuation_status, 'raw_quote');
    assert.equal(detail.coverage_statement.valuation_basis.usd_normalized, false);
  });

  test('proof-detail and verifier core coverage statements deep-equal for same record', () => {
    const detail = buildProofDetailView(knownRecord);
    const verifier = buildProofVerifierView(knownRecord);
    assert.deepEqual(detail.coverage_statement, verifier.coverage_statement);
  });

  test('missing timestamps produce incomplete coverage without changing proof-detail success shape', () => {
    const detail = buildProofDetailView({
      ...knownRecord,
      first_event_at: null,
      last_event_at: null,
    });
    assert.equal(detail.receipt.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(detail.coverage_statement.coverage_status, 'incomplete');
    assert.ok(detail.coverage_statement.coverage_codes.includes('event_bounds_missing_first_event_at'));
    assert.ok(detail.coverage_statement.coverage_codes.includes('event_bounds_missing_last_event_at'));
  });

  test('coverage statement itself excludes wallet, PnL, normalized value, profile, upload, mint, and signing fields', () => {
    const detail = buildProofDetailView(knownRecord);
    assertNoForbiddenCoverageFields(detail.coverage_statement);
  });

  test('view-model keeps verification fields separate from lifecycle fields', () => {
    const detail = buildProofDetailView(knownRecord);
    assert.equal(detail.verification.verification_status, 'verified');
    assert.equal(detail.verification.hash_valid, true);
    assert.equal(detail.verification.verifier_passed, true);
    assert.equal(detail.proof_lifecycle.mint_status, 'minted');
    assert.equal(detail.proof_lifecycle.upload_status, 'complete');
    assert.equal(detail.verification.mint_status, undefined);
  });

  test('view-model adds trust summary additively without changing existing sections', () => {
    const detail = buildProofDetailView(knownRecord);
    assert.equal(detail.trust.current_level, 4);
    assert.equal(detail.trust.current_code, 'source_anchored');
    assert.equal(detail.trust.current_label, 'Source Anchored');
    assert.equal(detail.trust.coverage_statement_present, true);
    assert.equal(detail.trust.current_level, 4);
    assert.equal(detail.trust.current_code, 'source_anchored');
    assert.ok(detail.trust.disclosures.includes('Hosted, unlisted, and private labels describe display or distribution choices only. They do not increase proof strength.'));
  });

  test('view-model does not expose raw legacy record blobs', () => {
    const detail = buildProofDetailView(knownRecord);
    assert.equal(detail.legacy.has_legacy_match, false);
    assert.equal(detail.legacy.verification_hash, null);
    assert.equal(detail.legacy.raw, undefined);
  });

  test('view-model handles missing optional artifact fields gracefully', () => {
    const sparse = {
      ...snapshotRecord,
      final_metadata_path: undefined,
      final_image_uri: undefined,
      final_metadata_uri: undefined,
      metadata_uri: undefined,
      image_uri: undefined,
      external_url: undefined,
      mint_blockers: undefined,
      mint_required_steps: undefined,
      verifier_rule_violations: undefined,
    };
    const detail = buildProofDetailView(sparse);
    assert.equal(detail.artifacts.final_metadata_path, null);
    assert.equal(detail.artifacts.final_image_uri, null);
    assert.equal(detail.artifacts.final_metadata_uri, null);
    assert.equal(detail.artifacts.metadata_uri, null);
    assert.equal(detail.artifacts.image_uri, null);
    assert.equal(detail.artifacts.external_url, null);
    assert.deepEqual(detail.proof_lifecycle.mint_blockers, []);
    assert.deepEqual(detail.proof_lifecycle.mint_required_steps, []);
    assert.deepEqual(detail.verification.verifier_rule_violations, []);
    assert.equal(detail.trust.current_level, 3);
    assert.equal(detail.trust.correlatable, false);
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
