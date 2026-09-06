import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { domainSeparatedCanonicalBytesV1, verifyEd25519DomainSignatureV1 } from './authentication-domain-v1.mjs';
import { validateBoundedAgentMandateV1 } from './mandate-v1.mjs';

export const HUMAN_EPISODE_AUTHORIZATION_VERSION_V1 = 'artifact_bounded_agent_human_authorization_v1';
export const HUMAN_EPISODE_AUTHORIZATION_DOMAIN_V1 = 'ARTIFACT_HUMAN_EPISODE_AUTHORIZATION_ED25519_V1';
const DIGEST = /^[0-9a-f]{64}$/;
const UNSIGNED_FIELDS = [
  'mandate_digest', 'human_public_key', 'agent_public_key', 'executor_release_sha256',
  'authorization_nonce', 'issued_at_unix_seconds', 'not_before_unix_seconds',
  'acquisition_not_after_unix_seconds', 'authorization_statement', 'revocation_status',
];
const FIELDS = [
  'authorization_version', 'authorization_id', 'authorization_digest',
  ...UNSIGNED_FIELDS, 'signature',
];
function unsigned(value) { return Object.fromEntries(UNSIGNED_FIELDS.map(field => [field, value[field]])); }
function digestPreimage(value) {
  return Object.fromEntries(FIELDS.filter(field => !['authorization_id', 'authorization_digest'].includes(field))
    .map(field => [field, value[field]]));
}
function validateUnsigned(value) {
  assertExactFields(value, UNSIGNED_FIELDS, 'human_episode_authorization_unsigned');
  for (const field of ['mandate_digest', 'human_public_key', 'agent_public_key', 'executor_release_sha256']) {
    if (typeof value[field] !== 'string' || !DIGEST.test(value[field])) fail('bounded_agent_authorization_identity_invalid', `${field} is invalid`);
  }
  for (const field of ['issued_at_unix_seconds', 'not_before_unix_seconds', 'acquisition_not_after_unix_seconds']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) fail('bounded_agent_authorization_time_invalid', `${field} is invalid`);
  }
  if (value.not_before_unix_seconds >= value.acquisition_not_after_unix_seconds
      || value.issued_at_unix_seconds >= value.acquisition_not_after_unix_seconds) {
    fail('bounded_agent_authorization_time_invalid', 'authorization interval is invalid');
  }
  if (typeof value.authorization_nonce !== 'string' || !/^[a-z0-9][a-z0-9._-]{15,127}$/.test(value.authorization_nonce)
      || value.authorization_statement !== 'AUTHORIZE_ONE_BOUNDED_AGENT_DIRECTED_TWO_SWAP_FINAL_PROOF_EPISODE'
      || value.revocation_status !== 'NOT_REVOKED') {
    fail('bounded_agent_authorization_semantics_invalid', 'human authorization semantics are invalid');
  }
  return true;
}
export function humanAuthorizationSigningBytesV1(value) {
  validateUnsigned(value);
  return domainSeparatedCanonicalBytesV1(HUMAN_EPISODE_AUTHORIZATION_DOMAIN_V1, value);
}
export function validateHumanEpisodeAuthorizationV1(value, { mandate } = {}) {
  assertExactFields(value, FIELDS, 'human_episode_authorization');
  if (value.authorization_version !== HUMAN_EPISODE_AUTHORIZATION_VERSION_V1) fail('bounded_agent_authorization_version_invalid', 'authorization version is invalid');
  validateUnsigned(unsigned(value));
  verifyEd25519DomainSignatureV1({
    domain: HUMAN_EPISODE_AUTHORIZATION_DOMAIN_V1, value: unsigned(value),
    public_key: value.human_public_key, signature: value.signature,
  });
  if (!DIGEST.test(value.authorization_digest)
      || value.authorization_digest !== sha256CanonicalJson(digestPreimage(value))
      || value.authorization_id !== `human-authorization-${value.authorization_digest}`) {
    fail('bounded_agent_authorization_identity_invalid', 'authorization identity is invalid');
  }
  if (mandate !== undefined) {
    validateBoundedAgentMandateV1(mandate);
    const authority = mandate.unresolved_live_readiness.status === 'RESOLVED'
      ? mandate.unresolved_live_readiness
      : mandate.offline_identity;
    if (value.mandate_digest !== mandate.mandate_digest
        || value.executor_release_sha256 !== authority.executor_release_sha256
        || value.human_public_key !== authority.human_authorization_public_key
        || value.agent_public_key !== authority.agent_control_public_key
        || value.not_before_unix_seconds !== mandate.age_gate.earliest_opening_candidate_unix_seconds
        || value.acquisition_not_after_unix_seconds !== authority.acquisition_not_after_unix_seconds) {
      fail('bounded_agent_authorization_mandate_mismatch', 'authorization does not bind the mandate');
    }
  }
  return true;
}
export function buildHumanEpisodeAuthorizationV1(input) {
  assertExactFields(input, [...UNSIGNED_FIELDS, 'signature'], 'human_episode_authorization_input');
  validateUnsigned(unsigned(input));
  const value = {
    authorization_version: HUMAN_EPISODE_AUTHORIZATION_VERSION_V1,
    authorization_id: `human-authorization-${'0'.repeat(64)}`,
    authorization_digest: '0'.repeat(64),
    ...Object.fromEntries([...UNSIGNED_FIELDS, 'signature'].map(field => [field, input[field]])),
  };
  value.authorization_digest = sha256CanonicalJson(digestPreimage(value));
  value.authorization_id = `human-authorization-${value.authorization_digest}`;
  validateHumanEpisodeAuthorizationV1(value);
  return cloneAndFreeze(value);
}
