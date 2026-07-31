#!/usr/bin/env node
import assert from 'node:assert/strict';
import { WalletCandidateSetError } from './errors.mjs';
import { assertPlainJsonValue, clonePlainData, deepFreeze } from './plain-data.mjs';

assert.doesNotThrow(() => assertPlainJsonValue({ ok: [null, true, 1, 'x'] }));
for (const value of [undefined, 1n, NaN, Infinity, -Infinity, -0, Symbol('x'), () => {}]) {
  assert.throws(() => assertPlainJsonValue(value), WalletCandidateSetError);
}
const accessor = {};
Object.defineProperty(accessor, 'trap', { enumerable: true, get() { throw new Error('executed'); } });
assert.throws(() => assertPlainJsonValue(accessor), error => error.code === 'accessor_not_allowed');
const sparse = []; sparse[1] = 'x';
assert.throws(() => assertPlainJsonValue(sparse), error => error.code === 'sparse_array_not_allowed');
let proxyTrapCount = 0;
const proxy = new Proxy({}, { getPrototypeOf() { proxyTrapCount += 1; throw new Error('proxy trap invoked'); }, ownKeys() { proxyTrapCount += 1; throw new Error('proxy trap invoked'); } });
assert.throws(() => assertPlainJsonValue(proxy), error => error.code === 'proxy_not_allowed'); assert.equal(proxyTrapCount, 0);
const source = { nested: [{ value: 1 }] };
const clone = clonePlainData(source);
assert.deepEqual(clone, source); assert.notEqual(clone, source); assert.notEqual(clone.nested, source.nested);
deepFreeze(clone);
assert.ok(Object.isFrozen(clone) && Object.isFrozen(clone.nested) && Object.isFrozen(clone.nested[0]));
const hostileDetails = {};
Object.defineProperty(hostileDetails, 'secret', { enumerable: true, get() { throw new Error('executed'); } });
const error = new WalletCandidateSetError('bad_input', 'bad input', hostileDetails);
assert.equal(error.code, 'bad_input'); assert.ok(Object.isFrozen(error.details)); assert.deepEqual(error.details, {});
console.log('candidate-set plain data: PASS');
