#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './solana-identities.mjs';

test('Solana identities require Base58 values decoding to the native byte length', () => {
  assert.equal(isSolanaSignatureV1('1'.repeat(64)), true);
  assert.equal(isSolanaSignatureV1('1'.repeat(63)), false);
  assert.equal(isSolanaSignatureV1('1'.repeat(65)), false);
  assert.equal(isSolanaSignatureV1('0'.repeat(64)), false);
  assert.equal(isSolanaPublicKeyV1('1'.repeat(32)), true);
  assert.equal(isSolanaPublicKeyV1('1'.repeat(31)), false);
  assert.equal(isSolanaPublicKeyV1('1'.repeat(33)), false);
  assert.equal(isSolanaPublicKeyV1('0'.repeat(32)), false);
});