#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cloneAndFreeze } from './plain-data.mjs';
import { buildSourceTransactionReferenceV1, buildMarkObservationV1 } from './identity.mjs';

const input = Object.create(Object.prototype);
Object.defineProperty(input, '__proto__', { value: { safe: true }, enumerable: true, writable: true, configurable: true });
Object.defineProperty(input, 'constructor', { value: { name: 'data' }, enumerable: true, writable: true, configurable: true });
Object.defineProperty(input, 'prototype', { value: ['data'], enumerable: true, writable: true, configurable: true });
input.nested = { values: [1, { ok: true }] };
const output = cloneAndFreeze(input);
input.nested.values[1].ok = false;
assert.equal(output.nested.values[1].ok, true);
assert.ok(Object.isFrozen(output) && Object.isFrozen(output.nested) && Object.isFrozen(output.nested.values) && Object.isFrozen(output.nested.values[1]));
assert.equal(Object.getPrototypeOf(output), Object.prototype);
assert.deepEqual(output.__proto__, { safe: true }); assert.deepEqual(output.constructor, { name: 'data' }); assert.deepEqual(output.prototype, ['data']);
assert.throws(() => { output.nested.values.push(2); }, TypeError);

let invoked = 0; const hostile = {};
Object.defineProperty(hostile, 'secret', { enumerable: true, get() { invoked += 1; return 42; } });
assert.throws(() => cloneAndFreeze(hostile), error => error.code === 'accessor_not_allowed'); assert.equal(invoked, 0);
const txInput = { tx_hash: 'z'.repeat(88), slot: 7, block_time: null }; const tx = buildSourceTransactionReferenceV1(txInput); txInput.slot = 99; assert.equal(tx.slot, 7); assert.ok(Object.isFrozen(tx));
const markInput = { token_mint: 'mint', quote_mint: 'quote', observation_status: 'unavailable', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: null, observed_at: null, source_slot: null, reason_code: 'mark_source_unavailable' };
const mark = buildMarkObservationV1(markInput); markInput.reason_code = 'mutated'; assert.equal(mark.reason_code, 'mark_source_unavailable'); assert.ok(Object.isFrozen(mark));
console.log('candidate-set immutability: PASS');
