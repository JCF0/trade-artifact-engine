import { verifyReceipt } from '../ledger/receipt-verifier.mjs';
import { fail } from './errors.mjs';
import {
  PACKAGE_VERSION, PACKAGE_MEMBER_NAMES, CONTENT_MEMBER_NAMES, ARCHIVE_FIELDS, ECONOMICS_RECORD_FIELDS,
  assertPlainJsonValue, assertExactFields, assertReceiptHash, validateCanonicalReceiptV1,
  validateArchiveRecordV1, validateEconomicsRecordV1, validateVerificationResultV1, validateInputCommitmentV1,
} from './schema.mjs';
import { canonicalJson, sha256CanonicalJson, computePackageDigest } from './serialize.mjs';

function same(a, b) { return canonicalJson(a) === canonicalJson(b); }
function assertSame(actual, expected, code, message, details = {}) { if (!same(actual, expected)) fail(code, message, details); }
function reconstruct(archive, economics) {
  const receipt = {};
  for (const field of ARCHIVE_FIELDS) receipt[field] = archive[field];
  for (const field of ECONOMICS_RECORD_FIELDS) receipt[field] = economics[field];
  return receipt;
}
function validateManifest(manifest) {
  assertExactFields(manifest, ['package_version','receipt_hash','receipt_version','receipt_type','package_status','members','verification_gate','input_commitment','package_digest'], 'manifest');
  if (manifest.package_version !== PACKAGE_VERSION) fail('unsupported_package_version', `package_version must be ${PACKAGE_VERSION}`);
  if (manifest.package_status !== 'verified') fail('package_status_invalid', 'package_status must be verified');
  assertReceiptHash(manifest.receipt_hash); assertReceiptHash(manifest.package_digest, 'package_digest');
  assertExactFields(manifest.members, CONTENT_MEMBER_NAMES, 'manifest.members');
  for (const name of CONTENT_MEMBER_NAMES) {
    assertExactFields(manifest.members[name], ['media_type','sha256'], `manifest.members.${name}`);
    if (manifest.members[name].media_type !== 'application/json') fail('invalid_media_type', `${name} media_type must be application/json`);
    assertReceiptHash(manifest.members[name].sha256, `${name}.sha256`);
  }
  assertExactFields(manifest.verification_gate, ['recomputed_hash','hash_valid','schema_valid','consistency_valid','pass','rule_violation_count'], 'manifest.verification_gate');
  validateInputCommitmentV1(manifest.input_commitment);
}
export function validateReceiptPackageV1(pkg) {
  assertPlainJsonValue(pkg, ['receipt_package']);
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)
      || Object.keys(pkg).length !== PACKAGE_MEMBER_NAMES.length
      || PACKAGE_MEMBER_NAMES.some(name => !Object.hasOwn(pkg, name))) {
    fail('package_member_set_invalid', 'package must contain exactly the five authoritative v1 members');
  }
  const manifest = pkg['manifest.json']; const canonical = pkg['canonical-receipt.json'];
  const verification = pkg['verification.json']; const archive = pkg['archive-record.json']; const economics = pkg['economics.json'];
  validateManifest(manifest); validateCanonicalReceiptV1(canonical); validateVerificationResultV1(verification);
  validateArchiveRecordV1(archive); validateEconomicsRecordV1(economics);
  const hash = canonical.receipt_hash;
  for (const [context, value] of [['manifest',manifest],['verification',verification],['archive',archive],['economics',economics]]) {
    if (value.receipt_hash !== hash) fail('receipt_hash_disagreement', `${context} receipt_hash does not match canonical receipt`, { context });
  }
  if (manifest.receipt_version !== canonical.receipt_version || manifest.receipt_type !== canonical.receipt_type) fail('manifest_identity_mismatch', 'manifest receipt version/type does not match canonical receipt');
  if (manifest.input_commitment.accounting_method_version !== canonical.accounting_method) {
    fail('input_commitment_mismatch', 'input commitment accounting version must match the canonical accounting method');
  }
  for (const field of ARCHIVE_FIELDS) if (!same(archive[field], canonical[field])) fail('archive_overlap_mismatch', `archive field does not exactly match canonical receipt: ${field}`, { field });
  for (const field of ECONOMICS_RECORD_FIELDS) if (!same(economics[field], canonical[field])) fail('economics_overlap_mismatch', `economics field does not exactly match canonical receipt: ${field}`, { field });
  const reconstructed = reconstruct(archive, economics);
  assertSame(reconstructed, canonical, 'canonical_reconstruction_mismatch', 'archive + economics must reconstruct canonical-receipt.json exactly');
  const deterministic = verifyReceipt(reconstructed);
  if (deterministic.recomputed_hash !== hash || !deterministic.hash_valid) fail('receipt_hash_mismatch', 'reconstructed receipt does not reproduce receipt_hash');
  if (!deterministic.schema_valid || !deterministic.consistency_valid || !deterministic.pass || deterministic.rule_violations.length !== 0) fail('verification_gate_failed', 'deterministic verifier gate failed');
  assertSame(verification, deterministic, 'verification_result_mismatch', 'verification.json must equal complete deterministic verifyReceipt() result');
  const expectedGate = { recomputed_hash: deterministic.recomputed_hash, hash_valid: true, schema_valid: true, consistency_valid: true, pass: true, rule_violation_count: 0 };
  assertSame(manifest.verification_gate, expectedGate, 'manifest_verification_gate_mismatch', 'manifest verification_gate does not match verifier result');
  for (const name of CONTENT_MEMBER_NAMES) {
    const actual = sha256CanonicalJson(pkg[name]);
    if (manifest.members[name].sha256 !== actual) fail('member_hash_mismatch', `${name} SHA-256 does not match manifest`, { member: name, expected: actual, actual: manifest.members[name].sha256 });
  }
  const digest = computePackageDigest(pkg);
  if (manifest.package_digest !== digest) fail('package_digest_mismatch', 'package_digest does not match canonical package preimage', { expected: digest, actual: manifest.package_digest });
  return true;
}
