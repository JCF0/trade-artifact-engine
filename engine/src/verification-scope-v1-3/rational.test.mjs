#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  makeRational,
  validateRational,
  addRational,
  subtractRational,
  multiplyRational,
  divideRational,
  compareRational,
  isZeroRational,
} from './rational.mjs';

test('rational representation is canonical, reduced, sign-normalized, and frozen', () => {
  assert.deepEqual(makeRational('6', '-8'), { numerator: '-3', denominator: '4' });
  assert.deepEqual(makeRational('-0', '99'), { numerator: '0', denominator: '1' });
  assert.deepEqual(makeRational(42n, 7n), { numerator: '6', denominator: '1' });
  assert.equal(Object.isFrozen(makeRational('1', '2')), true);
  assert.equal(validateRational({ numerator: '-3', denominator: '4' }), true);
});

test('rational validation rejects noncanonical and non-closed representations', () => {
  for (const value of [
    { numerator: '2', denominator: '4' },
    { numerator: '0', denominator: '2' },
    { numerator: '01', denominator: '2' },
    { numerator: '+1', denominator: '2' },
    { numerator: '1', denominator: '-2' },
    { numerator: '1', denominator: '0' },
    { numerator: '1', denominator: '2', rounded: true },
    { numerator: 1, denominator: 2 },
  ]) assert.throws(() => validateRational(value), error => typeof error.code === 'string');
});

test('exact rational arithmetic supports later ordered WAC accounting without floating point', () => {
  const basisBefore = makeRational('20');
  const inventoryBefore = makeRational('10');
  const average = divideRational(basisBefore, inventoryBefore);
  const consumed = multiplyRational(makeRational('4'), average);
  const remaining = subtractRational(basisBefore, consumed);
  assert.deepEqual(average, makeRational('2'));
  assert.deepEqual(consumed, makeRational('8'));
  assert.deepEqual(remaining, makeRational('12'));
  assert.deepEqual(addRational(remaining, makeRational('40')), makeRational('52'));
});

test('partial disposal retains exact remainder and arithmetic is deterministic', () => {
  assert.deepEqual(multiplyRational(makeRational('1', '3'), makeRational('2', '5')), makeRational('2', '15'));
  assert.deepEqual(subtractRational(makeRational('1'), makeRational('1', '3')), makeRational('2', '3'));
  assert.equal(compareRational(makeRational('2', '3'), makeRational('4', '6')), 0);
  assert.equal(compareRational(makeRational('-1', '2'), makeRational('0')), -1);
  assert.equal(isZeroRational(makeRational('0')), true);
});

test('division by zero and unsafe input forms fail closed', () => {
  assert.throws(() => divideRational(makeRational('1'), makeRational('0')), error => error.code === 'rational_division_by_zero');
  for (const value of [1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', '1.0', ' 1', {}, null]) {
    assert.throws(() => makeRational(value), error => typeof error.code === 'string');
  }
});

test('hostile rational representations reject without invoking accessors or proxy traps', () => {
  let calls = 0;
  const accessor = { denominator: '1' };
  Object.defineProperty(accessor, 'numerator', { enumerable: true, get() { calls += 1; throw new Error('must not execute'); } });
  assert.throws(() => validateRational(accessor), error => error.code === 'accessor_not_allowed');
  const proxy = new Proxy({}, { ownKeys() { calls += 1; throw new Error('must not execute'); } });
  assert.throws(() => validateRational(proxy), error => error.code === 'proxy_not_allowed');
  assert.equal(calls, 0);
});
