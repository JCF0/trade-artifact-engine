import { types as utilTypes } from 'node:util';
import {
  assertExactFields,
  assertPlainJsonValue,
  canonicalJson,
  cloneAndFreeze,
  deepFreeze,
  fail,
  sha256CanonicalJson,
} from './contract.mjs';
import {
  CLAIM_PROFILE_BY_TYPE,
  EXCLUSION_CODES,
  FULL_RESULT_PROFILE_DEFINITIONS,
  LIMITED_PROFILE_BY_CLAIM_PROFILE,
  LIMITED_RESULT_PROFILE_DEFINITIONS,
  POSITION_VERIFIED_FIELD_MATRIX,
  REASON_CODES,
  SUPPORTING_PROFILES,
  normalizeReasonCodes,
  validateClaimCombination,
} from './semantics.mjs';
import {
  NON_INTERFERENCE_SOURCE_KINDS,
  deriveNonInterferenceDecisionsV13,
  validateNonInterferenceDecisionStructureV13,
} from './non-interference.mjs';
import {
  validateSourceBoundAuthoritativeEvidenceContextV13,
  validateAuthoritativeEvidenceContextStructureV13,
} from './authoritative-evidence-context.mjs';
import { projectSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import { validateSourceBoundPositionEpisodeV13 } from './position-episode.mjs';
import { validateWalletAcquisitionResultV1 } from '../candidate-set/acquisition-result.mjs';

export const CLAIM_EVALUATION_VERSION = 'artifact_claim_evaluation_v1_3';
export const CLAIM_EVALUATION_PROFILE = 'ARTIFACT_CLAIM_OUTCOME_EVALUATION_V1';
export const CLAIM_EVALUATION_IDENTITY_VERSION = 'artifact_claim_evaluation_identity_v1_3';
export const CLAIM_EVALUATION_ID_PREFIX = 'claim-evaluation-';
export const FIELD_AVAILABILITY_VALUES = deepFreeze(['AVAILABLE', 'UNAVAILABLE', 'NOT_APPLICABLE']);
export const CLAIM_EVALUATION_FIELDS = deepFreeze([
  'claim_evaluation_version', 'claim_evaluation_profile', 'claim_evaluation_identity_version',
  'evaluation_id', 'evaluation_digest', 'claim_type', 'claim_profile', 'requested',
  'scope_digest', 'requested_field_set', 'supporting_profiles', 'authoritative_evidence_identities',
  'derived_boundary_identities', 'field_availability', 'established_fields',
  'unresolved_dependencies', 'non_interference_decisions', 'exclusions', 'reason_codes',
  'result_profile', 'claim_outcome', 'position_state',
]);

const REQUEST_FIELDS = ['claim_type', 'claim_profile', 'requested', 'scope_digest'];
const EVALUATOR_INPUT_FIELDS = ['request', 'source'];
const CONTEXT_AUTHORITY_FIELDS = [
  'transaction_transcript_port', 'legacy_acquisition_result', 'opening_enumeration_port',
  'ending_enumeration_port', 'target_mint', 'opening_basis_reference',
];
const SOURCE_FIELDS = Object.freeze({
  TRANSACTION_EFFECT: ['context', 'context_authority', 'transaction_signature'],
  POSITION_EPISODE: ['context', 'context_authority', 'episode', 'exact_quote_mint', 'economic_evidence_port'],
  WALLET_WINDOW: ['context', 'context_authority'],
});
const DIGEST = /^[0-9a-f]{64}$/;
const AVAILABILITY_FIELDS = ['field', 'availability'];
const ESTABLISHED_FIELDS = ['field', 'value', 'value_digest', 'source_references'];
const EVIDENCE_IDENTITY_FIELDS = ['evidence_kind', 'evidence_digest'];
const BOUNDARY_IDENTITY_FIELDS = ['boundary_kind', 'boundary_identity_profile', 'boundary_digest'];
const UNRESOLVED_FIELDS = ['reference_digest', 'source_kind', 'reason_code'];
const EXCLUSION_FIELDS = ['evidence_digest', 'exclusion_code', 'non_interference_rule'];

const POSITION_FIELD_ORDER = deepFreeze([
  'scope_identity', 'target_mint', 'exact_quote_mint', 'episode_identity', 'opening_boundary',
  'ending_boundary', 'opening_target_inventory', 'opening_attributable_basis',
  'acquisition_event_set', 'disposal_event_set', 'target_transfer_set',
  'aggregate_acquisition_basis', 'fee_treatment', 'exclusion_references',
  'unresolved_claim_affecting_findings', 'disposal_proceeds', 'realized_basis_consumed',
  'realized_pnl', 'realized_return', 'ending_target_inventory',
  'remaining_attributable_basis', 'position_state',
]);
const FULL_FIELDS = deepFreeze({
  TRANSACTION_EFFECT_V1: FULL_RESULT_PROFILE_DEFINITIONS.TRANSACTION_EFFECT_V1.required_fields,
  POSITION_ECONOMICS_V1: POSITION_FIELD_ORDER,
  WALLET_EFFECT_COVERAGE_V1: FULL_RESULT_PROFILE_DEFINITIONS.WALLET_EFFECT_COVERAGE_V1.required_fields,
});
const POSITION_LIMITED_FIELDS = [
  'scope_identity', 'acquisition_evidence_identity', 'target_mint', 'exact_quote_mint',
  'episode_identity', 'observed_episode_span', 'established_target_effects',
  'verified_subordinate_effect_references', 'unresolved_finding_references', 'position_state',
];
const RESIDUAL_REASON_MAP = Object.freeze({
  UNKNOWN_TOKEN_OWNER: 'UNKNOWN_TOKEN_SCOPE',
  TOKEN_BALANCE_SIDE_MISSING: 'TRANSACTION_EFFECT_UNRESOLVED',
  UNMATCHED_WALLET_INSTRUCTION: 'UNMATCHED_WALLET_INSTRUCTION',
  NATIVE_BALANCE_RECONCILIATION: 'TRANSACTION_EFFECT_UNRESOLVED',
  FAILED_TOKEN_BALANCE_OBSERVATION: 'TRANSACTION_EFFECT_UNRESOLVED',
  ACCOUNT_CLOSURE_UNRESOLVED: 'ACCOUNT_AUTHORITY_UNRESOLVED',
  ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED: 'ACCOUNT_AUTHORITY_UNRESOLVED',
  EXTERNAL_CLOSURE_RENT: 'FEE_TREATMENT_UNRESOLVED',
  WALLET_ACCOUNT_EVIDENCE_MISSING: 'TRANSACTION_EFFECT_UNRESOLVED',
});

function safeDescriptors(value, fields, context) {
  if (value !== null && typeof value === 'object' && utilTypes.isProxy(value)) fail('proxy_not_allowed', `${context} must not be a proxy`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_object', `${context} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype) fail('custom_prototype_not_allowed', `${context} must have the plain-object prototype`);
  let descriptors;
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) fail('symbol_key_not_allowed', `${context} contains symbol keys`);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { fail('proxy_not_allowed', `${context} must not be a proxy`); }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!fields.includes(key)) fail('unknown_field', `${context} contains unknown field`, { context, field: key });
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('accessor_not_allowed', `${context} contains an accessor`, { context, field: key });
  }
  for (const field of fields) if (!Object.hasOwn(descriptors, field)) fail('missing_field', `${context} is missing field`, { context, field });
  return descriptors;
}
function valuesFromDescriptors(descriptors, fields) { return Object.fromEntries(fields.map(field => [field, descriptors[field].value])); }
function validateRequest(value) {
  const request = valuesFromDescriptors(assertExactFields(value, REQUEST_FIELDS, 'claim_evaluation_request'), REQUEST_FIELDS);
  if (CLAIM_PROFILE_BY_TYPE[request.claim_type] !== request.claim_profile) fail('claim_profile_invalid', 'claim profile does not match claim type');
  if (typeof request.requested !== 'boolean') fail('requested_invalid', 'requested must be boolean');
  if (!DIGEST.test(request.scope_digest)) fail('scope_digest_invalid', 'scope digest must be lowercase SHA-256');
  return request;
}
function validateSourceShape(source, claimType) {
  const fields = SOURCE_FIELDS[claimType];
  const result = valuesFromDescriptors(safeDescriptors(source, fields, 'claim_evaluation_source'), fields);
  const authority = valuesFromDescriptors(safeDescriptors(result.context_authority, CONTEXT_AUTHORITY_FIELDS, 'claim_evaluation_context_authority'), CONTEXT_AUTHORITY_FIELDS);
  result.context_authority = authority;
  return result;
}
function contextValidationInput(source) {
  return {
    context: source.context,
    transaction_transcript_port: source.context_authority.transaction_transcript_port,
    legacy_acquisition_result: source.context_authority.legacy_acquisition_result,
    opening_enumeration_port: source.context_authority.opening_enumeration_port,
    ending_enumeration_port: source.context_authority.ending_enumeration_port,
    target_mint: source.context_authority.target_mint,
    opening_basis_reference: source.context_authority.opening_basis_reference,
  };
}
function sourceScopePreimage(claimType, source) {
  validateAuthoritativeEvidenceContextStructureV13(source.context);
  if (claimType === 'TRANSACTION_EFFECT') return {
    claim_type: claimType,
    transaction_population_digest: source.context.transaction_population.population_evidence_digest,
    transaction_signature: source.transaction_signature,
  };
  if (claimType === 'POSITION_EPISODE') return {
    claim_type: claimType,
    evidence_context_digest: source.context.evidence_context_digest,
    position_episode_digest: source.episode.position_episode_digest,
    target_mint: source.episode.target_mint,
    exact_quote_mint: source.episode.exact_quote_mint,
  };
  return {
    claim_type: claimType,
    legacy_acquisition_result_digest: source.context.transaction_population.legacy_acquisition_result_digest,
    transaction_population_digest: source.context.transaction_population.population_evidence_digest,
  };
}
export function computeClaimEvaluationScopeDigestV13(input) {
  const descriptors = safeDescriptors(input, ['claim_type', 'source'], 'claim_evaluation_scope_input');
  const claimType = descriptors.claim_type.value;
  if (!SOURCE_FIELDS[claimType]) fail('claim_type_invalid', 'unsupported claim type');
  const source = validateSourceShape(descriptors.source.value, claimType);
  return sha256CanonicalJson(sourceScopePreimage(claimType, source));
}

