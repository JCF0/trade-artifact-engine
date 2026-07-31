#!/usr/bin/env node
import assert from 'node:assert/strict';
import { canonicalJson, sha256Bytes, sha256CanonicalJson } from './serialize.mjs';
import { compareCodeUnits, sortCodeUnitKeys, sortedCodeUnitCopy } from './order.mjs';

const a = { z: [{ b: 2, a: 1 }], a: 'first' };
const b = { a: 'first', z: [{ a: 1, b: 2 }] };
const bytes = canonicalJson(a);
assert.equal(bytes, canonicalJson(b));
assert.equal(bytes, '{\n  "a": "first",\n  "z": [\n    {\n      "a": 1,\n      "b": 2\n    }\n  ]\n}\n');
assert.ok(bytes.endsWith('\n') && !bytes.endsWith('\n\n') && !bytes.includes('\r'));
assert.equal(sha256Bytes('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.match(sha256CanonicalJson(a), /^[0-9a-f]{64}$/);
assert.deepEqual(sortCodeUnitKeys({ '\ud800': 1, 'a': 2, 'A': 3 }), ['A', 'a', '\ud800']);
assert.deepEqual(sortedCodeUnitCopy(['b', 'A', 'a']), ['A', 'a', 'b']);
assert.ok(compareCodeUnits('A', 'a') < 0);
const sequence = ['second', 'first']; canonicalJson(sequence); assert.deepEqual(sequence, ['second', 'first']);
console.log('candidate-set serialization: PASS');
