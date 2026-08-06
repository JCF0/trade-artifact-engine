#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOpenPositionSnapshotV1 } from './open-snapshot.mjs';
import { buildMarkObservationV1 } from './mark-observations.mjs';
import { buildWalletAcquisitionResultV1 } from './acquisition-result.mjs';
import { buildWalletCandidateSetV1 } from './builder.mjs';
import { buildCandidateEvidenceBundleV1 } from './evidence-bundle.mjs';
import { buildEventRecordV1, computeCandidateSetDigest } from './identity.mjs';
import { compareNormalizedEventRecordsV1 } from './dispositions.mjs';
import { assertPlainJsonValue } from './plain-data.mjs';
import { recomputeCoverageV1 } from './coverage.mjs';
import { resolveCandidateSelectionV1 } from './selection-resolver.mjs';
import { canonicalJson } from './serialize.mjs';
import { orchestrateTargetedReceiptPackageV1 } from '../receipt-package/targeted-orchestrator.mjs';
import {
  COMPLETE_INPUT_STATUS,
  FIXTURE_MATRIX,
  JUP_GOLDEN,
  RAY_GOLDEN,
  REQUIRED_FIXTURE_CASES,
  USDC_MINT,
  buildDeterministicCandidateFixtureV1,
} from './fixtures/deterministic-fixtures.mjs';
import { GENESIS_HASH } from './schema.mjs';

function candidateFor(built, tokenMint, segmentIndex = undefined) {
  const matches = built.candidateSet.payload.candidates.filter(item => item.projection.token_mint === tokenMint
    && (segmentIndex === undefined || item.projection.segment_index === segmentIndex));
  assert.equal(matches.length, 1, `expected exactly one ${tokenMint} candidate`);
  return matches[0];
}

function resolve(built, candidate) {
  return resolveCandidateSelectionV1({
    candidateSet: built.candidateSet,
    evidenceBundle: built.evidenceBundle,
    selection: {
      candidate_set_digest: built.candidateSet.candidate_set_digest,
      candidate_digest: candidate.candidate_digest,
    },
  });
}

function expectSelectionCode(built, candidate, code) {
  assert.throws(() => resolve(built, candidate), error => error.code === code && error.cause === undefined);
}

const memberNames = ['archive-record.json', 'canonical-receipt.json', 'economics.json', 'manifest.json', 'verification.json'];

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertRecursivelyFrozen(child);
}

test('required deterministic fixture manifest covers exactly A through L and exported fixtures are deeply frozen', () => {
  assert.deepEqual(Object.keys(REQUIRED_FIXTURE_CASES), 'ABCDEFGHIJKL'.split(''));
  assertRecursivelyFrozen(REQUIRED_FIXTURE_CASES);
  assertRecursivelyFrozen(FIXTURE_MATRIX);
  assertRecursivelyFrozen(JUP_GOLDEN);
  assertRecursivelyFrozen(RAY_GOLDEN);
});

test('multiple closed positions are deterministically ordered and resolve only inside their exact set', () => {
  const built = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.multipleCleanClosed);
  assert.equal(built.candidateSet.payload.candidates.length, 2);
  assert.equal(built.candidateSet.payload.counts.selectable_candidate_count, 2);
  assert.deepEqual(
    built.candidateSet.payload.candidates.map(item => item.candidate_digest),
    [...built.candidateSet.payload.candidates.map(item => item.candidate_digest)].sort(),
  );
  for (const candidate of built.candidateSet.payload.candidates) {
    const resolved = resolve(built, candidate);
    assert.equal(resolved.audit.candidate_digest, candidate.candidate_digest);
    assert.equal(resolved.slice7_request.target.token_mint, candidate.projection.token_mint);
  }
  const other = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.reopened);
  const foreign = candidateFor(other, 'REOPEN', 0);
  assert.throws(() => resolveCandidateSelectionV1({
    candidateSet: built.candidateSet,
    evidenceBundle: built.evidenceBundle,
    selection: { candidate_set_digest: built.candidateSet.candidate_set_digest, candidate_digest: foreign.candidate_digest },
  }), error => error.code === 'candidate_not_found');
});