function boundaryIdentity(boundaryKind, boundary, contextDigest) {
  const preimage = {
    boundary_identity_profile: 'ARTIFACT_CLAIM_EVALUATION_BOUNDARY_IDENTITY_V1',
    boundary_kind: boundaryKind,
    evidence_context_digest: contextDigest,
    boundary,
  };
  return {
    boundary_kind: boundaryKind,
    boundary_identity_profile: preimage.boundary_identity_profile,
    boundary_digest: sha256CanonicalJson(preimage),
  };
}
function evidenceIdentity(kind, digest) { return { evidence_kind: kind, evidence_digest: digest }; }
function established(field, value, sourceReferences = []) {
  return {
    field,
    value: structuredClone(value),
    value_digest: sha256CanonicalJson({ field, value }),
    source_references: [...new Set(sourceReferences)].sort(),
  };
}
export function normalizedResidualReferenceV13(effect, residual) {
  return sha256CanonicalJson({
    evidence_kind: 'TRANSACTION_EFFECT_RESIDUAL',
    transaction_identity: effect.transaction_identity,
    residual,
  });
}
function allProjectedTransactions(context) {
  return [...context.transaction_population.transactions]
    .sort((a, b) => a.canonical_transaction_coordinate - b.canonical_transaction_coordinate)
    .map(row => ({
      row,
      effect: projectSolanaFullTransactionEffectV13({ wallet: context.analyzed_wallet, transaction: row.full_transaction }),
    }));
}
function residualItem(projected, residual) {
  const transactionResidualReasons = [...new Set(projected.effect.residual_unresolved_effects.map(item => item.reason_code))].sort();
  return {
    reference_digest: normalizedResidualReferenceV13(projected.effect, residual),
    source_kind: 'TRANSACTION_EFFECT_RESIDUAL',
    transaction_coordinate: projected.row.canonical_transaction_coordinate,
    transaction_status: projected.effect.finalized_execution_status,
    residual_reason: residual.reason_code,
    mint: residual.mint,
    accounts: [...new Set([...(residual.accounts ?? []), residual.account].filter(item => item !== null))].sort(),
    established_effect_kinds: [...new Set(projected.effect.established_effects.map(item => item.effect_kind))].sort(),
    dependency_code: null,
    dependency_references: [],
    transaction_residual_reasons: transactionResidualReasons,
    dependency_last_event_ordinal: null,
    basis_reset_event_ordinal: null,
  };
}
function unclassifiedEffectItem(projected, effect) {
  const transactionResidualReasons = [...new Set(projected.effect.residual_unresolved_effects.map(item => item.reason_code))].sort();
  return {
    reference_digest: sha256CanonicalJson({
      evidence_kind: 'UNCLASSIFIED_POSITION_EFFECT',
      transaction_identity: projected.effect.transaction_identity,
      effect,
    }),
    source_kind: 'TRANSACTION_EFFECT_RESIDUAL',
    transaction_coordinate: projected.row.canonical_transaction_coordinate,
    transaction_status: projected.effect.finalized_execution_status,
    residual_reason: null,
    mint: effect.mint,
    accounts: [...new Set([effect.account, effect.destination].filter(item => item !== null))].sort(),
    established_effect_kinds: [...new Set(projected.effect.established_effects.map(item => item.effect_kind))].sort(),
    dependency_code: null,
    dependency_references: [],
    transaction_residual_reasons: transactionResidualReasons,
    dependency_last_event_ordinal: null,
    basis_reset_event_ordinal: null,
  };
}
function dependencyItem(dependency, episode) {
  const eventById = new Map(episode.ordered_admitted_economic_events.map(event => [event.event_id, event]));
  const dependencyEvents = dependency.event_ids.map(id => eventById.get(id)).filter(Boolean);
  const coordinate = dependencyEvents.map(event => event.canonical_transaction_coordinate).sort((a, b) => a - b)[0] ?? null;
  const dependencyEventOrdinals = dependencyEvents.map(event => event.episode_event_ordinal);
  const dependencyLastEventOrdinal = dependencyEventOrdinals.length
    ? Math.max(...dependencyEventOrdinals) : null;
  const basisResetEventOrdinal = episode.ordered_admitted_economic_events
    .filter(event => dependencyLastEventOrdinal !== null
      && event.episode_event_ordinal > dependencyLastEventOrdinal && event.genuine_economic_zero_after)
    .map(event => event.episode_event_ordinal).sort((a, b) => a - b)[0] ?? null;
  return {
    reference_digest: sha256CanonicalJson({ evidence_kind: 'POSITION_ECONOMIC_DEPENDENCY', dependency }),
    source_kind: 'POSITION_ECONOMIC_DEPENDENCY',
    transaction_coordinate: coordinate,
    transaction_status: null,
    residual_reason: null,
    mint: null,
    accounts: [],
    established_effect_kinds: [],
    dependency_code: dependency.dependency_code,
    dependency_references: dependency.dependency_references.map(reference => DIGEST.test(reference) ? reference : sha256CanonicalJson({ dependency_reference: reference })).sort(),
    transaction_residual_reasons: [],
    dependency_last_event_ordinal: dependencyLastEventOrdinal,
    basis_reset_event_ordinal: basisResetEventOrdinal,
  };
}
function findingItem(finding) {
  const affected = finding.affected_token_mints ?? [];
  return {
    reference_digest: finding.finding_digest,
    source_kind: 'ACQUISITION_ACTIVITY_FINDING',
    transaction_coordinate: null,
    transaction_status: null,
    residual_reason: null,
    mint: affected.length === 1 ? affected[0] : null,
    accounts: [],
    established_effect_kinds: [],
    dependency_code: null,
    dependency_references: [],
    transaction_residual_reasons: [],
    dependency_last_event_ordinal: null,
    basis_reset_event_ordinal: null,
  };
}
function targetAccounts(context) {
  return [...new Set([
    ...context.opening_snapshot.accounts.map(item => item.account),
    ...context.ending_snapshot.accounts.map(item => item.account),
  ])].sort();
}
function positionClosedCoordinate(episode) {
  if (episode.position_state !== 'CLOSED') return null;
  const candidates = episode.ordered_admitted_economic_events
    .filter(event => event.genuine_economic_zero_after)
    .map(event => event.canonical_transaction_coordinate);
  return candidates.length ? Math.max(...candidates) : null;
}
function positionZeroOpenCoordinate(episode, items) {
  const boundary = episode.opening_boundary;
  if (boundary.zero_status !== 'EXACT_ZERO' || boundary.aggregate_raw_quantity !== '0') return null;
  if (boundary.boundary_kind === 'TRANSACTION_PRE') {
    const coordinate = boundary.canonical_transaction_coordinate;
    if (items.some(item => item.residual_reason !== null
        && Number.isSafeInteger(item.transaction_coordinate)
        && item.transaction_coordinate < coordinate)) return null;
    return coordinate;
  }
  if (Object.hasOwn(boundary, 'enumeration_digest')) return 0;
  return null;
}
function deriveDecisions(claimType, profile, source, projected, episode = null) {
  let items = projected.flatMap(item => item.effect.residual_unresolved_effects.map(residual => residualItem(item, residual)));
  if (claimType === 'POSITION_EPISODE') {
    const resolvedEffectIds = new Set(episode.ordered_admitted_economic_events.flatMap(event => [...event.source_effect_ids, ...event.corroborating_effect_ids]));
    items = projected.flatMap(item => [
      ...item.effect.established_effects.filter(effect => !resolvedEffectIds.has(effect.effect_id)).map(effect => unclassifiedEffectItem(item, effect)),
      ...item.effect.residual_unresolved_effects.map(residual => residualItem(item, residual)),
    ]);
    items.push(...episode.unresolved_economic_dependencies.map(dependency => dependencyItem(dependency, episode)));
    items.push(...source.context_authority.legacy_acquisition_result.activity_findings.map(findingItem));
  } else if (claimType === 'WALLET_WINDOW') {
    items.push(...source.context_authority.legacy_acquisition_result.activity_findings.map(findingItem));
  }
  return {
    items,
    decisions: deriveNonInterferenceDecisionsV13({
      claim_context: {
        claim_type: claimType,
        claim_profile: profile,
        target_mint: claimType === 'POSITION_EPISODE' ? episode.target_mint : null,
        exact_quote_mint: claimType === 'POSITION_EPISODE' ? episode.exact_quote_mint : null,
        target_accounts: claimType === 'POSITION_EPISODE' ? targetAccounts(source.context) : [],
        closed_boundary_coordinate: claimType === 'POSITION_EPISODE' ? positionClosedCoordinate(episode) : null,
        zero_open_boundary_coordinate: claimType === 'POSITION_EPISODE'
          ? positionZeroOpenCoordinate(episode, items) : null,
      },
      evidence_items: items,
    }),
  };
}
function reasonsFor(items, decisions, claimType) {
  const affecting = new Set(decisions.filter(item => item.decision === 'CLAIM_AFFECTING').map(item => item.unresolved_reference));
  const reasons = [];
  for (const item of items) {
    if (!affecting.has(item.reference_digest)) continue;
    if (claimType === 'WALLET_WINDOW') reasons.push('WALLET_EFFECT_UNRESOLVED');
    else if (claimType === 'TRANSACTION_EFFECT') reasons.push('TRANSACTION_EFFECT_UNRESOLVED');
    if (item.dependency_code !== null) reasons.push(item.dependency_code);
    else if (item.residual_reason !== null) reasons.push(RESIDUAL_REASON_MAP[item.residual_reason] ?? 'TRANSACTION_EFFECT_UNRESOLVED');
    else if (claimType === 'POSITION_EPISODE') reasons.push('TRANSACTION_EFFECT_UNRESOLVED');
  }
  return normalizeReasonCodes(reasons);
}
function unresolvedRows(items, decisions, claimType) {
  const affecting = new Set(decisions.filter(item => item.decision === 'CLAIM_AFFECTING').map(item => item.unresolved_reference));
  return items.filter(item => affecting.has(item.reference_digest)).map(item => ({
    reference_digest: item.reference_digest,
    source_kind: item.source_kind,
    reason_code: item.dependency_code ?? (claimType === 'WALLET_WINDOW' ? 'WALLET_EFFECT_UNRESOLVED' : claimType === 'TRANSACTION_EFFECT' ? 'TRANSACTION_EFFECT_UNRESOLVED' : (RESIDUAL_REASON_MAP[item.residual_reason] ?? 'TRANSACTION_EFFECT_UNRESOLVED')),
  })).sort((a, b) => a.reference_digest.localeCompare(b.reference_digest));
}
function exclusions(decisions) {
  return decisions.filter(item => item.decision === 'EXCLUDED_NON_INTERFERING').map(item => ({
    evidence_digest: item.unresolved_reference,
    exclusion_code: item.exclusion_code,
    non_interference_rule: item.applied_rule,
  }));
}
function availabilityRows(fields, unavailable = new Set(), notApplicable = new Set()) {
  return fields.map(field => ({
    field,
    availability: notApplicable.has(field) ? 'NOT_APPLICABLE' : unavailable.has(field) ? 'UNAVAILABLE' : 'AVAILABLE',
  }));
}
function sourceRefs(source, projected, episode = null) {
  const refs = [source.context.transaction_population.population_evidence_digest];
  if (episode) refs.push(source.context.evidence_context_digest, episode.position_episode_digest, episode.economic_evidence_identity.economic_evidence_digest);
  refs.push(...projected.map(item => sha256CanonicalJson(item.effect)));
  return [...new Set(refs)].sort();
}
function positionValues(scopeDigest, episode, decisions) {
  const events = episode.ordered_admitted_economic_events;
  const eventSet = ids => ids.map(id => events.find(event => event.event_id === id));
  return {
    scope_identity: scopeDigest,
    target_mint: episode.target_mint,
    exact_quote_mint: episode.exact_quote_mint,
    episode_identity: episode.position_episode_digest,
    opening_boundary: episode.opening_boundary,
    ending_boundary: episode.ending_boundary,
    opening_target_inventory: episode.opening_inventory,
    opening_attributable_basis: episode.opening_attributable_basis,
    acquisition_event_set: eventSet(episode.acquisition_event_ids),
    disposal_event_set: eventSet(episode.disposal_event_ids),
    target_transfer_set: eventSet(episode.transfer_event_ids),
    aggregate_acquisition_basis: episode.aggregate_acquisition_basis,
    fee_treatment: episode.fee_treatment,
    exclusion_references: exclusions(decisions),
    unresolved_claim_affecting_findings: decisions.filter(item => item.decision === 'CLAIM_AFFECTING').map(item => item.unresolved_reference),
    disposal_proceeds: episode.recognized_disposal_proceeds,
    realized_basis_consumed: episode.realized_basis_consumed,
    realized_pnl: episode.realized_pnl,
    realized_return: episode.realized_return,
    ending_target_inventory: episode.ending_economic_inventory,
    remaining_attributable_basis: episode.remaining_attributable_basis,
    position_state: episode.position_state,
  };
}
function positionAvailability(episode, values, decisions) {
  const unavailable = new Set();
  const notApplicable = new Set();
  if (episode.position_state === 'OPEN') for (const field of ['disposal_proceeds', 'realized_basis_consumed', 'realized_pnl', 'realized_return']) notApplicable.add(field);
  for (const field of POSITION_FIELD_ORDER) {
    if (['exclusion_references', 'unresolved_claim_affecting_findings'].includes(field) || notApplicable.has(field)) continue;
    if (values[field] === null) unavailable.add(field);
  }
  for (const decision of decisions) if (decision.decision === 'CLAIM_AFFECTING') for (const field of decision.affected_fields) {
    if (field !== 'unresolved_claim_affecting_findings') {
      unavailable.add(field);
      notApplicable.delete(field);
    }
  }
  if (episode.position_state === null) {
    for (const field of ['ending_target_inventory', 'remaining_attributable_basis']) unavailable.add(field);
  }
  return availabilityRows(POSITION_FIELD_ORDER, unavailable, notApplicable);
}
function evidenceIdentities(source, projected, episode = null) {
  const rows = [
    evidenceIdentity('TRANSACTION_POPULATION', source.context.transaction_population.population_evidence_digest),
    evidenceIdentity('LEGACY_ACQUISITION_RESULT', source.context.transaction_population.legacy_acquisition_result_digest),
    ...projected.map(item => evidenceIdentity('TRANSACTION_EFFECT', sha256CanonicalJson(item.effect))),
  ];
  if (episode) {
    rows.push(evidenceIdentity('AUTHORITATIVE_EVIDENCE_CONTEXT', source.context.evidence_context_digest));
    rows.push(evidenceIdentity('POSITION_EPISODE', episode.position_episode_digest));
    rows.push(evidenceIdentity('POSITION_ECONOMIC_EVIDENCE', episode.economic_evidence_identity.economic_evidence_digest));
  }
  return rows.sort((a, b) => a.evidence_kind.localeCompare(b.evidence_kind) || a.evidence_digest.localeCompare(b.evidence_digest));
}
function buildBase(request) {
  return {
    claim_evaluation_version: CLAIM_EVALUATION_VERSION,
    claim_evaluation_profile: CLAIM_EVALUATION_PROFILE,
    claim_evaluation_identity_version: CLAIM_EVALUATION_IDENTITY_VERSION,
    evaluation_id: null,
    evaluation_digest: null,
    claim_type: request.claim_type,
    claim_profile: request.claim_profile,
    requested: request.requested,
    scope_digest: request.scope_digest,
    requested_field_set: request.requested ? [...FULL_FIELDS[request.claim_profile]] : [],
    supporting_profiles: request.requested ? SUPPORTING_PROFILES : null,
    authoritative_evidence_identities: [],
    derived_boundary_identities: [],
    field_availability: [],
    established_fields: [],
    unresolved_dependencies: [],
    non_interference_decisions: [],
    exclusions: [],
    reason_codes: [],
    result_profile: null,
    claim_outcome: 'NOT_EVALUATED',
    position_state: null,
  };
}
function finalize(value) {
  value.authoritative_evidence_identities = [...value.authoritative_evidence_identities].sort((a, b) => a.evidence_kind.localeCompare(b.evidence_kind) || a.evidence_digest.localeCompare(b.evidence_digest));
  value.derived_boundary_identities = [...value.derived_boundary_identities].sort((a, b) => ['OPENING', 'ENDING_AS_OF'].indexOf(a.boundary_kind) - ['OPENING', 'ENDING_AS_OF'].indexOf(b.boundary_kind));
  value.established_fields = [...value.established_fields].sort((a, b) => a.field.localeCompare(b.field));
  value.unresolved_dependencies = [...value.unresolved_dependencies].sort((a, b) => a.reference_digest.localeCompare(b.reference_digest));
  value.non_interference_decisions = [...value.non_interference_decisions].sort((a, b) => a.unresolved_reference.localeCompare(b.unresolved_reference));
  value.exclusions = [...value.exclusions].sort((a, b) => a.evidence_digest.localeCompare(b.evidence_digest));
  const preimage = { claim_evaluation_identity_version: CLAIM_EVALUATION_IDENTITY_VERSION, evaluation: Object.fromEntries(CLAIM_EVALUATION_FIELDS.filter(field => !['evaluation_id', 'evaluation_digest'].includes(field)).map(field => [field, value[field]])) };
  value.evaluation_digest = sha256CanonicalJson(preimage);
  value.evaluation_id = `${CLAIM_EVALUATION_ID_PREFIX}${value.evaluation_digest}`;
  const frozen = cloneAndFreeze(value);
  validateClaimEvaluationStructureV13(frozen);
  return frozen;
}
async function reconstructSource(request, source) {
  await validateSourceBoundAuthoritativeEvidenceContextV13(contextValidationInput(source));
  const expectedScope = sha256CanonicalJson(sourceScopePreimage(request.claim_type, source));
  if (request.scope_digest !== expectedScope) fail('scope_digest_mismatch', 'request scope does not match authoritative source');
  validateWalletAcquisitionResultV1(source.context_authority.legacy_acquisition_result);
  if (sha256CanonicalJson(source.context_authority.legacy_acquisition_result) !== source.context.transaction_population.legacy_acquisition_result_digest) fail('legacy_acquisition_source_mismatch', 'legacy acquisition result does not match evidence context');
  const projected = allProjectedTransactions(source.context);
  if (request.claim_type === 'POSITION_EPISODE') {
    await validateSourceBoundPositionEpisodeV13({
      episode: source.episode,
      evidence_context: source.context,
      exact_quote_mint: source.exact_quote_mint,
      economic_evidence_port: source.economic_evidence_port,
    });
  }
  return projected;
}

