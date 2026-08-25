import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCanonicalTransactionOrderV13 } from './canonical-order.mjs';
import {
  buildTargetAccountBoundaryV13,
  validateSourceBoundTargetAccountBoundaryV13,
  validateTargetAccountBoundaryStructureV13,
} from './target-account-boundary.mjs';
import { projectSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import { providerPublicKey, providerSignature } from '../wallet-acquisition/fixtures/slice4-fixtures.mjs';

const WALLET = providerPublicKey('slice3a-boundary-wallet');
const TARGET = providerPublicKey('slice3a-boundary-target');
const EXTERNAL = providerPublicKey('slice3a-boundary-external');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function transaction(label, { slot, blockTime, rows = [] } = {}) {
  const tokenAccounts = rows.map(row => providerPublicKey(`${label}-${row.label}`));
  const addresses = [WALLET, TOKEN_PROGRAM, ...tokenAccounts];
  const accounts = addresses.map((address, index) => ({
    address,
    is_signer: index === 0,
    is_writable: index === 0 || tokenAccounts.includes(address),
    source: 'static',
  }));
  const pre = accounts.map(() => 0);
  const post = accounts.map(() => 0);
  pre[0] = 1_000_000;
  post[0] = 999_995;
  const tokenRows = side => rows.flatMap((row, index) => {
    if ((side === 'pre' && row.omitPre) || (side === 'post' && row.omitPost)) return [];
    return [{
      account_index: addresses.indexOf(tokenAccounts[index]),
      account: tokenAccounts[index],
      mint: row.mint ?? TARGET,
      owner: row.owner === undefined ? WALLET : row.owner,
      raw_amount: String(side === 'pre' ? row.pre : row.post),
      decimals: 6,
      token_program: TOKEN_PROGRAM,
    }];
  });
  return {
    full_transaction_version: 'solana_full_transaction_v1',
    signature: providerSignature(label),
    slot,
    block_time: blockTime,
    execution_state: 'succeeded',
    transaction_version: 0,
    fee_payer: WALLET,
    fee_lamports: 5,
    accounts,
    pre_lamport_balances: pre,
    post_lamport_balances: post,
    pre_token_balances: tokenRows('pre'),
    post_token_balances: tokenRows('post'),
    instructions: [],
    inner_instruction_groups: [],
  };
}
function record(tx) {
  return { transaction: tx, effect: projectSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: tx }) };
}
function source(tx) {
  return { signature: tx.signature, slot: tx.slot, block_time: tx.block_time, execution_state: tx.execution_state };
}
function closureTransaction(label) {
  const closed = providerPublicKey(`${label}-closed`);
  return {
    full_transaction_version: 'solana_full_transaction_v1',
    signature: providerSignature(label),
    slot: 15,
    block_time: 105,
    execution_state: 'succeeded',
    transaction_version: 0,
    fee_payer: WALLET,
    fee_lamports: 5,
    accounts: [
      { address: WALLET, is_signer: true, is_writable: true, source: 'static' },
      { address: TOKEN_PROGRAM, is_signer: false, is_writable: false, source: 'static' },
      { address: closed, is_signer: false, is_writable: true, source: 'static' },
    ],
    pre_lamport_balances: [1_000_000, 0, 2_039_280],
    post_lamport_balances: [3_039_275, 0, 0],
    pre_token_balances: [{
      account_index: 2,
      account: closed,
      mint: TARGET,
      owner: WALLET,
      raw_amount: '0',
      decimals: 6,
      token_program: TOKEN_PROGRAM,
    }],
    post_token_balances: [],
    instructions: [{
      instruction_index: 0,
      program_id: TOKEN_PROGRAM,
      accounts: [closed, WALLET, WALLET],
      data: 'A',
    }],
    inner_instruction_groups: [],
  };
}
function build(records) {
  const newestFirst = [...records].sort((left, right) => right.transaction.slot - left.transaction.slot);
  const order = buildCanonicalTransactionOrderV13({
    wallet: WALLET,
    authoritative_population: newestFirst.map(item => source(item.transaction)),
    transaction_records: [...records].reverse(),
  });
  return buildTargetAccountBoundaryV13({
    wallet: WALLET,
    target_mint: TARGET,
    canonical_order: order,
    transaction_records: records,
  });
}

