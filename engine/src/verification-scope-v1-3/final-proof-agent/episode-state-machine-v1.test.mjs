import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFixedTestAgentDecisionV1,
  buildFixedTestAuthorizationV1,
  buildFixedTestChallengeV1,
  buildFixedTestMandateV1,
} from './fixtures/fixed-test-identities-v1.mjs';
import {
  closeFinalizedLegV1,
  createAuthorizedEpisodeStateV1,
  validateBoundedAgentEpisodeStateV1,
} from './episode-state-machine-v1.mjs';
import { createOfflineBoundedExecutorCoreV1 } from './offline-executor-core-v1.mjs';
import { buildReadinessChallengeV1 } from './readiness-challenge-v1.mjs';

function challengeFor({ mandate, authorization, state, phase, nonce, amount = null }) {
  return buildFixedTestChallengeV1({ mandate, authorization, state, phase, nonce, amount });
}

function harness() {
  const mandate = buildFixedTestMandateV1();
  const authorization = buildFixedTestAuthorizationV1(mandate);
  const calls = { prepare: 0, load: 0, sign: 0 };
  const consumed = new Set();
  const revokedEpisodes = new Set();
  const decisionConsumptionPort = {
    async consumeEpisodeOrdinalV1({ episode_id, ordinal, decision_id, challenge_id }) {
      if (revokedEpisodes.has(episode_id)) return 'REVOKED';
      const keys = [`ordinal:${episode_id}:${ordinal}`, `decision:${decision_id}`, `challenge:${challenge_id}`];
      if (keys.some(key => consumed.has(key))) return 'ALREADY_CONSUMED';
      keys.forEach(key => consumed.add(key));
      return 'CONSUMED';
    },
    async revokeAuthorizationV1({ episode_id, predecessor_state }) {
      if (revokedEpisodes.has(episode_id)) return 'ALREADY_REVOKED';
      const hasAdmission = [...consumed].some(key => key.startsWith(`ordinal:${episode_id}:`));
      if ((predecessor_state === 'AUTHORIZED_DORMANT') === hasAdmission) return 'STATE_MISMATCH';
      revokedEpisodes.add(episode_id);
      return 'REVOKED';
    },
  };
  const executionPort = {
    async prepareBoundedLegV1({ mandate: boundMandate, challenge, admission }) {
      calls.prepare += 1;
      const acquisition = challenge.phase === 'ACQUISITION';
      return {
        prepared_transaction_version: 'artifact_bounded_agent_prepared_transaction_v1',
        episode_id: challenge.episode_id,
        phase: challenge.phase,
        admission_digest: admission.admission_digest,
        wallet: boundMandate.wallet_scope.wallet,
        pool: boundMandate.route_scope.pool,
        input_mint: acquisition ? boundMandate.asset_scope.usdc_mint : boundMandate.asset_scope.jup_mint,
        output_mint: acquisition ? boundMandate.asset_scope.jup_mint : boundMandate.asset_scope.usdc_mint,
        input_raw_quantity: acquisition ? boundMandate.economic_authority.acquisition_input_usdc_raw
          : challenge.chain_derived_disposal_jup_raw,
        maximum_slippage_bps: boundMandate.economic_authority.maximum_slippage_bps,
        transaction_profile: 'DIRECT_CLASSIC_ORCA_LEGACY_SWAP_V1',
        unsigned_transaction_digest: acquisition ? 'a'.repeat(64) : 'b'.repeat(64),
        readiness_evidence_digest: challenge.readiness_evidence_digest,
      };
    },
  };
  const walletSignerPort = {
    async signAdmittedTransactionV1({ admission, prepared_transaction: prepared }) {
      calls.load += 1;
      calls.sign += 1;
      return {
        signed_transaction_intent_version: 'artifact_bounded_agent_signed_transaction_intent_v1',
        episode_id: prepared.episode_id,
        phase: prepared.phase,
        admission_digest: admission.admission_digest,
        semantic_transaction_digest: prepared.unsigned_transaction_digest,
        message_sha256: prepared.phase === 'ACQUISITION' ? 'e'.repeat(64) : 'f'.repeat(64),
        signed_wire_sha256: prepared.phase === 'ACQUISITION' ? '1'.repeat(64) : '2'.repeat(64),
        signature: prepared.phase === 'ACQUISITION' ? '3'.repeat(88) : '4'.repeat(88),
        sign_count: 1,
      };
    },
  };
  const executor = createOfflineBoundedExecutorCoreV1({
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    decision_consumption_port: decisionConsumptionPort,
    execution_port: executionPort,
    wallet_signer_port: walletSignerPort,
  });
  return { mandate, authorization, calls, executor, decisionConsumptionPort, executionPort, walletSignerPort };
}

