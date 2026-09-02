import {
  assertExactFields,
  canonicalJson,
  cloneAndFreeze,
  fail,
  sha256CanonicalJson,
} from './contract.mjs';
import {
  validateSourceBoundAuthoritativeEvidenceContextV13,
} from './authoritative-evidence-context.mjs';
import {
  buildEpisodeCandidatePopulationV13,
  validateSourceBoundEpisodeCandidatePopulationV13,
} from './episode-candidate-population.mjs';
import {
  computeCandidateMemberDigestV13,
  selectExplicitCandidateV13,
  validateSourceBoundExplicitCandidateSelectionV13,
} from './explicit-candidate-selection.mjs';
import {
  issueImmutablePositionClaimV13,
  validateSourceBoundImmutablePositionClaimV13,
} from './immutable-claim-artifact.mjs';
import { validateSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import {
  CONTROLLED_CASE_FIXTURE_VERSION_V1,
  createControlledCaseAuthorityV1,
} from './fixtures/controlled-case-offline-v1.mjs';

export const CONTROLLED_CASE_GATE_VERSION_V1 = 'artifact_verification_scope_v1_3_controlled_case_gate_result_v1';
export const CONTROLLED_CASE_GATE_PROFILE_V1 = 'ARTIFACT_VERIFICATION_SCOPE_V1_3_CONTROLLED_CASE_OFFLINE_E2E_V1';
export const VERIFICATION_SCOPE_V1_3_SPEC_SHA256 = '2535bd51cbda5b638b486f85ded6808a43d9928c1049e73a1f73cdbe2e3cef0e';
export const CONTROLLED_CASE_GATE_RESULT_SHA256 = '9b1aa666e40ce83aefcafee5ebfd9e1927e59d920625b98d0daaaed3d649d80e';

const RESULT_FIELDS = [
  'gate_result_version', 'gate_profile', 'fixture_identity', 'specification_identity',
  'authoritative_source_identities', 'transaction_effect_identities', 'evidence_context_identity',
  'episode_identities', 'claim_evaluation_identities', 'population_identity',
  'requested_candidate_identity', 'selection_identity', 'immutable_claim_identity',
  'assertions', 'overall_status',
];
const FIXTURE_FIELDS = ['fixture_version', 'fixture_manifest_digest'];
const SPEC_FIELDS = ['specification_profile', 'sha256'];
const SOURCE_FIELDS = [
  'legacy_acquisition_result_digest', 'transaction_population_digest', 'opening_enumeration_digest',
  'ending_enumeration_digest', 'economic_evidence_digest',
];
const EFFECT_FIELDS = ['canonical_transaction_coordinate', 'signature', 'effect_digest'];
const IDENTITY_FIELDS = ['id', 'digest'];
const ASSERTION_FIELDS = ['assertion_id', 'expected', 'observed', 'status'];
const ASSERTION_IDS = [
  'opening_exact_zero', 'ending_exact_zero', 'source_transaction_count', 'source_episode_count',
  'verified_count', 'limited_count', 'blocked_count', 'position_state', 'claim_outcome',
  'aggregate_acquisition_basis', 'recognized_disposal_proceeds', 'realized_basis_consumed',
  'realized_pnl', 'realized_return',
  'remaining_attributable_basis', 'explicit_selection_status', 'selection_policy',
  'immutable_claim_byte_reconstruction',
];
const DIGEST = /^[0-9a-f]{64}$/;

function assertDigest(value, context) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('controlled_case_gate_digest_invalid', `${context} is invalid`);
}
function assertIdentity(value, prefix, context) {
  assertExactFields(value, IDENTITY_FIELDS, context);
  assertDigest(value.digest, `${context}.digest`);
  if (value.id !== `${prefix}${value.digest}`) {
    fail('controlled_case_gate_identity_invalid', `${context} id does not bind its digest`);
  }
}
function assertion(assertionId, expected, observed) {
  return {
    assertion_id: assertionId,
    expected,
    observed,
    status: canonicalJson(expected) === canonicalJson(observed) ? 'PASS' : 'FAIL',
  };
}
function establishedValue(evaluation, field) {
  const row = evaluation.established_fields.find(item => item.field === field);
  if (row === undefined) fail('controlled_case_gate_field_missing', `evaluation did not establish ${field}`);
  return row.value;
}
function identity(id, digest) { return { id, digest }; }

