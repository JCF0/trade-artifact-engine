import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { domainSeparatedCanonicalBytesV1, verifyEd25519DomainSignatureV1 } from './authentication-domain-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { validateExecutorMandateV1 as validateBoundedAgentMandateV1 } from './executor-mandate-profile-v1.mjs';
import { validateBoundedAgentEpisodeStateV1 } from './episode-state-machine-v1.mjs';

export const HUMAN_REVOCATION_VERSION_V1 = 'artifact_bounded_agent_human_revocation_v1';
export const HUMAN_REVOCATION_DOMAIN_V1 = 'ARTIFACT_HUMAN_AUTHORIZATION_REVOCATION_ED25519_V1';
const DIGEST = /^[0-9a-f]{64}$/;
const UNSIGNED_FIELDS = [
  'episode_id', 'mandate_digest', 'authorization_digest', 'human_public_key',
  'predecessor_state', 'predecessor_state_digest', 'revoked_at_unix_seconds',
  'revocation_nonce', 'revocation_statement',
];
const FIELDS = ['human_revocation_version', 'revocation_id', 'revocation_digest', ...UNSIGNED_FIELDS, 'signature'];
function unsigned(value) { return Object.fromEntries(UNSIGNED_FIELDS.map(field => [field, value[field]])); }
function preimage(value) {
  return Object.fromEntries(FIELDS.filter(field => !['revocation_id', 'revocation_digest'].includes(field))
    .map(field => [field, value[field]]));
}
function validateUnsigned(value) {
  assertExactFields(value, UNSIGNED_FIELDS, 'bounded_agent_human_revocation_unsigned');
  if (typeof value.episode_id !== 'string' || !/^bounded-agent-episode-[0-9a-f]{64}$/.test(value.episode_id)) {
    fail('bounded_agent_revocation_identity_invalid', 'revocation episode identity is invalid');
  }
  for (const field of ['mandate_digest', 'authorization_digest', 'human_public_key', 'predecessor_state_digest']) {
    if (typeof value[field] !== 'string' || !DIGEST.test(value[field])) fail('bounded_agent_revocation_identity_invalid', `${field} is invalid`);
  }
  if (!['AUTHORIZED_DORMANT', 'ACQUISITION_ADMITTED', 'ACQUISITION_EVIDENCE_CLOSED',
    'DISPOSAL_ADMITTED', 'ACQUISITION_SUBMISSION_RESOLVING', 'DISPOSAL_SUBMISSION_RESOLVING'].includes(value.predecessor_state)
      || !Number.isSafeInteger(value.revoked_at_unix_seconds) || value.revoked_at_unix_seconds < 0
      || typeof value.revocation_nonce !== 'string' || !/^[a-z0-9][a-z0-9._-]{15,127}$/.test(value.revocation_nonce)
      || value.revocation_statement !== 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION') {
    fail('bounded_agent_revocation_semantics_invalid', 'human revocation semantics are invalid');
  }
  return true;
}
export function humanRevocationSigningBytesV1(value) {
  validateUnsigned(value);
  return domainSeparatedCanonicalBytesV1(HUMAN_REVOCATION_DOMAIN_V1, value);
}
export function validateHumanRevocationV1(value, { mandate, authorization, state } = {}) {
  assertExactFields(value, FIELDS, 'bounded_agent_human_revocation');
  if (value.human_revocation_version !== HUMAN_REVOCATION_VERSION_V1) fail('bounded_agent_revocation_version_invalid', 'human revocation version is invalid');
  validateUnsigned(unsigned(value));
  verifyEd25519DomainSignatureV1({
    domain: HUMAN_REVOCATION_DOMAIN_V1,
    value: unsigned(value),
    public_key: value.human_public_key,
    signature: value.signature,
  });
  if (!DIGEST.test(value.revocation_digest) || value.revocation_digest !== sha256CanonicalJson(preimage(value))
      || value.revocation_id !== `human-revocation-${value.revocation_digest}`) {
    fail('bounded_agent_revocation_identity_invalid', 'human revocation identity is invalid');
  }
  if (mandate !== undefined || authorization !== undefined || state !== undefined) {
    if ([mandate, authorization, state].some(item => item === undefined)) fail('bounded_agent_revocation_context_missing', 'complete revocation context is required');
    validateBoundedAgentMandateV1(mandate);
    validateHumanEpisodeAuthorizationV1(authorization, { mandate });
    validateBoundedAgentEpisodeStateV1(state);
    if (value.episode_id !== state.episode_id
        || value.episode_id !== `bounded-agent-episode-${authorization.authorization_digest}`
        || value.mandate_digest !== mandate.mandate_digest
        || value.authorization_digest !== authorization.authorization_digest
        || value.human_public_key !== authorization.human_public_key
        || value.predecessor_state !== state.state
        || value.predecessor_state_digest !== state.state_digest) {
      fail('bounded_agent_revocation_context_mismatch', 'revocation does not bind the current human-authorized episode state');
    }
  }
  return true;
}
export function buildHumanRevocationV1(input) {
  assertExactFields(input, [...UNSIGNED_FIELDS, 'signature'], 'bounded_agent_human_revocation_input');
  validateUnsigned(unsigned(input));
  const value = {
    human_revocation_version: HUMAN_REVOCATION_VERSION_V1,
    revocation_id: `human-revocation-${'0'.repeat(64)}`,
    revocation_digest: '0'.repeat(64),
    ...Object.fromEntries([...UNSIGNED_FIELDS, 'signature'].map(field => [field, input[field]])),
  };
  value.revocation_digest = sha256CanonicalJson(preimage(value));
  value.revocation_id = `human-revocation-${value.revocation_digest}`;
  validateHumanRevocationV1(value);
  return cloneAndFreeze(value);
}
