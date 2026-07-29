#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReceiptPackageV1 } from './builder.mjs';
import { canonicalJson } from './serialize.mjs';
import { makeFixture, clone } from './fixtures.test-helper.mjs';

function deeplyFrozen(value) { if (value && typeof value === 'object') return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen); return true; }
const OPERATIONAL_FIELDS = ['candidate_hash', 'source', 'promoted_at', 'promoted_from'];
function withoutOperational(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => !OPERATIONAL_FIELDS.includes(key))); }
for (const symbol of ['JUP', 'RAY']) {
  const input = makeFixture(symbol); const before = clone(input);
  const pkg = buildReceiptPackageV1(input);
  assert.deepEqual(input, before); assert.equal(pkg['manifest.json'].receipt_hash, input.canonicalReceipt.receipt_hash);
  assert.deepEqual(pkg['canonical-receipt.json'], withoutOperational(input.canonicalReceipt));
  assert.deepEqual(pkg['verification.json'], input.verificationResult);
  assert.deepEqual(pkg['archive-record.json'], withoutOperational(input.archiveRecord));
  assert.deepEqual(pkg['economics.json'], input.economicsRecord);
  assert.deepEqual(pkg['canonical-receipt.json'].entry_tx_hashes, input.canonicalReceipt.entry_tx_hashes);
  assert.equal(pkg['canonical-receipt.json'].realized_pnl_quote, input.canonicalReceipt.realized_pnl_quote);
  assert.ok(deeplyFrozen(pkg));
  assert.throws(() => { pkg['canonical-receipt.json'].entry_tx_hashes.push('changed'); }, TypeError);
}
const operationalA = makeFixture('JUP', {
  promoted_at: 1700000300,
  source: 'position_ledger_primary_run',
  promoted_from: 'candidate-primary',
  candidate_hash: 'a'.repeat(64),
});
const operationalB = makeFixture('JUP', {
  promoted_at: 1900000000,
  source: 'position_ledger_replay_run',
  promoted_from: 'candidate-replay',
  candidate_hash: 'b'.repeat(64),
});
assert.equal(operationalA.canonicalReceipt.receipt_hash, operationalB.canonicalReceipt.receipt_hash);
const operationalPackageA = buildReceiptPackageV1(operationalA);
const operationalPackageB = buildReceiptPackageV1(operationalB);
assert.equal(canonicalJson(operationalPackageA), canonicalJson(operationalPackageB));
assert.equal(operationalPackageA['manifest.json'].package_digest, operationalPackageB['manifest.json'].package_digest);
for (const field of ['promoted_at', 'source', 'promoted_from', 'candidate_hash']) {
  assert.ok(!canonicalJson(operationalPackageA).includes(`\"${field}\"`));
}
const stableRebuild = buildReceiptPackageV1({
  canonicalReceipt: operationalPackageA['canonical-receipt.json'],
  verificationResult: operationalPackageA['verification.json'],
  archiveRecord: operationalPackageA['archive-record.json'],
  economicsRecord: operationalPackageA['economics.json'],
  inputCommitment: operationalPackageA['manifest.json'].input_commitment,
});
assert.equal(canonicalJson(stableRebuild), canonicalJson(operationalPackageA));
for (const ambientField of ['walletTransactions', 'providerResponse', 'lookbackLength', 'pagination']) {
  const ambientInput = { ...makeFixture(), [ambientField]: ambientField === 'walletTransactions' ? ['selected', 'unrelated'] : 'operational' };
  assert.throws(() => buildReceiptPackageV1(ambientInput), error => error.code === 'unknown_field');
}
const baseVersionPackage = buildReceiptPackageV1(makeFixture());
const changedReconstruction = makeFixture();
changedReconstruction.inputCommitment.reconstruction_engine_version = 'position_ledger_v2';
assert.notEqual(buildReceiptPackageV1(changedReconstruction)['manifest.json'].package_digest, baseVersionPackage['manifest.json'].package_digest);
const changedAccounting = makeFixture('JUP', {
  accounting_method: 'weighted_average_position_accounting_v2',
  ledger_accounting_version: 'weighted_average_position_accounting_v2',
});
changedAccounting.inputCommitment.accounting_method_version = 'weighted_average_position_accounting_v2';
assert.notEqual(buildReceiptPackageV1(changedAccounting)['manifest.json'].package_digest, baseVersionPackage['manifest.json'].package_digest);
const changedTransactions = makeFixture('JUP', {
  entry_tx_hashes: ['JUP-entry-1', 'JUP-entry-2', 'JUP-entry-3'],
  num_buys: 3,
});
assert.notEqual(buildReceiptPackageV1(changedTransactions)['manifest.json'].package_digest, baseVersionPackage['manifest.json'].package_digest);
const changedEconomics = makeFixture('JUP', {
  total_sold_quote: 160,
  avg_sell_quote_price: 0.16,
  realized_pnl_quote: 60,
  realized_pnl_pct: 60,
});
assert.notEqual(buildReceiptPackageV1(changedEconomics)['manifest.json'].package_digest, baseVersionPackage['manifest.json'].package_digest);
const mismatchedVersion = makeFixture(); mismatchedVersion.inputCommitment.accounting_method_version = 'weighted_average_position_accounting_v2';
assert.throws(() => buildReceiptPackageV1(mismatchedVersion), error => error.code === 'input_commitment_mismatch');
const input = makeFixture();
const detachedPackage = buildReceiptPackageV1(input);
const detachedCanonical = clone(detachedPackage['canonical-receipt.json']);
const detachedEconomics = clone(detachedPackage['economics.json']);
input.canonicalReceipt.limitations.disclosures.push('mutated_after_build');
input.economicsRecord.entry_tx_hashes[0] = 'mutated_after_build';
assert.deepEqual(detachedPackage['canonical-receipt.json'], detachedCanonical);
assert.deepEqual(detachedPackage['economics.json'], detachedEconomics);
const reorderedInput = makeFixture();
const reordered = Object.fromEntries(Object.entries(reorderedInput).reverse());
for (const key of Object.keys(reordered)) if (reordered[key] && !Array.isArray(reordered[key]) && typeof reordered[key] === 'object') reordered[key] = Object.fromEntries(Object.entries(reordered[key]).reverse());
assert.equal(canonicalJson(buildReceiptPackageV1(reorderedInput)), canonicalJson(buildReceiptPackageV1(reordered)));
const parsedLf = JSON.parse(canonicalJson(reorderedInput));
const parsedCrlf = JSON.parse(canonicalJson(reorderedInput).replaceAll('\n', '\r\n'));
assert.equal(canonicalJson(buildReceiptPackageV1(parsedLf)), canonicalJson(buildReceiptPackageV1(parsedCrlf)));
const packageText = canonicalJson(buildReceiptPackageV1(reorderedInput));
for (const term of ['transactions_sha256','receipt_evidence_sha256','promoted_at','source','promoted_from','candidate_hash','job_id','runtime_timestamp','hostname','machine_path','evidence_path','provider_url','api_key_identity','retry_count','git_commit','local_source_directory','upload_status','mint_status','signing_state','raw_transaction_bodies']) assert.ok(!packageText.includes(`\"${term}\"`));
const forbidden = ['job_id','runtime_timestamp','hostname','machine_path','evidence_path','provider_url','api_key_identity','retry_count','git_commit','local_source_directory','upload_status','mint_status','signing_state','raw_transaction_bodies'];
for (const key of forbidden) { const bad = makeFixture(); bad.inputCommitment[key] = 'forbidden'; assert.throws(() => buildReceiptPackageV1(bad)); }
for (const value of ['https://provider.invalid/api', '/home/operator/evidence', 'C:\\private\\evidence']) {
  const bad = makeFixture(); bad.inputCommitment.fetch_profile = value;
  assert.throws(() => buildReceiptPackageV1(bad), error => error.code === 'forbidden_value');
}
const nestedForbidden = makeFixture(); nestedForbidden.canonicalReceipt.limitations.disclosures[0] = 'https://provider.invalid/raw';
assert.throws(() => buildReceiptPackageV1(nestedForbidden), error => error.code === 'forbidden_value');
for (const embedded of [
  'provider mirror: https://provider.invalid/raw',
  'evidence saved at /home/operator/evidence.json',
  'evidence=/home/operator/evidence.json',
  'evidence:/tmp',
  'evidence saved at C:\\private\\evidence.json',
  'evidence=C:\\private\\evidence.json',
  'evidence saved at \\\\server\\share\\evidence.json',
  '[\\\\server\\share\\evidence.json]',
]) {
  const bad = makeFixture(); bad.canonicalReceipt.limitations.disclosures[0] = embedded;
  assert.throws(() => buildReceiptPackageV1(bad), error => error.code === 'forbidden_value');
}
const source = readFileSync(new URL('./builder.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(source, /(?:from\s+['"](?:node:)?(?:fs|path|http|https|net)|provider|uploader|upload-package|mint|sign)/i);
console.log('receipt-package builder: PASS');
