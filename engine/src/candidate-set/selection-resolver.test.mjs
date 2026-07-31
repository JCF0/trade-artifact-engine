#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWalletAcquisitionResultV1 } from './acquisition-result.mjs';
import { buildWalletCandidateSetV1 } from './builder.mjs';
import { recomputeCoverageV1 } from './coverage.mjs';
import { buildCandidateEvidenceBundleV1 } from './evidence-bundle.mjs';
import { buildDispositionV1, buildEventRecordV1, computeCandidateDigest, computeCandidateSetDigest, computeEvidenceBundleDigest } from './identity.mjs';
import { resolveCandidateSelectionV1 } from './selection-resolver.mjs';
import { GENESIS_HASH } from './schema.mjs';
import { orchestrateTargetedReceiptPackageV1 } from '../receipt-package/targeted-orchestrator.mjs';

const QUOTE_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const profiles = { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1', reconstruction_engine_version: 'artifact_position_ledger_receipt_v1', accounting_method_version: 'weighted_average_position_accounting_v1', mark_profile: null };
const inputStatus = { coverage_status: 'complete', acquisition_complete: true, normalization_complete: true, classification_complete: true, pagination_complete: true, historical_bound_proven: true, chain_boundary_proven: true, truncated: false, capped: false, partial: false, provider_uncertain: false };

function event(fixture, { timestamp, txHash, buy, rawIndex, sourceSlot, tokenAmount, quoteAmount }) {
  return buildEventRecordV1({ source_slot: sourceSlot, slice7_event: {
    wallet: fixture.wallet, timestamp, tx_hash: txHash, source: 'deterministic_fixture',
    token_in_mint: buy ? fixture.quoteMint : fixture.tokenMint,
    token_in_amount: buy ? quoteAmount : tokenAmount,
    token_in_decimals: 6,
    token_out_mint: buy ? fixture.tokenMint : fixture.quoteMint,
    token_out_amount: buy ? tokenAmount : quoteAmount,
    token_out_decimals: 6, extraction_method: 'events_swap', raw_index: rawIndex,
  } });
}

function buildFixture(fixture, extraRecords = []) {
  const records = [
    event(fixture, { timestamp: fixture.firstEventAt, txHash: fixture.buyTx, buy: true, rawIndex: 0, sourceSlot: 10, tokenAmount: fixture.boughtQty, quoteAmount: fixture.boughtQuote }),
    event(fixture, { timestamp: fixture.lastEventAt, txHash: fixture.sellTx, buy: false, rawIndex: 1, sourceSlot: 20, tokenAmount: fixture.soldQty, quoteAmount: fixture.soldQuote }),
    ...extraRecords,
  ];
  records.sort((a, b) => a.source_slot - b.source_slot || a.slice7_event.timestamp - b.slice7_event.timestamp || (a.slice7_event.tx_hash < b.slice7_event.tx_hash ? -1 : 1));
  records.forEach((record, index) => { assert.equal(record.slice7_event.raw_index, index); });
  const dispositions = records.map(record => buildDispositionV1({ tx_hash: record.slice7_event.tx_hash, slot: record.source_slot, block_time: record.slice7_event.timestamp, disposition_type: 'supported_normalized_event', affected_token_mints: [record.slice7_event.token_in_mint, record.slice7_event.token_out_mint].sort(), normalized_event_digests: [record.event_digest], finding_digests: [] })).sort((a, b) => a.slot - b.slot || (a.tx_hash < b.tx_hash ? -1 : 1));
  const scope = { scope_version: 'wallet_candidate_scope_input_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, wallet: fixture.wallet, window: { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1', requested_lookback_seconds: 2592000, initial_before_signature: null, lower_bound: { oldest_allowed_timestamp: fixture.firstEventAt - 1, completion_status: 'proven' } } };
  const boundary = { boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: 'solana', network: 'mainnet-beta', genesis_hash: GENESIS_HASH, commitment: 'finalized', anchor_slot: 100, anchor_block_time: fixture.lastEventAt + 1, anchor_blockhash: 'blockhash', history_complete_through_anchor: true, lower_bound_completion_proven: true, boundary_status: 'proven' };
  const coverage = recomputeCoverageV1({ transactionDispositions: dispositions, normalizedEventRecords: records, activityFindings: [], boundary, inputStatus, paginationTerminalReason: 'historical_bound_reached' });
  const acquisitionResult = buildWalletAcquisitionResultV1({ acquisition_result_version: 'wallet_wide_acquisition_result_v1', scope, profiles, boundary, input_status: inputStatus, coverage, transaction_dispositions: dispositions, normalized_event_records: records, activity_findings: [] });
  const evidenceBundle = buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: [], profiles });
  const candidateSet = buildWalletCandidateSetV1({ evidenceBundle });
  const candidate = candidateSet.payload.candidates.find(item => item.projection.token_mint === fixture.tokenMint);
  return { candidateSet, evidenceBundle, candidate };
}

