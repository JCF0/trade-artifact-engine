#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOLANA_FULL_TRANSACTION_VERSION_V1,
  buildSolanaFullTransactionV1,
  validateSolanaFullTransactionV1,
} from './solana-full-transaction.mjs';
import { getWalletAcquisitionFailureDiagnosticV1 } from './provider-port.mjs';
import { providerPublicKey, providerSignature } from './fixtures/test-identities.mjs';

const SIGNATURE = providerSignature('full-transaction-signature');
const FEE_PAYER = providerPublicKey('full-transaction-fee-payer');
const TOKEN_ACCOUNT = providerPublicKey('full-transaction-token-account');
const PROGRAM = providerPublicKey('full-transaction-program');
const MINT = providerPublicKey('full-transaction-mint');
const TOKEN_PROGRAM = providerPublicKey('full-transaction-token-program');

function fixture() {
  return {
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
      { address: TOKEN_ACCOUNT, is_signer: false, is_writable: true, source: 'lookup_writable' },
    ],
    pre_lamport_balances: [100000, 0, 2039280],
    post_lamport_balances: [95000, 0, 2039280],
    pre_token_balances: [{
      account_index: 2, account: TOKEN_ACCOUNT, mint: MINT, owner: FEE_PAYER,
      raw_amount: '10', decimals: 6, token_program: TOKEN_PROGRAM,
    }],
    post_token_balances: [{
      account_index: 2, account: TOKEN_ACCOUNT, mint: MINT, owner: FEE_PAYER,
      raw_amount: '0', decimals: 6, token_program: TOKEN_PROGRAM,
    }],
    instructions: [{ instruction_index: 0, program_id: PROGRAM, accounts: [FEE_PAYER, TOKEN_ACCOUNT], data: '3Bxs4' }],
    inner_instruction_groups: [{
      outer_instruction_index: 0,
      instructions: [{ instruction_index: 0, program_id: TOKEN_PROGRAM, accounts: [TOKEN_ACCOUNT, FEE_PAYER], data: 'A' }],
    }],
  };
}

function expectShape(fn) {
  assert.throws(fn, error => error?.code === 'malformed_provider_response'
    && error.stack === undefined && error.cause === undefined
    && getWalletAcquisitionFailureDiagnosticV1(error)?.reason === 'full_transaction_shape_invalid');
}

function expectUnsafe(fn) {
  assert.throws(fn, error => error?.code === 'malformed_provider_response'
    && getWalletAcquisitionFailureDiagnosticV1(error)?.reason === 'provider_value_unsafe');
}

function frozenGraph(value) {
  assert.ok(Object.isFrozen(value));
  if (value !== null && typeof value === 'object') for (const child of Object.values(value)) frozenGraph(child);
}

test('builds the exact closed detached provider-neutral full-transaction representation', () => {
  const input = fixture();
  const built = buildSolanaFullTransactionV1(input);
  assert.equal(SOLANA_FULL_TRANSACTION_VERSION_V1, 'solana_full_transaction_v1');
  assert.equal(validateSolanaFullTransactionV1(built), true);
  assert.deepEqual(built, input);
  assert.deepEqual(Object.keys(built), [
    'full_transaction_version','signature','slot','block_time','execution_state','transaction_version',
    'fee_payer','fee_lamports','accounts','pre_lamport_balances','post_lamport_balances',
    'pre_token_balances','post_token_balances','instructions','inner_instruction_groups',
  ]);
  frozenGraph(built);
  input.accounts[0].address = PROGRAM;
  assert.equal(built.accounts[0].address, FEE_PAYER);
});

test('accepts legacy transactions, failed execution, null token owners, and canonical zero raw amounts', () => {
  const value = fixture();
  value.transaction_version = 'legacy';
  value.execution_state = 'failed';
  value.pre_token_balances[0].owner = null;
  value.post_token_balances[0].owner = null;
  assert.equal(validateSolanaFullTransactionV1(value), true);
});