test('reopened nonzero segment retains complete same-mint reconstruction history and exact hash', () => {
  const built = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.reopened);
  const tokenCandidates = built.candidateSet.payload.candidates.filter(item => item.projection.token_mint === 'REOPEN');
  assert.deepEqual(tokenCandidates.map(item => item.projection.segment_index).sort(), [0, 1]);
  assert.deepEqual(
    tokenCandidates.map(item => item.candidate_digest),
    [...tokenCandidates.map(item => item.candidate_digest)].sort(),
  );
  const later = candidateFor(built, 'REOPEN', 1);
  const resolved = resolve(built, later);
  assert.equal(resolved.slice7_request.target.segment_index, 1);
  assert.deepEqual(resolved.slice7_request.normalizedEvents.map(item => item.tx_hash), [
    'reopen-buy-0', 'reopen-sell-0', 'reopen-buy-1', 'reopen-sell-1',
  ]);
  assert.equal(resolved.audit.ledger_candidate_hash, later.ledger_candidate_hash);
});

test('realized partial, clean open, and partial-history candidates remain visible-only and fail before request derivation', () => {
  const built = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.openAndPartialHistory);
  const partial = candidateFor(built, 'REALIZED-PARTIAL');
  assert.equal(partial.projection.candidate_type, 'realized_partial');
  assert.equal(partial.projection.economics.realized_pnl_quote, 2);
  assert.equal(partial.projection.economics.remaining_qty, 8);
  assert.equal(partial.projection.economics.remaining_cost_basis_quote, 16);
  assert.equal(partial.projection.snapshot.snapshot_at, FIXTURE_MATRIX.openAndPartialHistory.anchorBlockTime);
  assert.equal(partial.projection.selection_status, 'visible_only');
  assert.equal(partial.projection.package_eligibility, 'not_publication_eligible_v1');
  expectSelectionCode(built, partial, 'candidate_not_selectable');

  const open = candidateFor(built, 'CLEAN-OPEN');
  assert.equal(open.projection.candidate_type, 'open_snapshot');
  assert.equal(open.projection.economics.remaining_qty, 4);
  assert.equal(open.projection.economics.remaining_cost_basis_quote, 8);
  assert.equal(open.projection.economics.realized_pnl_to_date_quote, 0);
  assert.equal(open.projection.snapshot.unrealized_pnl.market_value_quote, 12);
  assert.equal(open.projection.snapshot.unrealized_pnl.unrealized_pnl_quote, 4);
  assert.ok(open.projection.disclosure_codes.includes('open_outcome_not_final'));
  expectSelectionCode(built, open, 'candidate_not_selectable');

  const limited = candidateFor(built, 'LIMITED-HISTORY');
  assert.equal(limited.projection.ledger_evidence_status, 'limited_partial_history');
  assert.equal(limited.projection.economics_status, 'unavailable_partial_history');
  assert.equal(limited.projection.economics, null);
  assert.equal(limited.projection.snapshot, null);
  assert.equal(limited.projection.valuation_status, 'unavailable');
  assert.equal(limited.projection.selection_status, 'visible_only');
  assert.equal(limited.projection.package_eligibility, 'not_publication_eligible_v1');
  expectSelectionCode(built, limited, 'candidate_not_selectable');

  const partiallyObserved = candidateFor(built, 'PARTIALLY-OBSERVED');
  assert.equal(partiallyObserved.projection.ledger_evidence_status, 'limited_partial_history');
  assert.equal(partiallyObserved.projection.economics_status, 'unavailable_partial_history');
  assert.equal(partiallyObserved.projection.economics, null);
  assert.equal(partiallyObserved.projection.snapshot, null);
  assert.equal(partiallyObserved.projection.valuation_status, 'unavailable');
  assert.equal(partiallyObserved.projection.event_counts.buys, 1);
  assert.equal(partiallyObserved.projection.event_counts.sells, 1);
  expectSelectionCode(built, partiallyObserved, 'candidate_not_selectable');
});

