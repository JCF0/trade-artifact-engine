#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  ExtensionType,
  getAccountLen,
  getAccountLenForMint,
  getAccountTypeOfMintType,
  getExtensionTypes,
  unpackMint,
} from '@solana/spl-token';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  CLASSIC_TOKEN_PROGRAM,
  APPROVED_CLASSIC_ACCOUNT_LENGTH,
  APPROVED_TOKEN_2022_ACCOUNT_LENGTH,
  FixtureSetupError,
  MAINNET_GENESIS_HASH,
  TOKEN_2022_PROGRAM,
  createOfflineFixturePlan,
  evaluatePreflightEvidence,
} from './fixture-core.mjs';

function fail(code) {
  throw new FixtureSetupError(code);
}

function reconstructInstruction(descriptor) {
  return new TransactionInstruction({
    programId: new PublicKey(descriptor.program_id),
    keys: descriptor.account_metas.map(item => ({
      pubkey: new PublicKey(item.account),
      isSigner: item.is_signer,
      isWritable: item.is_writable,
    })),
    data: Buffer.from(descriptor.instruction_data_hex, 'hex'),
  });
}

export function requiredAssociatedAccountLength(mintState, tokenProgram) {
  if (tokenProgram === CLASSIC_TOKEN_PROGRAM) return getAccountLenForMint(mintState);
  if (tokenProgram !== TOKEN_2022_PROGRAM) fail('mint_program_identity_mismatch');
  const mintDerivedAccountExtensions = getExtensionTypes(mintState.tlvData)
    .map(getAccountTypeOfMintType)
    .filter(extension => extension !== ExtensionType.Uninitialized);
  return getAccountLen([...new Set([...mintDerivedAccountExtensions, ExtensionType.ImmutableOwner])]);
}

function defaultInspectMintAccount(mint, accountInfo, tokenProgram) {
  if (accountInfo === null || accountInfo.executable !== false
      || accountInfo.owner.toBase58() !== tokenProgram) fail('mint_program_identity_mismatch');
  const unpacked = unpackMint(new PublicKey(mint), accountInfo, new PublicKey(tokenProgram));
  const requiredAccountExtensions = tokenProgram === TOKEN_2022_PROGRAM
    ? [...new Set([
      ...getExtensionTypes(unpacked.tlvData)
        .map(getAccountTypeOfMintType)
        .filter(extension => extension !== ExtensionType.Uninitialized),
      ExtensionType.ImmutableOwner,
    ])]
    : [];
  return {
    account_length: accountInfo.data.length,
    mint_derived_token_account_length: getAccountLenForMint(unpacked),
    required_token_account_length: requiredAssociatedAccountLength(unpacked, tokenProgram),
    required_account_extensions: requiredAccountExtensions.map(extension => ExtensionType[extension]),
  };
}

