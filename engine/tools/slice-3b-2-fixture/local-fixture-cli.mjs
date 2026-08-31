#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ExtensionType, getExtensionTypes, unpackAccount } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

import { sha256CanonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import {
  FixtureSetupError,
  APPROVED_CLASSIC_ACCOUNT_LENGTH,
  APPROVED_TOKEN_2022_ACCOUNT_LENGTH,
  TOKEN_2022_PROGRAM,
  buildFrozenPublicManifest,
  createOfflineFixturePlan,
} from './fixture-core.mjs';
import {
  collectReadOnlyPreflight,
  runFixtureSetupTool,
} from './prepare-or-execute-setup.mjs';
import { assertSafeLocalSecretPath } from './generate-controls.mjs';

const INDEPENDENT_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
const EXECUTION_AUTHORIZATION = 'SLICE_3B_2_ONE_MAINNET_SETUP_TRANSACTION_APPROVED';

function fail(code) {
  throw new FixtureSetupError(code);
}

function parsePairs(argv, allowed) {
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== 'string' || value.length === 0 || values[key] !== undefined) {
      fail('fixture_cli_arguments_invalid');
    }
    values[key] = value;
  }
  return values;
}

export function parseSetupCliArguments(argv) {
  const modeFlag = argv[0];
  if (modeFlag === '--offline-plan') {
    const values = parsePairs(argv, new Set(['--controls-public', '--fee-payer-pubkey', '--output']));
    if (Object.keys(values).length !== 3) fail('fixture_cli_arguments_invalid');
    return {
      mode: 'offline-plan', controls_public: values['--controls-public'],
      fee_payer: values['--fee-payer-pubkey'], output: values['--output'],
    };
  }
  if (modeFlag === '--read-only-mainnet-preflight') {
    const values = parsePairs(argv, new Set(['--controls-public', '--fee-payer-pubkey', '--output']));
    if (Object.keys(values).length !== 3) fail('fixture_cli_arguments_invalid');
    return {
      mode: 'read-only-mainnet-preflight', controls_public: values['--controls-public'],
      fee_payer: values['--fee-payer-pubkey'], output: values['--output'],
    };
  }
  if (modeFlag === '--execute-authorized-mainnet-setup') {
    const values = parsePairs(argv, new Set([
      '--authorization', '--controls-public', '--fee-payer-pubkey', '--funding-keypair',
      '--local-machine-attestation', '--manifest-output',
    ]));
    if (Object.keys(values).length !== 6 || values['--authorization'] !== EXECUTION_AUTHORIZATION) {
      fail('mainnet_execution_not_authorized');
    }
    return {
      mode: 'execute-authorized-mainnet-setup', execution_authorization: values['--authorization'],
      controls_public: values['--controls-public'], fee_payer: values['--fee-payer-pubkey'],
      funding_keypair: values['--funding-keypair'],
      local_machine_attestation: values['--local-machine-attestation'],
      output: values['--manifest-output'],
    };
  }
  fail('mainnet_execution_not_authorized');
}

async function loadPublicControls(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('public_controls_invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).sort().join('\0') !== [
        'empty_control_wallet', 'fixture_controls_version', 'known_control_wallet',
      ].sort().join('\0')
      || parsed.fixture_controls_version !== 'artifact_slice_3b_2_public_controls_v1') {
    fail('public_controls_invalid');
  }
  return parsed;
}

async function reserveOutput(path) {
  try {
    return await open(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('output_path_unavailable');
    throw error;
  }
}

async function persistReserved(handle, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) fail('output_persistence_failed');
    offset += bytesWritten;
  }
  await handle.sync();
}

async function writeReserved(handle, value) {
  await persistReserved(handle, value);
  await handle.close();
}

