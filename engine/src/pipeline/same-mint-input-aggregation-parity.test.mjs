#!/usr/bin/env node

import assert from 'assert';
import { normalizeTransactions } from './ingest.mjs';
import { classifyAll, classifyTransaction, CLASSIFICATION } from './classifier.mjs';
import {
  aggregateSameMintInputsFromSwapEvent,
  aggregateSameMintInputsFromWalletTransfers,
  SAME_MINT_INPUT_AGGREGATION_FAILURES as FAILURE,
} from './same-mint-input-aggregation.mjs';
import { DEX_PROGRAMS, USDC_MINT, USDT_MINT, SOL_MINT } from './constants.mjs';

const WALLET = 'Wallet1111111111111111111111111111111111111';
const OTHER = 'Other11111111111111111111111111111111111111';
const RAY_MINT = '4k3Dyjzvzp8eXw3bFJ3hHnQ5XVkY6C4FfZbbQXfH7Y';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3Q7XBoMf4cQ3x3JqQdPqV9Vq9v';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function rawAmount(amount, decimals = 6) {
  return { tokenAmount: String(amount), decimals };
}

function swapTx(inputs, outputs, overrides = {}) {
  return {
    signature: overrides.signature || 'swap_tx',
    timestamp: overrides.timestamp ?? 1700000000,
    type: 'SWAP',
    source: 'JUPITER',
    transactionError: null,
    events: {
      swap: {
        tokenInputs: inputs.map(([mint, amount, decimals = 6]) => ({ mint, rawTokenAmount: rawAmount(amount, decimals) })),
        tokenOutputs: outputs.map(([mint, amount, decimals = 6]) => ({ mint, rawTokenAmount: rawAmount(amount, decimals) })),
        ...(overrides.swap || {}),
      },
    },
    tokenTransfers: [],
    nativeTransfers: overrides.nativeTransfers || [],
    instructions: [],
  };
}

function transferTx(inputs, outputs, overrides = {}) {
  return {
    signature: overrides.signature || 'transfer_tx',
    timestamp: overrides.timestamp ?? 1700000000,
    type: 'SWAP',
    source: 'JUPITER',
    transactionError: null,
    events: {},
    tokenTransfers: [
      ...inputs.map(([mint, amount, decimals = 6], index) => ({
        mint,
        tokenAmount: Number(amount) / Math.pow(10, decimals),
        rawTokenAmount: rawAmount(amount, decimals),
        fromUserAccount: WALLET,
        toUserAccount: `${OTHER}_${index}`,
      })),
      ...outputs.map(([mint, amount, decimals = 6], index) => ({
        mint,
        tokenAmount: Number(amount) / Math.pow(10, decimals),
        rawTokenAmount: rawAmount(amount, decimals),
        fromUserAccount: `${OTHER}_${index}`,
        toUserAccount: WALLET,
      })),
    ],
    nativeTransfers: overrides.nativeTransfers || [],
    instructions: [],
    accountData: [],
  };
}

function eventCore(event) {
  return {
    token_in_mint: event.token_in_mint,
    token_in_amount: event.token_in_amount,
    token_in_decimals: event.token_in_decimals,
    token_out_mint: event.token_out_mint,
    token_out_amount: event.token_out_amount,
    token_out_decimals: event.token_out_decimals,
  };
}

const expectedRayBuy = {
  token_in_mint: USDT_MINT,
  token_in_amount: 4,
  token_in_decimals: 6,
  token_out_mint: RAY_MINT,
  token_out_amount: 9,
  token_out_decimals: 6,
};

await test('two USDT inputs to one RAY output succeeds identically through helper, ingest, transfers, and classifier', () => {
  const tx = swapTx([
    [USDT_MINT, 1250000],
    [USDT_MINT, 2750000],
  ], [[RAY_MINT, 9000000]]);
  const transfer = transferTx([
    [USDT_MINT, 1250000],
    [USDT_MINT, 2750000],
  ], [[RAY_MINT, 9000000]]);

  const helper = aggregateSameMintInputsFromSwapEvent(tx.events.swap);
  const transferHelper = aggregateSameMintInputsFromWalletTransfers(transfer, WALLET);
  const { events } = normalizeTransactions([tx], WALLET, { silent: true });
  const classified = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);

  assert.equal(helper.ok, true);
  assert.equal(transferHelper.ok, true);
  assert.deepEqual(helper.event_fields, expectedRayBuy);
  assert.deepEqual(transferHelper.event_fields, expectedRayBuy);
  assert.equal(events.length, 1);
  assert.deepEqual(eventCore(events[0]), expectedRayBuy);
  assert.equal(events[0].extraction_method, 'events_swap_same_mint_aggregated');
  assert.equal(classified.classification, CLASSIFICATION.CLASSIFIED);
  assert.deepEqual(classified.swap_detail, expectedRayBuy);
});

await test('three same-mint inputs succeeds', () => {
  const tx = swapTx([
    [USDT_MINT, 100000],
    [USDT_MINT, 200000],
    [USDT_MINT, 300000],
  ], [[RAY_MINT, 250000]]);
  const { events } = normalizeTransactions([tx], WALLET, { silent: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].token_in_amount, 0.6);
  assert.equal(events[0].token_out_amount, 0.25);
});

