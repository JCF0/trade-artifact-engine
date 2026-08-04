#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildWalletAcquisitionResultV1, validateWalletAcquisitionResultV1 } from './acquisition-result.mjs';
import { recomputeCoverageV1 } from './coverage.mjs';
import { buildActivityFindingV1 } from './activity-findings.mjs';
import { buildDispositionV1 } from './identity.mjs';
import { GENESIS_HASH } from './schema.mjs';
import { sha256CanonicalJson } from './serialize.mjs';

const coverageBody = {
  coverage_version: 'wallet_candidate_coverage_v1', coverage_status: 'complete', transactions_examined: 0,
  supported_transaction_count: 0, unsupported_transaction_count: 0, ambiguous_transaction_count: 0,
  unrelated_transaction_count: 0, failed_transaction_count: 0, normalized_event_count: 0,
  finding_count: 0, localized_finding_count: 0, wallet_wide_finding_count: 0,
  oldest_observed_timestamp: null, newest_observed_timestamp: null, oldest_observed_slot: null,
  newest_observed_slot: null, pagination_terminal_reason: 'provider_exhaustion',
};
const coverage = { ...coverageBody, coverage_digest: sha256CanonicalJson({ coverage_identity_version: 'wallet_candidate_coverage_identity_v1', coverage: coverageBody }) };
const input = {
  acquisition_result_version: 'wallet_wide_acquisition_result_v1',
  scope: { scope_version: 'wallet_candidate_scope_input_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, wallet: 'wallet', window: { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1', requested_lookback_seconds: 2592000, initial_before_signature: null, lower_bound: { oldest_allowed_timestamp: 1, completion_status: 'proven' } } },
  profiles: { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1', reconstruction_engine_version: 'artifact_position_ledger_receipt_v1', accounting_method_version: 'weighted_average_position_accounting_v1', mark_profile: null, mark_max_age_seconds: null },
  boundary: { boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, commitment: 'finalized', anchor_slot: 100, anchor_block_time: 2592001, anchor_blockhash: 'blockhash', history_complete_through_anchor: true, lower_bound_completion_proven: true, boundary_status: 'proven' },
  input_status: { coverage_status: 'complete', acquisition_complete: true, normalization_complete: true, classification_complete: true, pagination_complete: true, historical_bound_proven: true, chain_boundary_proven: true, truncated: false, capped: false, partial: false, provider_uncertain: false },
  coverage, transaction_dispositions: [], normalized_event_records: [], activity_findings: [],
};
const result = buildWalletAcquisitionResultV1(input);
assert.deepEqual(result, input); assert.ok(Object.isFrozen(result) && Object.isFrozen(result.scope.window));
input.scope.wallet = 'mutated'; assert.equal(result.scope.wallet, 'wallet');
assert.doesNotThrow(() => validateWalletAcquisitionResultV1(result));
for (const [lookback_profile, requested_lookback_seconds] of Object.entries({
  lookback_7d_v1: 604800,
  lookback_30d_v1: 2592000,
  lookback_90d_v1: 7776000,
  lookback_180d_v1: 15552000,
})) {
  const permitted = structuredClone(result);
  permitted.scope.window.lookback_profile = lookback_profile;
  permitted.scope.window.requested_lookback_seconds = requested_lookback_seconds;
  permitted.boundary.anchor_block_time = requested_lookback_seconds + 1;
  assert.doesNotThrow(() => validateWalletAcquisitionResultV1(permitted));
}
const cursor = structuredClone(result); cursor.scope.window.initial_before_signature = 'sig';
assert.throws(() => validateWalletAcquisitionResultV1(cursor), error => error.code === 'non_null_latest_state_cursor');
const unknown = structuredClone(result); unknown.extra = true;
assert.throws(() => validateWalletAcquisitionResultV1(unknown), error => error.code === 'unknown_field');
let accessorCalls = 0; const hostile = structuredClone(result);
Object.defineProperty(hostile, 'acquisition_result_version', { enumerable: true, get() { accessorCalls += 1; return 'wallet_wide_acquisition_result_v1'; } });
assert.throws(() => validateWalletAcquisitionResultV1(hostile), error => error.code === 'accessor_not_allowed'); assert.equal(accessorCalls, 0);

