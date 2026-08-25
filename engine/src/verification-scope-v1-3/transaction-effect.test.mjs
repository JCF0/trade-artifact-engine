#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import * as transactionEffectContract from './transaction-effect.mjs';
import {
  canonicalTransactionEffectRecordIdV13,
  validateTransactionEffectStructureV13,
} from './transaction-effect.mjs';
import {
  projectSolanaFullTransactionEffectV13,
  validateSolanaFullTransactionEffectV13,
} from './solana-full-transaction-effect-projector.mjs';
import { providerPublicKey, providerSignature } from '../wallet-acquisition/fixtures/test-identities.mjs';

const WALLET = providerPublicKey('v13-effect-wallet');
const ROUTE = providerPublicKey('v13-effect-route');
const OTHER = providerPublicKey('v13-effect-other');
const TOKEN_ACCOUNT = providerPublicKey('v13-effect-token-account');
const MINT = providerPublicKey('v13-effect-mint');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function transaction(name = 'v13-effect-source') {
  return {
    full_transaction_version: 'solana_full_transaction_v1',
    signature: providerSignature(name),
    slot: 42,
    block_time: 1_780_000_000,
    execution_state: 'succeeded',
    transaction_version: 0,
    fee_payer: WALLET,
    fee_lamports: 5,
    accounts: [
      { address: WALLET, is_signer: true, is_writable: true, source: 'static' },
      { address: ROUTE, is_signer: false, is_writable: false, source: 'static' },
      { address: TOKEN_PROGRAM, is_signer: false, is_writable: false, source: 'static' },
      { address: TOKEN_ACCOUNT, is_signer: false, is_writable: true, source: 'static' },
    ],
    pre_lamport_balances: [1_000_000, 0, 0, 2_039_280],
    post_lamport_balances: [999_995, 0, 0, 2_039_280],
    pre_token_balances: [{
      account_index: 3, account: TOKEN_ACCOUNT, mint: MINT, owner: WALLET,
      raw_amount: '0', decimals: 6, token_program: TOKEN_PROGRAM,
    }],
    post_token_balances: [{
      account_index: 3, account: TOKEN_ACCOUNT, mint: MINT, owner: WALLET,
      raw_amount: '10', decimals: 6, token_program: TOKEN_PROGRAM,
    }],
    instructions: [{ instruction_index: 0, program_id: ROUTE, accounts: [WALLET, TOKEN_ACCOUNT], data: '' }],
    inner_instruction_groups: [],
  };
}

function project(source = transaction()) {
  return projectSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: source });
}

function reidentifyEffect(projection, index) {
  projection.established_effects[index].effect_id = canonicalTransactionEffectRecordIdV13({
    transaction_identity: projection.transaction_identity,
    analyzed_wallet: projection.analyzed_wallet,
    record_kind: 'effect',
    record: projection.established_effects[index],
  });
}

function reidentifyResidual(projection, index) {
  projection.residual_unresolved_effects[index].residual_id = canonicalTransactionEffectRecordIdV13({
    transaction_identity: projection.transaction_identity,
    analyzed_wallet: projection.analyzed_wallet,
    record_kind: 'residual',
    record: projection.residual_unresolved_effects[index],
  });
}

test('only the source-bound projector issues an immutable canonical transaction effect', () => {
  const source = transaction();
  const built = project(source);

  assert.equal(validateTransactionEffectStructureV13(built), true);
  assert.equal(validateSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: source, effect: built }), true);
  assert.equal(Object.isFrozen(built), true);
  assert.equal(Object.isFrozen(built.established_effects), true);
  assert.equal(Object.hasOwn(transactionEffectContract, 'buildTransactionEffectV13'), false);
  assert.match(built.established_effects[0].effect_id, /^effect-[0-9a-f]{64}$/);
});

test('a structurally canonical caller-authored quantity cannot pass source-bound authority', () => {
  const source = transaction();
  const forged = structuredClone(project(source));
  const tokenIndex = forged.established_effects.findIndex(effect => effect.effect_kind === 'token_balance_observation');
  forged.established_effects[tokenIndex].signed_raw_quantity = '999999';
  reidentifyEffect(forged, tokenIndex);
  forged.established_effects.sort((left, right) => left.canonical_order - right.canonical_order);

  assert.equal(validateTransactionEffectStructureV13(forged), true);
  assert.throws(
    () => validateSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: source, effect: forged }),
    error => error.code === 'transaction_effect_source_mismatch',
  );
});

test('canonical identities reject semantic duplicates and canonical order rejects permutations', () => {
  const built = project();
  const duplicate = structuredClone(built);
  const token = duplicate.established_effects.find(effect => effect.effect_kind === 'token_balance_observation');
  const tokenIndex = duplicate.established_effects.indexOf(token);
  duplicate.established_effects.splice(tokenIndex + 1, 0, structuredClone(token));
  duplicate.established_effects.forEach((effect, index) => { effect.canonical_order = index; });
  assert.throws(
    () => validateTransactionEffectStructureV13(duplicate),
    error => error.code === 'duplicate_effect_identity',
  );

  const reversed = structuredClone(built);
  reversed.established_effects.reverse();
  reversed.established_effects.forEach((effect, index) => { effect.canonical_order = index; });
  assert.throws(
    () => validateTransactionEffectStructureV13(reversed),
    error => error.code === 'noncanonical_effect_order',
  );

  const source = transaction('v13-residual-order');
  source.post_lamport_balances[1] += 1;
  const residualOrder = structuredClone(project(source));
  residualOrder.residual_unresolved_effects.reverse();
  residualOrder.residual_unresolved_effects.forEach((residual, index) => { residual.canonical_order = index; });
  assert.throws(
    () => validateTransactionEffectStructureV13(residualOrder),
    error => error.code === 'noncanonical_effect_order',
  );
});