const SIMPLE = Object.freeze({ wallet: 'wallet', tokenMint: 'TOKEN', quoteMint: QUOTE_USDC, firstEventAt: 100, lastEventAt: 200, buyTx: 'buy', sellTx: 'sell', boughtQty: 5, boughtQuote: 10, soldQty: 5, soldQuote: 12 });

function resolveFixture(fixture = SIMPLE) {
  const built = buildFixture(fixture);
  return { ...built, result: resolveCandidateSelectionV1({ candidateSet: built.candidateSet, evidenceBundle: built.evidenceBundle, selection: { candidate_set_digest: built.candidateSet.candidate_set_digest, candidate_digest: built.candidate.candidate_digest } }) };
}

test('resolves only the two-digest handoff into the exact dry-run Slice 7 request', () => {
  const { result, candidateSet, evidenceBundle, candidate } = resolveFixture();
  assert.equal(result.resolution_version, 'candidate_selection_resolution_v1');
  assert.deepEqual(Object.keys(result), ['resolution_version', 'slice7_request', 'audit']);
  assert.deepEqual(Object.keys(result.slice7_request), ['normalizedEvents', 'inputStatus', 'target', 'profiles', 'mode']);
  assert.deepEqual(result.slice7_request.normalizedEvents.map(item => item.tx_hash), ['buy', 'sell']);
  assert.deepEqual(result.slice7_request.inputStatus, { acquisition_complete: true, normalization_complete: true, pagination_complete: true, truncated: false, capped: false, partial: false, provider_uncertain: false });
  assert.deepEqual(result.slice7_request.target, { wallet: SIMPLE.wallet, token_mint: SIMPLE.tokenMint, receipt_type: 'closed_position', segment_index: 0 });
  assert.deepEqual(result.slice7_request.profiles, { fetch_profile: 'receipt_scoped_transaction_selection_v1', normalization_profile: 'artifact_solana_spot_normalization_v1', reconstruction_engine_version: 'artifact_position_ledger_receipt_v1', accounting_method_version: 'weighted_average_position_accounting_v1' });
  assert.equal(result.slice7_request.mode, 'dry_run');
  assert.deepEqual({ ...result.audit, projection_mapping: undefined }, { candidate_set_digest: candidateSet.candidate_set_digest, evidence_bundle_digest: evidenceBundle.evidence_bundle_digest, candidate_digest: candidate.candidate_digest, receipt_scoped_evidence_digest: candidate.receipt_scoped_evidence_digest, ledger_candidate_hash: candidate.ledger_candidate_hash, projection_mapping: undefined });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.slice7_request.normalizedEvents[0]) && Object.isFrozen(result.audit.projection_mapping));
  assert.equal(JSON.stringify(result.slice7_request).includes('projection_mapping'), false);
  assert.equal(JSON.stringify(result.slice7_request).includes('coverage_status'), false);
});

function expectCode(input, code) {
  assert.throws(() => resolveCandidateSelectionV1(input), error => error.code === code && error.cause === undefined);
}

