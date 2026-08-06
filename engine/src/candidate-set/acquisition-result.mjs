import { cloneAndFreeze, assertPlainJsonValue } from './plain-data.mjs';
import { fail } from './errors.mjs';
import {
  ACQUISITION_RESULT_VERSION, SOURCE_TRANSACTION_REFERENCE_VERSION, validateScopeInputV1, validateProfilesV1, validateBoundaryV1,
  validateInputStatusV1, validateCoverageV1, validateDispositionV1, validateEventRecordV1,
  validateFindingV1, validateWalletAcquisitionScopeBoundaryV1,
} from './schema.mjs';
import { sha256CanonicalJson } from './serialize.mjs';
import { validateRecomputedCoverageV1 } from './coverage.mjs';
import { compareActivityFindingsV1, validateActivityFindingsV1 } from './activity-findings.mjs';
import { validateDispositionAccountingV1 } from './dispositions.mjs';

function computeSourceTransactionDigest(reference) { return sha256CanonicalJson({ source_transaction_reference_version: SOURCE_TRANSACTION_REFERENCE_VERSION, source_transaction: reference }); }

const FIELDS = ['acquisition_result_version','scope','profiles','boundary','input_status','coverage','transaction_dispositions','normalized_event_records','activity_findings'];
function exact(value, fields, context) {
  assertPlainJsonValue(value, [context]);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_object', `${context} must be an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail('unknown_field', `${context} contains unknown field`, { context, field: key });
  for (const key of fields) if (!Object.hasOwn(value, key)) fail('missing_field', `${context} is missing field`, { context, field: key });
}
function unique(values, code) { if (new Set(values).size !== values.length) fail(code, 'authoritative identities must be unique'); }