test('participating target accounts are aggregated only as partial observations and never prove coverage or zero', () => {
  const tx = transaction('two-zero-accounts', {
    slot: 10,
    blockTime: 100,
    rows: [
      { label: 'first', pre: 0, post: 0 },
      { label: 'second', pre: 0, post: 0 },
    ],
  });
  const records = [record(tx)];
  const built = build(records);
  const order = buildCanonicalTransactionOrderV13({
    wallet: WALLET,
    authoritative_population: [source(tx)],
    transaction_records: records,
  });

  assert.equal(built.account_coverage_status, 'UNRESOLVED');
  assert.equal(built.account_coverage_evidence_identity, null);
  assert.equal(built.canonical_order_evidence_identity, null);
  assert.deepEqual(built.transaction_boundaries, []);
  assert.deepEqual(built.reason_codes, [
    'OPENING_INVENTORY_UNRESOLVED',
    'ENDING_INVENTORY_UNRESOLVED',
    'TARGET_ACCOUNT_COVERAGE_INCOMPLETE',
    'ACCOUNT_AUTHORITY_UNRESOLVED',
  ]);
  assert.equal(built.accounts.length, 2);
  assert.ok(built.accounts.every(account => account.owner_status === 'WALLET_OWNED'
    && account.authority_status === 'UNKNOWN'
    && account.delegate_status === 'UNKNOWN'));
  assert.equal(built.opening_boundary.observed_wallet_owned_raw_quantity, null);
  assert.equal(built.ending_boundary.observed_wallet_owned_raw_quantity, null);
  assert.ok(built.accounts.every(account => account.observations[0].pre_raw_amount === '0'
    && account.observations[0].post_raw_amount === '0'
    && account.observations[0].canonical_transaction_coordinate === null));
  assert.equal(built.opening_boundary.aggregate_raw_quantity, null);
  assert.equal(built.ending_boundary.aggregate_raw_quantity, null);
  assert.equal(built.ending_boundary.zero_status, 'UNRESOLVED');
  assert.equal(built.ending_boundary.valid_for_closed, false);
  assert.equal(validateTargetAccountBoundaryStructureV13(built), true);
  assert.equal(validateSourceBoundTargetAccountBoundaryV13({
    wallet: WALLET, target_mint: TARGET, canonical_order: order,
    transaction_records: records, boundary: built,
  }), true);
  assert.ok(Object.isFrozen(built.accounts[0].observations));

  const forged = structuredClone(built);
  forged.ending_boundary.observed_wallet_owned_raw_quantity = '999';
  assert.throws(
    () => validateTargetAccountBoundaryStructureV13(forged),
    error => error.code === 'unsupported_boundary_authority',
  );
  for (const endpoint of ['opening_boundary', 'ending_boundary']) {
    const chronologyForged = structuredClone(built);
    chronologyForged[endpoint].canonical_transaction_coordinate = 0;
    chronologyForged[endpoint].transaction_identity = records[0].effect.transaction_identity;
    assert.throws(
      () => validateTargetAccountBoundaryStructureV13(chronologyForged),
      error => error.code === 'unsupported_boundary_authority',
    );
  }
  const sourceForged = structuredClone(built);
  sourceForged.accounts[0].observations[0].transaction_identity.slot += 1;
  assert.throws(
    () => validateSourceBoundTargetAccountBoundaryV13({
      wallet: WALLET, target_mint: TARGET, canonical_order: order,
      transaction_records: records, boundary: sourceForged,
    }),
    error => error.code === 'target_account_boundary_source_mismatch',
  );
});

test('one raw unit remains nonzero observed custody without dust or display rounding', () => {
  const tx = transaction('exact-one-unit', {
    slot: 11,
    blockTime: 101,
    rows: [{ label: 'dust-is-inventory', pre: 0, post: 1 }],
  });
  const built = build([record(tx)]);
  assert.equal(built.accounts[0].observations[0].post_raw_amount, '1');
  assert.equal(built.ending_boundary.observed_wallet_owned_raw_quantity, null);
  assert.equal(built.ending_boundary.observed_quantity_status, 'UNAVAILABLE');
  assert.equal(built.ending_boundary.aggregate_raw_quantity, null);
  assert.equal(built.ending_boundary.zero_status, 'UNRESOLVED');
});

