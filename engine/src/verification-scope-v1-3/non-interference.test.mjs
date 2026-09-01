#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NON_INTERFERENCE_DECISIONS,
  NON_INTERFERENCE_SOURCE_KINDS,
  deriveNonInterferenceDecisionsV13,
} from './non-interference.mjs';

const D = char => char.repeat(64);
const baseContext = () => ({
  claim_type: 'POSITION_EPISODE',
  claim_profile: 'POSITION_ECONOMICS_V1',
  target_mint: 'TargetMint111111111111111111111111111111111',
  exact_quote_mint: 'QuoteMint1111111111111111111111111111111111',
  target_accounts: ['TargetAccount111111111111111111111111111111'],
  closed_boundary_coordinate: null,
  zero_open_boundary_coordinate: null,
});
const residual = (overrides = {}) => {
  const item = {
    reference_digest: D('a'),
    source_kind: 'TRANSACTION_EFFECT_RESIDUAL',
    transaction_coordinate: 5,
    transaction_status: 'succeeded',
    residual_reason: 'UNMATCHED_WALLET_INSTRUCTION',
    mint: null,
    accounts: [],
    established_effect_kinds: ['network_fee'],
    dependency_code: null,
    dependency_references: [],
    transaction_residual_reasons: ['UNMATCHED_WALLET_INSTRUCTION'],
    dependency_last_event_ordinal: null,
    basis_reset_event_ordinal: null,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'transaction_residual_reasons') && item.residual_reason !== null) item.transaction_residual_reasons = [item.residual_reason];
  return item;
};

function derive(context, items) {
  return deriveNonInterferenceDecisionsV13({ claim_context: context, evidence_items: items });
}

test('closed vocabulary is exact and unresolved evidence defaults to claim-affecting', () => {
  assert.deepEqual(NON_INTERFERENCE_SOURCE_KINDS, [
    'TRANSACTION_EFFECT_RESIDUAL', 'POSITION_ECONOMIC_DEPENDENCY',
    'ACQUISITION_ACTIVITY_FINDING', 'BOUNDARY_FINDING',
  ]);
  assert.deepEqual(NON_INTERFERENCE_DECISIONS, ['EXCLUDED_NON_INTERFERING', 'CLAIM_AFFECTING']);
  const [decision] = derive(baseContext(), [residual()]);
  assert.equal(decision.decision, 'CLAIM_AFFECTING');
  assert.equal(decision.applied_rule, null);
  assert.ok(decision.affected_fields.includes('ending_target_inventory'));
});

test('NI-01 and NI-02 require strict authoritative boundary coordinates', () => {
  const after = derive({ ...baseContext(), closed_boundary_coordinate: 4 }, [residual()])[0];
  assert.equal(after.applied_rule, 'NI-01');
  assert.equal(after.exclusion_code, 'EXCLUDED_AFTER_CLOSED_BOUNDARY');

  const before = derive({ ...baseContext(), zero_open_boundary_coordinate: 6 }, [residual()])[0];
  assert.equal(before.applied_rule, 'NI-02');
  assert.equal(before.exclusion_code, 'EXCLUDED_BEFORE_ZERO_OPEN_BOUNDARY');

  assert.equal(derive({ ...baseContext(), closed_boundary_coordinate: 5 }, [residual()])[0].decision, 'CLAIM_AFFECTING');
  assert.equal(derive({ ...baseContext(), zero_open_boundary_coordinate: 5 }, [residual()])[0].decision, 'CLAIM_AFFECTING');
});

