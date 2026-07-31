import { cloneAndFreeze, clonePlainData, assertPlainJsonValue } from './plain-data.mjs';
import { fail } from './errors.mjs';
import {
  SOURCE_TRANSACTION_REFERENCE_VERSION, EVIDENCE_BUNDLE_VERSION, FINDING_VERSION, FINDING_IDENTITY_VERSION,
  DISPOSITION_VERSION, EVENT_RECORD_VERSION, MARK_OBSERVATION_VERSION,
  CANDIDATE_VERSION, CANDIDATE_IDENTITY_VERSION, BLOCKED_SUMMARY_VERSION, CANDIDATE_SET_VERSION,
  validateSourceTransactionReferenceV1, validateEvidenceBundleV1, validateFindingV1,
  validateDispositionV1, validateEventRecordV1, validateMarkObservationV1,
  validateBlockedSummaryV1, validateCandidateV1, validateCandidateSetV1,
} from './schema.mjs';
import { sha256CanonicalJson } from './serialize.mjs';

function exactInput(input, fields, context) {
  assertPlainJsonValue(input, [context]);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('invalid_object', `${context} must be an object`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.getOwnPropertySymbols(input).length) fail('symbol_key_not_allowed', `${context} contains a symbol`);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('accessor_not_allowed', `${context} contains a non-data field`);
    if (!fields.includes(key)) fail('unknown_field', `${context} contains unknown field`, { context, field: key });
  }
  for (const key of fields) if (!Object.hasOwn(descriptors, key)) fail('missing_field', `${context} is missing field`, { context, field: key });
}
function without(value, omitted) {
  const copy = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) if (!omitted.includes(key)) Object.defineProperty(copy, key, { value: clonePlainData(descriptor.value), enumerable: true, writable: true, configurable: true });
  return cloneAndFreeze(copy);
}
function buildAddressed(input, versionField, version, idField, prefix, digestField, validator) {
  const body = clonePlainData({ [versionField]: version, ...input });
  const digest = sha256CanonicalJson(body);
  const result = { [versionField]: version, [idField]: `${prefix}${digest}`, [digestField]: digest, ...input };
  validator(result); return cloneAndFreeze(result);
}

export function buildSourceTransactionReferenceV1(input) { validateSourceTransactionReferenceV1(input); return cloneAndFreeze(input); }
export function sourceTransactionDigestPreimage(reference) { validateSourceTransactionReferenceV1(reference); return cloneAndFreeze({ source_transaction_reference_version: SOURCE_TRANSACTION_REFERENCE_VERSION, source_transaction: reference }); }
export function computeSourceTransactionDigest(reference) { return sha256CanonicalJson(sourceTransactionDigestPreimage(reference)); }
export const sourceTransactionReferenceDigestPreimage = sourceTransactionDigestPreimage;
export const computeSourceTransactionReferenceDigest = computeSourceTransactionDigest;