test('no discovered account and missing balance sides remain unresolved rather than becoming zero', () => {
  const noRows = build([record(transaction('no-target-rows', { slot: 12, blockTime: 102 }))]);
  assert.equal(noRows.accounts.length, 0);
  assert.equal(noRows.opening_boundary.observed_wallet_owned_raw_quantity, null);
  assert.equal(noRows.ending_boundary.observed_wallet_owned_raw_quantity, null);

  const missing = build([record(transaction('missing-pre-side', {
    slot: 13,
    blockTime: 103,
    rows: [{ label: 'created-looking', pre: 0, post: 7, omitPre: true }],
  }))]);
  assert.equal(missing.accounts[0].observations[0].pre_raw_amount, null);
  assert.equal(missing.opening_boundary.observed_wallet_owned_raw_quantity, null);
  assert.ok(missing.findings.some(item => item.finding_code === 'TARGET_ACCOUNT_BALANCE_SIDE_MISSING'));
});

test('unknown ownership is preserved as a coverage finding and is never admitted as wallet-owned', () => {
  const tx = transaction('unknown-owner-row', {
    slot: 14,
    blockTime: 104,
    rows: [
      { label: 'wallet-owned', pre: 2, post: 2 },
      { label: 'unknown-owner', owner: null, pre: 9, post: 9 },
      { label: 'external-owner', owner: EXTERNAL, pre: 4, post: 4 },
    ],
  });
  const built = build([record(tx)]);
  assert.equal(built.accounts.length, 1);
  assert.equal(built.accounts[0].owner, WALLET);
  assert.ok(built.findings.some(item => item.finding_code === 'TARGET_ACCOUNT_OWNER_UNRESOLVED'));
  assert.equal(built.accounts[0].observations[0].pre_raw_amount, '2');
  assert.equal(built.opening_boundary.observed_wallet_owned_raw_quantity, null);
});

test('source-established closure carries authority and establishes the missing post side as exact zero', () => {
  const built = build([record(closureTransaction('established-close'))]);
  const account = built.accounts[0];
  assert.equal(account.closure_status, 'ESTABLISHED');
  assert.equal(account.authority_status, 'ESTABLISHED_FOR_CLOSURE_ONLY');
  assert.equal(account.closure_authority, WALLET);
  assert.equal(account.delegate_status, 'UNKNOWN');
  assert.equal(account.observations[0].post_raw_amount, '0');
  assert.equal(account.observations[0].post_evidence_status, 'EXACT_LIFECYCLE_ZERO');
  assert.equal(built.ending_boundary.observed_wallet_owned_raw_quantity, null);
  assert.equal(built.ending_boundary.zero_status, 'UNRESOLVED');
});

test('transfer-like custody changes and later return never establishes economic continuity or a closed boundary', () => {
  const out = transaction('custody-out', {
    slot: 20,
    blockTime: 200,
    rows: [{ label: 'shared-account', pre: 10, post: 0 }],
  });
  const returned = transaction('custody-return', {
    slot: 21,
    blockTime: 201,
    rows: [{ label: 'shared-account', pre: 0, post: 10 }],
  });
  // Use the same account identity across both transactions.
  const account = out.pre_token_balances[0].account;
  returned.accounts[2].address = account;
  returned.pre_token_balances[0].account = account;
  returned.post_token_balances[0].account = account;
  const built = build([record(out), record(returned)]);

  assert.equal(built.ending_boundary.observed_wallet_owned_raw_quantity, null);
  assert.equal(built.ending_boundary.economic_continuity_status, 'UNRESOLVED');
  assert.equal(built.ending_boundary.valid_for_closed, false);
  assert.equal(built.ending_boundary.valid_for_open, false);
  assert.ok(built.findings.some(item => item.finding_code === 'TARGET_EFFECT_CAUSAL_SEMANTICS_UNRESOLVED'));
});

test('caller completeness declarations are rejected at the closed input boundary', () => {
  const tx = transaction('forged-completeness', { slot: 30, blockTime: 300 });
  const records = [record(tx)];
  const order = buildCanonicalTransactionOrderV13({
    wallet: WALLET,
    authoritative_population: [source(tx)],
    transaction_records: records,
  });
  assert.throws(() => buildTargetAccountBoundaryV13({
    wallet: WALLET,
    target_mint: TARGET,
    canonical_order: order,
    transaction_records: records,
    account_coverage_complete: true,
  }), error => error.code === 'unknown_field');
});
