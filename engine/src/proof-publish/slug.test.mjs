import assert from 'assert';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildPublishSlug } from './slug.mjs';

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
  const otherRecord = getInventoryReceipt(fixture.hashes.receiptBHash, { engineRoot: fixture.root });
  const proofDetail = buildProofDetailView(knownRecord);

  test('slug is deterministic for same receipt_hash', () => {
    assert.equal(buildPublishSlug(fixture.hashes.receiptAHash), buildPublishSlug(fixture.hashes.receiptAHash));
  });

  test('slug is URL-safe and has expected shape', () => {
    assert.match(buildPublishSlug(fixture.hashes.receiptAHash), /^p-[a-f0-9]{24}$/);
  });

  test('different receipt_hash values produce different slugs', () => {
    assert.notEqual(buildPublishSlug(fixture.hashes.receiptAHash), buildPublishSlug(fixture.hashes.receiptBHash));
  });

  test('slug does not include wallet, token mint, receipt type, or raw receipt_hash', () => {
    const slug = buildPublishSlug(fixture.hashes.receiptAHash);
    assert.ok(!slug.includes(proofDetail.receipt.wallet.toLowerCase()));
    assert.ok(!slug.includes(proofDetail.receipt.token_mint.toLowerCase()));
    assert.ok(!slug.includes(proofDetail.receipt.receipt_type.toLowerCase()));
    assert.ok(!slug.includes(fixture.hashes.receiptAHash.toLowerCase()));
    assert.ok(!slug.includes(otherRecord.token_mint.toLowerCase()));
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