test('NI-03 requires exact asset and account disjointness and rejects unknown scope', () => {
  const other = residual({
    residual_reason: 'TOKEN_BALANCE_SIDE_MISSING',
    mint: 'OtherMint1111111111111111111111111111111111',
    accounts: ['OtherAccount11111111111111111111111111111'],
  });
  const excluded = derive(baseContext(), [other])[0];
  assert.equal(excluded.applied_rule, 'NI-03');
  assert.equal(excluded.exclusion_code, 'EXCLUDED_ASSET_AND_DIMENSION_DISJOINT');

  assert.equal(derive(baseContext(), [{ ...other, mint: null }])[0].decision, 'CLAIM_AFFECTING');
  assert.equal(derive(baseContext(), [{ ...other, accounts: baseContext().target_accounts }])[0].decision, 'CLAIM_AFFECTING');
  assert.equal(derive(baseContext(), [{ ...other, mint: baseContext().exact_quote_mint }])[0].decision, 'CLAIM_AFFECTING');
  assert.equal(derive(baseContext(), [{ ...other, residual_reason: 'UNKNOWN_TOKEN_OWNER', transaction_residual_reasons: ['UNKNOWN_TOKEN_OWNER'] }])[0].decision, 'CLAIM_AFFECTING');
});

test('NI-03 independently classifies an unconsumed established effect instead of trusting NON_ECONOMIC', () => {
  const item = residual({
    source_kind: 'TRANSACTION_EFFECT_RESIDUAL', residual_reason: null, dependency_code: null,
    transaction_status: 'succeeded', mint: 'OtherMint1111111111111111111111111111111111',
    accounts: ['OtherAccount11111111111111111111111111111'],
  });
  const [decision] = derive(baseContext(), [item]);
  assert.equal(decision.applied_rule, null);
  assert.equal(decision.decision, 'CLAIM_AFFECTING');
});

test('NI-03 rejects other-mint near misses with unlocalized committed transfer or lifecycle dimensions', () => {
  const other = residual({
    residual_reason: 'TOKEN_BALANCE_SIDE_MISSING',
    mint: 'OtherMint1111111111111111111111111111111111',
    accounts: ['OtherAccount11111111111111111111111111111'],
  });
  for (const kind of ['token_transfer', 'native_transfer', 'account_creation', 'account_closure']) {
    assert.equal(derive(baseContext(), [{ ...other, established_effect_kinds: ['network_fee', kind].sort() }])[0].decision, 'CLAIM_AFFECTING');
  }
});

test('NI-04 derives failed no-committed-target exclusion from exact transaction facts', () => {
  const failed = residual({
    transaction_status: 'failed',
    residual_reason: 'FAILED_TOKEN_BALANCE_OBSERVATION',
    mint: baseContext().target_mint,
    established_effect_kinds: ['network_fee', 'native_balance_observation'],
    transaction_residual_reasons: ['FAILED_TOKEN_BALANCE_OBSERVATION'],
  });
  const excluded = derive(baseContext(), [failed])[0];
  assert.equal(excluded.applied_rule, 'NI-04');
  assert.equal(excluded.exclusion_code, 'EXCLUDED_FAILED_TX_NO_COMMITTED_TARGET_EFFECT');

  assert.equal(derive(baseContext(), [{ ...failed, established_effect_kinds: [] }])[0].decision, 'CLAIM_AFFECTING');
  assert.equal(derive(baseContext(), [{ ...failed, transaction_residual_reasons: ['FAILED_TOKEN_BALANCE_OBSERVATION', 'NATIVE_BALANCE_RECONCILIATION'] }])[0].decision, 'CLAIM_AFFECTING');

  const committed = { ...failed, established_effect_kinds: ['network_fee', 'token_transfer'] };
  assert.equal(derive(baseContext(), [committed])[0].decision, 'CLAIM_AFFECTING');
});

test('NI-05 and NI-06 fail closed without a Slice 1-4 source-bound quote-flow separation carrier', () => {
  assert.throws(
    () => derive(baseContext(), [{ ...residual(), quote_flow_classification: 'QUOTE_FUNDING_ONLY' }]),
    /closed schema/i,
  );
  assert.equal(derive(baseContext(), [residual()])[0].decision, 'CLAIM_AFFECTING');
});

