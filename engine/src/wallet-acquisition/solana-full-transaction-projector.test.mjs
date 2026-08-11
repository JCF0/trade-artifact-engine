#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOLANA_FULL_TRANSACTION_UNRESOLVED_REASONS_V1,
  getSolanaFullTransactionUnresolvedReasonV1,
  getSolanaFullTransactionUnresolvedReasonSetV1,
  projectSolanaFullTransactionV1,
} from './solana-full-transaction-projector.mjs';
import { buildWalletSourceTransactionFromSpotEvidenceV1 } from './solana-spot-evidence.mjs';
import { classifyWalletSourceTransactionV1 } from './transaction-classifier.mjs';
import { normalizeWalletWideSolanaSpotEvidenceV1 } from './wallet-wide-normalizer.mjs';
import { getWalletAcquisitionFailureDiagnosticV1 } from './provider-port.mjs';
import { providerPublicKey, providerSignature } from './fixtures/test-identities.mjs';
import { JUP, PROGRAMS, RAY, USDC, USDT, WALLET } from './fixtures/spot-normalizer-fixtures.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const MANIFEST_ROUTE_PROGRAM = 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms';
const MANIFEST_ROUTE_DATA = '3QDBF27AwRXDMN627wXRP6ACgg';
const OTHER_PROGRAM = providerPublicKey('full-projector-other-program');
const SPONSOR = providerPublicKey('full-projector-sponsor');

function transaction(name, {
  feePayer = WALLET,
  fee = 5,
  walletDelta = -fee,
  program = PROGRAMS.jupiter,
  programLocation = 'top',
  executionState = 'succeeded',
  tokenRows = [
    { label: 'input', mint: USDC, owner: WALLET, pre: '25000000', post: '0', decimals: 6 },
    { label: 'output', mint: JUP, owner: WALLET, pre: '0', post: '100000000', decimals: 6 },
  ],
  includeWalletAccount = true,
} = {}) {
  const staticAddresses = [feePayer];
  if (includeWalletAccount && feePayer !== WALLET) staticAddresses.push(WALLET);
  for (const address of [programLocation === 'top' ? program : OTHER_PROGRAM, TOKEN_PROGRAM, ...(programLocation === 'inner' ? [program] : [])]) {
    if (!staticAddresses.includes(address)) staticAddresses.push(address);
  }
  const tokenAccounts = tokenRows.map((row, index) => providerPublicKey(`${name}-${row.label}-${index}`));
  const accounts = [
    ...staticAddresses.map((address, index) => ({
      address,
      is_signer: index === 0 || address === WALLET,
      is_writable: index === 0 || address === WALLET,
      source: 'static',
    })),
    ...tokenAccounts.map(address => ({ address, is_signer: false, is_writable: true, source: 'lookup_writable' })),
  ];
  const walletIndex = staticAddresses.indexOf(WALLET);
  const preLamports = accounts.map(() => 0);
  const postLamports = accounts.map(() => 0);
  preLamports[0] = feePayer === WALLET ? 1_000_000_000 : 2_000_000_000;
  postLamports[0] = preLamports[0] - fee;
  if (walletIndex >= 0) {
    preLamports[walletIndex] = 1_000_000_000;
    postLamports[walletIndex] = preLamports[walletIndex] + walletDelta;
    if (walletIndex === 0) postLamports[0] = preLamports[0] + walletDelta;
  }
  const counterpartyIndex = staticAddresses.findIndex(address => address !== feePayer && address !== WALLET);
  const walletEconomicDelta = BigInt(walletDelta) + BigInt(feePayer === WALLET ? fee : 0);
  if (counterpartyIndex >= 0 && walletEconomicDelta !== 0n) {
    preLamports[counterpartyIndex] = 1_000_000_000;
    postLamports[counterpartyIndex] = Number(BigInt(preLamports[counterpartyIndex]) - walletEconomicDelta);
  }
  tokenAccounts.forEach((_, index) => {
    const accountIndex = staticAddresses.length + index;
    preLamports[accountIndex] = 2_039_280;
    postLamports[accountIndex] = 2_039_280;
  });
  const balanceRows = side => tokenRows.flatMap((row, index) => {
    const amount = row[side];
    if (amount === undefined) return [];
    const accountIndex = staticAddresses.length + index;
    return [{
      account_index: accountIndex,
      account: tokenAccounts[index],
      mint: row.mint,
      owner: row.owner,
      raw_amount: amount,
      decimals: row.decimals,
      token_program: TOKEN_PROGRAM,
    }];
  });
  const topProgram = programLocation === 'top' ? program : OTHER_PROGRAM;
  const instructions = [{
    instruction_index: 0,
    program_id: topProgram,
    accounts: programLocation === 'inner' ? [] : [feePayer],
    data: '',
  }];
  const inner_instruction_groups = programLocation === 'inner'
    ? [{ outer_instruction_index: 0, instructions: [{ instruction_index: 0, program_id: program, accounts: [feePayer], data: '' }] }]
    : [];
  return {
    full_transaction_version: 'solana_full_transaction_v1',
    signature: providerSignature(name),
    slot: 1234,
    block_time: 1_780_000_000,
    execution_state: executionState,
    transaction_version: 0,
    fee_payer: feePayer,
    fee_lamports: fee,
    accounts,
    pre_lamport_balances: preLamports,
    post_lamport_balances: postLamports,
    pre_token_balances: balanceRows('pre'),
    post_token_balances: balanceRows('post'),
    instructions,
    inner_instruction_groups,
  };
}