export function findingDigestPreimage(value) {
  assertPlainJsonValue(value);
  const preimage = { finding_identity_version: FINDING_IDENTITY_VERSION };
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!['finding_version','finding_id','finding_digest'].includes(key)) Object.defineProperty(preimage, key, { value: clonePlainData(descriptor.value), enumerable: true, writable: true, configurable: true });
  }
  return cloneAndFreeze(preimage);
}
export function computeFindingDigest(value) { return sha256CanonicalJson(findingDigestPreimage(value)); }
export function buildFindingV1(input) {
  const fields = ['finding_type','severity','impact_scope','time_range','affected_token_mints','affected_quote_mints','source_transaction_digests','source_event_digests','reason_codes','impact','disclosure_codes']; exactInput(input, fields, 'finding input');
  const digest = sha256CanonicalJson(findingDigestPreimage(input));
  const result = cloneAndFreeze({ finding_version: FINDING_VERSION, finding_id: `aaf1_${digest}`, finding_digest: digest, ...input });
  validateFindingV1(result); return result;
}
export function dispositionDigestPreimage(value) { return without(value, ['disposition_id','disposition_digest']); }
export function computeDispositionDigest(value) { return sha256CanonicalJson(dispositionDigestPreimage(value)); }
export function buildDispositionV1(input) {
  const fields = ['tx_hash','slot','block_time','disposition_type','affected_token_mints','normalized_event_digests','finding_digests']; exactInput(input, fields, 'disposition input');
  return buildAddressed(input, 'disposition_version', DISPOSITION_VERSION, 'disposition_id', 'awd1_', 'disposition_digest', validateDispositionV1);
}
export function eventRecordDigestPreimage(value) { return without(value, ['event_record_id','event_digest']); }
export function computeEventRecordDigest(value) { return sha256CanonicalJson(eventRecordDigestPreimage(value)); }
export function buildEventRecordV1(input) { exactInput(input, ['source_slot','slice7_event'], 'event record input'); return buildAddressed(input, 'event_record_version', EVENT_RECORD_VERSION, 'event_record_id', 'awer1_', 'event_digest', validateEventRecordV1); }
export function markObservationDigestPreimage(value) { return without(value, ['mark_observation_id','mark_observation_digest']); }
export function computeMarkObservationDigest(value) { return sha256CanonicalJson(markObservationDigestPreimage(value)); }
export function buildMarkObservationV1(input) {
  exactInput(input, ['token_mint','quote_mint','observation_status','source_profile','mark_price_raw_quote','observed_at','source_slot','reason_code'], 'mark input');
  return buildAddressed(input, 'mark_observation_version', MARK_OBSERVATION_VERSION, 'mark_observation_id', 'amo1_', 'mark_observation_digest', validateMarkObservationV1);
}
export function blockedSummaryDigestPreimage(value) { return without(value, ['blocked_summary_id','blocked_summary_digest']); }
export function computeBlockedSummaryDigest(value) { return sha256CanonicalJson(blockedSummaryDigestPreimage(value)); }
export function buildBlockedSummaryV1(input) {
  const fields = ['chain','network','wallet','token_mint','position_status','ledger_evidence_status','boundary_status','valuation_status','selection_status','package_eligibility','economics_status','associated_finding_digests','reason_codes','disclosure_codes']; exactInput(input, fields, 'blocked summary input');
  return buildAddressed(input, 'blocked_summary_version', BLOCKED_SUMMARY_VERSION, 'blocked_summary_id', 'abs1_', 'blocked_summary_digest', validateBlockedSummaryV1);
}

export function computeDigestIndex(indexVersion, digests) { return sha256CanonicalJson({ index_version: indexVersion, digests }); }
export function coverageDigestPreimage(coverageWithoutDigest) { return cloneAndFreeze({ coverage_identity_version: 'wallet_candidate_coverage_identity_v1', coverage: coverageWithoutDigest }); }
export function computeCoverageDigest(coverageWithoutDigest) { return sha256CanonicalJson(coverageDigestPreimage(coverageWithoutDigest)); }
export function windowDigestPreimage(input) { return cloneAndFreeze({ window_identity_version: 'wallet_candidate_window_identity_v1', ...input }); }
export function computeWindowDigest(input) { return sha256CanonicalJson(windowDigestPreimage(input)); }
export function scopeDigestPreimage(input) { return cloneAndFreeze({ scope_identity_version: 'wallet_candidate_scope_identity_v1', ...input }); }
export function computeScopeDigest(input) { return sha256CanonicalJson(scopeDigestPreimage(input)); }
export function receiptScopedEvidenceDigestPreimage(input) { return cloneAndFreeze({ receipt_scoped_evidence_version: 'wallet_candidate_selection_projection_v1', ...input }); }
export function computeReceiptScopedEvidenceDigest(input) { return sha256CanonicalJson(receiptScopedEvidenceDigestPreimage(input)); }

