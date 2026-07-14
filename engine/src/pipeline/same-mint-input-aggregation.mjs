/**
 * Deterministic same-mint multi-input aggregation helper.
 *
 * This module is intentionally not wired into runtime normalization yet.
 * It returns existing normalized swap-event fields separately from diagnostic
 * metadata so raw transfer references do not become canonical receipt inputs.
 */

export const SAME_MINT_INPUT_AGGREGATION_VERSION = 'same_mint_multi_input_aggregation_v1';

const FAILURE = Object.freeze({
  NOT_MULTI_INPUT: 'not_multi_input',
  NATIVE_INPUT_UNSUPPORTED: 'native_input_unsupported',
  NATIVE_OUTPUT_UNSUPPORTED: 'native_output_unsupported',
  AMBIGUOUS_OWNERSHIP: 'ambiguous_ownership',
  MIXED_INPUT_MINTS: 'mixed_input_mints',
  MIXED_INPUT_DECIMALS: 'mixed_input_decimals',
  MULTIPLE_OUTPUT_MINTS: 'multiple_output_mints',
  NO_OUTPUT_ASSET: 'no_output_asset',
  INVALID_RAW_AMOUNT: 'invalid_raw_amount',
  SAME_INPUT_OUTPUT_MINT: 'same_input_output_mint',
});

export const SAME_MINT_INPUT_AGGREGATION_FAILURES = FAILURE;

/**
 * Aggregate multiple wallet-side token inputs into one existing normalized
 * swap-event field set when the shape is safely equivalent to a single input.
 *
 * @param {object} shape
 * @param {object[]} shape.inputs Wallet-side sent token inputs.
 * @param {object[]} shape.outputs Wallet-side received token outputs.
 * @param {object|null} [shape.nativeInput] Native input, unsupported here.
 * @param {object|null} [shape.nativeOutput] Native output, unsupported here.
 * @returns {{ok: true, event_fields: object, aggregate_raw: object, diagnostic_metadata: object} | {ok: false, reason: string}}
 */
export function aggregateSameMintMultiInputSwap(shape = {}) {
  const inputs = Array.isArray(shape.inputs) ? shape.inputs : [];
  const outputs = Array.isArray(shape.outputs) ? shape.outputs : [];

  if (shape.nativeInput) return fail(FAILURE.NATIVE_INPUT_UNSUPPORTED);
  if (shape.nativeOutput) return fail(FAILURE.NATIVE_OUTPUT_UNSUPPORTED);
  if (inputs.length < 2) return fail(FAILURE.NOT_MULTI_INPUT);
  if (outputs.length !== 1) {
    return fail(outputs.length === 0 ? FAILURE.NO_OUTPUT_ASSET : FAILURE.MULTIPLE_OUTPUT_MINTS);
  }

  const firstInput = inputs[0];
  if (!isUnambiguousInput(firstInput)) return fail(FAILURE.AMBIGUOUS_OWNERSHIP);

  const inputMint = firstInput.mint;
  const inputDecimals = firstInput.decimals;
  if (!isValidDecimals(inputDecimals)) return fail(FAILURE.MIXED_INPUT_DECIMALS);

  let inputRawTotal = 0n;
  const inputRefs = [];

  for (const input of inputs) {
    if (!isUnambiguousInput(input)) return fail(FAILURE.AMBIGUOUS_OWNERSHIP);
    if (input.mint !== inputMint) return fail(FAILURE.MIXED_INPUT_MINTS);
    if (input.decimals !== inputDecimals) return fail(FAILURE.MIXED_INPUT_DECIMALS);

    const rawAmount = parseRawAmount(input.rawAmount);
    if (rawAmount === null) return fail(FAILURE.INVALID_RAW_AMOUNT);
    inputRawTotal += rawAmount;
    inputRefs.push(buildInputRef(input));
  }

  const output = outputs[0];
  if (!isUnambiguousOutput(output)) return fail(FAILURE.AMBIGUOUS_OWNERSHIP);
  if (output.mint === inputMint) return fail(FAILURE.SAME_INPUT_OUTPUT_MINT);
  if (!isValidDecimals(output.decimals)) return fail(FAILURE.MIXED_INPUT_DECIMALS);

  const outputRawAmount = parseRawAmount(output.rawAmount);
  if (outputRawAmount === null) return fail(FAILURE.INVALID_RAW_AMOUNT);

  return {
    ok: true,
    event_fields: {
      token_in_mint: inputMint,
      token_in_amount: decimalNormalize(inputRawTotal, inputDecimals),
      token_in_decimals: inputDecimals,
      token_out_mint: output.mint,
      token_out_amount: decimalNormalize(outputRawAmount, output.decimals),
      token_out_decimals: output.decimals,
    },
    aggregate_raw: {
      token_in_raw_amount: inputRawTotal.toString(),
      token_out_raw_amount: outputRawAmount.toString(),
    },
    diagnostic_metadata: {
      aggregation_version: SAME_MINT_INPUT_AGGREGATION_VERSION,
      input_count: inputs.length,
      output_count: outputs.length,
      input_refs: inputRefs,
    },
  };
}

function fail(reason) {
  return { ok: false, reason };
}

function isUnambiguousInput(input) {
  return input
    && input.mint
    && input.direction === 'in'
    && input.wallet_side === true
    && input.owner_ambiguous !== true;
}

function isUnambiguousOutput(output) {
  return output
    && output.mint
    && output.direction === 'out'
    && output.wallet_side === true
    && output.owner_ambiguous !== true;
}

function isValidDecimals(decimals) {
  return Number.isInteger(decimals) && decimals >= 0;
}

function parseRawAmount(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

function decimalNormalize(rawAmount, decimals) {
  return Number(rawAmount) / Math.pow(10, decimals);
}

function buildInputRef(input) {
  return {
    ref: input.ref ?? null,
    mint: input.mint,
    raw_amount: parseRawAmount(input.rawAmount).toString(),
    decimals: input.decimals,
  };
}
