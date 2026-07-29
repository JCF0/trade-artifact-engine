#!/usr/bin/env node
import assert from 'node:assert/strict';
import { assertPlainJsonValue, CANONICAL_RECEIPT_FIELDS, validateCanonicalReceiptV1, validateCanonicalReceiptInputV1, validateInputCommitmentV1, ReceiptPackageError } from './schema.mjs';
import { makeFixture } from './fixtures.test-helper.mjs';

const fixture = makeFixture();
const stableReceipt = Object.fromEntries(CANONICAL_RECEIPT_FIELDS.map(field => [field, fixture.canonicalReceipt[field]]));
assert.doesNotThrow(() => validateCanonicalReceiptInputV1(fixture.canonicalReceipt));
assert.doesNotThrow(() => validateCanonicalReceiptV1(stableReceipt));
assert.doesNotThrow(() => validateInputCommitmentV1(fixture.inputCommitment));
for (const digestField of ['transactions_sha256', 'receipt_evidence_sha256']) {
  const value = structuredClone(fixture.inputCommitment); value[digestField] = 'd'.repeat(64);
  assert.throws(() => validateInputCommitmentV1(value), error => error.code === 'unknown_field');
}
for (const profileField of ['normalization_profile', 'reconstruction_engine_version', 'accounting_method_version']) {
  const value = structuredClone(fixture.inputCommitment); value[profileField] = 'runtime label 2026';
  assert.throws(() => validateInputCommitmentV1(value), error => error.code === 'invalid_field');
}
for (const mutate of [
  value => { value.unknown = true; },
  value => Object.defineProperty(value, 'job_id', { enumerable: true, get() { throw new Error('must not run'); } }),
]) {
  const value = structuredClone(fixture.inputCommitment); mutate(value);
  assert.throws(() => validateInputCommitmentV1(value), error => error instanceof ReceiptPackageError && ['accessor_not_allowed', 'unknown_field'].includes(error.code));
}
const custom = Object.create({ inherited: true }); custom.ok = true;
assert.throws(() => assertPlainJsonValue(custom), error => error.code === 'custom_prototype_not_allowed');
const nullPrototype = Object.create(null); nullPrototype.ok = true;
assert.throws(() => assertPlainJsonValue(nullPrototype), error => error.code === 'custom_prototype_not_allowed');
for (const value of [undefined, 1n, NaN, Infinity, -Infinity, -0, () => {}, Symbol('x')]) {
  assert.throws(() => assertPlainJsonValue(value), error => error instanceof ReceiptPackageError);
}
const sparse = []; sparse[1] = 'x';
assert.throws(() => assertPlainJsonValue(sparse), error => error.code === 'sparse_array_not_allowed');
const unknownLimitation = structuredClone(stableReceipt); unknownLimitation.limitations.unknown = true;
assert.throws(() => validateCanonicalReceiptV1(unknownLimitation), error => error.code === 'unknown_field');
const wrongDerived = structuredClone(stableReceipt); wrongDerived.hold_time_seconds += 1;
assert.throws(() => validateCanonicalReceiptV1(wrongDerived), error => error.code === 'derived_field_mismatch');
for (const mutate of [
  receipt => { receipt.receipt_id = 'runtime-selected-id'; },
  receipt => { receipt.display_status = 'Different label'; },
  receipt => { receipt.ledger_accounting_version = 'different_accounting_v2'; },
]) {
  const value = structuredClone(stableReceipt); mutate(value);
  assert.throws(() => validateCanonicalReceiptV1(value), error => error.code === 'derived_field_mismatch');
}
console.log('receipt-package schema: PASS');
