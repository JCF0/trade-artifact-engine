#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildWalletAcquisitionResultV1 } from './acquisition-result.mjs';
import { buildDispositionV1, buildEventRecordV1, computeEvidenceBundleDigest } from './identity.mjs';
import { recomputeCoverageV1 } from './coverage.mjs';
import { buildMarkObservationV1 } from './mark-observations.mjs';
import { buildActivityFindingV1 } from './activity-findings.mjs';
import { buildCandidateEvidenceBundleV1, validateCandidateEvidenceBundleV1 } from './evidence-bundle.mjs';
import { canonicalJson } from './serialize.mjs';
import { GENESIS_HASH } from './schema.mjs';

const scope = { scope_version: 'wallet_candidate_scope_input_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, wallet: 'wallet', window: { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1', requested_lookback_seconds: 2592000, initial_before_signature: null, lower_bound: { oldest_allowed_timestamp: 1, completion_status: 'proven' } } };
const profiles = { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1', reconstruction_engine_version: 'artifact_position_ledger_receipt_v1', accounting_method_version: 'weighted_average_position_accounting_v1', mark_profile: 'direct_quote_mark_v1', mark_max_age_seconds: 300 };
const boundary = { boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, commitment: 'finalized', anchor_slot: 100, anchor_block_time: 2592001, anchor_blockhash: 'blockhash', history_complete_through_anchor: true, lower_bound_completion_proven: true, boundary_status: 'proven' };
const inputStatus = { coverage_status: 'complete', acquisition_complete: true, normalization_complete: true, classification_complete: true, pagination_complete: true, historical_bound_proven: true, chain_boundary_proven: true, truncated: false, capped: false, partial: false, provider_uncertain: false };
const event = buildEventRecordV1({ source_slot: 90, slice7_event: { wallet: 'wallet', timestamp: 900, tx_hash: 'tx', source: 'swap', token_in_mint: 'QUOTE', token_in_amount: 10, token_in_decimals: 6, token_out_mint: 'TOKEN', token_out_amount: 5, token_out_decimals: 6, extraction_method: 'balance_delta', raw_index: 0 } });
const disposition = buildDispositionV1({ tx_hash: 'tx', slot: 90, block_time: 900, disposition_type: 'supported_normalized_event', affected_token_mints: ['QUOTE', 'TOKEN'], normalized_event_digests: [event.event_digest], finding_digests: [] });
const coverageArgs = { transactionDispositions: [disposition], normalizedEventRecords: [event], activityFindings: [], boundary, inputStatus, paginationTerminalReason: 'historical_bound_reached' };
const acquisitionResult = buildWalletAcquisitionResultV1({ acquisition_result_version: 'wallet_wide_acquisition_result_v1', scope, profiles: { ...profiles, mark_profile: null, mark_max_age_seconds: null }, boundary, input_status: inputStatus, coverage: recomputeCoverageV1(coverageArgs), transaction_dispositions: [disposition], normalized_event_records: [event], activity_findings: [] });
const markInput = { token_mint: 'TOKEN', quote_mint: 'QUOTE', observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 2, observed_at: 2591951, source_slot: 95, reason_code: null };
const mark = buildMarkObservationV1(markInput);
const bundle = buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: [mark], profiles });
const canonicalFinding = buildActivityFindingV1({
  finding_type: 'unsupported_activity', severity: 'candidate_blocking', impact_scope: 'token_specific',
  time_range: { first_observed_at: 900, last_observed_at: 900, first_observed_slot: 90, last_observed_slot: 90 },
  affected_token_mints: ['TOKEN'], affected_quote_mints: ['QUOTE'], source_transaction_digests: ['a'.repeat(64)], source_event_digests: [],
  reason_codes: ['unsupported_swap_shape'], impact: { blocks_candidate_projection: true, blocks_receipt_publication: true }, disclosure_codes: ['activity_not_reconstructable'],
});
for (const findingType of ['partial_history_boundary', 'external_transfer_gap', 'unobserved_inventory', 'balance_boundary_mismatch', 'mark_source_limitation']) {
  const authoritative = structuredClone(bundle);
  const removed = structuredClone(canonicalFinding);
  removed.finding_type = findingType;
  authoritative.payload.activity_findings = [removed];
  assert.throws(() => validateCandidateEvidenceBundleV1(authoritative), error => error.code === 'invalid_field', `${findingType} must not enter an authoritative bundle`);
}
const acquisitionWithoutMarkProfile = buildWalletAcquisitionResultV1({ ...structuredClone(acquisitionResult), profiles: { ...profiles, mark_profile: null, mark_max_age_seconds: null } });
assert.doesNotThrow(() => buildCandidateEvidenceBundleV1({ acquisitionResult: acquisitionWithoutMarkProfile, markObservations: [mark], profiles }));
assert.doesNotThrow(() => validateCandidateEvidenceBundleV1(bundle));
const changedFreshnessPolicy = structuredClone(bundle.payload);
changedFreshnessPolicy.profiles.mark_max_age_seconds = 301;
assert.notEqual(computeEvidenceBundleDigest(changedFreshnessPolicy), bundle.evidence_bundle_digest);
assert.throws(() => buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: [mark], profiles: { ...profiles, mark_max_age_seconds: 301 } }), error => error.code === 'unsupported_profile');
assert.ok(Object.isFrozen(bundle) && Object.isFrozen(bundle.payload) && Object.isFrozen(bundle.payload.integrity) && Object.isFrozen(bundle.payload.mark_observations));
const before = canonicalJson(bundle);
markInput.mark_price_raw_quote = 99;
assert.equal(canonicalJson(bundle), before);
assert.equal(bundle.payload.coverage.transactions_examined, 1);
assert.equal(bundle.payload.integrity.transaction_disposition_count, 1);
const tamperedIndex = structuredClone(bundle);
tamperedIndex.payload.integrity.normalized_events_digest = 'f'.repeat(64);
assert.throws(() => validateCandidateEvidenceBundleV1(tamperedIndex), error => error.code === 'integrity_digest_mismatch');
const orphan = structuredClone(bundle);
orphan.payload.transaction_dispositions = [];
assert.throws(() => validateCandidateEvidenceBundleV1(orphan), error => ['event_disposition_mismatch', 'coverage_count_mismatch', 'integrity_count_mismatch'].includes(error.code));
const incomplete = structuredClone(acquisitionResult);
incomplete.input_status.pagination_complete = false;
assert.throws(() => buildCandidateEvidenceBundleV1({ acquisitionResult: incomplete, markObservations: [mark], profiles }), error => error.code === 'incomplete_acquisition_input');
let calls = 0;
const hostileMarks = [];
Object.defineProperty(hostileMarks, 'map', { enumerable: true, get() { calls += 1; return () => []; } });
assert.throws(() => buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: hostileMarks, profiles }), error => error.code === 'sparse_array_not_allowed');
assert.equal(calls, 0);
let topLevelCalls = 0;
const hostileBuilderInput = { markObservations: [mark], profiles };
Object.defineProperty(hostileBuilderInput, 'acquisitionResult', { enumerable: true, get() { topLevelCalls += 1; return acquisitionResult; } });
assert.throws(() => buildCandidateEvidenceBundleV1(hostileBuilderInput), error => error.code === 'accessor_not_allowed');
assert.equal(topLevelCalls, 0);
assert.throws(() => buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: [mark], profiles, extra: true }), error => error.code === 'unknown_field');
let deepHostileValue = null;
for (let index = 0; index < 20000; index += 1) deepHostileValue = [deepHostileValue];
assert.throws(() => buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: deepHostileValue, profiles }), error => error.code === 'json_depth_exceeded');
let aliasedHostileValue = {};
for (let index = 0; index < 17; index += 1) aliasedHostileValue = [aliasedHostileValue, aliasedHostileValue];
assert.throws(() => buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: aliasedHostileValue, profiles }), error => error.code === 'json_node_limit_exceeded');
console.log('candidate-set evidence bundle: PASS');
