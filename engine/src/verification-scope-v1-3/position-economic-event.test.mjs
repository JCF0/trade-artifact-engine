#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POSITION_ECONOMIC_EVENT_VERSION_V1_3,
  buildStructuralPositionEconomicEventsV13,
  validateCanonicalPositionEconomicEventsStructureV13,
} from './position-economic-event.mjs';
import { providerSignature } from '../wallet-acquisition/fixtures/test-identities.mjs';

const digest = character => character.repeat(64);
const QUOTE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TARGET_ACCOUNT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const signature = character => providerSignature(`slice4-event-${character}`);
const transactionIdentity = (character, slot) => ({
  signature: signature(character), slot, block_time: 1_780_000_000 + slot, transaction_version: 0,
});
const EFFECTS = Object.freeze({
  a: `effect-${digest('a')}`, b: `effect-${digest('b')}`, c: `effect-${digest('c')}`,
  d: `effect-${digest('d')}`, e: `effect-${digest('e')}`, f: `effect-${digest('f')}`,
});
const transactions = [
  { transaction_identity: transactionIdentity('1', 10), canonical_transaction_coordinate: 0, finalized_execution_status: 'succeeded', effect_ids: [EFFECTS.a, EFFECTS.b, EFFECTS.c] },
  { transaction_identity: transactionIdentity('2', 11), canonical_transaction_coordinate: 1, finalized_execution_status: 'succeeded', effect_ids: [EFFECTS.d, EFFECTS.e, EFFECTS.f] },
];
function sourceEvent({
  signature: txSignature = signature('1'), coordinate = 0, kind = 'TARGET_ACQUISITION',
  payload = { target_raw_quantity: '10', quote_status: 'EXACT', quote_mint: QUOTE_MINT, quote_raw_amount: '20' },
  sourceEffectIds = [EFFECTS.a], corroboratingEffectIds = [], dependencies = [],
} = {}) {
  return {
    transaction_signature: txSignature,
    authoritative_intra_transaction_coordinate: coordinate,
    event_kind: kind,
    payload,
    source_effect_ids: sourceEffectIds,
    corroborating_effect_ids: corroboratingEffectIds,
    dependency_references: dependencies,
  };
}

function input(sourceEvents) {
  return { transactions: structuredClone(transactions), source_events: sourceEvents };
}

test('derives event identities and dense ordinals from source-bound coordinates and semantic content', () => {
  const acquisition = sourceEvent();
  const disposal = sourceEvent({
    signature: signature('2'), coordinate: 2, kind: 'TARGET_DISPOSAL',
    payload: { target_raw_quantity: '10', quote_status: 'EXACT', quote_mint: QUOTE_MINT, quote_raw_amount: '30' },
    sourceEffectIds: [EFFECTS.d],
  });
  const built = buildStructuralPositionEconomicEventsV13(input([disposal, acquisition]));
  const permuted = buildStructuralPositionEconomicEventsV13(input([acquisition, disposal]));

  assert.equal(built.position_economic_event_version, POSITION_ECONOMIC_EVENT_VERSION_V1_3);
  assert.deepEqual(built, permuted);
  assert.deepEqual(built.events.map(event => event.episode_event_ordinal), [0, 1]);
  assert.ok(built.events.every(event => /^position-event-[0-9a-f]{64}$/.test(event.event_id)));
  assert.deepEqual(built.events.map(event => event.canonical_transaction_coordinate), [0, 1]);
  assert.equal(validateCanonicalPositionEconomicEventsStructureV13(built), true);
  assert.ok(Object.isFrozen(built.events[0].payload));
});

test('caller-selected event IDs, episode ordinals, and transaction coordinates are not input fields', () => {
  for (const extra of [
    { event_id: `position-event-${digest('0')}` },
    { episode_event_ordinal: 99 },
    { canonical_transaction_coordinate: 99 },
  ]) {
    assert.throws(
      () => buildStructuralPositionEconomicEventsV13(input([{ ...sourceEvent(), ...extra }])),
      error => error.code === 'unknown_field',
    );
  }
});

test('equivalent admitted evidence cannot acquire multiple identities through duplication or permutation', () => {
  const event = sourceEvent();
  assert.throws(
    () => buildStructuralPositionEconomicEventsV13(input([event, structuredClone(event)])),
    error => error.code === 'duplicate_economic_event_identity',
  );
  const first = buildStructuralPositionEconomicEventsV13(input([event]));
  const reorderedFields = Object.fromEntries(Object.entries(event).reverse());
  const second = buildStructuralPositionEconomicEventsV13(input([reorderedFields]));
  assert.equal(first.events[0].event_id, second.events[0].event_id);
});

test('source effects must resolve in the bound transaction and primary effects cannot be counted twice', () => {
  assert.throws(
    () => buildStructuralPositionEconomicEventsV13(input([sourceEvent({ sourceEffectIds: [EFFECTS.d] })])),
    error => error.code === 'economic_event_source_mismatch',
  );
  assert.throws(
    () => buildStructuralPositionEconomicEventsV13(input([
      sourceEvent(),
      sourceEvent({ coordinate: 1, kind: 'TARGET_TRANSFER_IN', payload: {
        target_raw_quantity: '2', basis_status: 'KNOWN', attributable_basis: { numerator: '3', denominator: '1' },
      } }),
    ])),
    error => error.code === 'duplicate_primary_effect_reference',
  );
});

