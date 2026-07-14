#!/usr/bin/env node

import assert from 'assert';
import {
  aggregateSameMintMultiInputSwap,
  SAME_MINT_INPUT_AGGREGATION_FAILURES as FAILURE,
  SAME_MINT_INPUT_AGGREGATION_VERSION,
} from './same-mint-input-aggregation.mjs';

const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RAY_MINT = '4k3Dyjzvzp8eXw3bFJ3hHnQ5XVkY6C4FfZbbQXfH7Y';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

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

function input(overrides = {}) {
  return {
    mint: USDT_MINT,
    rawAmount: '1000000',
    decimals: 6,
    direction: 'in',
    wallet_side: true,
    ref: 'input-ref',
    ...overrides,
  };
}

function output(overrides = {}) {
  return {
    mint: RAY_MINT,
    rawAmount: '250000000',
    decimals: 6,
    direction: 'out',
    wallet_side: true,
    ref: 'output-ref',
    ...overrides,
  };
}

await test('two USDT inputs to one RAY output succeeds', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [
      input({ rawAmount: '1250000', ref: 'tx:0' }),
      input({ rawAmount: '2750000', ref: 'tx:1' }),
    ],
    outputs: [output({ rawAmount: '9000000' })],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.event_fields, {
    token_in_mint: USDT_MINT,
    token_in_amount: 4,
    token_in_decimals: 6,
    token_out_mint: RAY_MINT,
    token_out_amount: 9,
    token_out_decimals: 6,
  });
  assert.equal(result.aggregate_raw.token_in_raw_amount, '4000000');
  assert.equal(result.diagnostic_metadata.aggregation_version, SAME_MINT_INPUT_AGGREGATION_VERSION);
  assert.deepEqual(result.diagnostic_metadata.input_refs.map(ref => ref.ref), ['tx:0', 'tx:1']);
});

await test('three same-mint inputs succeeds', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [
      input({ rawAmount: '100000' }),
      input({ rawAmount: '200000' }),
      input({ rawAmount: '300000' }),
    ],
    outputs: [output()],
  });

  assert.equal(result.ok, true);
  assert.equal(result.aggregate_raw.token_in_raw_amount, '600000');
  assert.equal(result.event_fields.token_in_amount, 0.6);
  assert.equal(result.diagnostic_metadata.input_count, 3);
});

await test('mixed USDC and USDT inputs fail', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [input({ mint: USDT_MINT }), input({ mint: USDC_MINT })],
    outputs: [output()],
  });

  assert.deepEqual(result, { ok: false, reason: FAILURE.MIXED_INPUT_MINTS });
});

await test('multiple output mints fail', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [input(), input({ rawAmount: '2000000' })],
    outputs: [output({ mint: RAY_MINT }), output({ mint: SOL_MINT, decimals: 9 })],
  });

  assert.deepEqual(result, { ok: false, reason: FAILURE.MULTIPLE_OUTPUT_MINTS });
});

await test('token plus native input fails', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [input(), input({ rawAmount: '2000000' })],
    outputs: [output()],
    nativeInput: { amount: '1000000' },
  });

  assert.deepEqual(result, { ok: false, reason: FAILURE.NATIVE_INPUT_UNSUPPORTED });
});

await test('same input and output mint fails', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [input(), input({ rawAmount: '2000000' })],
    outputs: [output({ mint: USDT_MINT })],
  });

  assert.deepEqual(result, { ok: false, reason: FAILURE.SAME_INPUT_OUTPUT_MINT });
});

await test('ambiguous ownership fails', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [input(), input({ owner_ambiguous: true })],
    outputs: [output()],
  });

  assert.deepEqual(result, { ok: false, reason: FAILURE.AMBIGUOUS_OWNERSHIP });
});

await test('unexplained extra wallet-side asset fails', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [input(), input({ rawAmount: '2000000' })],
    outputs: [output(), output({ mint: SOL_MINT, decimals: 9, rawAmount: '1' })],
  });

  assert.deepEqual(result, { ok: false, reason: FAILURE.MULTIPLE_OUTPUT_MINTS });
});

await test('integer aggregation is deterministic and avoids floating-point drift', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [
      input({ rawAmount: '100000000000000001' }),
      input({ rawAmount: '200000000000000002' }),
      input({ rawAmount: '300000000000000003' }),
    ],
    outputs: [output()],
  });

  assert.equal(result.ok, true);
  assert.equal(result.aggregate_raw.token_in_raw_amount, '600000000000000006');
  assert.equal(result.event_fields.token_in_amount, Number('600000000000000006') / 1e6);
});

await test('diagnostic refs are preserved but absent from canonical-facing output', () => {
  const result = aggregateSameMintMultiInputSwap({
    inputs: [
      input({ rawAmount: '1000000', ref: { signature: 'sig', index: 0 } }),
      input({ rawAmount: '2000000', ref: { signature: 'sig', index: 1 } }),
    ],
    outputs: [output()],
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostic_metadata.input_refs.length, 2);
  assert.equal(Object.hasOwn(result.event_fields, 'input_refs'), false);
  assert.equal(Object.hasOwn(result.event_fields, 'diagnostic_metadata'), false);
  assert.equal(Object.hasOwn(result.event_fields, 'aggregate_raw'), false);
});

console.log(`\nSame-mint input aggregation tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