export function validateControlledCaseGateResultV1(value) {
  assertExactFields(value, RESULT_FIELDS, 'controlled_case_gate_result');
  if (value.gate_result_version !== CONTROLLED_CASE_GATE_VERSION_V1
      || value.gate_profile !== CONTROLLED_CASE_GATE_PROFILE_V1) {
    fail('controlled_case_gate_version_invalid', 'controlled case gate version or profile is invalid');
  }
  assertExactFields(value.fixture_identity, FIXTURE_FIELDS, 'controlled_case_gate_result.fixture_identity');
  if (value.fixture_identity.fixture_version !== CONTROLLED_CASE_FIXTURE_VERSION_V1) {
    fail('controlled_case_gate_fixture_invalid', 'controlled case fixture version is invalid');
  }
  assertDigest(value.fixture_identity.fixture_manifest_digest, 'fixture manifest digest');
  assertExactFields(value.specification_identity, SPEC_FIELDS, 'controlled_case_gate_result.specification_identity');
  if (value.specification_identity.specification_profile !== 'ARTIFACT_VERIFICATION_SCOPE_ACCEPTABILITY_V1_3'
      || value.specification_identity.sha256 !== VERIFICATION_SCOPE_V1_3_SPEC_SHA256) {
    fail('controlled_case_gate_specification_invalid', 'controlled case gate specification identity is invalid');
  }
  assertExactFields(value.authoritative_source_identities, SOURCE_FIELDS, 'controlled_case_gate_result.authoritative_source_identities');
  for (const digest of Object.values(value.authoritative_source_identities)) assertDigest(digest, 'authoritative source digest');
  if (!Array.isArray(value.transaction_effect_identities) || value.transaction_effect_identities.length !== 2) {
    fail('controlled_case_gate_effects_invalid', 'controlled case gate must bind exactly two effects');
  }
  value.transaction_effect_identities.forEach((row, index) => {
    assertExactFields(row, EFFECT_FIELDS, `controlled_case_gate_result.transaction_effect_identities.${index}`);
    if (row.canonical_transaction_coordinate !== index || typeof row.signature !== 'string') {
      fail('controlled_case_gate_effects_invalid', 'transaction effect identities are not canonical');
    }
    assertDigest(row.effect_digest, 'transaction effect digest');
  });
  const identityPrefixes = {
    evidence_context_identity: 'evidence-context-',
    population_identity: 'episode-population-',
    requested_candidate_identity: 'candidate-',
    selection_identity: 'selection-',
    immutable_claim_identity: 'immutable-claim-',
  };
  for (const [field, prefix] of Object.entries(identityPrefixes)) {
    assertIdentity(value[field], prefix, `controlled_case_gate_result.${field}`);
  }
  for (const [field, expectedLength] of [['episode_identities', 1], ['claim_evaluation_identities', 1]]) {
    if (!Array.isArray(value[field]) || value[field].length !== expectedLength) {
      fail('controlled_case_gate_identity_invalid', `${field} has invalid cardinality`);
    }
    const prefix = field === 'episode_identities' ? 'position-episode-' : 'claim-evaluation-';
    value[field].forEach((row, index) => {
      assertIdentity(row, prefix, `controlled_case_gate_result.${field}.${index}`);
    });
  }
  if (!Array.isArray(value.assertions) || value.assertions.length !== ASSERTION_IDS.length) {
    fail('controlled_case_gate_assertions_invalid', 'controlled case gate assertions are incomplete');
  }
  const assertionIds = new Set();
  for (const [index, row] of value.assertions.entries()) {
    assertExactFields(row, ASSERTION_FIELDS, `controlled_case_gate_result.assertions.${index}`);
    if (row.assertion_id !== ASSERTION_IDS[index] || assertionIds.has(row.assertion_id)
        || !['PASS', 'FAIL'].includes(row.status)
        || row.status !== (canonicalJson(row.expected) === canonicalJson(row.observed) ? 'PASS' : 'FAIL')) {
      fail('controlled_case_gate_assertions_invalid', 'controlled case gate assertion is invalid');
    }
    assertionIds.add(row.assertion_id);
  }
  const expectedStatus = value.assertions.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL';
  if (value.overall_status !== expectedStatus) {
    fail('controlled_case_gate_status_invalid', 'controlled case gate status does not reconcile with assertions');
  }
  if (sha256CanonicalJson(value) !== CONTROLLED_CASE_GATE_RESULT_SHA256) {
    fail('controlled_case_gate_release_identity_mismatch', 'controlled case gate result does not match the fixed release identity');
  }
  return true;
}

