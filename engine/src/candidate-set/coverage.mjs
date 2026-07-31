import { assertPlainJsonValue, cloneAndFreeze } from './plain-data.mjs';
import { fail } from './errors.mjs';
import {
  COVERAGE_VERSION,
  validateBoundaryV1,
  validateCoverageV1,
  validateInputStatusV1,
} from './schema.mjs';
import { computeCoverageDigest } from './identity.mjs';
import { canonicalJson } from './serialize.mjs';

const DISPOSITION_COUNT_FIELDS = Object.freeze({
  supported_normalized_event: 'supported_transaction_count',
  unsupported_activity: 'unsupported_transaction_count',
  ambiguous_activity: 'ambiguous_transaction_count',
  unrelated_activity: 'unrelated_transaction_count',
  failed_transaction: 'failed_transaction_count',
});

function nullableBounds(values) {
  let oldest = null;
  let newest = null;
  for (const value of values) {
    if (value === null) continue;
    if (oldest === null || value < oldest) oldest = value;
    if (newest === null || value > newest) newest = value;
  }
  return [oldest, newest];
}

export function recomputeCoverageV1(input) {
  assertPlainJsonValue(input, ['coverage_recomputation']);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('coverage_count_mismatch', 'coverage recomputation input is invalid');
  const expectedFields = ['transactionDispositions','normalizedEventRecords','activityFindings','boundary','inputStatus','paginationTerminalReason'];
  const keys = Object.keys(input);
  if (keys.some(key => !expectedFields.includes(key)) || expectedFields.some(key => !Object.hasOwn(input, key))) fail('coverage_count_mismatch', 'coverage recomputation fields are invalid');
  const { transactionDispositions, normalizedEventRecords, activityFindings, boundary, inputStatus, paginationTerminalReason } = input;
  if (!Array.isArray(transactionDispositions) || !Array.isArray(normalizedEventRecords) || !Array.isArray(activityFindings)) fail('coverage_count_mismatch', 'coverage members must be arrays');
  validateBoundaryV1(boundary);
  validateInputStatusV1(inputStatus);
  if (!['historical_bound_reached', 'provider_exhaustion'].includes(paginationTerminalReason)) fail('pagination_terminal_ambiguous', 'pagination terminal reason is not complete');

  const counts = Object.fromEntries(Object.values(DISPOSITION_COUNT_FIELDS).map(field => [field, 0]));
  for (const disposition of transactionDispositions) {
    const field = DISPOSITION_COUNT_FIELDS[disposition.disposition_type];
    if (!field) fail('unsupported_disposition_type', 'transaction disposition type is unsupported');
    counts[field] += 1;
    if (!Number.isSafeInteger(disposition.slot) || disposition.slot < 0 || disposition.slot > boundary.anchor_slot) fail('event_after_anchor_boundary', 'source transaction lies after the finalized boundary');
  }
  if (counts.supported_transaction_count !== normalizedEventRecords.length) fail('coverage_count_mismatch', 'supported transaction and normalized event counts differ');

  const [oldestObservedTimestamp, newestObservedTimestamp] = nullableBounds(transactionDispositions.map(item => item.block_time));
  const [oldestObservedSlot, newestObservedSlot] = nullableBounds(transactionDispositions.map(item => item.slot));
  const localizedFindingCount = activityFindings.filter(item => item.impact_scope === 'token_specific').length;
  const walletWideFindingCount = activityFindings.filter(item => item.impact_scope === 'wallet_wide').length;
  if (localizedFindingCount + walletWideFindingCount !== activityFindings.length) fail('coverage_count_mismatch', 'finding impact scopes are incomplete');

  const body = {
    coverage_version: COVERAGE_VERSION,
    coverage_status: 'complete',
    transactions_examined: transactionDispositions.length,
    ...counts,
    normalized_event_count: normalizedEventRecords.length,
    finding_count: activityFindings.length,
    localized_finding_count: localizedFindingCount,
    wallet_wide_finding_count: walletWideFindingCount,
    oldest_observed_timestamp: oldestObservedTimestamp,
    newest_observed_timestamp: newestObservedTimestamp,
    oldest_observed_slot: oldestObservedSlot,
    newest_observed_slot: newestObservedSlot,
    pagination_terminal_reason: paginationTerminalReason,
  };
  const coverage = cloneAndFreeze({ ...body, coverage_digest: computeCoverageDigest(body) });
  validateCoverageV1(coverage);
  return coverage;
}

export function validateRecomputedCoverageV1(coverage, inputs) {
  validateCoverageV1(coverage);
  const recomputed = recomputeCoverageV1(inputs);
  if (canonicalJson(coverage) !== canonicalJson(recomputed)) fail('coverage_count_mismatch', 'caller-supplied coverage does not equal recomputed coverage');
  return true;
}
