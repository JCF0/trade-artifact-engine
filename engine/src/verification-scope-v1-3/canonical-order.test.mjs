import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCanonicalTransactionOrderV13,
  buildIntraTransactionEffectOrderV13,
  validateCanonicalTransactionOrderStructureV13,
  validateIntraTransactionEffectOrderStructureV13,
  validateSourceBoundCanonicalTransactionOrderV13,
  validateSourceBoundIntraTransactionEffectOrderV13,
} from './canonical-order.mjs';
import { projectSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import { providerPublicKey, providerSignature } from '../wallet-acquisition/fixtures/slice4-fixtures.mjs';

const WALLET = providerPublicKey('slice3a-order-wallet');
const TARGET = providerPublicKey('slice3a-order-target');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function transaction(label, { slot, blockTime, rows = [], instructions = [], inner = [] } = {}) {
  const tokenAccounts = rows.map(row => providerPublicKey(`${label}-${row.label}`));
  const programAccounts = [...new Set([TOKEN_PROGRAM, ...instructions.map(item => item.program_id), ...inner.flatMap(group => group.instructions.map(item => item.program_id))])];
  const addresses = [WALLET, ...programAccounts, ...tokenAccounts];
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
  const tokenRows = side => rows.map((row, index) => ({
    account_index: addresses.indexOf(tokenAccounts[index]),
    account: tokenAccounts[index],
    mint: row.mint ?? TARGET,
    owner: row.owner === undefined ? WALLET : row.owner,
    raw_amount: String(side === 'pre' ? row.pre : row.post),
    decimals: 6,
    token_program: TOKEN_PROGRAM,
  }));
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
    instructions: instructions.map((item, index) => ({ instruction_index: index, ...item })),
    inner_instruction_groups: inner.map(group => ({
      outer_instruction_index: group.outer_instruction_index,
      instructions: group.instructions.map((item, index) => ({ instruction_index: index, ...item })),
    })),
  };
}

function record(tx) {
  return { transaction: tx, effect: projectSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: tx }) };
}
function source(tx) {
  return { signature: tx.signature, slot: tx.slot, block_time: tx.block_time, execution_state: tx.execution_state };
}

test('caller-supplied acquisition arrays cannot issue authoritative transaction order', () => {
  const older = transaction('zz-order-older', { slot: 10, blockTime: 100 });
  const newer = transaction('aa-order-newer', { slot: 11, blockTime: 101 });
  const built = buildCanonicalTransactionOrderV13({
    wallet: WALLET,
    authoritative_population: [source(newer), source(older)],
    transaction_records: [record(older), record(newer)],
  });

  assert.equal(built.order_status, 'UNRESOLVED');
  assert.equal(built.population_evidence_identity, null);
  assert.ok(built.transactions.every(item => item.acquisition_population_coordinate === null
    && item.canonical_transaction_coordinate === null));
  assert.equal(validateCanonicalTransactionOrderStructureV13(built), true);
  assert.equal(validateSourceBoundCanonicalTransactionOrderV13({
    wallet: WALLET,
    authoritative_population: [source(newer), source(older)],
    transaction_records: [record(older), record(newer)],
    order: built,
  }), true);
  assert.ok(Object.isFrozen(built.transactions[0].transaction_identity));

  const permuted = buildCanonicalTransactionOrderV13({
    wallet: WALLET,
    authoritative_population: [source(newer), source(older)],
    transaction_records: [record(newer), record(older)],
  });
  assert.deepEqual(permuted, built);
});

test('missing or contradictory population authority stays explicitly unresolved without guessed coordinates', () => {
  const older = transaction('unresolved-older', { slot: 10, blockTime: 100 });
  const newer = transaction('unresolved-newer', { slot: 11, blockTime: 101 });
  for (const population of [
    null,
    [],
    [source(older)],
    [source(newer), { ...source(older), block_time: 102 }],
  ]) {
    const built = buildCanonicalTransactionOrderV13({
      wallet: WALLET,
      authoritative_population: population,
      transaction_records: [record(older), record(newer)],
    });
    assert.equal(built.order_status, 'UNRESOLVED');
    assert.equal(built.population_evidence_identity, null);
    assert.deepEqual(built.reason_codes, ['INTRA_OR_INTER_TX_ORDER_UNRESOLVED']);
    assert.ok(built.transactions.every(item => item.acquisition_population_coordinate === null
      && item.canonical_transaction_coordinate === null));
  }
});