export function controlledCaseGateExitCodeV1(value) {
  return value?.overall_status === 'PASS' ? 0 : 1;
}

export async function runControlledCaseOfflineE2EGateV1() {
  const fixture = await createControlledCaseAuthorityV1();
  const { context, context_authority: contextAuthority } = fixture;
  await validateSourceBoundAuthoritativeEvidenceContextV13({
    context,
    transaction_transcript_port: contextAuthority.transaction_transcript_port,
    legacy_acquisition_result: contextAuthority.legacy_acquisition_result,
    opening_enumeration_port: contextAuthority.opening_enumeration_port,
    ending_enumeration_port: contextAuthority.ending_enumeration_port,
    target_mint: contextAuthority.target_mint,
    opening_basis_reference: contextAuthority.opening_basis_reference,
  });
  const effectIdentities = context.transaction_population.transactions
    .slice().sort((left, right) => left.canonical_transaction_coordinate - right.canonical_transaction_coordinate)
    .map(row => {
      const effect = fixture.effects.get(row.canonical_transaction_coordinate);
      validateSolanaFullTransactionEffectV13({ wallet: context.analyzed_wallet, transaction: row.full_transaction, effect });
      return {
        canonical_transaction_coordinate: row.canonical_transaction_coordinate,
        signature: row.source_identity.signature,
        effect_digest: sha256CanonicalJson(effect),
      };
    });
  const populationInput = {
    context,
    context_authority: contextAuthority,
    exact_quote_mint: fixture.exact_quote_mint,
    economic_evidence_port: fixture.economic_evidence_port,
  };
  const population = await buildEpisodeCandidatePopulationV13(populationInput);
  await validateSourceBoundEpisodeCandidatePopulationV13({ population, ...populationInput });
  if (population.episode_dispositions.length !== 1) {
    fail('controlled_case_gate_population_cardinality', 'canonical controlled case did not enumerate exactly one episode');
  }
  const row = population.episode_dispositions[0];
  const requestedCandidateDigest = computeCandidateMemberDigestV13({
    candidate_population_digest: population.population_digest,
    episode_disposition: row,
  });
  const request = {
    candidate_population_digest: population.population_digest,
    requested_candidate_digest: requestedCandidateDigest,
  };
  const source = { population, ...populationInput };
  const selectionResult = await selectExplicitCandidateV13({ request, source });
  await validateSourceBoundExplicitCandidateSelectionV13({ result: selectionResult, request, source });
  if (selectionResult.status !== 'SELECTED_VERIFIED') {
    fail('controlled_case_gate_selection_refused', 'canonical controlled case selection was refused');
  }
  const claim = await issueImmutablePositionClaimV13({ request, source });
  await validateSourceBoundImmutablePositionClaimV13({ artifact: claim, request, source });
  const reconstructedClaim = await issueImmutablePositionClaimV13({ request, source });
  const evaluation = claim.claim_evaluation;
  const observedSemantics = {
    opening_target_raw_quantity: context.opening_snapshot.aggregate_raw_quantity,
    ending_target_raw_quantity: context.ending_snapshot.aggregate_raw_quantity,
    source_transaction_count: population.source_transaction_count,
    source_episode_count: population.source_episode_count,
    verified_count: population.verified_count,
    limited_count: population.limited_count,
    blocked_count: population.blocked_count,
    position_state: evaluation.position_state,
    claim_outcome: evaluation.claim_outcome,
    aggregate_acquisition_basis: establishedValue(evaluation, 'aggregate_acquisition_basis'),
    recognized_disposal_proceeds: establishedValue(evaluation, 'disposal_proceeds'),
    realized_basis_consumed: establishedValue(evaluation, 'realized_basis_consumed'),
    realized_pnl: establishedValue(evaluation, 'realized_pnl'),
    realized_return: establishedValue(evaluation, 'realized_return'),
    remaining_attributable_basis: establishedValue(evaluation, 'remaining_attributable_basis'),
  };
  const assertions = [
    assertion('opening_exact_zero', '0', observedSemantics.opening_target_raw_quantity),
    assertion('ending_exact_zero', '0', observedSemantics.ending_target_raw_quantity),
    assertion('source_transaction_count', 2, observedSemantics.source_transaction_count),
    assertion('source_episode_count', 1, observedSemantics.source_episode_count),
    assertion('verified_count', 1, observedSemantics.verified_count),
    assertion('limited_count', 0, observedSemantics.limited_count),
    assertion('blocked_count', 0, observedSemantics.blocked_count),
    assertion('position_state', 'CLOSED', observedSemantics.position_state),
    assertion('claim_outcome', 'VERIFIED', observedSemantics.claim_outcome),
    assertion('aggregate_acquisition_basis', { numerator: '25000000', denominator: '1' }, observedSemantics.aggregate_acquisition_basis),
    assertion('recognized_disposal_proceeds', { numerator: '32500000', denominator: '1' }, observedSemantics.recognized_disposal_proceeds),
    assertion('realized_basis_consumed', { numerator: '25000000', denominator: '1' }, observedSemantics.realized_basis_consumed),
    assertion('realized_pnl', { numerator: '7500000', denominator: '1' }, observedSemantics.realized_pnl),
    assertion('realized_return', { numerator: '3', denominator: '10' }, observedSemantics.realized_return),
    assertion('remaining_attributable_basis', { numerator: '0', denominator: '1' }, observedSemantics.remaining_attributable_basis),
    assertion('explicit_selection_status', 'SELECTED_VERIFIED', selectionResult.status),
    assertion('selection_policy', 'EXPLICIT_DIGEST_NO_FALLBACK_V1', selectionResult.selection_artifact.selection_policy),
    assertion('immutable_claim_byte_reconstruction', true, canonicalJson(claim) === canonicalJson(reconstructedClaim)),
  ];
  const result = {
    gate_result_version: CONTROLLED_CASE_GATE_VERSION_V1,
    gate_profile: CONTROLLED_CASE_GATE_PROFILE_V1,
    fixture_identity: {
      fixture_version: fixture.fixture_manifest.fixture_version,
      fixture_manifest_digest: sha256CanonicalJson(fixture.fixture_manifest),
    },
    specification_identity: {
      specification_profile: 'ARTIFACT_VERIFICATION_SCOPE_ACCEPTABILITY_V1_3',
      sha256: VERIFICATION_SCOPE_V1_3_SPEC_SHA256,
    },
    authoritative_source_identities: {
      legacy_acquisition_result_digest: context.transaction_population.legacy_acquisition_result_digest,
      transaction_population_digest: context.transaction_population.population_evidence_digest,
      opening_enumeration_digest: context.opening_snapshot.enumeration_digest,
      ending_enumeration_digest: context.ending_snapshot.enumeration_digest,
      economic_evidence_digest: fixture.economic_evidence.economic_evidence_digest,
    },
    transaction_effect_identities: effectIdentities,
    evidence_context_identity: identity(
      `evidence-context-${context.evidence_context_digest}`, context.evidence_context_digest,
    ),
    episode_identities: population.episode_dispositions.map(item => identity(
      item.episode.episode_id, item.episode.position_episode_digest,
    )),
    claim_evaluation_identities: population.episode_dispositions.map(item => identity(
      item.claim_evaluation_identity.evaluation_id, item.claim_evaluation_identity.evaluation_digest,
    )),
    population_identity: identity(population.population_id, population.population_digest),
    requested_candidate_identity: identity(`candidate-${requestedCandidateDigest}`, requestedCandidateDigest),
    selection_identity: identity(
      selectionResult.selection_artifact.selection_id, selectionResult.selection_artifact.selection_digest,
    ),
    immutable_claim_identity: identity(claim.claim_artifact_id, claim.claim_artifact_digest),
    assertions,
    overall_status: assertions.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL',
  };
  validateControlledCaseGateResultV1(result);
  return cloneAndFreeze(result);
}
