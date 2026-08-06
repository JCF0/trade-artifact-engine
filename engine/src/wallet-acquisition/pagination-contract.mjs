import {
  assertExactFieldsV1,
  assertPlainDataV1,
  assertSafeNonnegativeIntegerV1,
  assertSafePositiveIntegerV1,
  cloneAndFreezePlainDataV1,
  failWalletAcquisitionV1,
} from './errors.mjs';
import { isSolanaSignatureV1 } from './solana-identities.mjs';
import {
  MAX_PAGES_V1,
  MAX_TRANSACTIONS_V1,
  PAGE_SIZE_V1,
} from './request-contract.mjs';

export const PAGINATION_STATE_VERSION_V1 = 'wallet_history_pagination_state_v1';
export const PAGINATION_PHASES_V1 = Object.freeze(['unstarted','acquiring_head','paginating','lower_bound_reached','provider_exhausted','enriching','classifying','reconciling','complete']);
export const PAGINATION_SUCCESS_REASONS_V1 = Object.freeze(['historical_bound_reached','provider_exhaustion']);
export const PAGINATION_FAILURE_REASONS_V1 = Object.freeze(['pagination_incomplete','acquisition_capped','acquisition_truncated','provider_uncertain','acquisition_deadline_exceeded','latest_state_unproven','lower_bound_unproven']);

const CONFIG_FIELDS = ['oldest_allowed_timestamp','page_size','max_pages','max_transactions'];
const PAGE_INPUT_FIELDS = ['before_signature','page'];
const SOURCE_FIELDS = ['signature','slot','block_time'];
const STATE_FIELDS = ['pagination_state_version','phase','status','pagination_terminal_reason','oldest_allowed_timestamp','page_size','max_pages','max_transactions','pages_accepted','accepted_page_lengths','provider_entries_examined','next_before_signature','last_source','seen_sources','in_window_sources','lower_bound_sentinel','lower_bound_proven','pagination_complete','capped','truncated','provider_uncertain'];
const ACTIVE_PHASES_AFTER_PAGINATION = ['lower_bound_reached','provider_exhausted','enriching','classifying','reconciling'];

function sourceEqual(left, right) {
  return left.signature === right.signature && left.slot === right.slot && left.block_time === right.block_time;
}

function validateSource(source) {
  assertExactFieldsV1(source, SOURCE_FIELDS, 'pagination_incomplete');
  if (!isSolanaSignatureV1(source.signature)) failWalletAcquisitionV1('pagination_incomplete');
  assertSafeNonnegativeIntegerV1(source.slot, 'pagination_incomplete');
  assertSafeNonnegativeIntegerV1(source.block_time, 'pagination_incomplete');
}

function validateSourceArray(sources) {
  if (!Array.isArray(sources)) failWalletAcquisitionV1('pagination_incomplete');
  const bySignature = new Map();
  let previous = null;
  for (const source of sources) {
    validateSource(source);
    const prior = bySignature.get(source.signature);
    if (prior !== undefined) failWalletAcquisitionV1('pagination_duplicate_conflict');
    bySignature.set(source.signature, source);
    if (previous !== null && (source.slot > previous.slot || source.block_time > previous.block_time)) failWalletAcquisitionV1('pagination_order_invalid');
    previous = source;
  }
}

function failForTerminalState(state) {
  if (state.status === 'failed') failWalletAcquisitionV1(state.pagination_terminal_reason);
  if (state.status === 'successful') failWalletAcquisitionV1('pagination_incomplete');
}