export function validateWalletAcquisitionResultV1(result) {
  exact(result, FIELDS, 'acquisition_result');
  if (result.acquisition_result_version !== ACQUISITION_RESULT_VERSION) fail('unsupported_version', `acquisition_result_version must be ${ACQUISITION_RESULT_VERSION}`);
  validateScopeInputV1(result.scope); validateProfilesV1(result.profiles); validateBoundaryV1(result.boundary); validateInputStatusV1(result.input_status); validateCoverageV1(result.coverage);
  validateWalletAcquisitionScopeBoundaryV1(result.scope, result.boundary);
  if (result.profiles.mark_profile !== null || result.profiles.mark_max_age_seconds !== null) fail('unsupported_profile', 'wallet acquisition results do not carry marks');
  for (const field of ['transaction_dispositions','normalized_event_records','activity_findings']) if (!Array.isArray(result[field])) fail('invalid_field', `${field} must be an array`);
  result.transaction_dispositions.forEach(validateDispositionV1); result.normalized_event_records.forEach(validateEventRecordV1); result.activity_findings.forEach(validateFindingV1);
  unique(result.transaction_dispositions.map(item => item.tx_hash), 'duplicate_transaction_disposition');
  unique(result.transaction_dispositions.map(item => item.disposition_digest), 'duplicate_transaction_disposition');
  unique(result.normalized_event_records.map(item => item.event_digest), 'duplicate_normalized_event');
  unique(result.activity_findings.map(item => item.finding_digest), 'duplicate_activity_finding');
  validateDispositionAccountingV1({
    transactionDispositions: result.transaction_dispositions,
    normalizedEventRecords: result.normalized_event_records,
    activityFindings: result.activity_findings,
    wallet: result.scope.wallet,
    anchorSlot: result.boundary.anchor_slot,
  });
  const eventByDigest = new Map(result.normalized_event_records.map(item => [item.event_digest, item]));
  const eventDigests = new Set(eventByDigest.keys());
  const sourceDigests = new Set(result.transaction_dispositions.map(item => computeSourceTransactionDigest({ tx_hash: item.tx_hash, slot: item.slot, block_time: item.block_time })));
  const sourceByDigest = new Map(result.transaction_dispositions.map(item => [computeSourceTransactionDigest({ tx_hash: item.tx_hash, slot: item.slot, block_time: item.block_time }), item]));
  const findingByDigest = new Map(result.activity_findings.map(item => [item.finding_digest, item]));
  for (const disposition of result.transaction_dispositions) {
    if (disposition.slot > result.boundary.anchor_slot) fail('event_after_anchor_boundary', 'disposition is after anchor');
    if (disposition.block_time === null) fail('incomplete_acquisition_input', 'wallet acquisition source block time is required');
    if (disposition.block_time > result.boundary.anchor_block_time) fail('event_after_anchor_boundary', 'disposition is after anchor');
    if (disposition.block_time < result.scope.window.lower_bound.oldest_allowed_timestamp) fail('lookback_boundary_mismatch', 'disposition is before the requested lookback window');
    for (const digest of disposition.normalized_event_digests) {
      const event = eventByDigest.get(digest); if (!event) fail('event_disposition_mismatch', 'disposition references an unknown event');
      if (event.slice7_event.tx_hash !== disposition.tx_hash || event.source_slot !== disposition.slot || (disposition.block_time !== null && event.slice7_event.timestamp !== disposition.block_time)) fail('event_source_mismatch', 'event source does not match its disposition');
    }
    for (const digest of disposition.finding_digests) {
      const finding = findingByDigest.get(digest);
      if (!finding) fail('finding_disposition_mismatch', 'disposition references an unknown finding');
      if (finding.finding_type !== disposition.disposition_type) fail('finding_disposition_mismatch', 'finding type does not match its disposition');
    }
  }
  for (const event of result.normalized_event_records) {
    if (event.source_slot > result.boundary.anchor_slot || event.slice7_event.wallet !== result.scope.wallet) fail('event_after_anchor_boundary', 'event is outside scope');
    const references = result.transaction_dispositions.filter(item => item.normalized_event_digests.includes(event.event_digest));
    if (references.length !== 1) fail('event_disposition_mismatch', 'event must be referenced exactly once');
  }
  for (const finding of result.activity_findings) {
    for (const digest of finding.source_transaction_digests) if (!sourceDigests.has(digest)) fail('finding_disposition_mismatch', 'finding references an unknown source transaction');
    const references = result.transaction_dispositions.filter(item => item.finding_digests.includes(finding.finding_digest));
    if (references.length < 1) fail('finding_disposition_mismatch', 'finding must be referenced by a disposition');
    if (finding.impact_scope === 'wallet_wide') fail('wallet_wide_impact_unresolved', 'wallet-wide findings prevent candidate-set evidence');
    const sources = finding.source_transaction_digests.map(digest => sourceByDigest.get(digest));
    const timestamps = sources.map(source => source.block_time);
    const slots = sources.map(source => source.slot);
    if (finding.time_range.first_observed_at !== Math.min(...timestamps)
        || finding.time_range.last_observed_at !== Math.max(...timestamps)
        || finding.time_range.first_observed_slot !== Math.min(...slots)
        || finding.time_range.last_observed_slot !== Math.max(...slots)) fail('finding_disposition_mismatch', 'finding range does not match its source transactions');
  }
  validateActivityFindingsV1([...result.activity_findings].sort(compareActivityFindingsV1), { sourceTransactionDigests: [...sourceDigests], sourceEventDigests: [...eventDigests], allowWalletWide: false });
  validateRecomputedCoverageV1(result.coverage, {
    transactionDispositions: result.transaction_dispositions,
    normalizedEventRecords: result.normalized_event_records,
    activityFindings: result.activity_findings,
    boundary: result.boundary,
    inputStatus: result.input_status,
    paginationTerminalReason: result.coverage.pagination_terminal_reason,
  });
  const c = result.coverage;
  if (c.transactions_examined !== result.transaction_dispositions.length || c.normalized_event_count !== result.normalized_event_records.length || c.finding_count !== result.activity_findings.length) fail('coverage_count_mismatch', 'coverage does not match result arrays');
  const dispositionCounts = Object.fromEntries(['supported_normalized_event','unsupported_activity','ambiguous_activity','unrelated_activity','failed_transaction'].map(type => [type, result.transaction_dispositions.filter(x => x.disposition_type === type).length]));
  if (c.supported_transaction_count !== dispositionCounts.supported_normalized_event || c.unsupported_transaction_count !== dispositionCounts.unsupported_activity || c.ambiguous_transaction_count !== dispositionCounts.ambiguous_activity || c.unrelated_transaction_count !== dispositionCounts.unrelated_activity || c.failed_transaction_count !== dispositionCounts.failed_transaction) fail('coverage_count_mismatch', 'coverage disposition partition does not match result');
  return true;
}
export function buildWalletAcquisitionResultV1(input) {
  const result = cloneAndFreeze(input); validateWalletAcquisitionResultV1(result); return result;
}
export const buildAcquisitionResultV1 = buildWalletAcquisitionResultV1;
export const validateAcquisitionResultV1 = validateWalletAcquisitionResultV1;
