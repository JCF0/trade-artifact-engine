#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildActivityFindingV1 } from './activity-findings.mjs';
import { computeBlockedSummaryDigest, computeCandidateSetDigest, computeSourceTransactionDigest } from './identity.mjs';
import { buildBlockedTokenOverlayV1, buildBlockedSummariesV1 } from './blocked-summary.mjs';
import { buildDeterministicCandidateFixtureV1, FIXTURE_MATRIX } from './fixtures/deterministic-fixtures.mjs';
import { validateCandidateSetV1 } from './schema.mjs';
import { providerPublicKey, providerSignature } from '../wallet-acquisition/fixtures/test-identities.mjs';

const TOKEN_A = providerPublicKey('TOKEN-A');
const TOKEN_B = providerPublicKey('TOKEN-B');
const WALLET = providerPublicKey('wallet');
const source = computeSourceTransactionDigest({ tx_hash: providerSignature('tx'), slot: 10, block_time: 100 });
function finding({ type = 'unsupported_activity', tokens, reason, disclosure = 'activity_not_reconstructable' }) {
  return buildActivityFindingV1({
    finding_type: type,
    severity: 'candidate_blocking',
    impact_scope: 'token_specific',
    time_range: { first_observed_at: 100, last_observed_at: 100, first_observed_slot: 10, last_observed_slot: 10 },
    affected_token_mints: tokens,
    affected_quote_mints: [],
    source_transaction_digests: [source],
    source_event_digests: [],
    reason_codes: [reason],
    impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
    disclosure_codes: [disclosure],
  });
}
const unsupported = finding({ tokens: [TOKEN_A, TOKEN_B], reason: 'unsupported_swap_shape' });
const ambiguous = finding({ type: 'ambiguous_activity', tokens: [TOKEN_B], reason: 'ambiguous_swap_direction' });
const overlay = buildBlockedTokenOverlayV1({ activityFindings: [ambiguous, unsupported] });
assert.deepEqual(overlay.blockedTokenMints, [TOKEN_A, TOKEN_B].sort());
const tokenBFindings = overlay.findingsByToken.find(group => group.token_mint === TOKEN_B).findings;
assert.equal(tokenBFindings.length, 2);
assert.ok(Object.isFrozen(overlay) && Object.isFrozen(overlay.blockedTokenMints) && Object.isFrozen(overlay.findingsByToken) && Object.isFrozen(tokenBFindings));
assert.throws(() => overlay.blockedTokenMints.pop(), TypeError);
assert.throws(() => overlay.findingsByToken.pop(), TypeError);
assert.throws(() => tokenBFindings.pop(), TypeError);
assert.throws(() => Set.prototype.clear.call(overlay.blockedTokenMints), TypeError);
assert.throws(() => Map.prototype.clear.call(overlay.findingsByToken), TypeError);
assert.deepEqual(overlay.blockedTokenMints, [TOKEN_A, TOKEN_B].sort());

const summaries = buildBlockedSummariesV1({
  chain: 'solana', network: 'mainnet-beta', wallet: WALLET, activityFindings: [ambiguous, unsupported],
});
assert.equal(summaries.length, 2);
const summary = summaries.find(item => item.token_mint === TOKEN_B);
assert.equal(summary.ledger_evidence_status, 'blocked_ambiguous_activity');
assert.deepEqual(summary.reason_codes, ['ambiguous_swap_direction', 'unsupported_swap_shape']);
assert.deepEqual(summary.disclosure_codes, ['activity_not_reconstructable']);
assert.equal(summary.selection_status, 'blocked');
assert.equal(summary.package_eligibility, 'blocked_by_evidence');
assert.ok(Object.isFrozen(summary));
for (const forbidden of ['quantity','qty','price','basis','proceeds','pnl']) {
  assert.ok(!Object.keys(summary).some(key => key.toLowerCase().includes(forbidden)));
}
assert.equal(summary.economics_status, 'unavailable');
assert.throws(
  () => buildBlockedTokenOverlayV1({ activityFindings: [{ ...unsupported, impact_scope: 'wallet_wide', affected_token_mints: [] }] }),
  error => error.code === 'wallet_wide_impact_unresolved',
);

function forgedSet(mutator) {
  const set = structuredClone(buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.localizedUnsupported).candidateSet);
  const forged = set.payload.blocked_summaries[0];
  mutator(forged);
  forged.blocked_summary_digest = computeBlockedSummaryDigest(forged);
  forged.blocked_summary_id = `abs1_${forged.blocked_summary_digest}`;
  set.candidate_set_digest = computeCandidateSetDigest(set.payload);
  return set;
}
assert.throws(
  () => validateCandidateSetV1(forgedSet(summary => { summary.ledger_evidence_status = 'blocked_ambiguous_activity'; })),
  error => error.code === 'blocked_summary_mismatch',
);
assert.throws(
  () => validateCandidateSetV1(forgedSet(summary => { summary.token_mint = providerPublicKey('UNRELATED-TOKEN'); })),
  error => error.code === 'blocked_summary_mismatch',
);
console.log('candidate-set blocked summaries: PASS');
