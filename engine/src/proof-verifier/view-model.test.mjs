import assert from 'assert';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofVerifierView } from './view-model.mjs';

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
  const knownRecord = getInventoryReceipt(fixture.hashes.receiptAHash, {
    engineRoot: fixture.root,
    includeExcluded: false,
  });
  const sparseRecord = getInventoryReceipt(fixture.hashes.receiptBHash, {
    engineRoot: fixture.root,
    includeExcluded: false,
  });

  test('view-model returns compact verifier shape for known receipt', () => {
    const view = buildProofVerifierView(knownRecord);
    assert.deepEqual(Object.keys(view), [
      'receipt_hash',
      'receipt_id',
      'receipt_type',
      'valuation_status',
      'coverage_statement',
      'verification',
      'trust',
      'disclosures',
      'instructions',
    ]);
    assert.equal(view.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(view.receipt_id, 'art_v12_cp_TEST_0');
    assert.equal(view.receipt_type, 'closed_position');
    assert.equal(view.valuation_status, 'raw_quote');
  });


  test('adds core receipt coverage statement without publication context', () => {
    const view = buildProofVerifierView(knownRecord);
    assert.equal(view.coverage_statement.coverage_statement_version, 'receipt_coverage_v1');
    assert.equal(view.coverage_statement.coverage_status, 'complete');
    assert.equal(view.coverage_statement.scope.scope_type, 'receipt');
    assert.equal(view.coverage_statement.publication_context, null);
    assert.equal(view.coverage_statement.receipt.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(view.coverage_statement.valuation_basis.valuation_status, 'raw_quote');
    assert.equal(view.coverage_statement.valuation_basis.usd_normalized, false);
  });

  test('verifier and proof-detail core coverage statements deep-equal for same record', () => {
    const view = buildProofVerifierView(knownRecord);
    const detail = buildProofDetailView(knownRecord);
    assert.deepEqual(view.coverage_statement, detail.coverage_statement);
  });

  test('missing timestamps produce incomplete coverage without changing verifier success shape', () => {
    const view = buildProofVerifierView({
      ...knownRecord,
      first_event_at: null,
      last_event_at: null,
    });
    assert.equal(view.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(view.coverage_statement.coverage_status, 'incomplete');
    assert.ok(view.coverage_statement.coverage_codes.includes('event_bounds_missing_first_event_at'));
    assert.ok(view.coverage_statement.coverage_codes.includes('event_bounds_missing_last_event_at'));
  });

  test('coverage statement itself excludes wallet, PnL, normalized value, profile, upload, mint, and signing fields', () => {
    const view = buildProofVerifierView(knownRecord);
    assertNoForbiddenCoverageFields(view.coverage_statement);
  });

  test('view-model keeps verifier fields distinct from lifecycle and status fields', () => {
    const view = buildProofVerifierView(knownRecord);
    assert.equal(view.verification.hash_valid, true);
    assert.equal(view.verification.verifier_passed, true);
    assert.equal(view.verification.verifier_schema_valid, true);
    assert.equal(view.verification.verifier_consistency_valid, true);
    assert.deepEqual(view.verification.verifier_rule_violations, []);
    assert.equal(view.verification.verification_status, undefined);
    assert.equal(view.verification.mint_status, undefined);
    assert.equal(view.trust.current_code, 'source_anchored');
  });

  test('view-model includes Slice 1 trust summary and disclosures', () => {
    const view = buildProofVerifierView(knownRecord);
    assert.deepEqual(view.trust, {
      current_level: 4,
      current_code: 'source_anchored',
      current_label: 'Source Anchored',
    });
    assert.ok(view.disclosures.includes('Selected receipt only. Not a portfolio statement.'));
    assert.ok(view.disclosures.includes('Hosted, unlisted, and private labels describe display or distribution choices only. They do not increase proof strength.'));
    assert.ok(view.disclosures.includes('Source anchors make this proof correlatable and should not be treated as private.'));
  });

  test('view-model includes local inventory-backed instructions', () => {
    const view = buildProofVerifierView(knownRecord);
    assert.deepEqual(view.instructions, {
      mode: 'local_inventory_backed',
      summary: 'Local inventory-backed verifier view only. This surface does not rerun the ledger verifier and does not perform network verification.',
      proof_api_path: `/api/proof/${fixture.hashes.receiptAHash}`,
      inventory_api_path: `/inventory/${fixture.hashes.receiptAHash}`,
      local_command_template: 'node engine/src/verify/verify-receipt.mjs <receipt.json>',
    });
  });

  test('view-model handles sparse verifier outputs without inventing values', () => {
    const sparse = {
      ...sparseRecord,
      recomputed_hash: undefined,
      hash_valid: undefined,
      verifier_passed: undefined,
      verifier_schema_valid: undefined,
      verifier_consistency_valid: undefined,
      verifier_rule_violations: undefined,
    };
    const view = buildProofVerifierView(sparse);
    assert.equal(view.verification.recomputed_hash, null);
    assert.equal(view.verification.hash_valid, null);
    assert.equal(view.verification.verifier_passed, null);
    assert.equal(view.verification.verifier_schema_valid, null);
    assert.equal(view.verification.verifier_consistency_valid, null);
    assert.deepEqual(view.verification.verifier_rule_violations, []);
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);