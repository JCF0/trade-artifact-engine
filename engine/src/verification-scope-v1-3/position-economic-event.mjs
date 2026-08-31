import {
  assertExactFields, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson,
} from './contract.mjs';
import { compareRational, makeRational, validateRational } from './rational.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from '../wallet-acquisition/solana-identities.mjs';

export const POSITION_ECONOMIC_EVENT_VERSION_V1_3 = 'artifact_position_economic_event_v1_3';
export const POSITION_ECONOMIC_EVENT_IDENTITY_PROFILE_V1_3 = 'ARTIFACT_POSITION_ECONOMIC_EVENT_ID_V1';
export const POSITION_ECONOMIC_EVENT_KINDS_V1_3 = Object.freeze([
  'TARGET_ACQUISITION',
  'TARGET_DISPOSAL',
  'TARGET_TRANSFER_IN',
  'TARGET_TRANSFER_OUT',
  'FEE',
  'TARGET_ACCOUNT_LIFECYCLE',
]);

const INPUT_FIELDS = ['transactions', 'source_events'];
const TRANSACTION_FIELDS = [
  'transaction_identity', 'canonical_transaction_coordinate', 'finalized_execution_status', 'effect_ids',
];
const TRANSACTION_IDENTITY_FIELDS = ['signature', 'slot', 'block_time', 'transaction_version'];
const SOURCE_EVENT_FIELDS = [
  'transaction_signature', 'authoritative_intra_transaction_coordinate', 'event_kind', 'payload',
  'source_effect_ids', 'corroborating_effect_ids', 'dependency_references',
];
const TOP_FIELDS = ['position_economic_event_version', 'events'];
const EVENT_FIELDS = [
  'event_id', 'episode_event_ordinal', 'transaction_identity', 'canonical_transaction_coordinate',
  'authoritative_intra_transaction_coordinate', 'event_kind', 'payload', 'source_effect_ids',
  'corroborating_effect_ids', 'dependency_references', 'dependency_codes',
];
const TRADE_PAYLOAD_FIELDS = ['target_raw_quantity', 'quote_status', 'quote_mint', 'quote_raw_amount'];
const TRANSFER_IN_PAYLOAD_FIELDS = ['target_raw_quantity', 'basis_status', 'attributable_basis'];
const TRANSFER_OUT_PAYLOAD_FIELDS = ['target_raw_quantity', 'external_continuation_status'];
const FEE_SOURCE_PAYLOAD_FIELDS = [
  'denomination_kind', 'denomination_mint', 'raw_fee_amount', 'allocation_status', 'attributed_event_locator',
];
const FEE_EVENT_PAYLOAD_FIELDS = [
  'denomination_kind', 'denomination_mint', 'raw_fee_amount', 'allocation_status', 'attributed_event_id',
];
const LOCATOR_FIELDS = [
  'transaction_signature', 'authoritative_intra_transaction_coordinate', 'event_kind',
];
const LIFECYCLE_PAYLOAD_FIELDS = ['lifecycle_action', 'account'];
const RAW_NONNEGATIVE = /^(?:0|[1-9][0-9]*)$/;
const EFFECT_ID = /^(?:effect|residual)-[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

function safeNonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function identifier(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    fail('invalid_identifier', `${field} must be a bounded identifier`);
  }
}
function publicKey(value, field) {
  if (!isSolanaPublicKeyV1(value)) fail('invalid_solana_identity', `${field} is invalid`);
}
function raw(value, field, { positive = false } = {}) {
  if (typeof value !== 'string' || value.length > 20 || !RAW_NONNEGATIVE.test(value)
      || BigInt(value) > MAX_U64 || (positive && value === '0')) {
    fail('invalid_raw_quantity', `${field} must be a canonical raw integer`);
  }
}
function transactionIdentity(value, context) {
  assertExactFields(value, TRANSACTION_IDENTITY_FIELDS, context);
  if (!isSolanaSignatureV1(value.signature)) fail('invalid_transaction_identity', `${context}.signature is invalid`);
  if (!safeNonnegative(value.slot) || !safeNonnegative(value.block_time)
      || !['legacy', 0].includes(value.transaction_version)) {
    fail('invalid_transaction_identity', `${context} is invalid`);
  }
}
function sortedUnique(value, field, pattern) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !pattern.test(item))) {
    fail('invalid_reference_set', `${field} is invalid`);
  }
  if (new Set(value).size !== value.length || value.some((item, index) => index > 0 && value[index - 1] >= item)) {
    fail('noncanonical_reference_set', `${field} must be sorted and unique`);
  }
}
function dependencyCodes(eventKind, payload) {
  if (['TARGET_ACQUISITION', 'TARGET_DISPOSAL'].includes(eventKind)
      && payload.quote_status === 'UNRESOLVED') return ['QUOTE_CONTEXT_UNRESOLVED'];
  if (eventKind === 'TARGET_TRANSFER_IN' && payload.basis_status === 'UNKNOWN') {
    return ['TRANSFER_IN_BASIS_UNRESOLVED'];
  }
  if (eventKind === 'TARGET_TRANSFER_OUT' && payload.external_continuation_status === 'UNRESOLVED') {
    return ['TARGET_TRANSFER_EXTERNAL_CONTINUATION'];
  }
  if (eventKind === 'FEE' && payload.allocation_status === 'UNALLOCATED_SHARED') {
    return ['SHARED_EFFECT_ALLOCATION_UNRESOLVED'];
  }
  return [];
}
function validateDependencyReferences(references, codes, context) {
  sortedUnique(references, `${context}.dependency_references`, DIGEST);
  if ((codes.length === 0) !== (references.length === 0)) {
    fail('dependency_reference_mismatch', `${context} dependency references do not match unresolved semantics`);
  }
}
function validateLocator(value, context) {
  assertExactFields(value, LOCATOR_FIELDS, context);
  identifier(value.transaction_signature, `${context}.transaction_signature`);
  if (!safeNonnegative(value.authoritative_intra_transaction_coordinate)
      || !['TARGET_ACQUISITION', 'TARGET_DISPOSAL'].includes(value.event_kind)) {
    fail('invalid_fee_attribution', `${context} is invalid`);
  }
}
function validateSourcePayload(kind, payload, context) {
  if (['TARGET_ACQUISITION', 'TARGET_DISPOSAL'].includes(kind)) {
    assertExactFields(payload, TRADE_PAYLOAD_FIELDS, context);
    raw(payload.target_raw_quantity, `${context}.target_raw_quantity`, { positive: true });
    if (!['EXACT', 'UNRESOLVED'].includes(payload.quote_status)) fail('invalid_quote_status', `${context}.quote_status is invalid`);
    if (payload.quote_status === 'EXACT') {
      publicKey(payload.quote_mint, `${context}.quote_mint`);
      raw(payload.quote_raw_amount, `${context}.quote_raw_amount`);
    } else if (payload.quote_mint !== null || payload.quote_raw_amount !== null) {
      fail('invalid_quote_status', `${context} unresolved quote must not contain an amount or mint`);
    }
  } else if (kind === 'TARGET_TRANSFER_IN') {
    assertExactFields(payload, TRANSFER_IN_PAYLOAD_FIELDS, context);
    raw(payload.target_raw_quantity, `${context}.target_raw_quantity`, { positive: true });
    if (!['KNOWN', 'UNKNOWN'].includes(payload.basis_status)) fail('invalid_basis_status', `${context}.basis_status is invalid`);
    if (payload.basis_status === 'KNOWN') {
      validateRational(payload.attributable_basis);
      if (compareRational(payload.attributable_basis, makeRational('0')) < 0) {
        fail('negative_transfer_basis', `${context}.attributable_basis cannot be negative`);
      }
    }
    else if (payload.attributable_basis !== null) fail('invalid_basis_status', `${context} unknown basis must be null`);
  } else if (kind === 'TARGET_TRANSFER_OUT') {
    assertExactFields(payload, TRANSFER_OUT_PAYLOAD_FIELDS, context);
    raw(payload.target_raw_quantity, `${context}.target_raw_quantity`, { positive: true });
    if (!['CONTINUING', 'UNRESOLVED'].includes(payload.external_continuation_status)) {
      fail('invalid_external_continuation', `${context}.external_continuation_status is invalid`);
    }
  } else if (kind === 'FEE') {
    assertExactFields(payload, FEE_SOURCE_PAYLOAD_FIELDS, context);
    if (!['TOKEN_MINT', 'NATIVE_SOL'].includes(payload.denomination_kind)) fail('invalid_fee_denomination', `${context} denomination is invalid`);
    if (payload.denomination_kind === 'TOKEN_MINT') publicKey(payload.denomination_mint, `${context}.denomination_mint`);
    else if (payload.denomination_mint !== null) fail('invalid_fee_denomination', `${context} native fee mint must be null`);
    raw(payload.raw_fee_amount, `${context}.raw_fee_amount`);
    if (!['ACQUISITION', 'DISPOSAL', 'UNALLOCATED_SHARED', 'NON_QUOTE_DISCLOSURE'].includes(payload.allocation_status)) {
      fail('invalid_fee_allocation', `${context}.allocation_status is invalid`);
    }
    if (['ACQUISITION', 'DISPOSAL'].includes(payload.allocation_status)) validateLocator(payload.attributed_event_locator, `${context}.attributed_event_locator`);
    else if (payload.attributed_event_locator !== null) fail('invalid_fee_attribution', `${context} unattributed fee locator must be null`);
  } else if (kind === 'TARGET_ACCOUNT_LIFECYCLE') {
    assertExactFields(payload, LIFECYCLE_PAYLOAD_FIELDS, context);
    if (!['CREATE', 'CLOSE'].includes(payload.lifecycle_action)) fail('invalid_lifecycle_action', `${context}.lifecycle_action is invalid`);
    publicKey(payload.account, `${context}.account`);
  } else fail('invalid_economic_event_kind', `${context} event kind is unsupported`);
}
function validateEventPayload(kind, payload, context) {
  if (kind !== 'FEE') return validateSourcePayload(kind, payload, context);
  assertExactFields(payload, FEE_EVENT_PAYLOAD_FIELDS, context);
  if (!['TOKEN_MINT', 'NATIVE_SOL'].includes(payload.denomination_kind)) fail('invalid_fee_denomination', `${context} denomination is invalid`);
  if (payload.denomination_kind === 'TOKEN_MINT') publicKey(payload.denomination_mint, `${context}.denomination_mint`);
  else if (payload.denomination_mint !== null) fail('invalid_fee_denomination', `${context} native fee mint must be null`);
  raw(payload.raw_fee_amount, `${context}.raw_fee_amount`);
  if (!['ACQUISITION', 'DISPOSAL', 'UNALLOCATED_SHARED', 'NON_QUOTE_DISCLOSURE'].includes(payload.allocation_status)) fail('invalid_fee_allocation', `${context}.allocation_status is invalid`);
  if (['ACQUISITION', 'DISPOSAL'].includes(payload.allocation_status)) {
    if (typeof payload.attributed_event_id !== 'string' || !/^position-event-[0-9a-f]{64}$/.test(payload.attributed_event_id)) fail('invalid_fee_attribution', `${context}.attributed_event_id is invalid`);
  } else if (payload.attributed_event_id !== null) fail('invalid_fee_attribution', `${context} unattributed fee ID must be null`);
}
function locatorKey(signature, coordinate, kind) { return `${signature}:${coordinate}:${kind}`; }
function eventPreimage(event) {
  return {
    identity_profile: POSITION_ECONOMIC_EVENT_IDENTITY_PROFILE_V1_3,
    transaction_identity: event.transaction_identity,
    canonical_transaction_coordinate: event.canonical_transaction_coordinate,
    authoritative_intra_transaction_coordinate: event.authoritative_intra_transaction_coordinate,
    event_kind: event.event_kind,
    payload: event.payload,
    source_effect_ids: event.source_effect_ids,
    corroborating_effect_ids: event.corroborating_effect_ids,
    dependency_references: event.dependency_references,
    dependency_codes: event.dependency_codes,
  };
}
function eventId(event) { return `position-event-${sha256CanonicalJson(eventPreimage(event))}`; }
function compareEvents(left, right) {
  return left.canonical_transaction_coordinate - right.canonical_transaction_coordinate
    || left.authoritative_intra_transaction_coordinate - right.authoritative_intra_transaction_coordinate
    || POSITION_ECONOMIC_EVENT_KINDS_V1_3.indexOf(left.event_kind) - POSITION_ECONOMIC_EVENT_KINDS_V1_3.indexOf(right.event_kind)
    || (canonicalJson(eventPreimage(left)) < canonicalJson(eventPreimage(right)) ? -1
      : canonicalJson(eventPreimage(left)) > canonicalJson(eventPreimage(right)) ? 1 : 0);
}

