#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWalletAcquisitionResultV1 } from './acquisition-result.mjs';
import { buildActivityFindingV1 } from './activity-findings.mjs';
import { recomputeCoverageV1 } from './coverage.mjs';
import { compareNormalizedEventRecordsV1 } from './dispositions.mjs';
import { buildCandidateEvidenceBundleV1 } from './evidence-bundle.mjs';
import { buildDispositionV1, buildEventRecordV1, computeSourceTransactionDigest } from './identity.mjs';
import { GENESIS_HASH } from './schema.mjs';
import {
  PROJECTION_MAPPING_VERSION,
  SELECTION_PROJECTION_VERSION,
  buildCandidateSelectionProjectionV1,
  validateCandidateSelectionProjectionV1,
} from './selection-projection.mjs';
import { providerPublicKey, providerSignature } from '../wallet-acquisition/fixtures/test-identities.mjs';

const WALLET = providerPublicKey('wallet');
const TOKEN = providerPublicKey('token');
const OTHER = providerPublicKey('other');
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const profiles = { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1', reconstruction_engine_version: 'artifact_position_ledger_receipt_v1', accounting_method_version: 'weighted_average_position_accounting_v1', mark_profile: null, mark_max_age_seconds: null };
const scope = { scope_version: 'wallet_candidate_scope_input_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, wallet: WALLET, window: { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1', requested_lookback_seconds: 2592000, initial_before_signature: null, lower_bound: { oldest_allowed_timestamp: 1, completion_status: 'proven' } } };
const boundary = { boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, commitment: 'finalized', anchor_slot: 100, anchor_block_time: 2592001, anchor_blockhash: providerPublicKey('blockhash'), history_complete_through_anchor: true, lower_bound_completion_proven: true, boundary_status: 'proven' };
const inputStatus = { coverage_status: 'complete', acquisition_complete: true, normalization_complete: true, classification_complete: true, pagination_complete: true, historical_bound_proven: true, chain_boundary_proven: true, truncated: false, capped: false, partial: false, provider_uncertain: false };

function raw({ token = TOKEN, timestamp, tx, rawIndex, buy = true }) {
  return { wallet: WALLET, timestamp, tx_hash: providerSignature(tx), source: 'swap', token_in_mint: buy ? QUOTE : token, token_in_amount: buy ? 10 : 5, token_in_decimals: 6, token_out_mint: buy ? token : QUOTE, token_out_amount: buy ? 5 : 12, token_out_decimals: 6, extraction_method: 'balance_delta', raw_index: rawIndex };
}

function evidenceFor(specs) {
  const records = specs.map(spec => buildEventRecordV1({ source_slot: spec.slot, slice7_event: raw(spec) }));
  const dispositions = records.map(record => buildDispositionV1({ tx_hash: record.slice7_event.tx_hash, slot: record.source_slot, block_time: record.slice7_event.timestamp, disposition_type: 'supported_normalized_event', affected_token_mints: [record.slice7_event.token_in_mint === QUOTE ? record.slice7_event.token_out_mint : record.slice7_event.token_in_mint], normalized_event_digests: [record.event_digest], finding_digests: [] }));
  records.sort(compareNormalizedEventRecordsV1);
  dispositions.sort((a, b) => a.slot - b.slot || (a.tx_hash < b.tx_hash ? -1 : 1));
  records.forEach((record, index) => { if (record.slice7_event.raw_index !== index) throw new Error('fixture raw indexes must follow evidence order'); });
  const coverage = recomputeCoverageV1({ transactionDispositions: dispositions, normalizedEventRecords: records, activityFindings: [], boundary, inputStatus, paginationTerminalReason: 'historical_bound_reached' });
  const acquisitionResult = buildWalletAcquisitionResultV1({ acquisition_result_version: 'wallet_wide_acquisition_result_v1', scope, profiles, boundary, input_status: inputStatus, coverage, transaction_dispositions: dispositions, normalized_event_records: records, activity_findings: [] });
  return buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: [], profiles });
}