test('localized unsupported and ambiguous activity isolate tokens with ambiguous precedence', () => {
  const unsupported = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.localizedUnsupported);
  assert.equal(unsupported.candidateSet.payload.blocked_summaries.length, 1);
  assert.equal(unsupported.candidateSet.payload.blocked_summaries[0].ledger_evidence_status, 'blocked_unsupported_activity');
  assert.equal(unsupported.candidateSet.payload.candidates.some(item => item.projection.token_mint === 'BLOCKED'), false);
  assert.equal(candidateFor(unsupported, JUP_GOLDEN.tokenMint).projection.selection_status, 'selectable');

  const ambiguous = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.localizedAmbiguous);
  assert.equal(ambiguous.candidateSet.payload.blocked_summaries.length, 1);
  const summary = ambiguous.candidateSet.payload.blocked_summaries[0];
  assert.equal(summary.ledger_evidence_status, 'blocked_ambiguous_activity');
  assert.equal(summary.associated_finding_digests.length, 2);
  assert.equal(ambiguous.candidateSet.payload.candidates.some(item => item.projection.token_mint === 'BLOCKED'), false);
  assert.equal(candidateFor(ambiguous, JUP_GOLDEN.tokenMint).projection.selection_status, 'selectable');
});

test('wallet-wide indeterminate ambiguity emits neither evidence bundle nor candidate set', () => {
  let emitted = null;
  assert.throws(() => {
    emitted = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.walletWideAmbiguous);
  }, error => error.code === 'wallet_wide_impact_unresolved');
  assert.equal(emitted, null);
});

test('same timestamp ordering is timestamp, signature code units, source slot, then digest and ignores provider permutation', () => {
  const first = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.sameTimestamp);
  const permuted = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.sameTimestamp, { permuteInput: true });
  const records = first.evidenceBundle.payload.normalized_event_records;
  assert.deepEqual(records.map(item => [item.slice7_event.timestamp, item.slice7_event.tx_hash, item.source_slot]), [
    [100, 'sig-a', 30],
    [100, 'sig-b', 10],
    [100, 'sig-c', 20],
  ]);
  assert.equal(canonicalJson(first.acquisitionResult), canonicalJson(permuted.acquisitionResult));
  assert.equal(canonicalJson(first.evidenceBundle), canonicalJson(permuted.evidenceBundle));
  assert.equal(canonicalJson(first.candidateSet), canonicalJson(permuted.candidateSet));

  assert.throws(() => buildWalletAcquisitionResultV1({
    ...first.acquisitionResult,
    transaction_dispositions: [...first.acquisitionResult.transaction_dispositions].reverse(),
    normalized_event_records: [...first.acquisitionResult.normalized_event_records].reverse(),
    activity_findings: [...first.acquisitionResult.activity_findings].reverse(),
  }), error => error.code === 'event_index_mismatch' || error.code === 'order_invalid');
  const independentlyPermutedAcquisition = buildWalletAcquisitionResultV1({
    ...first.acquisitionResult,
    transaction_dispositions: [...first.acquisitionResult.transaction_dispositions].reverse(),
    activity_findings: [...first.acquisitionResult.activity_findings].reverse(),
  });
  assert.notEqual(canonicalJson(independentlyPermutedAcquisition), canonicalJson(first.acquisitionResult));
  const canonicalizedEvidence = buildCandidateEvidenceBundleV1({
    acquisitionResult: independentlyPermutedAcquisition,
    markObservations: [],
    profiles: independentlyPermutedAcquisition.profiles,
  });
  const canonicalizedSet = buildWalletCandidateSetV1({ evidenceBundle: canonicalizedEvidence });
  assert.equal(canonicalJson(canonicalizedEvidence), canonicalJson(first.evidenceBundle));
  assert.equal(canonicalJson(canonicalizedSet), canonicalJson(first.candidateSet));

  const tied = [
    buildEventRecordV1({ source_slot: 9, slice7_event: { wallet: 'matrix-wallet', timestamp: 100, tx_hash: 'same-signature', source: 'deterministic_fixture', token_in_mint: USDC_MINT, token_in_amount: 2, token_in_decimals: 6, token_out_mint: 'TIE-B', token_out_amount: 1, token_out_decimals: 6, extraction_method: 'events_swap', raw_index: 0 } }),
    buildEventRecordV1({ source_slot: 8, slice7_event: { wallet: 'matrix-wallet', timestamp: 100, tx_hash: 'same-signature', source: 'deterministic_fixture', token_in_mint: USDC_MINT, token_in_amount: 2, token_in_decimals: 6, token_out_mint: 'TIE-A', token_out_amount: 1, token_out_decimals: 6, extraction_method: 'events_swap', raw_index: 1 } }),
    buildEventRecordV1({ source_slot: 9, slice7_event: { wallet: 'matrix-wallet', timestamp: 100, tx_hash: 'same-signature', source: 'deterministic_fixture', token_in_mint: USDC_MINT, token_in_amount: 3, token_in_decimals: 6, token_out_mint: 'TIE-C', token_out_amount: 1, token_out_decimals: 6, extraction_method: 'events_swap', raw_index: 2 } }),
  ].sort(compareNormalizedEventRecordsV1);
  assert.equal(tied[0].source_slot, 8);
  assert.deepEqual(tied.slice(1).map(item => item.event_digest), [...tied.slice(1).map(item => item.event_digest)].sort());
});

