#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSolanaFullTransactionUnresolvedReasonV1,
  projectSolanaFullTransactionV1,
} from './solana-full-transaction-projector.mjs';
import { buildWalletSourceTransactionFromSpotEvidenceV1 } from './solana-spot-evidence.mjs';
import { classifyWalletSourceTransactionV1 } from './transaction-classifier.mjs';
import { normalizeWalletWideSolanaSpotEvidenceV1 } from './wallet-wide-normalizer.mjs';
import { providerPublicKey, providerSignature } from './fixtures/test-identities.mjs';
import { JUP, PROGRAMS, RAY, USDC, WALLET } from './fixtures/spot-normalizer-fixtures.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const RENT = 2_039_280;

function closureTransaction(name, {
  destination = WALLET,
  mint = RAY,
  owner = WALLET,
  authority = WALLET,
  tokenProgram = TOKEN_PROGRAM,
  closeData = 'A',
  closeAccounts = null,
  postClosedAmount = undefined,
  includeCloseInstruction = true,
  closeLocation = 'top',
} = {}) {
  const closedAccount = providerPublicKey(`${name}-closed`);
  const inputAccount = providerPublicKey(`${name}-input`);
  const outputAccount = providerPublicKey(`${name}-output`);
  const addresses = [
    WALLET,
    PROGRAMS.jupiter,
    TOKEN_PROGRAM,
    ...(tokenProgram === TOKEN_PROGRAM ? [] : [tokenProgram]),
    ...(destination === WALLET ? [] : [destination]),
    ...(authority === WALLET || authority === destination ? [] : [authority]),
    inputAccount,
    outputAccount,
    closedAccount,
  ];
  const accounts = addresses.map((address, index) => ({
    address,
    is_signer: index === 0 || address === authority,
    is_writable: index === 0 || [destination, inputAccount, outputAccount, closedAccount].includes(address),
    source: 'static',
  }));
  const indexOf = address => addresses.indexOf(address);
  const pre = addresses.map(() => 0);
  const post = addresses.map(() => 0);
  pre[0] = 1_000_000_000;
  post[0] = pre[0] - 5;
  pre[indexOf(inputAccount)] = 2_039_280;
  post[indexOf(inputAccount)] = 2_039_280;
  pre[indexOf(outputAccount)] = 2_039_280;
  post[indexOf(outputAccount)] = 2_039_280;
  pre[indexOf(closedAccount)] = RENT;
  post[indexOf(closedAccount)] = 0;
  if (destination === WALLET) post[0] += RENT;
  else {
    pre[indexOf(destination)] = 1_000_000;
    post[indexOf(destination)] = 1_000_000 + RENT;
  }
  const tokenRow = (account, rowMint, rowOwner, rawAmount, token_program = TOKEN_PROGRAM) => ({
    account_index: indexOf(account),
    account,
    mint: rowMint,
    owner: rowOwner,
    raw_amount: rawAmount,
    decimals: 6,
    token_program,
  });
  const preTokenBalances = [
    tokenRow(inputAccount, USDC, WALLET, '25000000'),
    tokenRow(outputAccount, JUP, WALLET, '0'),
    ...(mint === null ? [] : [tokenRow(closedAccount, mint, owner, '0', tokenProgram)]),
  ].sort((left, right) => left.account_index - right.account_index);
  const postTokenBalances = [
    tokenRow(inputAccount, USDC, WALLET, '0'),
    tokenRow(outputAccount, JUP, WALLET, '100000000'),
    ...(mint === null || postClosedAmount === undefined
      ? []
      : [tokenRow(closedAccount, mint, owner, postClosedAmount, tokenProgram)]),
  ].sort((left, right) => left.account_index - right.account_index);
  const instructions = [{
    instruction_index: 0,
    program_id: PROGRAMS.jupiter,
    accounts: [WALLET],
    data: '',
  }];
  const closeInstruction = {
    instruction_index: closeLocation === 'inner' ? 0 : 1,
    program_id: tokenProgram,
    accounts: closeAccounts ?? [closedAccount, destination, authority],
    data: closeData,
  };
  if (includeCloseInstruction && closeLocation === 'top') instructions.push(closeInstruction);
  return {
    value: {
      full_transaction_version: 'solana_full_transaction_v1',
      signature: providerSignature(name),
      slot: 1234,
      block_time: 1_780_000_000,
      execution_state: 'succeeded',
      transaction_version: 0,
      fee_payer: WALLET,
      fee_lamports: 5,
      accounts,
      pre_lamport_balances: pre,
      post_lamport_balances: post,
      pre_token_balances: preTokenBalances,
      post_token_balances: postTokenBalances,
      instructions,
      inner_instruction_groups: includeCloseInstruction && closeLocation === 'inner'
        ? [{ outer_instruction_index: 0, instructions: [closeInstruction] }]
        : [],
    },
    closedAccount,
    closedIndex: indexOf(closedAccount),
    destinationIndex: indexOf(destination),
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

function assertNotSupported(value) {
  assert.notEqual(classify(value).disposition.disposition_type, 'supported_normalized_event', value.signature);
}

test('decodes only exact SPL Token and Token-2022 CloseAccount and subtracts proven wallet-returned rent', () => {
  for (const tokenProgram of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    for (const closeLocation of ['top', 'inner']) {
      const { value } = closureTransaction(`returned-rent-${tokenProgram.slice(0, 6)}-${closeLocation}`, {
        tokenProgram,
        closeLocation,
      });
      const evidence = project(value);
      assert.deepEqual(evidence.account_closures, [{ closure_id: 'account-close-0', owner: WALLET, mint: RAY }]);
      assert.deepEqual(evidence.unresolved_wallet_effects, []);
      assert.deepEqual(evidence.native_sol_transfer_legs, []);
      assert.equal(classify(value).disposition.disposition_type, 'supported_normalized_event');
    }
  }

  const nonClose = closureTransaction('non-close-token-instruction', { closeData: 'B' }).value;
  assert.deepEqual(project(nonClose).account_closures, []);
  assertNotSupported(nonClose);
});

test('preserves external closure rent and localizes only one exactly proven non-quote mint', () => {
  const destination = providerPublicKey('full-projector-external-rent-destination');
  const known = closureTransaction('external-known-rent', { destination, mint: JUP }).value;
  const knownEvidence = project(known);
  assert.deepEqual(knownEvidence.account_closures, [{ closure_id: 'account-close-0', owner: WALLET, mint: JUP }]);
  assert.deepEqual(knownEvidence.unresolved_wallet_effects.map(effect => effect.mint), [JUP]);
  assert.equal(getSolanaFullTransactionUnresolvedReasonV1(knownEvidence), 'closure_rent_unreconciled');
  const knownResult = classify(known);
  assert.equal(knownResult.disposition.disposition_type, 'ambiguous_activity');
  assert.equal(knownResult.activity_findings[0].impact_scope, 'token_specific');
  assert.deepEqual(knownResult.disposition.affected_token_mints, [JUP]);

  const quote = closureTransaction('external-quote-rent', { destination, mint: USDC }).value;
  const quoteResult = classify(quote);
  assert.equal(quoteResult.disposition.disposition_type, 'ambiguous_activity');
  assert.equal(quoteResult.activity_findings[0].impact_scope, 'wallet_wide');
  assert.deepEqual(quoteResult.disposition.affected_token_mints, []);
  assert.equal(
    getSolanaFullTransactionUnresolvedReasonV1(project(quote)),
    'quote_mint_closure_unreconciled',
  );

  const unknown = closureTransaction('external-unknown-rent', { destination, mint: null }).value;
  const unknownResult = classify(unknown);
  assert.equal(unknownResult.disposition.disposition_type, 'ambiguous_activity');
  assert.equal(unknownResult.activity_findings[0].impact_scope, 'wallet_wide');
  assert.equal(getSolanaFullTransactionUnresolvedReasonV1(project(unknown)), 'unknown_token_scope');
});

test('fails closed on incomplete, conflicting, duplicate, ownership-incoherent, and unreconciled closure evidence', () => {
  const external = providerPublicKey('full-projector-conflict-destination');
  const cases = [];

  const incomplete = closureTransaction('closure-incomplete');
  incomplete.value.instructions.at(-1).accounts = [incomplete.closedAccount];
  cases.push(incomplete.value);

  const quoteIncomplete = closureTransaction('quote-closure-incomplete', { mint: USDC });
  quoteIncomplete.value.instructions.at(-1).accounts = [quoteIncomplete.closedAccount, WALLET];
  cases.push(quoteIncomplete.value);

  const duplicate = closureTransaction('closure-duplicate').value;
  duplicate.instructions.push({ ...duplicate.instructions.at(-1), instruction_index: 2 });
  cases.push(duplicate);

  const splitDuplicate = closureTransaction('closure-split-duplicate').value;
  splitDuplicate.inner_instruction_groups = [{
    outer_instruction_index: 0,
    instructions: [{ ...splitDuplicate.instructions.at(-1), instruction_index: 0 }],
  }];
  cases.push(splitDuplicate);

  const conflicting = closureTransaction('closure-conflicting').value;
  const externalIndex = conflicting.accounts.length;
  conflicting.accounts.push({ address: external, is_signer: false, is_writable: true, source: 'static' });
  conflicting.pre_lamport_balances.push(1_000_000);
  conflicting.post_lamport_balances.push(1_000_000);
  conflicting.instructions.push({
    ...conflicting.instructions.at(-1),
    instruction_index: 2,
    accounts: [conflicting.instructions.at(-1).accounts[0], external, WALLET],
  });
  assert.equal(externalIndex, conflicting.accounts.length - 1);
  cases.push(conflicting);

  const wrongAuthority = closureTransaction('closure-wrong-authority', {
    authority: providerPublicKey('full-projector-wrong-authority'),
  }).value;
  cases.push(wrongAuthority);

  const unknownOwner = closureTransaction('closure-unknown-owner', { owner: null }).value;
  cases.push(unknownOwner);

  const destinationMismatch = closureTransaction('closure-destination-mismatch', { destination: external });
  destinationMismatch.value.post_lamport_balances[destinationMismatch.destinationIndex] -= 1;
  destinationMismatch.value.post_lamport_balances[0] += 1;
  cases.push(destinationMismatch.value);

  const sourceMismatch = closureTransaction('closure-source-mismatch');
  sourceMismatch.value.post_lamport_balances[sourceMismatch.closedIndex] = 1;
  sourceMismatch.value.post_lamport_balances[0] -= 1;
  cases.push(sourceMismatch.value);

  const nonzeroPostState = closureTransaction('closure-nonzero-post-state', { postClosedAmount: '1' }).value;
  cases.push(nonzeroPostState);

  for (const value of cases) {
    const evidence = project(value);
    assertNotSupported(value);
    assert.ok(evidence.unresolved_wallet_effects.length > 0, value.signature);
  }
  assert.equal(classify(incomplete.value).activity_findings[0].impact_scope, 'wallet_wide');
  assert.equal(
    getSolanaFullTransactionUnresolvedReasonV1(project(incomplete.value)),
    'closure_evidence_unreconciled',
  );
  assert.equal(classify(quoteIncomplete.value).activity_findings[0].impact_scope, 'wallet_wide');
  assert.equal(
    getSolanaFullTransactionUnresolvedReasonV1(project(quoteIncomplete.value)),
    'quote_mint_closure_unreconciled',
  );
  assert.equal(classify(conflicting).activity_findings[0].impact_scope, 'wallet_wide');
  assert.equal(classify(unknownOwner).activity_findings[0].impact_scope, 'wallet_wide');
});

test('does not fabricate closure from zero token state and closure-like lamport movement without an instruction', () => {
  const value = closureTransaction('closure-metadata-only', { includeCloseInstruction: false }).value;
  const evidence = project(value);
  assert.deepEqual(evidence.account_closures, []);
  assert.ok(evidence.unresolved_wallet_effects.some(effect => effect.mint === RAY));
  assertNotSupported(value);
});

test('ignores an exactly bound closure whose account, authority, owner, and destination are all external', () => {
  const owner = providerPublicKey('full-projector-external-close-owner');
  const destination = providerPublicKey('full-projector-external-close-destination');
  const value = closureTransaction('external-close-irrelevant', { owner, authority: owner, destination }).value;
  const evidence = project(value);
  assert.deepEqual(evidence.account_closures, []);
  assert.deepEqual(evidence.unresolved_wallet_effects, []);
  assert.equal(classify(value).disposition.disposition_type, 'supported_normalized_event');

  const incoherent = closureTransaction('external-close-incoherent', {
    mint: RAY,
    owner,
    authority: owner,
    destination,
  });
  incoherent.value.post_lamport_balances[incoherent.destinationIndex] -= 1;
  incoherent.value.post_lamport_balances[0] += 1;
  const incoherentEvidence = project(incoherent.value);
  assert.deepEqual(incoherentEvidence.account_closures, []);
  assert.deepEqual(incoherentEvidence.unresolved_wallet_effects.map(effect => effect.mint), [null]);
  assert.equal(
    getSolanaFullTransactionUnresolvedReasonV1(incoherentEvidence),
    'closure_evidence_unreconciled',
  );

});

test('does not subtract wallet-returned rent when the destination balance cannot prove the return', () => {
  const diverted = closureTransaction('wallet-rent-diverted');
  const sink = providerPublicKey('full-projector-rent-diversion-sink');
  diverted.value.accounts.push({ address: sink, is_signer: false, is_writable: true, source: 'static' });
  diverted.value.pre_lamport_balances.push(1_000_000);
  diverted.value.post_lamport_balances.push(1_000_000 + RENT);
  diverted.value.post_lamport_balances[0] -= RENT;
  const inputAccount = diverted.value.pre_token_balances.find(row => row.mint === USDC).account;
  diverted.value.pre_token_balances = diverted.value.pre_token_balances.filter(row => row.account !== inputAccount);
  diverted.value.post_token_balances = diverted.value.post_token_balances.filter(row => row.account !== inputAccount);

  const evidence = project(diverted.value);
  assert.deepEqual(evidence.account_closures, []);
  assert.ok(evidence.unresolved_wallet_effects.some(effect => effect.mint === null));
  const result = classify(diverted.value);
  assert.equal(result.disposition.disposition_type, 'ambiguous_activity');
  assert.equal(result.activity_findings[0].impact_scope, 'wallet_wide');
  assert.equal(getSolanaFullTransactionUnresolvedReasonV1(evidence), 'closure_rent_unreconciled');

  const overcredited = closureTransaction('wallet-rent-overcredited');
  overcredited.value.post_lamport_balances[0] += 1;
  const counterpartyIndex = overcredited.value.accounts.findIndex(account => account.address === PROGRAMS.jupiter);
  overcredited.value.pre_lamport_balances[counterpartyIndex] = 1;
  const overcreditedEvidence = project(overcredited.value);
  assert.deepEqual(overcreditedEvidence.account_closures, []);
  assert.ok(overcreditedEvidence.unresolved_wallet_effects.some(effect => effect.mint === null));
});
