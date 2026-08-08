import {
  assertExactFieldsV1,
  assertPlainDataV1,
  assertSafeNonnegativeIntegerV1,
  assertSafePositiveIntegerV1,
  cloneAndFreezePlainDataV1,
  failWalletAcquisitionV1,
} from './errors.mjs';
import { isSolanaPublicKeyV1 } from './solana-identities.mjs';

export const WALLET_ACQUISITION_REQUEST_VERSION_V1 = 'wallet_wide_acquisition_request_v1';
export const WALLET_ACQUISITION_REQUEST_VERSION_V2 = 'wallet_wide_acquisition_request_v2';
export const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const LOOKBACK_SECONDS_BY_PROFILE_V1 = Object.freeze({
  lookback_7d_v1: 604800,
  lookback_30d_v1: 2592000,
  lookback_90d_v1: 7776000,
  lookback_180d_v1: 15552000,
});
export const MAX_ANCHOR_SEARCH_SLOTS_V1 = 32;
export const MAX_PAGES_V1 = 100;
export const MAX_TRANSACTIONS_V1 = 10000;
export const MAX_ATTEMPTS_PER_OPERATION_V1 = 8;
export const MAX_REQUEST_TIMEOUT_MS_V1 = 60000;
export const MAX_OVERALL_TIMEOUT_MS_V1 = 300000;
export const PAGE_SIZE_V1 = 100;
export const MAX_EXACT_FALLBACK_TRANSACTIONS_V2 = 8;


const REQUEST_FIELDS = ['request_version','chain','network','genesis_hash','wallet','window','finality','budgets','profiles'];
const WINDOW_FIELDS = ['window_version','lookback_profile','requested_lookback_seconds','initial_before_signature'];
const FINALITY_FIELDS = ['commitment','boundary_profile','max_anchor_search_slots'];
const BUDGET_FIELDS_V1 = ['pagination_profile','page_size','max_pages','max_transactions','retry_profile','max_attempts_per_operation','timeout_profile','request_timeout_ms','overall_timeout_ms'];
const BUDGET_FIELDS_V2 = [...BUDGET_FIELDS_V1, 'exact_fallback_profile','max_exact_fallback_transactions'];
const PROFILE_FIELDS = ['wallet_acquisition_profile','wallet_normalization_profile'];


function validateRequestShape(request, budgetFields) {
  assertPlainDataV1(request, 'invalid_acquisition_request');
  assertExactFieldsV1(request, REQUEST_FIELDS);
  assertExactFieldsV1(request.window, WINDOW_FIELDS);
  assertExactFieldsV1(request.finality, FINALITY_FIELDS);
  assertExactFieldsV1(request.budgets, budgetFields);
  assertExactFieldsV1(request.profiles, PROFILE_FIELDS);
}

export function validateWalletAcquisitionRequestV1(request) {
  validateRequestShape(request, BUDGET_FIELDS_V1);
  if (request.request_version !== WALLET_ACQUISITION_REQUEST_VERSION_V1) failWalletAcquisitionV1('invalid_acquisition_request');
  if (request.chain !== 'solana' || request.network !== 'mainnet-beta' || request.genesis_hash !== SOLANA_MAINNET_GENESIS_HASH) failWalletAcquisitionV1('chain_identity_mismatch');
  if (!isSolanaPublicKeyV1(request.wallet)) failWalletAcquisitionV1('invalid_acquisition_request');

  const window = request.window;
  if (window.window_version !== 'fixed_lookback_latest_state_v1' || window.initial_before_signature !== null) failWalletAcquisitionV1('invalid_acquisition_request');
  if (!Object.hasOwn(LOOKBACK_SECONDS_BY_PROFILE_V1, window.lookback_profile)) failWalletAcquisitionV1('unsupported_lookback_profile');
  if (window.requested_lookback_seconds !== LOOKBACK_SECONDS_BY_PROFILE_V1[window.lookback_profile]) failWalletAcquisitionV1('lookback_boundary_mismatch');

  const finality = request.finality;
  if (finality.commitment !== 'finalized' || finality.boundary_profile !== 'solana_finalized_anchor_v1' || finality.max_anchor_search_slots !== MAX_ANCHOR_SEARCH_SLOTS_V1) failWalletAcquisitionV1('invalid_acquisition_request');

  const budgets = request.budgets;
  if (budgets.pagination_profile !== 'helius_wallet_history_page_100_v1' || budgets.page_size !== PAGE_SIZE_V1 || budgets.retry_profile !== 'bounded_exponential_retry_v1' || budgets.timeout_profile !== 'bounded_provider_timeout_v1') failWalletAcquisitionV1('invalid_acquisition_request');
  for (const [field, maximum] of [
    ['max_pages', MAX_PAGES_V1],
    ['max_transactions', MAX_TRANSACTIONS_V1],
    ['max_attempts_per_operation', MAX_ATTEMPTS_PER_OPERATION_V1],
    ['request_timeout_ms', MAX_REQUEST_TIMEOUT_MS_V1],
    ['overall_timeout_ms', MAX_OVERALL_TIMEOUT_MS_V1],
  ]) {
    assertSafePositiveIntegerV1(budgets[field], 'invalid_acquisition_request');
    if (budgets[field] > maximum) failWalletAcquisitionV1('invalid_acquisition_request');
  }
  if (budgets.request_timeout_ms >= budgets.overall_timeout_ms) failWalletAcquisitionV1('invalid_acquisition_request');

  if (request.profiles.wallet_acquisition_profile !== 'wallet_wide_bounded_history_v1' || request.profiles.wallet_normalization_profile !== 'artifact_wallet_wide_solana_spot_normalization_v1') failWalletAcquisitionV1('invalid_acquisition_request');
  return true;
}

