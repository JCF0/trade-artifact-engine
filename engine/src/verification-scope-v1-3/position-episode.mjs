import { types as utilTypes } from 'node:util';

import {
  assertExactFields, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson,
} from './contract.mjs';
import {
  addRational, divideRational, isZeroRational, makeRational, multiplyRational,
  subtractRational, validateRational,
} from './rational.mjs';
import { validateAuthoritativeEvidenceContextStructureV13 } from './authoritative-evidence-context.mjs';
import { projectSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import {
  buildStructuralPositionEconomicEventsV13, validateCanonicalPositionEconomicEventsStructureV13,
} from './position-economic-event.mjs';
import { isSolanaPublicKeyV1 } from '../wallet-acquisition/solana-identities.mjs';

export const POSITION_EPISODE_VERSION_V1_3 = 'artifact_position_episode_v1_3';
export const POSITION_EPISODE_PROFILE_V1_3 = 'ARTIFACT_POSITION_EPISODE_V1';
export const POSITION_ACCOUNTING_PROFILE_V1_3 = 'ARTIFACT_WAC_ACCOUNTING_V1';
export const POSITION_QUOTE_PROFILE_V1_3 = 'ARTIFACT_RAW_QUOTE_V1';
export const POSITION_ECONOMIC_EVIDENCE_PROFILE_V1_3 = 'ARTIFACT_AUTHORITATIVE_POSITION_ECONOMIC_EFFECTS_V1';

const INPUT_FIELDS = ['evidence_context', 'exact_quote_mint', 'economic_evidence_port'];
const BASIS_EVIDENCE_FIELDS = [
  'basis_evidence_profile', 'analyzed_wallet', 'target_mint', 'exact_quote_mint',
  'attributable_basis', 'source_references', 'basis_evidence_digest',
];
const ECONOMIC_EVIDENCE_FIELDS = [
  'economic_evidence_profile', 'evidence_context_digest', 'exact_quote_mint',
  'opening_basis_evidence', 'source_events', 'effect_dispositions', 'economic_evidence_digest',
];
const DISPOSITION_FIELDS = ['effect_id', 'disposition', 'event_locator', 'reason_code'];
const EVENT_LOCATOR_FIELDS = [
  'transaction_signature', 'authoritative_intra_transaction_coordinate', 'event_kind',
];
const ECONOMIC_EVIDENCE_IDENTITY_FIELDS = ['economic_evidence_profile', 'economic_evidence_digest'];
const TOP_FIELDS = [
  'position_episode_version', 'position_episode_profile', 'accounting_profile', 'quote_profile',
  'episode_id', 'position_episode_digest', 'evidence_context_identity', 'economic_evidence_identity',
  'analyzed_wallet', 'target_mint',
  'exact_quote_mint', 'opening_boundary', 'ending_boundary', 'opening_inventory', 'opening_attributable_basis',
  'ordered_admitted_economic_events', 'acquisition_event_ids', 'disposal_event_ids', 'transfer_event_ids',
  'lifecycle_event_ids', 'fee_treatment', 'aggregate_acquisition_basis', 'recognized_disposal_proceeds',
  'realized_basis_consumed', 'realized_pnl', 'realized_return', 'ending_wallet_custody',
  'ending_economic_inventory', 'remaining_attributable_basis', 'position_state',
  'unresolved_economic_dependencies',
];
const CONTEXT_IDENTITY_FIELDS = [
  'evidence_context_profile', 'evidence_context_digest', 'transaction_population_digest',
];
const BOUNDARY_FIELDS = ['slot', 'enumeration_digest', 'aggregate_raw_quantity', 'zero_status'];
const PROJECTED_EVENT_FIELDS = [
  'event_id', 'episode_event_ordinal', 'transaction_identity', 'canonical_transaction_coordinate',
  'authoritative_intra_transaction_coordinate', 'event_kind', 'payload', 'source_effect_ids',
  'corroborating_effect_ids', 'dependency_references', 'dependency_codes', 'economic_inventory_before',
  'basis_before', 'acquisition_basis_added', 'basis_consumed', 'recognized_proceeds', 'realized_pnl',
  'economic_inventory_after', 'basis_after', 'genuine_economic_zero_after',
];
const DEPENDENCY_FIELDS = ['dependency_code', 'dependency_references', 'event_ids'];
const FEE_TREATMENT_FIELDS = [
  'fee_event_id', 'denomination_kind', 'denomination_mint', 'raw_fee_amount', 'allocation_status',
  'attributed_event_id', 'enters_quote_economics',
];
const DIGEST = /^[0-9a-f]{64}$/;
const EFFECT_ID = /^(?:effect|residual)-[0-9a-f]{64}$/;
const RAW = /^(?:0|[1-9][0-9]*)$/;
const ZERO = makeRational('0');
const ECONOMIC_EVIDENCE_PORTS = new WeakSet();

function rationalOrNull(value) { if (value !== null) validateRational(value); }
function raw(value, field) {
  if (typeof value !== 'string' || !RAW.test(value)) fail('invalid_raw_quantity', `${field} is invalid`);
}
function withoutDigest(value, digestField) {
  const result = {};
  for (const [key, item] of Object.entries(value)) if (key !== digestField) result[key] = item;
  return result;
}
function validateEconomicEvidenceCapability(capability) {
  try {
    if (capability === null || typeof capability !== 'object' || Array.isArray(capability)
        || utilTypes.isProxy(capability) || Object.getPrototypeOf(capability) !== Object.prototype
        || Object.getOwnPropertySymbols(capability).length !== 0) {
      fail('position_economic_evidence_capability_denied', 'position economic evidence capability is unavailable');
    }
    const descriptors = Object.getOwnPropertyDescriptors(capability);
    if (Object.keys(descriptors).length !== 1) {
      fail('position_economic_evidence_capability_denied', 'position economic evidence capability shape is invalid');
    }
    const descriptor = descriptors.captureAuthoritativePositionEconomicsV13;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      fail('position_economic_evidence_capability_denied', 'position economic evidence capability method is invalid');
    }
    return descriptor.value.bind(capability);
  } catch (error) {
    if (error?.code === 'position_economic_evidence_capability_denied') throw error;
    fail('position_economic_evidence_capability_denied', 'position economic evidence capability is unavailable');
  }
}
export function createPositionEconomicEvidencePortV13(capability) {
  const capture = validateEconomicEvidenceCapability(capability);
  const port = Object.freeze({
    async captureAuthoritativePositionEconomicsV13(request) {
      let response;
      try {
        response = await capture(cloneAndFreeze(request));
      } catch {
        fail('position_economic_evidence_capability_failed', 'position economic evidence capability failed');
      }
      try { return cloneAndFreeze(response); }
      catch { fail('position_economic_evidence_response_invalid', 'position economic evidence response is unsafe'); }
    },
  });
  ECONOMIC_EVIDENCE_PORTS.add(port);
  return port;
}
function validateOpeningBasisEvidenceStructure(evidence, context, exactQuoteMint) {
  assertExactFields(evidence, BASIS_EVIDENCE_FIELDS, 'opening_basis_evidence');
  if (evidence.basis_evidence_profile !== 'ARTIFACT_OPENING_BASIS_EVIDENCE_V1'
      || evidence.analyzed_wallet !== context.analyzed_wallet || evidence.target_mint !== context.target_mint
      || evidence.exact_quote_mint !== exactQuoteMint || !Array.isArray(evidence.source_references)
      || evidence.source_references.length === 0
      || evidence.source_references.some(item => typeof item !== 'string' || !DIGEST.test(item))
      || new Set(evidence.source_references).size !== evidence.source_references.length
      || evidence.source_references.some((item, index) => index > 0 && evidence.source_references[index - 1] >= item)) {
    fail('opening_basis_source_mismatch', 'opening basis evidence scope or references are invalid');
  }
  validateRational(evidence.attributable_basis);
  if (evidence.attributable_basis.numerator.startsWith('-')) fail('negative_opening_basis', 'opening basis cannot be negative');
  const expected = sha256CanonicalJson(withoutDigest(evidence, 'basis_evidence_digest'));
  if (evidence.basis_evidence_digest !== expected) fail('opening_basis_digest_mismatch', 'opening basis digest does not bind the supplied basis');
}
function eventLocator(source) {
  return {
    transaction_signature: source.transaction_signature,
    authoritative_intra_transaction_coordinate: source.authoritative_intra_transaction_coordinate,
    event_kind: source.event_kind,
  };
}
function validateEconomicEvidence(evidence, { context, exactQuoteMint, transactions }) {
  assertExactFields(evidence, ECONOMIC_EVIDENCE_FIELDS, 'position_economic_evidence');
  if (evidence.economic_evidence_profile !== POSITION_ECONOMIC_EVIDENCE_PROFILE_V1_3
      || evidence.evidence_context_digest !== context.evidence_context_digest
      || evidence.exact_quote_mint !== exactQuoteMint || !Array.isArray(evidence.source_events)
      || !Array.isArray(evidence.effect_dispositions)) {
    fail('position_economic_evidence_scope_mismatch', 'position economic evidence does not match the request');
  }
  const expectedDigest = sha256CanonicalJson(withoutDigest(evidence, 'economic_evidence_digest'));
  if (evidence.economic_evidence_digest !== expectedDigest) {
    fail('position_economic_evidence_digest_mismatch', 'position economic evidence digest is invalid');
  }
  if (evidence.opening_basis_evidence !== null) {
    validateOpeningBasisEvidenceStructure(evidence.opening_basis_evidence, context, exactQuoteMint);
  }
  const allEffectIds = transactions.flatMap(transaction => transaction.effect_ids).sort();
  if (new Set(allEffectIds).size !== allEffectIds.length
      || evidence.effect_dispositions.length !== allEffectIds.length) {
    fail('incomplete_effect_disposition', 'every authoritative effect requires exactly one disposition');
  }
  const expectedRoles = new Map();
  for (const source of evidence.source_events) {
    const locator = eventLocator(source);
    for (const [field, disposition] of [['source_effect_ids', 'PRIMARY'], ['corroborating_effect_ids', 'CORROBORATING']]) {
      if (!Array.isArray(source[field])) fail('position_economic_evidence_response_invalid', `${field} must be an array`);
      for (const effectId of source[field]) {
        if (expectedRoles.has(effectId)) fail('duplicate_effect_disposition', 'one effect cannot support multiple economic event roles');
        expectedRoles.set(effectId, { disposition, event_locator: locator, reason_code: null });
      }
    }
  }
  evidence.effect_dispositions.forEach((item, index) => {
    assertExactFields(item, DISPOSITION_FIELDS, `effect_dispositions.${index}`);
    if (item.effect_id !== allEffectIds[index] || !EFFECT_ID.test(item.effect_id)) {
      fail('noncanonical_effect_disposition', 'effect dispositions must exhaust the canonical effect population');
    }
    const expectedRole = expectedRoles.get(item.effect_id);
    if (expectedRole === undefined) {
      if (item.disposition !== 'NON_ECONOMIC' || item.event_locator !== null
          || item.reason_code !== 'NO_POSITION_ECONOMIC_EFFECT') {
        fail('incomplete_effect_disposition', 'unused effects require an explicit non-economic disposition');
      }
      return;
    }
    assertExactFields(item.event_locator, EVENT_LOCATOR_FIELDS, `effect_dispositions.${index}.event_locator`);
    if (item.disposition !== expectedRole.disposition || item.reason_code !== null
        || canonicalJson(item.event_locator) !== canonicalJson(expectedRole.event_locator)) {
      fail('effect_disposition_mismatch', 'effect disposition does not match its economic event role');
    }
  });
}
function episodeDigestPreimage(value) {
  const result = {};
  for (const field of TOP_FIELDS) if (!['episode_id', 'position_episode_digest'].includes(field)) result[field] = value[field];
  return result;
}
function boundary(snapshot) {
  return {
    slot: snapshot.boundary.slot,
    enumeration_digest: snapshot.enumeration_digest,
    aggregate_raw_quantity: snapshot.aggregate_raw_quantity,
    zero_status: snapshot.zero_status,
  };
}
function eventTransactions(context) {
  return [...context.transaction_population.transactions]
    .sort((left, right) => left.canonical_transaction_coordinate - right.canonical_transaction_coordinate)
    .map(item => {
      const effect = projectSolanaFullTransactionEffectV13({
        wallet: context.analyzed_wallet,
        transaction: item.full_transaction,
      });
      return {
        transaction_identity: effect.transaction_identity,
        canonical_transaction_coordinate: item.canonical_transaction_coordinate,
        finalized_execution_status: effect.finalized_execution_status,
        effect_ids: [
          ...effect.established_effects.map(value => value.effect_id),
          ...effect.residual_unresolved_effects.map(value => value.residual_id),
        ].sort(),
      };
    });
}
function validateOpeningBasis(context, evidence, exactQuoteMint) {
  const quantity = BigInt(context.opening_snapshot.aggregate_raw_quantity);
  if (quantity === 0n) {
    if (evidence !== null) fail('opening_basis_evidence_unexpected', 'opening zero cannot accept caller basis evidence');
    return { basis: ZERO, dependency: null };
  }
  if (evidence === null) {
    return {
      basis: null,
      dependency: {
        dependency_code: 'OPENING_BASIS_UNRESOLVED',
        dependency_references: [context.opening_basis_reference.basis_evidence_digest],
        event_ids: [],
      },
    };
  }
  validateOpeningBasisEvidenceStructure(evidence, context, exactQuoteMint);
  if (evidence.basis_evidence_profile !== context.opening_basis_reference.basis_evidence_profile
      || evidence.basis_evidence_digest !== context.opening_basis_reference.basis_evidence_digest) {
    fail('opening_basis_source_mismatch', 'opening basis evidence does not match the bound reference');
  }
  return { basis: evidence.attributable_basis, dependency: null };
}
function dependencyKey(value) { return canonicalJson(value); }
function addDependency(map, dependencyCode, references, eventIds) {
  const value = {
    dependency_code: dependencyCode,
    dependency_references: [...new Set(references)].sort(),
    event_ids: [...new Set(eventIds)].sort(),
  };
  map.set(dependencyKey(value), value);
}
function addNullable(left, right) { return left === null || right === null ? null : addRational(left, right); }
function projectedEvent(event, state, values) {
  return {
    ...event,
    economic_inventory_before: state.inventoryKnown ? state.inventory.toString() : null,
    basis_before: state.basis,
    acquisition_basis_added: values.acquisitionBasis,
    basis_consumed: values.basisConsumed,
    recognized_proceeds: values.proceeds,
    realized_pnl: values.pnl,
    economic_inventory_after: values.inventoryKnown ? values.inventory.toString() : null,
    basis_after: values.basis,
    genuine_economic_zero_after: values.genuineZero,
  };
}
function validateBuildInput(input, fields = INPUT_FIELDS) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length !== 0) {
    fail('position_episode_input_invalid', 'position episode input must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Object.keys(descriptors)) if (!fields.includes(key)) fail('unknown_field', 'position_episode_input contains unknown field');
  for (const field of fields) {
    if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')) {
      fail('missing_field', `position_episode_input is missing ${field}`);
    }
  }
  return descriptors;
}

