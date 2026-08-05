#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWalletSourceTransactionFromSpotEvidenceV1 } from './solana-spot-evidence.mjs';
import { classifyWalletSourceTransactionV1 } from './transaction-classifier.mjs';
import {
  NORMALIZER_OUTCOME_FIELDS_V1,
  normalizeWalletWideSolanaSpotEvidenceV1,
  validateWalletWideNormalizerOutcomeV1,
} from './wallet-wide-normalizer.mjs';
import {
  BONK, JUP, PROGRAMS, RAY, USDC, USDT, WALLET, WSOL,
  fallback, leg, spotEvidence, structured,
} from './fixtures/spot-normalizer-fixtures.mjs';

function normalize(evidence, provisionalRawIndex = 0) {
  return normalizeWalletWideSolanaSpotEvidenceV1({ evidence, provisional_raw_index: provisionalRawIndex });
}

function assertClosed(result, outcome) {
  assert.deepEqual(Object.keys(result), NORMALIZER_OUTCOME_FIELDS_V1);
  assert.equal(result.outcome, outcome);
  assert.equal(validateWalletWideNormalizerOutcomeV1(result), true);
  assert.ok(Object.isFrozen(result));
  for (const value of Object.values(result)) if (value !== null && typeof value === 'object') assert.ok(Object.isFrozen(value));
}

function assertSupported(evidence, expected, provisionalRawIndex = 0) {
  const result = normalize(evidence, provisionalRawIndex);
  assertClosed(result, 'supported_event');
  assert.deepEqual(result.affected_position_token_mints, [expected.position]);
  assert.deepEqual(result.affected_quote_mints, [expected.quote]);
  assert.equal(result.impact_scope, 'token_specific');
  assert.equal(result.reason_code, null);
  assert.deepEqual(result.event, {
    wallet: WALLET,
    timestamp: evidence.block_time,
    tx_hash: evidence.signature,
    source: 'wallet_source_transaction_v1',
    token_in_mint: expected.inputMint,
    token_in_amount: expected.inputAmount,
    token_in_decimals: expected.inputDecimals ?? 6,
    token_out_mint: expected.outputMint,
    token_out_amount: expected.outputAmount,
    token_out_decimals: expected.outputDecimals ?? 6,
    extraction_method: 'injected_wallet_spot_normalizer_v1',
    raw_index: provisionalRawIndex,
  });
  return result;
}

function assertOutcome(evidence, outcome, positions, quotes, reason, impact = positions.length ? 'token_specific' : 'none') {
  const result = normalize(evidence);
  assertClosed(result, outcome);
  assert.equal(result.event, null);
  assert.deepEqual(result.affected_position_token_mints, positions.slice().sort());
  assert.deepEqual(result.affected_quote_mints, quotes.slice().sort());
  assert.equal(result.reason_code, reason);
  assert.equal(result.impact_scope, impact);
  return result;
}

const buyExpected = { position: JUP, quote: USDC, inputMint: USDC, inputAmount: 25, outputMint: JUP, outputAmount: 100 };
const sellExpected = { position: JUP, quote: USDT, inputMint: JUP, inputAmount: 100, outputMint: USDT, outputAmount: 30 };

test('fixture matrix 1-4: JUP and RAY structured buys and sells', () => {
  assertSupported(structured('jup-buy'), buyExpected);
  assertSupported(structured('jup-sell', { inputMint: JUP, inputRaw: '100000000', outputMint: USDT, outputRaw: '30000000' }), sellExpected);
  assertSupported(structured('ray-buy', { outputMint: RAY, outputRaw: '26644791399', program: PROGRAMS.raydium }), {
    position: RAY, quote: USDC, inputMint: USDC, inputAmount: 25, outputMint: RAY, outputAmount: 26644.791399,
  });
  assertSupported(structured('ray-sell', { inputMint: RAY, inputRaw: '26644791399', outputMint: USDT, outputRaw: '30000000000', program: PROGRAMS.raydium }), {
    position: RAY, quote: USDT, inputMint: RAY, inputAmount: 26644.791399, outputMint: USDT, outputAmount: 30000,
  });
});