function project(value) {
  return projectSolanaFullTransactionV1({ wallet: WALLET, transaction: value });
}

function classify(value) {
  const evidence = project(value);
  return classifyWalletSourceTransactionV1({
    sourceTransaction: buildWalletSourceTransactionFromSpotEvidenceV1(evidence),
    normalizeSupportedSpotOperation: () => normalizeWalletWideSolanaSpotEvidenceV1({ evidence, provisional_raw_index: 0 }),
  });
}

function disposition(value) {
  return classify(value).disposition.disposition_type;
}

test('reconstructs separately identified same-mint wallet account legs and aggregates RAY 24,975 + 25 exactly once', () => {
  const value = transaction('ray-same-mint', {
    program: PROGRAMS.raydium,
    programLocation: 'inner',
    tokenRows: [
      { label: 'usdt-main', mint: USDT, owner: WALLET, pre: '24975000000', post: '0', decimals: 6 },
      { label: 'usdt-small', mint: USDT, owner: WALLET, pre: '25000000', post: '0', decimals: 6 },
      { label: 'ray-output', mint: RAY, owner: WALLET, pre: '0', post: '125000000', decimals: 6 },
    ],
  });
  const evidence = project(value);
  assert.equal(evidence.provider_transaction_type, null);
  assert.deepEqual(evidence.recognized_programs, [{ program_id: PROGRAMS.raydium }]);
  assert.deepEqual(evidence.token_transfer_legs.map(leg => [leg.leg_id, leg.direction, leg.mint, leg.raw_amount]), [
    ['token-account-000004', 'debit', USDT, '24975000000'],
    ['token-account-000005', 'debit', USDT, '25000000'],
    ['token-account-000006', 'credit', RAY, '125000000'],
  ]);
  const result = classify(value);
  assert.equal(result.disposition.disposition_type, 'supported_normalized_event');
  assert.equal(result.normalized_event_records[0].slice7_event.token_in_amount, 25000);
});

