#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { validateHeliusFullTransactionV1 } from './helius-full-transaction-validator.mjs';
import { getWalletAcquisitionFailureDiagnosticV1 } from './provider-port.mjs';
import { providerPublicKey, providerSignature } from './fixtures/test-identities.mjs';

const SIGNATURE = providerSignature('raw-full-transaction-signature');
const OTHER_SIGNATURE = providerSignature('raw-full-transaction-other-signature');
const FEE_PAYER = providerPublicKey('raw-full-transaction-fee-payer');
const PROGRAM = providerPublicKey('raw-full-transaction-program');
const TOKEN_PROGRAM = providerPublicKey('raw-full-transaction-token-program');
const TOKEN_ACCOUNT = providerPublicKey('raw-full-transaction-token-account');
const MINT = providerPublicKey('raw-full-transaction-mint');
const LOOKUP_TABLE = providerPublicKey('raw-full-transaction-lookup-table');

function rawFixture() {
  return {
    slot: 42,
    blockTime: 1_780_000_000,
    version: 0,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: [FEE_PAYER, PROGRAM, TOKEN_PROGRAM],
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
        recentBlockhash: providerPublicKey('raw-full-transaction-blockhash'),
        instructions: [{ programIdIndex: 1, accounts: [0, 3], data: '3Bxs4', stackHeight: null }],
        addressTableLookups: [{ accountKey: LOOKUP_TABLE, writableIndexes: [1], readonlyIndexes: [] }],
      },
    },
    meta: {
      err: null,
      status: { Ok: null },
      fee: 5000,
      preBalances: [100000, 0, 0, 2039280],
      postBalances: [95000, 0, 0, 2039280],
      preTokenBalances: [{
        accountIndex: 3, mint: MINT, owner: FEE_PAYER, programId: TOKEN_PROGRAM,
        uiTokenAmount: { amount: '10', decimals: 6, uiAmount: 0.00001, uiAmountString: '0.00001' },
      }],
      postTokenBalances: [{
        accountIndex: 3, mint: MINT, owner: FEE_PAYER, programId: TOKEN_PROGRAM,
        uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
      }],
      innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 2, accounts: [3, 0], data: 'A', stackHeight: 2 }],
      }],
      loadedAddresses: { writable: [TOKEN_ACCOUNT], readonly: [] },
      logMessages: ['provider prose must not survive'],
      rewards: [],
      computeUnitsConsumed: 100,
    },
  };
}

function expectReason(fn, reason) {
  assert.throws(fn, error => error?.code === 'malformed_provider_response'
    && error.stack === undefined && error.cause === undefined
    && getWalletAcquisitionFailureDiagnosticV1(error)?.reason === reason);
}

test('normalizes a raw full JSON transaction into the closed provider-neutral representation', () => {
  const raw = rawFixture();
  const value = validateHeliusFullTransactionV1(raw, SIGNATURE);
  assert.deepEqual(value, {
    full_transaction_version: 'solana_full_transaction_v1',
    signature: SIGNATURE,
    slot: 42,
    block_time: 1_780_000_000,
    execution_state: 'succeeded',
    transaction_version: 0,
    fee_payer: FEE_PAYER,
    fee_lamports: 5000,
    accounts: [
      { address: FEE_PAYER, is_signer: true, is_writable: true, source: 'static' },
      { address: PROGRAM, is_signer: false, is_writable: false, source: 'static' },
      { address: TOKEN_PROGRAM, is_signer: false, is_writable: false, source: 'static' },
      { address: TOKEN_ACCOUNT, is_signer: false, is_writable: true, source: 'lookup_writable' },
    ],
    pre_lamport_balances: [100000, 0, 0, 2039280],
    post_lamport_balances: [95000, 0, 0, 2039280],
    pre_token_balances: [{
      account_index: 3, account: TOKEN_ACCOUNT, mint: MINT, owner: FEE_PAYER,
      raw_amount: '10', decimals: 6, token_program: TOKEN_PROGRAM,
    }],
    post_token_balances: [{
      account_index: 3, account: TOKEN_ACCOUNT, mint: MINT, owner: FEE_PAYER,
      raw_amount: '0', decimals: 6, token_program: TOKEN_PROGRAM,
    }],
    instructions: [{ instruction_index: 0, program_id: PROGRAM, accounts: [FEE_PAYER, TOKEN_ACCOUNT], data: '3Bxs4' }],
    inner_instruction_groups: [{
      outer_instruction_index: 0,
      instructions: [{ instruction_index: 0, program_id: TOKEN_PROGRAM, accounts: [TOKEN_ACCOUNT, FEE_PAYER], data: 'A' }],
    }],
  });
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.accounts));
  raw.meta.preBalances[0] = 1;
  assert.equal(value.pre_lamport_balances[0], 100000);
  assert.equal(JSON.stringify(value).includes('provider prose'), false);
});