test('closed event variants preserve unresolved quote, basis, fee, transfer, and lifecycle evidence', () => {
  const values = [
    sourceEvent({
      coordinate: 0, kind: 'TARGET_ACQUISITION', sourceEffectIds: [EFFECTS.a], dependencies: [digest('1')],
      payload: { target_raw_quantity: '5', quote_status: 'UNRESOLVED', quote_mint: null, quote_raw_amount: null },
    }),
    sourceEvent({
      coordinate: 1, kind: 'TARGET_TRANSFER_IN', sourceEffectIds: [EFFECTS.b], dependencies: [digest('2')],
      payload: { target_raw_quantity: '4', basis_status: 'UNKNOWN', attributable_basis: null },
    }),
    sourceEvent({
      coordinate: 2, kind: 'TARGET_TRANSFER_OUT', sourceEffectIds: [EFFECTS.c], dependencies: [digest('3')],
      payload: { target_raw_quantity: '3', external_continuation_status: 'UNRESOLVED' },
    }),
    sourceEvent({
      signature: signature('2'), coordinate: 0, kind: 'FEE', sourceEffectIds: [EFFECTS.d], dependencies: [digest('4')],
      payload: {
        denomination_kind: 'TOKEN_MINT', denomination_mint: QUOTE_MINT, raw_fee_amount: '1',
        allocation_status: 'UNALLOCATED_SHARED', attributed_event_locator: null,
      },
    }),
    sourceEvent({
      signature: signature('2'), coordinate: 1, kind: 'TARGET_ACCOUNT_LIFECYCLE', sourceEffectIds: [EFFECTS.e],
      corroboratingEffectIds: [EFFECTS.f], payload: { lifecycle_action: 'CLOSE', account: TARGET_ACCOUNT },
    }),
  ];
  const built = buildStructuralPositionEconomicEventsV13(input(values));
  assert.deepEqual(built.events.map(event => event.event_kind), [
    'TARGET_ACQUISITION', 'TARGET_TRANSFER_IN', 'TARGET_TRANSFER_OUT', 'FEE', 'TARGET_ACCOUNT_LIFECYCLE',
  ]);
  assert.deepEqual(built.events[0].dependency_codes, ['QUOTE_CONTEXT_UNRESOLVED']);
  assert.deepEqual(built.events[1].dependency_codes, ['TRANSFER_IN_BASIS_UNRESOLVED']);
  assert.deepEqual(built.events[2].dependency_codes, ['TARGET_TRANSFER_EXTERNAL_CONTINUATION']);
  assert.deepEqual(built.events[3].dependency_codes, ['SHARED_EFFECT_ALLOCATION_UNRESOLVED']);
  assert.deepEqual(built.events[4].dependency_codes, []);
});

test('uniquely allocated fees reference an event by source locator rather than caller-created event ID', () => {
  const acquisition = sourceEvent();
  const fee = sourceEvent({
    coordinate: 1, kind: 'FEE', sourceEffectIds: [EFFECTS.b],
    payload: {
      denomination_kind: 'TOKEN_MINT', denomination_mint: QUOTE_MINT, raw_fee_amount: '2',
      allocation_status: 'ACQUISITION',
      attributed_event_locator: {
        transaction_signature: signature('1'), authoritative_intra_transaction_coordinate: 0,
        event_kind: 'TARGET_ACQUISITION',
      },
    },
  });
  const built = buildStructuralPositionEconomicEventsV13(input([fee, acquisition]));
  assert.equal(built.events[1].payload.attributed_event_id, built.events[0].event_id);
  assert.equal(Object.hasOwn(built.events[1].payload, 'attributed_event_locator'), false);
});

test('hostile values and malformed exact quantities fail closed', () => {
  const invalid = sourceEvent();
  invalid.payload.target_raw_quantity = '1.0';
  assert.throws(() => buildStructuralPositionEconomicEventsV13(input([invalid])), error => error.code === 'invalid_raw_quantity');

  let calls = 0;
  const accessor = sourceEvent();
  Object.defineProperty(accessor.payload, 'target_raw_quantity', {
    enumerable: true, get() { calls += 1; throw new Error('must not execute'); },
  });
  assert.throws(() => buildStructuralPositionEconomicEventsV13(input([accessor])), error => error.code === 'accessor_not_allowed');
  assert.equal(calls, 0);
});

test('failed transactions cannot be relabeled as committed target economics', () => {
  const failedTransactions = transactions.map((transaction, index) => index === 0
    ? { ...transaction, finalized_execution_status: 'failed' } : transaction);
  assert.throws(
    () => buildStructuralPositionEconomicEventsV13({
      transactions: failedTransactions,
      source_events: [sourceEvent({ sourceEffectIds: [EFFECTS.a] })],
    }),
    error => error.code === 'failed_transaction_economic_event',
  );
});