export async function collectReadOnlyPreflight(plan, connection, dependencies = {}) {
  if (plan?.instructions?.length !== 2 || plan?.derived_accounts?.length !== 2) fail('fixture_plan_invalid');
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== MAINNET_GENESIS_HASH) fail('mainnet_identity_mismatch');
  const mintKeys = plan.mints.map(item => new PublicKey(item.mint));
  const mintResponse = await connection.getMultipleAccountsInfoAndContext(mintKeys, 'finalized');
  if (!Array.isArray(mintResponse?.value) || mintResponse.value.length !== 2) fail('mint_evidence_invalid');
  const inspectMintAccount = dependencies.inspectMintAccount ?? defaultInspectMintAccount;
  const mintAccounts = {};
  for (let index = 0; index < plan.mints.length; index += 1) {
    const expected = plan.mints[index];
    const inspected = inspectMintAccount(expected.mint, mintResponse.value[index], expected.token_program);
    mintAccounts[expected.mint] = {
      outer_owner_program: expected.token_program,
      account_length: inspected.account_length,
      required_token_account_length: inspected.required_token_account_length,
      required_account_extensions: inspected.required_account_extensions,
    };
  }
  for (const expected of plan.mints) {
    const length = mintAccounts[expected.mint].required_token_account_length;
    if (expected.token_program === CLASSIC_TOKEN_PROGRAM
        && length !== APPROVED_CLASSIC_ACCOUNT_LENGTH) {
      fail('classic_account_layout_unapproved');
    }
    if (expected.token_program === TOKEN_2022_PROGRAM
        && length !== APPROVED_TOKEN_2022_ACCOUNT_LENGTH) {
      fail('token_2022_account_layout_unapproved');
    }
  }

  const derivedKeys = plan.derived_accounts.map(item => new PublicKey(item.account));
  const derivedResponse = await connection.getMultipleAccountsInfoAndContext(derivedKeys, 'finalized');
  if (!Array.isArray(derivedResponse?.value) || derivedResponse.value.length !== 2) fail('derived_account_evidence_invalid');
  const derivedAccountsAbsent = {};
  for (let index = 0; index < plan.derived_accounts.length; index += 1) {
    derivedAccountsAbsent[plan.derived_accounts[index].account] = derivedResponse.value[index] === null;
  }

  const rentLamportsByAccount = {};
  for (let index = 0; index < plan.derived_accounts.length; index += 1) {
    const account = plan.derived_accounts[index];
    const length = mintAccounts[account.mint].required_token_account_length;
    rentLamportsByAccount[account.account] = await connection.getMinimumBalanceForRentExemption(length, 'finalized');
  }

  const latest = await connection.getLatestBlockhash('finalized');
  const transaction = new Transaction({
    feePayer: new PublicKey(plan.controls.fee_payer),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  for (const descriptor of plan.instructions) transaction.add(reconstructInstruction(descriptor));
  const message = transaction.compileMessage();
  const feeResponse = await connection.getFeeForMessage(message, 'finalized');
  if (feeResponse?.value === null || feeResponse?.value === undefined) fail('compiled_fee_invalid');

  const preflight = evaluatePreflightEvidence(plan, {
    genesis_hash: genesisHash,
    mint_accounts: mintAccounts,
    derived_accounts_absent: derivedAccountsAbsent,
    rent_lamports_by_account: rentLamportsByAccount,
    compiled_transaction_fee_lamports: feeResponse.value,
    latest_blockhash: latest.blockhash,
    last_valid_block_height: latest.lastValidBlockHeight,
  });
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation?.value?.err !== null) fail('setup_simulation_failed');

  return Object.freeze({
    preflight,
    transaction,
    sanitized_transaction: Object.freeze({
      network: 'mainnet-beta',
      fee_payer: plan.controls.fee_payer,
      recent_blockhash: latest.blockhash,
      last_valid_block_height: latest.lastValidBlockHeight,
      instructions: plan.instructions,
      simulation_slot: simulation.context?.slot ?? null,
      simulation_succeeded: true,
    }),
  });
}

export async function runFixtureSetupTool(input, dependencies = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('fixture_input_invalid');
  if (input.mode === 'offline-plan') {
    const plan = createOfflineFixturePlan({
      empty_control_wallet: input.empty_control_wallet,
      known_control_wallet: input.known_control_wallet,
      fee_payer: input.fee_payer,
    });
    return Object.freeze({ status: 'OFFLINE_PLAN_ONLY', plan });
  }
  if (input.mode === 'read-only-mainnet-preflight') {
    if (typeof dependencies.createConnection !== 'function') fail('read_only_connection_capability_unavailable');
    const plan = createOfflineFixturePlan({
      empty_control_wallet: input.empty_control_wallet,
      known_control_wallet: input.known_control_wallet,
      fee_payer: input.fee_payer,
    });
    const collected = await collectReadOnlyPreflight(plan, dependencies.createConnection(input.rpc_url), dependencies);
    return Object.freeze({ status: 'READ_ONLY_PREFLIGHT_COMPLETE', plan, ...collected });
  }
  if (input.mode !== 'execute-authorized-mainnet-setup'
      || input.execution_authorization !== 'SLICE_3B_2_ONE_MAINNET_SETUP_TRANSACTION_APPROVED') {
    fail('mainnet_execution_not_authorized');
  }
  if (dependencies.executeAuthorizedMainnetSetup === undefined) fail('mainnet_execution_capability_unavailable');
  return dependencies.executeAuthorizedMainnetSetup(input);
}

async function main() {
  process.stderr.write('FIXTURE_SETUP_NOT_RUN use the documented local-only commands\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
