#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { QUOTE_MINTS } from '../pipeline/constants.mjs';
import { validateDispositionAccountingV1 } from '../candidate-set/dispositions.mjs';
import {
  buildWalletSourceTransactionV1,
  validateWalletSourceTransactionV1,
} from './source-transaction.mjs';
import { classifyWalletSourceTransactionV1 } from './transaction-classifier.mjs';
import {
  CLASSIFIER_FIXTURES as F,
  JUP,
  RAY,
  SUPPORTED_EVENTS,
  USDC,
  USDT,
  WALLET,
  WSOL,
  outcomeNormalizer,
  supportedNormalizer,
} from './fixtures/classifier-fixtures.mjs';

function classify(sourceTransaction, normalizer = outcomeNormalizer('no_supported_operation')) {
  return classifyWalletSourceTransactionV1({ sourceTransaction, normalizeSupportedSpotOperation: normalizer });
}

function expectCode(fn, code) {
  assert.throws(fn, error => error?.name === 'WalletAcquisitionContractError'
    && error.code === code
    && error.cause === undefined
    && Object.keys(error.details ?? {}).length === 0);
}

function assertFrozenGraph(value) {
  assert.ok(Object.isFrozen(value));
  if (value !== null && typeof value === 'object') for (const child of Object.values(value)) assertFrozenGraph(child);
}

function assertOutcome(result, type, eventCount, findingCount) {
  assert.equal(result.disposition.disposition_type, type);
  assert.equal(result.normalized_event_records.length, eventCount);
  assert.equal(result.activity_findings.length, findingCount);
  assert.equal(result.disposition.normalized_event_digests.length, eventCount);
  assert.equal(result.disposition.finding_digests.length, findingCount);
  assertFrozenGraph(result);
}

test('builds a closed provider-neutral detached and canonically ordered source transaction', () => {
  const input = structuredClone(F.twoSwaps);
  input.token_operations.reverse();
  input.recognized_programs.push({ program_id: 'token-program', program_role: 'token' });
  input.recognized_programs.reverse();
  const built = buildWalletSourceTransactionV1(input);
  assert.equal(validateWalletSourceTransactionV1(built), true);
  assert.deepEqual(built.token_operations.map(item => item.operation_id), ['jup-in', 'ray-in', 'usdc-out', 'usdt-out']);
  assert.deepEqual(built.recognized_programs.map(item => item.program_id), ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'token-program']);
  input.token_operations[0].mint = 'mutated';
  assert.notEqual(built.token_operations[0].mint, 'mutated');
  assertFrozenGraph(built);

  for (const forbidden of ['raw_response','url','headers','credential','provider_error','retry_history','local_path','job_state']) {
    const invalid = structuredClone(F.supportedBuy);
    invalid[forbidden] = 'forbidden';
    expectCode(() => buildWalletSourceTransactionV1(invalid), 'invalid_source_transaction');
  }
});

test('emits supported buy and sell only after the injected event reconciles exactly', () => {
  const buy = classify(F.supportedBuy, supportedNormalizer(SUPPORTED_EVENTS.supportedBuy));
  assertOutcome(buy, 'supported_normalized_event', 1, 0);
  assert.deepEqual(buy.disposition.affected_token_mints, [JUP]);
  assert.equal(buy.normalized_event_records[0].slice7_event.token_in_mint, USDC);

  const sell = classify(F.supportedSell, supportedNormalizer(SUPPORTED_EVENTS.supportedSell));
  assertOutcome(sell, 'supported_normalized_event', 1, 0);
  assert.deepEqual(sell.disposition.affected_token_mints, [JUP]);
  assert.equal(sell.normalized_event_records[0].slice7_event.token_out_mint, USDT);
});

test('accepts caller-assigned dense wallet-wide raw indexes that reconcile across source transactions', () => {
  const buy = classify(F.supportedBuy, supportedNormalizer(SUPPORTED_EVENTS.supportedBuy));
  const sellEvent = { ...SUPPORTED_EVENTS.supportedSell, raw_index: 1 };
  const sell = classify(F.supportedSell, supportedNormalizer(sellEvent));
  assert.doesNotThrow(() => validateDispositionAccountingV1({
    transactionDispositions: [buy.disposition, sell.disposition],
    normalizedEventRecords: [buy.normalized_event_records[0], sell.normalized_event_records[0]],
    activityFindings: [],
    wallet: WALLET,
    anchorSlot: 1000,
  }));
});

test('accounts explicitly for failed and unrelated transactions without events or findings', () => {
  assertOutcome(classify(F.failed), 'failed_transaction', 0, 0);
  for (const fixture of [F.quoteOnlyTransfer, F.metadataOnly, F.closeAccountNoMovement]) {
    const result = classify(fixture);
    assertOutcome(result, 'unrelated_activity', 0, 0);
    assert.deepEqual(result.disposition.affected_token_mints, []);
  }
});