export async function buildPositionEpisodeV13(input) {
  validateBuildInput(input);
  validateAuthoritativeEvidenceContextStructureV13(input.evidence_context);
  if (!isSolanaPublicKeyV1(input.exact_quote_mint)) {
    fail('invalid_quote_mint', 'exact quote mint is invalid');
  }
  const context = input.evidence_context;
  if (!ECONOMIC_EVIDENCE_PORTS.has(input.economic_evidence_port)) {
    fail('position_economic_evidence_capability_denied', 'registered position economic evidence port is required');
  }
  const transactions = eventTransactions(context);
  const evidence = await input.economic_evidence_port.captureAuthoritativePositionEconomicsV13({
    economic_evidence_profile: POSITION_ECONOMIC_EVIDENCE_PROFILE_V1_3,
    evidence_context_digest: context.evidence_context_digest,
    analyzed_wallet: context.analyzed_wallet,
    target_mint: context.target_mint,
    exact_quote_mint: input.exact_quote_mint,
  });
  validateEconomicEvidence(evidence, { context, exactQuoteMint: input.exact_quote_mint, transactions });
  const canonicalEvents = buildStructuralPositionEconomicEventsV13({
    transactions,
    source_events: evidence.source_events,
  });
  const opening = validateOpeningBasis(context, evidence.opening_basis_evidence, input.exact_quote_mint);
  const dependencies = new Map();
  if (opening.dependency !== null) dependencies.set(dependencyKey(opening.dependency), opening.dependency);
  for (const event of canonicalEvents.events) {
    event.dependency_codes.forEach(code => addDependency(dependencies, code, event.dependency_references, [event.event_id]));
  }

  const feesByTarget = new Map();
  const feeTreatment = [];
  let sharedQuoteFee = false;
  for (const fee of canonicalEvents.events.filter(event => event.event_kind === 'FEE')) {
    const entersQuote = fee.payload.denomination_kind === 'TOKEN_MINT'
      && fee.payload.denomination_mint === input.exact_quote_mint
      && ['ACQUISITION', 'DISPOSAL'].includes(fee.payload.allocation_status);
    feeTreatment.push({
      fee_event_id: fee.event_id,
      denomination_kind: fee.payload.denomination_kind,
      denomination_mint: fee.payload.denomination_mint,
      raw_fee_amount: fee.payload.raw_fee_amount,
      allocation_status: fee.payload.allocation_status,
      attributed_event_id: fee.payload.attributed_event_id,
      enters_quote_economics: entersQuote,
    });
    if (entersQuote) {
      const prior = feesByTarget.get(fee.payload.attributed_event_id) ?? ZERO;
      feesByTarget.set(fee.payload.attributed_event_id, addRational(prior, makeRational(fee.payload.raw_fee_amount)));
    }
    if (fee.payload.allocation_status === 'UNALLOCATED_SHARED'
        && fee.payload.denomination_kind === 'TOKEN_MINT'
        && fee.payload.denomination_mint === input.exact_quote_mint) sharedQuoteFee = true;
  }

  const state = {
    inventory: BigInt(context.opening_snapshot.aggregate_raw_quantity),
    inventoryKnown: true,
    custody: BigInt(context.opening_snapshot.aggregate_raw_quantity),
    basis: opening.basis,
  };
  const openingBasis = state.basis;
  let aggregateAcquisitionBasis = ZERO;
  let aggregateProceeds = ZERO;
  let aggregateBasisConsumed = ZERO;
  let disposalOccurred = false;
  let historicalBasisUnresolved = false;
  let historicalProceedsUnresolved = false;
  let mixedQuote = false;
  const projected = [];
  const lastInventoryEventOrdinalByTransaction = new Map();
  for (const event of canonicalEvents.events) {
    if (['TARGET_ACQUISITION', 'TARGET_DISPOSAL', 'TARGET_TRANSFER_IN', 'TARGET_TRANSFER_OUT'].includes(event.event_kind)) {
      lastInventoryEventOrdinalByTransaction.set(
        event.canonical_transaction_coordinate,
        event.episode_event_ordinal,
      );
    }
  }

  for (const event of canonicalEvents.events) {
    const before = { ...state };
    let acquisitionBasis = ZERO;
    let basisConsumed = ZERO;
    let proceeds = ZERO;
    let pnl = ZERO;
    let genuineZero = false;
    const quantity = ['TARGET_ACQUISITION', 'TARGET_DISPOSAL', 'TARGET_TRANSFER_IN', 'TARGET_TRANSFER_OUT'].includes(event.event_kind)
      ? BigInt(event.payload.target_raw_quantity) : 0n;

    if (event.event_kind === 'TARGET_ACQUISITION') {
      state.inventory += quantity;
      state.custody += quantity;
      if (event.payload.quote_status === 'EXACT' && event.payload.quote_mint === input.exact_quote_mint && !sharedQuoteFee) {
        acquisitionBasis = addRational(makeRational(event.payload.quote_raw_amount), feesByTarget.get(event.event_id) ?? ZERO);
        if (state.basis !== null) state.basis = addRational(state.basis, acquisitionBasis);
      } else {
        if (event.payload.quote_status === 'EXACT') mixedQuote = true;
        state.basis = null;
        acquisitionBasis = null;
      }
      aggregateAcquisitionBasis = addNullable(aggregateAcquisitionBasis, acquisitionBasis);
    } else if (event.event_kind === 'TARGET_TRANSFER_IN') {
      state.inventory += quantity;
      state.custody += quantity;
      if (event.payload.basis_status === 'KNOWN' && state.basis !== null) {
        state.basis = addRational(state.basis, event.payload.attributable_basis);
      } else state.basis = null;
    } else if (event.event_kind === 'TARGET_DISPOSAL') {
      disposalOccurred = true;
      if (state.inventoryKnown && state.inventory < quantity) {
        fail('OVERSOLD_ESTABLISHED_INVENTORY', 'disposal exceeds established economic inventory');
      }
      if (state.custody < quantity) fail('ending_inventory_mismatch', 'disposal exceeds established wallet custody');
      state.custody -= quantity;
      if (state.inventoryKnown) state.inventory -= quantity;
      if (event.payload.quote_status === 'EXACT' && event.payload.quote_mint === input.exact_quote_mint && !sharedQuoteFee) {
        proceeds = subtractRational(makeRational(event.payload.quote_raw_amount), feesByTarget.get(event.event_id) ?? ZERO);
      } else {
        if (event.payload.quote_status === 'EXACT') mixedQuote = true;
        proceeds = null;
        historicalProceedsUnresolved = true;
      }
      if (before.inventoryKnown && before.basis !== null) {
        const wac = divideRational(before.basis, makeRational(before.inventory.toString()));
        basisConsumed = multiplyRational(wac, makeRational(quantity.toString()));
        state.basis = subtractRational(before.basis, basisConsumed);
      } else {
        basisConsumed = null;
        state.basis = null;
        historicalBasisUnresolved = true;
      }
      aggregateBasisConsumed = addNullable(aggregateBasisConsumed, basisConsumed);
      aggregateProceeds = addNullable(aggregateProceeds, proceeds);
      pnl = basisConsumed === null || proceeds === null ? null : subtractRational(proceeds, basisConsumed);
      if (state.inventoryKnown && state.inventory === 0n
          && lastInventoryEventOrdinalByTransaction.get(event.canonical_transaction_coordinate)
            === event.episode_event_ordinal) {
        state.basis = ZERO;
        genuineZero = true;
      }
    } else if (event.event_kind === 'TARGET_TRANSFER_OUT') {
      if (state.custody < quantity) fail('ending_inventory_mismatch', 'transfer-out exceeds established wallet custody');
      state.custody -= quantity;
      if (event.payload.external_continuation_status === 'UNRESOLVED') {
        state.inventoryKnown = false;
        state.basis = null;
      }
    }
    projected.push(projectedEvent(event, before, {
      acquisitionBasis, basisConsumed, proceeds, pnl,
      inventory: state.inventory, inventoryKnown: state.inventoryKnown, basis: state.basis, genuineZero,
    }));
  }

  if (state.custody.toString() !== context.ending_snapshot.aggregate_raw_quantity) {
    fail('ending_inventory_mismatch', 'economic events do not reconcile authoritative ending wallet custody');
  }
  if (mixedQuote) {
    const mixedEventIds = canonicalEvents.events.filter(event => ['TARGET_ACQUISITION', 'TARGET_DISPOSAL'].includes(event.event_kind)
      && event.payload.quote_status === 'EXACT' && event.payload.quote_mint !== input.exact_quote_mint).map(event => event.event_id);
    addDependency(dependencies, 'MIXED_QUOTE_UNSUPPORTED', [], mixedEventIds);
    aggregateAcquisitionBasis = null;
    aggregateProceeds = null;
    aggregateBasisConsumed = historicalBasisUnresolved ? null : aggregateBasisConsumed;
  }
  if (sharedQuoteFee) {
    aggregateAcquisitionBasis = null;
    aggregateProceeds = null;
    state.basis = state.inventoryKnown && state.inventory === 0n ? ZERO : null;
  }
  if (historicalBasisUnresolved) aggregateBasisConsumed = null;
  if (historicalProceedsUnresolved) aggregateProceeds = null;
  const realizedPnl = aggregateBasisConsumed === null || aggregateProceeds === null
    ? null : subtractRational(aggregateProceeds, aggregateBasisConsumed);
  const realizedReturn = realizedPnl === null || aggregateBasisConsumed === null
    ? null : isZeroRational(aggregateBasisConsumed)
      ? 'UNDEFINED_ZERO_BASIS' : divideRational(realizedPnl, aggregateBasisConsumed);
  const positionState = !state.inventoryKnown ? null : state.inventory === 0n ? 'CLOSED'
    : disposalOccurred ? 'OPEN_REALIZED_PARTIAL' : 'OPEN';

  const value = {
    position_episode_version: POSITION_EPISODE_VERSION_V1_3,
    position_episode_profile: POSITION_EPISODE_PROFILE_V1_3,
    accounting_profile: POSITION_ACCOUNTING_PROFILE_V1_3,
    quote_profile: POSITION_QUOTE_PROFILE_V1_3,
    episode_id: null,
    position_episode_digest: null,
    evidence_context_identity: {
      evidence_context_profile: context.evidence_context_profile,
      evidence_context_digest: context.evidence_context_digest,
      transaction_population_digest: context.transaction_population.population_evidence_digest,
    },
    economic_evidence_identity: {
      economic_evidence_profile: evidence.economic_evidence_profile,
      economic_evidence_digest: evidence.economic_evidence_digest,
    },
    analyzed_wallet: context.analyzed_wallet,
    target_mint: context.target_mint,
    exact_quote_mint: input.exact_quote_mint,
    opening_boundary: boundary(context.opening_snapshot),
    ending_boundary: boundary(context.ending_snapshot),
    opening_inventory: context.opening_snapshot.aggregate_raw_quantity,
    opening_attributable_basis: openingBasis,
    ordered_admitted_economic_events: projected,
    acquisition_event_ids: canonicalEvents.events.filter(event => event.event_kind === 'TARGET_ACQUISITION').map(event => event.event_id),
    disposal_event_ids: canonicalEvents.events.filter(event => event.event_kind === 'TARGET_DISPOSAL').map(event => event.event_id),
    transfer_event_ids: canonicalEvents.events.filter(event => ['TARGET_TRANSFER_IN', 'TARGET_TRANSFER_OUT'].includes(event.event_kind)).map(event => event.event_id),
    lifecycle_event_ids: canonicalEvents.events.filter(event => event.event_kind === 'TARGET_ACCOUNT_LIFECYCLE').map(event => event.event_id),
    fee_treatment: feeTreatment,
    aggregate_acquisition_basis: aggregateAcquisitionBasis,
    recognized_disposal_proceeds: aggregateProceeds,
    realized_basis_consumed: aggregateBasisConsumed,
    realized_pnl: realizedPnl,
    realized_return: realizedReturn,
    ending_wallet_custody: state.custody.toString(),
    ending_economic_inventory: state.inventoryKnown ? state.inventory.toString() : null,
    remaining_attributable_basis: state.basis,
    position_state: positionState,
    unresolved_economic_dependencies: [...dependencies.values()].sort((left, right) => dependencyKey(left) < dependencyKey(right) ? -1 : 1),
  };
  value.position_episode_digest = sha256CanonicalJson(episodeDigestPreimage(value));
  value.episode_id = `position-episode-${value.position_episode_digest}`;
  const result = cloneAndFreeze(value);
  validatePositionEpisodeStructureV13(result);
  return result;
}