// Structural canonicalization only. Position authority is issued exclusively by
// buildPositionEpisodeV13 after recapturing a registered economic-evidence capability
// and deriving transaction chronology from a validated evidence context.
export function buildStructuralPositionEconomicEventsV13(input) {
  assertExactFields(input, INPUT_FIELDS, 'position_economic_event_input');
  if (!Array.isArray(input.transactions) || !Array.isArray(input.source_events)) {
    fail('invalid_economic_event_collection', 'transactions and source_events must be arrays');
  }
  const transactionsBySignature = new Map();
  input.transactions.forEach((transaction, index) => {
    assertExactFields(transaction, TRANSACTION_FIELDS, `transactions.${index}`);
    transactionIdentity(transaction.transaction_identity, `transactions.${index}.transaction_identity`);
    if (transaction.canonical_transaction_coordinate !== index) fail('noncanonical_transaction_order', 'transaction coordinates must be dense and ordered');
    if (!['succeeded', 'failed'].includes(transaction.finalized_execution_status)) {
      fail('invalid_execution_status', `transactions.${index}.finalized_execution_status is invalid`);
    }
    sortedUnique(transaction.effect_ids, `transactions.${index}.effect_ids`, EFFECT_ID);
    if (transactionsBySignature.has(transaction.transaction_identity.signature)) fail('duplicate_transaction_identity', 'transaction signatures must be unique');
    transactionsBySignature.set(transaction.transaction_identity.signature, transaction);
  });

  const primaryReferences = new Set();
  const sourceSemanticRecords = new Set();
  const events = input.source_events.map((source, index) => {
    assertExactFields(source, SOURCE_EVENT_FIELDS, `source_events.${index}`);
    const sourceSemanticRecord = canonicalJson(source);
    if (sourceSemanticRecords.has(sourceSemanticRecord)) {
      fail('duplicate_economic_event_identity', 'equivalent economic events cannot be admitted twice');
    }
    sourceSemanticRecords.add(sourceSemanticRecord);
    const transaction = transactionsBySignature.get(source.transaction_signature);
    if (transaction === undefined) fail('economic_event_source_mismatch', 'economic event transaction is absent');
    if (!safeNonnegative(source.authoritative_intra_transaction_coordinate)
        || !POSITION_ECONOMIC_EVENT_KINDS_V1_3.includes(source.event_kind)) {
      fail('invalid_economic_event_order', 'economic event coordinate or kind is invalid');
    }
    validateSourcePayload(source.event_kind, source.payload, `source_events.${index}.payload`);
    if (transaction.finalized_execution_status === 'failed'
        && (source.event_kind !== 'FEE' || source.payload.denomination_kind !== 'NATIVE_SOL'
          || source.payload.allocation_status !== 'NON_QUOTE_DISCLOSURE')) {
      fail('failed_transaction_economic_event', 'failed transactions retain only native non-quote fee disclosure');
    }
    sortedUnique(source.source_effect_ids, `source_events.${index}.source_effect_ids`, EFFECT_ID);
    sortedUnique(source.corroborating_effect_ids, `source_events.${index}.corroborating_effect_ids`, EFFECT_ID);
    if (source.source_effect_ids.length === 0
        || source.source_effect_ids.some(id => !transaction.effect_ids.includes(id))
        || source.corroborating_effect_ids.some(id => !transaction.effect_ids.includes(id))) {
      fail('economic_event_source_mismatch', 'economic event effects do not resolve in the bound transaction');
    }
    if (source.source_effect_ids.some(id => source.corroborating_effect_ids.includes(id))) fail('duplicate_effect_role', 'one effect cannot be primary and corroborating in one event');
    for (const id of source.source_effect_ids) {
      if (primaryReferences.has(id)) fail('duplicate_primary_effect_reference', 'primary effects cannot be counted twice');
      primaryReferences.add(id);
    }
    const codes = dependencyCodes(source.event_kind, source.payload);
    validateDependencyReferences(source.dependency_references, codes, `source_events.${index}`);
    return {
      event_id: null,
      episode_event_ordinal: null,
      transaction_identity: transaction.transaction_identity,
      canonical_transaction_coordinate: transaction.canonical_transaction_coordinate,
      authoritative_intra_transaction_coordinate: source.authoritative_intra_transaction_coordinate,
      event_kind: source.event_kind,
      payload: source.payload,
      source_effect_ids: source.source_effect_ids,
      corroborating_effect_ids: source.corroborating_effect_ids,
      dependency_references: source.dependency_references,
      dependency_codes: codes,
      source_locator: source.event_kind === 'FEE' ? source.payload.attributed_event_locator : null,
    };
  });

  const nonFeeByLocator = new Map();
  for (const event of events.filter(item => item.event_kind !== 'FEE')) {
    event.event_id = eventId(event);
    const key = locatorKey(event.transaction_identity.signature, event.authoritative_intra_transaction_coordinate, event.event_kind);
    if (nonFeeByLocator.has(key)) fail('ambiguous_economic_event_locator', 'event locator is not unique');
    nonFeeByLocator.set(key, event);
  }
  for (const event of events.filter(item => item.event_kind === 'FEE')) {
    const locator = event.source_locator;
    let attributedEventId = null;
    if (locator !== null) {
      const target = nonFeeByLocator.get(locatorKey(locator.transaction_signature, locator.authoritative_intra_transaction_coordinate, locator.event_kind));
      if (target === undefined || target.transaction_identity.signature !== event.transaction_identity.signature
          || event.payload.allocation_status !== (target.event_kind === 'TARGET_ACQUISITION' ? 'ACQUISITION' : 'DISPOSAL')) {
        fail('invalid_fee_attribution', 'fee attribution does not resolve to the declared economic event');
      }
      attributedEventId = target.event_id;
    }
    event.payload = {
      denomination_kind: event.payload.denomination_kind,
      denomination_mint: event.payload.denomination_mint,
      raw_fee_amount: event.payload.raw_fee_amount,
      allocation_status: event.payload.allocation_status,
      attributed_event_id: attributedEventId,
    };
    delete event.source_locator;
    event.event_id = eventId(event);
  }
  for (const event of events) delete event.source_locator;
  events.sort(compareEvents);
  if (events.some((event, index) => index > 0 && event.event_id === events[index - 1].event_id)
      || new Set(events.map(event => event.event_id)).size !== events.length) {
    fail('duplicate_economic_event_identity', 'equivalent economic events cannot be admitted twice');
  }
  events.forEach((event, index) => { event.episode_event_ordinal = index; });
  const result = cloneAndFreeze({ position_economic_event_version: POSITION_ECONOMIC_EVENT_VERSION_V1_3, events });
  validateCanonicalPositionEconomicEventsStructureV13(result);
  return result;
}