test('projects arbitrary provider errors only to failed execution state', () => {
  const raw = rawFixture();
  raw.meta.err = { InstructionError: [0, { Custom: 6001 }], secret: 'provider prose' };
  const value = validateHeliusFullTransactionV1(raw, SIGNATURE);
  assert.equal(value.execution_state, 'failed');
  assert.equal(JSON.stringify(value).includes('InstructionError'), false);
  assert.equal(JSON.stringify(value).includes('provider prose'), false);
});

test('requires the first transaction signature to equal the requested canonical signature', () => {
  const wrongFirst = rawFixture(); wrongFirst.transaction.signatures = [OTHER_SIGNATURE, SIGNATURE];
  expectReason(() => validateHeliusFullTransactionV1(wrongFirst, SIGNATURE), 'full_transaction_signature_mismatch');
  const wrongRequest = rawFixture();
  expectReason(() => validateHeliusFullTransactionV1(wrongRequest, OTHER_SIGNATURE), 'full_transaction_signature_mismatch');
});

test('reconciles signature count with the header and requires a writable fee payer', () => {
  const tooFew = rawFixture();
  tooFew.transaction.message.header.numRequiredSignatures = 2;
  tooFew.transaction.message.header.numReadonlyUnsignedAccounts = 1;
  expectReason(() => validateHeliusFullTransactionV1(tooFew, SIGNATURE), 'full_transaction_shape_invalid');

  const extra = rawFixture();
  extra.transaction.signatures.push(OTHER_SIGNATURE);
  expectReason(() => validateHeliusFullTransactionV1(extra, SIGNATURE), 'full_transaction_shape_invalid');

  const readonlyFeePayer = rawFixture();
  readonlyFeePayer.transaction.message.header.numReadonlySignedAccounts = 1;
  expectReason(() => validateHeliusFullTransactionV1(readonlyFeePayer, SIGNATURE), 'full_transaction_shape_invalid');
});

test('rejects null block time/meta, unsupported versions, missing fee, and malformed instruction data', () => {
  for (const mutate of [
    value => { value.blockTime = null; }, value => { value.meta = null; }, value => { value.version = 1; },
    value => { delete value.meta.err; }, value => { delete value.meta.fee; },
    value => { value.transaction.message.instructions[0].data = '0OIl'; },
    value => { value.transaction.signatures = []; }, value => { value.transaction.message.accountKeys[0] = 'bad'; },
  ]) { const value = rawFixture(); mutate(value); expectReason(() => validateHeliusFullTransactionV1(value, SIGNATURE), 'full_transaction_shape_invalid'); }
});

test('rejects malformed loaded addresses, account/balance lengths, indexes, and contradictory token rows', () => {
  for (const mutate of [
    value => { value.meta.loadedAddresses.writable = []; },
    value => { value.meta.loadedAddresses = null; },
    value => { value.meta.preBalances.pop(); },
    value => { value.transaction.message.instructions[0].programIdIndex = 9; },
    value => { value.transaction.message.instructions[0].accounts = [9]; },
    value => { value.meta.preTokenBalances[0].accountIndex = 9; },
    value => { value.meta.preTokenBalances.push({ ...value.meta.preTokenBalances[0] }); },
    value => { value.meta.postTokenBalances[0].mint = providerPublicKey('raw-conflicting-mint'); },
    value => { value.meta.innerInstructions[0].index = 9; },
  ]) { const value = rawFixture(); mutate(value); expectReason(() => validateHeliusFullTransactionV1(value, SIGNATURE), 'full_transaction_shape_invalid'); }
});

test('sanitizes malformed legacy loaded-address values instead of leaking native errors', () => {
  const value = rawFixture();
  value.version = 'legacy';
  value.transaction.message.addressTableLookups = [];
  value.meta.loadedAddresses = null;
  expectReason(() => validateHeliusFullTransactionV1(value, SIGNATURE), 'full_transaction_shape_invalid');
});

test('generic unsafe-value detachment always precedes transaction structure classification', () => {
  let calls = 0;
  const getter = rawFixture();
  Object.defineProperty(getter, 'slot', { enumerable: true, get() { calls += 1; return 42; } });
  const cyclic = rawFixture(); cyclic.meta.self = cyclic;
  const sparse = rawFixture(); sparse.meta.preBalances = new Array(4);
  const symbol = rawFixture(); symbol.meta[Symbol('secret')] = true;
  for (const value of [getter, cyclic, sparse, symbol, new Proxy({}, {})]) {
    expectReason(() => validateHeliusFullTransactionV1(value, SIGNATURE), 'provider_value_unsafe');
  }
  for (const number of [Number.NaN, Number.POSITIVE_INFINITY, -0, Number.MAX_SAFE_INTEGER + 1]) {
    const value = rawFixture(); value.slot = number;
    expectReason(() => validateHeliusFullTransactionV1(value, SIGNATURE),
      number === Number.MAX_SAFE_INTEGER + 1 ? 'full_transaction_shape_invalid' : 'provider_value_unsafe');
  }
  assert.equal(calls, 0);
});