test('is closed at every retained object boundary and validates Base58 identities', () => {
  const top = fixture(); top.description = 'provider prose'; expectShape(() => validateSolanaFullTransactionV1(top));
  for (const [collection, field] of [
    ['accounts', 'provider_source'], ['pre_token_balances', 'ui_amount'],
    ['instructions', 'parsed'], ['inner_instruction_groups', 'stack_height'],
  ]) {
    const value = fixture(); value[collection][0][field] = 'forbidden'; expectShape(() => validateSolanaFullTransactionV1(value));
  }
  const inner = fixture(); inner.inner_instruction_groups[0].instructions[0].parsed = {}; expectShape(() => validateSolanaFullTransactionV1(inner));
  for (const mutate of [
    value => { value.signature = providerPublicKey('not-signature'); },
    value => { value.fee_payer = 'not-base58'; },
    value => { value.accounts[1].address = 'not-base58'; },
    value => { value.pre_token_balances[0].mint = 'not-base58'; },
    value => { value.instructions[0].program_id = 'not-base58'; },
  ]) { const value = fixture(); mutate(value); expectShape(() => validateSolanaFullTransactionV1(value)); }
});

test('rejects unsafe integers, malformed amounts/data, unsupported versions, and null time', () => {
  for (const mutate of [
    value => { value.slot = -1; }, value => { value.block_time = null; },
    value => { value.fee_lamports = Number.MAX_SAFE_INTEGER + 1; }, value => { value.pre_lamport_balances[0] = 1.5; },
    value => { value.transaction_version = 1; }, value => { value.pre_token_balances[0].raw_amount = '01'; },
    value => { value.pre_token_balances[0].raw_amount = '-1'; }, value => { value.pre_token_balances[0].decimals = 256; },
    value => { value.pre_token_balances[0].raw_amount = '18446744073709551616'; },
    value => { value.instructions[0].data = '0OIl'; }, value => { value.execution_state = 'unknown'; },
  ]) { const value = fixture(); mutate(value); expectShape(() => validateSolanaFullTransactionV1(value)); }
});

test('reconciles account vectors, account references, indexes, and token rows exactly', () => {
  for (const mutate of [
    value => { value.post_lamport_balances.pop(); },
    value => { value.accounts[0].is_writable = false; },
    value => { value.accounts[2].address = value.accounts[0].address; },
    value => { value.pre_token_balances[0].account_index = 1; },
    value => { value.pre_token_balances.push({ ...value.pre_token_balances[0] }); },
    value => { value.post_token_balances[0].mint = providerPublicKey('conflicting-mint'); },
    value => { value.instructions[0].instruction_index = 1; },
    value => { value.instructions[0].accounts[0] = providerPublicKey('unresolved-account'); },
    value => { value.inner_instruction_groups[0].outer_instruction_index = 1; },
    value => { value.inner_instruction_groups[0].instructions[0].instruction_index = 1; },
  ]) { const value = fixture(); mutate(value); expectShape(() => validateSolanaFullTransactionV1(value)); }
});

test('generic unsafe-value precedence covers hostile graphs without invoking accessors', () => {
  let getterCalls = 0;
  const getter = fixture();
  Object.defineProperty(getter, 'signature', { enumerable: true, get() { getterCalls += 1; return SIGNATURE; } });
  const cyclic = fixture(); cyclic.accounts[0].cycle = cyclic;
  const sparse = fixture(); sparse.instructions = new Array(1);
  const symbol = fixture(); symbol.accounts[0][Symbol('secret')] = true;
  const custom = fixture(); custom.accounts[0] = Object.assign(Object.create(null), custom.accounts[0]);
  const deep = fixture(); let cursor = deep.accounts[0];
  for (let index = 0; index < 257; index += 1) { cursor.next = {}; cursor = cursor.next; }
  const wide = fixture(); wide.accounts[0].wide = Array.from({ length: 100001 }, () => null);
  for (const value of [getter, cyclic, sparse, symbol, custom, deep, wide, new Proxy({}, {})]) expectUnsafe(() => validateSolanaFullTransactionV1(value));
  for (const number of [Number.NaN, Number.POSITIVE_INFINITY, -0]) {
    const value = fixture(); value.slot = number; expectUnsafe(() => validateSolanaFullTransactionV1(value));
  }
  assert.equal(getterCalls, 0);
});