test('source transaction and wallet claims cannot localize their own unresolved effects', () => {
  const transaction = { ...baseContext(), claim_type: 'TRANSACTION_EFFECT', claim_profile: 'TRANSACTION_EFFECT_V1', target_mint: null, exact_quote_mint: null, target_accounts: [], closed_boundary_coordinate: null };
  const wallet = { ...transaction, claim_type: 'WALLET_WINDOW', claim_profile: 'WALLET_EFFECT_COVERAGE_V1' };
  for (const context of [transaction, wallet]) {
    const decision = derive(context, [residual({ mint: 'OtherMint1111111111111111111111111111111111', accounts: ['OtherAccount11111111111111111111111111111'] })])[0];
    assert.equal(decision.decision, 'CLAIM_AFFECTING');
    assert.equal(decision.applied_rule, null);
  }
});

test('unknown transfer-in basis affects historical basis economics but not state', () => {
  const item = residual({
    source_kind: 'POSITION_ECONOMIC_DEPENDENCY',
    transaction_status: null,
    residual_reason: null,
    mint: null,
    accounts: [],
    established_effect_kinds: [],
    transaction_residual_reasons: [],
    dependency_code: 'TRANSFER_IN_BASIS_UNRESOLVED',
    dependency_references: [D('b')],
    dependency_last_event_ordinal: 2,
  });
  const [decision] = derive(baseContext(), [item]);
  assert.equal(decision.decision, 'CLAIM_AFFECTING');
  assert.ok(decision.affected_fields.includes('remaining_attributable_basis'));
  assert.ok(decision.affected_fields.includes('realized_basis_consumed'));
  assert.ok(decision.affected_fields.includes('realized_pnl'));
  assert.ok(decision.affected_fields.includes('realized_return'));
  assert.equal(decision.affected_fields.includes('opening_attributable_basis'), false);
  assert.equal(decision.affected_fields.includes('position_state'), false);
  assert.equal(decision.affected_fields.includes('ending_target_inventory'), false);
});

test('later genuine economic zero restores only subsequent remaining basis availability', () => {
  const item = residual({
    source_kind: 'POSITION_ECONOMIC_DEPENDENCY', transaction_status: null, residual_reason: null,
    mint: null, accounts: [], established_effect_kinds: [],
    transaction_residual_reasons: [],
    dependency_code: 'TRANSFER_IN_BASIS_UNRESOLVED', dependency_references: [D('c')],
    dependency_last_event_ordinal: 2, basis_reset_event_ordinal: 4,
  });
  const [decision] = derive(baseContext(), [item]);
  assert.equal(decision.affected_fields.includes('remaining_attributable_basis'), false);
  assert.ok(decision.affected_fields.includes('realized_basis_consumed'));
  assert.ok(decision.affected_fields.includes('realized_pnl'));
  assert.ok(decision.affected_fields.includes('realized_return'));
});

test('equivalent evidence permutations have one canonical immutable decision set', () => {
  const a = residual({ reference_digest: D('a') });
  const b = residual({ reference_digest: D('b'), transaction_coordinate: 6 });
  const first = derive(baseContext(), [b, a, a]);
  const second = derive(baseContext(), [a, b]);
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0]), true);
  assert.throws(() => { first[0].decision = 'EXCLUDED_NON_INTERFERING'; }, TypeError);
});

test('closed input rejects caller safety flags, malformed arrays, accessors, and proxies', () => {
  assert.throws(() => derive(baseContext(), [{ ...residual(), non_interfering: true }]), error => error.code === 'evidence_item_shape_invalid');
  assert.throws(() => derive(baseContext(), ''), error => error.code === 'evidence_items_invalid');
  let calls = 0;
  const hostile = residual();
  Object.defineProperty(hostile, 'mint', { enumerable: true, get() { calls += 1; return null; } });
  assert.throws(() => derive(baseContext(), [hostile]), error => error.code === 'accessor_not_allowed');
  const proxy = new Proxy(residual(), { ownKeys() { calls += 1; return []; } });
  assert.throws(() => derive(baseContext(), [proxy]), error => error.code === 'proxy_not_allowed');
  assert.equal(calls, 0);
});