function resolverInput(built, selection = {}) {
  return {
    candidateSet: built.candidateSet,
    evidenceBundle: built.evidenceBundle,
    selection: {
      candidate_set_digest: built.candidateSet.candidate_set_digest,
      candidate_digest: built.candidate.candidate_digest,
      ...selection,
    },
  };
}

test('rejects every browser-supplied selector, target, economics, mode, and profile field', () => {
  const built = buildFixture(SIMPLE);
  for (const field of ['wallet', 'token_mint', 'receipt_type', 'segment_index', 'candidate_hash', 'realized_pnl_quote', 'expected_receipt_hash', 'mode', 'profiles']) {
    expectCode(resolverInput(built, { [field]: field === 'segment_index' ? 0 : 'attacker' }), 'invalid_candidate_selection');
  }
});

test('enforces exact set membership and evidence binding across replay and unrelated evidence changes', () => {
  const first = buildFixture(SIMPLE);
  const otherFixture = { ...SIMPLE, tokenMint: 'OTHER-TOKEN', buyTx: 'other-buy', sellTx: 'other-sell' };
  const second = buildFixture(otherFixture);
  expectCode({ candidateSet: second.candidateSet, evidenceBundle: second.evidenceBundle, selection: { candidate_set_digest: first.candidateSet.candidate_set_digest, candidate_digest: first.candidate.candidate_digest } }, 'candidate_set_digest_mismatch');
  expectCode({ candidateSet: second.candidateSet, evidenceBundle: second.evidenceBundle, selection: { candidate_set_digest: second.candidateSet.candidate_set_digest, candidate_digest: first.candidate.candidate_digest } }, 'candidate_not_found');
  expectCode({ candidateSet: first.candidateSet, evidenceBundle: second.evidenceBundle, selection: { candidate_set_digest: first.candidateSet.candidate_set_digest, candidate_digest: first.candidate.candidate_digest } }, 'evidence_bundle_not_bound_to_set');

  const unrelatedFixture = { wallet: SIMPLE.wallet, tokenMint: 'UNRELATED', quoteMint: QUOTE_USDC };
  const unrelated = event(unrelatedFixture, { timestamp: 300, txHash: 'unrelated-buy', buy: true, rawIndex: 2, sourceSlot: 30, tokenAmount: 2, quoteAmount: 3 });
  const changed = buildFixture(SIMPLE, [unrelated]);
  assert.equal(changed.candidate.candidate_digest, first.candidate.candidate_digest);
  assert.notEqual(changed.candidateSet.candidate_set_digest, first.candidateSet.candidate_set_digest);
  expectCode({ candidateSet: changed.candidateSet, evidenceBundle: changed.evidenceBundle, selection: { candidate_set_digest: first.candidateSet.candidate_set_digest, candidate_digest: first.candidate.candidate_digest } }, 'candidate_set_digest_mismatch');
  assert.equal(resolveCandidateSelectionV1(resolverInput(changed)).audit.candidate_digest, first.candidate.candidate_digest);
});

test('rejects duplicate or internally forged candidate membership before resolution', () => {
  const built = buildFixture(SIMPLE);
  const duplicateSet = structuredClone(built.candidateSet);
  duplicateSet.payload.candidates.push(structuredClone(duplicateSet.payload.candidates[0]));
  duplicateSet.candidate_set_digest = computeCandidateSetDigest(duplicateSet);
  expectCode({ candidateSet: duplicateSet, evidenceBundle: built.evidenceBundle, selection: { candidate_set_digest: duplicateSet.candidate_set_digest, candidate_digest: built.candidate.candidate_digest } }, 'candidate_selection_ambiguous');

  const forgedSet = structuredClone(built.candidateSet);
  const forged = forgedSet.payload.candidates.find(item => item.candidate_digest === built.candidate.candidate_digest);
  forged.projection.economics.realized_pnl_quote += 1;
  forgedSet.candidate_set_digest = computeCandidateSetDigest(forgedSet);
  expectCode({ candidateSet: forgedSet, evidenceBundle: built.evidenceBundle, selection: { candidate_set_digest: forgedSet.candidate_set_digest, candidate_digest: forged.candidate_digest } }, 'candidate_not_member_of_set');
});

