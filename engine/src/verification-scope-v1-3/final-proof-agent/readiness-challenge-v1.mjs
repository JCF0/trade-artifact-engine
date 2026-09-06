import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';

export const READINESS_CHALLENGE_VERSION_V1 = 'artifact_bounded_agent_readiness_challenge_v1';
export const MAX_READINESS_CHALLENGE_LIFETIME_SECONDS_V1 = 300;
const DIGEST = /^[0-9a-f]{64}$/;
const RAW = /^(?:0|[1-9][0-9]*)$/;
const INPUT_FIELDS = [
  'episode_id', 'phase', 'ordinal', 'mandate_digest', 'authorization_digest',
  'predecessor_state', 'predecessor_state_digest', 'executor_release_sha256',
  'challenge_nonce', 'readiness_evidence_digest', 'issued_at_unix_seconds', 'expires_at_unix_seconds', 'readiness_status',
  'finalized_acquisition_evidence_digest', 'chain_derived_disposal_jup_raw', 'disposal_quantity_rule',
];
const FIELDS = ['readiness_challenge_version', 'challenge_id', 'challenge_digest', ...INPUT_FIELDS];
function preimage(value) {
  return Object.fromEntries(FIELDS.filter(field => !['challenge_id', 'challenge_digest'].includes(field))
    .map(field => [field, value[field]]));
}
export function validateReadinessChallengeV1(value) {
  assertExactFields(value, FIELDS, 'bounded_agent_readiness_challenge');
  if (value.readiness_challenge_version !== READINESS_CHALLENGE_VERSION_V1) fail('bounded_agent_challenge_version_invalid', 'challenge version is invalid');
  for (const field of ['mandate_digest', 'authorization_digest', 'predecessor_state_digest', 'executor_release_sha256', 'readiness_evidence_digest']) {
    if (typeof value[field] !== 'string' || !DIGEST.test(value[field])) fail('bounded_agent_challenge_identity_invalid', `${field} is invalid`);
  }
  if (typeof value.episode_id !== 'string' || !/^bounded-agent-episode-[0-9a-f]{64}$/.test(value.episode_id)
      || typeof value.challenge_nonce !== 'string' || !/^[a-z0-9][a-z0-9._-]{15,127}$/.test(value.challenge_nonce)
      || value.readiness_status !== 'READY'
      || value.disposal_quantity_rule !== 'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE'
      || !Number.isSafeInteger(value.issued_at_unix_seconds) || value.issued_at_unix_seconds < 0
      || !Number.isSafeInteger(value.expires_at_unix_seconds) || value.expires_at_unix_seconds <= value.issued_at_unix_seconds
      || value.expires_at_unix_seconds - value.issued_at_unix_seconds > MAX_READINESS_CHALLENGE_LIFETIME_SECONDS_V1) {
    fail('bounded_agent_challenge_semantics_invalid', 'challenge semantics are invalid');
  }
  const acquisition = value.phase === 'ACQUISITION' && value.ordinal === 1
    && value.predecessor_state === 'AUTHORIZED_DORMANT'
    && value.finalized_acquisition_evidence_digest === null && value.chain_derived_disposal_jup_raw === null;
  const disposal = value.phase === 'DISPOSAL' && value.ordinal === 2
    && value.predecessor_state === 'ACQUISITION_EVIDENCE_CLOSED'
    && typeof value.finalized_acquisition_evidence_digest === 'string'
    && DIGEST.test(value.finalized_acquisition_evidence_digest)
    && typeof value.chain_derived_disposal_jup_raw === 'string'
    && RAW.test(value.chain_derived_disposal_jup_raw) && value.chain_derived_disposal_jup_raw !== '0';
  if (!acquisition && !disposal) fail('bounded_agent_challenge_phase_invalid', 'challenge phase, ordinal, predecessor, or disposal authority is invalid');
  if (!DIGEST.test(value.challenge_digest) || value.challenge_digest !== sha256CanonicalJson(preimage(value))
      || value.challenge_id !== `readiness-challenge-${value.challenge_digest}`) {
    fail('bounded_agent_challenge_identity_invalid', 'challenge identity is invalid');
  }
  return true;
}
export function buildReadinessChallengeV1(input) {
  assertExactFields(input, INPUT_FIELDS, 'bounded_agent_readiness_challenge_input');
  const value = {
    readiness_challenge_version: READINESS_CHALLENGE_VERSION_V1,
    challenge_id: `readiness-challenge-${'0'.repeat(64)}`,
    challenge_digest: '0'.repeat(64),
    ...Object.fromEntries(INPUT_FIELDS.map(field => [field, input[field]])),
  };
  value.challenge_digest = sha256CanonicalJson(preimage(value));
  value.challenge_id = `readiness-challenge-${value.challenge_digest}`;
  validateReadinessChallengeV1(value);
  return cloneAndFreeze(value);
}