await test('multiple same-mint outputs fail', () => {
  const tx = swapTx([
    [USDT_MINT, 100000],
    [USDT_MINT, 200000],
  ], [[RAY_MINT, 100000], [RAY_MINT, 200000]]);
  const helper = aggregateSameMintInputsFromSwapEvent(tx.events.swap);
  const { events, stats } = normalizeTransactions([tx], WALLET, { silent: true });
  const classified = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);

  assert.deepEqual(helper, { ok: false, reason: FAILURE.MULTIPLE_OUTPUT_MINTS });
  assert.equal(events.length, 0);
  assert.equal(stats.skipped.ambiguous, 1);
  assert.equal(classified.classification, CLASSIFICATION.MULTI_LEG);
});

await test('mixed inputs, native plus token, ambiguous ownership, and extra assets fail', () => {
  const mixed = swapTx([[USDT_MINT, 1], [USDC_MINT, 1]], [[RAY_MINT, 1]]);
  assert.deepEqual(aggregateSameMintInputsFromSwapEvent(mixed.events.swap), { ok: false, reason: FAILURE.MIXED_INPUT_MINTS });

  const nativePlusToken = swapTx([[USDT_MINT, 1], [USDT_MINT, 2]], [[RAY_MINT, 1]], { swap: { nativeInput: { amount: '1' } } });
  assert.deepEqual(aggregateSameMintInputsFromSwapEvent(nativePlusToken.events.swap), { ok: false, reason: FAILURE.NATIVE_INPUT_UNSUPPORTED });

  const ambiguous = transferTx([[USDT_MINT, 1], [USDT_MINT, 2]], [[RAY_MINT, 1]]);
  ambiguous.tokenTransfers[1].toUserAccount = WALLET;
  assert.deepEqual(aggregateSameMintInputsFromWalletTransfers(ambiguous, WALLET), { ok: false, reason: FAILURE.AMBIGUOUS_OWNERSHIP });

  const extraAsset = swapTx([[USDT_MINT, 1], [USDT_MINT, 2]], [[RAY_MINT, 1], [BONK_MINT, 1]]);
  assert.deepEqual(aggregateSameMintInputsFromSwapEvent(extraAsset.events.swap), { ok: false, reason: FAILURE.MULTIPLE_OUTPUT_MINTS });
});

await test('legacy one-input one-output fixture remains unchanged', () => {
  const tx = swapTx([[USDT_MINT, 4000000]], [[RAY_MINT, 9000000]]);
  const { events } = normalizeTransactions([tx], WALLET, { silent: true });
  const classified = classifyTransaction(tx, 0, WALLET, DEX_PROGRAMS);

  assert.equal(events.length, 1);
  assert.deepEqual(eventCore(events[0]), expectedRayBuy);
  assert.equal(events[0].extraction_method, 'events_swap');
  assert.equal(classified.classification, CLASSIFICATION.CLASSIFIED);
});

await test('classifier metrics move accepted fixture from multi_leg to processable', () => {
  const accepted = swapTx([[USDT_MINT, 1], [USDT_MINT, 2]], [[RAY_MINT, 1]], { signature: 'accepted' });
  const rejected = swapTx([[USDT_MINT, 1], [USDC_MINT, 2]], [[RAY_MINT, 1]], { signature: 'rejected' });
  const { coverage } = classifyAll([accepted, rejected], WALLET, DEX_PROGRAMS);

  assert.equal(coverage.fully_classified, 1);
  assert.equal(coverage.breakdown[CLASSIFICATION.CLASSIFIED], 1);
  assert.equal(coverage.breakdown[CLASSIFICATION.MULTI_LEG], 1);
});

await test('diagnostic metadata cannot enter canonical event fields', () => {
  const tx = swapTx([[USDT_MINT, 1], [USDT_MINT, 2]], [[RAY_MINT, 1]]);
  const helper = aggregateSameMintInputsFromSwapEvent(tx.events.swap);
  const { events } = normalizeTransactions([tx], WALLET, { silent: true });

  assert.equal(helper.ok, true);
  assert.ok(helper.diagnostic_metadata.input_refs.length === 2);
  assert.equal(Object.hasOwn(helper.event_fields, 'diagnostic_metadata'), false);
  assert.equal(Object.hasOwn(events[0], 'diagnostic_metadata'), false);
  assert.equal(Object.hasOwn(events[0], 'input_refs'), false);
  assert.equal(Object.hasOwn(events[0], 'aggregate_raw'), false);
});

await test('native output remains unsupported for aggregation', () => {
  const tx = swapTx([[USDT_MINT, 1], [USDT_MINT, 2]], [], { swap: { nativeOutput: { amount: '1000000000' } } });
  const helper = aggregateSameMintInputsFromSwapEvent(tx.events.swap);
  assert.deepEqual(helper, { ok: false, reason: FAILURE.NATIVE_OUTPUT_UNSUPPORTED });
});

console.log(`\nSame-mint aggregation parity tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
