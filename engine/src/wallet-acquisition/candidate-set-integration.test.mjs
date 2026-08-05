#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWalletCandidateSetV1 } from '../candidate-set/builder.mjs';
import { buildCandidateEvidenceBundleV1 } from '../candidate-set/evidence-bundle.mjs';
import { JUP_GOLDEN, RAY_GOLDEN } from '../candidate-set/fixtures/deterministic-fixtures.mjs';
import { resolveCandidateSelectionV1 } from '../candidate-set/selection-resolver.mjs';
import { canonicalJson } from '../candidate-set/serialize.mjs';
import { orchestrateTargetedReceiptPackageV1 } from '../receipt-package/targeted-orchestrator.mjs';
import { acquireWalletHistoryV1 } from './orchestrator.mjs';
import { providerPublicKey } from './fixtures/slice4-fixtures.mjs';
import {
  JUP_MINT_V1,
  JUP_WALLET_V1,
  RAY_MINT_V1,
  RAY_WALLET_V1,
  USDC_MINT_V1,
  USDT_MINT_V1,
  offlineWalletHistoryFixtureV1,
  syntheticEnhancedBodyV1,
  syntheticTransferBodyV1,
} from './fixtures/retained-provider-fixtures.mjs';

const MEMBER_NAMES = ['archive-record.json', 'canonical-receipt.json', 'economics.json', 'manifest.json', 'verification.json'];

async function buildBridge(fixture) {
  const acquisitionResult = await acquireWalletHistoryV1(fixture.request, { walletHistoryPort: fixture.port });
  const evidenceBundle = buildCandidateEvidenceBundleV1({
    acquisitionResult,
    markObservations: [],
    profiles: acquisitionResult.profiles,
  });
  const candidateSet = buildWalletCandidateSetV1({ evidenceBundle });
  return { acquisitionResult, evidenceBundle, candidateSet };
}