test('fixture matrix 5-7: exact same-mint aggregation, permutation invariance, and duplicate inclusion', () => {
  const ray = structured('ray-aggregate', {
    outputMint: RAY,
    outputRaw: '26644791399',
    program: PROGRAMS.raydium,
    inputs: [
      leg.token('large-input', USDT, '24975000000', 6),
      leg.token('small-input', USDT, '25000000', 6),
    ],
  });
  const expected = { position: RAY, quote: USDT, inputMint: USDT, inputAmount: 25000, outputMint: RAY, outputAmount: 26644.791399 };
  const original = assertSupported(ray, expected);
  const permuted = structuredClone(ray);
  permuted.structured_swap_groups[0].token_inputs.reverse();
  assert.deepEqual(normalize(permuted), original);
  const duplicated = structuredClone(ray);
  duplicated.structured_swap_groups[0].token_inputs.push(leg.token('duplicate-input', USDT, '25000000', 6));
  assertSupported(duplicated, { ...expected, inputAmount: 25025 });
});

test('fixture matrix 8-10: mixed mints, mixed decimals, and multiple outputs fail closed', () => {
  const mixedMint = structured('mixed-mint', { inputs: [leg.token('a', USDC, '1000000'), leg.token('b', USDT, '1000000')] });
  assertOutcome(mixedMint, 'unsupported_shape', [JUP], [USDC, USDT], 'mixed_input_mints');
  const mixedDecimals = structured('mixed-decimals', { inputs: [leg.token('a', USDC, '1000000', 6), leg.token('b', USDC, '1000000', 9)] });
  assertOutcome(mixedDecimals, 'unsupported_shape', [JUP], [USDC], 'mixed_input_decimals');
  const outputs = structured('outputs', { outputs: [leg.token('a', JUP, '1000000'), leg.token('b', RAY, '1000000')] });
  assertOutcome(outputs, 'unsupported_shape', [JUP, RAY], [USDC], 'multiple_economic_outputs');
});

test('fixture matrix 11-13: Jupiter, Raydium, and Orca recognized-program fallback', () => {
  for (const [name, program] of Object.entries(PROGRAMS)) {
    assertSupported(fallback(`${name}-fallback`, { program }), buyExpected);
  }
});

test('fixture matrix 14-15: guarded native SOL buy and sell', () => {
  const buy = spotEvidence('native-buy', {
    provider_transaction_type: 'UNKNOWN',
    token_transfer_legs: [leg.transfer('jup-in', 'native-1', 'credit', JUP, '100000000')],
    native_sol_transfer_legs: [leg.nativeTransfer('sol-out', 'native-1', 'debit', 25_000_000)],
  });
  assertSupported(buy, { position: JUP, quote: WSOL, inputMint: WSOL, inputAmount: 0.025, inputDecimals: 9, outputMint: JUP, outputAmount: 100 });
  const sell = spotEvidence('native-sell', {
    provider_transaction_type: 'UNKNOWN',
    token_transfer_legs: [leg.transfer('jup-out', 'native-1', 'debit', JUP, '100000000')],
    native_sol_transfer_legs: [leg.nativeTransfer('sol-in', 'native-1', 'credit', 30_000_000)],
  });
  assertSupported(sell, { position: JUP, quote: WSOL, inputMint: JUP, inputAmount: 100, outputMint: WSOL, outputAmount: 0.03, outputDecimals: 9 });
  const closureRentLookalike = spotEvidence('native-close-rent-lookalike', {
    provider_transaction_type: 'CLOSE_ACCOUNT',
    token_transfer_legs: [leg.transfer('token-in', 'native-close', 'debit', JUP, '100000000')],
    native_sol_transfer_legs: [leg.nativeTransfer('rent-out', 'native-close', 'credit', 2_039_280)],
    account_closures: [{ closure_id: 'close-rent', owner: WALLET, mint: JUP }],
  });
  assertOutcome(closureRentLookalike, 'unsupported_shape', [JUP], [WSOL], 'native_side_with_account_close');
  const dust = structuredClone(buy);
  dust.native_sol_transfer_legs[0].amount_lamports = 999_999;
  assertOutcome(dust, 'unsupported_shape', [JUP], [WSOL], 'native_side_below_trade_threshold');
});

