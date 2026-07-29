import { fail } from './errors.mjs';
import {
  PACKAGE_VERSION, CONTENT_MEMBER_NAMES, CANONICAL_RECEIPT_FIELDS, ARCHIVE_FIELDS,
  assertExactFields, validateCanonicalReceiptInputV1, validateCanonicalReceiptV1,
  validateVerificationResultV1, validateArchiveRecordInputV1, validateArchiveRecordV1,
  validateEconomicsRecordV1, validateInputCommitmentV1,
} from './schema.mjs';
import { sha256CanonicalJson, computePackageDigest } from './serialize.mjs';
import { validateReceiptPackageV1 } from './validator.mjs';

function clone(value) { if (Array.isArray(value)) return value.map(clone); if (value !== null && typeof value === 'object') { const result = {}; for (const key of Object.keys(value)) result[key] = clone(value[key]); return result; } return value; }
function project(value, fields) { return Object.fromEntries(fields.map(field => [field, clone(value[field])])); }
function deepFreeze(value) { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
export function buildReceiptPackageV1(input) {
  assertExactFields(input, ['canonicalReceipt','verificationResult','archiveRecord','economicsRecord','inputCommitment'], 'builder_input');
  validateCanonicalReceiptInputV1(input.canonicalReceipt);
  validateArchiveRecordInputV1(input.archiveRecord);
  const canonical = project(input.canonicalReceipt, CANONICAL_RECEIPT_FIELDS);
  const verification = clone(input.verificationResult);
  const archive = { archive_record_version: input.archiveRecord.archive_record_version, ...project(input.archiveRecord, ARCHIVE_FIELDS) };
  const economics = clone(input.economicsRecord); const commitment = clone(input.inputCommitment);
  validateCanonicalReceiptV1(canonical); validateVerificationResultV1(verification); validateArchiveRecordV1(archive); validateEconomicsRecordV1(economics); validateInputCommitmentV1(commitment);
  if (commitment.accounting_method_version !== canonical.accounting_method) {
    fail('input_commitment_mismatch', 'input commitment accounting version must match the canonical accounting method');
  }
  if (!verification.hash_valid || !verification.schema_valid || !verification.consistency_valid || !verification.pass || verification.rule_violations.length !== 0) fail('verification_gate_failed', 'verificationResult must pass every deterministic gate with zero violations');
  const members = { 'canonical-receipt.json': canonical, 'verification.json': verification, 'archive-record.json': archive, 'economics.json': economics };
  const memberDigests = {};
  for (const name of CONTENT_MEMBER_NAMES) memberDigests[name] = { media_type: 'application/json', sha256: sha256CanonicalJson(members[name]) };
  const pkg = {
    'manifest.json': {
      package_version: PACKAGE_VERSION, receipt_hash: canonical.receipt_hash, receipt_version: canonical.receipt_version,
      receipt_type: canonical.receipt_type, package_status: 'verified', members: memberDigests,
      verification_gate: { recomputed_hash: verification.recomputed_hash, hash_valid: true, schema_valid: true, consistency_valid: true, pass: true, rule_violation_count: 0 },
      input_commitment: commitment, package_digest: '0'.repeat(64),
    },
    ...members,
  };
  pkg['manifest.json'].package_digest = computePackageDigest(pkg);
  validateReceiptPackageV1(pkg);
  return deepFreeze(pkg);
}