const unsupportedLookback = structuredClone(result); unsupportedLookback.scope.window.lookback_profile = 'lookback_custom_v1';
assert.throws(() => validateWalletAcquisitionResultV1(unsupportedLookback), error => error.code === 'unsupported_lookback_profile');
const secondsMismatch = structuredClone(result); secondsMismatch.scope.window.requested_lookback_seconds = 604800;
assert.throws(() => validateWalletAcquisitionResultV1(secondsMismatch), error => error.code === 'lookback_boundary_mismatch');
const durationMismatch = structuredClone(result); durationMismatch.scope.window.lower_bound.oldest_allowed_timestamp = 2;
assert.throws(() => validateWalletAcquisitionResultV1(durationMismatch), error => error.code === 'lookback_boundary_mismatch');
const markProfile = structuredClone(result); markProfile.profiles.mark_profile = 'direct_quote_mark_v1'; markProfile.profiles.mark_max_age_seconds = 300;
assert.throws(() => validateWalletAcquisitionResultV1(markProfile), error => error.code === 'unsupported_profile');
const markAge = structuredClone(result); markAge.profiles.mark_max_age_seconds = 300;
assert.throws(() => validateWalletAcquisitionResultV1(markAge), error => error.code === 'unsupported_profile');
const markObservations = structuredClone(result); markObservations.mark_observations = [];
assert.throws(() => validateWalletAcquisitionResultV1(markObservations), error => error.code === 'unknown_field');

for (const attack of [
  { capped: true },
  { truncated: true },
  { partial: true },
  { provider_uncertain: true },
  { pagination_complete: false },
]) {
  const incomplete = structuredClone(result);
  Object.assign(incomplete.input_status, attack);
  assert.throws(() => validateWalletAcquisitionResultV1(incomplete), error => error.code === 'incomplete_acquisition_input');
}
const invalidTerminal = structuredClone(result);
const invalidCoverageBody = { ...invalidTerminal.coverage, pagination_terminal_reason: 'page_cap_reached' };
delete invalidCoverageBody.coverage_digest;
invalidTerminal.coverage = {
  ...invalidCoverageBody,
  coverage_digest: sha256CanonicalJson({ coverage_identity_version: 'wallet_candidate_coverage_identity_v1', coverage: invalidCoverageBody }),
};
assert.throws(() => validateWalletAcquisitionResultV1(invalidTerminal), error => error.code === 'invalid_field');

function withFailedSource({ slot, block_time }) {
  const value = structuredClone(result);
  value.transaction_dispositions = [buildDispositionV1({
    tx_hash: `failed-${slot}-${String(block_time)}`,
    slot,
    block_time,
    disposition_type: 'failed_transaction',
    affected_token_mints: [],
    normalized_event_digests: [],
    finding_digests: [],
  })];
  value.coverage = recomputeCoverageV1({
    transactionDispositions: value.transaction_dispositions,
    normalizedEventRecords: [],
    activityFindings: [],
    boundary: value.boundary,
    inputStatus: value.input_status,
    paginationTerminalReason: 'historical_bound_reached',
  });
  return value;
}