test('supports one recognized top-level route with nested recognized venues and an authority-only inner program', () => {
  const value = transaction('nested-routed-swap');
  const nestedVenue = PROGRAMS.raydium;
  value.accounts.push(
    { address: OTHER_PROGRAM, is_signer: false, is_writable: false, source: 'lookup_readonly' },
    { address: MANIFEST_ROUTE_PROGRAM, is_signer: false, is_writable: false, source: 'lookup_readonly' },
    { address: nestedVenue, is_signer: false, is_writable: false, source: 'lookup_readonly' },
    { address: SYSTEM_PROGRAM, is_signer: false, is_writable: false, source: 'lookup_readonly' },
    { address: USDT, is_signer: false, is_writable: false, source: 'lookup_readonly' },
    { address: USDC, is_signer: false, is_writable: false, source: 'lookup_readonly' },
  );
  value.pre_lamport_balances.push(0, 0, 0, 0, 0, 0);
  value.post_lamport_balances.push(0, 0, 0, 0, 0, 0);
  value.inner_instruction_groups.push({
    outer_instruction_index: 0,
    instructions: [
      { instruction_index: 0, program_id: nestedVenue, accounts: [], data: '' },
      {
        instruction_index: 1,
        program_id: MANIFEST_ROUTE_PROGRAM,
        accounts: [
          WALLET, OTHER_PROGRAM, nestedVenue, SYSTEM_PROGRAM, OTHER_PROGRAM, nestedVenue, OTHER_PROGRAM,
          nestedVenue, TOKEN_PROGRAM, USDT, TOKEN_PROGRAM, USDC, OTHER_PROGRAM, nestedVenue,
        ],
        data: MANIFEST_ROUTE_DATA,
      },
    ],
  });
  const evidence = project(value);
  assert.deepEqual(evidence.recognized_programs, [
    { program_id: nestedVenue },
    { program_id: PROGRAMS.jupiter },
  ]);
  assert.deepEqual(evidence.unresolved_wallet_effects, []);
  assert.equal(disposition(value), 'supported_normalized_event');

  const repeatedTopLevelRoute = structuredClone(value);
  repeatedTopLevelRoute.signature = providerSignature('repeated-top-level-route');
  repeatedTopLevelRoute.instructions.push({
    instruction_index: 1,
    program_id: PROGRAMS.jupiter,
    accounts: [],
    data: '',
  });
  assert.equal(disposition(repeatedTopLevelRoute), 'unsupported_activity');

  const recognizedInnerUnderUnrelatedOuter = structuredClone(value);
  recognizedInnerUnderUnrelatedOuter.signature = providerSignature('recognized-inner-under-unrelated-outer');
  recognizedInnerUnderUnrelatedOuter.instructions.push({
    instruction_index: 1,
    program_id: OTHER_PROGRAM,
    accounts: [],
    data: '',
  });
  recognizedInnerUnderUnrelatedOuter.inner_instruction_groups.push({
    outer_instruction_index: 1,
    instructions: [{ instruction_index: 0, program_id: nestedVenue, accounts: [], data: '' }],
  });
  assert.equal(disposition(recognizedInnerUnderUnrelatedOuter), 'unsupported_activity');

  const arbitraryNestedProgram = structuredClone(value);
  arbitraryNestedProgram.signature = providerSignature('arbitrary-nested-program');
  arbitraryNestedProgram.inner_instruction_groups[0].instructions[1].program_id = OTHER_PROGRAM;
  assert.equal(disposition(arbitraryNestedProgram), 'ambiguous_activity');
  assert.equal(
    getSolanaFullTransactionUnresolvedReasonV1(project(arbitraryNestedProgram)),
    'unsupported_nested_instruction_shape',
  );

  const unknownManifestInstruction = structuredClone(value);
  unknownManifestInstruction.signature = providerSignature('unknown-manifest-instruction');
  unknownManifestInstruction.inner_instruction_groups[0].instructions[1].data = '1';
  assert.equal(disposition(unknownManifestInstruction), 'ambiguous_activity');

  const topLevelAuthorityOnly = structuredClone(value);
  topLevelAuthorityOnly.signature = providerSignature('top-level-authority-only');
  topLevelAuthorityOnly.instructions.push({
    instruction_index: 1,
    program_id: MANIFEST_ROUTE_PROGRAM,
    accounts: [WALLET],
    data: '',
  });
  assert.equal(disposition(topLevelAuthorityOnly), 'ambiguous_activity');

  const nestedWalletTokenEffect = structuredClone(value);
  nestedWalletTokenEffect.signature = providerSignature('nested-wallet-token-effect');
  nestedWalletTokenEffect.inner_instruction_groups[0].instructions[1].accounts.push(
    nestedWalletTokenEffect.pre_token_balances[0].account,
  );
  assert.equal(disposition(nestedWalletTokenEffect), 'ambiguous_activity');

  const nestedSystemEffect = structuredClone(value);
  nestedSystemEffect.signature = providerSignature('nested-system-effect');
  nestedSystemEffect.inner_instruction_groups[0].instructions.push({
    instruction_index: 2,
    program_id: SYSTEM_PROGRAM,
    accounts: [WALLET],
    data: '',
  });
  assert.equal(disposition(nestedSystemEffect), 'ambiguous_activity');

});

