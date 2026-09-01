#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAIM_TYPES,
  CLAIM_PROFILES,
  CLAIM_OUTCOMES,
  POSITION_STATES,
  SUPPORTING_PROFILES,
  REASON_CODES,
  EXCLUSION_CODES,
  NON_INTERFERENCE_RULES,
  POSITION_VERIFIED_FIELD_MATRIX,
  POSITION_STATE_DERIVATION_RULE,
  CLAIM_SCOPED_PROJECTION_RULE,
  FULL_RESULT_PROFILE_DEFINITIONS,
  LIMITED_RESULT_PROFILE_DEFINITIONS,
  normalizeReasonCodes,
  normalizeExclusionCodes,
  validateClaimCombination,
  deriveVerificationLabel,
} from './semantics.mjs';

const positionVerified = {
  claim_type: 'POSITION_EPISODE',
  claim_profile: 'POSITION_ECONOMICS_V1',
  claim_outcome: 'VERIFIED',
  position_state: 'CLOSED',
  requested: true,
  result_profile: 'POSITION_ECONOMICS_V1',
};

test('canonical semantic constants and policy profiles are exact and deeply frozen', () => {
  assert.deepEqual(CLAIM_TYPES, ['TRANSACTION_EFFECT', 'POSITION_EPISODE', 'WALLET_WINDOW']);
  assert.deepEqual(CLAIM_PROFILES, ['TRANSACTION_EFFECT_V1', 'POSITION_ECONOMICS_V1', 'WALLET_EFFECT_COVERAGE_V1']);
  assert.deepEqual(CLAIM_OUTCOMES, ['VERIFIED', 'LIMITED', 'BLOCKED', 'NOT_EVALUATED']);
  assert.deepEqual(POSITION_STATES, ['CLOSED', 'OPEN_REALIZED_PARTIAL', 'OPEN', null]);
  assert.deepEqual(SUPPORTING_PROFILES, {
    effect_model_profile: 'ARTIFACT_EFFECT_MODEL_V1_15',
    boundary_authority_profile: 'ARTIFACT_POSITION_BOUNDARY_V1',
    canonical_ordering_profile: 'ARTIFACT_CANONICAL_ORDER_V1',
    intra_tx_effect_order_profile: 'ARTIFACT_INTRA_TX_EFFECT_ORDER_V1',
    accounting_profile: 'ARTIFACT_WAC_ACCOUNTING_V1',
    quote_profile: 'ARTIFACT_RAW_QUOTE_V1',
    non_interference_profile: 'ARTIFACT_NON_INTERFERENCE_V1',
    episode_enumeration_profile: 'ARTIFACT_EPISODE_ENUMERATION_V1',
    candidate_population_profile: 'ARTIFACT_CANDIDATE_POPULATION_V1',
    candidate_selection_policy: 'ARTIFACT_EXPLICIT_DIGEST_SELECTION_V1',
  });
  assert.equal(Object.isFrozen(SUPPORTING_PROFILES), true);
  assert.deepEqual(POSITION_STATE_DERIVATION_RULE, { derivation_source: 'ADMITTED_EVIDENCE', independent_of_claim_outcome: true });
  assert.deepEqual(CLAIM_SCOPED_PROJECTION_RULE, { source_transaction_promotion_allowed: false, prohibited_derived_label: 'TRANSACTION_VERIFIED' });
});

test('reason, exclusion, and NI orders are frozen identity-relevant ordinals', () => {
  assert.equal(REASON_CODES.length, 23);
  assert.equal(REASON_CODES[0], 'ACQUISITION_AUTHORITY_UNRESOLVED');
  assert.equal(REASON_CODES[21], 'NO_LIMITED_PROJECTION');
  assert.equal(REASON_CODES[22], 'TRANSFER_IN_BASIS_UNRESOLVED');
  assert.deepEqual(EXCLUSION_CODES, [
    'EXCLUDED_AFTER_CLOSED_BOUNDARY',
    'EXCLUDED_BEFORE_ZERO_OPEN_BOUNDARY',
    'EXCLUDED_ASSET_AND_DIMENSION_DISJOINT',
    'EXCLUDED_FAILED_TX_NO_COMMITTED_TARGET_EFFECT',
    'EXCLUDED_QUOTE_FUNDING_ONLY',
    'EXCLUDED_QUOTE_WITHDRAWAL_ONLY',
  ]);
  assert.deepEqual(NON_INTERFERENCE_RULES.map(rule => [rule.ordinal, rule.rule, rule.exclusion_code]), [
    [1, 'NI-01', EXCLUSION_CODES[0]], [2, 'NI-02', EXCLUSION_CODES[1]],
    [3, 'NI-03', EXCLUSION_CODES[2]], [4, 'NI-04', EXCLUSION_CODES[3]],
    [5, 'NI-05', EXCLUSION_CODES[4]], [6, 'NI-06', EXCLUSION_CODES[5]],
  ]);
  assert.deepEqual(normalizeReasonCodes(['NO_LIMITED_PROJECTION', REASON_CODES[1], REASON_CODES[1]]), [REASON_CODES[1], 'NO_LIMITED_PROJECTION']);
  assert.deepEqual(normalizeExclusionCodes([EXCLUSION_CODES[5], EXCLUSION_CODES[0], EXCLUSION_CODES[5]]), [EXCLUSION_CODES[0], EXCLUSION_CODES[5]]);
  assert.throws(() => normalizeReasonCodes(['FUTURE_REASON']), error => error.code === 'unknown_reason_code');
  assert.throws(() => normalizeExclusionCodes(['FUTURE_EXCLUSION']), error => error.code === 'unknown_exclusion_code');
});

