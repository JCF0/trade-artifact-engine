import assert from 'assert';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
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