export async function loadFundingKeypair(path, localMachineAttestation) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    fail('funding_keypair_path_unsafe');
  }
  try {
    await assertSafeLocalSecretPath(path, localMachineAttestation);
  } catch (error) {
    if (error?.code === 'trusted_local_machine_not_attested') throw error;
    fail('funding_keypair_path_unsafe');
  }
  let canonicalPath;
  try {
    canonicalPath = await realpath(path);
  } catch {
    fail('funding_keypair_path_unsafe');
  }
  if (canonicalPath !== path) fail('funding_keypair_path_unsafe');
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) fail('funding_keypair_permissions_unsafe');
  const bytes = await readFile(path);
  let array;
  try {
    array = JSON.parse(bytes.toString('utf8'));
  } catch {
    bytes.fill(0);
    fail('funding_keypair_invalid');
  }
  bytes.fill(0);
  if (!Array.isArray(array) || array.length !== 64
      || array.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    if (Array.isArray(array)) array.fill(0);
    fail('funding_keypair_invalid');
  }
  const secret = Uint8Array.from(array);
  array.fill(0);
  try {
    return Keypair.fromSecretKey(secret);
  } finally {
    secret.fill(0);
  }
}

export function validateFinalizedAccount(account, item, knownWallet, dependencies = {}) {
  if (account === null || account.executable !== false || account.owner.toBase58() !== item.token_program) {
    fail('finalized_account_invalid');
  }
  const expectedToken2022 = item.token_program === TOKEN_2022_PROGRAM;
  const expectedLength = expectedToken2022
    ? APPROVED_TOKEN_2022_ACCOUNT_LENGTH
    : APPROVED_CLASSIC_ACCOUNT_LENGTH;
  if (!(account.data instanceof Uint8Array) || account.data.length !== expectedLength) {
    fail('finalized_account_layout_unapproved');
  }
  const decodeAccount = dependencies.decodeAccount ?? unpackAccount;
  const decoded = decodeAccount(new PublicKey(item.account), account, new PublicKey(item.token_program));
  if (decoded.mint.toBase58() !== item.mint || decoded.owner.toBase58() !== knownWallet
      || decoded.amount !== 0n || decoded.delegate !== null || decoded.delegatedAmount !== 0n
      || decoded.closeAuthority !== null || decoded.isInitialized !== true || decoded.isFrozen !== false) {
    fail('finalized_account_invalid');
  }
  const expectedNative = expectedToken2022;
  if (decoded.isNative !== expectedNative
      || (expectedNative && (typeof decoded.rentExemptReserve !== 'bigint' || decoded.rentExemptReserve <= 0n))
      || (!expectedNative && decoded.rentExemptReserve !== null)) {
    fail(expectedNative ? 'token_2022_native_state_mismatch' : 'classic_non_native_state_mismatch');
  }
  if (expectedToken2022) {
    let extensionTypes;
    try {
      if (!(decoded.tlvData instanceof Uint8Array)
          || !Buffer.from(decoded.tlvData).equals(Buffer.from([
            ExtensionType.ImmutableOwner, 0, 0, 0,
          ]))) fail('token_2022_extension_state_mismatch');
      extensionTypes = getExtensionTypes(decoded.tlvData);
    } catch {
      fail('token_2022_extension_state_mismatch');
    }
    if (extensionTypes.length !== 1 || extensionTypes[0] !== ExtensionType.ImmutableOwner) {
      fail('token_2022_extension_state_mismatch');
    }
  }
  return {
    outer_owner_program: account.owner.toBase58(),
    account_length: account.data.length,
    is_native: decoded.isNative,
    raw_account_data_sha256: createHash('sha256').update(account.data).digest('hex'),
    raw_amount: '0',
  };
}