test('available, missing, stale, after-boundary, and quote-mismatch marks preserve null rather than zero', () => {
  const boundary = {
    boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta',
    genesis_hash: GENESIS_HASH, commitment: 'finalized', anchor_slot: 100, anchor_block_time: 1000,
    anchor_blockhash: 'mark-boundary', history_complete_through_anchor: true, lower_bound_completion_proven: true,
    boundary_status: 'proven',
  };
  const position = { candidate_type: 'open_snapshot', token_mint: 'MARK-TOKEN', quote_mint: USDC_MINT, remaining_qty: 4, remaining_cost_basis_quote: 8 };
  const available = buildMarkObservationV1({ token_mint: 'MARK-TOKEN', quote_mint: USDC_MINT, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 3, observed_at: 999, source_slot: 99, reason_code: null });
  const stale = buildMarkObservationV1({ token_mint: 'MARK-TOKEN', quote_mint: USDC_MINT, observation_status: 'unavailable', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: null, observed_at: null, source_slot: null, reason_code: 'mark_stale' });
  const after = buildMarkObservationV1({ token_mint: 'MARK-TOKEN', quote_mint: USDC_MINT, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 3, observed_at: 1001, source_slot: 99, reason_code: null });
  const mismatch = buildMarkObservationV1({ token_mint: 'MARK-TOKEN', quote_mint: 'OTHER-QUOTE', observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 3, observed_at: 999, source_slot: 99, reason_code: null });
  const cases = [
    [available, 'available', 'fresh', 12],
    [null, 'unavailable', 'unavailable', null],
    [stale, 'unavailable', 'stale', null],
    [after, 'unavailable', 'after_boundary', null],
    [mismatch, 'unavailable', 'quote_mismatch', null],
  ];
  for (const [markObservation, status, freshness, marketValue] of cases) {
    const snapshot = buildOpenPositionSnapshotV1({ position, boundary, markObservation });
    assert.equal(snapshot.mark.status, status);
    assert.equal(snapshot.mark.freshness_status, freshness);
    assert.equal(snapshot.unrealized_pnl?.market_value_quote ?? null, marketValue);
    if (marketValue === null) {
      assert.equal(snapshot.mark.mark_price_raw_quote, null);
      assert.equal(snapshot.unrealized_pnl, null);
    }
  }
});

