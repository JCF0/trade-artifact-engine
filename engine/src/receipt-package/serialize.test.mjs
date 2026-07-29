#!/usr/bin/env node
import assert from 'node:assert/strict';
import { canonicalJson, computePackageDigest, packageDigestPreimage, sha256CanonicalJson, serializeReceiptPackageV1 } from './serialize.mjs';
import { ReceiptPackageError } from './errors.mjs';
import { buildReceiptPackageV1 } from './builder.mjs';
import { makeFixture } from './fixtures.test-helper.mjs';

const a = { z: [{ b: 2, a: 1 }, 'x'], a: { d: 4, c: 3 } };
const b = { a: { c: 3, d: 4 }, z: [{ a: 1, b: 2 }, 'x'] };
const bytes = canonicalJson(a);
assert.equal(bytes, canonicalJson(b));
assert.equal(bytes, '{\n  "a": {\n    "c": 3,\n    "d": 4\n  },\n  "z": [\n    {\n      "a": 1,\n      "b": 2\n    },\n    "x"\n  ]\n}\n');
assert.ok(!bytes.includes('\r')); assert.ok(bytes.endsWith('\n')); assert.ok(!bytes.endsWith('\n\n'));
assert.equal(sha256CanonicalJson(a), sha256CanonicalJson(b));
const array = ['second', 'first']; assert.match(canonicalJson(array), /"second"[\s\S]*"first"/);
assert.throws(() => canonicalJson({ lossy: undefined }), error => error.code === 'unsupported_json_value');
const protoKey = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
assert.deepEqual(JSON.parse(canonicalJson(protoKey)), protoKey);
assert.equal(Object.getPrototypeOf(JSON.parse(canonicalJson(protoKey))), Object.prototype);
const packageBytes = serializeReceiptPackageV1(buildReceiptPackageV1(makeFixture()));
assert.deepEqual(Object.keys(packageBytes).sort(), ['archive-record.json','canonical-receipt.json','economics.json','manifest.json','verification.json']);
for (const value of Object.values(packageBytes)) { assert.ok(value.endsWith('\n')); assert.ok(!value.includes('\r')); }
const pkg = structuredClone(buildReceiptPackageV1(makeFixture()));
const digest = computePackageDigest(pkg);
pkg['manifest.json'].package_digest = 'f'.repeat(64);
assert.equal(computePackageDigest(pkg), digest);
pkg['manifest.json'].package_status = 'changed';
assert.notEqual(computePackageDigest(pkg), digest);
assert.ok(!Object.hasOwn(packageDigestPreimage(pkg)['manifest.json'], 'package_digest'));
for (const malformed of [{}, { ...pkg, 'extra.json': {} }]) {
  assert.throws(() => serializeReceiptPackageV1(malformed), error => error instanceof ReceiptPackageError && error.code === 'package_member_set_invalid');
  assert.throws(() => packageDigestPreimage(malformed), error => error instanceof ReceiptPackageError && error.code === 'package_member_set_invalid');
}
console.log('receipt-package serialization: PASS');
