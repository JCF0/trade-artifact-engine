#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildActivityFindingV1, canonicalizeActivityFindingsV1, validateActivityFindingsV1 } from './activity-findings.mjs';
import { validateFindingV1 } from './schema.mjs';

const txA = 'a'.repeat(64);
const txB = 'b'.repeat(64);
const tokenFinding = buildActivityFindingV1({
  finding_type: 'unsupported_activity', severity: 'candidate_blocking', impact_scope: 'token_specific',
  time_range: { first_observed_at: 20, last_observed_at: 20, first_observed_slot: 2, last_observed_slot: 2 },
  affected_token_mints: ['TOKEN'], affected_quote_mints: [], source_transaction_digests: [txB], source_event_digests: [],
  reason_codes: ['unsupported_swap_shape'], impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
  disclosure_codes: ['activity_not_reconstructable'],
});
const walletFinding = buildActivityFindingV1({
  finding_type: 'ambiguous_activity', severity: 'candidate_blocking', impact_scope: 'wallet_wide',
  time_range: { first_observed_at: 10, last_observed_at: 10, first_observed_slot: 1, last_observed_slot: 1 },
  affected_token_mints: [], affected_quote_mints: [], source_transaction_digests: [txA], source_event_digests: [],
  reason_codes: ['ambiguous_swap_direction'], impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
  disclosure_codes: ['activity_not_reconstructable'],
});
assert.equal(tokenFinding.finding_id, `aaf1_${tokenFinding.finding_digest}`);
assert.deepEqual(canonicalizeActivityFindingsV1([tokenFinding, walletFinding]).map(item => item.impact_scope), ['wallet_wide', 'token_specific']);
assert.doesNotThrow(() => validateActivityFindingsV1([walletFinding, tokenFinding], {
  sourceTransactionDigests: [txA, txB], sourceEventDigests: [], allowWalletWide: true,
}));
assert.throws(() => validateActivityFindingsV1([walletFinding], {
  sourceTransactionDigests: [txA], sourceEventDigests: [], allowWalletWide: false,
}), error => error.code === 'wallet_wide_impact_unresolved');
assert.throws(() => buildActivityFindingV1({
  ...structuredClone(tokenFinding), finding_id: undefined, finding_digest: undefined,
}), error => ['unsupported_json_value', 'unknown_field'].includes(error.code));
const badReason = structuredClone(tokenFinding);
badReason.reason_codes = ['made_up_reason'];
assert.throws(() => validateActivityFindingsV1([badReason], {
  sourceTransactionDigests: [txB], sourceEventDigests: [], allowWalletWide: true,
}), error => ['finding_digest_mismatch', 'invalid_activity_finding'].includes(error.code));
const duplicate = [tokenFinding, tokenFinding];
assert.throws(() => canonicalizeActivityFindingsV1(duplicate), error => error.code === 'duplicate_activity_finding');

for (const [findingType, reasonCode] of [
  ['partial_history_boundary', 'partial_history_boundary'],
  ['external_transfer_gap', 'external_transfer_gap'],
  ['unobserved_inventory', 'unobserved_pre_window_inventory'],
  ['balance_boundary_mismatch', 'balance_boundary_mismatch'],
  ['mark_source_limitation', 'mark_stale'],
]) {
  const removed = structuredClone(tokenFinding);
  removed.finding_type = findingType;
  removed.reason_codes = [reasonCode];
  assert.throws(
    () => validateFindingV1(removed, { verifyDigest: false }),
    error => error.code === 'invalid_field',
    `${findingType} must not enter canonical v1.13 activity findings`,
  );
}
console.log('candidate-set activity findings: PASS');