test('fixture matrix 16-20: CLOSE_ACCOUNT and UNKNOWN are evidence-driven, never type-code-driven', () => {
  const closeTrade = fallback('close-trade', { type: 'CLOSE_ACCOUNT' });
  closeTrade.account_closures.push({ closure_id: 'close-jup', owner: WALLET, mint: JUP });
  assertSupported(closeTrade, buyExpected);

  const closureOnly = spotEvidence('closure-only', {
    provider_transaction_type: 'CLOSE_ACCOUNT',
    account_closures: [{ closure_id: 'close-jup', owner: WALLET, mint: JUP }],
  });
  assertOutcome(closureOnly, 'no_supported_operation', [], [], 'no_economic_wallet_movement');

  const oneSided = spotEvidence('closure-movement', {
    provider_transaction_type: 'CLOSE_ACCOUNT',
    token_transfer_legs: [leg.transfer('jup-out', null, 'debit', JUP, '1000000')],
    account_closures: [{ closure_id: 'close-jup', owner: WALLET, mint: JUP }],
  });
  assertOutcome(oneSided, 'unsupported_shape', [JUP], [], 'one_sided_position_movement');

  assertSupported(fallback('unknown-valid', { type: 'UNKNOWN' }), buyExpected);
  assertOutcome(fallback('unknown-no-dex', { type: 'UNKNOWN', program: null }), 'unsupported_shape', [JUP], [USDC], 'recognized_dex_required');
});

test('fixture matrix 21-24: nonquote swap, quote transfer, self-transfer, and failed transaction', () => {
  assertOutcome(structured('token-token', { inputMint: JUP, outputMint: RAY }), 'unsupported_shape', [JUP, RAY], [], 'nonquote_to_nonquote');
  const quoteOnly = spotEvidence('quote-only', {
    provider_transaction_type: 'TRANSFER', recognized_programs: [],
    token_transfer_legs: [leg.transfer('usdc-in', null, 'credit', USDC, '1000000')],
  });
  assertOutcome(quoteOnly, 'no_supported_operation', [], [], 'quote_only_movement');
  const self = spotEvidence('self-transfer', {
    provider_transaction_type: 'TRANSFER', recognized_programs: [],
    unresolved_wallet_effects: [{ effect_id: 'self-transfer', mint: JUP }],
  });
  assertOutcome(self, 'ambiguous_shape', [JUP], [], 'unresolved_wallet_effect');
  const failed = structured('failed');
  failed.execution_state = 'failed';
  assertOutcome(failed, 'no_supported_operation', [], [], 'failed_transaction');
});