test('residual reasons reject semantically impossible payloads', () => {
  const built = structuredClone(project());
  const residualIndex = built.residual_unresolved_effects.findIndex(
    residual => residual.reason_code === 'UNMATCHED_WALLET_INSTRUCTION',
  );
  const residual = built.residual_unresolved_effects[residualIndex];
  residual.reason_code = 'UNKNOWN_TOKEN_OWNER';
  residual.owner = WALLET;
  reidentifyResidual(built, residualIndex);

  assert.throws(
    () => validateTransactionEffectStructureV13(built),
    error => error.code === 'invalid_residual_shape',
  );

  for (const mutate of [
    residual => { residual.account = OTHER; },
    residual => { residual.account = WALLET; residual.owner = OTHER; },
    residual => {
      residual.account = WALLET;
      residual.owner = WALLET;
      residual.mint = null;
      residual.token_program = null;
    },
  ]) {
    const contradictory = structuredClone(project());
    const index = contradictory.residual_unresolved_effects.findIndex(
      item => item.reason_code === 'UNMATCHED_WALLET_INSTRUCTION',
    );
    mutate(contradictory.residual_unresolved_effects[index]);
    reidentifyResidual(contradictory, index);
    assert.throws(
      () => validateTransactionEffectStructureV13(contradictory),
      error => error.code === 'invalid_residual_shape',
    );
  }
});

test('lamport and fee quantities are bounded to the admitted safe-integer source domain', () => {
  const built = structuredClone(project());
  built.fee_lamports = '9'.repeat(10000);
  const feeIndex = built.established_effects.findIndex(effect => effect.effect_kind === 'network_fee');
  built.established_effects[feeIndex].signed_lamports = `-${built.fee_lamports}`;
  reidentifyEffect(built, feeIndex);

  assert.throws(
    () => validateTransactionEffectStructureV13(built),
    error => error.code === 'invalid_exact_integer',
  );
});

test('syntactically valid but source-impossible coordinates fail authoritative validation', () => {
  const source = transaction();
  const forged = structuredClone(project(source));
  const residualIndex = forged.residual_unresolved_effects.findIndex(
    residual => residual.reason_code === 'UNMATCHED_WALLET_INSTRUCTION',
  );
  forged.residual_unresolved_effects[residualIndex].source_coordinate.outer_instruction_index = 99;
  reidentifyResidual(forged, residualIndex);

  assert.equal(validateTransactionEffectStructureV13(forged), true);
  assert.throws(
    () => validateSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: source, effect: forged }),
    error => error.code === 'transaction_effect_source_mismatch',
  );
});

test('observations and attributed components carry deterministic reconciliation provenance', () => {
  const built = project();
  const fee = built.established_effects.find(effect => effect.effect_kind === 'network_fee');
  const walletNative = built.established_effects.find(
    effect => effect.effect_kind === 'native_balance_observation' && effect.account === WALLET,
  );
  const token = built.established_effects.find(effect => effect.effect_kind === 'token_balance_observation');

  assert.equal(fee.evidence_role, 'attributed_component');
  assert.deepEqual(fee.corroborating_effect_ids, [walletNative.effect_id]);
  assert.equal(walletNative.evidence_role, 'observation');
  assert.deepEqual(walletNative.corroborating_effect_ids, []);
  assert.equal(token.evidence_role, 'observation');
  assert.ok(built.established_effects.every((effect, index) => effect.canonical_order === index));
});

test('record identities bind the analyzed wallet as well as transaction evidence', () => {
  const built = project();
  const effect = built.established_effects.find(item => item.effect_kind === 'network_fee');
  const otherWalletId = canonicalTransactionEffectRecordIdV13({
    transaction_identity: built.transaction_identity,
    analyzed_wallet: ROUTE,
    record_kind: 'effect',
    record: effect,
  });
  assert.notEqual(otherWalletId, effect.effect_id);
});

test('structural and authoritative boundaries reject unknown fields, accessors, and proxies', () => {
  const built = structuredClone(project());
  built.unrecognized = true;
  assert.throws(
    () => validateTransactionEffectStructureV13(built),
    error => error.code === 'unknown_field',
  );

  const accessor = structuredClone(project());
  let accessorCalls = 0;
  Object.defineProperty(accessor.established_effects[0], 'signed_lamports', {
    enumerable: true,
    get() { accessorCalls += 1; return '-5'; },
  });
  assert.throws(
    () => validateTransactionEffectStructureV13(accessor),
    error => error.code === 'accessor_not_allowed',
  );
  assert.equal(accessorCalls, 0);

  const proxied = new Proxy(project(), { get() { throw new Error('proxy trap executed'); } });
  assert.throws(
    () => validateSolanaFullTransactionEffectV13({
      wallet: WALLET, transaction: transaction(), effect: proxied,
    }),
    error => error.code === 'proxy_not_allowed',
  );
});
