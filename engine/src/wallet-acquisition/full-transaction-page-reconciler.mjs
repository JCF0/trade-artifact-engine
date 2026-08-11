import { canonicalJson } from '../candidate-set/serialize.mjs';
import { buildSolanaFullTransactionV1 } from './solana-full-transaction.mjs';
import { detachProviderNeutralValueV1, failWalletAcquisitionOperationV1 } from './provider-port.mjs';
import { MAX_PAGES_V1, MAX_TRANSACTIONS_V1 } from './request-contract.mjs';

const MAX_PAGINATION_TOKEN_LENGTH = 1024;
const RECONCILERS = new WeakMap();

function fail(code, reason) { failWalletAcquisitionOperationV1(code, reason); }
function token(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PAGINATION_TOKEN_LENGTH) {
    fail('malformed_provider_response', 'full_transaction_pagination_token_invalid');
  }
  return value;
}
function budgets(value) {
  const detached = detachProviderNeutralValueV1(value);
  if (detached === null || typeof detached !== 'object' || Array.isArray(detached)
      || Object.keys(detached).length !== 2 || !Object.hasOwn(detached, 'max_pages')
      || !Object.hasOwn(detached, 'max_transactions')) fail('invalid_acquisition_request');
  for (const field of ['max_pages','max_transactions']) {
    if (!Number.isSafeInteger(detached[field]) || detached[field] <= 0) fail('invalid_acquisition_request');
  }
  if (detached.max_pages > MAX_PAGES_V1 || detached.max_transactions > MAX_TRANSACTIONS_V1) {
    fail('invalid_acquisition_request');
  }
  return detached;
}
function page(value) {
  const detached = detachProviderNeutralValueV1(value);
  const fields = ['requested_pagination_token','transactions','pagination_token'];
  if (detached === null || typeof detached !== 'object' || Array.isArray(detached)
      || Object.keys(detached).length !== fields.length || fields.some(field => !Object.hasOwn(detached, field))
      || !Array.isArray(detached.transactions)) {
    fail('malformed_provider_response', 'full_transaction_page_invalid');
  }
  return {
    requestedToken: token(detached.requested_pagination_token),
    transactions: detached.transactions.map(buildSolanaFullTransactionV1),
    nextToken: token(detached.pagination_token),
  };
}

export function createFullTransactionPageReconcilerV1(rawBudgets) {
  const limits = budgets(rawBudgets);
  const reconciler = Object.freeze({
    assertPageRequestAllowedV1(value) {
      const state = RECONCILERS.get(reconciler);
      const requestedToken = token(detachProviderNeutralValueV1(value));
      if (state.pages >= limits.max_pages || state.entries >= limits.max_transactions) {
        fail('acquisition_capped');
      }
      if (state.terminal || requestedToken !== state.expectedToken) {
        fail('malformed_provider_response', 'full_transaction_pagination_token_invalid');
      }
      return true;
    },
    acceptPageV1(value) {
      const state = RECONCILERS.get(reconciler);
      const next = page(value);
      if (state.pages >= limits.max_pages) fail('acquisition_capped');
      if (state.terminal || next.requestedToken !== state.expectedToken) {
        fail('malformed_provider_response', 'full_transaction_pagination_token_invalid');
      }
      if (state.entries + next.transactions.length > limits.max_transactions) fail('acquisition_capped');

      let previousSlot = state.previousSlot;
      const additions = [];
      const stagedBySignature = new Map(state.transactionsBySignature);
      for (const transaction of next.transactions) {
        if (previousSlot !== null && transaction.slot > previousSlot) {
          fail('malformed_provider_response', 'full_transaction_order_invalid');
        }
        const prior = stagedBySignature.get(transaction.signature);
        if (prior !== undefined && canonicalJson(prior) !== canonicalJson(transaction)) {
          fail('malformed_provider_response', 'full_transaction_duplicate_signature');
        }
        if (prior === undefined) {
          stagedBySignature.set(transaction.signature, transaction);
          additions.push(transaction);
        }
        previousSlot = transaction.slot;
      }
      if (next.nextToken !== null && state.seenTokens.has(next.nextToken)) {
        fail('malformed_provider_response', 'full_transaction_pagination_token_repeated');
      }

      state.pages += 1;
      state.entries += next.transactions.length;
      state.previousSlot = previousSlot;
      for (const transaction of additions) state.transactionsBySignature.set(transaction.signature, transaction);
      if (next.nextToken !== null) state.seenTokens.add(next.nextToken);
      state.expectedToken = next.nextToken;
      state.terminal = next.nextToken === null;
      return Object.freeze({ transactions: Object.freeze(additions), pagination_token: next.nextToken });
    },
  });
  RECONCILERS.set(reconciler, {
    pages: 0,
    entries: 0,
    expectedToken: null,
    terminal: false,
    seenTokens: new Set(),
    transactionsBySignature: new Map(),
    previousSlot: null,
  });
  return reconciler;
}