test('fixture matrix 25-27: extra transfer, two swaps, and several groups never select a best swap', () => {
  const extra = structured('extra-transfer');
  extra.token_transfer_legs.push(leg.transfer('extra-jup', 'extra-1', 'debit', JUP, '1000000'));
  assertOutcome(extra, 'unsupported_shape', [JUP], [USDC], 'multiple_material_operations');

  const conflictingDuplicateRepresentation = structured('conflicting-structured-fallback');
  conflictingDuplicateRepresentation.token_transfer_legs.push(
    leg.transfer('fallback-in', 'swap-1', 'debit', USDC, '25000000'),
    leg.transfer('fallback-out', 'swap-1', 'credit', JUP, '101000000'),
  );
  assertOutcome(conflictingDuplicateRepresentation, 'unsupported_shape', [JUP], [USDC], 'multiple_material_operations');

  const matchingDuplicateRepresentation = structured('matching-structured-fallback');
  matchingDuplicateRepresentation.token_transfer_legs.push(
    leg.transfer('fallback-in', 'swap-1', 'debit', USDC, '25000000'),
    leg.transfer('fallback-out', 'swap-1', 'credit', JUP, '100000000'),
  );
  assertSupported(matchingDuplicateRepresentation, buyExpected);

  const two = structured('two-swaps');
  two.structured_swap_groups.push({
    group_id: 'swap-2',
    token_inputs: [leg.token('ray-input', USDT, '30000000')],
    token_outputs: [leg.token('ray-output', RAY, '50000000')],
    native_inputs: [], native_outputs: [],
  });
  assertOutcome(two, 'unsupported_shape', [JUP, RAY], [USDC, USDT], 'multiple_material_operations');

  const groups = fallback('groups');
  groups.token_transfer_legs.push(
    leg.transfer('second-in', 'fallback-2', 'debit', USDT, '1000000'),
    leg.transfer('second-out', 'fallback-2', 'credit', RAY, '1000000'),
  );
  assertOutcome(groups, 'unsupported_shape', [JUP, RAY], [USDC, USDT], 'multiple_material_operations');
});

test('fixture matrix 28-30: ambiguous mint, operation permutation, and hostile malformed evidence', () => {
  const unknown = spotEvidence('unknown-effect', {
    provider_transaction_type: 'UNKNOWN',
    unresolved_wallet_effects: [{ effect_id: 'unknown-effect', mint: null }],
  });
  assertOutcome(unknown, 'ambiguous_shape', [], [], 'unresolved_wallet_effect', 'wallet_wide');

  const originalEvidence = fallback('order');
  const original = normalize(originalEvidence, 7);
  const permuted = structuredClone(originalEvidence);
  permuted.token_transfer_legs.reverse();
  permuted.recognized_programs.reverse();
  assert.deepEqual(normalize(permuted, 7), original);

  const hostile = structured('hostile');
  let calls = 0;
  Object.defineProperty(hostile, 'signature', { enumerable: true, get() { calls += 1; throw new Error('secret'); } });
  assert.throws(() => normalize(hostile), error => error?.code === 'invalid_spot_evidence' && error.stack === undefined);
  assert.equal(calls, 0);
});

test('supported result uses only the caller-supplied provisional raw index and integrates through Slice 2', () => {
  const evidence = structured('classifier-ray-aggregate', {
    outputMint: RAY,
    program: PROGRAMS.raydium,
    inputs: [leg.token('a', USDT, '24975000000'), leg.token('b', USDT, '25000000')],
  });
  const outcome = normalize(evidence, 12);
  assert.equal(outcome.event.raw_index, 12);
  const classified = classifyWalletSourceTransactionV1({
    sourceTransaction: buildWalletSourceTransactionFromSpotEvidenceV1(evidence),
    normalizeSupportedSpotOperation: () => outcome,
  });
  assert.equal(classified.disposition.disposition_type, 'supported_normalized_event');
  assert.equal(classified.normalized_event_records[0].slice7_event.raw_index, 12);
  assert.deepEqual(classified.disposition.affected_token_mints, [RAY]);

  const fallbackEvidence = fallback('classifier-fallback');
  const nativeEvidence = spotEvidence('classifier-native', {
    provider_transaction_type: 'UNKNOWN',
    token_transfer_legs: [leg.transfer('jup-in', 'native-1', 'credit', JUP, '100000000')],
    native_sol_transfer_legs: [leg.nativeTransfer('sol-out', 'native-1', 'debit', 25_000_000)],
  });
  const corroboratedEvidence = structured('classifier-corroborated');
  corroboratedEvidence.token_transfer_legs.push(
    leg.transfer('fallback-in', 'swap-1', 'debit', USDC, '25000000'),
    leg.transfer('fallback-out', 'swap-1', 'credit', JUP, '100000000'),
  );
  const corroboratedSource = buildWalletSourceTransactionFromSpotEvidenceV1(corroboratedEvidence);
  assert.equal(corroboratedSource.token_operations.length, 4);
  assert.deepEqual([...new Set(corroboratedSource.token_operations.map(operation => operation.operation_kind))].sort(), ['swap','transfer']);
  for (const value of [fallbackEvidence, nativeEvidence, corroboratedEvidence]) {
    const normalized = normalize(value, 13);
    const integrated = classifyWalletSourceTransactionV1({
      sourceTransaction: buildWalletSourceTransactionFromSpotEvidenceV1(value),
      normalizeSupportedSpotOperation: () => normalized,
    });
    assert.equal(integrated.disposition.disposition_type, 'supported_normalized_event');
  }

  const fractionalEvidence = structured('classifier-fractional', {
    outputMint: RAY,
    outputRaw: '1000000',
    inputs: [leg.token('a', USDT, '1', 1), leg.token('b', USDT, '2', 1)],
  });
  const fractionalOutcome = normalize(fractionalEvidence, 14);
  assert.equal(fractionalOutcome.event.token_in_amount, 0.3);
  const fractionalIntegrated = classifyWalletSourceTransactionV1({
    sourceTransaction: buildWalletSourceTransactionFromSpotEvidenceV1(fractionalEvidence),
    normalizeSupportedSpotOperation: () => fractionalOutcome,
  });
  assert.equal(fractionalIntegrated.disposition.disposition_type, 'supported_normalized_event');
});