function candidateFor(built, tokenMint) {
  const matches = built.candidateSet.payload.candidates.filter(candidate => candidate.projection.token_mint === tokenMint);
  assert.equal(matches.length, 1, `expected one candidate for ${tokenMint}`);
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

async function packageCandidate(built, candidate) {
  const resolution = resolve(built, candidate);
  assert.deepEqual(Object.keys(resolution.slice7_request), ['normalizedEvents', 'inputStatus', 'target', 'profiles', 'mode']);
  assert.equal(resolution.slice7_request.mode, 'dry_run');
  const packageResult = await orchestrateTargetedReceiptPackageV1(resolution.slice7_request, {});
  assert.equal(packageResult.status, 'dry_run');
  return { resolution, packageResult };
}

for (const value of [
  { name: 'JUP', wallet: JUP_WALLET_V1, retainedBodyNames: ['jup_buy', 'jup_sell'], tokenMint: JUP_MINT_V1, golden: JUP_GOLDEN },
  { name: 'RAY', wallet: RAY_WALLET_V1, retainedBodyNames: ['ray_buy', 'ray_sell'], tokenMint: RAY_MINT_V1, golden: RAY_GOLDEN },
]) {
  test(`acquireWalletHistoryV1 complete ${value.name} bridge preserves exact Slice 7 receipt, package, and member identities without a store`, async () => {
    const fixture = offlineWalletHistoryFixtureV1({ wallet: value.wallet, retainedBodyNames: value.retainedBodyNames });
    const built = await buildBridge(fixture);
    const candidate = candidateFor(built, value.tokenMint);
    assert.equal(candidate.projection.candidate_type, 'closed_position');
    assert.equal(candidate.projection.selection_status, 'selectable');
    const { resolution, packageResult } = await packageCandidate(built, candidate);
    assert.equal(resolution.slice7_request.target.wallet, value.wallet);
    assert.equal(resolution.slice7_request.target.token_mint, value.tokenMint);
    assert.equal(resolution.slice7_request.target.receipt_type, 'closed_position');
    assert.equal(resolution.slice7_request.target.segment_index, 0);
    assert.equal(packageResult.receipt_hash, value.golden.receiptHash);
    assert.equal(packageResult.package_digest, value.golden.packageDigest);
    assert.deepEqual(Object.keys(packageResult.member_hashes).sort(), MEMBER_NAMES);
    assert.deepEqual(packageResult.member_hashes, value.golden.memberHashes);
  });
}

test('provider response permutation, permitted synthetic full-page prefix, repeated construction, and dense indexing are byte invariant through resolution', async () => {
  const direct = await buildBridge(offlineWalletHistoryFixtureV1({
    wallet: RAY_WALLET_V1,
    retainedBodyNames: ['ray_buy', 'ray_sell'],
  }));
  const permuted = await buildBridge(offlineWalletHistoryFixtureV1({
    wallet: RAY_WALLET_V1,
    retainedBodyNames: ['ray_buy', 'ray_sell'],
    enhancedOrder: 'reversed',
    pageLayout: 'synthetic_full_prefix',
  }));
  const repeated = await buildBridge(offlineWalletHistoryFixtureV1({
    wallet: RAY_WALLET_V1,
    retainedBodyNames: ['ray_buy', 'ray_sell'],
  }));
  for (const other of [permuted, repeated]) {
    assert.equal(canonicalJson(other.acquisitionResult), canonicalJson(direct.acquisitionResult));
    assert.equal(canonicalJson(other.evidenceBundle), canonicalJson(direct.evidenceBundle));
    assert.equal(canonicalJson(other.candidateSet), canonicalJson(direct.candidateSet));
  }
  assert.deepEqual(direct.acquisitionResult.normalized_event_records.map(record => record.slice7_event.raw_index), [0, 1]);
  const directCandidate = candidateFor(direct, RAY_MINT_V1);
  const permutedCandidate = candidateFor(permuted, RAY_MINT_V1);
  assert.equal(permutedCandidate.candidate_digest, directCandidate.candidate_digest);
  assert.equal(permutedCandidate.receipt_scoped_evidence_digest, directCandidate.receipt_scoped_evidence_digest);
  assert.equal(canonicalJson(resolve(permuted, permutedCandidate)), canonicalJson(resolve(direct, directCandidate)));
});

test('caller input mutation after fixture and artifact construction cannot change acquisition, evidence, candidate, or resolver bytes', async () => {
  const token = providerPublicKey('mutation-token');
  const syntheticBodies = [
    syntheticEnhancedBodyV1({ label: 'mutation-buy', wallet: JUP_WALLET_V1, slot: 428001220, timestamp: 1782068824, outputMint: token, outputRaw: '5000000' }),
    syntheticEnhancedBodyV1({ label: 'mutation-sell', wallet: JUP_WALLET_V1, slot: 428001221, timestamp: 1782068825, inputMint: token, inputRaw: '5000000', outputMint: USDC_MINT_V1, outputRaw: '12000000' }),
  ];
  const fixture = offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1, syntheticBodies });
  syntheticBodies[0].signature = 'mutated-after-port-construction';
  const built = await buildBridge(fixture);
  const candidate = candidateFor(built, token);
  const before = [canonicalJson(built.acquisitionResult), canonicalJson(built.evidenceBundle), canonicalJson(built.candidateSet), canonicalJson(resolve(built, candidate))];
  fixture.request.window.lookback_profile = 'mutated-after-acquisition';
  syntheticBodies.push(structuredClone(syntheticBodies[1]));
  assert.deepEqual(before, [canonicalJson(built.acquisitionResult), canonicalJson(built.evidenceBundle), canonicalJson(built.candidateSet), canonicalJson(resolve(built, candidate))]);
});

test('multiple clean closed candidates in one acquired wallet are independently selectable', async () => {
  const otherToken = providerPublicKey('second-clean-token');
  const syntheticBodies = [
    syntheticEnhancedBodyV1({ label: 'second-buy', wallet: JUP_WALLET_V1, slot: 428001220, timestamp: 1782068824, outputMint: otherToken, outputRaw: '5000000' }),
    syntheticEnhancedBodyV1({ label: 'second-sell', wallet: JUP_WALLET_V1, slot: 428001221, timestamp: 1782068825, inputMint: otherToken, inputRaw: '5000000', outputMint: USDC_MINT_V1, outputRaw: '12000000' }),
  ];
  const built = await buildBridge(offlineWalletHistoryFixtureV1({
    wallet: JUP_WALLET_V1,
    retainedBodyNames: ['jup_buy', 'jup_sell'],
    syntheticBodies,
  }));
  assert.equal(built.candidateSet.payload.counts.selectable_candidate_count, 2);
  for (const tokenMint of [JUP_MINT_V1, otherToken]) {
    const candidate = candidateFor(built, tokenMint);
    assert.equal(resolve(built, candidate).slice7_request.target.token_mint, tokenMint);
  }
});

