#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAGINATION_FAILURE_REASONS_V1,
  PAGINATION_PHASES_V1,
  PAGINATION_SUCCESS_REASONS_V1,
  acceptWalletHistoryPageV1,
  advancePaginationPhaseV1,
  createPaginationStateV1,
  failPaginationStateV1,
  startPaginationV1,
  validatePaginationStateV1,
} from './pagination-contract.mjs';

function source(signature, slot, block_time) { return { signature, slot, block_time }; }
function descendingPage(count, { startSlot = 1000, startTime = 2000, prefix = 'sig' } = {}) {
  return Array.from({ length: count }, (_, index) => source(`${prefix}-${index}`, startSlot - index, startTime - index));
}
function initial(overrides = {}) {
  return createPaginationStateV1({ oldest_allowed_timestamp: 1000, page_size: 100, max_pages: 100, max_transactions: 10000, ...overrides });
}
function accept(state, page, before_signature = state.next_before_signature) {
  return acceptWalletHistoryPageV1(state, { before_signature, page });
}
function expectCode(fn, code) {
  assert.throws(fn, error => error?.name === 'WalletAcquisitionContractError' && error.code === code);
}
function finish(state) {
  for (const phase of ['enriching', 'classifying', 'reconciling', 'complete']) state = advancePaginationPhaseV1(state, phase);
  return state;
}

test('exports the exact phase and terminal-reason vocabularies', () => {
  assert.deepEqual(PAGINATION_PHASES_V1, ['unstarted','acquiring_head','paginating','lower_bound_reached','provider_exhausted','enriching','classifying','reconciling','complete']);
  assert.deepEqual(PAGINATION_SUCCESS_REASONS_V1, ['historical_bound_reached','provider_exhaustion']);
  assert.deepEqual(PAGINATION_FAILURE_REASONS_V1, ['pagination_incomplete','acquisition_capped','acquisition_truncated','provider_uncertain','acquisition_deadline_exceeded','latest_state_unproven','lower_bound_unproven']);
});

test('accepts empty-wallet and one-short-page provider exhaustion', () => {
  let empty = startPaginationV1(initial());
  empty = accept(empty, [], null);
  assert.equal(empty.phase, 'provider_exhausted');
  assert.equal(empty.pagination_terminal_reason, 'provider_exhaustion');
  assert.equal(empty.lower_bound_proven, true);
  assert.equal(empty.pagination_complete, true);
  assert.equal(empty.pages_accepted, 1);
  assert.equal(empty.provider_entries_examined, 0);
  assert.deepEqual(finish(empty).in_window_sources, []);

  let short = startPaginationV1(initial());
  short = accept(short, descendingPage(2), null);
  assert.equal(short.phase, 'provider_exhausted');
  assert.equal(short.pagination_terminal_reason, 'provider_exhaustion');
  assert.equal(short.provider_entries_examined, 2);
  assert.equal(short.in_window_sources.length, 2);
  assert.equal(finish(short).status, 'successful');
});

test('paginates two pages and permits a genuine empty terminal page after a full page', () => {
  let twoPages = startPaginationV1(initial());
  const first = descendingPage(100);
  twoPages = accept(twoPages, first, null);
  assert.equal(twoPages.phase, 'paginating');
  assert.equal(twoPages.next_before_signature, first.at(-1).signature);
  const second = descendingPage(2, { startSlot: 900, startTime: 1900, prefix: 'second' });
  twoPages = accept(twoPages, second);
  assert.equal(twoPages.phase, 'provider_exhausted');
  assert.equal(twoPages.pages_accepted, 2);
  assert.equal(twoPages.provider_entries_examined, 102);

  let exactMultiple = startPaginationV1(initial());
  exactMultiple = accept(exactMultiple, first, null);
  exactMultiple = accept(exactMultiple, []);
  assert.equal(exactMultiple.phase, 'provider_exhausted');
  assert.equal(exactMultiple.pages_accepted, 2);
  assert.equal(exactMultiple.provider_entries_examined, 100);
  assert.equal(finish(exactMultiple).status, 'successful');
});

test('includes an exact-bound transaction and excludes the first older sentinel', () => {
  let state = startPaginationV1(initial({ oldest_allowed_timestamp: 80 }));
  state = accept(state, [source('new', 10, 100), source('at-bound', 9, 80), source('older', 8, 79), source('older-2', 7, 78)], null);
  assert.equal(state.phase, 'lower_bound_reached');
  assert.equal(state.pagination_terminal_reason, 'historical_bound_reached');
  assert.deepEqual(state.in_window_sources.map(item => item.signature), ['new', 'at-bound']);
  assert.deepEqual(state.lower_bound_sentinel, source('older', 8, 79));
  assert.equal(state.provider_entries_examined, 4);
  assert.equal(state.next_before_signature, null);
  assert.equal(finish(state).status, 'successful');
});

test('rejects invalid, echoed, repeated, and non-progressing cursors', () => {
  let state = startPaginationV1(initial());
  const first = descendingPage(100);
  state = accept(state, first, null);
  expectCode(() => accept(state, [], ''), 'pagination_cursor_invalid');
  expectCode(() => accept(state, [], 'not-the-derived-cursor'), 'pagination_cursor_invalid');
  expectCode(() => accept(state, [source(state.next_before_signature, 900, 1900)]), 'pagination_cursor_repeated');
  expectCode(() => accept(state, [first[50]]), 'pagination_cursor_repeated');
});

