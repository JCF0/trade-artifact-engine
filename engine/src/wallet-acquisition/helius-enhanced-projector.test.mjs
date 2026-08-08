#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectHeliusEnhancedTransactionV1 } from './helius-enhanced-projector.mjs';
import { buildWalletSourceTransactionFromSpotEvidenceV1 } from './solana-spot-evidence.mjs';
import { classifyWalletSourceTransactionV1 } from './transaction-classifier.mjs';
import { normalizeWalletWideSolanaSpotEvidenceV1 } from './wallet-wide-normalizer.mjs';
import { enhanced, JUP, PROGRAMS, providerPublicKey, providerSignature, RAY, USDC, WALLET } from './fixtures/slice4-fixtures.mjs';
import { getWalletAcquisitionFailureDiagnosticV1 } from './provider-port.mjs';

function expectMalformed(value, reason = 'enhanced_transaction_shape_invalid') {
  assert.throws(() => projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: value }), error => (
    error?.code === 'malformed_provider_response'
    && getWalletAcquisitionFailureDiagnosticV1(error)?.reason === reason
  ));
}

function classify(transaction) {
  const evidence = projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction });
  return classifyWalletSourceTransactionV1({
    sourceTransaction: buildWalletSourceTransactionFromSpotEvidenceV1(evidence),
    normalizeSupportedSpotOperation: () => normalizeWalletWideSolanaSpotEvidenceV1({ evidence, provisional_raw_index: 0 }),
  });
}

function withWalletNativeEvidence(transaction, { fee = 5, walletChange = -fee } = {}) {
  transaction.fee = fee;
  transaction.accountData = transaction.accountData.filter(account => account.account !== WALLET);
  transaction.accountData.push({ account: WALLET, nativeBalanceChange: walletChange, tokenBalanceChanges: [] });
  return transaction;
}

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
  assert.deepEqual(fallbackEvidence.token_transfer_legs.map(leg => leg.raw_amount).sort(), ['100000000', '25000000']);
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
  expectMalformed(new Proxy({}, { ownKeys() { throw new Error('secret'); } }), 'enhanced_projection_internal_rejection');
});

test('attractive swap plus an unmatched wallet-owned nonquote accountData change cannot remain supported', () => {
  const transaction = enhanced('secondary-account-change');
  const secondaryMint = providerPublicKey('secondary-position-mint');
  const tokenAccount = providerPublicKey('secondary-token-account');
  transaction.accountData = [{
    account: tokenAccount,
    nativeBalanceChange: 0,
    tokenBalanceChanges: [{
      userAccount: WALLET,
      tokenAccount,
      mint: secondaryMint,
      rawTokenAmount: { tokenAmount: '7', decimals: 0 },
    }],
  }, { account: WALLET, nativeBalanceChange: 0, tokenBalanceChanges: [] }];
  const result = classify(transaction);
  assert.notEqual(result.disposition.disposition_type, 'supported_normalized_event');
  assert.ok(result.disposition.affected_token_mints.includes(secondaryMint));
});

test('wallet token balance changes exactly corroborating structured and transfer legs count once', () => {
  const transaction = enhanced('corroborated-account-changes');
  transaction.accountData = [
    { account: providerPublicKey('corroborated-input-account'), nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, mint: USDC, rawTokenAmount: { tokenAmount: '-25000000', decimals: 6 } }] },
    { account: providerPublicKey('corroborated-output-account'), nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, mint: JUP, rawTokenAmount: { tokenAmount: '100000000', decimals: 6 } }] },
    { account: WALLET, nativeBalanceChange: 0, tokenBalanceChanges: [] },
  ];
  const evidence = projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction });
  assert.deepEqual(evidence.unresolved_wallet_effects, []);
  assert.equal(classify(transaction).disposition.disposition_type, 'supported_normalized_event');
});

