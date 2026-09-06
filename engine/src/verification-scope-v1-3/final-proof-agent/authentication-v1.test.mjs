import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import test from 'node:test';

import { sha256CanonicalJson } from '../contract.mjs';
import { buildBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { fixedTestMandateInputV1 } from './fixtures/fixed-test-identities-v1.mjs';
import {
  buildHumanEpisodeAuthorizationV1,
  humanAuthorizationSigningBytesV1,
  validateHumanEpisodeAuthorizationV1,
} from './human-authorization-v1.mjs';
import {
  buildReadinessChallengeV1,
  validateReadinessChallengeV1,
} from './readiness-challenge-v1.mjs';
import {
  agentDecisionSigningBytesV1,
  buildAuthenticatedAgentDecisionV1,
  validateAuthenticatedAgentDecisionV1,
} from './agent-decision-v1.mjs';
import {
  buildExecutorAdmissionV1,
  validateExecutorAdmissionV1,
} from './executor-admission-v1.mjs';

const HUMAN_SEED = '9d61b19deffd5a60ba844af492ec2cc4' + '4449c5697b326919703bac031cae7f60';
export const HUMAN_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a' + '0ee172f3daa62325af021a68f707511a';
const AGENT_SEED = '4ccd089b28ff96da9db6c346ec114e0f' + '5b8a319f35aba624da8cf6ed4fb8a6fb';
export const AGENT_PUBLIC = '3d4017c3e843895a92b70aa74d1b7ebc' + '9c982ccf2ec4968cc0cd55f12af4660c';

function mandateInput(overrides = {}) {
  return { ...fixedTestMandateInputV1(), ...overrides };
}

function privateKey(seed) {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]),
    format: 'der', type: 'pkcs8',
  });
}
function signature(seed, bytes) { return sign(null, bytes, privateKey(seed)).toString('hex'); }

export function authorizationFixture(mandate, overrides = {}, signingSeed = HUMAN_SEED) {
  const unsigned = {
    mandate_digest: mandate.mandate_digest,
    human_public_key: HUMAN_PUBLIC,
    agent_public_key: AGENT_PUBLIC,
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    authorization_nonce: 'fixed-offline-human-authorization-nonce-v1',
    issued_at_unix_seconds: 1900000000,
    not_before_unix_seconds: mandate.age_gate.earliest_opening_candidate_unix_seconds,
    acquisition_not_after_unix_seconds: mandate.offline_identity.acquisition_not_after_unix_seconds,
    authorization_statement: 'AUTHORIZE_ONE_BOUNDED_AGENT_DIRECTED_TWO_SWAP_FINAL_PROOF_EPISODE',
    revocation_status: 'NOT_REVOKED',
    ...overrides,
  };
  const bytes = humanAuthorizationSigningBytesV1(unsigned);
  return buildHumanEpisodeAuthorizationV1({ ...unsigned, signature: signature(signingSeed, bytes) });
}

export function acquisitionChallengeFixture(mandate, authorization, overrides = {}) {
  return buildReadinessChallengeV1({
    episode_id: `bounded-agent-episode-${authorization.authorization_digest}`,
    phase: 'ACQUISITION', ordinal: 1,
    mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest,
    predecessor_state: 'AUTHORIZED_DORMANT',
    predecessor_state_digest: '6'.repeat(64),
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    challenge_nonce: 'fixed-acquisition-challenge-nonce-v1',
    readiness_evidence_digest: '7'.repeat(64),
    issued_at_unix_seconds: 1900000010,
    expires_at_unix_seconds: 1900000110,
    readiness_status: 'READY',
    finalized_acquisition_evidence_digest: null,
    chain_derived_disposal_jup_raw: null,
    disposal_quantity_rule: 'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE',
    ...overrides,
  });
}

