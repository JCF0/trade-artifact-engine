import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Message, Transaction } from '@solana/web3.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256CanonicalJson } from '../contract.mjs';
import { buildBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { createAuthorizedEpisodeStateV1 } from './episode-state-machine-v1.mjs';
import { buildReadinessChallengeV1 } from './readiness-challenge-v1.mjs';
import { createCrashDurableDecisionAuthorityV1, provisionCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { buildOrcaMessageBoundaryV1 } from './orca-message-boundary-v1.mjs';
import { fixedTestMandateInputV1, buildFixedTestAuthorizationV1, buildFixedTestAgentDecisionV1, buildFixedTestChallengeV1 } from './fixtures/fixed-test-identities-v1.mjs';

for (const outcome of ['UNCERTAIN', 'ALTERED_WIRE', 'BAD_FEE_BINDING', 'BAD_SOURCE_BINDING', 'BAD_SLIPPAGE']) {
  test(`composed Orca boundary authenticates and checkpoints before inert signer; ${outcome} cannot re-sign after reopen`, async () => {
    const { createOfflineOrcaSigningCompositionV1 } = await import('./orca-signing-composition-v1.mjs');
    const input = fixedTestMandateInputV1();
    input.unresolved_live_readiness = {
      human_authorization_public_key: input.offline_identity.human_authorization_public_key,
      agent_control_public_key: input.offline_identity.agent_control_public_key,
      acquisition_not_after_unix_seconds: input.offline_identity.acquisition_not_after_unix_seconds,
      rpc_budget_table_sha256: input.offline_identity.rpc_budget_table_sha256,
      executor_release_sha256: input.offline_identity.executor_release_sha256, status: 'RESOLVED',
    };
    const mandate = buildBoundedAgentMandateV1(input);
    const authorization = buildFixedTestAuthorizationV1(mandate);
    const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
    const root = mkdtempSync(join(tmpdir(), 'artifact-orca-composition-'));
    provisionCrashDurableDecisionAuthorityV1({ state_root: root, initial_episode_state: state,
      executor_release_sha256: authorization.executor_release_sha256 });
    let authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
    let calls = 0;
    const source = { blockhash: '11111111111111111111111111111111', tick_spacing: 64,
      tick_current_index: 0, quoted_output_raw: '10000000', minimum_output_raw: '9950000', fee_lamports: '5000' };
    if (outcome === 'BAD_SLIPPAGE') {
      source.quoted_output_raw = '10000001';
      source.minimum_output_raw = '9950001';
    }
    const plan = buildOrcaMessageBoundaryV1({ mandate, phase: 'ACQUISITION', ordinal: 1,
      input_raw_quantity: '5000000', retained_acquisition_jup_raw: null, ...source });
    let expectedMessage = Buffer.from(plan.message_base64, 'base64');
    if (outcome === 'BAD_SLIPPAGE') {
      // Build a valid template, then encode the forbidden minimum without asking
      // the policy builder to accept it. No signing: this is an unsigned fixture.
      const transaction = Transaction.populate(Message.from(expectedMessage));
      source.minimum_output_raw = '9950000';
      transaction.instructions[0].data.writeBigUInt64LE(BigInt(source.minimum_output_raw), 16);
      expectedMessage = transaction.serializeMessage();
      assert.equal(BigInt(source.minimum_output_raw) * 10000n
        >= BigInt(source.quoted_output_raw) * (10000n - BigInt(mandate.economic_authority.maximum_slippage_bps)), false);
    }
    source.fee_message_sha256 = createHash('sha256').update(expectedMessage).digest('hex');
    if (outcome === 'BAD_FEE_BINDING') source.fee_message_sha256 = '0'.repeat(64);
    const config = () => ({ mandate, authorization, state_root: root,
      executor_release_sha256: authorization.executor_release_sha256,
      durable_episode_authority: authority,
      acquisition_closure_port: { async capture_authority() { throw Error('NO_LIVE_CLOSURE'); } },
      readiness_challenge_port: { async issueReadinessChallengeV1({ state: current, phase }) {
        const fixed = buildFixedTestChallengeV1({ mandate, authorization, state: current, phase, nonce: 'offline-orca-challenge-01' });
        const { readiness_challenge_version, challenge_id, challenge_digest, ...fields } = fixed;
        return buildReadinessChallengeV1({ ...fields, readiness_evidence_digest: sha256CanonicalJson({
          episode_id: current.episode_id, ordinal: 1, source,
        }) });
      } },
      build_input_port: { async captureBuildInputV1() { return source; } },
      message_signer_port: { async signExactMessageV1(message) {
        calls += 1;
        assert.deepEqual(message, expectedMessage);
        const inspection = await authority.inspectEpisodeV1({ episode_id: state.episode_id });
        assert.equal(inspection.ordinals[0].stage, 'KEY_LOAD_STARTED_AMBIGUOUS');
        if (outcome === 'UNCERTAIN') throw Error('TEST_SIGNER_UNCERTAIN');
        return Buffer.alloc(100);
      } },
    });
    try {
      let control = createOfflineOrcaSigningCompositionV1(config());
      assert.equal(control.signExactMessageV1, undefined);
      assert.equal(control.prepareBoundedLegV1, undefined);
      const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
      const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
      if (outcome === 'BAD_SLIPPAGE') {
        assert.equal(challenge.readiness_evidence_digest, sha256CanonicalJson({ episode_id: state.episode_id, ordinal: 1, source }));
        assert.equal(source.fee_message_sha256, createHash('sha256').update(expectedMessage).digest('hex'));
        assert.equal(Transaction.populate(Message.from(expectedMessage)).instructions[0].data.readBigUInt64LE(16), 9950000n);
      }
      if (outcome === 'BAD_SOURCE_BINDING') source.quoted_output_raw = '10000001';
      const bad = { ...decision, signature: '0'.repeat(128) };
      await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1({
        decision_bytes: Buffer.from(canonicalJson(bad)), now_unix_seconds: 1900000012,
      }));
      assert.equal(calls, 0);
      const request = { decision_bytes: Buffer.from(canonicalJson(decision)), now_unix_seconds: 1900000012 };
      const expectedCalls = outcome.startsWith('BAD_') ? 0 : 1;
      const expectedStage = expectedCalls === 0 ? 'RESERVED' : 'KEY_LOAD_STARTED_AMBIGUOUS';
      await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1(request),
        outcome === 'BAD_SLIPPAGE' ? {
          code: 'bounded_agent_orca_message_invalid', message: 'minimum output exceeds slippage authority',
        } : outcome === 'UNCERTAIN' ? /TEST_SIGNER_UNCERTAIN/ : outcome === 'BAD_SOURCE_BINDING' ? /build input/ : /message/);
      assert.equal(calls, expectedCalls);
      authority.closeV1();
      authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
      control = createOfflineOrcaSigningCompositionV1(config());
      await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1(request));
      assert.equal(calls, expectedCalls);
      assert.equal((await authority.inspectEpisodeV1({ episode_id: state.episode_id })).ordinals[0].stage, expectedStage);
    } finally { authority.closeV1(); rmSync(root, { recursive: true, force: true }); }
  });
}