export function validateWalletAcquisitionRequestV2(request) {
  validateRequestShape(request, BUDGET_FIELDS_V2);
  if (request.request_version !== WALLET_ACQUISITION_REQUEST_VERSION_V2) failWalletAcquisitionV1('invalid_acquisition_request');
  if (request.chain !== 'solana' || request.network !== 'mainnet-beta' || request.genesis_hash !== SOLANA_MAINNET_GENESIS_HASH) failWalletAcquisitionV1('chain_identity_mismatch');
  if (!isSolanaPublicKeyV1(request.wallet)) failWalletAcquisitionV1('invalid_acquisition_request');

  const window = request.window;
  if (window.window_version !== 'fixed_lookback_latest_state_v1' || window.initial_before_signature !== null) failWalletAcquisitionV1('invalid_acquisition_request');
  if (!Object.hasOwn(LOOKBACK_SECONDS_BY_PROFILE_V1, window.lookback_profile)) failWalletAcquisitionV1('unsupported_lookback_profile');
  if (window.requested_lookback_seconds !== LOOKBACK_SECONDS_BY_PROFILE_V1[window.lookback_profile]) failWalletAcquisitionV1('lookback_boundary_mismatch');

  const finality = request.finality;
  if (finality.commitment !== 'finalized' || finality.boundary_profile !== 'solana_finalized_anchor_v1' || finality.max_anchor_search_slots !== MAX_ANCHOR_SEARCH_SLOTS_V1) failWalletAcquisitionV1('invalid_acquisition_request');

  const budgets = request.budgets;
  if (budgets.pagination_profile !== 'solana_full_transaction_page_100_v1' || budgets.page_size !== PAGE_SIZE_V1
      || budgets.retry_profile !== 'bounded_exponential_retry_v1' || budgets.timeout_profile !== 'bounded_provider_timeout_v1'
      || budgets.exact_fallback_profile !== 'finalized_get_transaction_missing_only_v1') failWalletAcquisitionV1('invalid_acquisition_request');
  for (const [field, maximum] of [
    ['max_pages', MAX_PAGES_V1],
    ['max_transactions', MAX_TRANSACTIONS_V1],
    ['max_attempts_per_operation', MAX_ATTEMPTS_PER_OPERATION_V1],
    ['request_timeout_ms', MAX_REQUEST_TIMEOUT_MS_V1],
    ['overall_timeout_ms', MAX_OVERALL_TIMEOUT_MS_V1],
  ]) {
    assertSafePositiveIntegerV1(budgets[field], 'invalid_acquisition_request');
    if (budgets[field] > maximum) failWalletAcquisitionV1('invalid_acquisition_request');
  }
  assertSafeNonnegativeIntegerV1(budgets.max_exact_fallback_transactions, 'invalid_acquisition_request');
  if (budgets.max_exact_fallback_transactions > MAX_EXACT_FALLBACK_TRANSACTIONS_V2
      || budgets.request_timeout_ms >= budgets.overall_timeout_ms) failWalletAcquisitionV1('invalid_acquisition_request');

  if (request.profiles.wallet_acquisition_profile !== 'wallet_wide_bounded_history_v1' || request.profiles.wallet_normalization_profile !== 'artifact_wallet_wide_solana_spot_normalization_v1') failWalletAcquisitionV1('invalid_acquisition_request');
  return true;
}

export function buildWalletAcquisitionRequestV1(input) {
  validateWalletAcquisitionRequestV1(input);
  return cloneAndFreezePlainDataV1(input);
}

export function buildWalletAcquisitionRequestV2(input) {
  validateWalletAcquisitionRequestV2(input);
  return cloneAndFreezePlainDataV1(input);
}