test('keeps unmatched wallet-relevant Token instructions unresolved both top-level and inside a recognized DEX instruction', () => {
  const make = location => {
    const value = transaction(`unmatched-token-${location}`);
    const walletTokenAccount = value.pre_token_balances[0].account;
    const instruction = {
      instruction_index: location === 'top' ? 1 : 0,
      program_id: TOKEN_PROGRAM,
      accounts: [walletTokenAccount, WALLET],
      data: '7',
    };
    if (location === 'top') value.instructions.push(instruction);
    else value.inner_instruction_groups.push({ outer_instruction_index: 0, instructions: [instruction] });
    return value;
  };
  for (const location of ['top','inner']) {
    const value = make(location);
    const evidence = project(value);
    assert.deepEqual(evidence.unresolved_wallet_effects.map(effect => effect.mint), [null]);
    assert.equal(
      getSolanaFullTransactionUnresolvedReasonV1(evidence),
      location === 'inner' ? 'unsupported_nested_instruction_shape' : 'unmatched_wallet_instruction',
    );
    assert.equal(disposition(value), 'ambiguous_activity');
  }
});

test('uses the reconciled pre/post union only for wallet-owned token accounts, including pre-only and post-only rows', () => {
  const externalOwner = providerPublicKey('full-projector-external-owner');
  const value = transaction('token-union', {
    tokenRows: [
      { label: 'pre-only', mint: USDC, owner: WALLET, pre: '25000000', post: undefined, decimals: 6 },
      { label: 'post-only', mint: JUP, owner: WALLET, pre: undefined, post: '100000000', decimals: 6 },
      { label: 'zero', mint: RAY, owner: WALLET, pre: '7', post: '7', decimals: 6 },
      { label: 'external', mint: RAY, owner: externalOwner, pre: '1', post: '9', decimals: 6 },
    ],
  });
  const evidence = project(value);
  assert.deepEqual(evidence.token_transfer_legs.map(leg => [leg.direction, leg.mint, leg.raw_amount]), [
    ['debit', USDC, '25000000'], ['credit', JUP, '100000000'],
  ]);
  assert.equal(disposition(value), 'supported_normalized_event');
});

test('unknown token ownership remains unresolved instead of allowing an attractive partial swap', () => {
  const value = transaction('unknown-token-owner', {
    tokenRows: [
      { label: 'input', mint: USDC, owner: WALLET, pre: '25000000', post: '0', decimals: 6 },
      { label: 'output', mint: JUP, owner: WALLET, pre: '0', post: '100000000', decimals: 6 },
      { label: 'unknown', mint: RAY, owner: null, pre: '0', post: '7', decimals: 6 },
    ],
  });
  const result = classify(value);
  assert.equal(result.disposition.disposition_type, 'ambiguous_activity');
  assert.deepEqual(project(value).unresolved_wallet_effects, [
    { effect_id: 'full-transaction-unresolved-0', mint: RAY },
  ]);
  assert.equal(getSolanaFullTransactionUnresolvedReasonV1(project(value)), 'unknown_token_scope');
});

test('derives native swap economics from the explicit wallet lamport delta after the explicit fee', () => {
  const value = transaction('native-input', {
    fee: 5000,
    walletDelta: -10_005_000,
    tokenRows: [{ label: 'output', mint: JUP, owner: WALLET, pre: '0', post: '100000000', decimals: 6 }],
  });
  const evidence = project(value);
  assert.deepEqual(evidence.native_sol_transfer_legs, [{
    leg_id: 'native-wallet-000000', economic_group: 'swap-0', direction: 'debit', owner: WALLET,
    amount_lamports: 10_000_000,
  }]);
  assert.equal(disposition(value), 'supported_normalized_event');
  assert.equal(classify(value).normalized_event_records[0].slice7_event.token_in_amount, 0.01);

  const nativeOutput = transaction('native-output', {
    fee: 5000,
    walletDelta: 9_995_000,
    tokenRows: [{ label: 'input', mint: JUP, owner: WALLET, pre: '100000000', post: '0', decimals: 6 }],
  });
  assert.deepEqual(project(nativeOutput).native_sol_transfer_legs, [{
    leg_id: 'native-wallet-000000', economic_group: 'swap-0', direction: 'credit', owner: WALLET,
    amount_lamports: 10_000_000,
  }]);
  assert.equal(disposition(nativeOutput), 'supported_normalized_event');

  const explicitZeroFee = transaction('explicit-zero-fee', { fee: 0, walletDelta: 0 });
  assert.equal(disposition(explicitZeroFee), 'supported_normalized_event');
  const missingFee = transaction('missing-fee');
  delete missingFee.fee_lamports;
  assert.throws(() => project(missingFee), error => error?.code === 'malformed_provider_response'
    && getWalletAcquisitionFailureDiagnosticV1(error)?.reason === 'full_transaction_shape_invalid');
});

