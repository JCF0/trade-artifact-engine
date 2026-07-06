import assert from 'assert';

import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { buildTrustSummary, deriveTrustLevel, getSourceAnchors } from './trust-model.mjs';

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
  const receiptA = getInventoryReceipt(fixture.hashes.receiptAHash, {
    engineRoot: fixture.root,
    includeExcluded: false,
  });
  const receiptB = getInventoryReceipt(fixture.hashes.receiptBHash, {
    engineRoot: fixture.root,
    includeExcluded: false,
  });

  test('Level 4 derives when rule-verified receipt exposes source anchors', () => {
    const trust = deriveTrustLevel(receiptA);
    assert.equal(trust.current_level, 4);
    assert.equal(trust.current_code, 'source_anchored');
    assert.equal(trust.coverage_statement_present, false);
    assert.equal(trust.correlatable, true);
    assert.ok(trust.source_anchor_types.includes('transaction_signature'));
    assert.ok(trust.source_anchor_types.includes('mint_address'));
    assert.ok(trust.source_anchor_types.includes('metadata_uri'));
    assert.ok(trust.disclosures.includes('Hosted, unlisted, and private labels describe display or distribution choices only. They do not increase proof strength.'));
    assert.ok(trust.disclosures.includes('Source anchors make this proof correlatable and should not be treated as private.'));
  });

  test('Level 3 derives when receipt is rule-verified but has no source anchors', () => {
    const stripped = {
      ...receiptB,
      final_image_uri: null,
      final_metadata_uri: null,
      metadata_uri: null,
      image_uri: null,
      external_url: null,
      proof_wallet_pubkey: null,
      mint_authority_pubkey: null,
      mint_address: null,
      token_account: null,
      transaction_signature: null,
    };
    const trust = deriveTrustLevel(stripped);
    assert.equal(trust.current_level, 3);
    assert.equal(trust.current_code, 'rule_verified');
    assert.equal(trust.correlatable, false);
    assert.equal(trust.correlatable_disclosure, null);
  });

  test('Level 2 derives when hash is valid but verifier pass is incomplete', () => {
    const partial = {
      ...receiptA,
      verifier_passed: null,
      verifier_schema_valid: null,
      verifier_consistency_valid: null,
      final_image_uri: null,
      final_metadata_uri: null,
      metadata_uri: null,
      image_uri: null,
      external_url: null,
      mint_address: null,
      token_account: null,
      transaction_signature: null,
    };
    const trust = deriveTrustLevel(partial);
    assert.equal(trust.current_level, 2);
    assert.equal(trust.current_code, 'hash_verified');
  });

  test('Level 1 derives when generated receipt exists without hash verification', () => {
    const generatedOnly = {
      receipt_hash: 'a'.repeat(64),
      receipt_id: 'art_v12_cp_TEST_0',
      hash_valid: null,
      verifier_passed: null,
      verifier_schema_valid: null,
      verifier_consistency_valid: null,
    };
    const trust = deriveTrustLevel(generatedOnly);
    assert.equal(trust.current_level, 1);
    assert.equal(trust.current_code, 'generated_receipt');
    assert.deepEqual(trust.planned_levels.map(level => level.level), [5]);
  });

  test('Level 5 is only reached when an explicit coverage statement exists on top of Level 4', () => {
    const covered = {
      ...receiptA,
      coverage_statement: 'Coverage scoped to committed workspace artifacts for this wallet and selection window.',
    };
    const trust = deriveTrustLevel(covered);
    assert.equal(trust.current_level, 5);
    assert.equal(trust.current_code, 'coverage_scoped');
    assert.equal(trust.coverage_statement_present, true);
    assert.equal(trust.coverage_statement, covered.coverage_statement);
    assert.deepEqual(trust.planned_levels, []);
  });

  test('weak or unverified receipt with anchors does not reach Level 4', () => {
    const weak = {
      receipt_hash: 'a'.repeat(64),
      receipt_id: 'art_v12_cp_TEST_0',
      hash_valid: false,
      verifier_passed: false,
      verifier_schema_valid: false,
      verifier_consistency_valid: false,
      transaction_signature: 'TX_A',
    };
    const trust = deriveTrustLevel(weak);
    assert.equal(trust.current_level, 1);
    assert.equal(trust.current_code, 'generated_receipt');
    assert.equal(trust.correlatable, true);
  });

  test('hash-valid but rule-failed receipt with anchors does not reach Level 4', () => {
    const weak = {
      ...receiptA,
      verifier_passed: false,
      verifier_schema_valid: true,
      verifier_consistency_valid: true,
      transaction_signature: 'TX_A',
    };
    const trust = deriveTrustLevel(weak);
    assert.equal(trust.current_level, 2);
    assert.equal(trust.current_code, 'hash_verified');
  });

  test('coverage present without rule verification does not reach Level 5', () => {
    const weak = {
      ...receiptA,
      verifier_passed: false,
      verifier_schema_valid: true,
      verifier_consistency_valid: true,
      coverage_statement: 'Coverage scoped to selected receipt only.',
    };
    const trust = deriveTrustLevel(weak);
    assert.equal(trust.current_level, 2);
    assert.notEqual(trust.current_code, 'coverage_scoped');
  });

  test('coverage present without source anchoring does not reach Level 5', () => {
    const weak = {
      ...receiptB,
      final_image_uri: null,
      final_metadata_uri: null,
      metadata_uri: null,
      image_uri: null,
      external_url: null,
      proof_wallet_pubkey: null,
      mint_authority_pubkey: null,
      mint_address: null,
      token_account: null,
      transaction_signature: null,
      coverage_scope: 'Coverage scoped to committed workspace artifacts only.',
    };
    const trust = deriveTrustLevel(weak);
    assert.equal(trust.current_level, 3);
    assert.notEqual(trust.current_code, 'coverage_scoped');
  });

  test('hash invalid caps the level even if later fields exist', () => {
    const weak = {
      ...receiptA,
      hash_valid: false,
      verifier_passed: true,
      verifier_schema_valid: true,
      verifier_consistency_valid: true,
      transaction_signature: 'TX_A',
      coverage_statement: 'Coverage scoped to selected receipt only.',
    };
    const trust = deriveTrustLevel(weak);
    assert.equal(trust.current_level, 1);
    assert.equal(trust.current_code, 'generated_receipt');
  });

  test('source anchor extraction returns only exposed anchors', () => {
    const anchors = getSourceAnchors({
      mint_address: 'MINT_A',
      final_metadata_uri: 'https://example.invalid/meta-a',
      external_url: '',
      transaction_signature: null,
    });
    assert.deepEqual(anchors, [
      { type: 'mint_address', value: 'MINT_A' },
      { type: 'final_metadata_uri', value: 'https://example.invalid/meta-a' },
    ]);
  });

  test('trust summary compresses derived trust state', () => {
    const summary = buildTrustSummary(receiptA);
    assert.deepEqual(summary, {
      level: 4,
      code: 'source_anchored',
      label: 'Source Anchored',
      correlatable: true,
      coverage_statement_present: false,
    });
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