test('executor reaches dummy signing only through the complete acquisition authority chain', async () => {
  const { mandate, authorization, calls, executor } = harness();
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const challenge = challengeFor({ mandate, authorization, state, phase: 'ACQUISITION', nonce: 'acquisition-challenge-0001' });
  const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
  const result = await executor.executeAgentDecisionV1({ state, mandate, authorization, challenge, decision, now_unix_seconds: 1900000012 });
  assert.equal(result.admission.status, 'ADMITTED');
  assert.equal(result.state.state, 'ACQUISITION_SUBMISSION_RESOLVING');
  assert.equal(result.state.possible_submission, true);
  assert.deepEqual(calls, { prepare: 1, load: 1, sign: 1 });
  assert.equal(validateBoundedAgentEpisodeStateV1(result.state), true);
  assert.equal('loadWalletSignerV1' in executor, false);
  assert.equal('signAdmittedTransactionV1' in executor, false);
});

test('cross-episode challenge cannot be admitted against another episode state', async () => {
  const { mandate, authorization, calls, executor } = harness();
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const validChallenge = challengeFor({
    mandate, authorization, state, phase: 'ACQUISITION', nonce: 'cross-episode-challenge-01',
  });
  const challengeInput = Object.fromEntries(Object.entries(validChallenge)
    .filter(([field]) => !['readiness_challenge_version', 'challenge_id', 'challenge_digest'].includes(field)));
  const challenge = buildReadinessChallengeV1({
    ...challengeInput,
    episode_id: `bounded-agent-episode-${'f'.repeat(64)}`,
  });
  const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
  await assert.rejects(() => executor.executeAgentDecisionV1({
    state, mandate, authorization, challenge, decision, now_unix_seconds: 1900000012,
  }), error => error.code === 'bounded_agent_state_authority_mismatch');
  assert.deepEqual(calls, { prepare: 0, load: 0, sign: 0 });
});

test('decision and challenge replay cannot cause a second preparation or signature across executor instances', async () => {
  const { mandate, authorization, calls, executor, decisionConsumptionPort, executionPort, walletSignerPort } = harness();
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const challenge = challengeFor({ mandate, authorization, state, phase: 'ACQUISITION', nonce: 'acquisition-challenge-0002' });
  const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
  await executor.executeAgentDecisionV1({ state, mandate, authorization, challenge, decision, now_unix_seconds: 1900000012 });
  await assert.rejects(() => executor.executeAgentDecisionV1({ state, mandate, authorization, challenge, decision, now_unix_seconds: 1900000013 }),
    error => error.code === 'bounded_agent_decision_replay');
  const secondDecision = buildFixedTestAgentDecisionV1(
    mandate, authorization, challenge, 'REFUSE_ACQUISITION',
  );
  await assert.rejects(() => executor.executeAgentDecisionV1({
    state, mandate, authorization, challenge, decision: secondDecision, now_unix_seconds: 1900000013,
  }), error => error.code === 'bounded_agent_decision_replay');
  const restartedExecutor = createOfflineBoundedExecutorCoreV1({
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    decision_consumption_port: decisionConsumptionPort,
    execution_port: executionPort,
    wallet_signer_port: walletSignerPort,
  });
  await assert.rejects(() => restartedExecutor.executeAgentDecisionV1({
    state, mandate, authorization, challenge, decision, now_unix_seconds: 1900000014,
  }), error => error.code === 'bounded_agent_decision_replay');
  assert.deepEqual(calls, { prepare: 1, load: 1, sign: 1 });
});

