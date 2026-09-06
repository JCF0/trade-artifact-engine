import { types as utilTypes } from 'node:util';

import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import {
  admitAgentDecisionStateV1,
  applyHumanRevocationV1,
  recordSignedIntentV1,
  validateBoundedAgentEpisodeStateV1,
} from './episode-state-machine-v1.mjs';

const DIGEST = /^[0-9a-f]{64}$/;
const RAW = /^(?:0|[1-9][0-9]*)$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const PREPARED_FIELDS = [
  'prepared_transaction_version', 'episode_id', 'phase', 'admission_digest', 'wallet', 'pool',
  'input_mint', 'output_mint', 'input_raw_quantity', 'maximum_slippage_bps',
  'transaction_profile', 'unsigned_transaction_digest', 'readiness_evidence_digest',
];
const SIGNED_FIELDS = [
  'signed_transaction_intent_version', 'episode_id', 'phase', 'admission_digest',
  'semantic_transaction_digest', 'message_sha256', 'signed_wire_sha256', 'signature', 'sign_count',
];
function capability(value, fields, context) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      fail('bounded_agent_executor_capability_invalid', `${context} is invalid`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) if (!fields.includes(key)) fail('bounded_agent_executor_capability_invalid', `${context} has an unknown field`);
    for (const field of fields) if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value') || typeof descriptors[field].value !== 'function') {
      fail('bounded_agent_executor_capability_invalid', `${context}.${field} is unavailable`);
    }
    return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
  } catch (error) {
    if (error?.name === 'VerificationScopeError') throw error;
    fail('bounded_agent_executor_capability_invalid', `${context} is unavailable`);
  }
}
function validatePrepared(value, { mandate, challenge, admission }) {
  assertExactFields(value, PREPARED_FIELDS, 'bounded_agent_prepared_transaction');
  const acquisition = challenge.phase === 'ACQUISITION';
  const expectedInput = acquisition ? mandate.economic_authority.acquisition_input_usdc_raw : challenge.chain_derived_disposal_jup_raw;
  const expectedInputMint = acquisition ? mandate.asset_scope.usdc_mint : mandate.asset_scope.jup_mint;
  const expectedOutputMint = acquisition ? mandate.asset_scope.jup_mint : mandate.asset_scope.usdc_mint;
  if (value.prepared_transaction_version !== 'artifact_bounded_agent_prepared_transaction_v1'
      || value.episode_id !== challenge.episode_id || value.phase !== challenge.phase
      || value.admission_digest !== admission.admission_digest || value.wallet !== mandate.wallet_scope.wallet
      || value.pool !== mandate.route_scope.pool || value.input_mint !== expectedInputMint
      || value.output_mint !== expectedOutputMint || value.input_raw_quantity !== expectedInput
      || !RAW.test(value.input_raw_quantity) || value.maximum_slippage_bps !== mandate.economic_authority.maximum_slippage_bps
      || value.transaction_profile !== 'DIRECT_CLASSIC_ORCA_LEGACY_SWAP_V1'
      || !DIGEST.test(value.unsigned_transaction_digest)
      || value.readiness_evidence_digest !== challenge.readiness_evidence_digest) {
    fail('bounded_agent_prepared_transaction_mismatch', 'prepared transaction is outside the admitted mandate');
  }
  return true;
}
function signedPreimage(value) { return Object.fromEntries(SIGNED_FIELDS.map(field => [field, value[field]])); }
export function validateSignedTransactionIntentV1(value, { prepared, admission }) {
  assertExactFields(value, SIGNED_FIELDS, 'bounded_agent_signed_transaction_intent');
  if (value.signed_transaction_intent_version !== 'artifact_bounded_agent_signed_transaction_intent_v1'
      || value.episode_id !== prepared.episode_id || value.phase !== prepared.phase
      || value.admission_digest !== admission.admission_digest
      || value.semantic_transaction_digest !== prepared.unsigned_transaction_digest
      || !DIGEST.test(value.message_sha256) || !DIGEST.test(value.signed_wire_sha256)
      || typeof value.signature !== 'string' || !SOLANA_SIGNATURE.test(value.signature)
      || value.sign_count !== 1) {
    fail('bounded_agent_signed_intent_invalid', 'signed transaction intent does not bind the admitted transaction');
  }
  return true;
}
export function createOfflineBoundedExecutorCoreV1(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) fail('bounded_agent_executor_capability_invalid', 'executor input is invalid');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expected = ['executor_release_sha256', 'decision_consumption_port', 'execution_port', 'wallet_signer_port'];
  for (const key of Object.keys(descriptors)) if (!expected.includes(key)) fail('bounded_agent_executor_capability_invalid', 'executor input has unknown field');
  for (const field of expected) if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')) fail('bounded_agent_executor_capability_invalid', `executor input is missing ${field}`);
  const executorRelease = descriptors.executor_release_sha256.value;
  if (typeof executorRelease !== 'string' || !DIGEST.test(executorRelease)) fail('bounded_agent_executor_identity_invalid', 'executor release identity is invalid');
  const consumption = capability(descriptors.decision_consumption_port.value,
    ['consumeEpisodeOrdinalV1', 'revokeAuthorizationV1'], 'decision_consumption_port');
  const execution = capability(descriptors.execution_port.value, ['prepareBoundedLegV1'], 'execution_port');
  const signer = capability(descriptors.wallet_signer_port.value, ['signAdmittedTransactionV1'], 'wallet_signer_port');
  const consumedDecisions = new Set();
  const consumedChallenges = new Set();
  const core = {
    async executeAgentDecisionV1({ state, mandate, authorization, challenge, decision, now_unix_seconds }) {
      validateBoundedAgentEpisodeStateV1(state);
      if (consumedDecisions.has(decision?.decision_id) || consumedChallenges.has(challenge?.challenge_id)) {
        fail('bounded_agent_decision_replay', 'decision or challenge has already been consumed by this executor');
      }
      const transitioned = admitAgentDecisionStateV1({
        state, mandate, authorization, challenge, decision,
        executor_release_sha256: executorRelease, now_unix_seconds,
      });
      const consumptionResult = await consumption.consumeEpisodeOrdinalV1({
        episode_id: state.episode_id,
        authorization_digest: state.authorization_digest,
        ordinal: challenge.ordinal,
        predecessor_state_digest: state.state_digest,
        decision_id: decision.decision_id,
        challenge_id: challenge.challenge_id,
        admission_digest: transitioned.admission.admission_digest,
      });
      if (consumptionResult === 'REVOKED') {
        fail('bounded_agent_authorization_revoked', 'authorization is revoked in the atomic episode authority');
      }
      if (consumptionResult !== 'CONSUMED') {
        fail('bounded_agent_decision_replay', 'decision or challenge was not atomically consumed');
      }
      consumedDecisions.add(decision.decision_id);
      consumedChallenges.add(challenge.challenge_id);
      if (transitioned.admission.status === 'REFUSED') return cloneAndFreeze(transitioned);
      const prepared = await execution.prepareBoundedLegV1({ mandate, challenge, admission: transitioned.admission });
      validatePrepared(prepared, { mandate, challenge, admission: transitioned.admission });
      const signedIntent = await signer.signAdmittedTransactionV1({ admission: transitioned.admission, prepared_transaction: prepared });
      validateSignedTransactionIntentV1(signedIntent, { prepared, admission: transitioned.admission });
      const signedIntentDigest = sha256CanonicalJson(signedPreimage(signedIntent));
      const submittedState = recordSignedIntentV1({ state: transitioned.state, signed_intent_digest: signedIntentDigest });
      return cloneAndFreeze({
        state: submittedState, admission: transitioned.admission,
        prepared_transaction: prepared, signed_transaction_intent: signedIntent,
        signed_transaction_intent_digest: signedIntentDigest,
      });
    },
    async revokeHumanAuthorizationV1({ state, authorization_digest }) {
      const revoked = applyHumanRevocationV1({ state, authorization_digest });
      const result = await consumption.revokeAuthorizationV1({
        episode_id: state.episode_id,
        authorization_digest,
        predecessor_state: state.state,
        predecessor_state_digest: state.state_digest,
        revoked_state_digest: revoked.state_digest,
      });
      if (result !== 'REVOKED') {
        fail('bounded_agent_revocation_state_invalid', 'authorization revocation did not match the atomic episode authority');
      }
      return revoked;
    },
  };
  return Object.freeze(core);
}
