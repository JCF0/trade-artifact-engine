#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOLANA_SPOT_EVIDENCE_VERSION_V1,
  buildSolanaSpotEvidenceV1,
  buildWalletSourceTransactionFromSpotEvidenceV1,
  isRecognizedSpotProgramV1,
  validateSolanaSpotEvidenceV1,
} from './solana-spot-evidence.mjs';

const WALLET = '7YWHMfk9JZe0LMKx5fYJEE9HDSKPQpJiX5wV8QvB7vvV';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

function fixture() {
  return {
    spot_evidence_version: SOLANA_SPOT_EVIDENCE_VERSION_V1,
    signature: 'detached-signature',
    slot: 42,
    block_time: 1_780_000_000,
    execution_state: 'succeeded',
    wallet: WALLET,
    fee_payer: WALLET,
    provider_transaction_type: 'SWAP',
    recognized_programs: [{ program_id: JUPITER_V6 }],
    structured_swap_groups: [{
      group_id: 'swap-1',
      token_inputs: [{ leg_id: 'input-1', owner: WALLET, mint: USDC, raw_amount: '25000000', decimals: 6 }],
      token_outputs: [{ leg_id: 'output-1', owner: WALLET, mint: JUP, raw_amount: '100000000', decimals: 6 }],
      native_inputs: [],
      native_outputs: [],
    }],
    token_transfer_legs: [],
    native_sol_transfer_legs: [],
    account_closures: [],
    unresolved_wallet_effects: [],
  };
}

function expectCode(fn, code = 'invalid_spot_evidence') {
  assert.throws(fn, error => error?.name === 'WalletSpotEvidenceError'
    && error.code === code
    && error.cause === undefined
    && error.stack === undefined
    && Object.keys(error.details ?? {}).length === 0);
}

function assertFrozenGraph(value) {
  assert.ok(Object.isFrozen(value));
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) assertFrozenGraph(child);
  }
}

test('builds a closed detached deeply frozen evidence graph and source transaction', () => {
  const input = fixture();
  const evidence = buildSolanaSpotEvidenceV1(input);
  assert.equal(validateSolanaSpotEvidenceV1(evidence), true);
  assertFrozenGraph(evidence);
  input.structured_swap_groups[0].token_inputs[0].mint = JUP;
  assert.equal(evidence.structured_swap_groups[0].token_inputs[0].mint, USDC);

  const source = buildWalletSourceTransactionFromSpotEvidenceV1(evidence);
  assert.equal(source.source_transaction_version, 'wallet_source_transaction_v1');
  assert.deepEqual(source.token_operations.map(item => ({
    id: item.operation_id,
    group: item.economic_group,
    kind: item.operation_kind,
    direction: item.direction,
    mint: item.mint,
    amount: item.amount,
  })), [
    { id: 'input-1', group: 'swap-1', kind: 'swap', direction: 'debit', mint: USDC, amount: 25 },
    { id: 'output-1', group: 'swap-1', kind: 'swap', direction: 'credit', mint: JUP, amount: 100 },
  ]);
  assert.deepEqual(source.recognized_programs, [{ program_id: JUPITER_V6, program_role: 'spot_swap' }]);
});

test('recognizes only the frozen Jupiter, Orca, and Raydium program set', () => {
  for (const programId of [
    JUPITER_V6,
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  ]) assert.equal(isRecognizedSpotProgramV1(programId), true);
  assert.equal(isRecognizedSpotProgramV1('future-dex-program'), false);
});

test('rejects forbidden metadata, unknown nested fields, ownership mismatch, and malformed amounts', () => {
  for (const field of ['raw_provider_response','description','url','headers','credentials','retry_state','timeout_state','local_path','job','storage','publication']) {
    expectCode(() => buildSolanaSpotEvidenceV1({ ...fixture(), [field]: 'forbidden' }));
  }
  const nested = fixture();
  nested.structured_swap_groups[0].token_inputs[0].provider_description = 'arbitrary mint mention';
  expectCode(() => buildSolanaSpotEvidenceV1(nested));
  const owner = fixture();
  owner.structured_swap_groups[0].token_inputs[0].owner = 'other-wallet';
  expectCode(() => buildSolanaSpotEvidenceV1(owner), 'spot_evidence_mismatch');
  for (const rawAmount of ['0', '-1', '01', '1.5', 1]) {
    const malformed = fixture();
    malformed.structured_swap_groups[0].token_inputs[0].raw_amount = rawAmount;
    expectCode(() => buildSolanaSpotEvidenceV1(malformed));
  }
});

test('rejects hostile JavaScript values without executing accessors or retaining diagnostics', () => {
  let getterCalls = 0;
  const accessor = fixture();
  Object.defineProperty(accessor, 'signature', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('secret https://provider.invalid /root/key'); },
  });
  expectCode(() => buildSolanaSpotEvidenceV1(accessor));
  assert.equal(getterCalls, 0);
  expectCode(() => buildSolanaSpotEvidenceV1(new Proxy({}, { ownKeys() { throw new Error('secret'); } })));
  expectCode(() => buildSolanaSpotEvidenceV1(Object.assign(Object.create(null), fixture())));
  const symbol = fixture();
  symbol[Symbol('secret')] = true;
  expectCode(() => buildSolanaSpotEvidenceV1(symbol));
});

test('retains account closure separately and ignores metadata-only mint mentions by construction', () => {
  const input = fixture();
  input.structured_swap_groups = [];
  input.account_closures = [{ closure_id: 'close-1', owner: WALLET, mint: JUP }];
  const evidence = buildSolanaSpotEvidenceV1(input);
  const source = buildWalletSourceTransactionFromSpotEvidenceV1(evidence);
  assert.equal(source.token_operations.length, 1);
  assert.deepEqual(source.token_operations[0], {
    operation_id: 'close-1', economic_group: null, operation_kind: 'account_close', direction: 'none',
    owner: WALLET, mint: JUP, amount: null, decimals: null,
  });
  assert.equal(JSON.stringify(evidence).includes('description'), false);
});
