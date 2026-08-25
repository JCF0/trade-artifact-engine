import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

const MAX_JSON_DEPTH = 256;
const MAX_JSON_NODES = 100000;

export class VerificationScopeError extends Error {
  constructor(code, message, details = {}) {
    super(typeof message === 'string' ? message : 'verification scope contract error');
    this.name = 'VerificationScopeError';
    this.code = typeof code === 'string' && code.length ? code : 'verification_scope_error';
    this.details = Object.freeze(details !== null && typeof details === 'object' && !Array.isArray(details) ? { ...details } : {});
  }
}

export function fail(code, message, details = {}) {
  throw new VerificationScopeError(code, message, details);
}

function pathText(path) { return path.length ? path.join('.') : '<root>'; }
export function assertPlainJsonValue(value, path = [], active = new Set(), depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) fail('json_node_limit_exceeded', `JSON graph exceeds node budget at ${pathText(path)}`);
  if (depth > MAX_JSON_DEPTH) fail('json_depth_exceeded', `JSON graph exceeds depth limit at ${pathText(path)}`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('invalid_json_number', `invalid JSON number at ${pathText(path)}`);
    return true;
  }
  if (typeof value !== 'object') fail('unsupported_json_value', `unsupported JSON value at ${pathText(path)}`);
  if (utilTypes.isProxy(value)) fail('proxy_not_allowed', `proxy is not allowed at ${pathText(path)}`);
  if (active.has(value)) fail('cyclic_value_not_allowed', `cycle is not allowed at ${pathText(path)}`);
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) fail('custom_prototype_not_allowed', `custom prototype at ${pathText(path)}`);
  if (Object.getOwnPropertySymbols(value).length) fail('symbol_key_not_allowed', `symbol key at ${pathText(path)}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors).filter(([key]) => !(isArray && key === 'length'));
  if (isArray && (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))) fail('sparse_array_not_allowed', `array must be dense at ${pathText(path)}`);
  active.add(value);
  for (const [key, descriptor] of entries) {
    if (!descriptor.enumerable) fail('non_enumerable_field_not_allowed', `non-enumerable field at ${pathText([...path, key])}`);
    if (!Object.hasOwn(descriptor, 'value')) fail('accessor_not_allowed', `accessor at ${pathText([...path, key])}`);
    assertPlainJsonValue(descriptor.value, [...path, key], active, depth + 1, budget);
  }
  active.delete(value);
  return true;
}

export function assertExactFields(value, fields, context) {
  assertPlainJsonValue(value, [context]);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_object', `${context} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) if (!fields.includes(key)) fail('unknown_field', `${context} contains unknown field`, { context, field: key });
  for (const field of fields) if (!Object.hasOwn(descriptors, field)) fail('missing_field', `${context} is missing field`, { context, field });
  return descriptors;
}

export function clonePlainData(value) {
  assertPlainJsonValue(value);
  function clone(item) {
    if (Array.isArray(item)) return item.map(clone);
    if (item !== null && typeof item === 'object') {
      const result = {};
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) Object.defineProperty(result, key, { value: clone(descriptor.value), enumerable: true, writable: true, configurable: true });
      return result;
    }
    return item;
  }
  return clone(value);
}

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
    Object.freeze(value);
  }
  return value;
}
export function cloneAndFreeze(value) { return deepFreeze(clonePlainData(value)); }

function canonicalClone(value) {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) Object.defineProperty(result, key, { value: canonicalClone(Object.getOwnPropertyDescriptor(value, key).value), enumerable: true, writable: true, configurable: true });
    return result;
  }
  return value;
}
export function canonicalJson(value) {
  assertPlainJsonValue(value);
  return `${JSON.stringify(canonicalClone(value), null, 2)}\n`;
}
export function sha256CanonicalJson(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
