import { types as utilTypes } from 'node:util';
import { fail } from './errors.mjs';

function pathText(path) { return path.length ? path.join('.') : '<root>'; }

const MAX_JSON_DEPTH = 256;
const MAX_JSON_NODES = 100000;

export function assertPlainJsonValue(value, path = [], seen = new Set(), depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) fail('json_node_limit_exceeded', `JSON value exceeds maximum node count at ${pathText(path)}`);
  if (depth > MAX_JSON_DEPTH) fail('json_depth_exceeded', `JSON value exceeds maximum depth at ${pathText(path)}`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('invalid_json_number', `invalid JSON number at ${pathText(path)}`);
    return true;
  }
  if (typeof value !== 'object') fail('unsupported_json_value', `unsupported JSON value at ${pathText(path)}`, { type: typeof value });
  if (utilTypes.isProxy(value)) fail('proxy_not_allowed', `proxy value at ${pathText(path)}`);
  if (seen.has(value)) fail('cyclic_value_not_allowed', `cyclic value at ${pathText(path)}`);
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (prototype !== (isArray ? Array.prototype : Object.prototype)) fail('custom_prototype_not_allowed', `custom prototype at ${pathText(path)}`);
  if (Object.getOwnPropertySymbols(value).length) fail('symbol_key_not_allowed', `symbol key at ${pathText(path)}`);
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors).filter(([key]) => !(isArray && key === 'length'));
  if (isArray && (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))) fail('sparse_array_not_allowed', `array must be dense at ${pathText(path)}`);
  for (const [key, descriptor] of entries) {
    if (!descriptor.enumerable) fail('non_enumerable_field_not_allowed', `non-enumerable field at ${pathText([...path, key])}`);
    if (!Object.hasOwn(descriptor, 'value')) fail('accessor_not_allowed', `accessor at ${pathText([...path, key])}`);
    assertPlainJsonValue(descriptor.value, [...path, key], seen, depth + 1, budget);
  }
  seen.delete(value);
  return true;
}

export function clonePlainData(value) {
  assertPlainJsonValue(value);
  if (Array.isArray(value)) return value.map(clonePlainData);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      Object.defineProperty(result, key, { value: clonePlainData(descriptor.value), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return value;
}

export function deepFreeze(value) {
  assertPlainJsonValue(value);
  if (value !== null && typeof value === 'object') {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
    Object.freeze(value);
  }
  return value;
}

export function cloneAndFreeze(value) { return deepFreeze(clonePlainData(value)); }
export const safeDeepClone = clonePlainData;
export const safeDeepFreeze = deepFreeze;
