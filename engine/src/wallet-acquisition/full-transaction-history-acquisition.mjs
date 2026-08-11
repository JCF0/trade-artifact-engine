import { types as utilTypes } from 'node:util';

import { createFullTransactionPageReconcilerV1 } from './full-transaction-page-reconciler.mjs';
import {
  contextualizeWalletAcquisitionErrorV1,
  detachProviderNeutralValueV1,
  failWalletAcquisitionOperationV1,
  sanitizeWalletAcquisitionErrorV1,
} from './provider-port.mjs';
import {
  MAX_ATTEMPTS_PER_OPERATION_V1,
  MAX_EXACT_FALLBACK_TRANSACTIONS_V2,
  MAX_OVERALL_TIMEOUT_MS_V1,
  MAX_PAGES_V1,
  MAX_REQUEST_TIMEOUT_MS_V1,
  MAX_TRANSACTIONS_V1,
  PAGE_SIZE_V1,
} from './request-contract.mjs';
import { buildSolanaFullTransactionV1 } from './solana-full-transaction.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './solana-identities.mjs';

const INPUT_FIELDS = ['port','wallet','anchor_slot','canonical_sources','budgets'];
const SOURCE_FIELDS = ['signature','slot','block_time','execution_state'];
const BUDGET_FIELDS = [
  'pagination_profile','page_size','max_pages','max_transactions','retry_profile',
  'max_attempts_per_operation','timeout_profile','request_timeout_ms','overall_timeout_ms',
  'exact_fallback_profile','max_exact_fallback_transactions',
];

