import { acquisitionFail } from './acquisition-errors.mjs';
import { isDeepStrictEqual } from 'node:util';

export const HELIUS_ENHANCED_TRANSACTIONS_PAGE_SIZE = 100;

function descriptors(value, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    acquisitionFail('malformed_provider_page', `${context} must be an ordinary object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    acquisitionFail('malformed_provider_page', `${context} must not contain symbol keys`);
  }
  const result = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(result)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      acquisitionFail('malformed_provider_page', `${context} must contain only enumerable data properties`);
    }
  }
  return result;
}

function validatePlainData(value, context, active) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) acquisitionFail('malformed_provider_page', `${context} contains an invalid number`);
    return;
  }
  if (typeof value !== 'object') acquisitionFail('malformed_provider_page', `${context} contains a non-data value`);
  if (active.has(value)) acquisitionFail('malformed_provider_page', `${context} contains a cycle`);
  active.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      acquisitionFail('malformed_provider_page', `${context} contains a non-ordinary array`);
    }
    const properties = Object.getOwnPropertyDescriptors(value);
    const entries = Object.entries(properties).filter(([key]) => key !== 'length');
    if (entries.length !== value.length || entries.some(([key, descriptor], index) => (
      key !== String(index) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
    ))) acquisitionFail('malformed_provider_page', `${context} contains a sparse or decorated array`);
    for (const [key, descriptor] of entries) validatePlainData(descriptor.value, `${context}[${key}]`, active);
  } else {
    const fields = descriptors(value, context);
    for (const descriptor of Object.values(fields)) validatePlainData(descriptor.value, `${context} property`, active);
  }
  active.delete(value);
}

function densePage(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length !== 0) {
    acquisitionFail('malformed_provider_page', 'provider page must be an ordinary dense array');
  }
  const properties = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(properties).filter(([key]) => key !== 'length');
  if (entries.length !== value.length || entries.some(([key, descriptor], index) => (
    key !== String(index) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
  ))) acquisitionFail('malformed_provider_page', 'provider page must be an ordinary dense array');
  return entries.map(([, descriptor]) => descriptor.value);
}

export function validateHeliusEnhancedTransactionsPageV1(data, state = {}) {
  const page = densePage(data);
  if (page.length > HELIUS_ENHANCED_TRANSACTIONS_PAGE_SIZE) {
    acquisitionFail('malformed_provider_page', 'provider page exceeds the fixed page size');
  }
  const seen = state.seenSignatures instanceof Map ? state.seenSignatures : new Map();
  let previousTimestamp = state.previousTimestamp ?? null;
  const validated = [];
  for (let index = 0; index < page.length; index += 1) {
    const transaction = page[index];
    validatePlainData(transaction, `provider transaction ${index}`, new Set());
    const fields = descriptors(transaction, `provider transaction ${index}`);
    const signature = fields.signature?.value;
    const timestamp = fields.timestamp?.value;
    if (typeof signature !== 'string' || signature.length === 0) {
      acquisitionFail('malformed_provider_page', 'provider transaction signature is required');
    }
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      acquisitionFail('malformed_provider_page', 'provider transaction timestamp must be a non-negative safe integer');
    }
    if (previousTimestamp !== null && timestamp > previousTimestamp) {
      acquisitionFail('pagination_order_invalid', 'provider transactions are not in deterministic descending order');
    }
    if (seen.has(signature)) {
      if (!isDeepStrictEqual(seen.get(signature), transaction)) {
        acquisitionFail('pagination_order_invalid', 'duplicate provider transaction identities disagree');
      }
      if (signature === state.requestCursor) {
        acquisitionFail('pagination_cursor_repeated', 'provider repeated the pagination cursor');
      }
      acquisitionFail('pagination_order_invalid', 'provider repeated a transaction identity');
    }
    if (signature === state.requestCursor) {
      acquisitionFail('pagination_cursor_repeated', 'provider repeated the pagination cursor');
    }
    seen.set(signature, structuredClone(transaction));
    previousTimestamp = timestamp;
    validated.push(structuredClone(transaction));
  }
  return {
    transactions: validated,
    continuationCursor: validated.length === HELIUS_ENHANCED_TRANSACTIONS_PAGE_SIZE
      ? validated.at(-1).signature
      : null,
    lastTimestamp: previousTimestamp,
    seenSignatures: seen,
  };
}
