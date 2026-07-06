import assert from 'assert';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofCardView } from './view-model.mjs';
import { renderProofCardHtml } from './render-html.mjs';

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

  test('HTML includes title, trust label, short receipt hash, verifier path, and disclosures', () => {
    const html = renderProofCardHtml(buildProofCardView(proofDetail));
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('Artifact Proof'));
    assert.ok(html.includes('Source Anchored'));
    assert.ok(html.includes('aaaaaaaa...aaaaaaaa'));
    assert.ok(html.includes(`/api/verifier/${fixture.hashes.receiptAHash}`));
    assert.ok(html.includes('Selected receipt only. Not a portfolio statement.'));
    assert.ok(html.includes('Raw quote only. No USD normalization.'));
  });

  test('HTML does not include upload, mint, network rows, scripts, external css, or external assets', () => {
    const html = renderProofCardHtml(buildProofCardView(proofDetail));
    assert.ok(!html.includes('Upload Status'));
    assert.ok(!html.includes('Mint Status'));
    assert.ok(!html.includes('Proof Lifecycle'));
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('<link rel='));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('src="http'));
  });

  test('truncated wallet mode does not leak full wallet', () => {
    const clone = structuredClone(proofDetail);
    clone.receipt.wallet = 'TESTWALLET12345678901234567890123456789012345';
    const html = renderProofCardHtml(buildProofCardView(clone, { walletDisplayMode: 'truncated' }));
    assert.ok(html.includes('TESTWA...2345'));
    assert.ok(!html.includes('TESTWALLET12345678901234567890123456789012345'));
  });

  test('redacted wallet mode does not leak full wallet', () => {
    const clone = structuredClone(proofDetail);
    clone.receipt.wallet = 'TESTWALLET12345678901234567890123456789012345';
    const html = renderProofCardHtml(buildProofCardView(clone, { walletDisplayMode: 'redacted' }));
    assert.ok(html.includes('[redacted]'));
    assert.ok(!html.includes('TESTWALLET12345678901234567890123456789012345'));
  });
}
finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);