test('rejects self-hashed candidate economics that do not reconstruct from evidence', () => {
  const built = buildFixture(SIMPLE);
  const candidateSet = structuredClone(built.candidateSet);
  const candidate = candidateSet.payload.candidates.find(item => item.candidate_digest === built.candidate.candidate_digest);
  candidate.projection.economics.realized_pnl_quote = 999999;
  candidate.candidate_digest = computeCandidateDigest(candidate);
  candidate.candidate_id = `acv1_${candidate.candidate_digest}`;
  candidate.handoff.candidate_digest = candidate.candidate_digest;
  candidateSet.payload.candidates.sort((left, right) => left.candidate_digest < right.candidate_digest ? -1 : left.candidate_digest > right.candidate_digest ? 1 : 0);
  candidateSet.candidate_set_digest = computeCandidateSetDigest(candidateSet);
  expectCode({ candidateSet, evidenceBundle: built.evidenceBundle, selection: { candidate_set_digest: candidateSet.candidate_set_digest, candidate_digest: candidate.candidate_digest } }, 'evidence_bundle_not_bound_to_set');
});

test('distinguishes candidate-set and evidence-bundle digest failures', () => {
  const built = buildFixture(SIMPLE);
  const badSet = structuredClone(built.candidateSet);
  badSet.payload.counts.candidate_count += 1;
  expectCode({ ...resolverInput(built), candidateSet: badSet }, 'candidate_set_digest_mismatch');
  const badEvidence = structuredClone(built.evidenceBundle);
  badEvidence.payload.boundary.anchor_blockhash = 'changed';
  expectCode({ ...resolverInput(built), evidenceBundle: badEvidence }, 'evidence_bundle_digest_mismatch');

  const rehashedEvidence = structuredClone(built.evidenceBundle);
  rehashedEvidence.payload.boundary.anchor_blockhash = 'changed';
  rehashedEvidence.evidence_bundle_digest = computeEvidenceBundleDigest(rehashedEvidence);
  expectCode({ ...resolverInput(built), evidenceBundle: rehashedEvidence }, 'evidence_bundle_not_bound_to_set');
});

test('selecting authentic open, realized-partial, or limited candidates fails closed and status fields do not leak', () => {
  const openFixture = { wallet: SIMPLE.wallet, tokenMint: 'OPEN-TOKEN', quoteMint: QUOTE_USDC };
  const partialFixture = { wallet: SIMPLE.wallet, tokenMint: 'PARTIAL-TOKEN', quoteMint: QUOTE_USDC };
  const limitedFixture = { wallet: SIMPLE.wallet, tokenMint: 'LIMITED-TOKEN', quoteMint: QUOTE_USDC };
  const records = [
    event(openFixture, { timestamp: 300, txHash: 'open-buy', buy: true, rawIndex: 2, sourceSlot: 30, tokenAmount: 2, quoteAmount: 3 }),
    event(partialFixture, { timestamp: 400, txHash: 'partial-buy', buy: true, rawIndex: 3, sourceSlot: 40, tokenAmount: 2, quoteAmount: 3 }),
    event(partialFixture, { timestamp: 500, txHash: 'partial-sell', buy: false, rawIndex: 4, sourceSlot: 50, tokenAmount: 1, quoteAmount: 2 }),
    event(limitedFixture, { timestamp: 600, txHash: 'limited-sell', buy: false, rawIndex: 5, sourceSlot: 60, tokenAmount: 1, quoteAmount: 2 }),
  ];
  const built = buildFixture(SIMPLE, records);
  for (const tokenMint of [openFixture.tokenMint, partialFixture.tokenMint, limitedFixture.tokenMint]) {
    const candidate = built.candidateSet.payload.candidates.find(item => item.projection.token_mint === tokenMint);
    assert.ok(candidate);
    expectCode({ candidateSet: built.candidateSet, evidenceBundle: built.evidenceBundle, selection: { candidate_set_digest: built.candidateSet.candidate_set_digest, candidate_digest: candidate.candidate_digest } }, 'candidate_not_selectable');
  }
  const limited = built.candidateSet.payload.candidates.find(item => item.projection.token_mint === limitedFixture.tokenMint);
  assert.equal(limited.projection.ledger_evidence_status, 'limited_partial_history');
  const closed = resolveCandidateSelectionV1(resolverInput(built));
  assert.deepEqual(Object.keys(closed.slice7_request.inputStatus), ['acquisition_complete', 'normalization_complete', 'pagination_complete', 'truncated', 'capped', 'partial', 'provider_uncertain']);
  assert.equal(JSON.stringify(closed.slice7_request).includes('classification_complete'), false);
  assert.equal(JSON.stringify(closed.slice7_request).includes('coverage_status'), false);
});

