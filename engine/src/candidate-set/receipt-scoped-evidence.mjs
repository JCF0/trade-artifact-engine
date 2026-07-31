import { fail } from './errors.mjs';
import { computeEventRecordDigest, computeReceiptScopedEvidenceDigest } from './identity.mjs';
import { compareCodeUnits } from './order.mjs';
import { assertPlainJsonValue, cloneAndFreeze, clonePlainData } from './plain-data.mjs';
import { canonicalJson } from './serialize.mjs';
import { EVENT_RECORD_VERSION, validateEventRecordV1, validateSlice7EventV1 } from './schema.mjs';

export const RECEIPT_SCOPED_EVIDENCE_VERSION = 'wallet_candidate_selection_projection_v1';

const FIELDS = Object.freeze([
  'receipt_scoped_evidence_version',
  'receipt_scoped_evidence_digest',
  'wallet',
  'token_mint',
  'source_event_digests',
  'source_event_references',
  'events',
]);
const EVENT_FIELDS = Object.freeze([
  'wallet','timestamp','tx_hash','source','token_in_mint','token_in_amount','token_in_decimals',
  'token_out_mint','token_out_amount','token_out_decimals','extraction_method','raw_index',
]);

const SOURCE_REFERENCE_FIELDS = Object.freeze(['event_digest','source_slot','source_raw_index']);

function assertExactObject(value, fields, code, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code, message);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) fail(code, message);
  for (const field of fields) if (!Object.hasOwn(value, field)) fail(code, message);
}

function digestInput(value) {
  return {
    wallet: value.wallet,
    token_mint: value.token_mint,
    source_event_digests: value.source_event_digests,
    source_event_references: value.source_event_references,
    events: value.events,
  };
}

function affectsToken(record, tokenMint) {
  const event = record.slice7_event;
  return event.token_in_mint === tokenMint || event.token_out_mint === tokenMint;
}

// Preserve the target-scoped acquisition and Slice 7 reconstruction order:
// timestamp, then transaction signature. Rich source coordinates only close ties.
export function compareReceiptScopedEventRecordsV1(left, right) {
  return left.slice7_event.timestamp - right.slice7_event.timestamp
    || compareCodeUnits(left.slice7_event.tx_hash, right.slice7_event.tx_hash)
    || left.source_slot - right.source_slot
    || compareCodeUnits(left.event_digest, right.event_digest);
}

export function validateReceiptScopedEvidenceV1(value) {
  assertPlainJsonValue(value, ['receipt_scoped_evidence']);
  assertExactObject(value, FIELDS, 'invalid_receipt_scoped_evidence', 'receipt-scoped evidence shape is invalid');
  if (value.receipt_scoped_evidence_version !== RECEIPT_SCOPED_EVIDENCE_VERSION) fail('unsupported_version', 'receipt-scoped evidence version is unsupported');
  if (typeof value.receipt_scoped_evidence_digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.receipt_scoped_evidence_digest)) fail('malformed_digest', 'receipt-scoped evidence digest is malformed');
  if (typeof value.wallet !== 'string' || value.wallet.length === 0 || typeof value.token_mint !== 'string' || value.token_mint.length === 0) fail('invalid_receipt_scoped_evidence', 'receipt-scoped evidence identity is invalid');
  if (!Array.isArray(value.source_event_digests) || !Array.isArray(value.source_event_references) || !Array.isArray(value.events) || value.events.length === 0 || value.source_event_digests.length !== value.events.length || value.source_event_references.length !== value.events.length) fail('invalid_receipt_scoped_evidence', 'receipt-scoped evidence arrays are invalid');
  if (new Set(value.source_event_digests).size !== value.source_event_digests.length) fail('duplicate_normalized_event', 'receipt-scoped evidence contains duplicate event references');
  for (let index = 0; index < value.events.length; index += 1) {
    const event = value.events[index];
    const reference = value.source_event_references[index];
    assertExactObject(event, EVENT_FIELDS, 'invalid_receipt_scoped_evidence', 'receipt-scoped event shape is invalid');
    validateSlice7EventV1(event);
    assertExactObject(reference, SOURCE_REFERENCE_FIELDS, 'invalid_receipt_scoped_evidence', 'receipt-scoped source reference shape is invalid');
    if (!/^[0-9a-f]{64}$/.test(value.source_event_digests[index]) || reference.event_digest !== value.source_event_digests[index]) fail('malformed_digest', 'receipt-scoped event reference is malformed or misbound');
    if (!Number.isSafeInteger(reference.source_slot) || reference.source_slot < 0 || !Number.isSafeInteger(reference.source_raw_index) || reference.source_raw_index < 0) fail('invalid_receipt_scoped_evidence', 'receipt-scoped source reference coordinates are invalid');
    if (event.wallet !== value.wallet || (event.token_in_mint !== value.token_mint && event.token_out_mint !== value.token_mint)) fail('candidate_evidence_scope_mismatch', 'receipt-scoped event does not match candidate scope');
    if (event.raw_index !== index) fail('event_index_mismatch', 'receipt-scoped raw indexes must be dense');
    const sourceEvent = { ...clonePlainData(event), raw_index: reference.source_raw_index };
    const recomputedEventDigest = computeEventRecordDigest({ event_record_version: EVENT_RECORD_VERSION, source_slot: reference.source_slot, slice7_event: sourceEvent });
    if (recomputedEventDigest !== reference.event_digest) fail('receipt_scoped_event_reference_mismatch', 'receipt-scoped source reference does not bind its event');
    if (index > 0) {
      const previousReference = value.source_event_references[index - 1];
      const previousEvent = { ...value.events[index - 1], raw_index: previousReference.source_raw_index };
      const previousRecord = { source_slot: previousReference.source_slot, event_digest: previousReference.event_digest, slice7_event: previousEvent };
      const currentRecord = { source_slot: reference.source_slot, event_digest: reference.event_digest, slice7_event: sourceEvent };
      if (compareReceiptScopedEventRecordsV1(previousRecord, currentRecord) >= 0) fail('receipt_scoped_event_order_mismatch', 'receipt-scoped events are not in canonical source order');
    }
  }
  const expected = computeReceiptScopedEvidenceDigest(digestInput(value));
  if (expected !== value.receipt_scoped_evidence_digest) fail('receipt_scoped_evidence_digest_mismatch', 'receipt-scoped evidence digest mismatch');
  return true;
}