test('unmatched quote-token, conflicting, and unknown-mint account changes fail conservatively', () => {
  const quote = enhanced('unmatched-quote-change');
  quote.accountData = [{ account: providerPublicKey('quote-account'), nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, mint: USDC, rawTokenAmount: { tokenAmount: '-1', decimals: 6 } }] }];
  assert.notEqual(classify(quote).disposition.disposition_type, 'supported_normalized_event');

  const conflict = enhanced('conflicting-account-change');
  conflict.accountData = [{ account: providerPublicKey('conflict-account'), nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, mint: JUP, rawTokenAmount: { tokenAmount: '99999999', decimals: 6 } }] }];
  assert.notEqual(classify(conflict).disposition.disposition_type, 'supported_normalized_event');

  const unknown = enhanced('unknown-mint-account-change');
  unknown.accountData = [{ account: providerPublicKey('unknown-account'), nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, mint: 'unknown', rawTokenAmount: { tokenAmount: '1', decimals: 0 } }] }];
  const unknownResult = classify(unknown);
  assert.equal(unknownResult.disposition.disposition_type, 'ambiguous_activity');
  assert.deepEqual(unknownResult.disposition.affected_token_mints, []);
  assert.equal(unknownResult.activity_findings[0].impact_scope, 'wallet_wide');
});

test('unexplained native change blocks support while exact native swap transfer plus fee is corroboration', () => {
  const unexplained = enhanced('unexplained-native');
  unexplained.accountData = [{ account: WALLET, nativeBalanceChange: 1, tokenBalanceChanges: [] }];
  assert.notEqual(classify(unexplained).disposition.disposition_type, 'supported_normalized_event');

  const unknownOwner = enhanced('unknown-owner-native');
  unknownOwner.accountData = [{ nativeBalanceChange: 1, tokenBalanceChanges: [] }];
  assert.notEqual(classify(unknownOwner).disposition.disposition_type, 'supported_normalized_event');

  const ownedTokenAccount = enhanced('owned-token-account-native');
  const ownedAccount = providerPublicKey('owned-native-token-account');
  ownedTokenAccount.accountData = [{ account: ownedAccount, nativeBalanceChange: 1, tokenBalanceChanges: [{ userAccount: WALLET, tokenAccount: ownedAccount, mint: JUP, rawTokenAmount: { tokenAmount: '0', decimals: 6 } }] }];
  assert.notEqual(classify(ownedTokenAccount).disposition.disposition_type, 'supported_normalized_event');

  const uncertainOwner = enhanced('uncertain-owner-native');
  const uncertainAccount = providerPublicKey('uncertain-native-token-account');
  uncertainOwner.accountData = [{ account: uncertainAccount, nativeBalanceChange: 1, tokenBalanceChanges: [{ userAccount: 'invalid-owner', tokenAccount: uncertainAccount, mint: JUP, rawTokenAmount: { tokenAmount: '0', decimals: 6 } }] }];
  assert.notEqual(classify(uncertainOwner).disposition.disposition_type, 'supported_normalized_event');

  const conflictingAccount = enhanced('conflicting-zero-account');
  conflictingAccount.accountData = [{ account: providerPublicKey('zero-account-a'), nativeBalanceChange: 1, tokenBalanceChanges: [{ userAccount: WALLET, tokenAccount: providerPublicKey('zero-account-b'), mint: JUP, rawTokenAmount: { tokenAmount: '0', decimals: 6 } }] }];
  expectMalformed(conflictingAccount);

  const explained = enhanced('explained-native', { transfers: false });
  explained.fee = 5;
  explained.events.swap.tokenInputs = [];
  explained.events.swap.nativeInput = { account: WALLET, amount: 10_000_000 };
  explained.tokenTransfers = [{ fromUserAccount: providerPublicKey('native-pool-token'), toUserAccount: WALLET, mint: JUP, rawTokenAmount: { tokenAmount: '100000000', decimals: 6 } }];
  explained.nativeTransfers = [{ fromUserAccount: WALLET, toUserAccount: providerPublicKey('native-pool'), amount: 10_000_000 }];
  explained.accountData = [{ account: WALLET, nativeBalanceChange: -10_000_005, tokenBalanceChanges: [] }];
  assert.deepEqual(projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: explained }).unresolved_wallet_effects, []);
  assert.equal(classify(explained).disposition.disposition_type, 'supported_normalized_event');
});