test('same-slot and same-time caller order remains unavailable without an admitted population carrier', () => {
  const firstFromProvider = transaction('zz-same-coordinate', { slot: 20, blockTime: 200 });
  const secondFromProvider = transaction('aa-same-coordinate', { slot: 20, blockTime: 200 });
  const built = buildCanonicalTransactionOrderV13({
    wallet: WALLET,
    authoritative_population: [source(firstFromProvider), source(secondFromProvider)],
    transaction_records: [record(secondFromProvider), record(firstFromProvider)],
  });
  assert.equal(built.order_status, 'UNRESOLVED');
  assert.deepEqual(built.transactions.map(item => item.transaction_identity.signature), [
    firstFromProvider.signature,
    secondFromProvider.signature,
  ].sort());

  const forged = structuredClone(built);
  forged.order_status = 'ESTABLISHED';
  forged.reason_codes = [];
  forged.population_evidence_identity = `order-evidence-${'0'.repeat(64)}`;
  forged.transactions[0].acquisition_population_coordinate = 0;
  forged.transactions[0].canonical_transaction_coordinate = 0;
  assert.throws(
    () => validateCanonicalTransactionOrderStructureV13(forged),
    error => error.code === 'invalid_order_status',
  );
});

test('provider timestamp inversion cannot become chronology authority', () => {
  const older = transaction('timestamp-older', { slot: 40, blockTime: 400 });
  const newer = transaction('timestamp-newer', { slot: 41, blockTime: 399 });
  const built = buildCanonicalTransactionOrderV13({
    wallet: WALLET,
    authoritative_population: [source(newer), source(older)],
    transaction_records: [record(older), record(newer)],
  });
  assert.equal(built.order_status, 'UNRESOLVED');
  assert.ok(built.transactions.every(item => item.canonical_transaction_coordinate === null));
});

test('intra-transaction ordering exposes instruction authority but never invents order for aggregate observations', () => {
  const tx = transaction('intra-aggregate', {
    slot: 30,
    blockTime: 300,
    rows: [
      { label: 'one', pre: 10, post: 5 },
      { label: 'two', pre: 0, post: 5 },
    ],
  });
  const effect = projectSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: tx });
  const built = buildIntraTransactionEffectOrderV13({ wallet: WALLET, target_mint: TARGET, transaction: tx, effect });

  assert.equal(built.order_status, 'UNRESOLVED');
  assert.deepEqual(built.reason_codes, ['INTRA_TX_EFFECT_ORDER_UNRESOLVED']);
  assert.equal(built.transaction_boundary_units.length, 1);
  assert.ok(built.aggregate_unordered_effects.every(item => item.economic_order === null
    && item.order_status === 'AGGREGATE_CAUSAL_ORDER_UNAVAILABLE'));
  assert.equal(built.ambiguity_groups.length, 1);
  assert.equal(built.ambiguity_groups[0].record_ids.length, 2);
  assert.equal(validateIntraTransactionEffectOrderStructureV13(built), true);
  assert.equal(validateSourceBoundIntraTransactionEffectOrderV13({
    wallet: WALLET, target_mint: TARGET, transaction: tx, effect, order: built,
  }), true);
});

test('instruction coordinates are deterministic while temporary internal state cannot split the transaction boundary', () => {
  const tx = transaction('instruction-order', {
    slot: 31,
    blockTime: 301,
    instructions: [
      { program_id: TOKEN_PROGRAM, accounts: [], data: '' },
      { program_id: TOKEN_PROGRAM, accounts: [], data: '' },
    ],
    inner: [{ outer_instruction_index: 0, instructions: [
      { program_id: TOKEN_PROGRAM, accounts: [], data: '' },
      { program_id: TOKEN_PROGRAM, accounts: [], data: '' },
    ] }],
  });
  const projected = projectSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: tx });
  const instructionResiduals = projected.residual_unresolved_effects.filter(item => item.source_coordinate.coordinate_kind === 'instruction');
  assert.equal(instructionResiduals.length, 0);

  const built = buildIntraTransactionEffectOrderV13({ wallet: WALLET, target_mint: TARGET, transaction: tx, effect: projected });
  assert.equal(built.transaction_boundary_units.length, 1);
  assert.deepEqual(built.instruction_ordered_effects, []);
  assert.equal(built.order_status, 'ESTABLISHED_WHERE_AUTHORITATIVE');
});

test('a Slice 2 residual instruction touching a target account keeps causal economic order unresolved', () => {
  const targetAccount = providerPublicKey('target-residual-order-one');
  const tx = transaction('target-residual-order', {
    slot: 32,
    blockTime: 302,
    rows: [{ label: 'one', pre: 0, post: 0 }],
    instructions: [{ program_id: TOKEN_PROGRAM, accounts: [targetAccount], data: '' }],
  });
  const effect = projectSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: tx });
  const built = buildIntraTransactionEffectOrderV13({ wallet: WALLET, target_mint: TARGET, transaction: tx, effect });
  assert.equal(built.order_status, 'UNRESOLVED');
  assert.deepEqual(built.reason_codes, ['INTRA_TX_EFFECT_ORDER_UNRESOLVED']);
  assert.equal(built.residual_unordered_effects.length, 1);
  assert.equal(built.residual_unordered_effects[0].economic_order, null);
  assert.match(built.ambiguity_groups[0].record_ids[0], /^residual-/);
});