export function validateCanonicalPositionEconomicEventsStructureV13(value) {
  assertExactFields(value, TOP_FIELDS, 'position_economic_events');
  if (value.position_economic_event_version !== POSITION_ECONOMIC_EVENT_VERSION_V1_3 || !Array.isArray(value.events)) {
    fail('unsupported_economic_event_version', 'position economic event version is unsupported');
  }
  const ids = new Set();
  value.events.forEach((event, index) => {
    assertExactFields(event, EVENT_FIELDS, `events.${index}`);
    transactionIdentity(event.transaction_identity, `events.${index}.transaction_identity`);
    if (event.episode_event_ordinal !== index || !safeNonnegative(event.canonical_transaction_coordinate)
        || !safeNonnegative(event.authoritative_intra_transaction_coordinate)
        || !POSITION_ECONOMIC_EVENT_KINDS_V1_3.includes(event.event_kind)) {
      fail('noncanonical_economic_event_order', 'economic event order is invalid');
    }
    validateEventPayload(event.event_kind, event.payload, `events.${index}.payload`);
    sortedUnique(event.source_effect_ids, `events.${index}.source_effect_ids`, EFFECT_ID);
    sortedUnique(event.corroborating_effect_ids, `events.${index}.corroborating_effect_ids`, EFFECT_ID);
    const expectedCodes = dependencyCodes(event.event_kind, event.payload);
    if (canonicalJson(event.dependency_codes) !== canonicalJson(expectedCodes)) fail('dependency_code_mismatch', 'event dependency codes are not derived');
    validateDependencyReferences(event.dependency_references, expectedCodes, `events.${index}`);
    if (event.event_id !== eventId(event) || ids.has(event.event_id)) fail('invalid_economic_event_identity', 'event identity is invalid or duplicated');
    ids.add(event.event_id);
    if (index > 0 && compareEvents(value.events[index - 1], event) >= 0) fail('noncanonical_economic_event_order', 'events are not canonically ordered');
  });
  const byId = new Map(value.events.map(event => [event.event_id, event]));
  for (const fee of value.events.filter(event => event.event_kind === 'FEE'
    && ['ACQUISITION', 'DISPOSAL'].includes(event.payload.allocation_status))) {
    const target = byId.get(fee.payload.attributed_event_id);
    const expectedKind = fee.payload.allocation_status === 'ACQUISITION' ? 'TARGET_ACQUISITION' : 'TARGET_DISPOSAL';
    if (target?.event_kind !== expectedKind) fail('invalid_fee_attribution', 'fee target is absent or has the wrong kind');
  }
  return true;
}