test('instruction-bound closures are populated, unbound provider closure evidence is unresolved, and rent is not swap proceeds', () => {
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const closedAccount = providerPublicKey('closed-token-account');
  const bound = enhanced('bound-close', { transfers: false, type: 'CLOSE_ACCOUNT', program: null });
  bound.events = {};
  bound.accountData = [
    { account: closedAccount, nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, tokenAccount: closedAccount, mint: JUP, rawTokenAmount: { tokenAmount: '0', decimals: 6 } }] },
    { account: WALLET, nativeBalanceChange: 0, tokenBalanceChanges: [] },
  ];
  bound.instructions = [{ programId: tokenProgram, data: 'A', accounts: [closedAccount, WALLET, WALLET], innerInstructions: [] }];
  const boundEvidence = projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: bound });
  assert.deepEqual(boundEvidence.account_closures, [{ closure_id: 'account-close-0', owner: WALLET, mint: JUP }]);
  assert.deepEqual(boundEvidence.unresolved_wallet_effects, []);

  const externalDestination = structuredClone(bound);
  externalDestination.signature = providerSignature('bound-close-external-destination');
  externalDestination.instructions[0].accounts[1] = providerPublicKey('external-close-destination');
  assert.deepEqual(
    projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: externalDestination }).account_closures,
    [{ closure_id: 'account-close-0', owner: WALLET, mint: JUP }],
  );

  const unbound = structuredClone(bound);
  unbound.signature = providerSignature('unbound-close');
  unbound.instructions = [];
  const unboundEvidence = projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: unbound });
  assert.deepEqual(unboundEvidence.account_closures, []);
  assert.ok(unboundEvidence.unresolved_wallet_effects.some(effect => effect.mint === JUP));

  const rent = enhanced('closure-rent-swap');
  rent.fee = 5;
  rent.nativeTransfers = [{ fromUserAccount: providerPublicKey('closed-rent-source'), toUserAccount: WALLET, amount: 2_039_280 }];
  rent.accountData = [
    { account: WALLET, nativeBalanceChange: 2_039_275, tokenBalanceChanges: [] },
    { account: closedAccount, nativeBalanceChange: -2_039_280, tokenBalanceChanges: [{ userAccount: WALLET, tokenAccount: closedAccount, mint: JUP, rawTokenAmount: { tokenAmount: '0', decimals: 6 } }] },
  ];
  rent.instructions.push({ programId: tokenProgram, data: 'A', accounts: [closedAccount, WALLET, WALLET], innerInstructions: [] });
  assert.notEqual(classify(rent).disposition.disposition_type, 'supported_normalized_event');
});

test('token transfer and accountData order permutations preserve whole-transaction classification', () => {
  const transaction = enhanced('account-permutation');
  transaction.accountData = [
    { account: providerPublicKey('permutation-input'), nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, mint: USDC, rawTokenAmount: { tokenAmount: '-25000000', decimals: 6 } }] },
    { account: providerPublicKey('permutation-output'), nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: WALLET, mint: JUP, rawTokenAmount: { tokenAmount: '100000000', decimals: 6 } }] },
  ];
  const permuted = structuredClone(transaction);
  permuted.tokenTransfers.reverse();
  permuted.accountData.reverse();
  assert.deepEqual(classify(permuted), classify(transaction));
});

test('successful wallet-paid swaps require explicit valid fee and wallet native-balance evidence', () => {
  const exact = withWalletNativeEvidence(enhanced('complete-native-evidence'));
  assert.equal(classify(exact).disposition.disposition_type, 'supported_normalized_event');

  const missingWalletRow = structuredClone(exact);
  missingWalletRow.signature = providerSignature('missing-wallet-native-row');
  missingWalletRow.accountData = missingWalletRow.accountData.filter(account => account.account !== WALLET);
  assert.notEqual(classify(missingWalletRow).disposition.disposition_type, 'supported_normalized_event');

  const missingFee = structuredClone(exact);
  missingFee.signature = providerSignature('missing-fee');
  delete missingFee.fee;
  assert.notEqual(classify(missingFee).disposition.disposition_type, 'supported_normalized_event');

  const malformedFee = structuredClone(exact);
  malformedFee.signature = providerSignature('malformed-fee');
  malformedFee.fee = '0';
  expectMalformed(malformedFee);

  const mismatch = structuredClone(exact);
  mismatch.signature = providerSignature('native-reconciliation-mismatch');
  mismatch.accountData.find(account => account.account === WALLET).nativeBalanceChange = -4;
  assert.notEqual(classify(mismatch).disposition.disposition_type, 'supported_normalized_event');

  const zeroFee = withWalletNativeEvidence(enhanced('explicit-zero-fee'), { fee: 0, walletChange: 0 });
  assert.equal(classify(zeroFee).disposition.disposition_type, 'supported_normalized_event');

  const omittedCannotMeanZero = structuredClone(zeroFee);
  omittedCannotMeanZero.signature = providerSignature('omitted-fee-is-not-zero');
  delete omittedCannotMeanZero.fee;
  assert.notEqual(classify(omittedCannotMeanZero).disposition.disposition_type, 'supported_normalized_event');
});

