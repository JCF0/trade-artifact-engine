#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectHeliusEnhancedTransactionV1 } from './helius-enhanced-projector.mjs';
import { buildWalletSourceTransactionFromSpotEvidenceV1 } from './solana-spot-evidence.mjs';
import { enhanced, JUP, PROGRAMS, providerSignature, RAY, USDC, WALLET } from './fixtures/slice4-fixtures.mjs';

function expectMalformed(value) { assert.throws(() => projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: value }), error => error?.code === 'malformed_provider_response'); }

test('projects Helius structured swaps, transfer corroboration, recognized programs, and source evidence', () => {
  const raw = enhanced('jup-buy');
  raw.description = 'non-authoritative prose MintSecret';
  raw.source = 'JUPITER';
  const evidence = projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: raw });
  assert.equal(evidence.signature, providerSignature('jup-buy'));
  assert.deepEqual(evidence.recognized_programs, [{ program_id: PROGRAMS.jupiter }]);
  assert.deepEqual(evidence.structured_swap_groups[0].token_inputs.map(x => [x.mint, x.raw_amount]), [[USDC, '25000000']]);
  assert.equal(evidence.token_transfer_legs.length, 2);
  assert.equal(JSON.stringify(evidence).includes('description'), false);
  const source = buildWalletSourceTransactionFromSpotEvidenceV1(evidence);
  assert.equal(source.token_operations.length, 4);
  assert.ok(Object.isFrozen(evidence) && Object.isFrozen(evidence.token_transfer_legs));
});

test('projects Raydium/Orca evidence, native transfers, failures, and unresolved unbound closures/self transfers', () => {
  for (const program of [PROGRAMS.raydium, PROGRAMS.orca]) assert.deepEqual(projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: enhanced(`program-${program.slice(0, 4)}`, { program }) }).recognized_programs, [{ program_id: program }]);
  const raw = enhanced('native', { transfers: false, type: 'TRANSFER', program: null });
  raw.nativeTransfers = [{ fromUserAccount: WALLET, toUserAccount: 'Other', amount: 5 }];
  raw.type = 'CLOSE_ACCOUNT';
  raw.accountData = [{ account: WALLET, nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, mint: JUP, rawTokenAmount: { tokenAmount: '0', decimals: 6 } }] }];
  const evidence = projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: raw });
  assert.equal(evidence.native_sol_transfer_legs[0].direction, 'debit');
  assert.equal(evidence.account_closures.length, 0);
  assert.ok(evidence.unresolved_wallet_effects.some(effect => effect.mint === JUP));

  const fallback = enhanced('close-fallback', { transfers: false, type: 'CLOSE_ACCOUNT' });
  fallback.events = {};
  fallback.tokenTransfers = [
    { fromUserAccount: WALLET, toUserAccount: 'Pool', mint: USDC, tokenAmount: 25 },
    { fromUserAccount: 'Pool', toUserAccount: WALLET, mint: JUP, tokenAmount: 100 },
  ];
  fallback.accountData = [{ tokenBalanceChanges: [
    { userAccount: WALLET, mint: USDC, rawTokenAmount: { tokenAmount: '-25000000', decimals: 6 } },
    { userAccount: WALLET, mint: JUP, rawTokenAmount: { tokenAmount: '100000000', decimals: 6 } },
  ] }];
  const fallbackEvidence = projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: fallback });
  assert.deepEqual(fallbackEvidence.token_transfer_legs.map(leg => leg.raw_amount), ['25000000', '100000000']);
  assert.equal(fallbackEvidence.unresolved_wallet_effects.filter(effect => effect.effect_id.startsWith('token-unresolved-')).length, 0);
  assert.equal(fallbackEvidence.account_closures.length, 0);
  assert.deepEqual(fallbackEvidence.unresolved_wallet_effects.filter(effect => effect.effect_id.startsWith('unbound-account-close-')).map(effect => effect.mint), [USDC, JUP]);
  const failed = projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: enhanced('failed', { failed: true }) });
  assert.equal(failed.execution_state, 'failed');
  const unresolved = projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: enhanced('self', { type: 'TRANSFER', program: null, unresolved: true }) });
  assert.deepEqual(unresolved.unresolved_wallet_effects, [{ effect_id: 'token-self-0', mint: JUP }]);
});

test('accepts safe exactly-scaled provider numbers and rejects unsafe binary-float raw recovery', () => {
  const binary = enhanced('binary-float', { transfers: false, type: 'TRANSFER', program: null });
  binary.events = {};
  binary.tokenTransfers = [{ fromUserAccount: WALLET, toUserAccount: 'Pool', mint: USDC, tokenAmount: 9007199254.740992 }];
  binary.accountData = [{ tokenBalanceChanges: [{ userAccount: WALLET, mint: USDC, rawTokenAmount: { tokenAmount: '-9007199254740993', decimals: 6 } }] }];
  assert.equal(projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: binary }).token_transfer_legs.length, 0);

  const exact = structuredClone(binary);
  exact.signature = providerSignature('exact-decimal');
  exact.tokenTransfers[0].tokenAmount = '9007199254.740993';
  assert.equal(projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: exact }).token_transfer_legs[0].raw_amount, '9007199254740993');

  const rounded = structuredClone(exact);
  rounded.signature = providerSignature('rounded-decimal');
  rounded.tokenTransfers[0].tokenAmount = '9007199254.740992';
  assert.equal(projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: rounded }).token_transfer_legs.length, 0);

  const aliasedSafeInteger = structuredClone(binary);
  aliasedSafeInteger.signature = providerSignature('aliased-safe-integer');
  aliasedSafeInteger.tokenTransfers[0].tokenAmount = 9007199254.74089;
  aliasedSafeInteger.accountData[0].tokenBalanceChanges[0].rawTokenAmount.tokenAmount = '-9007199254740890';
  assert.equal(projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: aliasedSafeInteger }).token_transfer_legs.length, 0);
});

test('does not use arbitrary mint mentions and fails malformed ownership/amount/body shapes closed', () => {
  const prose = enhanced('prose', { transfers: false, type: 'TRANSFER', program: null });
  prose.description = RAY;
  prose.events = {};
  assert.deepEqual(projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: prose }).unresolved_wallet_effects, []);
  const wrongOwner = enhanced('wrong-owner');
  wrongOwner.events.swap.tokenInputs[0].userAccount = 'Other';
  expectMalformed(wrongOwner);
  const badRaw = enhanced('bad-raw');
  badRaw.events.swap.tokenInputs[0].rawTokenAmount.tokenAmount = '01';
  expectMalformed(badRaw);
  for (const mint of ['_', '-', '1'.repeat(31), '1'.repeat(33)]) {
    const badMint = enhanced(`bad-mint-${mint.length}`);
    badMint.events.swap.tokenInputs[0].mint = mint;
    expectMalformed(badMint);
  }
  expectMalformed(new Proxy({}, { ownKeys() { throw new Error('secret'); } }));
});