test('localizes transfers and unsupported swap shapes to nonquote position tokens only', () => {
  for (const [fixture, tokens, quotes] of [
    [F.nonquoteTransferIn, [JUP], []],
    [F.nonquoteTransferOut, [RAY], []],
    [F.tokenToToken, [RAY, JUP].sort(), []],
    [F.swapPlusTransfer, [JUP], [USDC]],
    [F.twoSwaps, [RAY, JUP].sort(), [USDC, USDT].sort()],
    [F.severalOutputs, [RAY, JUP].sort(), [USDC]],
    [F.wrongFeePayer, [JUP], [USDC]],
    [F.commonQuoteContext, [JUP], [USDC]],
    [F.commonQuoteContextRay, [RAY], [USDC]],
  ]) {
    const result = classify(fixture);
    assertOutcome(result, 'unsupported_activity', 0, tokens.length);
    assert.deepEqual(result.disposition.affected_token_mints, tokens);
    assert.deepEqual(result.activity_findings.flatMap(item => item.affected_token_mints).sort(), tokens);
    for (const finding of result.activity_findings) {
      assert.deepEqual(finding.affected_quote_mints, quotes);
      assert.ok(finding.affected_token_mints.every(mint => ![WSOL, USDC, USDT].includes(mint)));
      assert.ok(finding.affected_quote_mints.every(mint => !finding.affected_token_mints.includes(mint)));
    }
  }
});

test('emits localized or wallet-wide ambiguity without losing determinable tokens', () => {
  const one = classify(F.ambiguousOneToken);
  assertOutcome(one, 'ambiguous_activity', 0, 1);
  assert.deepEqual(one.disposition.affected_token_mints, [JUP]);
  assert.deepEqual(one.activity_findings[0].affected_quote_mints, [USDC]);

  const several = classify(F.ambiguousSeveralTokens);
  assertOutcome(several, 'ambiguous_activity', 0, 2);
  assert.deepEqual(several.disposition.affected_token_mints, [RAY, JUP].sort());

  const walletWide = classify(F.walletWideUnknownMint);
  assertOutcome(walletWide, 'ambiguous_activity', 0, 1);
  assert.equal(walletWide.activity_findings[0].impact_scope, 'wallet_wide');
  assert.deepEqual(walletWide.disposition.affected_token_mints, []);
});

test('quote-mint closure with unresolved rent destination remains wallet-wide material', () => {
  const source = structuredClone(F.closeAccountNoMovement);
  source.token_operations[0].mint = USDC;
  const unresolvedRent = structuredClone(F.walletWideUnknownMint.token_operations[0]);
  unresolvedRent.operation_id = 'external-closure-rent';
  unresolvedRent.mint = USDC;
  source.token_operations.push(unresolvedRent);

  const result = classify(source);
  assertOutcome(result, 'ambiguous_activity', 0, 1);
  assert.equal(result.activity_findings[0].impact_scope, 'wallet_wide');
  assert.deepEqual(result.disposition.affected_token_mints, []);
});

test('does not trust provider classification and accepts UNKNOWN with complete source evidence', () => {
  const result = classify(F.unknownProvider, supportedNormalizer(SUPPORTED_EVENTS.unknownProvider));
  assertOutcome(result, 'supported_normalized_event', 1, 0);
  assert.deepEqual(result.disposition.affected_token_mints, [RAY]);
});

test('uses a detached quote-set snapshot for deterministic localization', () => {
  assert.equal(QUOTE_MINTS.delete(USDC), true);
  try {
    assert.equal(classify(F.quoteOnlyTransfer).disposition.disposition_type, 'unrelated_activity');
    const localized = classify(F.commonQuoteContext);
    assert.deepEqual(localized.disposition.affected_token_mints, [JUP]);
    assert.deepEqual(localized.activity_findings[0].affected_quote_mints, [USDC]);
  } finally {
    QUOTE_MINTS.add(USDC);
  }

  const expected = classify(F.supportedBuy, supportedNormalizer(SUPPORTED_EVENTS.supportedBuy));
  try {
    const result = classify(F.supportedBuy, input => {
      QUOTE_MINTS.delete(USDC);
      return supportedNormalizer(SUPPORTED_EVENTS.supportedBuy)(input);
    });
    assert.deepEqual(result, expected);
  } finally {
    QUOTE_MINTS.add(USDC);
  }
});

test('whole-transaction material-operation detection prevents attractive partial normalization', () => {
  let calls = 0;
  const tempting = () => { calls += 1; return { outcome: 'supported_event', event: SUPPORTED_EVENTS.supportedBuy }; };
  for (const fixture of [F.swapPlusTransfer, F.twoSwaps, F.severalOutputs, F.commonQuoteContext]) {
    assert.equal(classify(fixture, tempting).disposition.disposition_type, 'unsupported_activity');
  }
  const swapPlusUnclassifiable = structuredClone(F.supportedBuy);
  swapPlusUnclassifiable.token_operations.push({
    operation_id: 'unknown-close-effect', economic_group: null, operation_kind: 'account_close',
    direction: 'unknown', owner: WALLET, mint: RAY, amount: null, decimals: null,
  });
  assert.equal(classify(swapPlusUnclassifiable, tempting).disposition.disposition_type, 'ambiguous_activity');
  assert.equal(calls, 0);
});

