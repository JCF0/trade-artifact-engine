import { createHash } from 'node:crypto';
import { assertPlainJsonValue, PACKAGE_MEMBER_NAMES } from './schema.mjs';
import { fail } from './errors.mjs';

function sortAndClone(value) {
  if (Array.isArray(value)) return value.map(sortAndClone);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(result, key, {
        value: sortAndClone(value[key]), enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  }
  return value;
}
export function canonicalJson(value) {
  assertPlainJsonValue(value);
  return `${JSON.stringify(sortAndClone(value), null, 2)}\n`;
}
export function sha256Bytes(bytes) {
  if (typeof bytes !== 'string' && !(bytes instanceof Uint8Array)) throw new TypeError('sha256Bytes requires a string or Uint8Array');
  return createHash('sha256').update(bytes).digest('hex');
}
export function sha256CanonicalJson(value) { return sha256Bytes(canonicalJson(value)); }
function assertPackageMemberSet(pkg) {
  assertPlainJsonValue(pkg);
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)
      || Object.keys(pkg).length !== PACKAGE_MEMBER_NAMES.length
      || PACKAGE_MEMBER_NAMES.some(name => !Object.hasOwn(pkg, name))) {
    fail('package_member_set_invalid', 'package must contain exactly the five authoritative v1 members');
  }
}
export function packageDigestPreimage(pkg) {
  assertPackageMemberSet(pkg);
  const manifest = { ...pkg['manifest.json'] };
  delete manifest.package_digest;
  return {
    'manifest.json': manifest,
    'canonical-receipt.json': pkg['canonical-receipt.json'],
    'verification.json': pkg['verification.json'],
    'archive-record.json': pkg['archive-record.json'],
    'economics.json': pkg['economics.json'],
  };
}
export function computePackageDigest(pkg) { return sha256CanonicalJson(packageDigestPreimage(pkg)); }
export function serializeReceiptPackageV1(pkg) {
  assertPackageMemberSet(pkg);
  return Object.fromEntries(PACKAGE_MEMBER_NAMES.map(name => [name, canonicalJson(pkg[name])]));
}