test('projects every target event, excludes unrelated events, and builds a detached source mapping', () => {
  const evidenceBundle = evidenceFor([
    { slot: 10, timestamp: 100, tx: 'buy', rawIndex: 0, buy: true },
    { slot: 11, timestamp: 150, tx: 'other', rawIndex: 1, token: OTHER, buy: true },
    { slot: 12, timestamp: 200, tx: 'sell', rawIndex: 2, buy: false },
  ]);
  const projection = buildCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN });
  assert.equal(projection.projection_version, SELECTION_PROJECTION_VERSION);
  assert.equal(projection.projection_mapping.projection_mapping_version, PROJECTION_MAPPING_VERSION);
  assert.deepEqual(projection.receipt_scoped_evidence.events.map(event => event.tx_hash), [providerSignature('buy'), providerSignature('sell')]);
  assert.deepEqual(projection.receipt_scoped_evidence.events.map(event => event.raw_index), [0, 1]);
  assert.deepEqual(Object.keys(projection.receipt_scoped_evidence.events[0]), [
    'wallet', 'timestamp', 'tx_hash', 'source',
    'token_in_mint', 'token_in_amount', 'token_in_decimals',
    'token_out_mint', 'token_out_amount', 'token_out_decimals',
    'extraction_method', 'raw_index',
  ]);
  assert.deepEqual(projection.projection_mapping.entries.map(entry => entry.projected_raw_index), [0, 1]);
  assert.ok(projection.projection_mapping.entries.every(entry => /^[0-9a-f]{64}$/.test(entry.source_event_digest) && /^[0-9a-f]{64}$/.test(entry.source_disposition_digest)));
  assert.ok(Object.isFrozen(projection) && Object.isFrozen(projection.receipt_scoped_evidence.events[0]) && Object.isFrozen(projection.projection_mapping.entries[0]));
  assert.equal(JSON.stringify(projection.receipt_scoped_evidence.events).includes('source_event_digest'), false);
});

function expectProjectionCode(evidenceBundle, projection, code) {
  assert.throws(
    () => validateCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN, projection }),
    error => error.code === code,
  );
}

test('uses target-acquisition timestamp/signature order even when same-time source slots disagree', () => {
  const evidenceBundle = evidenceFor([
    { slot: 10, timestamp: 100, tx: 'z-signature', rawIndex: 1, buy: true },
    { slot: 11, timestamp: 100, tx: 'a-signature', rawIndex: 0, buy: false },
  ]);
  const projection = buildCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN });
  assert.deepEqual(projection.receipt_scoped_evidence.events.map(event => event.tx_hash), [providerSignature('a-signature'), providerSignature('z-signature')]);
  assert.deepEqual(projection.projection_mapping.entries.map(entry => entry.projected_raw_index), [0, 1]);
});

test('same timestamp with different slots remains deterministic after signature ordering', () => {
  const evidenceBundle = evidenceFor([
    { slot: 10, timestamp: 100, tx: 'a-signature', rawIndex: 0, buy: true },
    { slot: 11, timestamp: 100, tx: 'b-signature', rawIndex: 1, buy: false },
  ]);
  const projection = buildCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN });
  assert.deepEqual(projection.receipt_scoped_evidence.source_event_references.map(reference => reference.source_slot), [10, 11]);
});

test('projection validator rejects omitted, duplicated, injected, altered, reordered, non-dense, and remapped evidence', () => {
  const evidenceBundle = evidenceFor([
    { slot: 10, timestamp: 100, tx: 'buy', rawIndex: 0, buy: true },
    { slot: 12, timestamp: 200, tx: 'sell', rawIndex: 1, buy: false },
  ]);
  const original = buildCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN });

  const omitted = structuredClone(original);
  omitted.receipt_scoped_evidence.events.pop();
  omitted.receipt_scoped_evidence.source_event_digests.pop();
  omitted.receipt_scoped_evidence.source_event_references.pop();
  expectProjectionCode(evidenceBundle, omitted, 'target_event_omitted');

  const duplicated = structuredClone(original);
  duplicated.receipt_scoped_evidence.events.push({ ...duplicated.receipt_scoped_evidence.events[0], raw_index: 2 });
  duplicated.receipt_scoped_evidence.source_event_digests.push(duplicated.receipt_scoped_evidence.source_event_digests[0]);
  duplicated.receipt_scoped_evidence.source_event_references.push(duplicated.receipt_scoped_evidence.source_event_references[0]);
  expectProjectionCode(evidenceBundle, duplicated, 'target_event_duplicated');

  const injected = structuredClone(original);
  injected.receipt_scoped_evidence.events.push({ ...injected.receipt_scoped_evidence.events[1], tx_hash: 'injected', raw_index: 2 });
  expectProjectionCode(evidenceBundle, injected, 'selection_projection_incomplete');

  const altered = structuredClone(original);
  altered.receipt_scoped_evidence.events[0].token_out_amount += 1;
  expectProjectionCode(evidenceBundle, altered, 'selection_projection_incomplete');

  const extraField = structuredClone(original);
  extraField.receipt_scoped_evidence.events[0].injected = true;
  expectProjectionCode(evidenceBundle, extraField, 'selection_projection_incomplete');

  const reordered = structuredClone(original);
  reordered.receipt_scoped_evidence.events.reverse();
  reordered.receipt_scoped_evidence.source_event_digests.reverse();
  reordered.receipt_scoped_evidence.source_event_references.reverse();
  reordered.receipt_scoped_evidence.events.forEach((event, index) => { event.raw_index = index; });
  expectProjectionCode(evidenceBundle, reordered, 'selection_projection_order_invalid');

  const nonDense = structuredClone(original);
  nonDense.receipt_scoped_evidence.events[1].raw_index = 9;
  expectProjectionCode(evidenceBundle, nonDense, 'selection_projection_order_invalid');

  const remapped = structuredClone(original);
  remapped.projection_mapping.entries[0].source_disposition_digest = '0'.repeat(64);
  expectProjectionCode(evidenceBundle, remapped, 'selection_projection_mapping_invalid');
});