test('mark variants flow through evidence and candidate-set construction with boundary failures closed', () => {
  const base = structuredClone(FIXTURE_MATRIX.openAndPartialHistory);
  const projectionFor = spec => buildDeterministicCandidateFixtureV1(spec).candidateSet.payload.candidates
    .find(candidate => candidate.projection.token_mint === 'CLEAN-OPEN').projection;

  const available = projectionFor(structuredClone(base));
  assert.equal(available.valuation_status, 'mark_available');
  assert.equal(available.snapshot.mark.freshness_status, 'fresh');
  assert.equal(available.snapshot.unrealized_pnl.market_value_quote, 12);

  const missingSpec = structuredClone(base);
  missingSpec.marks = [];
  const missing = projectionFor(missingSpec);
  assert.equal(missing.valuation_status, 'mark_unavailable');
  assert.equal(missing.snapshot.mark.mark_price_raw_quote, null);
  assert.equal(missing.snapshot.unrealized_pnl, null);

  const staleSpec = structuredClone(base);
  Object.assign(staleSpec.marks[1], { observation_status: 'unavailable', mark_price_raw_quote: null, observed_at: null, source_slot: null, reason_code: 'mark_stale' });
  const stale = projectionFor(staleSpec);
  assert.equal(stale.snapshot.mark.freshness_status, 'stale');
  assert.equal(stale.snapshot.mark.mark_price_raw_quote, null);
  assert.equal(stale.snapshot.unrealized_pnl, null);

  const mismatchSpec = structuredClone(base);
  mismatchSpec.marks[1].quote_mint = 'OTHER-QUOTE';
  const mismatch = projectionFor(mismatchSpec);
  assert.equal(mismatch.valuation_status, 'mark_quote_mismatch');
  assert.equal(mismatch.snapshot.mark.mark_price_raw_quote, null);
  assert.equal(mismatch.snapshot.unrealized_pnl, null);

  const afterSpec = structuredClone(base);
  afterSpec.marks[1].observed_at = base.anchorBlockTime + 1;
  afterSpec.marks[1].source_slot = base.anchorSlot + 1;
  const after = projectionFor(afterSpec);
  assert.equal(after.valuation_status, 'mark_after_boundary');
  assert.equal(after.snapshot.mark.freshness_status, 'after_boundary');
  assert.equal(after.snapshot.mark.mark_price_raw_quote, null);
  assert.equal(after.snapshot.unrealized_pnl, null);
});

test('golden JUP and RAY complete chain preserves exact receipt, package, and five member hashes without a store', async () => {
  for (const fixture of [JUP_GOLDEN, RAY_GOLDEN]) {
    const built = buildDeterministicCandidateFixtureV1(fixture);
    const candidate = candidateFor(built, fixture.tokenMint);
    const resolved = resolve(built, candidate);
    assert.deepEqual(Object.keys(resolved), ['resolution_version', 'slice7_request', 'audit']);
    assert.equal(resolved.slice7_request.mode, 'dry_run');
    const orchestrated = await orchestrateTargetedReceiptPackageV1(resolved.slice7_request, {});
    assert.equal(orchestrated.receipt_hash, fixture.receiptHash);
    assert.equal(orchestrated.package_digest, fixture.packageDigest);
    assert.deepEqual(Object.keys(orchestrated.member_hashes).sort(), memberNames);
    assert.deepEqual(orchestrated.member_hashes, fixture.memberHashes);
  }
  const ray = buildDeterministicCandidateFixtureV1(RAY_GOLDEN);
  assert.deepEqual(RAY_GOLDEN.events[0].sameMintInputAmounts, [24975, 25]);
  assert.equal(RAY_GOLDEN.events[0].sameMintInputAmounts.reduce((total, amount) => total + amount, 0), 25000);
  assert.equal(ray.acquisitionResult.normalized_event_records[0].slice7_event.tx_hash, RAY_GOLDEN.events[0].signature);
  assert.equal(ray.acquisitionResult.normalized_event_records[0].slice7_event.source, 'JUPITER');
  assert.equal(ray.acquisitionResult.normalized_event_records[0].slice7_event.extraction_method, 'helius_enhanced_transaction_swap_v1');
  assert.equal(ray.acquisitionResult.normalized_event_records[0].slice7_event.token_in_amount, 25000);
  assert.equal(ray.acquisitionResult.normalized_event_records[0].slice7_event.token_out_amount, 26644.791399);
  assert.equal(ray.acquisitionResult.transaction_dispositions[0].normalized_event_digests.length, 1);
});

