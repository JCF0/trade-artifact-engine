// rentEpoch is identity-bound provider metadata, not a token amount or balance.
// Never convert an unsafe Number to an allegedly exact integer.
const U64_DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
export function isSolanaRentEpochV1(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0))
    || (typeof value === 'string' && U64_DECIMAL.test(value) && BigInt(value) <= 18446744073709551615n);
}

// JSON.parse reviver: source is the original token, never String(value).
// Numeric wire tokens must be unsigned decimal integers (no fraction/exponent).
// A runtime without source-token support fails closed for numeric rentEpoch.
export function reviveSolanaRentEpochV1(key, value, context) {
  if (key !== 'rentEpoch') return value;
  if (typeof value === 'number') {
    if (!isSolanaRentEpochV1(context?.source)) throw new Error('invalid rentEpoch wire integer');
    return Number.isSafeInteger(value) ? value : context.source;
  }
  if (!isSolanaRentEpochV1(value)) throw new Error('invalid rentEpoch representation');
  return value;
}