test('rejects hostile projection inputs without invoking accessors or proxy traps', () => {
  const evidenceBundle = evidenceFor([
    { slot: 10, timestamp: 100, tx: 'buy', rawIndex: 0, buy: true },
    { slot: 12, timestamp: 200, tx: 'sell', rawIndex: 1, buy: false },
  ]);
  const projection = buildCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN });
  let calls = 0;

  const accessorInput = { evidenceBundle, tokenMint: TOKEN };
  Object.defineProperty(accessorInput, 'tokenMint', { enumerable: true, get() { calls += 1; throw new Error('secret path'); } });
  assert.throws(() => buildCandidateSelectionProjectionV1(accessorInput), error => error.code === 'selection_projection_incomplete');
  assert.equal(calls, 0);

  const proxiedEvidenceInput = { evidenceBundle: new Proxy({}, { ownKeys() { calls += 1; throw new Error('secret path'); } }), tokenMint: TOKEN };
  assert.throws(() => buildCandidateSelectionProjectionV1(proxiedEvidenceInput), error => error.code === 'selection_projection_incomplete');
  assert.equal(calls, 0);

  const accessorProjection = structuredClone(projection);
  Object.defineProperty(accessorProjection.receipt_scoped_evidence.events[0], 'wallet', { enumerable: true, get() { calls += 1; throw new Error('secret path'); } });
  assert.throws(() => validateCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN, projection: accessorProjection }), error => error.code === 'selection_projection_incomplete');
  assert.equal(calls, 0);

  const namedArray = structuredClone(projection);
  namedArray.receipt_scoped_evidence.events.injected = true;
  assert.throws(() => validateCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN, projection: namedArray }), error => error.code === 'selection_projection_incomplete');

  const customPrototype = structuredClone(projection);
  Object.setPrototypeOf(customPrototype.receipt_scoped_evidence.events[0], { injected: true });
  assert.throws(() => validateCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN, projection: customPrototype }), error => error.code === 'selection_projection_incomplete');
});

test('rejects target-affecting unsupported or ambiguous findings before projection', () => {
  const base = evidenceFor([
    { slot: 10, timestamp: 100, tx: 'buy', rawIndex: 0, buy: true },
    { slot: 12, timestamp: 200, tx: 'sell', rawIndex: 1, buy: false },
  ]);
  for (const [findingType, reasonCode] of [['unsupported_activity', 'unsupported_swap_shape'], ['ambiguous_activity', 'ambiguous_swap_direction']]) {
    const source = { tx_hash: providerSignature(`${findingType}-target`), slot: 30, block_time: 300 };
    const finding = buildActivityFindingV1({
      finding_type: findingType, severity: 'candidate_blocking', impact_scope: 'token_specific',
      time_range: { first_observed_at: 300, last_observed_at: 300, first_observed_slot: 30, last_observed_slot: 30 },
      affected_token_mints: [TOKEN], affected_quote_mints: [QUOTE],
      source_transaction_digests: [computeSourceTransactionDigest(source)], source_event_digests: [],
      reason_codes: [reasonCode], impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
      disclosure_codes: ['activity_not_reconstructable'],
    });
    const findingDisposition = buildDispositionV1({ ...source, disposition_type: findingType, affected_token_mints: [TOKEN], normalized_event_digests: [], finding_digests: [finding.finding_digest] });
    const dispositions = [...base.payload.transaction_dispositions, findingDisposition].sort((left, right) => left.slot - right.slot);
    const activityFindings = [finding];
    const coverage = recomputeCoverageV1({ transactionDispositions: dispositions, normalizedEventRecords: base.payload.normalized_event_records, activityFindings, boundary, inputStatus, paginationTerminalReason: 'historical_bound_reached' });
    const acquisitionResult = buildWalletAcquisitionResultV1({ acquisition_result_version: 'wallet_wide_acquisition_result_v1', scope, profiles, boundary, input_status: inputStatus, coverage, transaction_dispositions: dispositions, normalized_event_records: base.payload.normalized_event_records, activity_findings: activityFindings });
    const evidenceBundle = buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: [], profiles });
    assert.throws(() => buildCandidateSelectionProjectionV1({ evidenceBundle, tokenMint: TOKEN }), error => error.code === 'target_finding_present');
  }
});