export async function evaluateClaimOutcomeV13(input) {
  const top = valuesFromDescriptors(safeDescriptors(input, EVALUATOR_INPUT_FIELDS, 'claim_outcome_evaluator_input'), EVALUATOR_INPUT_FIELDS);
  const request = validateRequest(top.request);
  if (!request.requested) {
    if (top.source !== null) fail('not_evaluated_source_forbidden', 'unrequested claims are status-only');
    return finalize(buildBase(request));
  }
  if (top.source === null) fail('scope_source_required', 'requested claims require authoritative source binding');
  const source = validateSourceShape(top.source, request.claim_type);
  const projected = await reconstructSource(request, source);
  const value = buildBase(request);
  const refs = sourceRefs(source, projected, request.claim_type === 'POSITION_EPISODE' ? source.episode : null);
  value.authoritative_evidence_identities = evidenceIdentities(source, projected, request.claim_type === 'POSITION_EPISODE' ? source.episode : null);

  if (request.claim_type === 'TRANSACTION_EFFECT') {
    const match = projected.filter(item => item.row.source_identity.signature === source.transaction_signature);
    if (match.length !== 1) fail('transaction_source_mismatch', 'requested transaction is not uniquely present in the authoritative population');
    const { items, decisions } = deriveDecisions(request.claim_type, request.claim_profile, source, match);
    const reasons = reasonsFor(items, decisions, request.claim_type);
    const effect = match[0].effect;
    value.non_interference_decisions = decisions;
    value.unresolved_dependencies = unresolvedRows(items, decisions, request.claim_type);
    value.exclusions = exclusions(decisions);
    value.reason_codes = reasons;
    const unavailable = new Set(reasons.length ? ['committed_effects'] : []);
    value.field_availability = availabilityRows(FULL_FIELDS[request.claim_profile], unavailable);
    if (reasons.length === 0) {
      value.claim_outcome = 'VERIFIED';
      value.result_profile = request.claim_profile;
      value.established_fields = [
        established('transaction_identity', effect.transaction_identity, refs),
        established('finalized_execution_status', effect.finalized_execution_status, refs),
        established('committed_effects', effect.established_effects, refs),
        established('unresolved_effect_references', [], refs),
        established('reason_codes', [], refs),
      ];
    } else {
      value.claim_outcome = 'LIMITED';
      value.result_profile = LIMITED_PROFILE_BY_CLAIM_PROFILE[request.claim_profile];
      value.established_fields = [
        established('transaction_identity', effect.transaction_identity, refs),
        established('finalized_execution_status', effect.finalized_execution_status, refs),
        established('established_effects', effect.established_effects, refs),
        established('residual_unresolved_effect_references', value.unresolved_dependencies.map(item => item.reference_digest), refs),
      ];
    }
  } else if (request.claim_type === 'POSITION_EPISODE') {
    const episode = source.episode;
    const { items, decisions } = deriveDecisions(request.claim_type, request.claim_profile, source, projected, episode);
    const reasons = reasonsFor(items, decisions, request.claim_type);
    const values = positionValues(request.scope_digest, episode, decisions);
    value.derived_boundary_identities = [
      boundaryIdentity('OPENING', episode.opening_boundary, source.context.evidence_context_digest),
      boundaryIdentity('ENDING_AS_OF', episode.ending_boundary, source.context.evidence_context_digest),
    ];
    value.non_interference_decisions = decisions;
    value.unresolved_dependencies = unresolvedRows(items, decisions, request.claim_type);
    value.exclusions = exclusions(decisions);
    value.reason_codes = reasons;
    value.field_availability = positionAvailability(episode, values, decisions);
    value.position_state = value.field_availability.find(
      item => item.field === 'position_state',
    ).availability === 'AVAILABLE' ? episode.position_state : null;
    const unavailable = value.field_availability.some(item => item.availability === 'UNAVAILABLE');
    const establishedEffectIds = new Set(projected.flatMap(item => item.effect.established_effects.map(effect => effect.effect_id)));
    const establishedTargetEffects = episode.ordered_admitted_economic_events.filter(event => (
      [...event.source_effect_ids, ...event.corroborating_effect_ids].every(effectId => establishedEffectIds.has(effectId))
    ));
    const everyTargetEffectEstablished = establishedTargetEffects.length === episode.ordered_admitted_economic_events.length;
    if (!unavailable && episode.position_state !== null && reasons.length === 0 && everyTargetEffectEstablished) {
      value.claim_outcome = 'VERIFIED';
      value.result_profile = request.claim_profile;
      value.established_fields = POSITION_FIELD_ORDER.filter(field => value.field_availability.find(item => item.field === field).availability !== 'NOT_APPLICABLE').map(field => established(field, values[field], refs));
    } else {
      value.claim_outcome = 'LIMITED';
      value.result_profile = LIMITED_PROFILE_BY_CLAIM_PROFILE[request.claim_profile];
      const limitedValues = {
        scope_identity: request.scope_digest,
        acquisition_evidence_identity: source.context.evidence_context_digest,
        target_mint: episode.target_mint,
        exact_quote_mint: episode.exact_quote_mint,
        episode_identity: episode.position_episode_digest,
        observed_episode_span: { opening_boundary: episode.opening_boundary, ending_boundary: episode.ending_boundary },
        established_target_effects: establishedTargetEffects,
        verified_subordinate_effect_references: [...new Set(establishedTargetEffects.flatMap(event => [...event.source_effect_ids, ...event.corroborating_effect_ids]))].sort(),
        unresolved_finding_references: value.unresolved_dependencies.map(item => item.reference_digest),
        position_state: value.position_state,
      };
      const limitedProjectionComplete = POSITION_LIMITED_FIELDS.every(field => (
        Object.hasOwn(limitedValues, field) && limitedValues[field] !== undefined
          && (field === 'position_state' || limitedValues[field] !== null)
      )) && everyTargetEffectEstablished;
      if (!limitedProjectionComplete) {
        value.claim_outcome = 'BLOCKED';
        value.result_profile = null;
        value.authoritative_evidence_identities = [];
        value.derived_boundary_identities = [];
        value.field_availability = [];
        value.established_fields = [];
        value.reason_codes = normalizeReasonCodes([
          ...reasons,
          ...(!everyTargetEffectEstablished ? ['TRANSACTION_EFFECT_UNRESOLVED'] : []),
          'NO_LIMITED_PROJECTION',
        ]);
        value.position_state = null;
      } else {
        const limitedEstablished = new Map(POSITION_LIMITED_FIELDS.map(field => [field, established(field, limitedValues[field], refs)]));
        for (const field of POSITION_FIELD_ORDER.filter(field => value.field_availability.find(item => item.field === field).availability === 'AVAILABLE')) {
          if (!limitedEstablished.has(field)) limitedEstablished.set(field, established(field, values[field], refs));
        }
        value.established_fields = [...limitedEstablished.values()].sort((a, b) => a.field.localeCompare(b.field));
      }
    }
  } else {
    const { items, decisions } = deriveDecisions(request.claim_type, request.claim_profile, source, projected);
    const reasons = reasonsFor(items, decisions, request.claim_type);
    const acquisition = source.context_authority.legacy_acquisition_result;
    value.non_interference_decisions = decisions;
    value.unresolved_dependencies = unresolvedRows(items, decisions, request.claim_type);
    value.exclusions = [];
    value.reason_codes = reasons;
    const values = {
      acquisition_window_identity: sha256CanonicalJson({ scope: acquisition.scope, boundary: acquisition.boundary }),
      finalized_anchor: acquisition.boundary,
      transaction_population: source.context.transaction_population,
      transaction_dispositions: acquisition.transaction_dispositions,
      unresolved_effect_references: value.unresolved_dependencies.map(item => item.reference_digest),
      reason_codes: reasons,
    };
    value.claim_outcome = reasons.length === 0 ? 'VERIFIED' : 'LIMITED';
    value.result_profile = reasons.length === 0 ? request.claim_profile : LIMITED_PROFILE_BY_CLAIM_PROFILE[request.claim_profile];
    value.field_availability = reasons.length === 0 ? availabilityRows(FULL_FIELDS[request.claim_profile]) : [];
    value.established_fields = Object.entries(values)
      .filter(([field]) => value.claim_outcome === 'VERIFIED' || field !== 'reason_codes')
      .map(([field, fieldValue]) => established(field, fieldValue, refs));
  }
  return finalize(value);
}

