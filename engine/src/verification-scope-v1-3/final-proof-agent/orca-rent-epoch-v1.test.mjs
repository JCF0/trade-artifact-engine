import test from 'node:test';
import assert from 'node:assert/strict';
import { isSolanaRentEpochV1, reviveSolanaRentEpochV1 } from '../../wallet-acquisition/solana-rent-epoch-v1.mjs';
const parse = text => JSON.parse(text, reviveSolanaRentEpochV1);

test('rentEpoch preserves ordinary safe Numbers and admits canonical exact u64 strings', () => {
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER, '0', '1', '9007199254740991', '9007199254740992', '18446744073709551615']) {
    assert.equal(isSolanaRentEpochV1(value), true);
    assert.deepEqual(parse(JSON.stringify({ rentEpoch: value })), { rentEpoch: value });
  }
  assert.equal(parse('{"rentEpoch":18446744073709551615}').rentEpoch, '18446744073709551615');
  assert.equal(parse('{"rentEpoch":9007199254740993}').rentEpoch, '9007199254740993');
});

test('rentEpoch rejects unsafe Numbers and malformed, negative, fractional or out-of-range representations', () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, Number('18446744073709551615'), NaN, Infinity,
    -1, -0, 0.5, null, undefined, true, {}, [], 1n,
    '', '00', '01', '-0', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '1\n', '18446744073709551616', '999999999999999999999']) {
    assert.equal(isSolanaRentEpochV1(value), false);
  }
  for (const token of ['-0', '-1', '0.5', '1.00000000000000000001', '1e3', '18446744073709551616',
    '18446744073709552000', '1e999', 'null', 'true', '{}', '[]', '"01"', '"18446744073709551616"']) {
    assert.throws(() => parse(`{"rentEpoch":${token}}`), /rentEpoch/);
  }
  for (const token of ['NaN', 'Infinity', '01', '+1', '']) {
    assert.throws(() => parse(`{"rentEpoch":${token}}`), SyntaxError);
  }
});

test('source-token support is mandatory, never synthesized from a parsed Number', () => {
  assert.throws(() => reviveSolanaRentEpochV1('rentEpoch', 1), /rentEpoch/);
  assert.throws(() => reviveSolanaRentEpochV1('rentEpoch', Number('18446744073709551615')), /rentEpoch/);
});

test('reserialization is not recovery of an original precision-losing token', () => {
  const original = '{"rentEpoch":9007199254740993}';
  const rounded = JSON.parse(original);
  assert.equal(isSolanaRentEpochV1(rounded.rentEpoch), false);
  const reserialized = JSON.stringify(rounded);
  assert.equal(reserialized, '{"rentEpoch":9007199254740992}');
  // Both strings are independently valid u64 inputs, but are DIFFERENT evidence.
  assert.notEqual(parse(original).rentEpoch, parse(reserialized).rentEpoch);
  const maximum = '{"rentEpoch":18446744073709551615}';
  assert.equal(JSON.stringify(JSON.parse(maximum)), '{"rentEpoch":18446744073709552000}');
  assert.throws(() => parse(JSON.stringify(JSON.parse(maximum))), /rentEpoch/);
});

test('rentEpoch reviver does not normalize balances, quantities or context fields', () => {
  const raw = '{"lamports":9007199254740993,"slot":9007199254740993,"amount":"123","uiAmount":0.25}';
  assert.deepEqual(parse(raw), JSON.parse(raw));
  assert.equal(Number.isSafeInteger(parse(raw).lamports), false);
});