test('uses the dedicated publication-eligibility error for a selectable but publication-ineligible member', () => {
  const built = buildFixture(SIMPLE);
  const candidateSet = structuredClone(built.candidateSet);
  const candidate = candidateSet.payload.candidates.find(item => item.candidate_digest === built.candidate.candidate_digest);
  candidate.projection.package_eligibility = 'ineligible';
  candidate.candidate_digest = computeCandidateDigest(candidate);
  candidate.candidate_id = `acv1_${candidate.candidate_digest}`;
  candidate.handoff.candidate_digest = candidate.candidate_digest;
  candidateSet.payload.candidates.sort((left, right) => left.candidate_digest < right.candidate_digest ? -1 : left.candidate_digest > right.candidate_digest ? 1 : 0);
  candidateSet.candidate_set_digest = computeCandidateSetDigest(candidateSet);
  expectCode({ candidateSet, evidenceBundle: built.evidenceBundle, selection: { candidate_set_digest: candidateSet.candidate_set_digest, candidate_digest: candidate.candidate_digest } }, 'candidate_not_publication_eligible');
});

test('retains complete same-mint history so a nonzero segment regenerates exactly', () => {
  const secondBuy = event(SIMPLE, { timestamp: 300, txHash: 'buy-2', buy: true, rawIndex: 2, sourceSlot: 30, tokenAmount: 4, quoteAmount: 8 });
  const secondSell = event(SIMPLE, { timestamp: 400, txHash: 'sell-2', buy: false, rawIndex: 3, sourceSlot: 40, tokenAmount: 4, quoteAmount: 11 });
  const built = buildFixture(SIMPLE, [secondBuy, secondSell]);
  const candidate = built.candidateSet.payload.candidates.find(item => item.projection.token_mint === SIMPLE.tokenMint && item.projection.segment_index === 1);
  const result = resolveCandidateSelectionV1({ candidateSet: built.candidateSet, evidenceBundle: built.evidenceBundle, selection: { candidate_set_digest: built.candidateSet.candidate_set_digest, candidate_digest: candidate.candidate_digest } });
  assert.equal(result.slice7_request.target.segment_index, 1);
  assert.deepEqual(result.slice7_request.normalizedEvents.map(item => item.tx_hash), ['buy', 'sell', 'buy-2', 'sell-2']);
  assert.equal(result.audit.ledger_candidate_hash, candidate.ledger_candidate_hash);
});

test('enforces Solana mainnet-beta and its frozen genesis before Slice 7 derivation', () => {
  const built = buildFixture(SIMPLE);
  function changed(field, value) {
    const candidateSet = structuredClone(built.candidateSet);
    const evidenceBundle = structuredClone(built.evidenceBundle);
    candidateSet.payload.scope[field] = value;
    evidenceBundle.payload.scope[field] = value;
    candidateSet.candidate_set_digest = computeCandidateSetDigest(candidateSet);
    evidenceBundle.evidence_bundle_digest = computeEvidenceBundleDigest(evidenceBundle);
    return { candidateSet, evidenceBundle, selection: { candidate_set_digest: candidateSet.candidate_set_digest, candidate_digest: built.candidate.candidate_digest } };
  }
  expectCode(changed('network', 'devnet'), 'unsupported_network');
  expectCode(changed('genesis_hash', 'wrong-genesis'), 'network_genesis_mismatch');
});