export function validateFinalizedTransactionEvidence(finalizedTransaction, expectedMessage, expectedSignature) {
  if (finalizedTransaction === null || finalizedTransaction?.meta?.err !== null
      || !Number.isSafeInteger(finalizedTransaction?.slot) || finalizedTransaction.slot < 0) {
    fail('finalized_transaction_evidence_invalid');
  }
  const signatures = finalizedTransaction.transaction?.signatures;
  if (!Array.isArray(signatures) || signatures.length !== 1 || signatures[0] !== expectedSignature) {
    fail('finalized_transaction_signature_mismatch');
  }
  const serialize = finalizedTransaction.transaction?.message?.serialize;
  if (typeof serialize !== 'function') fail('finalized_transaction_evidence_invalid');
  let finalizedMessage;
  try {
    finalizedMessage = Buffer.from(serialize.call(finalizedTransaction.transaction.message));
  } catch {
    fail('finalized_transaction_evidence_invalid');
  }
  if (!Buffer.from(expectedMessage).equals(finalizedMessage)) fail('finalized_transaction_message_mismatch');
  return finalizedTransaction.slot;
}

export async function executeAuthorizedMainnetSetup(input, dependencies = {}) {
  if (input.execution_authorization !== EXECUTION_AUTHORIZATION) fail('mainnet_execution_not_authorized');
  if (typeof dependencies.persistSubmissionIntent !== 'function') {
    fail('submission_intent_persistence_unavailable');
  }
  const createConnection = dependencies.createConnection ?? (() => new Connection(INDEPENDENT_MAINNET_RPC, 'finalized'));
  const connection = createConnection();
  const plan = createOfflineFixturePlan({
    empty_control_wallet: input.empty_control_wallet,
    known_control_wallet: input.known_control_wallet,
    fee_payer: input.fee_payer,
  });
  const collected = await collectReadOnlyPreflight(plan, connection, dependencies);
  const fundingKeypair = await (dependencies.loadFundingKeypair ?? loadFundingKeypair)(
    input.funding_keypair, input.local_machine_attestation,
  );
  try {
    if (!(fundingKeypair instanceof Keypair) || fundingKeypair.publicKey.toBase58() !== plan.controls.fee_payer) {
      fail('funding_keypair_public_key_mismatch');
    }
    collected.transaction.sign(fundingKeypair);
    const expectedSignature = collected.transaction.signature;
    if (expectedSignature === null) fail('transaction_signature_missing');
    const expectedSignatureText = bs58.encode(expectedSignature);
    const expectedMessage = collected.transaction.serializeMessage();
    const sanitizedTransactionSha256 = createHash('sha256').update(expectedMessage).digest('hex');
    await dependencies.persistSubmissionIntent(Object.freeze({
      fixture_submission_intent_version: 'artifact_slice_3b_2_submission_intent_v1',
      status: 'SIGNED_NOT_YET_FINALIZED_DO_NOT_BLINDLY_RESUBMIT',
      signature: expectedSignatureText,
      sanitized_transaction_sha256: sanitizedTransactionSha256,
      recent_blockhash: collected.preflight.recent_blockhash,
      last_valid_block_height: collected.preflight.last_valid_block_height,
      expected_accounts: plan.derived_accounts.map(item => item.account),
    }));
    const signature = await connection.sendRawTransaction(collected.transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'finalized',
      maxRetries: 0,
    });
    if (signature !== expectedSignatureText) fail('submitted_signature_mismatch');
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: collected.preflight.recent_blockhash,
      lastValidBlockHeight: collected.preflight.last_valid_block_height,
    }, 'finalized');
    if (confirmation?.value?.err !== null) fail('setup_transaction_failed');

    const finalizedTransaction = await connection.getTransaction(signature, {
      commitment: 'finalized', maxSupportedTransactionVersion: 0,
    });
    const finalizedSlot = validateFinalizedTransactionEvidence(
      finalizedTransaction, expectedMessage, expectedSignatureText,
    );
    const accountResponse = await connection.getMultipleAccountsInfoAndContext(
      plan.derived_accounts.map(item => new PublicKey(item.account)), 'finalized',
    );
    if (!Array.isArray(accountResponse?.value) || accountResponse.value.length !== 2
        || !Number.isSafeInteger(accountResponse.context?.slot)
        || accountResponse.context.slot < finalizedSlot) {
      fail('finalized_account_evidence_invalid');
    }
    const confirmedAccounts = {};
    const inspectFinalizedAccount = dependencies.inspectFinalizedAccount ?? validateFinalizedAccount;
    for (let index = 0; index < plan.derived_accounts.length; index += 1) {
      const item = plan.derived_accounts[index];
      confirmedAccounts[item.account] = inspectFinalizedAccount(
        accountResponse.value[index], item, plan.controls.known_control_wallet,
      );
    }
    const manifest = buildFrozenPublicManifest({
      plan,
      preflight: collected.preflight,
      created_at_utc: new Date().toISOString(),
      setup_transaction: {
        signature,
        finalized_slot: finalizedSlot,
        sanitized_transaction_sha256: sanitizedTransactionSha256,
      },
      confirmed_accounts: confirmedAccounts,
    });
    return Object.freeze({
      status: 'FINALIZED_PUBLIC_MANIFEST_READY',
      manifest,
      public_summary_sha256: sha256CanonicalJson({
        signature,
        finalized_slot: finalizedSlot,
        manifest_sha256: manifest.manifest_sha256,
      }),
    });
  } finally {
    if (fundingKeypair instanceof Keypair) fundingKeypair.secretKey.fill(0);
  }
}