test('rejects order increases, equal duplicates, conflicting duplicates, and page overlap', () => {
  let state = startPaginationV1(initial());
  expectCode(() => accept(state, [source('a', 10, 10), source('b', 11, 9)], null), 'pagination_order_invalid');
  expectCode(() => accept(state, [source('a', 10, 10), source('b', 9, 11)], null), 'pagination_order_invalid');
  expectCode(() => accept(state, [source('a', 10, 10), source('a', 10, 10)], null), 'pagination_duplicate_conflict');
  expectCode(() => accept(state, [source('a', 10, 10), source('a', 9, 9)], null), 'pagination_duplicate_conflict');

  const first = descendingPage(100);
  state = accept(state, first, null);
  expectCode(() => accept(state, [source(first[50].signature, first[50].slot, first[50].block_time)]), 'pagination_cursor_repeated');
  expectCode(() => accept(state, [source(first[50].signature, first[50].slot - 1, first[50].block_time - 1)]), 'pagination_duplicate_conflict');
});

test('fails closed on a null block time and malformed page or source fields', () => {
  let state = startPaginationV1(initial());
  expectCode(() => accept(state, [source('a', 1, null)], null), 'pagination_incomplete');
  expectCode(() => accept(state, [source('', 1, 1)], null), 'pagination_incomplete');
  expectCode(() => accept(state, [{ signature: 'a', slot: 1, block_time: 1, raw: true }], null), 'pagination_incomplete');
  expectCode(() => accept(state, new Array(2), null), 'pagination_incomplete');
  expectCode(() => accept(state, descendingPage(101), null), 'pagination_incomplete');
});

test('turns page and transaction limits into terminal capped states before proof', () => {
  let pageCapped = startPaginationV1(initial({ max_pages: 1 }));
  pageCapped = accept(pageCapped, descendingPage(100), null);
  assert.equal(pageCapped.status, 'failed');
  assert.equal(pageCapped.pagination_terminal_reason, 'acquisition_capped');
  assert.equal(pageCapped.capped, true);
  expectCode(() => advancePaginationPhaseV1(pageCapped, 'enriching'), 'acquisition_capped');

  let transactionCapped = startPaginationV1(initial({ max_transactions: 99 }));
  transactionCapped = accept(transactionCapped, descendingPage(100), null);
  assert.equal(transactionCapped.status, 'failed');
  assert.equal(transactionCapped.pagination_terminal_reason, 'acquisition_capped');
  assert.equal(transactionCapped.provider_entries_examined, 0);
});

test('models timeout, truncation, provider uncertainty, and incomplete lower-bound failures', () => {
  const active = startPaginationV1(initial());
  for (const reason of PAGINATION_FAILURE_REASONS_V1) {
    const failed = failPaginationStateV1(active, reason);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.pagination_terminal_reason, reason);
    assert.equal(failed.pagination_complete, false);
    assert.equal(validatePaginationStateV1(failed), true);
    assert.equal(failed.capped, reason === 'acquisition_capped');
    assert.equal(failed.truncated, reason === 'acquisition_truncated');
    assert.equal(failed.provider_uncertain, reason === 'provider_uncertain');
    expectCode(() => advancePaginationPhaseV1(failed, 'enriching'), reason);
  }
});

test('complete is reachable only through the exact successful phase sequence', () => {
  let state = startPaginationV1(initial());
  state = accept(state, [], null);
  expectCode(() => advancePaginationPhaseV1(state, 'complete'), 'pagination_incomplete');
  state = advancePaginationPhaseV1(state, 'enriching');
  expectCode(() => advancePaginationPhaseV1(state, 'reconciling'), 'pagination_incomplete');
  state = advancePaginationPhaseV1(state, 'classifying');
  state = advancePaginationPhaseV1(state, 'reconciling');
  state = advancePaginationPhaseV1(state, 'complete');
  assert.equal(state.phase, 'complete');
  assert.equal(state.status, 'successful');
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.in_window_sources));
  assert.doesNotThrow(() => validatePaginationStateV1(state));

  for (const [attack, expectedCode] of [
    [{ capped: true }, 'acquisition_capped'],
    [{ truncated: true }, 'acquisition_truncated'],
    [{ provider_uncertain: true }, 'provider_uncertain'],
    [{ lower_bound_proven: false }, 'lower_bound_unproven'],
    [{ pagination_complete: false }, 'pagination_incomplete'],
    [{ pagination_terminal_reason: 'acquisition_capped' }, 'pagination_incomplete'],
    [{ status: 'active' }, 'pagination_incomplete'],
  ]) {
    const forged = { ...structuredClone(state), ...attack };
    expectCode(() => validatePaginationStateV1(forged), expectedCode);
  }

  let populated = accept(startPaginationV1(initial()), [source('kept', 2, 2000), source('dropped', 1, 1999)]);
  for (const phase of ['enriching','classifying','reconciling','complete']) populated = advancePaginationPhaseV1(populated, phase);
  const dropped = structuredClone(populated);
  dropped.in_window_sources.pop();
  expectCode(() => validatePaginationStateV1(dropped), 'pagination_incomplete');

  const fullOnly = accept(startPaginationV1(initial()), descendingPage(100, { prefix: 'forge', startSlot: 1000, startTime: 3000 }));
  expectCode(() => validatePaginationStateV1({
    ...fullOnly,
    phase: 'complete',
    status: 'successful',
    pagination_terminal_reason: 'provider_exhaustion',
    next_before_signature: null,
    lower_bound_proven: true,
    pagination_complete: true,
  }), 'pagination_incomplete');

  const bounded = accept(startPaginationV1(initial({ oldest_allowed_timestamp: 100 })), [
    source('newer', 3, 101), source('first-old', 2, 99), source('later-old', 1, 98),
  ]);
  expectCode(() => validatePaginationStateV1({ ...bounded, lower_bound_sentinel: bounded.seen_sources.at(-1) }), 'pagination_incomplete');
});
