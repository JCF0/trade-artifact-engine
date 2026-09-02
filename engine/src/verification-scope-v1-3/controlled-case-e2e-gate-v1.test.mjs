#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CONTROLLED_CASE_GATE_PROFILE_V1,
  CONTROLLED_CASE_GATE_VERSION_V1,
  runControlledCaseOfflineE2EGateV1,
  validateControlledCaseGateResultV1,
} from './controlled-case-e2e-gate-v1.mjs';
import { canonicalJson } from './contract.mjs';
import {
  CLASSIC_TOKEN_PROGRAM_V1,
  TOKEN_2022_PROGRAM_V1,
  createControlledCaseAuthorityV1,
} from './fixtures/controlled-case-offline-v1.mjs';

test('canonical controlled case traverses Slices 1-7 and emits identity-only PASS evidence', async () => {
  const result = await runControlledCaseOfflineE2EGateV1();

  assert.equal(result.gate_result_version, CONTROLLED_CASE_GATE_VERSION_V1);
  assert.equal(result.gate_profile, CONTROLLED_CASE_GATE_PROFILE_V1);
  assert.equal(result.overall_status, 'PASS');
  const assertions = Object.fromEntries(result.assertions.map(row => [row.assertion_id, row]));
  assert.equal(assertions.opening_exact_zero.observed, '0');
  assert.equal(assertions.ending_exact_zero.observed, '0');
  assert.equal(assertions.source_transaction_count.observed, 2);
  assert.equal(assertions.source_episode_count.observed, 1);
  assert.equal(assertions.verified_count.observed, 1);
  assert.equal(assertions.limited_count.observed, 0);
  assert.equal(assertions.blocked_count.observed, 0);
  assert.equal(assertions.position_state.observed, 'CLOSED');
  assert.equal(assertions.claim_outcome.observed, 'VERIFIED');
  assert.deepEqual(assertions.aggregate_acquisition_basis.observed, { numerator: '25000000', denominator: '1' });
  assert.deepEqual(assertions.recognized_disposal_proceeds.observed, { numerator: '32500000', denominator: '1' });
  assert.deepEqual(assertions.realized_basis_consumed.observed, { numerator: '25000000', denominator: '1' });
  assert.deepEqual(assertions.realized_pnl.observed, { numerator: '7500000', denominator: '1' });
  assert.deepEqual(assertions.realized_return.observed, { numerator: '3', denominator: '10' });
  assert.deepEqual(assertions.remaining_attributable_basis.observed, { numerator: '0', denominator: '1' });
  assert.equal(result.assertions.every(assertion => assertion.status === 'PASS'), true);
  assert.equal(validateControlledCaseGateResultV1(result), true);
  assert.equal(Object.isFrozen(result), true);
});

test('canonical release evidence reconstructs byte-identically to the checked golden file', async () => {
  const result = await runControlledCaseOfflineE2EGateV1();
  const golden = await readFile(new URL('./fixtures/controlled-case-offline-v1.golden.txt', import.meta.url), 'utf8');
  assert.equal(canonicalJson(result), golden);
});

test('classic-SPL proof recaptures equal-slot classic and empty Token-2022 owner lanes without mint lookup', async () => {
  const fixture = await createControlledCaseAuthorityV1();
  assert.equal(fixture.enumeration_requests.length, 4);
  assert.deepEqual(fixture.enumeration_requests.map(request => request.method), [
    'getTokenAccountsByOwner', 'getTokenAccountsByOwner',
    'getTokenAccountsByOwner', 'getTokenAccountsByOwner',
  ]);
  assert.deepEqual(fixture.enumeration_requests.map(request => request.params[1].programId), [
    CLASSIC_TOKEN_PROGRAM_V1, TOKEN_2022_PROGRAM_V1,
    CLASSIC_TOKEN_PROGRAM_V1, TOKEN_2022_PROGRAM_V1,
  ]);
  assert.equal(fixture.enumeration_requests.some(request => request.method === 'getAccountInfo'), false);
  assert.equal(fixture.context.opening_snapshot.accounts.length, 1);
  assert.equal(fixture.context.ending_snapshot.accounts.length, 1);
  assert.equal(fixture.context.opening_snapshot.accounts[0].account_program, CLASSIC_TOKEN_PROGRAM_V1);
  assert.equal(fixture.context.ending_snapshot.accounts[0].account_program, CLASSIC_TOKEN_PROGRAM_V1);
});