export function buildReceiptScopedEvidenceV1(input) {
  assertPlainJsonValue(input, ['receipt_scoped_evidence_input']);
  assertExactObject(input, ['wallet','tokenMint','normalizedEventRecords'], 'invalid_receipt_scoped_evidence', 'receipt-scoped evidence input shape is invalid');
  if (typeof input.wallet !== 'string' || input.wallet.length === 0 || typeof input.tokenMint !== 'string' || input.tokenMint.length === 0 || !Array.isArray(input.normalizedEventRecords)) fail('invalid_receipt_scoped_evidence', 'receipt-scoped evidence input is invalid');
  const records = input.normalizedEventRecords.map(record => {
    validateEventRecordV1(record);
    return clonePlainData(record);
  });
  const scoped = records.filter(record => affectsToken(record, input.tokenMint));
  if (scoped.length === 0) fail('candidate_evidence_empty', 'candidate token has no supported normalized evidence');
  scoped.sort(compareReceiptScopedEventRecordsV1);
  for (let index = 1; index < scoped.length; index += 1) if (compareReceiptScopedEventRecordsV1(scoped[index - 1], scoped[index]) === 0) fail('duplicate_normalized_event', 'receipt-scoped evidence contains duplicate events');
  const body = {
    wallet: input.wallet,
    token_mint: input.tokenMint,
    source_event_digests: scoped.map(record => record.event_digest),
    source_event_references: scoped.map(record => ({ event_digest: record.event_digest, source_slot: record.source_slot, source_raw_index: record.slice7_event.raw_index })),
    events: scoped.map((record, rawIndex) => ({ ...clonePlainData(record.slice7_event), raw_index: rawIndex })),
  };
  const result = cloneAndFreeze({
    receipt_scoped_evidence_version: RECEIPT_SCOPED_EVIDENCE_VERSION,
    receipt_scoped_evidence_digest: computeReceiptScopedEvidenceDigest(body),
    ...body,
  });
  validateReceiptScopedEvidenceV1(result);
  return result;
}

export const buildReceiptScopedCandidateEvidenceV1 = buildReceiptScopedEvidenceV1;
export const validateReceiptScopedCandidateEvidenceV1 = validateReceiptScopedEvidenceV1;

export function receiptScopedEvidenceDigestInputV1(value) {
  validateReceiptScopedEvidenceV1(value);
  return cloneAndFreeze(digestInput(value));
}

export function receiptScopedEvidenceEqualV1(left, right) {
  validateReceiptScopedEvidenceV1(left);
  validateReceiptScopedEvidenceV1(right);
  return canonicalJson(left) === canonicalJson(right);
}
