#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  GENESIS_HASH, ACQUISITION_RESULT_VERSION, EVIDENCE_BUNDLE_VERSION,
  FINDING_VERSION, DISPOSITION_VERSION, CANDIDATE_VERSION, CANDIDATE_SET_VERSION,
  validateSourceTransactionReferenceV1, validateFindingV1,
  validateMarkObservationV1, validateBlockedSummaryV1,
} from './schema.mjs';

assert.equal(GENESIS_HASH, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
assert.equal(ACQUISITION_RESULT_VERSION, 'wallet_wide_acquisition_result_v1');
assert.equal(EVIDENCE_BUNDLE_VERSION, 'candidate_evidence_bundle_v1');
assert.equal(FINDING_VERSION, 'wallet_activity_finding_v1');
assert.equal(DISPOSITION_VERSION, 'wallet_transaction_disposition_v1');
assert.equal(CANDIDATE_VERSION, 'wallet_candidate_projection_v1');
assert.equal(CANDIDATE_SET_VERSION, 'wallet_candidate_set_v1');

const tx = { tx_hash: 't'.repeat(88), slot: 42, block_time: 1700000000 };
assert.doesNotThrow(() => validateSourceTransactionReferenceV1(tx));
assert.throws(() => validateSourceTransactionReferenceV1({ ...tx, extra: true }), error => error.code === 'unknown_field');

const d = 'a'.repeat(64);
const finding = {
  finding_version: FINDING_VERSION, finding_id: `aaf1_${d}`, finding_digest: d,
  finding_type: 'unsupported_activity', severity: 'candidate_blocking', impact_scope: 'token_specific',
  time_range: { first_observed_at: 1, last_observed_at: 1, first_observed_slot: 42, last_observed_slot: 42 },
  affected_token_mints: ['mint'], affected_quote_mints: [], source_transaction_digests: [d],
  source_event_digests: [], reason_codes: ['unsupported_swap_shape'],
  impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
  disclosure_codes: ['activity_not_reconstructable'],
};
assert.doesNotThrow(() => validateFindingV1(finding, { verifyDigest: false }));
assert.throws(() => validateFindingV1({ ...finding, disposition_digest: d }, { verifyDigest: false }), error => error.code === 'unknown_field');
assert.throws(() => validateFindingV1({ ...finding, affected_token_mints: [] }, { verifyDigest: false }), error => error.code === 'invalid_field');

const mark = {
  mark_observation_version: 'wallet_mark_observation_v1', mark_observation_id: `amo1_${d}`,
  mark_observation_digest: d, token_mint: 'mint', quote_mint: 'quote', observation_status: 'available',
  source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 2, observed_at: 1, source_slot: 42, reason_code: null,
};
assert.doesNotThrow(() => validateMarkObservationV1(mark, { verifyDigest: false }));
assert.throws(() => validateMarkObservationV1({ ...mark, reason_code: 'bad' }, { verifyDigest: false }), error => error.code === 'invalid_field');

const blocked = {
  blocked_summary_version: 'wallet_blocked_candidate_summary_v1', blocked_summary_id: `abs1_${d}`,
  blocked_summary_digest: d, chain: 'solana', network: 'mainnet-beta', wallet: 'wallet', token_mint: 'mint',
  position_status: 'unknown', ledger_evidence_status: 'blocked_unsupported_activity', boundary_status: 'unavailable',
  valuation_status: 'unavailable', selection_status: 'blocked', package_eligibility: 'blocked_by_evidence',
  economics_status: 'unavailable', associated_finding_digests: [d], reason_codes: ['unsupported_swap_shape'],
  disclosure_codes: ['activity_not_reconstructable'],
};
assert.doesNotThrow(() => validateBlockedSummaryV1(blocked, { verifyDigest: false }));
assert.throws(() => validateBlockedSummaryV1({ ...blocked, economics: { pnl: 0 } }, { verifyDigest: false }), error => error.code === 'unknown_field');
console.log('candidate-set schema: PASS');
