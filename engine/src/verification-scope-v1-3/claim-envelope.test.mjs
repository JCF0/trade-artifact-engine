#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FULL_RESULT_PROFILE_DEFINITIONS,
  LIMITED_RESULT_PROFILE_DEFINITIONS,
  POSITION_VERIFIED_FIELD_MATRIX,
  SUPPORTING_PROFILES,
} from './semantics.mjs';
import {
  CLAIM_ENVELOPE_VERSION,
  CLAIM_IDENTITY_VERSION,
  buildClaimEnvelopeV13,
  validateClaimEnvelopeV13,
  claimDigestPreimage,
  computeClaimDigest,
} from './claim-envelope.mjs';

const digest = character => character.repeat(64);
const resultReferences = fields => [...fields].sort().map(field => ({ field, value_digest: digest('c') }));
const TRANSACTION_DIRECT_FIELDS = new Set(['transaction_identity', 'unresolved_effect_references', 'residual_unresolved_effect_references', 'field_availability', 'reason_codes']);
const POSITION_DIRECT_FIELDS = new Set(['scope_identity', 'acquisition_evidence_identity', 'target_mint', 'exact_quote_mint', 'episode_identity', 'opening_boundary', 'ending_boundary', 'position_state', 'exclusion_references', 'unresolved_claim_affecting_findings', 'unresolved_finding_references', 'field_availability', 'reason_codes']);
const WALLET_DIRECT_FIELDS = new Set(['acquisition_window_identity', 'finalized_anchor', 'unresolved_effect_references', 'reason_codes']);
const indirectFields = (fields, direct) => fields.filter(field => !direct.has(field));
const closedAvailability = Object.entries(POSITION_VERIFIED_FIELD_MATRIX.CLOSED)
  .filter(([, requirement]) => requirement !== 'FORBIDDEN')
  .map(([field, requirement]) => ({ field, availability: requirement === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'AVAILABLE' }))
  .sort((left, right) => left.field < right.field ? -1 : left.field > right.field ? 1 : 0);
const closedResultFields = indirectFields(Object.entries(POSITION_VERIFIED_FIELD_MATRIX.CLOSED)
  .filter(([, requirement]) => !['FORBIDDEN', 'NOT_APPLICABLE'].includes(requirement))
  .map(([field]) => field), POSITION_DIRECT_FIELDS);