for (const value of [
  { name: 'unsupported', type: 'unsupported_activity', expectedStatus: 'blocked_unsupported_activity', selfTransfer: false },
  { name: 'ambiguous', type: 'ambiguous_activity', expectedStatus: 'blocked_ambiguous_activity', selfTransfer: true },
]) {
  test(`localized ${value.name} activity blocks only its affected token while retained JUP remains selectable`, async () => {
    const blockedToken = providerPublicKey(`${value.name}-blocked-token`);
    const body = value.selfTransfer
      ? syntheticEnhancedBodyV1({ label: `${value.name}-local`, wallet: JUP_WALLET_V1, slot: 428001220, timestamp: 1782068824, type: 'TRANSFER', outputMint: blockedToken, selfTransfer: true, recognizedProgram: false })
      : syntheticTransferBodyV1({ label: `${value.name}-local`, wallet: JUP_WALLET_V1, slot: 428001220, timestamp: 1782068824, inputMint: blockedToken, outputMint: USDC_MINT_V1 });
    const built = await buildBridge(offlineWalletHistoryFixtureV1({
      wallet: JUP_WALLET_V1,
      retainedBodyNames: ['jup_buy', 'jup_sell'],
      syntheticBodies: [body],
    }));
    const disposition = built.acquisitionResult.transaction_dispositions.find(item => item.tx_hash === body.signature);
    assert.equal(disposition.disposition_type, value.type);
    const blocked = built.candidateSet.payload.blocked_summaries.find(summary => summary.token_mint === blockedToken);
    assert.equal(blocked.ledger_evidence_status, value.expectedStatus);
    assert.equal(built.candidateSet.payload.candidates.some(candidate => candidate.projection.token_mint === blockedToken), false);
    assert.equal(candidateFor(built, JUP_MINT_V1).projection.selection_status, 'selectable');
  });
}

test('wallet-wide ambiguity stops before evidence-bundle or candidate-set issuance', async () => {
  const body = syntheticEnhancedBodyV1({
    label: 'wallet-wide-ambiguous',
    wallet: JUP_WALLET_V1,
    slot: 428001220,
    timestamp: 1782068824,
    type: 'TRANSFER',
    selfTransfer: true,
    omitSelfTransferMint: true,
    recognizedProgram: false,
  });
  const fixture = offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1, syntheticBodies: [body] });
  assert.equal(fixture.evidenceFidelity.enhancedBodies, 'clearly_synthetic_enhanced_bodies');
  let acquisitionResult;
  await assert.rejects(
    async () => { acquisitionResult = await acquireWalletHistoryV1(fixture.request, { walletHistoryPort: fixture.port }); },
    error => error.code === 'wallet_wide_impact_unresolved',
  );
  assert.equal(acquisitionResult, undefined);
});

test('unrelated quote-only and failed transactions are disposition-accounted without changing clean candidate economics or package identity', async () => {
  const base = await buildBridge(offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1, retainedBodyNames: ['jup_buy', 'jup_sell'] }));
  const quoteOnly = syntheticTransferBodyV1({ label: 'quote-only', wallet: JUP_WALLET_V1, slot: 428001220, timestamp: 1782068824, inputMint: USDC_MINT_V1, outputMint: USDT_MINT_V1 });
  const failed = syntheticEnhancedBodyV1({ label: 'failed', wallet: JUP_WALLET_V1, slot: 428001221, timestamp: 1782068825, failed: true });
  const changed = await buildBridge(offlineWalletHistoryFixtureV1({
    wallet: JUP_WALLET_V1,
    retainedBodyNames: ['jup_buy', 'jup_sell'],
    syntheticBodies: [quoteOnly, failed],
  }));
  const types = new Map(changed.acquisitionResult.transaction_dispositions.map(item => [item.tx_hash, item.disposition_type]));
  assert.equal(types.get(quoteOnly.signature), 'unrelated_activity');
  assert.equal(types.get(failed.signature), 'failed_transaction');
  assert.equal(changed.acquisitionResult.normalized_event_records.length, 2);
  const baseCandidate = candidateFor(base, JUP_MINT_V1);
  const changedCandidate = candidateFor(changed, JUP_MINT_V1);
  assert.equal(changedCandidate.candidate_digest, baseCandidate.candidate_digest);
  assert.deepEqual(changedCandidate.projection.economics, baseCandidate.projection.economics);
  const changedPackage = await packageCandidate(changed, changedCandidate);
  assert.equal(changedPackage.packageResult.receipt_hash, JUP_GOLDEN.receiptHash);
  assert.equal(changedPackage.packageResult.package_digest, JUP_GOLDEN.packageDigest);
});