function publicPreflightOutput(result) {
  return {
    status: result.status,
    plan: result.plan,
    preflight: result.preflight,
    sanitized_transaction: result.sanitized_transaction,
  };
}

async function main(argv) {
  let outputHandle;
  let submissionIntentHandle;
  try {
    const parsed = parseSetupCliArguments(argv);
    outputHandle = await reserveOutput(parsed.output);
    if (parsed.mode === 'execute-authorized-mainnet-setup') {
      submissionIntentHandle = await reserveOutput(`${parsed.output}.submission-intent.json`);
    }
    const controls = await loadPublicControls(parsed.controls_public);
    const common = {
      mode: parsed.mode,
      execution_authorization: parsed.execution_authorization,
      empty_control_wallet: controls.empty_control_wallet,
      known_control_wallet: controls.known_control_wallet,
      fee_payer: parsed.fee_payer,
      funding_keypair: parsed.funding_keypair,
      local_machine_attestation: parsed.local_machine_attestation,
    };
    if (parsed.mode === 'offline-plan') {
      const result = await runFixtureSetupTool(common);
      await writeReserved(outputHandle, { status: result.status, plan: result.plan });
      outputHandle = undefined;
      process.stdout.write(`OFFLINE_PLAN_WRITTEN ${parsed.output}\n`);
      return 0;
    }
    if (parsed.mode === 'read-only-mainnet-preflight') {
      const result = await runFixtureSetupTool(common, {
        createConnection: () => new Connection(INDEPENDENT_MAINNET_RPC, 'finalized'),
      });
      await writeReserved(outputHandle, publicPreflightOutput(result));
      outputHandle = undefined;
      process.stdout.write(`READ_ONLY_PREFLIGHT_WRITTEN ${parsed.output}\n`);
      return 0;
    }
    const result = await runFixtureSetupTool(common, {
      executeAuthorizedMainnetSetup: value => executeAuthorizedMainnetSetup(value, {
        persistSubmissionIntent: async intent => {
          if (submissionIntentHandle === undefined) fail('submission_intent_persistence_unavailable');
          await writeReserved(submissionIntentHandle, intent);
          submissionIntentHandle = undefined;
        },
      }),
    });
    await writeReserved(outputHandle, result.manifest);
    outputHandle = undefined;
    process.stdout.write(`FINALIZED_PUBLIC_MANIFEST_WRITTEN ${parsed.output}\n`);
    return 0;
  } catch (error) {
    await outputHandle?.close();
    await submissionIntentHandle?.close();
    const code = error instanceof FixtureSetupError ? error.code : 'fixture_setup_failed';
    process.stderr.write(`${code}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
