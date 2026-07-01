import assert from 'assert';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
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

const fixture = createInventoryFixture();

try {
  const knownRecord = getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root });
  const snapshotRecord = getInventoryReceipt(fixture.hashes.receiptBHash, { engineRoot: fixture.root });

  test('view-model maps known inventory record into expected sections', () => {
    const detail = buildProofDetailView(knownRecord);
    assert.deepEqual(Object.keys(detail), [
      'receipt',
      'verification',
      'valuation',
      'proof_lifecycle',
      'artifacts',
      'legacy',
      'links',
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
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
