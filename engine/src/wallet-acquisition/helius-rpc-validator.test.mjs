#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { SOLANA_MAINNET_GENESIS_HASH } from './request-contract.mjs';
import {
  validateHeliusEnhancedAddressPageV1,
  validateHeliusRpcBlockResponseV1,
  validateHeliusRpcGenesisResponseV1,
  validateHeliusRpcSignaturePageResponseV1,
  validateHeliusRpcSlotResponseV1,
} from './helius-rpc-validator.mjs';
import { providerSignature } from './fixtures/slice4-fixtures.mjs';

function rpc(result) { return { jsonrpc: '2.0', id: 'wallet-acquisition-v1', result }; }
function expectMalformed(fn) { assert.throws(fn, error => error?.code === 'malformed_provider_response' && error.stack === undefined); }

test('validates mainnet genesis, finalized slot, and coherent finalized block', () => {
  assert.deepEqual(validateHeliusRpcGenesisResponseV1(rpc(SOLANA_MAINNET_GENESIS_HASH)), { chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH });
  assert.equal(validateHeliusRpcSlotResponseV1(rpc(99)), 99);
  assert.deepEqual(validateHeliusRpcBlockResponseV1(rpc({ blockTime: 1000, blockhash: '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh' }), 99), { slot: 99, block_time: 1000, blockhash: '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh', commitment: 'finalized' });
  assert.equal(validateHeliusRpcBlockResponseV1(rpc(null), 98), null);
});

test('rejects wrong genesis and malformed slot/block fields or wrong returned slot', () => {
  assert.throws(() => validateHeliusRpcGenesisResponseV1(rpc('wrong')), error => error?.code === 'chain_identity_mismatch');
  for (const body of [rpc(-1), rpc(1.5), { result: 1 }]) expectMalformed(() => validateHeliusRpcSlotResponseV1(body));
  for (const body of [rpc({ blockTime: null, blockhash: 'abc' }), rpc({ blockTime: 1, blockhash: null }), rpc({ blockTime: 1, blockhash: 'abc', slot: 7 })]) expectMalformed(() => validateHeliusRpcBlockResponseV1(body, 8));
});

test('projects canonical signature pages with failure state and rejects null time or malformed entries', () => {
  const signature = providerSignature('sig');
  const value = validateHeliusRpcSignaturePageResponseV1(rpc([{ signature, slot: 7, blockTime: 9, err: null, memo: null, confirmationStatus: 'finalized' }]));
  assert.deepEqual(value, [{ signature, slot: 7, block_time: 9, execution_state: 'succeeded' }]);
  assert.equal(validateHeliusRpcSignaturePageResponseV1(rpc([{ signature: providerSignature('failed'), slot: 6, blockTime: 8, err: { hostile: true }, memo: null, confirmationStatus: 'finalized' }]))[0].execution_state, 'failed');
  expectMalformed(() => validateHeliusRpcSignaturePageResponseV1(rpc([{ signature, slot: 7, blockTime: null, err: null, memo: null, confirmationStatus: 'finalized' }])));
  expectMalformed(() => validateHeliusRpcSignaturePageResponseV1(rpc([{ signature: '11111111111111111111111111111111', slot: 7, blockTime: 9, err: null, memo: null, confirmationStatus: 'finalized' }])));
  for (const signature of ['1'.repeat(63), '1'.repeat(65), '_'.repeat(88), '-'.repeat(88)]) {
    expectMalformed(() => validateHeliusRpcSignaturePageResponseV1(rpc([{ signature, slot: 7, blockTime: 9, err: null, memo: null, confirmationStatus: 'finalized' }])));
  }
  for (const blockhash of ['1'.repeat(31), '1'.repeat(33), '../not-a-blockhash']) {
    expectMalformed(() => validateHeliusRpcBlockResponseV1(rpc({ blockTime: 9, blockhash }), 7));
  }
});

test('Enhanced address pages retain detached plain bodies but enforce signature/timestamp/slot basics', () => {
  const page = [{ signature: providerSignature('sig'), slot: 7, timestamp: 9, transactionError: null }];
  const result = validateHeliusEnhancedAddressPageV1(page);
  page[0].slot = 8;
  assert.equal(result[0].slot, 7);
  for (const invalid of [{ transactions: [] }, [null], [{ signature: '', slot: 1, timestamp: 1 }], new Array(1)]) expectMalformed(() => validateHeliusEnhancedAddressPageV1(invalid));
});