test('repeated builds, permutations, and detached caller mutation are byte-identical', () => {
  const mutable = structuredClone(FIXTURE_MATRIX.multipleCleanClosed);
  const first = buildDeterministicCandidateFixtureV1(mutable);
  const bytes = [canonicalJson(first.acquisitionResult), canonicalJson(first.evidenceBundle), canonicalJson(first.candidateSet)];
  const repeated = buildDeterministicCandidateFixtureV1(structuredClone(FIXTURE_MATRIX.multipleCleanClosed));
  const permuted = buildDeterministicCandidateFixtureV1(structuredClone(FIXTURE_MATRIX.multipleCleanClosed), { permuteInput: true });
  assert.deepEqual(bytes, [canonicalJson(repeated.acquisitionResult), canonicalJson(repeated.evidenceBundle), canonicalJson(repeated.candidateSet)]);
  assert.deepEqual(bytes, [canonicalJson(permuted.acquisitionResult), canonicalJson(permuted.evidenceBundle), canonicalJson(permuted.candidateSet)]);
  mutable.events[0].signature = 'mutated-after-build';
  mutable.events.push(structuredClone(mutable.events[0]));
  assert.deepEqual(bytes, [canonicalJson(first.acquisitionResult), canonicalJson(first.evidenceBundle), canonicalJson(first.candidateSet)]);

  const replayed = resolveCandidateSelectionV1({
    candidateSet: JSON.parse(canonicalJson(first.candidateSet)),
    evidenceBundle: JSON.parse(canonicalJson(first.evidenceBundle)),
    selection: {
      candidate_set_digest: first.candidateSet.candidate_set_digest,
      candidate_digest: first.candidateSet.payload.candidates[0].candidate_digest,
    },
  });
  assert.equal(canonicalJson(replayed.slice7_request), canonicalJson(resolve(first, first.candidateSet.payload.candidates[0]).slice7_request));
});

test('unrelated wallet evidence changes the set digest but not unaffected candidate-local identity and requires a new set', () => {
  const baseSpec = structuredClone(FIXTURE_MATRIX.multipleCleanClosed);
  const base = buildDeterministicCandidateFixtureV1(baseSpec);
  const tokenA = candidateFor(base, 'TOKEN-A');
  const changedSpec = structuredClone(baseSpec);
  changedSpec.events.push(
    { token: 'UNRELATED', timestamp: 500, signature: 'unrelated-buy', slot: 50, buy: true, tokenAmount: 2, quoteAmount: 3, quoteMint: USDC_MINT, source: 'deterministic_fixture' },
    { token: 'UNRELATED', timestamp: 600, signature: 'unrelated-sell', slot: 60, buy: false, tokenAmount: 2, quoteAmount: 4, quoteMint: USDC_MINT, source: 'deterministic_fixture' },
  );
  const changed = buildDeterministicCandidateFixtureV1(changedSpec);
  const unchangedTokenA = candidateFor(changed, 'TOKEN-A');
  assert.equal(unchangedTokenA.candidate_digest, tokenA.candidate_digest);
  assert.equal(unchangedTokenA.receipt_scoped_evidence_digest, tokenA.receipt_scoped_evidence_digest);
  assert.notEqual(changed.candidateSet.candidate_set_digest, base.candidateSet.candidate_set_digest);
  assert.notEqual(changed.evidenceBundle.evidence_bundle_digest, base.evidenceBundle.evidence_bundle_digest);
  assert.throws(() => resolveCandidateSelectionV1({
    candidateSet: changed.candidateSet,
    evidenceBundle: changed.evidenceBundle,
    selection: { candidate_set_digest: base.candidateSet.candidate_set_digest, candidate_digest: tokenA.candidate_digest },
  }), error => error.code === 'candidate_set_digest_mismatch');
  assert.equal(resolve(changed, unchangedTokenA).audit.candidate_digest, tokenA.candidate_digest);
});

