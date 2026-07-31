#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildWalletAcquisitionResultV1, validateWalletAcquisitionResultV1 } from './acquisition-result.mjs';
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
  profiles: { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1', reconstruction_engine_version: 'artifact_position_ledger_receipt_v1', accounting_method_version: 'weighted_average_position_accounting_v1', mark_profile: null },
  boundary: { boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, commitment: 'finalized', anchor_slot: 100, anchor_block_time: 2, anchor_blockhash: 'blockhash', history_complete_through_anchor: true, lower_bound_completion_proven: true, boundary_status: 'proven' },
  input_status: { coverage_status: 'complete', acquisition_complete: true, normalization_complete: true, classification_complete: true, pagination_complete: true, historical_bound_proven: true, chain_boundary_proven: true, truncated: false, capped: false, partial: false, provider_uncertain: false },
  coverage, transaction_dispositions: [], normalized_event_records: [], activity_findings: [],
};
const result = buildWalletAcquisitionResultV1(input);
assert.deepEqual(result, input); assert.ok(Object.isFrozen(result) && Object.isFrozen(result.scope.window));
input.scope.wallet = 'mutated'; assert.equal(result.scope.wallet, 'wallet');
assert.doesNotThrow(() => validateWalletAcquisitionResultV1(result));
const cursor = structuredClone(result); cursor.scope.window.initial_before_signature = 'sig';
assert.throws(() => validateWalletAcquisitionResultV1(cursor), error => error.code === 'non_null_latest_state_cursor');
const unknown = structuredClone(result); unknown.extra = true;
assert.throws(() => validateWalletAcquisitionResultV1(unknown), error => error.code === 'unknown_field');
let accessorCalls = 0; const hostile = structuredClone(result);
Object.defineProperty(hostile, 'acquisition_result_version', { enumerable: true, get() { accessorCalls += 1; return 'wallet_wide_acquisition_result_v1'; } });
assert.throws(() => validateWalletAcquisitionResultV1(hostile), error => error.code === 'accessor_not_allowed'); assert.equal(accessorCalls, 0);
console.log('candidate-set acquisition result: PASS');
