import { createHash } from 'node:crypto';
import { assertPlainJsonValue } from './plain-data.mjs';
import { sortCodeUnitKeys } from './order.mjs';

function canonicalClone(value) {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const key of sortCodeUnitKeys(value)) Object.defineProperty(result, key, {
      value: canonicalClone(Object.getOwnPropertyDescriptor(value, key).value), enumerable: true, writable: true, configurable: true,
    });
    return result;
  }
  return value;
}

export function canonicalJson(value) {
  assertPlainJsonValue(value);
  return `${JSON.stringify(canonicalClone(value), null, 2)}\n`;
}

export function sha256Bytes(bytes) {
  if (typeof bytes !== 'string' && !(bytes instanceof Uint8Array)) throw new TypeError('sha256Bytes requires a string or Uint8Array');
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256CanonicalJson(value) { return sha256Bytes(canonicalJson(value)); }
export const canonicalSerialize = canonicalJson;
