import { types as utilTypes } from 'node:util';

function sanitizedClone(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : undefined;
  if (typeof value !== 'object' || utilTypes.isProxy(value) || seen.has(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) return undefined;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) { seen.delete(value); return undefined; }
  if (Array.isArray(value)) {
    const keys = Object.keys(descriptors).filter(key => key !== 'length');
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) { seen.delete(value); return undefined; }
    const result = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value')) { seen.delete(value); return undefined; }
      const item = sanitizedClone(descriptor.value, seen);
      if (item === undefined) { seen.delete(value); return undefined; }
      result.push(item);
    }
    seen.delete(value); return Object.freeze(result);
  }
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) { seen.delete(value); return undefined; }
    const item = sanitizedClone(descriptor.value, seen);
    if (item === undefined) { seen.delete(value); return undefined; }
    Object.defineProperty(result, key, { value: item, enumerable: true, writable: false, configurable: false });
  }
  seen.delete(value); return Object.freeze(result);
}

export class WalletCandidateSetError extends Error {
  constructor(code, message, details = {}) {
    super(typeof message === 'string' ? message : 'wallet candidate set error');
    this.name = 'WalletCandidateSetError';
    this.code = typeof code === 'string' && code.length ? code : 'candidate_set_error';
    const sanitized = sanitizedClone(details);
    this.details = sanitized !== undefined && sanitized !== null && !Array.isArray(sanitized) && typeof sanitized === 'object'
      ? sanitized : Object.freeze({});
  }
}

export function fail(code, message, details = {}) {
  throw new WalletCandidateSetError(code, message, details);
}