function fail(code) { failWalletAcquisitionOperationV1(code); }
function exactObject(value, fields, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== fields.length
      || fields.some(field => !descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value'))) fail(code);
  return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
}
function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function validateBudgets(value) {
  const budget = exactObject(value, BUDGET_FIELDS, 'invalid_acquisition_request');
  if (budget.pagination_profile !== 'solana_full_transaction_page_100_v1' || budget.page_size !== PAGE_SIZE_V1
      || budget.retry_profile !== 'bounded_exponential_retry_v1'
      || budget.timeout_profile !== 'bounded_provider_timeout_v1'
      || budget.exact_fallback_profile !== 'finalized_get_transaction_missing_only_v1'
      || !Number.isSafeInteger(budget.max_pages) || budget.max_pages <= 0 || budget.max_pages > MAX_PAGES_V1
      || !Number.isSafeInteger(budget.max_transactions) || budget.max_transactions <= 0
      || budget.max_transactions > MAX_TRANSACTIONS_V1
      || !Number.isSafeInteger(budget.max_attempts_per_operation) || budget.max_attempts_per_operation <= 0
      || budget.max_attempts_per_operation > MAX_ATTEMPTS_PER_OPERATION_V1
      || !Number.isSafeInteger(budget.request_timeout_ms) || budget.request_timeout_ms <= 0
      || budget.request_timeout_ms > MAX_REQUEST_TIMEOUT_MS_V1
      || !Number.isSafeInteger(budget.overall_timeout_ms) || budget.overall_timeout_ms <= 0
      || budget.overall_timeout_ms > MAX_OVERALL_TIMEOUT_MS_V1
      || budget.request_timeout_ms >= budget.overall_timeout_ms
      || !safeNonnegativeInteger(budget.max_exact_fallback_transactions)
      || budget.max_exact_fallback_transactions > MAX_EXACT_FALLBACK_TRANSACTIONS_V2) {
    fail('invalid_acquisition_request');
  }
  return budget;
}
function validateSources(value) {
  const sources = detachProviderNeutralValueV1(value);
  if (!Array.isArray(sources)) fail('pagination_incomplete');
  const signatures = new Set();
  let previous = null;
  for (const candidate of sources) {
    const source = exactObject(candidate, SOURCE_FIELDS, 'pagination_incomplete');
    if (!isSolanaSignatureV1(source.signature) || signatures.has(source.signature)
        || !safeNonnegativeInteger(source.slot) || !safeNonnegativeInteger(source.block_time)
        || !['succeeded','failed'].includes(source.execution_state)
        || (previous !== null && (source.slot > previous.slot || source.block_time > previous.block_time))) {
      fail('pagination_incomplete');
    }
    signatures.add(source.signature);
    previous = source;
  }
  return sources;
}
function validatePort(value) {
  if (value === null || typeof value !== 'object' || typeof value.getFinalizedFullTransactionPageV1 !== 'function'
      || typeof value.getFinalizedTransactionV1 !== 'function') fail('acquisition_capability_denied');
  return value;
}
function sameSource(transaction, source) {
  return transaction.signature === source.signature && transaction.slot === source.slot
    && transaction.block_time === source.block_time && transaction.execution_state === source.execution_state;
}
async function diagnosed(stage, operation, call) {
  try { return await call(); }
  catch (error) { throw contextualizeWalletAcquisitionErrorV1(error, stage, operation); }
}

export async function acquireFinalizedFullTransactionHistoryV1(rawInput) {
  try {
    const input = exactObject(rawInput, INPUT_FIELDS, 'invalid_acquisition_request');
    const port = validatePort(input.port);
    if (!isSolanaPublicKeyV1(input.wallet) || !safeNonnegativeInteger(input.anchor_slot)) fail('invalid_acquisition_request');
    const sources = validateSources(input.canonical_sources);
    const budget = validateBudgets(input.budgets);
    if (sources.length === 0) return Object.freeze([]);

    const canonicalBySignature = new Map(sources.map(source => [source.signature, source]));
    const transactionsBySignature = new Map();
    const reconciler = createFullTransactionPageReconcilerV1({
      max_pages: budget.max_pages,
      max_transactions: budget.max_transactions,
    });
    let token = null;
    while (transactionsBySignature.size !== canonicalBySignature.size) {
      reconciler.assertPageRequestAllowedV1(token);
      const page = await diagnosed('full_transaction_history', 'full_transaction_address_history', () => (
        port.getFinalizedFullTransactionPageV1({
          wallet: input.wallet,
          pagination_token: token,
          limit: PAGE_SIZE_V1,
          commitment: 'finalized',
          anchor_slot: input.anchor_slot,
          transaction_details: 'full',
          sort_order: 'desc',
          encoding: 'json',
          max_supported_transaction_version: 0,
          token_account_scope: 'none',
          status: 'any',
        })
      ));
      const accepted = reconciler.acceptPageV1({ requested_pagination_token: token, ...page });
      for (const transaction of accepted.transactions) {
        const source = canonicalBySignature.get(transaction.signature);
        if (source === undefined) continue;
        if (!sameSource(transaction, source)) fail('source_transaction_mismatch');
        transactionsBySignature.set(transaction.signature, transaction);
      }
      token = accepted.pagination_token;
      if (token === null) break;
    }

    const missing = sources.filter(source => !transactionsBySignature.has(source.signature));
    if (missing.length !== 0) {
      if (budget.max_exact_fallback_transactions === 0
          || missing.length > budget.max_exact_fallback_transactions) fail('source_transaction_mismatch');
      for (const source of missing) {
        const candidate = await diagnosed('exact_transaction_fallback', 'exact_transaction_fallback', () => (
          port.getFinalizedTransactionV1({
            signature: source.signature,
            commitment: 'finalized',
            encoding: 'json',
            max_supported_transaction_version: 0,
          })
        ));
        if (candidate === null) fail('source_transaction_mismatch');
        const transaction = buildSolanaFullTransactionV1(candidate);
        if (!sameSource(transaction, source)) fail('source_transaction_mismatch');
        transactionsBySignature.set(source.signature, transaction);
      }
    }
    if (transactionsBySignature.size !== canonicalBySignature.size) fail('source_transaction_mismatch');
    return Object.freeze(sources.map(source => transactionsBySignature.get(source.signature)));
  } catch (error) {
    throw sanitizeWalletAcquisitionErrorV1(error);
  }
}