test('full and limited profiles expose the frozen field requirements', () => {
  assert.equal(POSITION_VERIFIED_FIELD_MATRIX.CLOSED.ending_target_inventory, 'EXACT_ZERO');
  assert.equal(POSITION_VERIFIED_FIELD_MATRIX.OPEN_REALIZED_PARTIAL.disposal_proceeds, 'REQUIRED');
  assert.equal(POSITION_VERIFIED_FIELD_MATRIX.OPEN.disposal_proceeds, 'NOT_APPLICABLE');
  assert.equal(POSITION_VERIFIED_FIELD_MATRIX.OPEN.unrealized_mark_pnl, 'FORBIDDEN');
  assert.ok(FULL_RESULT_PROFILE_DEFINITIONS.POSITION_ECONOMICS_V1.state_conditioned);
  assert.deepEqual(LIMITED_RESULT_PROFILE_DEFINITIONS.TRANSACTION_EFFECT_V1_LIMITED.required_fields, [
    'transaction_identity', 'finalized_execution_status', 'established_effects',
    'residual_unresolved_effect_references', 'field_availability', 'reason_codes',
  ]);
  assert.ok(LIMITED_RESULT_PROFILE_DEFINITIONS.POSITION_ECONOMICS_V1_LIMITED.required_fields.includes('position_state'));
  assert.ok(LIMITED_RESULT_PROFILE_DEFINITIONS.WALLET_EFFECT_COVERAGE_V1_LIMITED.required_fields.includes('transaction_dispositions'));
});

test('claim/profile/outcome/state/result-profile combinations are closed', () => {
  assert.equal(validateClaimCombination(positionVerified), true);
  assert.equal(validateClaimCombination({ ...positionVerified, claim_outcome: 'LIMITED', position_state: null, result_profile: 'POSITION_ECONOMICS_V1_LIMITED' }), true);
  assert.equal(validateClaimCombination({ ...positionVerified, claim_outcome: 'BLOCKED', position_state: null, result_profile: null }), true);
  assert.equal(validateClaimCombination({
    claim_type: 'WALLET_WINDOW', claim_profile: 'WALLET_EFFECT_COVERAGE_V1', claim_outcome: 'NOT_EVALUATED',
    position_state: null, requested: false, result_profile: null,
  }), true);

  const invalid = [
    { ...positionVerified, claim_profile: 'TRANSACTION_EFFECT_V1' },
    { ...positionVerified, position_state: null },
    { ...positionVerified, claim_outcome: 'BLOCKED' },
    { ...positionVerified, claim_outcome: 'NOT_EVALUATED' },
    { ...positionVerified, requested: false },
    { ...positionVerified, claim_outcome: 'LIMITED', result_profile: 'POSITION_ECONOMICS_V1' },
    { ...positionVerified, claim_type: 'TRANSACTION_EFFECT', claim_profile: 'TRANSACTION_EFFECT_V1', position_state: 'CLOSED' },
  ];
  for (const value of invalid) assert.throws(() => validateClaimCombination(value), error => typeof error.code === 'string');
});

test('canonical verification labels derive only from verified matching tuples', () => {
  assert.equal(deriveVerificationLabel(positionVerified), 'POSITION_VERIFIED');
  assert.equal(deriveVerificationLabel({ ...positionVerified, claim_outcome: 'LIMITED', result_profile: 'POSITION_ECONOMICS_V1_LIMITED' }), null);
  assert.equal(deriveVerificationLabel({
    claim_type: 'TRANSACTION_EFFECT', claim_profile: 'TRANSACTION_EFFECT_V1', claim_outcome: 'VERIFIED',
    position_state: null, requested: true, result_profile: 'TRANSACTION_EFFECT_V1',
  }), 'TRANSACTION_VERIFIED');
  assert.equal(deriveVerificationLabel({
    claim_type: 'WALLET_WINDOW', claim_profile: 'WALLET_EFFECT_COVERAGE_V1', claim_outcome: 'VERIFIED',
    position_state: null, requested: true, result_profile: 'WALLET_EFFECT_COVERAGE_V1',
  }), 'WALLET_WINDOW_VERIFIED');
});

test('combination validation rejects accessors and proxies without executing them', () => {
  let calls = 0;
  const accessor = { ...positionVerified };
  Object.defineProperty(accessor, 'claim_type', { enumerable: true, get() { calls += 1; throw new Error('must not execute'); } });
  assert.throws(() => validateClaimCombination(accessor), error => error.code === 'accessor_not_allowed');
  const proxy = new Proxy(positionVerified, { ownKeys() { calls += 1; throw new Error('must not execute'); } });
  assert.throws(() => validateClaimCombination(proxy), error => error.code === 'proxy_not_allowed');
  const codeProxy = new Proxy([], { get() { calls += 1; throw new Error('must not execute'); } });
  assert.throws(() => normalizeReasonCodes(codeProxy), error => error.code === 'proxy_not_allowed');
  assert.equal(calls, 0);
});