test('impossible transaction-wide lamport equations and unmatched wallet instructions remain unresolved', () => {
  const impossible = transaction('impossible-native-equation');
  impossible.post_lamport_balances[1] += 1;
  assert.equal(disposition(impossible), 'ambiguous_activity');
  const impossibleEvidence = project(impossible);
  assert.ok(impossibleEvidence.unresolved_wallet_effects.some(effect => effect.mint === null));
  assert.equal(getSolanaFullTransactionUnresolvedReasonV1(impossibleEvidence), 'native_balance_unreconciled');

  const distinctTransfer = transaction('swap-plus-distinct-transfer');
  distinctTransfer.instructions.push({
    instruction_index: 1,
    program_id: TOKEN_PROGRAM,
    accounts: [WALLET],
    data: '3',
  });
  assert.equal(disposition(distinctTransfer), 'ambiguous_activity');
  assert.ok(project(distinctTransfer).unresolved_wallet_effects.some(effect => effect.mint === null));

  const distinctInnerTransfer = transaction('inner-extra', { programLocation: 'inner' });
  distinctInnerTransfer.inner_instruction_groups[0].instructions.push({
    instruction_index: 1,
    program_id: TOKEN_PROGRAM,
    accounts: [WALLET],
    data: '',
  });
  assert.equal(disposition(distinctInnerTransfer), 'ambiguous_activity');
});

test('records fixed private reasons for missing wallet evidence, native overflow, and multiple classes', () => {
  assert.deepEqual(SOLANA_FULL_TRANSACTION_UNRESOLVED_REASONS_V1, [
    'unknown_token_scope',
    'wallet_account_evidence_unresolved',
    'native_balance_unreconciled',
    'closure_evidence_unreconciled',
    'closure_rent_unreconciled',
    'quote_mint_closure_unreconciled',
    'unmatched_wallet_instruction',
    'unsupported_nested_instruction_shape',
    'native_amount_out_of_range',
    'multiple_unresolved_classes',
  ]);

  const missingWallet = transaction('reason-missing-wallet', {
    feePayer: SPONSOR, includeWalletAccount: false, tokenRows: [], walletDelta: 0,
  });
  assert.equal(
    getSolanaFullTransactionUnresolvedReasonV1(project(missingWallet)),
    'wallet_account_evidence_unresolved',
  );

  const overflow = transaction('reason-native-overflow', { fee: 1, walletDelta: 0, tokenRows: [] });
  overflow.pre_lamport_balances.fill(0);
  overflow.post_lamport_balances.fill(0);
  overflow.pre_lamport_balances[1] = Number.MAX_SAFE_INTEGER;
  overflow.pre_lamport_balances[2] = 1;
  overflow.post_lamport_balances[0] = Number.MAX_SAFE_INTEGER;
  const overflowEvidence = project(overflow);
  assert.deepEqual(overflowEvidence.unresolved_wallet_effects.map(effect => effect.mint), [null]);
  assert.equal(getSolanaFullTransactionUnresolvedReasonV1(overflowEvidence), 'native_amount_out_of_range');

  const multiple = transaction('reason-multiple');
  multiple.post_lamport_balances[1] += 1;
  multiple.instructions.push({
    instruction_index: 1,
    program_id: TOKEN_PROGRAM,
    accounts: [WALLET],
    data: '3',
  });
  const multipleEvidence = project(multiple);
  assert.equal(getSolanaFullTransactionUnresolvedReasonV1(multipleEvidence), 'multiple_unresolved_classes');
  assert.deepEqual(getSolanaFullTransactionUnresolvedReasonSetV1(multipleEvidence), [
    'native_balance_unreconciled',
    'unmatched_wallet_instruction',
  ]);

  multiple.instructions.push({
    instruction_index: 2,
    program_id: SYSTEM_PROGRAM,
    accounts: [WALLET],
    data: '7',
  });
  assert.deepEqual(getSolanaFullTransactionUnresolvedReasonSetV1(project(multiple)), [
    'native_balance_unreconciled',
    'unmatched_wallet_instruction',
  ]);

  const three = transaction('reason-three', { tokenRows: [
    { label: 'unknown', mint: JUP, owner: null, pre: '1', post: '2', decimals: 6 },
  ] });
  three.post_lamport_balances[1] += 1;
  three.instructions.push({
    instruction_index: 1,
    program_id: TOKEN_PROGRAM,
    accounts: [WALLET],
    data: '3',
  });
  const threeEvidence = project(three);
  assert.equal(getSolanaFullTransactionUnresolvedReasonV1(threeEvidence), 'multiple_unresolved_classes');
  assert.deepEqual(getSolanaFullTransactionUnresolvedReasonSetV1(threeEvidence), [
    'native_balance_unreconciled',
    'unknown_token_scope',
    'unmatched_wallet_instruction',
  ]);
  assert.equal(getSolanaFullTransactionUnresolvedReasonSetV1(overflowEvidence), null);
});