test('hostile graphs and bounded scale reject safely without accessor or proxy invocation', () => {
  let calls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', { enumerable: true, get() { calls += 1; throw new Error('must not execute'); } });
  assert.throws(() => assertPlainJsonValue(accessor), error => error.code === 'accessor_not_allowed');
  const proxy = new Proxy({}, { ownKeys() { calls += 1; throw new Error('must not execute'); } });
  assert.throws(() => assertPlainJsonValue(proxy), error => error.code === 'proxy_not_allowed');
  assert.equal(calls, 0);

  const named = [];
  named.extra = true;
  assert.throws(() => assertPlainJsonValue(named), error => error.code === 'sparse_array_not_allowed');
  assert.throws(() => assertPlainJsonValue(Object.create(null)), error => error.code === 'custom_prototype_not_allowed');
  assert.throws(() => assertPlainJsonValue(Object.create({ inherited: true })), error => error.code === 'custom_prototype_not_allowed');

  let deep = null;
  for (let index = 0; index < 300; index += 1) deep = [deep];
  assert.throws(() => assertPlainJsonValue(deep), error => error.code === 'json_depth_exceeded');
  let alias = {};
  for (let index = 0; index < 17; index += 1) alias = [alias, alias];
  assert.throws(() => assertPlainJsonValue(alias), error => error.code === 'json_node_limit_exceeded');
  const shared = { value: 1 };
  assert.doesNotThrow(() => assertPlainJsonValue([shared, shared]));

  const boundary = {
    boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH,
    commitment: 'finalized', anchor_slot: 5000, anchor_block_time: 5000, anchor_blockhash: 'scale-boundary',
    history_complete_through_anchor: true, lower_bound_completion_proven: true, boundary_status: 'proven',
  };
  const dense = Array.from({ length: 4000 }, (_, index) => ({ disposition_type: 'unrelated_activity', slot: index + 1, block_time: index + 1 }));
  const coverage = recomputeCoverageV1({ transactionDispositions: dense, normalizedEventRecords: [], activityFindings: [], boundary, inputStatus: COMPLETE_INPUT_STATUS, paginationTerminalReason: 'historical_bound_reached' });
  assert.equal(coverage.transactions_examined, 4000);
  assert.equal(coverage.oldest_observed_slot, 1);
  assert.equal(coverage.newest_observed_slot, 4000);
});

test('duplicate authoritative digests and duplicate candidate references fail closed', () => {
  const built = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.multipleCleanClosed);
  const duplicateEvidence = structuredClone(built.acquisitionResult);
  duplicateEvidence.normalized_event_records.push(structuredClone(duplicateEvidence.normalized_event_records[0]));
  assert.throws(() => buildWalletAcquisitionResultV1(duplicateEvidence), error => error.code === 'duplicate_normalized_event');

  const duplicateSet = structuredClone(built.candidateSet);
  const candidate = structuredClone(duplicateSet.payload.candidates[0]);
  duplicateSet.payload.candidates.push(candidate);
  duplicateSet.candidate_set_digest = computeCandidateSetDigest(duplicateSet);
  assert.throws(() => resolveCandidateSelectionV1({
    candidateSet: duplicateSet,
    evidenceBundle: built.evidenceBundle,
    selection: { candidate_set_digest: duplicateSet.candidate_set_digest, candidate_digest: candidate.candidate_digest },
  }), error => error.code === 'candidate_selection_ambiguous');
});