test('instruction-bound closure rent is reconciled for the wallet and external destinations stay material', () => {
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const closedAccount = providerPublicKey('rent-closed-token-account');
  const external = providerPublicKey('rent-external-destination');
  const rent = 2_039_280;
  const closureSwap = (label, destination, mint = JUP) => {
    const transaction = enhanced(label);
    transaction.fee = 5;
    transaction.instructions.push({ programId: tokenProgram, data: 'A', accounts: [closedAccount, destination, WALLET], innerInstructions: [] });
    transaction.nativeTransfers = [{ fromUserAccount: closedAccount, toUserAccount: destination, amount: rent }];
    transaction.accountData = [
      { account: WALLET, nativeBalanceChange: destination === WALLET ? rent - 5 : -5, tokenBalanceChanges: [] },
      { account: closedAccount, nativeBalanceChange: -rent, tokenBalanceChanges: mint === null ? [] : [{ userAccount: WALLET, tokenAccount: closedAccount, mint, rawTokenAmount: { tokenAmount: '0', decimals: 6 } }] },
    ];
    return transaction;
  };

  const returned = closureSwap('closure-rent-returned', WALLET);
  assert.equal(classify(returned).disposition.disposition_type, 'supported_normalized_event');

  const externalKnown = closureSwap('closure-rent-external-known', external);
  const knownResult = classify(externalKnown);
  assert.notEqual(knownResult.disposition.disposition_type, 'supported_normalized_event');
  assert.ok(knownResult.disposition.affected_token_mints.includes(JUP));

  const externalQuote = closureSwap('closure-rent-external-quote', external, USDC);
  const quoteResult = classify(externalQuote);
  assert.equal(quoteResult.disposition.disposition_type, 'ambiguous_activity');
  assert.equal(quoteResult.activity_findings[0].impact_scope, 'wallet_wide');
  assert.deepEqual(quoteResult.disposition.affected_token_mints, []);

  const externalUnknown = closureSwap('closure-rent-external-unknown', external, null);
  const unknownResult = classify(externalUnknown);
  assert.equal(unknownResult.disposition.disposition_type, 'ambiguous_activity');
  assert.equal(unknownResult.activity_findings[0].impact_scope, 'wallet_wide');

  const conflict = closureSwap('closure-rent-conflicting-destination', WALLET);
  conflict.instructions.push({ programId: tokenProgram, data: 'A', accounts: [closedAccount, external, WALLET], innerInstructions: [] });
  assert.notEqual(classify(conflict).disposition.disposition_type, 'supported_normalized_event');

  const providerConflict = closureSwap('closure-rent-provider-destination-conflict', WALLET);
  providerConflict.nativeTransfers[0].toUserAccount = external;
  assert.notEqual(classify(providerConflict).disposition.disposition_type, 'supported_normalized_event');

  const malformedDestination = closureSwap('closure-rent-malformed-destination', WALLET);
  malformedDestination.instructions.at(-1).accounts[1] = 'not-a-public-key';
  assert.notEqual(classify(malformedDestination).disposition.disposition_type, 'supported_normalized_event');

  const metadataOnly = closureSwap('closure-metadata-only', WALLET);
  metadataOnly.instructions = metadataOnly.instructions.filter(instruction => instruction.programId !== tokenProgram);
  metadataOnly.type = 'CLOSE_ACCOUNT';
  assert.notEqual(classify(metadataOnly).disposition.disposition_type, 'supported_normalized_event');
});