test('operation ordering permutations produce byte-equivalent classification output', () => {
  const original = classify(F.twoSwaps);
  const permuted = structuredClone(F.twoSwaps);
  permuted.token_operations.reverse();
  permuted.recognized_programs.reverse();
  assert.deepEqual(classify(permuted), original);
});

test('source, finding, event, and disposition references reconcile', () => {
  const unsupported = classify(F.nonquoteTransferIn);
  assert.equal(unsupported.activity_findings[0].source_transaction_digests[0], unsupported.source_transaction_digest);
  assert.deepEqual(unsupported.disposition.finding_digests, unsupported.activity_findings.map(item => item.finding_digest));
  const supported = classify(F.supportedBuy, supportedNormalizer(SUPPORTED_EVENTS.supportedBuy));
  assert.deepEqual(supported.disposition.normalized_event_digests, supported.normalized_event_records.map(item => item.event_digest));
  assert.equal(supported.disposition.tx_hash, supported.source_transaction.signature);
  assert.equal(supported.disposition.slot, supported.source_transaction.slot);
  assert.equal(supported.disposition.block_time, supported.source_transaction.block_time);
});

test('maps subordinate closed outcomes without surrendering final disposition authority', () => {
  assertOutcome(classify(F.supportedBuy, outcomeNormalizer('unsupported_shape')), 'unsupported_activity', 0, 1);
  assertOutcome(classify(F.supportedBuy, outcomeNormalizer('ambiguous_shape')), 'ambiguous_activity', 0, 1);
  assertOutcome(classify(F.supportedBuy, outcomeNormalizer('no_supported_operation')), 'ambiguous_activity', 0, 1);
  expectCode(() => classify(F.supportedBuy, () => ({ outcome: 'supported_event', event: null, raw: 'provider' })), 'normalization_failed');
  expectCode(() => classify(F.supportedBuy, () => { throw new Error('secret https://provider.invalid /root/key'); }), 'normalization_failed');
});

test('rejects normalized events that do not reconcile with wallet, source, amounts, mints, slot, or evidence', () => {
  for (const mutation of [
    { wallet: 'other-wallet' }, { tx_hash: 'other-signature' }, { timestamp: 1 },
    { token_in_amount: 26 }, { token_out_mint: RAY },
    { source: 'provider_raw' }, { extraction_method: 'other' },
  ]) {
    const event = { ...SUPPORTED_EVENTS.supportedBuy, ...mutation };
    expectCode(() => classify(F.supportedBuy, supportedNormalizer(event)), 'source_transaction_mismatch');
  }
});

test('rejects malformed, hostile, conflicting, or ownership-incoherent source evidence with stable sanitized codes', () => {
  const conflicts = [
    { ...structuredClone(F.failed), provider_failure_indicator: 'succeeded' },
    { ...structuredClone(F.supportedBuy), provider_failure_indicator: 'failed' },
    { ...structuredClone(F.supportedBuy), fee_payer: '' },
    { ...structuredClone(F.supportedBuy), token_operations: [{ ...F.supportedBuy.token_operations[0], owner: 'other-wallet' }] },
  ];
  for (const invalid of conflicts) expectCode(() => classify(invalid), 'invalid_source_transaction');

  const accessor = structuredClone(F.supportedBuy);
  Object.defineProperty(accessor, 'signature', { enumerable: true, get() { throw new Error('secret'); } });
  expectCode(() => classify(accessor), 'invalid_source_transaction');
  expectCode(() => classify(new Proxy({}, {})), 'invalid_source_transaction');
  let proxyTrapCalls = 0;
  const hostileEnvelope = new Proxy({}, { ownKeys() { proxyTrapCalls += 1; throw new Error('secret'); } });
  expectCode(() => classifyWalletSourceTransactionV1(hostileEnvelope), 'invalid_source_transaction');
  assert.equal(proxyTrapCalls, 0);
});

test('classifies native SOL as quote context and keeps returned values detached from all inputs', () => {
  const event = {
    wallet: WALLET,
    timestamp: F.nativeSolBuy.block_time,
    tx_hash: F.nativeSolBuy.signature,
    source: 'wallet_source_transaction_v1',
    token_in_mint: WSOL,
    token_in_amount: 0.025,
    token_in_decimals: 9,
    token_out_mint: JUP,
    token_out_amount: 100,
    token_out_decimals: 6,
    extraction_method: 'injected_wallet_spot_normalizer_v1',
    raw_index: 0,
  };
  const mutableSource = structuredClone(F.nativeSolBuy);
  const mutableEvent = structuredClone(event);
  const result = classify(mutableSource, supportedNormalizer(mutableEvent));
  assertOutcome(result, 'supported_normalized_event', 1, 0);
  mutableSource.token_operations[0].mint = RAY;
  mutableEvent.token_out_mint = RAY;
  assert.equal(result.normalized_event_records[0].slice7_event.token_out_mint, JUP);
  assert.deepEqual(result.disposition.affected_token_mints, [JUP]);
});