export function decisionFixture(mandate, authorization, challenge, overrides = {}, signingSeed = AGENT_SEED) {
  const unsigned = {
    episode_id: challenge.episode_id,
    action: challenge.phase === 'ACQUISITION' ? 'INITIATE_ACQUISITION' : 'INITIATE_FULL_DISPOSAL',
    ordinal: challenge.ordinal,
    mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest,
    challenge_digest: challenge.challenge_digest,
    predecessor_state_digest: challenge.predecessor_state_digest,
    executor_release_sha256: challenge.executor_release_sha256,
    challenge_nonce: challenge.challenge_nonce,
    agent_public_key: AGENT_PUBLIC,
    signed_at_unix_seconds: challenge.issued_at_unix_seconds + 1,
    ...overrides,
  };
  return buildAuthenticatedAgentDecisionV1({
    ...unsigned,
    signature: signature(signingSeed, agentDecisionSigningBytesV1(unsigned)),
  });
}

test('authenticates one human authorization and one challenge-bound narrow agent decision', () => {
  const mandate = buildBoundedAgentMandateV1(mandateInput());
  const authorization = authorizationFixture(mandate);
  const challenge = acquisitionChallengeFixture(mandate, authorization);
  const decision = decisionFixture(mandate, authorization, challenge);
  assert.equal(validateHumanEpisodeAuthorizationV1(authorization, { mandate }), true);
  assert.equal(validateReadinessChallengeV1(challenge), true);
  assert.equal(validateAuthenticatedAgentDecisionV1(decision, { mandate, authorization, challenge }), true);
  assert.equal(decision.action, 'INITIATE_ACQUISITION');
});

test('executor admission independently binds authorization, mandate, challenge, decision, predecessor, and release', () => {
  const mandate = buildBoundedAgentMandateV1(mandateInput());
  const authorization = authorizationFixture(mandate);
  const challenge = acquisitionChallengeFixture(mandate, authorization);
  const decision = decisionFixture(mandate, authorization, challenge);
  const admission = buildExecutorAdmissionV1({
    mandate, authorization, challenge, decision,
    expected_predecessor_state: 'AUTHORIZED_DORMANT',
    expected_predecessor_state_digest: challenge.predecessor_state_digest,
    expected_executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    now_unix_seconds: decision.signed_at_unix_seconds,
  });
  assert.equal(admission.status, 'ADMITTED');
  assert.equal(validateExecutorAdmissionV1(admission, { mandate, authorization, challenge, decision }), true);
  assert.equal(Object.isFrozen(admission), true);
});

test('executor rejects a human authorization issued in the future', () => {
  const mandate = buildBoundedAgentMandateV1(mandateInput());
  const authorization = authorizationFixture(mandate, { issued_at_unix_seconds: 1900000050 });
  const challenge = acquisitionChallengeFixture(mandate, authorization);
  const decision = decisionFixture(mandate, authorization, challenge);
  assert.throws(() => buildExecutorAdmissionV1({
    mandate, authorization, challenge, decision,
    expected_predecessor_state: 'AUTHORIZED_DORMANT',
    expected_predecessor_state_digest: challenge.predecessor_state_digest,
    expected_executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    now_unix_seconds: 1900000012,
  }), error => error.code === 'bounded_agent_decision_stale');
});

