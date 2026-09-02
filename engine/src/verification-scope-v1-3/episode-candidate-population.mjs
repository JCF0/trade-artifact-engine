import { types as utilTypes } from 'node:util';

import {
  assertExactFields, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson,
} from './contract.mjs';
import {
  validateAuthoritativeEvidenceContextStructureV13,
  validateSourceBoundAuthoritativeEvidenceContextV13,
} from './authoritative-evidence-context.mjs';
import { projectSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import {
  buildEnumeratedPositionEpisodesV13,
  validatePositionEpisodeStructureV13,
} from './position-episode.mjs';
import {
  computeClaimEvaluationScopeDigestV13,
  evaluateClaimOutcomeV13,
  normalizedResidualReferenceV13,
} from './claim-outcome-evaluator.mjs';
import { EXCLUSION_CODES, REASON_CODES } from './semantics.mjs';

export const EPISODE_CANDIDATE_POPULATION_VERSION_V1_3 = 'artifact_episode_candidate_population_v1_3';
export const EPISODE_CANDIDATE_POPULATION_PROFILE_V1_3 = 'ARTIFACT_CANDIDATE_POPULATION_V1';
export const EPISODE_ENUMERATION_PROFILE_V1_3 = 'ARTIFACT_EPISODE_ENUMERATION_V1';
export const POPULATION_DISPOSITIONS_V1_3 = Object.freeze([
  'VERIFIED', 'LIMITED', 'BLOCKED', 'PROFILE_EXCLUDED',
]);

const INPUT_FIELDS = ['context', 'context_authority', 'exact_quote_mint', 'economic_evidence_port'];
const SOURCE_BOUND_FIELDS = ['population', ...INPUT_FIELDS];
const CONTEXT_AUTHORITY_FIELDS = [
  'transaction_transcript_port', 'legacy_acquisition_result', 'opening_enumeration_port',
  'ending_enumeration_port', 'target_mint', 'opening_basis_reference',
];
const TOP_FIELDS = [
  'episode_candidate_population_version', 'episode_enumeration_profile', 'candidate_population_profile',
  'population_id', 'population_digest', 'network', 'analyzed_wallet', 'target_mint', 'exact_quote_mint',
  'legacy_acquisition_result_digest', 'evidence_context_digest', 'transaction_population_digest',
  'opening_enumeration_digest', 'ending_enumeration_digest', 'economic_evidence_identity',
  'transaction_partition', 'episode_dispositions', 'source_transaction_count', 'source_episode_count',
  'verified_count', 'limited_count', 'blocked_count', 'profile_excluded_count',
];
const ECONOMIC_IDENTITY_FIELDS = ['economic_evidence_profile', 'economic_evidence_digest'];
const PARTITION_FIELDS = [
  'canonical_transaction_coordinate', 'transaction_identity', 'transaction_disposition', 'episode_ordinal',
  'source_effect_ids', 'source_residual_ids', 'non_interference_residual_references',
  'activity_finding_digests',
];
const EPISODE_DISPOSITION_FIELDS = [
  'episode_ordinal', 'transaction_coordinates', 'episode', 'claim_evaluation_identity',
  'population_disposition', 'candidate_eligible', 'position_state', 'reason_codes',
  'unresolved_dependency_references', 'exclusion_references',
];
const CLAIM_EVALUATION_IDENTITY_FIELDS = [
  'evaluation_id', 'evaluation_digest', 'claim_evaluation_profile',
  'claim_type', 'claim_profile', 'scope_digest',
];
const EXCLUSION_FIELDS = ['evidence_digest', 'exclusion_code', 'non_interference_rule'];
const TRANSACTION_IDENTITY_FIELDS = ['signature', 'slot', 'block_time', 'transaction_version'];
const DIGEST = /^[0-9a-f]{64}$/;
const EFFECT_ID = /^effect-[0-9a-f]{64}$/;
const RESIDUAL_ID = /^residual-[0-9a-f]{64}$/;

function safeInput(value, fields, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    fail('episode_candidate_population_input_invalid', `${context} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!fields.includes(key)) fail('unknown_field', `${context} contains unknown field`);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('accessor_not_allowed', `${context} contains an accessor`);
  }
  for (const field of fields) if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')) {
    fail('missing_field', `${context} is missing ${field}`);
  }
  return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
}
function digestPreimage(value) {
  return Object.fromEntries(TOP_FIELDS.filter(field => !['population_id', 'population_digest'].includes(field))
    .map(field => [field, value[field]]));
}
function sortedUnique(value, pattern, context) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !pattern.test(item))
      || new Set(value).size !== value.length
      || value.some((item, index) => index > 0 && value[index - 1] >= item)) {
    fail('episode_candidate_population_structure_invalid', `${context} must be canonical`);
  }
}
function canonicalVocabulary(value, vocabulary, context) {
  if (!Array.isArray(value) || value.some(item => !vocabulary.includes(item))
      || new Set(value).size !== value.length
      || value.some((item, index) => index > 0
        && vocabulary.indexOf(value[index - 1]) >= vocabulary.indexOf(item))) {
    fail('episode_candidate_population_structure_invalid', `${context} must be canonical`);
  }
}
function positionSource(input, episode) {
  return {
    context: input.context,
    context_authority: input.context_authority,
    episode,
    exact_quote_mint: input.exact_quote_mint,
    economic_evidence_port: input.economic_evidence_port,
  };
}
function findingDigestsByTransaction(acquisition) {
  return new Map(acquisition.transaction_dispositions.map(disposition => [
    disposition.tx_hash,
    [...disposition.finding_digests].sort(),
  ]));
}

export async function buildEpisodeCandidatePopulationV13(input) {
  const values = safeInput(input, INPUT_FIELDS, 'episode_candidate_population_input');
  const contextAuthority = safeInput(values.context_authority, CONTEXT_AUTHORITY_FIELDS, 'context_authority');
  input = { ...values, context_authority: contextAuthority };
  validateAuthoritativeEvidenceContextStructureV13(input.context);
  await validateSourceBoundAuthoritativeEvidenceContextV13({
    context: input.context,
    transaction_transcript_port: contextAuthority.transaction_transcript_port,
    legacy_acquisition_result: contextAuthority.legacy_acquisition_result,
    opening_enumeration_port: contextAuthority.opening_enumeration_port,
    ending_enumeration_port: contextAuthority.ending_enumeration_port,
    target_mint: contextAuthority.target_mint,
    opening_basis_reference: contextAuthority.opening_basis_reference,
  });
  const enumerated = await buildEnumeratedPositionEpisodesV13({
    evidence_context: input.context,
    exact_quote_mint: input.exact_quote_mint,
    economic_evidence_port: input.economic_evidence_port,
  });
  const acquisition = input.context_authority.legacy_acquisition_result;
  const findingDigests = findingDigestsByTransaction(acquisition);
  const rows = [...input.context.transaction_population.transactions]
    .sort((left, right) => left.canonical_transaction_coordinate - right.canonical_transaction_coordinate);
  const basePartition = new Map(enumerated.transaction_partition.map(row => [row.canonical_transaction_coordinate, row]));
  const transactionPartition = rows.map(row => {
    const effect = projectSolanaFullTransactionEffectV13({
      wallet: input.context.analyzed_wallet,
      transaction: row.full_transaction,
    });
    const membership = basePartition.get(row.canonical_transaction_coordinate);
    return {
      canonical_transaction_coordinate: row.canonical_transaction_coordinate,
      transaction_identity: effect.transaction_identity,
      transaction_disposition: membership.transaction_disposition,
      episode_ordinal: membership.episode_ordinal,
      source_effect_ids: effect.established_effects.map(item => item.effect_id).sort(),
      source_residual_ids: effect.residual_unresolved_effects.map(item => item.residual_id).sort(),
      non_interference_residual_references: effect.residual_unresolved_effects
        .map(residual => normalizedResidualReferenceV13(effect, residual)).sort(),
      activity_finding_digests: findingDigests.get(effect.transaction_identity.signature) ?? [],
    };
  });

  const episodeDispositions = [];
  for (const [episodeOrdinal, episode] of enumerated.episodes.entries()) {
    const source = positionSource(input, episode);
    const scopeDigest = computeClaimEvaluationScopeDigestV13({ claim_type: 'POSITION_EPISODE', source });
    const evaluation = await evaluateClaimOutcomeV13({
      request: {
        claim_type: 'POSITION_EPISODE',
        claim_profile: 'POSITION_ECONOMICS_V1',
        requested: true,
        scope_digest: scopeDigest,
      },
      source,
    });
    if (!['VERIFIED', 'LIMITED', 'BLOCKED'].includes(evaluation.claim_outcome)) {
      fail('profile_excluded_unreachable', 'PROFILE_EXCLUDED is reserved and unreachable in v1.3 Slice 6');
    }
    episodeDispositions.push({
      episode_ordinal: episodeOrdinal,
      transaction_coordinates: transactionPartition
        .filter(row => row.episode_ordinal === episodeOrdinal)
        .map(row => row.canonical_transaction_coordinate),
      episode,
      claim_evaluation_identity: {
        evaluation_id: evaluation.evaluation_id,
        evaluation_digest: evaluation.evaluation_digest,
        claim_evaluation_profile: evaluation.claim_evaluation_profile,
        claim_type: evaluation.claim_type,
        claim_profile: evaluation.claim_profile,
        scope_digest: evaluation.scope_digest,
      },
      population_disposition: evaluation.claim_outcome,
      candidate_eligible: evaluation.claim_outcome === 'VERIFIED',
      position_state: evaluation.position_state,
      reason_codes: evaluation.reason_codes,
      unresolved_dependency_references: evaluation.unresolved_dependencies
        .map(item => item.reference_digest),
      exclusion_references: evaluation.exclusions,
    });
  }
  const counts = Object.fromEntries(POPULATION_DISPOSITIONS_V1_3.map(disposition => [
    disposition,
    episodeDispositions.filter(row => row.population_disposition === disposition).length,
  ]));
  const value = {
    episode_candidate_population_version: EPISODE_CANDIDATE_POPULATION_VERSION_V1_3,
    episode_enumeration_profile: EPISODE_ENUMERATION_PROFILE_V1_3,
    candidate_population_profile: EPISODE_CANDIDATE_POPULATION_PROFILE_V1_3,
    population_id: null,
    population_digest: null,
    network: input.context.network,
    analyzed_wallet: input.context.analyzed_wallet,
    target_mint: input.context.target_mint,
    exact_quote_mint: input.exact_quote_mint,
    legacy_acquisition_result_digest: input.context.transaction_population.legacy_acquisition_result_digest,
    evidence_context_digest: input.context.evidence_context_digest,
    transaction_population_digest: input.context.transaction_population.population_evidence_digest,
    opening_enumeration_digest: input.context.opening_snapshot.enumeration_digest,
    ending_enumeration_digest: input.context.ending_snapshot.enumeration_digest,
    economic_evidence_identity: enumerated.economic_evidence_identity,
    transaction_partition: transactionPartition,
    episode_dispositions: episodeDispositions,
    source_transaction_count: transactionPartition.length,
    source_episode_count: episodeDispositions.length,
    verified_count: counts.VERIFIED,
    limited_count: counts.LIMITED,
    blocked_count: counts.BLOCKED,
    profile_excluded_count: counts.PROFILE_EXCLUDED,
  };
  value.population_digest = sha256CanonicalJson(digestPreimage(value));
  value.population_id = `episode-population-${value.population_digest}`;
  const frozen = cloneAndFreeze(value);
  validateEpisodeCandidatePopulationStructureV13(frozen);
  return frozen;
}

export function validateEpisodeCandidatePopulationStructureV13(value) {
  assertExactFields(value, TOP_FIELDS, 'episode_candidate_population');
  if (value.episode_candidate_population_version !== EPISODE_CANDIDATE_POPULATION_VERSION_V1_3
      || value.episode_enumeration_profile !== EPISODE_ENUMERATION_PROFILE_V1_3
      || value.candidate_population_profile !== EPISODE_CANDIDATE_POPULATION_PROFILE_V1_3) {
    fail('unsupported_episode_candidate_population', 'episode candidate population profile is unsupported');
  }
  if (!DIGEST.test(value.legacy_acquisition_result_digest) || !DIGEST.test(value.evidence_context_digest)
      || !DIGEST.test(value.transaction_population_digest) || !DIGEST.test(value.opening_enumeration_digest)
      || !DIGEST.test(value.ending_enumeration_digest)) {
    fail('episode_candidate_population_structure_invalid', 'population source identities are invalid');
  }
  assertExactFields(value.economic_evidence_identity, ECONOMIC_IDENTITY_FIELDS, 'economic_evidence_identity');
  if (!DIGEST.test(value.economic_evidence_identity.economic_evidence_digest)) {
    fail('episode_candidate_population_structure_invalid', 'economic evidence identity is invalid');
  }
  if (!Array.isArray(value.transaction_partition) || !Array.isArray(value.episode_dispositions)) {
    fail('episode_candidate_population_structure_invalid', 'population collections must be arrays');
  }
  value.transaction_partition.forEach((row, index) => {
    assertExactFields(row, PARTITION_FIELDS, `transaction_partition.${index}`);
    assertExactFields(row.transaction_identity, TRANSACTION_IDENTITY_FIELDS, `transaction_partition.${index}.transaction_identity`);
    if (row.canonical_transaction_coordinate !== index
        || !['EPISODE_SPAN_MEMBER', 'OUTSIDE_EPISODE'].includes(row.transaction_disposition)
        || (row.transaction_disposition === 'EPISODE_SPAN_MEMBER') !== Number.isSafeInteger(row.episode_ordinal)
        || (row.transaction_disposition === 'EPISODE_SPAN_MEMBER'
          && (row.episode_ordinal < 0 || row.episode_ordinal >= value.episode_dispositions.length))
        || (row.transaction_disposition === 'OUTSIDE_EPISODE' && row.episode_ordinal !== null)) {
      fail('transaction_partition_incomplete', 'every transaction requires one canonical partition disposition');
    }
    sortedUnique(row.source_effect_ids, EFFECT_ID, `transaction_partition.${index}.source_effect_ids`);
    sortedUnique(row.source_residual_ids, RESIDUAL_ID, `transaction_partition.${index}.source_residual_ids`);
    sortedUnique(row.non_interference_residual_references, DIGEST, `transaction_partition.${index}.non_interference_residual_references`);
    sortedUnique(row.activity_finding_digests, DIGEST, `transaction_partition.${index}.activity_finding_digests`);
  });
  value.episode_dispositions.forEach((row, index) => {
    assertExactFields(row, EPISODE_DISPOSITION_FIELDS, `episode_dispositions.${index}`);
    if (row.episode_ordinal !== index || !Array.isArray(row.transaction_coordinates)
        || row.transaction_coordinates.some((coordinate, coordinateIndex) => !Number.isSafeInteger(coordinate)
          || (coordinateIndex > 0 && row.transaction_coordinates[coordinateIndex - 1] + 1 !== coordinate))) {
      fail('episode_population_incomplete', 'episode ordinals and spans must be dense and canonical');
    }
    validatePositionEpisodeStructureV13(row.episode);
    assertExactFields(row.claim_evaluation_identity, CLAIM_EVALUATION_IDENTITY_FIELDS, `episode_dispositions.${index}.claim_evaluation_identity`);
    if (!DIGEST.test(row.claim_evaluation_identity.evaluation_digest)
        || row.claim_evaluation_identity.evaluation_id !== `claim-evaluation-${row.claim_evaluation_identity.evaluation_digest}`
        || row.claim_evaluation_identity.claim_evaluation_profile !== 'ARTIFACT_CLAIM_OUTCOME_EVALUATION_V1'
        || row.claim_evaluation_identity.claim_type !== 'POSITION_EPISODE'
        || row.claim_evaluation_identity.claim_profile !== 'POSITION_ECONOMICS_V1'
        || !DIGEST.test(row.claim_evaluation_identity.scope_digest)) {
      fail('episode_population_incomplete', 'claim evaluation identity is invalid');
    }
    if (!POPULATION_DISPOSITIONS_V1_3.includes(row.population_disposition)
        || row.population_disposition === 'PROFILE_EXCLUDED') {
      fail('profile_excluded_unreachable', 'population disposition is not reachable under v1.3');
    }
    if (row.candidate_eligible !== (row.population_disposition === 'VERIFIED')) {
      fail('episode_population_incomplete', 'candidate eligibility must derive exactly from VERIFIED disposition');
    }
    if (![null, 'CLOSED', 'OPEN_REALIZED_PARTIAL', 'OPEN'].includes(row.position_state)
        || (row.population_disposition === 'VERIFIED' && row.position_state === null)
        || (row.population_disposition === 'BLOCKED' && row.position_state !== null)) {
      fail('episode_population_incomplete', 'position state is incompatible with the population disposition');
    }
    canonicalVocabulary(row.reason_codes, REASON_CODES, `episode_dispositions.${index}.reason_codes`);
    sortedUnique(row.unresolved_dependency_references, DIGEST, `episode_dispositions.${index}.unresolved_dependency_references`);
    if (!Array.isArray(row.exclusion_references)) fail('episode_population_incomplete', 'exclusion references must be an array');
    row.exclusion_references.forEach((exclusion, exclusionIndex) => {
      assertExactFields(exclusion, EXCLUSION_FIELDS, `episode_dispositions.${index}.exclusion_references.${exclusionIndex}`);
      if (!DIGEST.test(exclusion.evidence_digest) || !EXCLUSION_CODES.includes(exclusion.exclusion_code)
          || !/^NI-0[1-6]$/.test(exclusion.non_interference_rule)) {
        fail('episode_population_incomplete', 'exclusion reference is invalid');
      }
    });
    if (canonicalJson(row.exclusion_references) !== canonicalJson([...row.exclusion_references]
      .sort((left, right) => left.evidence_digest.localeCompare(right.evidence_digest)))) {
      fail('episode_population_incomplete', 'exclusion references are not canonical');
    }
    const partitionCoordinates = value.transaction_partition
      .filter(item => item.episode_ordinal === index)
      .map(item => item.canonical_transaction_coordinate);
    if (canonicalJson(partitionCoordinates) !== canonicalJson(row.transaction_coordinates)) {
      fail('transaction_partition_incomplete', 'episode span does not match the transaction partition');
    }
    const eventCoordinates = [...new Set(row.episode.ordered_admitted_economic_events
      .map(event => event.canonical_transaction_coordinate))];
    if (eventCoordinates.some(coordinate => !row.transaction_coordinates.includes(coordinate))) {
      fail('episode_population_incomplete', 'episode events escape the authoritative transaction span');
    }
  });
  const nonnegativeCounts = [
    value.source_transaction_count, value.source_episode_count, value.verified_count, value.limited_count,
    value.blocked_count, value.profile_excluded_count,
  ];
  if (nonnegativeCounts.some(count => !Number.isSafeInteger(count) || count < 0)
      || value.source_transaction_count !== value.transaction_partition.length
      || value.source_episode_count !== value.episode_dispositions.length
      || value.verified_count !== value.episode_dispositions.filter(row => row.population_disposition === 'VERIFIED').length
      || value.limited_count !== value.episode_dispositions.filter(row => row.population_disposition === 'LIMITED').length
      || value.blocked_count !== value.episode_dispositions.filter(row => row.population_disposition === 'BLOCKED').length
      || value.profile_excluded_count !== 0
      || value.source_episode_count !== value.verified_count + value.limited_count
        + value.blocked_count + value.profile_excluded_count) {
    fail('candidate_population_incomplete', 'population counts do not prove the complete four-way partition');
  }
  const expectedDigest = sha256CanonicalJson(digestPreimage(value));
  if (value.population_digest !== expectedDigest || value.population_id !== `episode-population-${expectedDigest}`) {
    fail('episode_candidate_population_digest_mismatch', 'population identity does not bind the complete artifact');
  }
  return true;
}

export async function validateSourceBoundEpisodeCandidatePopulationV13(input) {
  const values = safeInput(input, SOURCE_BOUND_FIELDS, 'source_bound_episode_candidate_population_input');
  validateEpisodeCandidatePopulationStructureV13(values.population);
  const expected = await buildEpisodeCandidatePopulationV13({
    context: values.context,
    context_authority: values.context_authority,
    exact_quote_mint: values.exact_quote_mint,
    economic_evidence_port: values.economic_evidence_port,
  });
  if (canonicalJson(expected) !== canonicalJson(values.population)) {
    fail('episode_candidate_population_source_mismatch', 'population does not match exhaustive authoritative reconstruction');
  }
  return true;
}