test('normalizer outcomes are closed, detached, and reject structural mismatch with sanitized errors', () => {
  const evidence = structured('detached');
  const result = normalize(evidence);
  evidence.structured_swap_groups[0].token_inputs[0].mint = JUP;
  assert.equal(result.event.token_in_mint, USDC);
  assert.throws(() => validateWalletWideNormalizerOutcomeV1({ ...result, raw: 'provider-body' }), error => (
    error?.code === 'normalization_failed' && error.cause === undefined && error.stack === undefined
  ));
  for (const eventMutation of [
    { token_in_amount: -1 },
    { token_out_amount: Number.POSITIVE_INFINITY },
    { token_in_mint: result.event.token_out_mint },
    { source: 'other_source' },
    { extraction_method: 'other_method' },
    { raw_index: 1.5 },
  ]) {
    const forged = { ...result, event: { ...result.event, ...eventMutation } };
    assert.throws(() => validateWalletWideNormalizerOutcomeV1(forged), error => error?.code === 'normalization_failed');
  }
  assert.throws(() => validateWalletWideNormalizerOutcomeV1({
    ...result,
    affected_position_token_mints: [RAY],
  }), error => error?.code === 'normalization_failed');
  assert.throws(() => normalize(structured('bad-index'), -1), error => error?.code === 'normalization_failed');

  let getterCalls = 0;
  const hostileInput = { evidence: structured('hostile-envelope'), provisional_raw_index: 0 };
  Object.defineProperty(hostileInput, 'provisional_raw_index', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('secret'); },
  });
  assert.throws(() => normalizeWalletWideSolanaSpotEvidenceV1(hostileInput), error => error?.code === 'normalization_failed');
  assert.equal(getterCalls, 0);

  const hostileOutcome = { ...result };
  Object.defineProperty(hostileOutcome, 'reason_code', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('secret'); },
  });
  assert.throws(() => validateWalletWideNormalizerOutcomeV1(hostileOutcome), error => error?.code === 'normalization_failed');
  assert.equal(getterCalls, 0);
});

test('quote-only unresolved evidence does not invent a position or fail structurally', () => {
  for (const quoteMint of [USDC, USDT, WSOL]) {
    const evidence = spotEvidence(`quote-unresolved-${quoteMint.slice(0, 4)}`, {
      provider_transaction_type: 'UNKNOWN',
      unresolved_wallet_effects: [{ effect_id: 'quote-effect', mint: quoteMint }],
    });
    assertOutcome(evidence, 'no_supported_operation', [], [], 'quote_only_movement');
  }
});
