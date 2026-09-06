import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { domainSeparatedCanonicalBytesV1, verifyEd25519DomainSignatureV1 } from './authentication-domain-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { validateBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { validateReadinessChallengeV1 } from './readiness-challenge-v1.mjs';

export const AUTHENTICATED_AGENT_DECISION_VERSION_V1 = 'artifact_bounded_agent_authenticated_decision_v1';
export const AGENT_DECISION_DOMAIN_V1 = 'ARTIFACT_AGENT_CONTROL_DECISION_ED25519_V1';
const DIGEST = /^[0-9a-f]{64}$/;
const ACTIONS = ['INITIATE_ACQUISITION', 'REFUSE_ACQUISITION', 'INITIATE_FULL_DISPOSAL', 'REFUSE_DISPOSAL'];
const UNSIGNED_FIELDS = [
  'episode_id', 'action', 'ordinal', 'mandate_digest', 'authorization_digest',
  'challenge_digest', 'predecessor_state_digest', 'executor_release_sha256',
  'challenge_nonce', 'agent_public_key', 'signed_at_unix_seconds',
];
const FIELDS = ['agent_decision_version', 'decision_id', 'decision_digest', ...UNSIGNED_FIELDS, 'signature'];
function unsigned(value) { return Object.fromEntries(UNSIGNED_FIELDS.map(field => [field, value[field]])); }
function preimage(value) {
  return Object.fromEntries(FIELDS.filter(field => !['decision_id', 'decision_digest'].includes(field))
    .map(field => [field, value[field]]));
}
function expectedAction(phase, initiated) {
  if (phase === 'ACQUISITION') return initiated ? 'INITIATE_ACQUISITION' : 'REFUSE_ACQUISITION';
  return initiated ? 'INITIATE_FULL_DISPOSAL' : 'REFUSE_DISPOSAL';
}
function validateUnsigned(value) {
  assertExactFields(value, UNSIGNED_FIELDS, 'authenticated_agent_decision_unsigned');
  if (!ACTIONS.includes(value.action)) fail('bounded_agent_decision_action_invalid', 'agent decision action is invalid');
  for (const field of ['mandate_digest', 'authorization_digest', 'challenge_digest', 'predecessor_state_digest', 'executor_release_sha256', 'agent_public_key']) {
    if (typeof value[field] !== 'string' || !DIGEST.test(value[field])) fail('bounded_agent_decision_identity_invalid', `${field} is invalid`);
  }
  if (typeof value.episode_id !== 'string' || !/^bounded-agent-episode-[0-9a-f]{64}$/.test(value.episode_id)
      || ![1, 2].includes(value.ordinal)
      || typeof value.challenge_nonce !== 'string' || !/^[a-z0-9][a-z0-9._-]{15,127}$/.test(value.challenge_nonce)
      || !Number.isSafeInteger(value.signed_at_unix_seconds) || value.signed_at_unix_seconds < 0) {
    fail('bounded_agent_decision_semantics_invalid', 'agent decision semantics are invalid');
  }
}
export function agentDecisionSigningBytesV1(value) {
  validateUnsigned(value);
  return domainSeparatedCanonicalBytesV1(AGENT_DECISION_DOMAIN_V1, value);
}
export function validateAuthenticatedAgentDecisionV1(value, { mandate, authorization, challenge } = {}) {
  assertExactFields(value, FIELDS, 'authenticated_agent_decision');
  if (value.agent_decision_version !== AUTHENTICATED_AGENT_DECISION_VERSION_V1) fail('bounded_agent_decision_version_invalid', 'decision version is invalid');
  validateUnsigned(unsigned(value));
  verifyEd25519DomainSignatureV1({
    domain: AGENT_DECISION_DOMAIN_V1, value: unsigned(value), public_key: value.agent_public_key, signature: value.signature,
  });
  if (!DIGEST.test(value.decision_digest) || value.decision_digest !== sha256CanonicalJson(preimage(value))
      || value.decision_id !== `agent-decision-${value.decision_digest}`) {
    fail('bounded_agent_decision_identity_invalid', 'decision identity is invalid');
  }
  if (mandate !== undefined || authorization !== undefined || challenge !== undefined) {
    if (mandate === undefined || authorization === undefined || challenge === undefined) fail('bounded_agent_decision_context_missing', 'complete decision context is required');
    validateBoundedAgentMandateV1(mandate);
    validateHumanEpisodeAuthorizationV1(authorization, { mandate });
    validateReadinessChallengeV1(challenge);
    if (value.agent_public_key !== authorization.agent_public_key) fail('bounded_agent_decision_agent_identity_mismatch', 'decision agent identity is not authorized');
    if (value.episode_id !== challenge.episode_id || value.mandate_digest !== mandate.mandate_digest
        || value.authorization_digest !== authorization.authorization_digest
        || value.challenge_digest !== challenge.challenge_digest
        || value.predecessor_state_digest !== challenge.predecessor_state_digest
        || value.executor_release_sha256 !== challenge.executor_release_sha256
        || value.challenge_nonce !== challenge.challenge_nonce || value.ordinal !== challenge.ordinal
        || ![expectedAction(challenge.phase, true), expectedAction(challenge.phase, false)].includes(value.action)) {
      fail('bounded_agent_decision_context_mismatch', 'decision does not bind the current authorized challenge');
    }
  }
  return true;
}
export function buildAuthenticatedAgentDecisionV1(input) {
  assertExactFields(input, [...UNSIGNED_FIELDS, 'signature'], 'authenticated_agent_decision_input');
  validateUnsigned(unsigned(input));
  const value = {
    agent_decision_version: AUTHENTICATED_AGENT_DECISION_VERSION_V1,
    decision_id: `agent-decision-${'0'.repeat(64)}`,
    decision_digest: '0'.repeat(64),
    ...Object.fromEntries([...UNSIGNED_FIELDS, 'signature'].map(field => [field, input[field]])),
  };
  value.decision_digest = sha256CanonicalJson(preimage(value));
  value.decision_id = `agent-decision-${value.decision_digest}`;
  validateAuthenticatedAgentDecisionV1(value);
  return cloneAndFreeze(value);
}
