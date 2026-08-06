#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWalletAcquisitionResultV1 } from './acquisition-result.mjs';
import { buildActivityFindingV1 } from './activity-findings.mjs';
import { buildWalletCandidateSetV1 } from './builder.mjs';
import { buildCandidateEvidenceBundleV1 } from './evidence-bundle.mjs';
import {
  buildDeterministicCandidateFixtureV1,
  FIXTURE_MATRIX,
  JUP_GOLDEN,
  RAY_GOLDEN,
  USDC_MINT,
  USDT_MINT,
} from './fixtures/deterministic-fixtures.mjs';

const JUP_MINT = JUP_GOLDEN.tokenMint;
const RAY_MINT = RAY_GOLDEN.tokenMint;

function blockingFinding({ type = 'unsupported_activity', token, signature, slot, quote = USDC_MINT, timestamp = 300 + slot }) {
  return {
    type,
    timestamp,
    signature,
    slot,
    tokens: [token],
    quotes: token === quote ? [] : [quote],
    reason: type === 'ambiguous_activity' ? 'ambiguous_swap_direction' : 'unsupported_swap_shape',
  };
}

function candidateMints(result) {
  return result.candidateSet.payload.candidates.map(candidate => candidate.projection.token_mint).sort();
}

function summaryFor(result, tokenMint) {
  return result.candidateSet.payload.blocked_summaries.find(summary => summary.token_mint === tokenMint);
}

test('common quote attack does not suppress a valid JUP USDC candidate', () => {
  const result = buildDeterministicCandidateFixtureV1({
    name: 'common_quote_attack',
    wallet: 'isolation-wallet',
    events: [...JUP_GOLDEN.events],
    findings: [blockingFinding({ token: USDC_MINT, signature: 'quote-finding', slot: 30, timestamp: 1782068815 })],
  });
  const jup = result.candidateSet.payload.candidates.find(candidate => candidate.projection.token_mint === JUP_MINT);
  assert.ok(jup);
  assert.equal(jup.projection.quote_mint, USDC_MINT);
  assert.equal(jup.projection.selection_status, 'selectable');
  assert.ok(summaryFor(result, USDC_MINT));
});

test('a real blocked JUP token has no economics while unrelated RAY remains available', () => {
  const result = buildDeterministicCandidateFixtureV1({
    name: 'real_blocked_position',
    wallet: 'isolation-wallet',
    events: [...JUP_GOLDEN.events, ...RAY_GOLDEN.events],
    findings: [blockingFinding({ token: JUP_MINT, signature: 'jup-finding', slot: 30, timestamp: 1782068815 })],
  });
  assert.ok(!candidateMints(result).includes(JUP_MINT));
  assert.ok(candidateMints(result).includes(RAY_MINT));
  const blocked = summaryFor(result, JUP_MINT);
  assert.ok(blocked);
  assert.equal(blocked.ledger_evidence_status, 'blocked_unsupported_activity');
  assert.equal(blocked.economics_status, 'unavailable');
});

test('two candidates sharing USDC remain independent when one base token is blocked', () => {
  const result = buildDeterministicCandidateFixtureV1({
    ...structuredClone(FIXTURE_MATRIX.multipleCleanClosed),
    findings: [blockingFinding({ token: 'TOKEN-A', signature: 'token-a-finding', slot: 30 })],
  });
  assert.deepEqual(candidateMints(result), ['TOKEN-B']);
  assert.ok(summaryFor(result, 'TOKEN-A'));
});

test('ambiguous precedence consolidates per position token only', () => {
  const result = buildDeterministicCandidateFixtureV1({
    name: 'ambiguous_position_precedence',
    wallet: 'isolation-wallet',
    events: [...JUP_GOLDEN.events, ...RAY_GOLDEN.events],
    findings: [
      blockingFinding({ token: JUP_MINT, signature: 'jup-unsupported', slot: 30, timestamp: 1782068815 }),
      blockingFinding({ type: 'ambiguous_activity', token: JUP_MINT, signature: 'jup-ambiguous', slot: 31, timestamp: 1782068816 }),
    ],
  });
  assert.deepEqual(candidateMints(result), [RAY_MINT]);
  const blocked = summaryFor(result, JUP_MINT);
  assert.equal(blocked.ledger_evidence_status, 'blocked_ambiguous_activity');
  assert.equal(blocked.associated_finding_digests.length, 2);
  assert.equal(result.candidateSet.payload.blocked_summaries.length, 1);
});

test('authoritative events reject permutations while other valid acquisition collections remain canonicalized downstream', () => {
  const spec = {
    name: 'permuted_isolation_evidence',
    wallet: 'isolation-wallet',
    events: [...JUP_GOLDEN.events, ...RAY_GOLDEN.events],
    findings: [
      blockingFinding({ type: 'ambiguous_activity', token: JUP_MINT, signature: 'jup-permutation-finding', slot: 30, timestamp: 1782068815 }),
      blockingFinding({ token: RAY_MINT, signature: 'ray-permutation-finding', slot: 31, quote: USDT_MINT, timestamp: 1782068816 }),
    ],
  };
  const canonical = buildDeterministicCandidateFixtureV1(spec);
  assert.throws(() => buildWalletAcquisitionResultV1({
    ...structuredClone(canonical.acquisitionResult),
    transaction_dispositions: [...canonical.acquisitionResult.transaction_dispositions].reverse(),
    normalized_event_records: [...canonical.acquisitionResult.normalized_event_records].reverse(),
    activity_findings: [...canonical.acquisitionResult.activity_findings].reverse(),
  }), error => error.code === 'event_index_mismatch' || error.code === 'order_invalid');
  const permutedAcquisition = buildWalletAcquisitionResultV1({
    ...structuredClone(canonical.acquisitionResult),
    transaction_dispositions: [...canonical.acquisitionResult.transaction_dispositions].reverse(),
    activity_findings: [...canonical.acquisitionResult.activity_findings].reverse(),
  });
  assert.notDeepEqual(permutedAcquisition.transaction_dispositions, canonical.acquisitionResult.transaction_dispositions);
  assert.deepEqual(permutedAcquisition.normalized_event_records, canonical.acquisitionResult.normalized_event_records);
  assert.notDeepEqual(permutedAcquisition.activity_findings, canonical.acquisitionResult.activity_findings);
  const permutedEvidence = buildCandidateEvidenceBundleV1({
    acquisitionResult: permutedAcquisition,
    markObservations: [],
    profiles: permutedAcquisition.profiles,
  });
  const permutedSet = buildWalletCandidateSetV1({ evidenceBundle: permutedEvidence });
  assert.deepEqual(permutedEvidence, canonical.evidenceBundle);
  assert.deepEqual(permutedSet, canonical.candidateSet);
});

test('affected token and quote mint collections must be disjoint', () => {
  assert.throws(() => buildActivityFindingV1({
    finding_type: 'unsupported_activity',
    severity: 'candidate_blocking',
    impact_scope: 'token_specific',
    time_range: { first_observed_at: 1, last_observed_at: 1, first_observed_slot: 1, last_observed_slot: 1 },
    affected_token_mints: [USDC_MINT],
    affected_quote_mints: [USDC_MINT],
    source_transaction_digests: ['a'.repeat(64)],
    source_event_digests: [],
    reason_codes: ['unsupported_swap_shape'],
    impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
    disclosure_codes: ['activity_not_reconstructable'],
  }), error => error.code === 'invalid_activity_finding');
});
