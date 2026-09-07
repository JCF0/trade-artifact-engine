import { types as utilTypes } from 'node:util';

import { assertExactFields, canonicalJson, fail, sha256CanonicalJson } from '../contract.mjs';
import { captureAuthoritativeAcquisitionClosureV1 } from './acquisition-closure-authority-v1.mjs';
import { validateAuthenticatedAgentDecisionV1 } from './agent-decision-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { validateHumanRevocationV1 } from './human-revocation-v1.mjs';
import { assertLiveReadyBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { createOfflineBoundedExecutorCoreV1 } from './offline-executor-core-v1.mjs';
import { applyHumanRevocationV1 } from './episode-state-machine-v1.mjs';
import { validateReadinessChallengeV1 } from './readiness-challenge-v1.mjs';

const MAX_AUTHENTICATED_RECORD_BYTES = 131072;
function parseCanonicalRecord(bytes, context) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_AUTHENTICATED_RECORD_BYTES) {
    fail(`bounded_agent_${context}_channel_invalid`, 'authenticated channel payload must be bounded bytes');
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail(`bounded_agent_${context}_channel_invalid`, 'authenticated channel payload is not JSON'); }
  if (!Buffer.from(canonicalJson(value), 'utf8').equals(bytes)) {
    fail(`bounded_agent_${context}_channel_noncanonical`, 'authenticated channel payload is not exact canonical JSON');
  }
  return value;
}
function requireMethod(value, name, context) {
  const descriptor = value !== null && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, name) : undefined;
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    fail('bounded_agent_executor_capability_invalid', `${context}.${name} is unavailable`);
  }
  return descriptor.value.bind(value);
}
function assertExactRequest(value, fields, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.getOwnPropertySymbols(value).length !== 0) {
    fail('verification_scope_unknown_field', `${context} must have only its exact request fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== fields.length
      || Object.keys(descriptors).some(field => !fields.includes(field))
      || fields.some(field => !descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value'))) {
    fail('verification_scope_unknown_field', `${context} must have only its exact request fields`);
  }
  return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
}

export function createWigglesAuthenticatedControlPlaneV1({
  mandate,
  authorization,
  executor_release_sha256,
  durable_episode_authority,
  acquisition_closure_port,
  readiness_challenge_port,
  execution_port,
  wallet_signer_port,
}) {
  assertLiveReadyBoundedAgentMandateV1(mandate);
  validateHumanEpisodeAuthorizationV1(authorization, { mandate });
  if (executor_release_sha256 !== mandate.unresolved_live_readiness.executor_release_sha256
      || executor_release_sha256 !== authorization.executor_release_sha256) {
    fail('bounded_agent_executor_identity_invalid', 'Wiggles executor release does not match the human-authorized mandate');
  }
  const episodeId = `bounded-agent-episode-${authorization.authorization_digest}`;

  const consume = requireMethod(durable_episode_authority, 'consumeEpisodeOrdinalV1', 'durable_episode_authority');
  const revoke = requireMethod(durable_episode_authority, 'revokeAuthorizationV1', 'durable_episode_authority');
  const prepared = requireMethod(durable_episode_authority, 'recordPreparedV1', 'durable_episode_authority');
  const keyLoad = requireMethod(durable_episode_authority, 'recordKeyLoadStartedV1', 'durable_episode_authority');
  const signedDurable = requireMethod(durable_episode_authority, 'recordSignedIntentDurableV1', 'durable_episode_authority');
  const loadState = requireMethod(durable_episode_authority, 'loadCurrentEpisodeStateV1', 'durable_episode_authority');
  const recordSignedState = requireMethod(durable_episode_authority, 'recordSignedEpisodeStateV1', 'durable_episode_authority');
  const closeAcquisition = requireMethod(durable_episode_authority, 'closeAcquisitionFromFinalizedEvidenceV1', 'durable_episode_authority');
  const inspectEpisode = requireMethod(durable_episode_authority, 'inspectEpisodeV1', 'durable_episode_authority');
  const registerChallenge = requireMethod(durable_episode_authority, 'registerReadinessChallengeV1', 'durable_episode_authority');
  const loadChallenge = requireMethod(durable_episode_authority, 'loadIssuedReadinessChallengeV1', 'durable_episode_authority');
  const issueChallenge = requireMethod(readiness_challenge_port, 'issueReadinessChallengeV1', 'readiness_challenge_port');
  const sign = requireMethod(wallet_signer_port, 'signAdmittedTransactionV1', 'wallet_signer_port');

  const executor = createOfflineBoundedExecutorCoreV1({
    executor_release_sha256,
    decision_consumption_port: {
      consumeEpisodeOrdinalV1: consume,
      revokeAuthorizationV1: revoke,
      recordPreparedV1: prepared,
      recordKeyLoadStartedV1: keyLoad,
    },
    execution_port,
    wallet_signer_port: {
      async signAdmittedTransactionV1(input) {
        const result = await sign(input);
        assertExactFields(result, ['signed_transaction_intent', 'signed_wire_path'], 'wiggles_durable_signer_result');
        const signedIntent = result.signed_transaction_intent;
        const durableResult = await signedDurable({
          episode_id: input.admission.episode_id,
          ordinal: input.admission.ordinal,
          admission_digest: input.admission.admission_digest,
          prepared_transaction_digest: sha256CanonicalJson(input.prepared_transaction),
          signed_intent_digest: sha256CanonicalJson(signedIntent),
          semantic_transaction_digest: signedIntent.semantic_transaction_digest,
          message_sha256: signedIntent.message_sha256,
          transaction_signature: signedIntent.signature,
          signed_wire_sha256: signedIntent.signed_wire_sha256,
          signed_wire_path: result.signed_wire_path,
        });
        if (durableResult !== 'SIGNED_INTENT_DURABLE') {
          fail('bounded_agent_authorization_revoked', 'signed bytes were retained but revocation prevents their release');
        }
        return signedIntent;
      },
    },
  });
  async function currentState() {
    const state = await loadState({ episode_id: episodeId });
    if (state.mandate_digest !== mandate.mandate_digest
        || state.authorization_digest !== authorization.authorization_digest) {
      fail('bounded_agent_durable_state_conflict', 'durable episode state is not bound to this authorization');
    }
    return state;
  }
  async function persistSignedSuccessor(predecessor, state, signedIntentDigest) {
    const result = await recordSignedState({
      episode_id: episodeId,
      ordinal: predecessor.next_ordinal,
      predecessor_state_digest: predecessor.state_digest,
      signed_intent_digest: signedIntentDigest,
      successor_state: state,
    });
    if (!['UPDATED', 'EXISTS'].includes(result)) {
      fail('bounded_agent_durable_state_conflict', 'episode state transition did not linearize');
    }
    return state;
  }
  return Object.freeze({
    async issueReadinessChallengeV1(request) {
      assertExactFields(request, ['phase', 'now_unix_seconds'], 'wiggles_readiness_request');
      const { phase, now_unix_seconds } = request;
      const state = await currentState();
      const challenge = await issueChallenge({ state, mandate, authorization, phase, now_unix_seconds });
      validateReadinessChallengeV1(challenge);
      if (challenge.episode_id !== episodeId || challenge.mandate_digest !== mandate.mandate_digest
          || challenge.authorization_digest !== authorization.authorization_digest
          || challenge.predecessor_state !== state.state || challenge.predecessor_state_digest !== state.state_digest
          || challenge.executor_release_sha256 !== executor_release_sha256 || challenge.phase !== phase
          || (phase === 'DISPOSAL' && (
            challenge.finalized_acquisition_evidence_digest !== state.acquisition_evidence_digest
            || challenge.chain_derived_disposal_jup_raw !== state.chain_derived_acquired_jup_raw
          ))) {
        fail('bounded_agent_challenge_context_mismatch', 'issued challenge does not bind current trusted Wiggles state');
      }
      await registerChallenge(challenge);
      return challenge;
    },
    async executeAuthenticatedDecisionBytesV1(request) {
      const { decision_bytes, now_unix_seconds } = assertExactRequest(request, ['decision_bytes', 'now_unix_seconds'], 'wiggles_authenticated_decision_request');
      const decision = parseCanonicalRecord(decision_bytes, 'decision');
      validateAuthenticatedAgentDecisionV1(decision);
      if (decision.agent_public_key !== authorization.agent_public_key
          || decision.episode_id !== episodeId || decision.mandate_digest !== mandate.mandate_digest
          || decision.authorization_digest !== authorization.authorization_digest
          || decision.executor_release_sha256 !== executor_release_sha256) {
        fail('bounded_agent_decision_context_mismatch', 'decision signer or trusted authority identity is not authorized');
      }
      const state = await currentState();
      const challenge = await loadChallenge({
        episode_id: episodeId,
        challenge_id: `readiness-challenge-${decision.challenge_digest}`,
      });
      const result = await executor.executeAgentDecisionV1({
        state, mandate, authorization, challenge, decision, now_unix_seconds,
      });
      if (result.admission.status === 'ADMITTED') {
        const admitted = await currentState();
        await persistSignedSuccessor(admitted, result.state, result.signed_transaction_intent_digest);
      }
      return result;
    },
    async closeAcquisitionFromFinalizedEvidenceV1(request) {
      assertExactRequest(request, [], 'wiggles_acquisition_closure_request');
      const state = await currentState();
      if (!['ACQUISITION_SUBMISSION_RESOLVING', 'RESOLUTION_REQUIRED_AFTER_REVOCATION'].includes(state.state)) {
        fail('bounded_agent_acquisition_closure_state_invalid', 'acquisition is not awaiting finalized evidence');
      }
      const durable = await inspectEpisode({ episode_id: episodeId });
      const ordinal = durable.ordinals.find(item => item.ordinal === 1);
      if (ordinal?.stage !== 'SUBMISSION_POSSIBLE'
          || ordinal.signed_intent_digest !== state.signed_intent_digest) {
        fail('bounded_agent_acquisition_closure_state_invalid', 'durable acquisition submission identity is incomplete');
      }
      const proof = await captureAuthoritativeAcquisitionClosureV1({
        acquisition_closure_port,
        mandate,
        authorization,
        signed_intent_digest: ordinal.signed_intent_digest,
        semantic_transaction_digest: ordinal.semantic_transaction_digest,
        message_sha256: ordinal.message_sha256,
        signed_transaction_signature: ordinal.transaction_signature,
        signed_wire_sha256: ordinal.signed_wire_sha256,
      });
      return closeAcquisition(proof);
    },
    async revokeAuthenticatedBytesV1(request) {
      const { revocation_bytes, now_unix_seconds } = assertExactRequest(request, ['revocation_bytes', 'now_unix_seconds'], 'wiggles_authenticated_revocation_request');
      const revocation = parseCanonicalRecord(revocation_bytes, 'revocation');
      validateHumanRevocationV1(revocation);
      if (revocation.human_public_key !== authorization.human_public_key
          || revocation.episode_id !== episodeId || revocation.mandate_digest !== mandate.mandate_digest
          || revocation.authorization_digest !== authorization.authorization_digest) {
        fail('bounded_agent_revocation_context_mismatch', 'revocation signer or trusted authority identity is not authorized');
      }
      if (!Number.isSafeInteger(now_unix_seconds) || now_unix_seconds < 0
          || revocation.revoked_at_unix_seconds > now_unix_seconds) {
        fail('bounded_agent_revocation_time_invalid', 'human revocation is future-dated');
      }
      const inspected = await inspectEpisode({ episode_id: episodeId });
      if (inspected.revocation !== null) {
        const existing = inspected.revocation;
        if (revocation.episode_id !== episodeId
            || revocation.mandate_digest !== mandate.mandate_digest
            || revocation.authorization_digest !== authorization.authorization_digest
            || revocation.human_public_key !== authorization.human_public_key
            || revocation.predecessor_state !== existing.predecessor_state
            || revocation.predecessor_state_digest !== existing.predecessor_state_digest
            || revocation.revoked_at_unix_seconds !== existing.revoked_at_unix_seconds
            || revocation.revocation_digest !== existing.authenticated_revocation_digest) {
          fail('bounded_agent_revocation_conflict', 'authenticated revocation conflicts with the durable episode revocation');
        }
        return Object.freeze({ revocation_result: 'ALREADY_REVOKED', episode_state: await currentState() });
      }
      const state = await currentState();
      validateHumanRevocationV1(revocation, { mandate, authorization, state });
      const revokedState = applyHumanRevocationV1({
        state,
        authorization_digest: authorization.authorization_digest,
      });
      const result = await revoke({
        episode_id: state.episode_id,
        mandate_digest: mandate.mandate_digest,
        authorization_digest: authorization.authorization_digest,
        executor_release_sha256,
        predecessor_state: state.state,
        predecessor_state_digest: state.state_digest,
        revoked_state_digest: revokedState.state_digest,
        revoked_at_unix_seconds: revocation.revoked_at_unix_seconds,
        revocation_digest: revocation.revocation_digest,
        successor_state: revokedState,
      });
      if (![
        'REVOKED',
        'ALREADY_REVOKED',
        'REVOCATION_RECORDED_SIGNING_AMBIGUOUS',
        'REVOKED_SIGNED_BYTES_DURABLE',
      ].includes(result)) {
        fail('bounded_agent_revocation_state_invalid', 'authenticated revocation did not linearize at the current durable episode state');
      }
      return Object.freeze({
        revocation_result: result,
        episode_state: await currentState(),
      });
    },
  });
}