export function validatePaginationStateV1(state) {
  assertExactFieldsV1(state, STATE_FIELDS, 'pagination_incomplete');
  if (state.pagination_state_version !== PAGINATION_STATE_VERSION_V1 || !PAGINATION_PHASES_V1.includes(state.phase) || !['active','failed','successful'].includes(state.status)) failWalletAcquisitionV1('pagination_incomplete');
  assertSafeNonnegativeIntegerV1(state.oldest_allowed_timestamp, 'pagination_incomplete');
  if (state.page_size !== PAGE_SIZE_V1) failWalletAcquisitionV1('pagination_incomplete');
  assertSafePositiveIntegerV1(state.max_pages, 'pagination_incomplete');
  assertSafePositiveIntegerV1(state.max_transactions, 'pagination_incomplete');
  if (state.max_pages > MAX_PAGES_V1 || state.max_transactions > MAX_TRANSACTIONS_V1) failWalletAcquisitionV1('pagination_incomplete');
  assertSafeNonnegativeIntegerV1(state.pages_accepted, 'pagination_incomplete');
  assertSafeNonnegativeIntegerV1(state.provider_entries_examined, 'pagination_incomplete');
  if (!Array.isArray(state.accepted_page_lengths) || state.accepted_page_lengths.length !== state.pages_accepted) failWalletAcquisitionV1('pagination_incomplete');
  let acceptedEntryCount = 0;
  for (const pageLength of state.accepted_page_lengths) {
    if (!Number.isSafeInteger(pageLength) || pageLength < 0 || pageLength > state.page_size) failWalletAcquisitionV1('pagination_incomplete');
    acceptedEntryCount += pageLength;
  }
  if (acceptedEntryCount !== state.provider_entries_examined) failWalletAcquisitionV1('pagination_incomplete');
  if (state.pages_accepted > state.max_pages || state.provider_entries_examined > state.max_transactions) failWalletAcquisitionV1('pagination_incomplete');
  for (const field of ['lower_bound_proven','pagination_complete','capped','truncated','provider_uncertain']) if (typeof state[field] !== 'boolean') failWalletAcquisitionV1('pagination_incomplete');

  if (state.status !== 'failed') {
    if (state.capped) failWalletAcquisitionV1('acquisition_capped');
    if (state.truncated) failWalletAcquisitionV1('acquisition_truncated');
    if (state.provider_uncertain) failWalletAcquisitionV1('provider_uncertain');
  }

  validateSourceArray(state.seen_sources);
  validateSourceArray(state.in_window_sources);
  if (state.provider_entries_examined !== state.seen_sources.length) failWalletAcquisitionV1('pagination_incomplete');
  const seenBySignature = new Map(state.seen_sources.map(source => [source.signature, source]));
  for (const source of state.in_window_sources) {
    const seen = seenBySignature.get(source.signature);
    if (seen === undefined || !sourceEqual(seen, source) || source.block_time < state.oldest_allowed_timestamp) failWalletAcquisitionV1('pagination_incomplete');
  }
  if (state.last_source === null) {
    if (state.seen_sources.length !== 0) failWalletAcquisitionV1('pagination_incomplete');
  } else {
    validateSource(state.last_source);
    if (state.seen_sources.length === 0 || !sourceEqual(state.last_source, state.seen_sources.at(-1))) failWalletAcquisitionV1('pagination_incomplete');
  }
  if (state.lower_bound_sentinel !== null) {
    validateSource(state.lower_bound_sentinel);
    const seen = seenBySignature.get(state.lower_bound_sentinel.signature);
    if (seen === undefined || !sourceEqual(seen, state.lower_bound_sentinel) || state.lower_bound_sentinel.block_time >= state.oldest_allowed_timestamp) failWalletAcquisitionV1('pagination_incomplete');
  }
  const expectedInWindowSources = state.seen_sources.filter(source => source.block_time >= state.oldest_allowed_timestamp);
  if (expectedInWindowSources.length !== state.in_window_sources.length
      || expectedInWindowSources.some((source, index) => !sourceEqual(source, state.in_window_sources[index]))) failWalletAcquisitionV1('pagination_incomplete');
  const expectedSentinel = state.seen_sources.find(source => source.block_time < state.oldest_allowed_timestamp) ?? null;
  if ((expectedSentinel === null) !== (state.lower_bound_sentinel === null)
      || (expectedSentinel !== null && !sourceEqual(expectedSentinel, state.lower_bound_sentinel))) failWalletAcquisitionV1('pagination_incomplete');

  if (state.status === 'failed') {
    if (!PAGINATION_FAILURE_REASONS_V1.includes(state.pagination_terminal_reason) || state.pagination_complete) failWalletAcquisitionV1('pagination_incomplete');
    if (state.capped !== (state.pagination_terminal_reason === 'acquisition_capped')
      || state.truncated !== (state.pagination_terminal_reason === 'acquisition_truncated')
      || state.provider_uncertain !== (state.pagination_terminal_reason === 'provider_uncertain')
      || state.phase === 'complete') failWalletAcquisitionV1('pagination_incomplete');
    return true;
  }
  if (state.status === 'successful') {
    if (state.phase !== 'complete' || !PAGINATION_SUCCESS_REASONS_V1.includes(state.pagination_terminal_reason) || !state.pagination_complete) failWalletAcquisitionV1('pagination_incomplete');
  } else if (state.phase === 'complete') {
    failWalletAcquisitionV1('pagination_incomplete');
  }

  if (['unstarted','acquiring_head'].includes(state.phase)) {
    if (state.pages_accepted !== 0 || state.provider_entries_examined !== 0 || state.next_before_signature !== null || state.last_source !== null || state.lower_bound_sentinel !== null || state.lower_bound_proven || state.pagination_complete || state.pagination_terminal_reason !== null) failWalletAcquisitionV1('pagination_incomplete');
  } else if (state.phase === 'paginating') {
    if (state.pages_accepted === 0 || typeof state.next_before_signature !== 'string' || state.next_before_signature.length === 0 || state.last_source === null || state.next_before_signature !== state.last_source.signature || state.lower_bound_proven || state.pagination_complete || state.pagination_terminal_reason !== null) failWalletAcquisitionV1('pagination_incomplete');
  } else if (ACTIVE_PHASES_AFTER_PAGINATION.includes(state.phase) || state.phase === 'complete') {
    if (state.next_before_signature !== null || !state.lower_bound_proven || !state.pagination_complete || !PAGINATION_SUCCESS_REASONS_V1.includes(state.pagination_terminal_reason)) {
      if (!state.lower_bound_proven) failWalletAcquisitionV1('lower_bound_unproven');
      failWalletAcquisitionV1('pagination_incomplete');
    }
    if (state.pagination_terminal_reason === 'historical_bound_reached' && state.lower_bound_sentinel === null) failWalletAcquisitionV1('lower_bound_unproven');
    if (state.phase === 'lower_bound_reached' && state.pagination_terminal_reason !== 'historical_bound_reached') failWalletAcquisitionV1('pagination_incomplete');
    if (state.phase === 'provider_exhausted' && state.pagination_terminal_reason !== 'provider_exhaustion') failWalletAcquisitionV1('pagination_incomplete');
    if (state.pagination_terminal_reason === 'provider_exhaustion' && (state.accepted_page_lengths.length === 0 || state.accepted_page_lengths.at(-1) >= state.page_size)) failWalletAcquisitionV1('pagination_incomplete');
  }
  return true;
}