export function validatePositionEpisodeStructureV13(value) {
  assertExactFields(value, TOP_FIELDS, 'position_episode');
  if (value.position_episode_version !== POSITION_EPISODE_VERSION_V1_3
      || value.position_episode_profile !== POSITION_EPISODE_PROFILE_V1_3
      || value.accounting_profile !== POSITION_ACCOUNTING_PROFILE_V1_3
      || value.quote_profile !== POSITION_QUOTE_PROFILE_V1_3) {
    fail('unsupported_position_episode_version', 'position episode profile is unsupported');
  }
  assertExactFields(value.evidence_context_identity, CONTEXT_IDENTITY_FIELDS, 'evidence_context_identity');
  assertExactFields(value.economic_evidence_identity, ECONOMIC_EVIDENCE_IDENTITY_FIELDS, 'economic_evidence_identity');
  if (value.economic_evidence_identity.economic_evidence_profile !== POSITION_ECONOMIC_EVIDENCE_PROFILE_V1_3
      || !DIGEST.test(value.economic_evidence_identity.economic_evidence_digest)) {
    fail('invalid_position_economic_evidence_identity', 'position economic evidence identity is invalid');
  }
  for (const boundaryValue of [value.opening_boundary, value.ending_boundary]) {
    assertExactFields(boundaryValue, BOUNDARY_FIELDS, 'position_boundary');
    raw(boundaryValue.aggregate_raw_quantity, 'position_boundary.aggregate_raw_quantity');
  }
  raw(value.opening_inventory, 'opening_inventory');
  raw(value.ending_wallet_custody, 'ending_wallet_custody');
  if (value.ending_economic_inventory !== null) raw(value.ending_economic_inventory, 'ending_economic_inventory');
  for (const field of ['opening_attributable_basis', 'aggregate_acquisition_basis', 'recognized_disposal_proceeds',
    'realized_basis_consumed', 'realized_pnl', 'remaining_attributable_basis']) rationalOrNull(value[field]);
  if (value.realized_return !== null && value.realized_return !== 'UNDEFINED_ZERO_BASIS') validateRational(value.realized_return);
  if (![null, 'CLOSED', 'OPEN_REALIZED_PARTIAL', 'OPEN'].includes(value.position_state)) fail('invalid_position_state', 'position state is invalid');
  if (!Array.isArray(value.ordered_admitted_economic_events)) fail('invalid_economic_event_collection', 'projected events must be an array');
  const canonicalCore = {
    position_economic_event_version: 'artifact_position_economic_event_v1_3',
    events: value.ordered_admitted_economic_events.map((event, index) => {
      assertExactFields(event, PROJECTED_EVENT_FIELDS, `ordered_admitted_economic_events.${index}`);
      rationalOrNull(event.basis_before); rationalOrNull(event.acquisition_basis_added);
      rationalOrNull(event.basis_consumed); rationalOrNull(event.recognized_proceeds);
      rationalOrNull(event.realized_pnl); rationalOrNull(event.basis_after);
      if (event.economic_inventory_before !== null) raw(event.economic_inventory_before, 'economic_inventory_before');
      if (event.economic_inventory_after !== null) raw(event.economic_inventory_after, 'economic_inventory_after');
      if (typeof event.genuine_economic_zero_after !== 'boolean') fail('invalid_economic_zero_marker', 'economic zero marker must be boolean');
      const core = {};
      for (const field of PROJECTED_EVENT_FIELDS.slice(0, 11)) core[field] = event[field];
      return core;
    }),
  };
  validateCanonicalPositionEconomicEventsStructureV13(canonicalCore);
  for (const field of ['acquisition_event_ids', 'disposal_event_ids', 'transfer_event_ids', 'lifecycle_event_ids']) {
    if (!Array.isArray(value[field])) fail('invalid_event_index', `${field} must be an array`);
  }
  if (!Array.isArray(value.fee_treatment)) fail('invalid_fee_treatment', 'fee treatment must be an array');
  value.fee_treatment.forEach((item, index) => assertExactFields(item, FEE_TREATMENT_FIELDS, `fee_treatment.${index}`));
  if (!Array.isArray(value.unresolved_economic_dependencies)) fail('invalid_dependency_set', 'dependencies must be an array');
  value.unresolved_economic_dependencies.forEach((item, index) => assertExactFields(item, DEPENDENCY_FIELDS, `unresolved_economic_dependencies.${index}`));
  const expectedDigest = sha256CanonicalJson(episodeDigestPreimage(value));
  if (!DIGEST.test(value.position_episode_digest) || value.position_episode_digest !== expectedDigest
      || value.episode_id !== `position-episode-${expectedDigest}`) {
    fail('position_episode_digest_mismatch', 'position episode identity does not match its projection');
  }
  return true;
}

export async function validateSourceBoundPositionEpisodeV13(input) {
  validateBuildInput(input, ['episode', ...INPUT_FIELDS]);
  const expected = await buildPositionEpisodeV13({
    evidence_context: input.evidence_context,
    exact_quote_mint: input.exact_quote_mint,
    economic_evidence_port: input.economic_evidence_port,
  });
  if (canonicalJson(expected) !== canonicalJson(input.episode)) {
    fail('position_episode_source_mismatch', 'position episode does not match authoritative dependencies');
  }
  return true;
}