test('rejects wrong identities, ordinals, stale challenges, and changed authorization', () => {
  const mandate = buildBoundedAgentMandateV1(mandateInput());
  const authorization = authorizationFixture(mandate);
  const challenge = acquisitionChallengeFixture(mandate, authorization);
  const decision = decisionFixture(mandate, authorization, challenge);
  const otherMandate = buildBoundedAgentMandateV1(mandateInput({
    setup_authority: { ...mandateInput().setup_authority, setup_archive_sha256: 'a'.repeat(64) },
  }));
  const otherAuthorization = authorizationFixture(otherMandate);
  const otherChallenge = acquisitionChallengeFixture(otherMandate, otherAuthorization);
  assert.throws(() => validateAuthenticatedAgentDecisionV1(decision, {
    mandate: otherMandate, authorization: otherAuthorization, challenge: otherChallenge,
  }), error => error.code === 'bounded_agent_decision_context_mismatch');
  const disposalChallenge = buildReadinessChallengeV1({
    episode_id: challenge.episode_id, phase: 'DISPOSAL', ordinal: 2,
    mandate_digest: mandate.mandate_digest, authorization_digest: authorization.authorization_digest,
    predecessor_state: 'ACQUISITION_EVIDENCE_CLOSED', predecessor_state_digest: '7'.repeat(64),
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    challenge_nonce: 'fixed-disposal-challenge-nonce-v1', readiness_evidence_digest: '9'.repeat(64),
    issued_at_unix_seconds: 1900000020,
    expires_at_unix_seconds: 1900000120, readiness_status: 'READY',
    finalized_acquisition_evidence_digest: '8'.repeat(64), chain_derived_disposal_jup_raw: '21437310',
    disposal_quantity_rule: 'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE',
  });
  assert.throws(() => validateAuthenticatedAgentDecisionV1(decision, {
    mandate, authorization, challenge: disposalChallenge,
  }), error => error.code === 'bounded_agent_decision_context_mismatch');
  assert.throws(() => buildExecutorAdmissionV1({
    mandate, authorization, challenge, decision,
    expected_predecessor_state: 'AUTHORIZED_DORMANT',
    expected_predecessor_state_digest: challenge.predecessor_state_digest,
    expected_executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    now_unix_seconds: challenge.expires_at_unix_seconds + 1,
  }), error => error.code === 'bounded_agent_decision_stale');
  const changedAuthorization = { ...authorization, authorization_nonce: 'changed' };
  assert.throws(() => validateAuthenticatedAgentDecisionV1(decision, {
    mandate, authorization: changedAuthorization, challenge,
  }));
});

test('rejects agent identity substitution and refuses actions outside the four-action vocabulary', () => {
  const mandate = buildBoundedAgentMandateV1(mandateInput());
  const authorization = authorizationFixture(mandate);
  const selfAuthorizedImpostor = authorizationFixture(
    mandate,
    { human_public_key: AGENT_PUBLIC },
    AGENT_SEED,
  );
  assert.throws(() => validateHumanEpisodeAuthorizationV1(selfAuthorizedImpostor, { mandate }),
    error => error.code === 'bounded_agent_authorization_mandate_mismatch');
  const challenge = acquisitionChallengeFixture(mandate, authorization);
  const wrongIdentity = decisionFixture(
    mandate, authorization, challenge, { agent_public_key: HUMAN_PUBLIC }, HUMAN_SEED,
  );
  assert.throws(() => validateAuthenticatedAgentDecisionV1(wrongIdentity, { mandate, authorization, challenge }),
    error => error.code === 'bounded_agent_decision_agent_identity_mismatch');
  assert.throws(() => agentDecisionSigningBytesV1({
    episode_id: challenge.episode_id, action: 'CHANGE_AMOUNT', ordinal: 1,
    mandate_digest: mandate.mandate_digest, authorization_digest: authorization.authorization_digest,
    challenge_digest: challenge.challenge_digest, predecessor_state_digest: challenge.predecessor_state_digest,
    executor_release_sha256: challenge.executor_release_sha256, challenge_nonce: challenge.challenge_nonce,
    agent_public_key: AGENT_PUBLIC, signed_at_unix_seconds: 1900000011,
  }), error => error.code === 'bounded_agent_decision_action_invalid');
});