function compareCanonical(value, expected, code, message) {
  if (canonicalJson(value) !== canonicalJson(expected)) fail(code, message);
}
function exactCanonicalArray(value, context, key, itemFields = null) {
  if (!Array.isArray(value)) fail(`${context}_invalid`, `${context} must be an array`);
  let prior = null;
  for (const [index, item] of value.entries()) {
    if (itemFields) assertExactFields(item, itemFields, `${context}.${index}`);
    const current = key(item);
    if (prior !== null && prior >= current) fail(`${context}_noncanonical`, `${context} must be unique and canonically ordered`);
    prior = current;
  }
}
export function claimEvaluationDigestPreimage(value) {
  return {
    claim_evaluation_identity_version: CLAIM_EVALUATION_IDENTITY_VERSION,
    evaluation: Object.fromEntries(CLAIM_EVALUATION_FIELDS.filter(field => !['evaluation_id', 'evaluation_digest'].includes(field)).map(field => [field, value[field]])),
  };
}
export function validateClaimEvaluationStructureV13(value) {
  const descriptors = assertExactFields(value, CLAIM_EVALUATION_FIELDS, 'claim_evaluation');
  value = Object.fromEntries(CLAIM_EVALUATION_FIELDS.map(field => [field, descriptors[field].value]));
  if (value.claim_evaluation_version !== CLAIM_EVALUATION_VERSION || value.claim_evaluation_profile !== CLAIM_EVALUATION_PROFILE || value.claim_evaluation_identity_version !== CLAIM_EVALUATION_IDENTITY_VERSION) fail('claim_evaluation_version_invalid', 'claim evaluation versions/profiles are invalid');
  const request = validateRequest({ claim_type: value.claim_type, claim_profile: value.claim_profile, requested: value.requested, scope_digest: value.scope_digest });
  compareCanonical(value.requested_field_set, request.requested ? FULL_FIELDS[request.claim_profile] : [], 'requested_field_set_invalid', 'requested fields do not match request status and profile');
  compareCanonical(value.supporting_profiles, request.requested ? SUPPORTING_PROFILES : null, 'supporting_profiles_invalid', 'supporting profiles do not match request status');
  if (!Array.isArray(value.field_availability)) fail('field_availability_invalid', 'field availability must be an array');
  exactCanonicalArray(value.authoritative_evidence_identities, 'authoritative_evidence_identities', item => `${item.evidence_kind}:${item.evidence_digest}`, EVIDENCE_IDENTITY_FIELDS);
  for (const item of value.authoritative_evidence_identities) {
    if (typeof item.evidence_kind !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(item.evidence_kind) || !DIGEST.test(item.evidence_digest)) fail('authoritative_evidence_identity_invalid', 'authoritative evidence identity is invalid');
  }
  exactCanonicalArray(value.derived_boundary_identities, 'derived_boundary_identities', item => `${String(['OPENING', 'ENDING_AS_OF'].indexOf(item.boundary_kind)).padStart(2, '0')}:${item.boundary_kind}`, BOUNDARY_IDENTITY_FIELDS);
  for (const item of value.derived_boundary_identities) {
    if (!['OPENING', 'ENDING_AS_OF'].includes(item.boundary_kind)
        || item.boundary_identity_profile !== 'ARTIFACT_CLAIM_EVALUATION_BOUNDARY_IDENTITY_V1'
        || !DIGEST.test(item.boundary_digest)) fail('boundary_identity_invalid', 'derived boundary identity is invalid');
  }
  const projectionExists = ['VERIFIED', 'LIMITED'].includes(value.claim_outcome);
  if ((projectionExists && value.authoritative_evidence_identities.length === 0)
      || (!projectionExists && value.authoritative_evidence_identities.length !== 0)) {
    fail('authoritative_evidence_identity_cardinality', 'authoritative evidence identities do not match the claim outcome');
  }
  const expectedBoundaryKinds = projectionExists && value.claim_type === 'POSITION_EPISODE' ? ['OPENING', 'ENDING_AS_OF'] : [];
  if (canonicalJson(value.derived_boundary_identities.map(item => item.boundary_kind)) !== canonicalJson(expectedBoundaryKinds)) {
    fail('boundary_identity_cardinality', 'derived boundary identities do not match the claim type and outcome');
  }
  exactCanonicalArray(value.field_availability, 'field_availability', item => `${String(FULL_FIELDS[request.claim_profile].indexOf(item.field)).padStart(3, '0')}:${item.field}`, AVAILABILITY_FIELDS);
  for (const item of value.field_availability) if (!FULL_FIELDS[request.claim_profile].includes(item.field) || !FIELD_AVAILABILITY_VALUES.includes(item.availability)) fail('field_availability_invalid', 'field availability entry is invalid');
  const expectedAvailabilityFields = value.claim_outcome === 'VERIFIED'
    || (value.claim_outcome === 'LIMITED' && value.claim_type !== 'WALLET_WINDOW')
    ? FULL_FIELDS[request.claim_profile] : [];
  if (canonicalJson(value.field_availability.map(item => item.field)) !== canonicalJson(expectedAvailabilityFields)) {
    fail('field_availability_noncanonical', 'field availability must be the exact closed profile field set in canonical order');
  }
  exactCanonicalArray(value.established_fields, 'established_fields', item => item.field, ESTABLISHED_FIELDS);
  for (const item of value.established_fields) {
    if (!DIGEST.test(item.value_digest) || item.value_digest !== sha256CanonicalJson({ field: item.field, value: item.value })) fail('established_value_digest_mismatch', 'established field digest is invalid');
    if (!Array.isArray(item.source_references) || item.source_references.some(reference => !DIGEST.test(reference))) fail('established_source_reference_invalid', 'established field source references are invalid');
    if (canonicalJson(item.source_references) !== canonicalJson([...new Set(item.source_references)].sort())) fail('established_source_reference_noncanonical', 'established field source references must be unique and sorted');
  }
  const establishedNames = new Set(value.established_fields.map(item => item.field));
  if (value.claim_outcome === 'VERIFIED') {
    const required = value.claim_type === 'POSITION_EPISODE'
      ? value.field_availability.filter(item => item.availability === 'AVAILABLE').map(item => item.field)
      : FULL_FIELDS[request.claim_profile];
    if (required.some(field => !establishedNames.has(field)) || [...establishedNames].some(field => !required.includes(field))) fail('result_projection_incomplete', 'verified result projection is incomplete or contains non-profile fields');
  } else if (value.claim_outcome === 'LIMITED') {
    const required = LIMITED_RESULT_PROFILE_DEFINITIONS[value.result_profile].required_fields.filter(field => !['field_availability', 'reason_codes'].includes(field));
    const retained = value.claim_type === 'POSITION_EPISODE'
      ? value.field_availability.filter(item => item.availability === 'AVAILABLE').map(item => item.field)
      : [];
    const allowed = [...new Set([...required, ...retained])];
    if (required.some(field => !establishedNames.has(field)) || [...establishedNames].some(field => !allowed.includes(field))) fail('result_projection_incomplete', 'limited result projection is incomplete or contains non-profile fields');
  }
  exactCanonicalArray(value.unresolved_dependencies, 'unresolved_dependencies', item => item.reference_digest, UNRESOLVED_FIELDS);
  for (const item of value.unresolved_dependencies) {
    if (!DIGEST.test(item.reference_digest) || !NON_INTERFERENCE_SOURCE_KINDS.includes(item.source_kind) || !REASON_CODES.includes(item.reason_code)) fail('unresolved_dependency_invalid', 'unresolved dependency entry is invalid');
  }
  if (!Array.isArray(value.non_interference_decisions)) fail('non_interference_decisions_invalid', 'non-interference decisions must be an array');
  exactCanonicalArray(value.non_interference_decisions, 'non_interference_decisions', item => item.unresolved_reference);
  for (const item of value.non_interference_decisions) validateNonInterferenceDecisionStructureV13(item);
  exactCanonicalArray(value.exclusions, 'exclusions', item => item.evidence_digest, EXCLUSION_FIELDS);
  for (const item of value.exclusions) {
    if (!DIGEST.test(item.evidence_digest) || !EXCLUSION_CODES.includes(item.exclusion_code)
        || !/^NI-0[1-6]$/.test(item.non_interference_rule)) fail('exclusion_invalid', 'exclusion entry is invalid');
  }
  const decisionByReference = new Map(value.non_interference_decisions.map(item => [item.unresolved_reference, item]));
  for (const item of value.unresolved_dependencies) if (decisionByReference.get(item.reference_digest)?.decision !== 'CLAIM_AFFECTING') fail('unresolved_decision_mismatch', 'unresolved dependency does not match a claim-affecting decision');
  for (const item of value.exclusions) {
    const decision = decisionByReference.get(item.evidence_digest);
    if (decision?.decision !== 'EXCLUDED_NON_INTERFERING' || decision.exclusion_code !== item.exclusion_code || decision.applied_rule !== item.non_interference_rule) fail('exclusion_decision_mismatch', 'exclusion does not match its non-interference decision');
  }
  if (value.non_interference_decisions.length !== value.unresolved_dependencies.length + value.exclusions.length) fail('decision_cardinality_mismatch', 'every decision must be represented exactly once as unresolved or excluded');
  compareCanonical(value.reason_codes, normalizeReasonCodes(value.reason_codes), 'reason_codes_noncanonical', 'reason codes are not canonical');
  validateClaimCombination({ claim_type: value.claim_type, claim_profile: value.claim_profile, claim_outcome: value.claim_outcome, position_state: value.position_state, requested: value.requested, result_profile: value.result_profile });
  if (!value.requested) {
    for (const field of ['authoritative_evidence_identities', 'derived_boundary_identities', 'field_availability', 'established_fields', 'unresolved_dependencies', 'non_interference_decisions', 'exclusions', 'reason_codes']) if (value[field].length !== 0) fail('not_evaluated_not_status_only', 'unrequested evaluations must be status-only');
  }
  if (value.claim_outcome === 'BLOCKED' && (!value.reason_codes.includes('NO_LIMITED_PROJECTION') || value.field_availability.length !== 0 || value.established_fields.length !== 0)) fail('blocked_result_invalid', 'blocked result must have no projection and include NO_LIMITED_PROJECTION');
  if (value.claim_outcome === 'LIMITED' && (value.reason_codes.length === 0 || value.unresolved_dependencies.length === 0)) fail('limited_result_invalid', 'limited result requires unresolved evidence and reasons');
  if (value.claim_outcome === 'VERIFIED' && (value.reason_codes.length !== 0 || value.unresolved_dependencies.length !== 0)) fail('verified_result_invalid', 'verified result cannot retain claim-affecting unresolved evidence');
  const expectedDigest = sha256CanonicalJson(claimEvaluationDigestPreimage(value));
  if (!DIGEST.test(value.evaluation_digest) || value.evaluation_digest !== expectedDigest || value.evaluation_id !== `${CLAIM_EVALUATION_ID_PREFIX}${expectedDigest}`) fail('claim_evaluation_digest_mismatch', 'claim evaluation identity is invalid');
  return true;
}
export async function validateSourceBoundClaimEvaluationV13(input) {
  const descriptors = safeDescriptors(input, ['evaluation', 'request', 'source'], 'source_bound_claim_evaluation_input');
  validateClaimEvaluationStructureV13(descriptors.evaluation.value);
  const expected = await evaluateClaimOutcomeV13({ request: descriptors.request.value, source: descriptors.source.value });
  if (canonicalJson(expected) !== canonicalJson(descriptors.evaluation.value)) fail('claim_evaluation_source_mismatch', 'claim evaluation does not match authoritative sources');
  return true;
}