test('recomputes receipt-scoped evidence and the regenerated ledger candidate hash', () => {
  const built = buildFixture(SIMPLE);
  function forged(field, value) {
    const candidateSet = structuredClone(built.candidateSet);
    const candidate = candidateSet.payload.candidates.find(item => item.candidate_digest === built.candidate.candidate_digest);
    candidate[field] = value;
    candidate.handoff[field] = value;
    candidate.candidate_digest = computeCandidateDigest(candidate);
    candidate.candidate_id = `acv1_${candidate.candidate_digest}`;
    candidate.handoff.candidate_digest = candidate.candidate_digest;
    candidateSet.payload.candidates.sort((left, right) => left.candidate_digest < right.candidate_digest ? -1 : left.candidate_digest > right.candidate_digest ? 1 : 0);
    candidateSet.candidate_set_digest = computeCandidateSetDigest(candidateSet);
    return { candidateSet, candidate };
  }
  const changedEvidence = forged('receipt_scoped_evidence_digest', '0'.repeat(64));
  expectCode({ candidateSet: changedEvidence.candidateSet, evidenceBundle: built.evidenceBundle, selection: { candidate_set_digest: changedEvidence.candidateSet.candidate_set_digest, candidate_digest: changedEvidence.candidate.candidate_digest } }, 'receipt_scoped_evidence_digest_mismatch');
  const changedLedger = forged('ledger_candidate_hash', '0'.repeat(64));
  expectCode({ candidateSet: changedLedger.candidateSet, evidenceBundle: built.evidenceBundle, selection: { candidate_set_digest: changedLedger.candidateSet.candidate_set_digest, candidate_digest: changedLedger.candidate.candidate_digest } }, 'ledger_candidate_hash_mismatch');
});

test('rejects malicious accessors and proxies without invocation and detaches caller mutation', () => {
  const built = buildFixture(SIMPLE);
  let calls = 0;
  const selection = {};
  Object.defineProperty(selection, 'candidate_set_digest', { enumerable: true, get() { calls += 1; throw new Error('secret path'); } });
  Object.defineProperty(selection, 'candidate_digest', { enumerable: true, value: built.candidate.candidate_digest });
  expectCode({ candidateSet: built.candidateSet, evidenceBundle: built.evidenceBundle, selection }, 'invalid_candidate_selection');
  assert.equal(calls, 0);
  expectCode({ candidateSet: built.candidateSet, evidenceBundle: built.evidenceBundle, selection: new Proxy({}, { ownKeys() { calls += 1; throw new Error('secret path'); } }) }, 'invalid_candidate_selection');
  assert.equal(calls, 0);

  const topLevel = { candidateSet: built.candidateSet, evidenceBundle: built.evidenceBundle, selection: resolverInput(built).selection };
  Object.defineProperty(topLevel, 'candidateSet', { enumerable: true, get() { calls += 1; throw new Error('secret path'); } });
  expectCode(topLevel, 'invalid_candidate_selection');
  assert.equal(calls, 0);

  const nestedCandidateSet = structuredClone(built.candidateSet);
  Object.defineProperty(nestedCandidateSet.payload.scope, 'wallet', { enumerable: true, get() { calls += 1; throw new Error('secret path'); } });
  expectCode({ candidateSet: nestedCandidateSet, evidenceBundle: built.evidenceBundle, selection: resolverInput(built).selection }, 'invalid_candidate_selection');
  assert.equal(calls, 0);

  const nestedEvidence = structuredClone(built.evidenceBundle);
  nestedEvidence.payload = new Proxy({}, { ownKeys() { calls += 1; throw new Error('secret path'); } });
  expectCode({ candidateSet: built.candidateSet, evidenceBundle: nestedEvidence, selection: resolverInput(built).selection }, 'invalid_candidate_selection');
  assert.equal(calls, 0);

  const input = resolverInput(built);
  const result = resolveCandidateSelectionV1(input);
  input.selection.candidate_digest = '0'.repeat(64);
  input.candidateSet = null;
  assert.equal(result.audit.candidate_digest, built.candidate.candidate_digest);
  assert.throws(() => { result.slice7_request.target.segment_index = 9; }, TypeError);
});