export function createPaginationStateV1(input) {
  assertExactFieldsV1(input, CONFIG_FIELDS, 'pagination_incomplete');
  assertSafeNonnegativeIntegerV1(input.oldest_allowed_timestamp, 'pagination_incomplete');
  if (input.page_size !== PAGE_SIZE_V1) failWalletAcquisitionV1('pagination_incomplete');
  assertSafePositiveIntegerV1(input.max_pages, 'pagination_incomplete');
  assertSafePositiveIntegerV1(input.max_transactions, 'pagination_incomplete');
  if (input.max_pages > MAX_PAGES_V1 || input.max_transactions > MAX_TRANSACTIONS_V1) failWalletAcquisitionV1('pagination_incomplete');
  return cloneAndFreezePlainDataV1({
    pagination_state_version: PAGINATION_STATE_VERSION_V1,
    phase: 'unstarted',
    status: 'active',
    pagination_terminal_reason: null,
    oldest_allowed_timestamp: input.oldest_allowed_timestamp,
    page_size: PAGE_SIZE_V1,
    max_pages: input.max_pages,
    max_transactions: input.max_transactions,
    pages_accepted: 0,
    accepted_page_lengths: [],
    provider_entries_examined: 0,
    next_before_signature: null,
    last_source: null,
    seen_sources: [],
    in_window_sources: [],
    lower_bound_sentinel: null,
    lower_bound_proven: false,
    pagination_complete: false,
    capped: false,
    truncated: false,
    provider_uncertain: false,
  }, 'pagination_incomplete');
}

export function startPaginationV1(state) {
  validatePaginationStateV1(state);
  failForTerminalState(state);
  if (state.phase !== 'unstarted') failWalletAcquisitionV1('pagination_incomplete');
  return cloneAndFreezePlainDataV1({ ...state, phase: 'acquiring_head' }, 'pagination_incomplete');
}

export function failPaginationStateV1(state, reason) {
  validatePaginationStateV1(state);
  failForTerminalState(state);
  if (!PAGINATION_FAILURE_REASONS_V1.includes(reason)) failWalletAcquisitionV1('pagination_incomplete');
  return cloneAndFreezePlainDataV1({
    ...state,
    status: 'failed',
    pagination_terminal_reason: reason,
    next_before_signature: null,
    pagination_complete: false,
    capped: reason === 'acquisition_capped',
    truncated: reason === 'acquisition_truncated',
    provider_uncertain: reason === 'provider_uncertain',
  }, 'pagination_incomplete');
}