function withFinding({
  findingType = 'unsupported_activity',
  dispositionType = findingType,
  sourceEventDigests = [],
  timeRange = { first_observed_at: 100, last_observed_at: 100, first_observed_slot: 50, last_observed_slot: 50 },
} = {}) {
  const value = structuredClone(result);
  const sourceReference = { tx_hash: 'finding-source', slot: 50, block_time: 100 };
  const sourceDigest = sha256CanonicalJson({ source_transaction_reference_version: 'source_transaction_reference_v1', source_transaction: sourceReference });
  const finding = buildActivityFindingV1({
    finding_type: findingType,
    severity: 'candidate_blocking',
    impact_scope: 'token_specific',
    time_range: timeRange,
    affected_token_mints: ['Mint111111111111111111111111111111111111'],
    affected_quote_mints: [],
    source_transaction_digests: [sourceDigest],
    source_event_digests: sourceEventDigests,
    reason_codes: [findingType === 'unsupported_activity' ? 'unsupported_swap_shape' : 'ambiguous_swap_direction'],
    impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
    disclosure_codes: [],
  });
  value.activity_findings = [finding];
  value.transaction_dispositions = [buildDispositionV1({
    ...sourceReference,
    disposition_type: dispositionType,
    affected_token_mints: ['Mint111111111111111111111111111111111111'],
    normalized_event_digests: [],
    finding_digests: [finding.finding_digest],
  })];
  value.coverage = recomputeCoverageV1({
    transactionDispositions: value.transaction_dispositions,
    normalizedEventRecords: [],
    activityFindings: value.activity_findings,
    boundary: value.boundary,
    inputStatus: value.input_status,
    paginationTerminalReason: 'historical_bound_reached',
  });
  return value;
}

assert.doesNotThrow(() => validateWalletAcquisitionResultV1(withFailedSource({ slot: 100, block_time: 2592001 })));
assert.doesNotThrow(() => validateWalletAcquisitionResultV1(withFailedSource({ slot: 1, block_time: 1 })));
assert.throws(() => validateWalletAcquisitionResultV1(withFailedSource({ slot: 101, block_time: 2592001 })), error => error.code === 'event_after_anchor_boundary');
assert.throws(() => validateWalletAcquisitionResultV1(withFailedSource({ slot: 100, block_time: 2592002 })), error => error.code === 'event_after_anchor_boundary');
assert.throws(() => validateWalletAcquisitionResultV1(withFailedSource({ slot: 1, block_time: 0 })), error => error.code === 'lookback_boundary_mismatch');
assert.throws(() => validateWalletAcquisitionResultV1(withFailedSource({ slot: 1, block_time: null })), error => error.code === 'incomplete_acquisition_input');

const actualCoverage = withFailedSource({ slot: 50, block_time: 100 });
for (const [field, forgedValue] of [
  ['oldest_observed_timestamp', 99],
  ['newest_observed_timestamp', 101],
  ['oldest_observed_slot', 49],
  ['newest_observed_slot', 51],
]) {
  const forged = structuredClone(actualCoverage);
  const coverageWithoutDigest = { ...forged.coverage, [field]: forgedValue };
  delete coverageWithoutDigest.coverage_digest;
  forged.coverage = {
    ...coverageWithoutDigest,
    coverage_digest: sha256CanonicalJson({ coverage_identity_version: 'wallet_candidate_coverage_identity_v1', coverage: coverageWithoutDigest }),
  };
  assert.throws(() => validateWalletAcquisitionResultV1(forged), error => error.code === 'coverage_count_mismatch');
}
assert.doesNotThrow(() => validateWalletAcquisitionResultV1(withFinding()));
assert.throws(() => validateWalletAcquisitionResultV1(withFinding({ sourceEventDigests: ['a'.repeat(64)] })), error => error.code === 'finding_disposition_mismatch');
assert.throws(() => validateWalletAcquisitionResultV1(withFinding({ timeRange: { first_observed_at: 99, last_observed_at: 100, first_observed_slot: 50, last_observed_slot: 50 } })), error => error.code === 'finding_disposition_mismatch');
assert.throws(() => validateWalletAcquisitionResultV1(withFinding({ findingType: 'ambiguous_activity', dispositionType: 'unsupported_activity' })), error => error.code === 'finding_disposition_mismatch');
console.log('candidate-set acquisition result: PASS');