test('unrelated later wallet evidence changes set identity while candidate-local and closed package identities remain stable', async () => {
  const base = await buildBridge(offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1, retainedBodyNames: ['jup_buy', 'jup_sell'] }));
  const unrelated = syntheticTransferBodyV1({ label: 'later-unrelated', wallet: JUP_WALLET_V1, slot: 428001230, timestamp: 1782068834, inputMint: USDC_MINT_V1, outputMint: USDT_MINT_V1 });
  const changed = await buildBridge(offlineWalletHistoryFixtureV1({
    wallet: JUP_WALLET_V1,
    retainedBodyNames: ['jup_buy', 'jup_sell'],
    syntheticBodies: [unrelated],
  }));
  const baseCandidate = candidateFor(base, JUP_MINT_V1);
  const changedCandidate = candidateFor(changed, JUP_MINT_V1);
  assert.notEqual(changed.evidenceBundle.evidence_bundle_digest, base.evidenceBundle.evidence_bundle_digest);
  assert.notEqual(changed.candidateSet.candidate_set_digest, base.candidateSet.candidate_set_digest);
  assert.equal(changedCandidate.candidate_digest, baseCandidate.candidate_digest);
  assert.equal(changedCandidate.receipt_scoped_evidence_digest, baseCandidate.receipt_scoped_evidence_digest);
  const { packageResult } = await packageCandidate(changed, changedCandidate);
  assert.equal(packageResult.receipt_hash, JUP_GOLDEN.receiptHash);
  assert.equal(packageResult.package_digest, JUP_GOLDEN.packageDigest);
});

test('source, disposition, event, finding, and coverage counts reconcile exactly across all localized disposition classes', async () => {
  const unsupportedToken = providerPublicKey('count-unsupported-token');
  const ambiguousToken = providerPublicKey('count-ambiguous-token');
  const unsupported = syntheticTransferBodyV1({ label: 'count-unsupported', wallet: JUP_WALLET_V1, slot: 428001220, timestamp: 1782068824, inputMint: unsupportedToken, outputMint: USDC_MINT_V1 });
  const ambiguous = syntheticEnhancedBodyV1({ label: 'count-ambiguous', wallet: JUP_WALLET_V1, slot: 428001221, timestamp: 1782068825, type: 'TRANSFER', outputMint: ambiguousToken, selfTransfer: true, recognizedProgram: false });
  const unrelated = syntheticTransferBodyV1({ label: 'count-unrelated', wallet: JUP_WALLET_V1, slot: 428001222, timestamp: 1782068826, inputMint: USDC_MINT_V1, outputMint: USDT_MINT_V1 });
  const failed = syntheticEnhancedBodyV1({ label: 'count-failed', wallet: JUP_WALLET_V1, slot: 428001223, timestamp: 1782068827, failed: true });
  const bodies = [unsupported, ambiguous, unrelated, failed];
  const fixture = offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1, retainedBodyNames: ['jup_buy', 'jup_sell'], syntheticBodies: bodies });
  const built = await buildBridge(fixture);
  const result = built.acquisitionResult;
  const expectedSignatures = fixture.exactRetainedBodies.map(body => body.signature);
  expectedSignatures.push(...bodies.map(body => body.signature));
  assert.deepEqual(new Set(result.transaction_dispositions.map(item => item.tx_hash)), new Set(expectedSignatures));
  assert.equal(result.transaction_dispositions.length, 6);
  assert.equal(result.normalized_event_records.length, 2);
  assert.equal(result.activity_findings.length, 2);
  assert.deepEqual(result.coverage, built.evidenceBundle.payload.coverage);
  assert.equal(result.coverage.transactions_examined, 6);
  assert.equal(result.coverage.supported_transaction_count, 2);
  assert.equal(result.coverage.unsupported_transaction_count, 1);
  assert.equal(result.coverage.ambiguous_transaction_count, 1);
  assert.equal(result.coverage.unrelated_transaction_count, 1);
  assert.equal(result.coverage.failed_transaction_count, 1);
  assert.equal(result.coverage.normalized_event_count, 2);
  assert.equal(result.coverage.finding_count, 2);
});