test('recognizes only actual top-level and inner Jupiter, Raydium, and Orca program IDs', () => {
  for (const [program, location] of [
    [PROGRAMS.jupiter, 'top'], [PROGRAMS.raydium, 'inner'], [PROGRAMS.orca, 'top'],
  ]) {
    try {
      assert.deepEqual(project(transaction(`program-${program.slice(0, 5)}-${location}`, { program, programLocation: location })).recognized_programs, [{ program_id: program }]);
    } catch (error) {
      assert.fail(`${program}/${location}: ${error?.code}/${getWalletAcquisitionFailureDiagnosticV1(error)?.reason}`);
    }
  }

  const unrelatedProgram = transaction('unrecognized-program', { program: TOKEN_PROGRAM });
  unrelatedProgram.instructions[0].accounts = [];
  const evidence = project(unrelatedProgram);
  assert.deepEqual(evidence.recognized_programs, []);
  assert.equal(evidence.provider_transaction_type, null);
  try {
    assert.equal(disposition(unrelatedProgram), 'unsupported_activity');
  } catch (error) {
    assert.fail(`classification: ${error?.code}/${getWalletAcquisitionFailureDiagnosticV1(error)?.reason}`);
  }
});

test('exercises supported, unsupported, ambiguous, unrelated, and failed dispositions without broadening complex shapes', () => {
  assert.equal(disposition(transaction('supported')), 'supported_normalized_event');

  const sponsored = transaction('sponsored', { feePayer: SPONSOR, walletDelta: -10_000_000 });
  assert.equal(disposition(sponsored), 'unsupported_activity');
  assert.equal(project(sponsored).native_sol_transfer_legs[0].amount_lamports, 10_000_000);

  const batch = transaction('batch', { tokenRows: [
    { label: 'input', mint: USDC, owner: WALLET, pre: '25000000', post: '0', decimals: 6 },
    { label: 'output-a', mint: JUP, owner: WALLET, pre: '0', post: '100000000', decimals: 6 },
    { label: 'output-b', mint: RAY, owner: WALLET, pre: '0', post: '1', decimals: 6 },
  ] });
  assert.equal(disposition(batch), 'unsupported_activity');

  const missingWalletEvidence = transaction('missing-wallet-evidence', {
    feePayer: SPONSOR, includeWalletAccount: false, walletDelta: 0,
  });
  const ambiguous = classify(missingWalletEvidence);
  assert.equal(ambiguous.disposition.disposition_type, 'ambiguous_activity');
  assert.equal(ambiguous.activity_findings[0].impact_scope, 'wallet_wide');
  assert.equal(
    getSolanaFullTransactionUnresolvedReasonV1(project(missingWalletEvidence)),
    'wallet_account_evidence_unresolved',
  );

  const unrelated = transaction('unrelated', { tokenRows: [], fee: 5, walletDelta: -5 });
  assert.equal(disposition(unrelated), 'unrelated_activity');

  const failed = transaction('failed', { executionState: 'failed', walletDelta: -999, tokenRows: [
    { label: 'input', mint: USDC, owner: WALLET, pre: '25000000', post: '0', decimals: 6 },
    { label: 'output', mint: JUP, owner: WALLET, pre: '0', post: '100000000', decimals: 6 },
  ] });
  const failedEvidence = project(failed);
  assert.equal(disposition(failed), 'failed_transaction');
  assert.deepEqual(failedEvidence.token_transfer_legs, []);
  assert.deepEqual(failedEvidence.native_sol_transfer_legs, []);
  assert.deepEqual(failedEvidence.unresolved_wallet_effects, []);
});