test('rejects wrong executor release and hostile authorization-chain objects', () => {
  const mandate = buildBoundedAgentMandateV1(mandateInput());
  const authorization = authorizationFixture(mandate);
  const challenge = acquisitionChallengeFixture(mandate, authorization);
  const decision = decisionFixture(mandate, authorization, challenge);
  const admission = buildExecutorAdmissionV1({
    mandate, authorization, challenge, decision,
    expected_predecessor_state: 'AUTHORIZED_DORMANT',
    expected_predecessor_state_digest: '6'.repeat(64),
    expected_executor_release_sha256: '4'.repeat(64),
    now_unix_seconds: 1900000012,
  });
  assert.throws(() => buildExecutorAdmissionV1({
    mandate, authorization, challenge, decision,
    expected_predecessor_state: 'AUTHORIZED_DORMANT',
    expected_predecessor_state_digest: '6'.repeat(64),
    expected_executor_release_sha256: 'b'.repeat(64),
    now_unix_seconds: 1900000012,
  }), error => error.code === 'bounded_agent_admission_executor_mismatch');

  const validators = [
    [validateHumanEpisodeAuthorizationV1, authorization],
    [validateReadinessChallengeV1, challenge],
    [validateAuthenticatedAgentDecisionV1, decision],
    [validateExecutorAdmissionV1, admission],
  ];
  for (const [validator, value] of validators) {
    let getterCalls = 0;
    const accessor = structuredClone(value);
    const field = Object.keys(accessor)[0];
    Object.defineProperty(accessor, field, { enumerable: true, get() { getterCalls += 1; return value[field]; } });
    assert.throws(() => validator(accessor), error => error.code === 'accessor_not_allowed');
    assert.equal(getterCalls, 0);
    assert.throws(() => validator(new Proxy(value, {})), error => error.code === 'proxy_not_allowed');
    assert.throws(() => validator(Object.assign(Object.create(null), value)),
      error => error.code === 'custom_prototype_not_allowed');
  }

  const selfRehashedAdmission = structuredClone(admission);
  selfRehashedAdmission.status = 'PWNED';
  selfRehashedAdmission.reason = 'ATTACKER_SELECTED';
  const admissionPreimage = Object.fromEntries(Object.entries(selfRehashedAdmission)
    .filter(([field]) => !['admission_id', 'admission_digest'].includes(field)));
  selfRehashedAdmission.admission_digest = sha256CanonicalJson(admissionPreimage);
  selfRehashedAdmission.admission_id = `executor-admission-${selfRehashedAdmission.admission_digest}`;
  assert.throws(() => validateExecutorAdmissionV1(selfRehashedAdmission),
    error => error.code === 'bounded_agent_admission_semantics_invalid');
});

test('enforces bounded half-open readiness and human not-before time', () => {
  const mandate = buildBoundedAgentMandateV1(mandateInput());
  const authorization = authorizationFixture(mandate);
  assert.throws(() => acquisitionChallengeFixture(mandate, authorization, {
    expires_at_unix_seconds: 1900000311,
  }), error => error.code === 'bounded_agent_challenge_semantics_invalid');
  const challenge = acquisitionChallengeFixture(mandate, authorization);
  const decision = decisionFixture(mandate, authorization, challenge);
  const context = {
    mandate, authorization, challenge, decision,
    expected_predecessor_state: 'AUTHORIZED_DORMANT',
    expected_predecessor_state_digest: '6'.repeat(64),
    expected_executor_release_sha256: mandate.offline_identity.executor_release_sha256,
  };
  assert.throws(() => buildExecutorAdmissionV1({
    ...context, now_unix_seconds: authorization.not_before_unix_seconds - 1,
  }), error => error.code === 'bounded_agent_decision_stale');
  assert.throws(() => buildExecutorAdmissionV1({
    ...context, now_unix_seconds: challenge.expires_at_unix_seconds,
  }), error => error.code === 'bounded_agent_decision_stale');
  const atExpiry = decisionFixture(mandate, authorization, challenge, {
    signed_at_unix_seconds: challenge.expires_at_unix_seconds,
  });
  assert.throws(() => buildExecutorAdmissionV1({
    ...context, decision: atExpiry, now_unix_seconds: challenge.expires_at_unix_seconds - 1,
  }), error => error.code === 'bounded_agent_decision_stale');
  const fromFuture = decisionFixture(mandate, authorization, challenge, {
    signed_at_unix_seconds: challenge.issued_at_unix_seconds + 10,
  });
  assert.throws(() => buildExecutorAdmissionV1({
    ...context, decision: fromFuture, now_unix_seconds: challenge.issued_at_unix_seconds + 5,
  }), error => error.code === 'bounded_agent_decision_stale');
});