export function evidenceBundleDigestPreimage(bundleOrPayload) { return cloneAndFreeze(Object.hasOwn(bundleOrPayload, 'payload') ? bundleOrPayload.payload : bundleOrPayload); }
export function computeEvidenceBundleDigest(value) { return sha256CanonicalJson(evidenceBundleDigestPreimage(value)); }
export function buildEvidenceBundleV1(input) {
  exactInput(input, ['scope','profiles','boundary','input_status','coverage','transaction_dispositions','normalized_event_records','activity_findings','mark_observations'], 'evidence bundle input');
  const integrity = {
    transaction_dispositions_digest: computeDigestIndex('wallet_transaction_disposition_index_v1', input.transaction_dispositions.map(item => item.disposition_digest)),
    normalized_events_digest: computeDigestIndex('wallet_normalized_event_index_v1', input.normalized_event_records.map(item => item.event_digest)),
    activity_findings_digest: computeDigestIndex('wallet_activity_finding_index_v1', input.activity_findings.map(item => item.finding_digest)),
    mark_observations_digest: computeDigestIndex('wallet_mark_observation_index_v1', input.mark_observations.map(item => item.mark_observation_digest)),
    transaction_disposition_count: input.transaction_dispositions.length,
    normalized_event_count: input.normalized_event_records.length,
    activity_finding_count: input.activity_findings.length,
    mark_observation_count: input.mark_observations.length,
  };
  const payload = cloneAndFreeze({ ...input, integrity });
  const result = cloneAndFreeze({ evidence_bundle_version: EVIDENCE_BUNDLE_VERSION, evidence_bundle_digest: sha256CanonicalJson(payload), payload });
  validateEvidenceBundleV1(result); return result;
}

export function candidateDigestPreimage(value) {
  return cloneAndFreeze({ candidate_identity_version: value.candidate_identity_version, receipt_scoped_evidence_digest: value.receipt_scoped_evidence_digest, ledger_candidate_hash: value.ledger_candidate_hash, projection: value.projection });
}
export function computeCandidateDigest(value) { return sha256CanonicalJson(candidateDigestPreimage(value)); }
export function buildCandidateV1(input) {
  exactInput(input, ['ledger_candidate_hash','receipt_scoped_evidence_digest','selection_key','projection'], 'candidate input');
  const semantic = clonePlainData({ candidate_identity_version: CANDIDATE_IDENTITY_VERSION, receipt_scoped_evidence_digest: input.receipt_scoped_evidence_digest, ledger_candidate_hash: input.ledger_candidate_hash, projection: input.projection });
  const digest = sha256CanonicalJson(semantic);
  const result = cloneAndFreeze({ candidate_version: CANDIDATE_VERSION, candidate_identity_version: CANDIDATE_IDENTITY_VERSION, candidate_id: `acv1_${digest}`, candidate_digest: digest, ledger_candidate_hash: input.ledger_candidate_hash, receipt_scoped_evidence_digest: input.receipt_scoped_evidence_digest, selection_key: input.selection_key, projection: input.projection, handoff: { handoff_version: 'candidate_selection_handoff_v1', candidate_digest: digest, receipt_scoped_evidence_digest: input.receipt_scoped_evidence_digest, ledger_candidate_hash: input.ledger_candidate_hash } });
  validateCandidateV1(result); return result;
}
export function candidateSetDigestPreimage(value) { return cloneAndFreeze(Object.hasOwn(value, 'payload') ? value.payload : value); }
export function computeCandidateSetDigest(value) { return sha256CanonicalJson(candidateSetDigestPreimage(value)); }
export function buildCandidateSetV1(payload) {
  const detached = cloneAndFreeze(payload); const result = cloneAndFreeze({ candidate_set_version: CANDIDATE_SET_VERSION, candidate_set_digest: sha256CanonicalJson(detached), payload: detached }); validateCandidateSetV1(result); return result;
}
