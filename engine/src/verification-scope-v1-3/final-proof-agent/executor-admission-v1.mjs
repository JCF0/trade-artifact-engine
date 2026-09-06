import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { validateAuthenticatedAgentDecisionV1 } from './agent-decision-v1.mjs';

export const EXECUTOR_ADMISSION_VERSION_V1 = 'artifact_bounded_agent_executor_admission_v1';
const DIGEST = /^[0-9a-f]{64}$/;
const FIELDS = [
  'executor_admission_version', 'admission_id', 'admission_digest', 'episode_id',
  'phase', 'ordinal', 'status', 'reason', 'mandate_digest', 'authorization_digest',
  'challenge_digest', 'decision_digest', 'predecessor_state', 'predecessor_state_digest',
  'executor_release_sha256', 'disposal_quantity_rule', 'chain_derived_disposal_jup_raw',
  'admitted_at_unix_seconds',
];
function preimage(value) {
  return Object.fromEntries(FIELDS.filter(field => !['admission_id', 'admission_digest'].includes(field))
    .map(field => [field, value[field]]));
}
export function validateExecutorAdmissionV1(value, { mandate, authorization, challenge, decision } = {}) {
  assertExactFields(value, FIELDS, 'bounded_agent_executor_admission');
  if (value.executor_admission_version !== EXECUTOR_ADMISSION_VERSION_V1) fail('bounded_agent_admission_version_invalid', 'admission version is invalid');
  for (const field of ['mandate_digest', 'authorization_digest', 'challenge_digest', 'decision_digest', 'predecessor_state_digest', 'executor_release_sha256']) {
    if (typeof value[field] !== 'string' || !DIGEST.test(value[field])) fail('bounded_agent_admission_identity_invalid', `${field} is invalid`);
  }
  const expectedStatus = decision?.action?.startsWith('INITIATE_') ? 'ADMITTED' : 'REFUSED';
  const expectedReason = expectedStatus === 'ADMITTED' ? null : 'AGENT_REFUSED';
  const acquisition = value.phase === 'ACQUISITION' && value.ordinal === 1
    && value.predecessor_state === 'AUTHORIZED_DORMANT'
    && value.chain_derived_disposal_jup_raw === null;
  const disposal = value.phase === 'DISPOSAL' && value.ordinal === 2
    && value.predecessor_state === 'ACQUISITION_EVIDENCE_CLOSED'
    && typeof value.chain_derived_disposal_jup_raw === 'string'
    && /^(?:[1-9][0-9]*)$/.test(value.chain_derived_disposal_jup_raw);
  const statusShape = (value.status === 'ADMITTED' && value.reason === null)
    || (value.status === 'REFUSED' && value.reason === 'AGENT_REFUSED');
  if ((!acquisition && !disposal) || !statusShape
      || typeof value.episode_id !== 'string' || !/^bounded-agent-episode-[0-9a-f]{64}$/.test(value.episode_id)
      || !Number.isSafeInteger(value.admitted_at_unix_seconds) || value.admitted_at_unix_seconds < 0
      || value.disposal_quantity_rule !== 'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE') {
    fail('bounded_agent_admission_semantics_invalid', 'admission semantics are invalid');
  }
  if (mandate !== undefined || authorization !== undefined || challenge !== undefined || decision !== undefined) {
    if ([mandate, authorization, challenge, decision].some(item => item === undefined)) fail('bounded_agent_admission_context_missing', 'complete admission context is required');
    validateAuthenticatedAgentDecisionV1(decision, { mandate, authorization, challenge });
    if (value.episode_id !== challenge.episode_id || value.phase !== challenge.phase || value.ordinal !== challenge.ordinal
        || value.status !== expectedStatus || value.reason !== expectedReason
        || value.mandate_digest !== mandate.mandate_digest
        || value.authorization_digest !== authorization.authorization_digest
        || value.challenge_digest !== challenge.challenge_digest
        || value.decision_digest !== decision.decision_digest
        || value.predecessor_state !== challenge.predecessor_state
        || value.predecessor_state_digest !== challenge.predecessor_state_digest
        || value.executor_release_sha256 !== challenge.executor_release_sha256
        || value.chain_derived_disposal_jup_raw !== challenge.chain_derived_disposal_jup_raw) {
      fail('bounded_agent_admission_context_mismatch', 'admission does not bind its complete authority chain');
    }
  }
  if (!DIGEST.test(value.admission_digest) || value.admission_digest !== sha256CanonicalJson(preimage(value))
      || value.admission_id !== `executor-admission-${value.admission_digest}`) {
    fail('bounded_agent_admission_identity_invalid', 'admission identity is invalid');
  }
  return true;
}
export function buildExecutorAdmissionV1({
  mandate, authorization, challenge, decision, expected_predecessor_state,
  expected_predecessor_state_digest, expected_executor_release_sha256, now_unix_seconds,
}) {
  validateAuthenticatedAgentDecisionV1(decision, { mandate, authorization, challenge });
  if (challenge.episode_id !== `bounded-agent-episode-${authorization.authorization_digest}`) {
    fail('bounded_agent_admission_episode_mismatch', 'challenge does not bind the authorized episode');
  }
  if (challenge.predecessor_state !== expected_predecessor_state
      || challenge.predecessor_state_digest !== expected_predecessor_state_digest) {
    fail('bounded_agent_admission_predecessor_mismatch', 'challenge does not bind the expected predecessor state');
  }
  if (challenge.executor_release_sha256 !== expected_executor_release_sha256
      || authorization.executor_release_sha256 !== expected_executor_release_sha256) {
    fail('bounded_agent_admission_executor_mismatch', 'executor release is not authorized');
  }
  if (now_unix_seconds < authorization.issued_at_unix_seconds
      || now_unix_seconds < authorization.not_before_unix_seconds
      || now_unix_seconds >= challenge.expires_at_unix_seconds
      || decision.signed_at_unix_seconds < challenge.issued_at_unix_seconds
      || decision.signed_at_unix_seconds >= challenge.expires_at_unix_seconds
      || decision.signed_at_unix_seconds > now_unix_seconds
      || (challenge.phase === 'ACQUISITION'
        && now_unix_seconds >= authorization.acquisition_not_after_unix_seconds)) {
    fail('bounded_agent_decision_stale', 'decision or authorization is stale');
  }
  const admitted = decision.action.startsWith('INITIATE_');
  const value = {
    executor_admission_version: EXECUTOR_ADMISSION_VERSION_V1,
    admission_id: `executor-admission-${'0'.repeat(64)}`,
    admission_digest: '0'.repeat(64),
    episode_id: challenge.episode_id,
    phase: challenge.phase,
    ordinal: challenge.ordinal,
    status: admitted ? 'ADMITTED' : 'REFUSED',
    reason: admitted ? null : 'AGENT_REFUSED',
    mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest,
    challenge_digest: challenge.challenge_digest,
    decision_digest: decision.decision_digest,
    predecessor_state: challenge.predecessor_state,
    predecessor_state_digest: challenge.predecessor_state_digest,
    executor_release_sha256: challenge.executor_release_sha256,
    disposal_quantity_rule: challenge.disposal_quantity_rule,
    chain_derived_disposal_jup_raw: challenge.chain_derived_disposal_jup_raw,
    admitted_at_unix_seconds: now_unix_seconds,
  };
  value.admission_digest = sha256CanonicalJson(preimage(value));
  value.admission_id = `executor-admission-${value.admission_digest}`;
  validateExecutorAdmissionV1(value, { mandate, authorization, challenge, decision });
  return cloneAndFreeze(value);
}