function validPositionInput() {
  return {
    network: 'solana_mainnet_beta',
    analyzed_wallet: 'wallet_fixture_1',
    acquisition_request_digest: digest('1'),
    finalized_anchor_digest: digest('2'),
    evidence_context_digest: digest('3'),
    claim_scope_digest: digest('4'),
    claim_type: 'POSITION_EPISODE',
    claim_profile: 'POSITION_ECONOMICS_V1',
    requested: true,
    target_mint: 'target_mint_fixture',
    exact_quote_mint: 'quote_mint_fixture',
    position_episode_digest: digest('5'),
    candidate_digest: digest('6'),
    supporting_profiles: { ...SUPPORTING_PROFILES },
    opening_boundary_digest: digest('7'),
    ending_boundary_digest: digest('8'),
    included_evidence_digests: [digest('9'), digest('a')],
    exclusions: [{ evidence_digest: digest('b'), exclusion_code: 'EXCLUDED_AFTER_CLOSED_BOUNDARY', non_interference_rule: 'NI-01' }],
    unresolved_finding_digests: [],
    claim_outcome: 'VERIFIED',
    position_state: 'CLOSED',
    reason_codes: [],
    result_profile: 'POSITION_ECONOMICS_V1',
    field_availability: closedAvailability,
    result_field_references: resultReferences(closedResultFields),
    legacy_reference: { receipt_hash: digest('d'), package_digest: digest('e') },
  };
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('claim builder emits a closed immutable deterministic content-addressed envelope', () => {
  const input = validPositionInput();
  const built = buildClaimEnvelopeV13(input);
  assert.equal(built.claim_envelope_version, CLAIM_ENVELOPE_VERSION);
  assert.equal(built.claim_identity_version, CLAIM_IDENTITY_VERSION);
  assert.equal(built.claim_digest, computeClaimDigest(built));
  assert.equal(built.claim_id, `avc13_${built.claim_digest}`);
  assert.equal(validateClaimEnvelopeV13(built), true);
  assertDeepFrozen(built);

  const reversed = Object.fromEntries(Object.entries(validPositionInput()).reverse());
  assert.equal(buildClaimEnvelopeV13(reversed).claim_digest, built.claim_digest);
  assert.deepEqual(claimDigestPreimage(buildClaimEnvelopeV13(reversed)), claimDigestPreimage(built));

  input.supporting_profiles.accounting_profile = 'MUTATED';
  input.included_evidence_digests.push(digest('f'));
  assert.equal(built.supporting_profiles.accounting_profile, 'ARTIFACT_WAC_ACCOUNTING_V1');
  assert.equal(built.included_evidence_digests.length, 2);
});

test('claim validation rejects unknown fields, mutation, malformed identity, and noncanonical set ordering', () => {
  const built = buildClaimEnvelopeV13(validPositionInput());
  const cases = [];
  cases.push({ ...structuredClone(built), extra: true });
  cases.push({ ...structuredClone(built), claim_digest: digest('0') });
  cases.push({ ...structuredClone(built), claim_id: `avc13_${digest('0')}` });
  const reversedEvidence = structuredClone(built);
  reversedEvidence.included_evidence_digests.reverse();
  cases.push(reversedEvidence);
  const duplicateEvidence = structuredClone(built);
  duplicateEvidence.included_evidence_digests = [duplicateEvidence.included_evidence_digests[0], duplicateEvidence.included_evidence_digests[0]];
  cases.push(duplicateEvidence);
  const noncanonicalReasons = structuredClone(built);
  noncanonicalReasons.reason_codes = ['NO_LIMITED_PROJECTION', 'OPENING_BASIS_UNRESOLVED'];
  cases.push(noncanonicalReasons);
  for (const value of cases) assert.throws(() => validateClaimEnvelopeV13(value), error => typeof error.code === 'string');
});

test('self-consistent invalid outcome/state and reason combinations fail semantic validation', () => {
  const invalid = validPositionInput();
  invalid.claim_outcome = 'BLOCKED';
  invalid.result_profile = null;
  invalid.position_state = 'CLOSED';
  invalid.reason_codes = ['OPENING_BASIS_UNRESOLVED', 'NO_LIMITED_PROJECTION'];
  invalid.field_availability = [];
  invalid.result_field_references = [];
  assert.throws(() => buildClaimEnvelopeV13(invalid), error => error.code === 'invalid_outcome_state');

  const blocked = validPositionInput();
  blocked.claim_outcome = 'BLOCKED';
  blocked.result_profile = null;
  blocked.position_state = null;
  blocked.reason_codes = ['OPENING_BASIS_UNRESOLVED'];
  blocked.field_availability = [];
  blocked.result_field_references = [];
  blocked.target_mint = null;
  blocked.exact_quote_mint = null;
  blocked.position_episode_digest = null;
  blocked.opening_boundary_digest = null;
  blocked.ending_boundary_digest = null;
  assert.throws(() => buildClaimEnvelopeV13(blocked), error => error.code === 'blocked_reason_set_invalid');
});

test('limited and blocked result shapes enforce objective availability and reason requirements', () => {
  const limited = validPositionInput();
  limited.claim_outcome = 'LIMITED';
  limited.result_profile = 'POSITION_ECONOMICS_V1_LIMITED';
  limited.position_state = 'CLOSED';
  limited.reason_codes = ['OPENING_BASIS_UNRESOLVED'];
  limited.unresolved_finding_digests = [digest('f')];
  limited.field_availability = closedAvailability.map(item => item.field === 'opening_attributable_basis' ? { ...item, availability: 'UNAVAILABLE' } : item);
  limited.result_field_references = resultReferences(indirectFields(LIMITED_RESULT_PROFILE_DEFINITIONS.POSITION_ECONOMICS_V1_LIMITED.required_fields, POSITION_DIRECT_FIELDS));
  const builtLimited = buildClaimEnvelopeV13(limited);
  assert.equal(validateClaimEnvelopeV13(builtLimited), true);

  const noUnavailable = { ...limited, field_availability: closedAvailability };
  assert.throws(() => buildClaimEnvelopeV13(noUnavailable), error => error.code === 'limited_availability_invalid');
  const unresolvedFieldUnavailable = {
    ...limited,
    field_availability: limited.field_availability.map(item => item.field === 'unresolved_claim_affecting_findings' ? { ...item, availability: 'UNAVAILABLE' } : item),
  };
  assert.throws(() => buildClaimEnvelopeV13(unresolvedFieldUnavailable), error => error.code === 'limited_availability_invalid');
  const noReason = { ...limited, reason_codes: [] };
  assert.throws(() => buildClaimEnvelopeV13(noReason), error => error.code === 'limited_reason_set_invalid');
  const incompleteLimited = { ...limited, result_field_references: limited.result_field_references.slice(1) };
  assert.throws(() => buildClaimEnvelopeV13(incompleteLimited), error => error.code === 'result_field_reference_shape_invalid');
  const contradictoryEvidence = { ...limited, unresolved_finding_digests: [digest('9')] };
  assert.throws(() => buildClaimEnvelopeV13(contradictoryEvidence), error => error.code === 'evidence_category_conflict');

  const blocked = validPositionInput();
  Object.assign(blocked, {
    claim_outcome: 'BLOCKED', position_state: null, result_profile: null,
    target_mint: null, exact_quote_mint: null, position_episode_digest: null,
    opening_boundary_digest: null, ending_boundary_digest: null,
    reason_codes: ['OPENING_BASIS_UNRESOLVED', 'NO_LIMITED_PROJECTION'],
    field_availability: [], result_field_references: [],
  });
  assert.equal(validateClaimEnvelopeV13(buildClaimEnvelopeV13(blocked)), true);
});

test('blocked envelopes require field_availability to be an actual empty array', () => {
  const blocked = validPositionInput();
  Object.assign(blocked, {
    claim_outcome: 'BLOCKED', position_state: null, result_profile: null,
    target_mint: null, exact_quote_mint: null, position_episode_digest: null,
    opening_boundary_digest: null, ending_boundary_digest: null,
    reason_codes: ['OPENING_BASIS_UNRESOLVED', 'NO_LIMITED_PROJECTION'],
    field_availability: [], result_field_references: [],
  });
  const built = buildClaimEnvelopeV13(blocked);
  assert.equal(validateClaimEnvelopeV13(built), true);

  const typeConfused = structuredClone(built);
  typeConfused.field_availability = '';
  assert.throws(
    () => validateClaimEnvelopeV13(typeConfused, { verifyDigest: false }),
    error => error.code === 'non_result_shape_invalid',
  );
});

test('not-evaluated envelopes reject non-array empty-length field availability', () => {
  const companion = validPositionInput();
  Object.assign(companion, {
    claim_type: 'WALLET_WINDOW', claim_profile: 'WALLET_EFFECT_COVERAGE_V1', requested: false,
    claim_outcome: 'NOT_EVALUATED', result_profile: null, position_state: null,
    target_mint: null, exact_quote_mint: null, position_episode_digest: null,
    candidate_digest: null, opening_boundary_digest: null, ending_boundary_digest: null, legacy_reference: null,
    result_field_references: [], field_availability: [],
    included_evidence_digests: [], exclusions: [], unresolved_finding_digests: [], reason_codes: [],
  });
  const built = buildClaimEnvelopeV13(companion);
  const typeConfused = structuredClone(built);
  typeConfused.field_availability = '';
  assert.throws(
    () => validateClaimEnvelopeV13(typeConfused, { verifyDigest: false }),
    error => error.code === 'non_result_shape_invalid',
  );
});

test('field-availability type confusion cannot create a second valid claim identity', () => {
  const blocked = validPositionInput();
  Object.assign(blocked, {
    claim_outcome: 'BLOCKED', position_state: null, result_profile: null,
    target_mint: null, exact_quote_mint: null, position_episode_digest: null,
    opening_boundary_digest: null, ending_boundary_digest: null,
    reason_codes: ['OPENING_BASIS_UNRESOLVED', 'NO_LIMITED_PROJECTION'],
    field_availability: [], result_field_references: [],
  });
  const canonical = buildClaimEnvelopeV13(blocked);
  const typeConfused = structuredClone(canonical);
  typeConfused.field_availability = '';
  typeConfused.claim_digest = computeClaimDigest(typeConfused);
  typeConfused.claim_id = `avc13_${typeConfused.claim_digest}`;
  assert.notEqual(typeConfused.claim_digest, canonical.claim_digest);
  assert.throws(
    () => validateClaimEnvelopeV13(typeConfused),
    error => error.code === 'non_result_shape_invalid',
  );
});

test('transaction and wallet companion envelopes enforce non-position and status-only shapes', () => {
  const transaction = validPositionInput();
  Object.assign(transaction, {
    claim_type: 'TRANSACTION_EFFECT', claim_profile: 'TRANSACTION_EFFECT_V1', result_profile: 'TRANSACTION_EFFECT_V1',
    position_state: null, target_mint: null, exact_quote_mint: null, position_episode_digest: null,
    candidate_digest: null, opening_boundary_digest: null, ending_boundary_digest: null, legacy_reference: null,
    field_availability: ['committed_effects', 'finalized_execution_status', 'reason_codes', 'transaction_identity', 'unresolved_effect_references']
      .map(field => ({ field, availability: 'AVAILABLE' })),
    result_field_references: resultReferences(indirectFields(FULL_RESULT_PROFILE_DEFINITIONS.TRANSACTION_EFFECT_V1.required_fields, TRANSACTION_DIRECT_FIELDS)),
  });
  assert.equal(validateClaimEnvelopeV13(buildClaimEnvelopeV13(transaction)), true);

  const transactionLimited = structuredClone(transaction);
  Object.assign(transactionLimited, {
    claim_outcome: 'LIMITED',
    result_profile: 'TRANSACTION_EFFECT_V1_LIMITED',
    reason_codes: ['TRANSACTION_EFFECT_UNRESOLVED'],
    unresolved_finding_digests: [digest('f')],
    field_availability: transaction.field_availability.map(item => item.field === 'committed_effects' ? { ...item, availability: 'UNAVAILABLE' } : item),
    result_field_references: resultReferences(indirectFields(LIMITED_RESULT_PROFILE_DEFINITIONS.TRANSACTION_EFFECT_V1_LIMITED.required_fields, TRANSACTION_DIRECT_FIELDS)),
  });
  assert.equal(validateClaimEnvelopeV13(buildClaimEnvelopeV13(transactionLimited)), true);
  const contradictoryTransactionAvailability = {
    ...transactionLimited,
    field_availability: transactionLimited.field_availability.map(item => item.field === 'reason_codes' ? { ...item, availability: 'UNAVAILABLE' } : item),
  };
  assert.throws(() => buildClaimEnvelopeV13(contradictoryTransactionAvailability), error => error.code === 'limited_availability_invalid');

  const companion = structuredClone(transaction);
  Object.assign(companion, {
    claim_type: 'WALLET_WINDOW', claim_profile: 'WALLET_EFFECT_COVERAGE_V1', requested: false,
    claim_outcome: 'NOT_EVALUATED', result_profile: null, result_field_references: [], field_availability: [],
    included_evidence_digests: [], exclusions: [], unresolved_finding_digests: [], reason_codes: [],
  });
  assert.equal(validateClaimEnvelopeV13(buildClaimEnvelopeV13(companion)), true);
  assert.throws(() => buildClaimEnvelopeV13({ ...companion, legacy_reference: { receipt_hash: digest('d'), package_digest: digest('e') } }), error => error.code === 'not_evaluated_reason_set_invalid');

  const walletLimited = structuredClone(companion);
  Object.assign(walletLimited, {
    requested: true,
    claim_outcome: 'LIMITED',
    result_profile: 'WALLET_EFFECT_COVERAGE_V1_LIMITED',
    reason_codes: ['WALLET_EFFECT_UNRESOLVED'],
    unresolved_finding_digests: [digest('f')],
    result_field_references: resultReferences(indirectFields(LIMITED_RESULT_PROFILE_DEFINITIONS.WALLET_EFFECT_COVERAGE_V1_LIMITED.required_fields, WALLET_DIRECT_FIELDS)),
  });
  assert.equal(validateClaimEnvelopeV13(buildClaimEnvelopeV13(walletLimited)), true);
  assert.throws(
    () => buildClaimEnvelopeV13({ ...walletLimited, result_field_references: walletLimited.result_field_references.slice(1) }),
    error => error.code === 'result_field_reference_shape_invalid',
  );

  companion.unresolved_finding_digests = [digest('f')];
  assert.throws(() => buildClaimEnvelopeV13(companion), error => error.code === 'not_evaluated_reason_set_invalid');
});

test('hostile accessors and proxies are rejected without executing traps', () => {
  let calls = 0;
  const accessor = validPositionInput();
  Object.defineProperty(accessor, 'network', { enumerable: true, get() { calls += 1; throw new Error('must not execute'); } });
  assert.throws(() => buildClaimEnvelopeV13(accessor), error => error.code === 'accessor_not_allowed');
  const proxy = new Proxy(validPositionInput(), { ownKeys() { calls += 1; throw new Error('must not execute'); } });
  assert.throws(() => buildClaimEnvelopeV13(proxy), error => error.code === 'proxy_not_allowed');
  assert.equal(calls, 0);
});
