#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildSourceTransactionReferenceV1, sourceTransactionDigestPreimage, computeSourceTransactionDigest,
  buildFindingV1, findingDigestPreimage, buildDispositionV1, buildEventRecordV1,
  buildMarkObservationV1, buildBlockedSummaryV1, buildCandidateV1,
  candidateDigestPreimage, computeCoverageDigest, computeDigestIndex,
  computeWindowDigest, computeScopeDigest, buildEvidenceBundleV1, evidenceBundleDigestPreimage,
  buildCandidateSetV1, candidateSetDigestPreimage,
} from './identity.mjs';
import { GENESIS_HASH } from './schema.mjs';
import { sha256CanonicalJson } from './serialize.mjs';

const d = n => n.repeat(64);
const tx = buildSourceTransactionReferenceV1({ block_time: 1700000000, slot: 42, tx_hash: 'x'.repeat(88) });
assert.deepEqual(sourceTransactionDigestPreimage(tx), { source_transaction_reference_version: 'source_transaction_reference_v1', source_transaction: tx });
const txDigest = computeSourceTransactionDigest(tx); assert.equal(txDigest, sha256CanonicalJson(sourceTransactionDigestPreimage(tx)));
const finding = buildFindingV1({ finding_type: 'unsupported_activity', severity: 'candidate_blocking', impact_scope: 'token_specific', time_range: { first_observed_at: 1, last_observed_at: 1, first_observed_slot: 42, last_observed_slot: 42 }, affected_token_mints: ['mint'], affected_quote_mints: [], source_transaction_digests: [txDigest], source_event_digests: [], reason_codes: ['unsupported_swap_shape'], impact: { blocks_candidate_projection: true, blocks_receipt_publication: true }, disclosure_codes: ['activity_not_reconstructable'] });
assert.equal(finding.finding_id, `aaf1_${finding.finding_digest}`); assert.ok(!Object.hasOwn(findingDigestPreimage(finding), 'finding_id')); assert.ok(!JSON.stringify(findingDigestPreimage(finding)).includes('disposition_digest'));
const disposition = buildDispositionV1({ tx_hash: tx.tx_hash, slot: tx.slot, block_time: tx.block_time, disposition_type: 'unsupported_activity', affected_token_mints: ['mint'], normalized_event_digests: [], finding_digests: [finding.finding_digest] });
assert.equal(disposition.disposition_id, `awd1_${disposition.disposition_digest}`);
const mark = buildMarkObservationV1({ token_mint: 'mint', quote_mint: 'quote', observation_status: 'unavailable', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: null, observed_at: null, source_slot: null, reason_code: 'mark_source_unavailable' });
assert.equal(mark.mark_observation_id, `amo1_${mark.mark_observation_digest}`);
const blocked = buildBlockedSummaryV1({ chain: 'solana', network: 'mainnet-beta', wallet: 'wallet', token_mint: 'mint', position_status: 'unknown', ledger_evidence_status: 'blocked_unsupported_activity', boundary_status: 'unavailable', valuation_status: 'unavailable', selection_status: 'blocked', package_eligibility: 'blocked_by_evidence', economics_status: 'unavailable', associated_finding_digests: [finding.finding_digest], reason_codes: ['unsupported_swap_shape'], disclosure_codes: ['activity_not_reconstructable'] });
assert.equal(blocked.blocked_summary_id, `abs1_${blocked.blocked_summary_digest}`);
const projection = { candidate_type: 'closed_position', position_status: 'closed', ledger_evidence_status: 'clean', boundary_status: 'not_applicable', valuation_status: 'raw_quote', selection_status: 'selectable', package_eligibility: 'eligible_closed_position_v1', economics_status: 'available', chain: 'solana', network: 'mainnet-beta', wallet: 'wallet', token_mint: 'mint', quote_mint: 'quote', quote_symbol_code: 'USDC', segment_index: 0, first_event_at: 1, last_event_at: 2, event_counts: { buys: 1, sells: 1, supported_events: 2, associated_findings: 0 }, ledger_eligibility: { eligible_for_closed_position: true, eligible_for_verified_receipt: true }, economics: { economics_type: 'closed_position_raw_quote_v1', total_bought_qty: 1, total_bought_quote: 1, avg_buy_quote_price: 1, total_sold_qty: 1, total_sold_quote: 2, avg_sell_quote_price: 2, allocated_cost_basis_quote: 1, remaining_qty: 0, remaining_cost_basis_quote: 0, entry_count: 1, exit_count: 1, accounting_method: 'weighted_average_position_accounting_v1', realized_pnl_quote: 1, realized_pnl_pct: 100, hold_time_seconds: 1, close_reason_code: null, dust_classification_code: null }, snapshot: null, flags: [], limitations: [], reason_codes: [], disclosure_codes: [] };
const candidate = buildCandidateV1({ ledger_candidate_hash: d('b'), receipt_scoped_evidence_digest: d('c'), selection_key: { wallet: 'wallet', token_mint: 'mint', receipt_type: 'closed_position', segment_index: 0 }, projection });
assert.equal(candidate.candidate_id, `acv1_${candidate.candidate_digest}`); assert.deepEqual(Object.keys(candidateDigestPreimage(candidate)), ['candidate_identity_version','receipt_scoped_evidence_digest','ledger_candidate_hash','projection']);
assert.ok(!Object.hasOwn(candidateDigestPreimage(candidate), 'handoff'));
assert.match(computeDigestIndex('wallet_mark_observation_index_v1', [mark.mark_observation_digest]), /^[0-9a-f]{64}$/);
const coverageBody = { coverage_version: 'wallet_candidate_coverage_v1', coverage_status: 'complete', transactions_examined: 0, supported_transaction_count: 0, unsupported_transaction_count: 0, ambiguous_transaction_count: 0, unrelated_transaction_count: 0, failed_transaction_count: 0, normalized_event_count: 0, finding_count: 0, localized_finding_count: 0, wallet_wide_finding_count: 0, oldest_observed_timestamp: null, newest_observed_timestamp: null, oldest_observed_slot: null, newest_observed_slot: null, pagination_terminal_reason: 'provider_exhaustion' };
const coverage = { ...coverageBody, coverage_digest: computeCoverageDigest(coverageBody) };
const window = { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1', requested_lookback_seconds: 2592000, initial_before_signature: null, lower_bound: { oldest_allowed_timestamp: 1, completion_status: 'proven' } };
const scopeInput = { scope_version: 'wallet_candidate_scope_input_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, wallet: 'wallet', window };
const profiles = { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1', reconstruction_engine_version: 'artifact_position_ledger_receipt_v1', accounting_method_version: 'weighted_average_position_accounting_v1', mark_profile: null, mark_max_age_seconds: null };
const boundary = { boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, commitment: 'finalized', anchor_slot: 100, anchor_block_time: 2, anchor_blockhash: 'blockhash', history_complete_through_anchor: true, lower_bound_completion_proven: true, boundary_status: 'proven' };
const inputStatus = { coverage_status: 'complete', acquisition_complete: true, normalization_complete: true, classification_complete: true, pagination_complete: true, historical_bound_proven: true, chain_boundary_proven: true, truncated: false, capped: false, partial: false, provider_uncertain: false };
const evidence = buildEvidenceBundleV1({ scope: scopeInput, profiles, boundary, input_status: inputStatus, coverage, transaction_dispositions: [], normalized_event_records: [], activity_findings: [], mark_observations: [] });
assert.deepEqual(evidenceBundleDigestPreimage(evidence), evidence.payload); assert.ok(Object.isFrozen(evidence.payload.integrity));
assert.throws(() => buildEvidenceBundleV1({ scope: scopeInput, profiles, boundary, input_status: inputStatus, coverage, transaction_dispositions: [], normalized_event_records: [], activity_findings: [], mark_observations: [mark, mark] }), error => error.code === 'duplicate_value');
let mapCalls = 0; const hostileMarks = [];
Object.defineProperty(hostileMarks, 'map', { enumerable: true, get() { mapCalls += 1; throw new Error('map invoked'); } });
assert.throws(() => buildEvidenceBundleV1({ scope: scopeInput, profiles, boundary, input_status: inputStatus, coverage, transaction_dispositions: [], normalized_event_records: [], activity_findings: [], mark_observations: hostileMarks }), error => error.code === 'sparse_array_not_allowed'); assert.equal(mapCalls, 0);
const wrongEvent = buildEventRecordV1({ source_slot: 41, slice7_event: { wallet: 'wallet', timestamp: 1700000000, tx_hash: 'y'.repeat(88), source: 'swap', token_in_mint: 'mintA', token_in_amount: 1, token_in_decimals: 6, token_out_mint: 'mintB', token_out_amount: 2, token_out_decimals: 6, extraction_method: 'balance_delta', raw_index: 0 } });
const wrongDisposition = buildDispositionV1({ tx_hash: 'z'.repeat(88), slot: 42, block_time: 1700000000, disposition_type: 'supported_normalized_event', affected_token_mints: ['mintA'], normalized_event_digests: [wrongEvent.event_digest], finding_digests: [] });
assert.throws(() => buildEvidenceBundleV1({ scope: scopeInput, profiles, boundary, input_status: inputStatus, coverage, transaction_dispositions: [wrongDisposition], normalized_event_records: [wrongEvent], activity_findings: [], mark_observations: [] }), error => error.code === 'event_source_mismatch');
const windowDigest = computeWindowDigest({ chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, wallet: 'wallet', window });
const scopeDigest = computeScopeDigest({ chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, wallet: 'wallet', window_digest: windowDigest, coverage_digest: coverage.coverage_digest, profiles });
const scope = { scope_version: 'wallet_candidate_scope_v1', scope_digest: scopeDigest, window_digest: windowDigest, chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, wallet: 'wallet', window };
const payload = { scope, profiles, commitments: { evidence_bundle_digest: evidence.evidence_bundle_digest, coverage_digest: coverage.coverage_digest, transaction_dispositions_digest: evidence.payload.integrity.transaction_dispositions_digest, normalized_events_digest: evidence.payload.integrity.normalized_events_digest, activity_findings_digest: evidence.payload.integrity.activity_findings_digest, mark_observations_digest: evidence.payload.integrity.mark_observations_digest }, coverage, counts: { candidate_count: 0, closed_candidate_count: 0, partial_candidate_count: 0, open_candidate_count: 0, limited_candidate_count: 0, selectable_candidate_count: 0, blocked_summary_count: 0, finding_count: 0 }, candidates: [], blocked_summaries: [], activity_findings: [] };
const set = buildCandidateSetV1(payload); assert.deepEqual(candidateSetDigestPreimage(set), payload); assert.ok(Object.isFrozen(set.payload));
assert.throws(() => buildCandidateSetV1({ ...payload, metadata: { candidate_set_digest: d('f') } }), error => error.code === 'candidate_set_digest_in_payload' || error.code === 'unknown_field');
const otherProjection = structuredClone(projection); otherProjection.wallet = 'other-wallet';
const otherCandidate = buildCandidateV1({ ledger_candidate_hash: d('d'), receipt_scoped_evidence_digest: d('e'), selection_key: { wallet: 'other-wallet', token_mint: 'mint', receipt_type: 'closed_position', segment_index: 0 }, projection: otherProjection });
const otherCounts = { ...payload.counts, candidate_count: 1, closed_candidate_count: 1, selectable_candidate_count: 1 };
assert.throws(() => buildCandidateSetV1({ ...payload, counts: otherCounts, candidates: [otherCandidate] }), error => error.code === 'candidate_scope_mismatch');
const alternateProjection = structuredClone(projection); alternateProjection.economics.realized_pnl_quote = 2;
const duplicateKeyCandidate = buildCandidateV1({ ledger_candidate_hash: d('f'), receipt_scoped_evidence_digest: d('1'), selection_key: candidate.selection_key, projection: alternateProjection });
const duplicateKeyCounts = { ...payload.counts, candidate_count: 2, closed_candidate_count: 2, selectable_candidate_count: 2 };
assert.throws(() => buildCandidateSetV1({ ...payload, counts: duplicateKeyCounts, candidates: [candidate, duplicateKeyCandidate] }), error => error.code === 'duplicate_selection_key');
console.log('candidate-set identity: PASS');