const PINNED = [
  {
    wallet: '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni', tokenMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', quoteMint: QUOTE_USDC,
    firstEventAt: 1781904268, lastEventAt: 1782068814, buyTx: '2ArLuJC2JEuWiavk1jYxLQ2E4xhq63BbeDV2kCWPcZ9zZNc4XyugUEFEryKrYfqcWnxkUvyacRmj2YNTfZGq17yV', sellTx: '5YCdUYkJVx3kkZUpvz4ygs6QT8GZtYtru4kGkur3LJ8yrMmW2XJ8qXtgjspMpJqqyQA6WPDQxd4BcTpNNSr3Dctk', boughtQty: 265951.319268, boughtQuote: 49728.694003, soldQty: 265951.319268, soldQuote: 58016.53285,
    receiptHash: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca', packageDigest: '5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278',
    memberHashes: { 'archive-record.json': 'd28c5a58b920f526c5ed9e08e4e5b034d99285cd7182a1374f1eb9c10697c6ac', 'canonical-receipt.json': 'c636cfda958eb87341d3225d33b53b7dc9dcf157def5cc3a054eb56cd4e9eb61', 'economics.json': 'd8d716459707f3b8c7f95b2f6e64a3c1f1faf91e62629e0477213e4b4ed9ffbd', 'manifest.json': '2ce234ccedcb52ac555f49129de7a3b6660506b04ed452c02503ec626646f1f6', 'verification.json': '851c283e7e321bee61a939f1b39dbfb1f09ec038cdd078ceca50c8f7167c6ad0' },
  },
  {
    wallet: '5fK3484fbh8gnmhvTsPYxTC6un7Co5LVUSoubZPVL3YA', tokenMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', quoteMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    firstEventAt: 1769382291, lastEventAt: 1769632666, buyTx: '2SUoNBBTkQBBGVCinvLQbVZq5LDZS5M8ikx5PLH7QiCuLdf6GWCPSM7wLd6gJsNUbLSousAhbkSX9eXgt1dAeBKm', sellTx: '4TmWRpMxWRTpQqNM7iFCRyP1m9VEyRK54VZwKeQV4cYisYRjQRjuvocF8j7mNAomoQf6H2h4vfd5Qp6Y2LQxeEsB', boughtQty: 26644.791399, boughtQuote: 25000, soldQty: 26644.791399, soldQuote: 27347.717902,
    receiptHash: '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341', packageDigest: '25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2',
    memberHashes: { 'archive-record.json': '777987cf14a3e41034923a6acc0e87ce15ec7affef68b0e3fb32890ad24bd695', 'canonical-receipt.json': '94717ca77018826e88bf39313c7b4b810ade1d42ed9f507809c649f1f6f3f2cb', 'economics.json': '4664d29a151bba54051c4a8ef6044990a2ca474a4b45a421536106e9fa5d0ea8', 'manifest.json': '9fffd0746b49b5e3b89dbf113675c76290c7ae10f99542a23b1c385e3c75b41e', 'verification.json': '808c2d03cd54bb13ed418ea034075dc8b523cb01e6a9ce3359d2959498141e6d' },
  },
];

test('resolver-produced JUP and RAY dry-run requests preserve pinned receipt and package identity', async () => {
  for (const fixture of PINNED) {
    const resolved = resolveFixture(fixture).result;
    const orchestrated = await orchestrateTargetedReceiptPackageV1(resolved.slice7_request, {});
    assert.equal(orchestrated.receipt_hash, fixture.receiptHash);
    assert.equal(orchestrated.package_digest, fixture.packageDigest);
    assert.deepEqual(orchestrated.member_hashes, fixture.memberHashes);
  }
});

export { buildFixture, resolveFixture };
