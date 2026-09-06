import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { buildExecutorAdmissionV1 } from './executor-admission-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { validateBoundedAgentMandateV1 } from './mandate-v1.mjs';

export const BOUNDED_AGENT_EPISODE_STATE_VERSION_V1 = 'artifact_bounded_agent_episode_state_v1';
const DIGEST = /^[0-9a-f]{64}$/;
const RAW = /^(?:0|[1-9][0-9]*)$/;
const FIELDS = [
  'episode_state_version', 'state_id', 'state_digest', 'episode_id', 'mandate_digest',
  'authorization_digest', 'state', 'next_ordinal', 'possible_submission', 'human_revocation_status',
  'consumed_decision_ids', 'consumed_challenge_ids', 'signed_intent_digest',
  'acquisition_evidence_digest', 'chain_derived_acquired_jup_raw', 'disposal_evidence_digest',
];
const STATES = new Set([
  'AUTHORIZED_DORMANT', 'ACQUISITION_ADMITTED', 'ACQUISITION_SUBMISSION_RESOLVING',
  'ACQUISITION_EVIDENCE_CLOSED', 'DISPOSAL_ADMITTED', 'DISPOSAL_SUBMISSION_RESOLVING',
  'DISPOSAL_EVIDENCE_CLOSED', 'AGENT_REFUSED_ACQUISITION', 'AGENT_REFUSED_DISPOSAL',
  'REVOKED_BEFORE_FIRST_ADMISSION', 'REVOKED_AFTER_ACQUISITION', 'REVOKED_AFTER_DISPOSAL',
  'RESOLUTION_REQUIRED_AFTER_REVOCATION',
]);
function preimage(value) {
  return Object.fromEntries(FIELDS.filter(field => !['state_id', 'state_digest'].includes(field))
    .map(field => [field, value[field]]));
}
function issue(fields) {
  const value = {
    episode_state_version: BOUNDED_AGENT_EPISODE_STATE_VERSION_V1,
    state_id: `episode-state-${'0'.repeat(64)}`,
    state_digest: '0'.repeat(64),
    ...fields,
  };
  value.state_digest = sha256CanonicalJson(preimage(value));
  value.state_id = `episode-state-${value.state_digest}`;
  validateBoundedAgentEpisodeStateV1(value);
  return cloneAndFreeze(value);
}
function next(state, changes) {
  return issue({ ...Object.fromEntries(FIELDS.slice(3).map(field => [field, state[field]])), ...changes });
}
export function validateBoundedAgentEpisodeStateV1(value) {
  assertExactFields(value, FIELDS, 'bounded_agent_episode_state');
  if (value.episode_state_version !== BOUNDED_AGENT_EPISODE_STATE_VERSION_V1
      || !STATES.has(value.state) || ![1, 2, null].includes(value.next_ordinal)
      || typeof value.possible_submission !== 'boolean'
      || !['NOT_REVOKED', 'REVOKED'].includes(value.human_revocation_status)
      || !Array.isArray(value.consumed_decision_ids) || !Array.isArray(value.consumed_challenge_ids)
      || value.consumed_decision_ids.length !== value.consumed_challenge_ids.length
      || value.consumed_decision_ids.length > 2
      || value.consumed_decision_ids.length !== new Set(value.consumed_decision_ids).size
      || value.consumed_challenge_ids.length !== new Set(value.consumed_challenge_ids).size
      || typeof value.episode_id !== 'string' || !/^bounded-agent-episode-[0-9a-f]{64}$/.test(value.episode_id)) {
    fail('bounded_agent_state_semantics_invalid', 'episode state semantics are invalid');
  }
  for (const field of ['mandate_digest', 'authorization_digest']) if (!DIGEST.test(value[field])) fail('bounded_agent_state_identity_invalid', `${field} is invalid`);
  if (value.consumed_decision_ids.some(id => typeof id !== 'string' || !/^agent-decision-[0-9a-f]{64}$/.test(id))
      || value.consumed_challenge_ids.some(id => typeof id !== 'string' || !/^readiness-challenge-[0-9a-f]{64}$/.test(id))) {
    fail('bounded_agent_state_identity_invalid', 'consumed decision or challenge identity is invalid');
  }
  for (const field of ['signed_intent_digest', 'acquisition_evidence_digest', 'disposal_evidence_digest']) {
    if (value[field] !== null && (typeof value[field] !== 'string' || !DIGEST.test(value[field]))) fail('bounded_agent_state_identity_invalid', `${field} is invalid`);
  }
  if (value.chain_derived_acquired_jup_raw !== null && (!RAW.test(value.chain_derived_acquired_jup_raw) || value.chain_derived_acquired_jup_raw === '0')) {
    fail('bounded_agent_state_semantics_invalid', 'chain-derived acquired quantity is invalid');
  }
  const hasAcquisition = value.acquisition_evidence_digest !== null && value.chain_derived_acquired_jup_raw !== null;
  if ((value.acquisition_evidence_digest === null) !== (value.chain_derived_acquired_jup_raw === null)) {
    fail('bounded_agent_state_semantics_invalid', 'acquisition evidence state does not reconcile');
  }
  const requiresAcquisition = ['ACQUISITION_EVIDENCE_CLOSED', 'DISPOSAL_ADMITTED', 'DISPOSAL_SUBMISSION_RESOLVING',
    'DISPOSAL_EVIDENCE_CLOSED', 'AGENT_REFUSED_DISPOSAL', 'REVOKED_AFTER_ACQUISITION', 'REVOKED_AFTER_DISPOSAL'].includes(value.state);
  const forbidsAcquisition = !requiresAcquisition && value.state !== 'RESOLUTION_REQUIRED_AFTER_REVOCATION';
  if ((requiresAcquisition && !hasAcquisition) || (forbidsAcquisition && hasAcquisition)) {
    fail('bounded_agent_state_semantics_invalid', 'acquisition evidence state does not reconcile');
  }
  if ((['DISPOSAL_EVIDENCE_CLOSED', 'REVOKED_AFTER_DISPOSAL'].includes(value.state)) !== (value.disposal_evidence_digest !== null)) {
    fail('bounded_agent_state_semantics_invalid', 'disposal evidence state does not reconcile');
  }
  if (value.possible_submission !== ['ACQUISITION_SUBMISSION_RESOLVING', 'DISPOSAL_SUBMISSION_RESOLVING', 'RESOLUTION_REQUIRED_AFTER_REVOCATION'].includes(value.state)) {
    fail('bounded_agent_state_semantics_invalid', 'possible-submission status does not reconcile');
  }
  if (value.human_revocation_status === 'REVOKED'
      !== ['REVOKED_BEFORE_FIRST_ADMISSION', 'REVOKED_AFTER_ACQUISITION', 'REVOKED_AFTER_DISPOSAL', 'RESOLUTION_REQUIRED_AFTER_REVOCATION'].includes(value.state)) {
    fail('bounded_agent_state_semantics_invalid', 'revocation status does not reconcile');
  }
  const shape = {
    AUTHORIZED_DORMANT: [1, 0, false],
    ACQUISITION_ADMITTED: [1, 1, false],
    ACQUISITION_SUBMISSION_RESOLVING: [1, 1, true],
    ACQUISITION_EVIDENCE_CLOSED: [2, 1, false],
    DISPOSAL_ADMITTED: [2, 2, false],
    DISPOSAL_SUBMISSION_RESOLVING: [2, 2, true],
    DISPOSAL_EVIDENCE_CLOSED: [null, 2, false],
    AGENT_REFUSED_ACQUISITION: [null, 1, false],
    AGENT_REFUSED_DISPOSAL: [null, 2, false],
    REVOKED_BEFORE_FIRST_ADMISSION: [null, 0, false],
    REVOKED_AFTER_ACQUISITION: [null, 1, false],
    REVOKED_AFTER_DISPOSAL: [null, 2, false],
  }[value.state];
  const signedIntentPresent = value.signed_intent_digest !== null;
  if (shape !== undefined
      && (value.next_ordinal !== shape[0] || value.consumed_decision_ids.length !== shape[1]
        || signedIntentPresent !== shape[2])) {
    fail('bounded_agent_state_semantics_invalid', 'state ordinal, consumption, or signed-intent shape is invalid');
  }
  if (value.state === 'RESOLUTION_REQUIRED_AFTER_REVOCATION'
      && (value.next_ordinal !== (hasAcquisition ? 2 : 1)
        || value.consumed_decision_ids.length !== (hasAcquisition ? 2 : 1) || !signedIntentPresent)) {
    fail('bounded_agent_state_semantics_invalid', 'revoked resolution state shape is invalid');
  }
  if (!DIGEST.test(value.state_digest) || value.state_digest !== sha256CanonicalJson(preimage(value))
      || value.state_id !== `episode-state-${value.state_digest}`) {
    fail('bounded_agent_state_identity_invalid', 'episode state identity is invalid');
  }
  return true;
}
export function createAuthorizedEpisodeStateV1({ mandate, authorization }) {
  validateBoundedAgentMandateV1(mandate);
  validateHumanEpisodeAuthorizationV1(authorization, { mandate });
  return issue({
    episode_id: `bounded-agent-episode-${authorization.authorization_digest}`,
    mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest,
    state: 'AUTHORIZED_DORMANT', next_ordinal: 1, possible_submission: false,
    human_revocation_status: 'NOT_REVOKED', consumed_decision_ids: [], consumed_challenge_ids: [],
    signed_intent_digest: null, acquisition_evidence_digest: null,
    chain_derived_acquired_jup_raw: null, disposal_evidence_digest: null,
  });
}
export function admitAgentDecisionStateV1({
  state, mandate, authorization, challenge, decision, executor_release_sha256, now_unix_seconds,
}) {
  validateBoundedAgentEpisodeStateV1(state);
  if (state.mandate_digest !== mandate.mandate_digest
      || state.authorization_digest !== authorization.authorization_digest
      || state.episode_id !== `bounded-agent-episode-${authorization.authorization_digest}`
      || challenge.episode_id !== state.episode_id) {
    fail('bounded_agent_state_authority_mismatch', 'episode state does not bind the supplied mandate and authorization');
  }
  if (state.human_revocation_status !== 'NOT_REVOKED') fail('bounded_agent_authorization_revoked', 'authorization is revoked');
  if (state.state !== challenge.predecessor_state || state.state_digest !== challenge.predecessor_state_digest
      || state.next_ordinal !== challenge.ordinal) {
    fail('bounded_agent_state_predecessor_mismatch', 'decision does not target the current episode state');
  }
  if (state.consumed_decision_ids.includes(decision.decision_id) || state.consumed_challenge_ids.includes(challenge.challenge_id)) {
    fail('bounded_agent_decision_replay', 'decision or challenge was already consumed');
  }
  const admission = buildExecutorAdmissionV1({
    mandate, authorization, challenge, decision,
    expected_predecessor_state: state.state,
    expected_predecessor_state_digest: state.state_digest,
    expected_executor_release_sha256: executor_release_sha256,
    now_unix_seconds,
  });
  const consumed = {
    consumed_decision_ids: [...state.consumed_decision_ids, decision.decision_id],
    consumed_challenge_ids: [...state.consumed_challenge_ids, challenge.challenge_id],
  };
  if (admission.status === 'REFUSED') {
    return { admission, state: next(state, {
      ...consumed, state: challenge.phase === 'ACQUISITION' ? 'AGENT_REFUSED_ACQUISITION' : 'AGENT_REFUSED_DISPOSAL',
      next_ordinal: null,
    }) };
  }
  return { admission, state: next(state, {
    ...consumed, state: challenge.phase === 'ACQUISITION' ? 'ACQUISITION_ADMITTED' : 'DISPOSAL_ADMITTED',
  }) };
}
export function recordSignedIntentV1({ state, signed_intent_digest }) {
  validateBoundedAgentEpisodeStateV1(state);
  if (!DIGEST.test(signed_intent_digest)) fail('bounded_agent_signed_intent_invalid', 'signed intent digest is invalid');
  if (!['ACQUISITION_ADMITTED', 'DISPOSAL_ADMITTED'].includes(state.state)) fail('bounded_agent_state_transition_invalid', 'state cannot accept a signed intent');
  return next(state, {
    state: state.state === 'ACQUISITION_ADMITTED' ? 'ACQUISITION_SUBMISSION_RESOLVING' : 'DISPOSAL_SUBMISSION_RESOLVING',
    possible_submission: true, signed_intent_digest,
  });
}
export function closeFinalizedLegV1({ state, phase, finalized_evidence_digest, chain_derived_acquired_jup_raw = null }) {
  validateBoundedAgentEpisodeStateV1(state);
  if (!DIGEST.test(finalized_evidence_digest)) fail('bounded_agent_finalized_evidence_invalid', 'finalized evidence digest is invalid');
  if (phase === 'ACQUISITION' && state.state === 'ACQUISITION_SUBMISSION_RESOLVING'
      && typeof chain_derived_acquired_jup_raw === 'string' && RAW.test(chain_derived_acquired_jup_raw)
      && chain_derived_acquired_jup_raw !== '0') {
    return next(state, {
      state: 'ACQUISITION_EVIDENCE_CLOSED', next_ordinal: 2, possible_submission: false,
      acquisition_evidence_digest: finalized_evidence_digest,
      chain_derived_acquired_jup_raw, signed_intent_digest: null,
    });
  }
  if (phase === 'DISPOSAL' && state.state === 'DISPOSAL_SUBMISSION_RESOLVING' && chain_derived_acquired_jup_raw === null) {
    return next(state, {
      state: 'DISPOSAL_EVIDENCE_CLOSED', next_ordinal: null, possible_submission: false,
      disposal_evidence_digest: finalized_evidence_digest, signed_intent_digest: null,
    });
  }
  if (state.state === 'RESOLUTION_REQUIRED_AFTER_REVOCATION' && phase === 'ACQUISITION'
      && state.acquisition_evidence_digest === null && typeof chain_derived_acquired_jup_raw === 'string'
      && RAW.test(chain_derived_acquired_jup_raw) && chain_derived_acquired_jup_raw !== '0') {
    return next(state, {
      state: 'REVOKED_AFTER_ACQUISITION', next_ordinal: null, possible_submission: false,
      acquisition_evidence_digest: finalized_evidence_digest,
      chain_derived_acquired_jup_raw, signed_intent_digest: null,
    });
  }
  if (state.state === 'RESOLUTION_REQUIRED_AFTER_REVOCATION' && phase === 'DISPOSAL'
      && state.acquisition_evidence_digest !== null && chain_derived_acquired_jup_raw === null) {
    return next(state, {
      state: 'REVOKED_AFTER_DISPOSAL', next_ordinal: null, possible_submission: false,
      disposal_evidence_digest: finalized_evidence_digest, signed_intent_digest: null,
    });
  }
  fail('bounded_agent_state_transition_invalid', 'finalized leg cannot close from this state');
}
export function applyHumanRevocationV1({ state, authorization_digest }) {
  validateBoundedAgentEpisodeStateV1(state);
  if (state.authorization_digest !== authorization_digest) fail('bounded_agent_revocation_authorization_mismatch', 'revocation targets another authorization');
  if (state.human_revocation_status === 'REVOKED') fail('bounded_agent_revocation_replay', 'authorization was already revoked');
  if (state.possible_submission) return next(state, { state: 'RESOLUTION_REQUIRED_AFTER_REVOCATION', human_revocation_status: 'REVOKED' });
  if (state.state === 'AUTHORIZED_DORMANT') return next(state, { state: 'REVOKED_BEFORE_FIRST_ADMISSION', next_ordinal: null, human_revocation_status: 'REVOKED' });
  if (state.state === 'ACQUISITION_EVIDENCE_CLOSED') return next(state, { state: 'REVOKED_AFTER_ACQUISITION', next_ordinal: null, human_revocation_status: 'REVOKED' });
  fail('bounded_agent_revocation_state_invalid', 'revocation is not admitted from this state');
}