export function acceptWalletHistoryPageV1(state, input) {
  validatePaginationStateV1(state);
  failForTerminalState(state);
  if (!['acquiring_head','paginating'].includes(state.phase)) failWalletAcquisitionV1('pagination_incomplete');
  assertExactFieldsV1(input, PAGE_INPUT_FIELDS, 'pagination_incomplete');
  const expectedCursor = state.phase === 'acquiring_head' ? null : state.next_before_signature;
  if (input.before_signature !== null && !isSolanaSignatureV1(input.before_signature)) failWalletAcquisitionV1('pagination_cursor_invalid');
  if (input.before_signature !== expectedCursor) failWalletAcquisitionV1('pagination_cursor_invalid');
  assertPlainDataV1(input.page, 'pagination_incomplete');
  if (!Array.isArray(input.page) || input.page.length > PAGE_SIZE_V1) failWalletAcquisitionV1('pagination_incomplete');
  validateSourceArray(input.page);

  const priorBySignature = new Map(state.seen_sources.map(source => [source.signature, source]));
  let previous = state.last_source;
  for (const source of input.page) {
    if (source.signature === input.before_signature) failWalletAcquisitionV1('pagination_cursor_repeated');
    const prior = priorBySignature.get(source.signature);
    if (prior !== undefined) {
      if (sourceEqual(prior, source)) failWalletAcquisitionV1('pagination_cursor_repeated');
      failWalletAcquisitionV1('pagination_duplicate_conflict');
    }
    if (previous !== null && (source.slot > previous.slot || source.block_time > previous.block_time)) failWalletAcquisitionV1('pagination_order_invalid');
    previous = source;
  }

  if (state.pages_accepted >= state.max_pages || state.provider_entries_examined + input.page.length > state.max_transactions) return failPaginationStateV1(state, 'acquisition_capped');

  const seenSources = [...state.seen_sources, ...input.page];
  const inWindowSources = [...state.in_window_sources];
  let sentinel = state.lower_bound_sentinel;
  for (const source of input.page) {
    if (source.block_time < state.oldest_allowed_timestamp) {
      if (sentinel === null) sentinel = source;
    } else if (sentinel === null) {
      inWindowSources.push(source);
    } else {
      failWalletAcquisitionV1('pagination_order_invalid');
    }
  }
  const pagesAccepted = state.pages_accepted + 1;
  const entriesExamined = state.provider_entries_examined + input.page.length;
  let next = {
    ...state,
    pages_accepted: pagesAccepted,
    accepted_page_lengths: [...state.accepted_page_lengths, input.page.length],
    provider_entries_examined: entriesExamined,
    last_source: input.page.length === 0 ? state.last_source : input.page.at(-1),
    seen_sources: seenSources,
    in_window_sources: inWindowSources,
    lower_bound_sentinel: sentinel,
  };

  if (sentinel !== null) {
    next = { ...next, phase: 'lower_bound_reached', pagination_terminal_reason: 'historical_bound_reached', next_before_signature: null, lower_bound_proven: true, pagination_complete: true };
  } else if (input.page.length < PAGE_SIZE_V1) {
    next = { ...next, phase: 'provider_exhausted', pagination_terminal_reason: 'provider_exhaustion', next_before_signature: null, lower_bound_proven: true, pagination_complete: true };
  } else {
    next = { ...next, phase: 'paginating', pagination_terminal_reason: null, next_before_signature: input.page.at(-1).signature, lower_bound_proven: false, pagination_complete: false };
  }
  next = cloneAndFreezePlainDataV1(next, 'pagination_incomplete');
  validatePaginationStateV1(next);
  if (next.phase === 'paginating' && (next.pages_accepted >= next.max_pages || next.provider_entries_examined >= next.max_transactions)) return failPaginationStateV1(next, 'acquisition_capped');
  return next;
}

export function advancePaginationPhaseV1(state, nextPhase) {
  validatePaginationStateV1(state);
  failForTerminalState(state);
  const allowed = {
    lower_bound_reached: 'enriching',
    provider_exhausted: 'enriching',
    enriching: 'classifying',
    classifying: 'reconciling',
    reconciling: 'complete',
  };
  if (allowed[state.phase] !== nextPhase) failWalletAcquisitionV1('pagination_incomplete');
  const next = cloneAndFreezePlainDataV1({
    ...state,
    phase: nextPhase,
    status: nextPhase === 'complete' ? 'successful' : 'active',
  }, 'pagination_incomplete');
  validatePaginationStateV1(next);
  return next;
}
