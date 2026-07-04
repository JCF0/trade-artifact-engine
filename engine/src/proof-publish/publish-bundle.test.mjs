import assert from 'assert';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildPublishBundle } from './publish-bundle.mjs';
import { REDACTED_WALLET_TEXT } from './wallet-policy.mjs';

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
  const proofDetail = buildProofDetailView(knownRecord);
  const longWalletProofDetail = structuredClone(proofDetail);
  longWalletProofDetail.receipt.wallet = 'TESTWALLET12345678901234567890123456789012345';

  test('bundle returns exactly index.html, proof.json, manifest.json', () => {
    const bundle = buildPublishBundle(proofDetail, { generatedAt: '2026-07-02T00:00:00.000Z' });
    assert.deepEqual(Object.keys(bundle.files).sort(), ['index.html', 'manifest.json', 'proof.json']);
  });

  test('defaults visibility to unlisted and wallet_display_mode to truncated', () => {
    const bundle = buildPublishBundle(proofDetail, { generatedAt: '2026-07-02T00:00:00.000Z' });
    assert.equal(bundle.manifest.visibility, 'unlisted');
    assert.equal(bundle.manifest.wallet_display_mode, 'truncated');
    assert.equal(bundle.proofJson.publish.visibility, 'unlisted');
    assert.equal(bundle.proofJson.publish.wallet_display_mode, 'truncated');
  });

  test('hosted_url is relative when base_url is absent', () => {
    const bundle = buildPublishBundle(proofDetail, { generatedAt: '2026-07-02T00:00:00.000Z' });
    assert.equal(bundle.manifest.base_url, null);
    assert.equal(bundle.manifest.hosted_url, './index.html');
  });

  test('manifest contains expected metadata', () => {
    const bundle = buildPublishBundle(proofDetail, { generatedAt: '2026-07-02T00:00:00.000Z' });
    assert.equal(bundle.manifest.bundle_version, 'v1.4');
    assert.equal(bundle.manifest.bundle_type, 'hosted_proof_bundle');
    assert.equal(bundle.manifest.receipt_hash, proofDetail.receipt.receipt_hash);
    assert.equal(bundle.manifest.slug, bundle.slug);
    assert.equal(bundle.manifest.generated_at, '2026-07-02T00:00:00.000Z');
    assert.deepEqual(bundle.manifest.files, {
      'index.html': 'index.html',
      'proof.json': 'proof.json',
    });
    assert.deepEqual(bundle.manifest.render_context, {
      hosted: true,
      selected_receipt_only: true,
      raw_quote_only: true,
      unlisted_not_private: true,
    });
  });

  test('proof.json uses transformed wallet display and does not leak full wallet in truncated mode', () => {
    const bundle = buildPublishBundle(longWalletProofDetail, { generatedAt: '2026-07-02T00:00:00.000Z' });
    assert.equal(bundle.proofJson.proof.receipt.wallet, 'TESTWA...2345');
    const serialized = bundle.files['proof.json'];
    assert.ok(serialized.includes('TESTWA...2345'));
    assert.ok(!serialized.includes('TESTWALLET12345678901234567890123456789012345'));
  });

  test('proof.json redacted mode hides wallet', () => {
    const bundle = buildPublishBundle(longWalletProofDetail, {
      generatedAt: '2026-07-02T00:00:00.000Z',
      wallet_display_mode: 'redacted',
    });
    assert.equal(bundle.proofJson.proof.receipt.wallet, REDACTED_WALLET_TEXT);
    assert.ok(!bundle.files['proof.json'].includes('TESTWALLET12345678901234567890123456789012345'));
  });

  test('proof.json preserves proof detail structure and separate verification/lifecycle fields', () => {
    const bundle = buildPublishBundle(proofDetail, { generatedAt: '2026-07-02T00:00:00.000Z' });
    assert.deepEqual(Object.keys(bundle.proofJson.proof), [
      'receipt',
      'verification',
      'valuation',
      'proof_lifecycle',
      'artifacts',
      'legacy',
      'links',
      'flags_and_limitations',
    ]);
    assert.equal(bundle.proofJson.proof.verification.verification_status, 'verified');
    assert.equal(bundle.proofJson.proof.verification.hash_valid, true);
    assert.equal(bundle.proofJson.proof.verification.verifier_passed, true);
    assert.equal(bundle.proofJson.proof.proof_lifecycle.upload_status, 'complete');
    assert.equal(bundle.proofJson.proof.proof_lifecycle.mint_status, 'minted');
    assert.equal(bundle.proofJson.proof.verification.mint_status, undefined);
    assert.equal(bundle.proofJson.proof.legacy.raw, undefined);
    assert.equal(bundle.proofJson.proof.flags_and_limitations.raw_quote_only_disclosure, 'Raw quote only. No USD normalization.');
  });

  test('index.html includes hosted, unlisted, raw quote, and selected receipt disclosures', () => {
    const bundle = buildPublishBundle(proofDetail, { generatedAt: '2026-07-02T00:00:00.000Z' });
    assert.ok(bundle.indexHtml.includes('Hosted proof page.'));
    assert.ok(bundle.indexHtml.includes('Unlisted does not mean private. Anyone with the link can view.'));
    assert.ok(bundle.indexHtml.includes('Raw quote only. No USD normalization.'));
    assert.ok(bundle.indexHtml.includes('Selected receipt only. Not a portfolio statement.'));
  });

  test('private visibility is manifest-only with no behavior side effects', () => {
    const unlistedBundle = buildPublishBundle(proofDetail, { generatedAt: '2026-07-02T00:00:00.000Z' });
    const privateBundle = buildPublishBundle(proofDetail, {
      generatedAt: '2026-07-02T00:00:00.000Z',
      visibility: 'private',
    });
    assert.equal(privateBundle.manifest.visibility, 'private');
    assert.equal(privateBundle.manifest.render_context.unlisted_not_private, false);
    assert.equal(privateBundle.indexHtml, unlistedBundle.indexHtml);
  });

  test('no filesystem writes occur during bundle build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trade-artifact-publish-bundle-'));
    try {
      const before = readdirSync(dir);
      buildPublishBundle(proofDetail, { generatedAt: '2026-07-02T00:00:00.000Z' });
      const after = readdirSync(dir);
      assert.deepEqual(after, before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