test('atomic episode-ordinal authority permits only one concurrent decision across executor instances', async () => {
  const { mandate, authorization, calls, decisionConsumptionPort, executionPort, walletSignerPort } = harness();
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const firstChallenge = challengeFor({ mandate, authorization, state, phase: 'ACQUISITION', nonce: 'concurrent-challenge-0001' });
  const secondChallenge = challengeFor({ mandate, authorization, state, phase: 'ACQUISITION', nonce: 'concurrent-challenge-0002' });
  const firstDecision = buildFixedTestAgentDecisionV1(mandate, authorization, firstChallenge);
  const secondDecision = buildFixedTestAgentDecisionV1(mandate, authorization, secondChallenge);
  const executors = [0, 1].map(() => createOfflineBoundedExecutorCoreV1({
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    decision_consumption_port: decisionConsumptionPort, execution_port: executionPort, wallet_signer_port: walletSignerPort,
  }));
  const outcomes = await Promise.allSettled([
    executors[0].executeAgentDecisionV1({ state, mandate, authorization, challenge: firstChallenge, decision: firstDecision, now_unix_seconds: 1900000012 }),
    executors[1].executeAgentDecisionV1({ state, mandate, authorization, challenge: secondChallenge, decision: secondDecision, now_unix_seconds: 1900000012 }),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
  assert.deepEqual(calls, { prepare: 1, load: 1, sign: 1 });
});

test('atomically persisted revocation rejects a stale pre-revocation state snapshot', async () => {
  const { mandate, authorization, calls, executor } = harness();
  const staleState = createAuthorizedEpisodeStateV1({ mandate, authorization });
  await executor.revokeHumanAuthorizationV1({ state: staleState, authorization_digest: authorization.authorization_digest });
  const challenge = challengeFor({ mandate, authorization, state: staleState, phase: 'ACQUISITION', nonce: 'stale-revoked-challenge-01' });
  const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
  await assert.rejects(() => executor.executeAgentDecisionV1({
    state: staleState, mandate, authorization, challenge, decision, now_unix_seconds: 1900000012,
  }), error => error.code === 'bounded_agent_authorization_revoked');
  assert.deepEqual(calls, { prepare: 0, load: 0, sign: 0 });
});

test('stale dormant snapshot cannot record pre-admission revocation after admission linearizes', async () => {
  const { mandate, authorization, executor } = harness();
  const staleState = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const challenge = challengeFor({ mandate, authorization, state: staleState, phase: 'ACQUISITION', nonce: 'admitted-before-revoke-01' });
  const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
  await executor.executeAgentDecisionV1({ state: staleState, mandate, authorization, challenge, decision, now_unix_seconds: 1900000012 });
  await assert.rejects(() => executor.revokeHumanAuthorizationV1({
    state: staleState, authorization_digest: authorization.authorization_digest,
  }), error => error.code === 'bounded_agent_revocation_state_invalid');
});

test('refusal never reaches preparation or signing', async () => {
  const { mandate, authorization, calls, executor } = harness();
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const challenge = challengeFor({ mandate, authorization, state, phase: 'ACQUISITION', nonce: 'acquisition-challenge-0003' });
  const refusal = buildFixedTestAgentDecisionV1(mandate, authorization, challenge, 'REFUSE_ACQUISITION');
  const refused = await executor.executeAgentDecisionV1({ state, mandate, authorization, challenge, decision: refusal, now_unix_seconds: 1900000012 });
  assert.equal(refused.state.state, 'AGENT_REFUSED_ACQUISITION');
  assert.deepEqual(calls, { prepare: 0, load: 0, sign: 0 });
});

test('revocation after possible submission requires resolution and cannot erase the attempt', async () => {
  const { mandate, authorization, executor } = harness();
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const challenge = challengeFor({ mandate, authorization, state, phase: 'ACQUISITION', nonce: 'acquisition-challenge-0004' });
  const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
  const submitted = await executor.executeAgentDecisionV1({ state, mandate, authorization, challenge, decision, now_unix_seconds: 1900000012 });
  const revoked = await executor.revokeHumanAuthorizationV1({ state: submitted.state, authorization_digest: authorization.authorization_digest });
  assert.equal(revoked.state, 'RESOLUTION_REQUIRED_AFTER_REVOCATION');
  assert.equal(revoked.possible_submission, true);
  assert.equal(revoked.signed_intent_digest, submitted.signed_transaction_intent_digest);
  const resolved = closeFinalizedLegV1({
    state: revoked, phase: 'ACQUISITION', finalized_evidence_digest: '7'.repeat(64),
    chain_derived_acquired_jup_raw: '21437310',
  });
  assert.equal(resolved.state, 'REVOKED_AFTER_ACQUISITION');
  assert.equal(resolved.possible_submission, false);
  assert.equal(resolved.next_ordinal, null);
});

test('disposal is impossible before closed finalized acquisition and quantity substitution fails before signing', async () => {
  const { mandate, authorization, calls, executor } = harness();
  const initial = createAuthorizedEpisodeStateV1({ mandate, authorization });
  assert.throws(() => challengeFor({ mandate, authorization, state: initial, phase: 'DISPOSAL', nonce: 'disposal-challenge-00001', amount: '21437310' }));
  const acquisitionChallenge = challengeFor({ mandate, authorization, state: initial, phase: 'ACQUISITION', nonce: 'acquisition-challenge-0005' });
  const acquisitionDecision = buildFixedTestAgentDecisionV1(mandate, authorization, acquisitionChallenge);
  const submitted = await executor.executeAgentDecisionV1({ state: initial, mandate, authorization, challenge: acquisitionChallenge, decision: acquisitionDecision, now_unix_seconds: 1900000012 });
  const closed = closeFinalizedLegV1({
    state: submitted.state, phase: 'ACQUISITION', finalized_evidence_digest: '8'.repeat(64),
    chain_derived_acquired_jup_raw: '21437310',
  });
  const disposalChallenge = challengeFor({ mandate, authorization, state: closed, phase: 'DISPOSAL', nonce: 'disposal-challenge-00002', amount: '21437310' });
  const disposalDecision = buildFixedTestAgentDecisionV1(mandate, authorization, disposalChallenge);
  const maliciousPort = {
    async prepareBoundedLegV1() {
      const prepared = await harness().executor;
      void prepared;
      return {
        prepared_transaction_version: 'artifact_bounded_agent_prepared_transaction_v1',
        episode_id: closed.episode_id, phase: 'DISPOSAL', admission_digest: '0'.repeat(64),
        wallet: mandate.wallet_scope.wallet, pool: mandate.route_scope.pool,
        input_mint: mandate.asset_scope.jup_mint, output_mint: mandate.asset_scope.usdc_mint,
        input_raw_quantity: '1', maximum_slippage_bps: 50,
        transaction_profile: 'DIRECT_CLASSIC_ORCA_LEGACY_SWAP_V1',
        unsigned_transaction_digest: 'b'.repeat(64), readiness_evidence_digest: 'd'.repeat(64),
      };
    },
  };
  const denied = createOfflineBoundedExecutorCoreV1({
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    decision_consumption_port: {
      async consumeEpisodeOrdinalV1() { return 'CONSUMED'; },
      async revokeAuthorizationV1() { return 'REVOKED'; },
    },
    execution_port: maliciousPort,
    wallet_signer_port: { async signAdmittedTransactionV1() { calls.sign += 1; throw new Error('must not sign'); } },
  });
  await assert.rejects(() => denied.executeAgentDecisionV1({
    state: closed, mandate, authorization, challenge: disposalChallenge, decision: disposalDecision,
    now_unix_seconds: 1900001012,
  }), error => error.code === 'bounded_agent_prepared_transaction_mismatch');
  assert.equal(calls.sign, 1);
});

test('mandate expiry and ordinal/predecessor drift fail before any injected capability call', async () => {
  const { mandate, authorization, calls, executor } = harness();
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const challenge = challengeFor({ mandate, authorization, state, phase: 'ACQUISITION', nonce: 'acquisition-challenge-0006' });
  const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
  await assert.rejects(() => executor.executeAgentDecisionV1({
    state, mandate, authorization, challenge, decision,
    now_unix_seconds: authorization.acquisition_not_after_unix_seconds,
  }), error => error.code === 'bounded_agent_decision_stale');
  assert.deepEqual(calls, { prepare: 0, load: 0, sign: 0 });

  const forged = structuredClone(state);
  forged.state = 'ACQUISITION_EVIDENCE_CLOSED';
  forged.next_ordinal = 1;
  forged.acquisition_evidence_digest = '8'.repeat(64);
  forged.chain_derived_acquired_jup_raw = '21437310';
  assert.throws(() => validateBoundedAgentEpisodeStateV1(forged),
    error => error.code === 'bounded_agent_state_semantics_invalid');
});
