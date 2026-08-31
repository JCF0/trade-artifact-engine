import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ExtensionType } from '@solana/spl-token';
import { Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

import {
  ASSOCIATED_TOKEN_PROGRAM,
  CLASSIC_MINT,
  CLASSIC_TOKEN_PROGRAM,
  MAINNET_GENESIS_HASH,
  MAX_SETUP_LAMPORTS,
  TOKEN_2022_MINT,
  TOKEN_2022_PROGRAM,
  buildFrozenPublicManifest,
  createOfflineFixturePlan,
  evaluatePreflightEvidence,
} from './fixture-core.mjs';
import {
  collectReadOnlyPreflight,
  requiredAssociatedAccountLength,
  runFixtureSetupTool,
} from './prepare-or-execute-setup.mjs';
import {
  executeAuthorizedMainnetSetup,
  loadFundingKeypair,
  parseSetupCliArguments,
  validateFinalizedAccount,
  validateFinalizedTransactionEvidence,
} from './local-fixture-cli.mjs';
import { assertSafeLocalSecretPath, generateControlFiles } from './generate-controls.mjs';

const publicKey = byte => Keypair.fromSeed(Buffer.alloc(32, byte)).publicKey.toBase58();
const EMPTY = publicKey(1);
const KNOWN = publicKey(2);
const PAYER = publicKey(3);
const LOCAL_ATTESTATION = 'I_CONFIRM_THIS_IS_A_TRUSTED_LOCAL_MACHINE_NOT_THE_ARTIFACT_VPS';

function offlinePlan() {
  return createOfflineFixturePlan({
    empty_control_wallet: EMPTY,
    known_control_wallet: KNOWN,
    fee_payer: PAYER,
  });
}

function evidence(overrides = {}) {
  const plan = offlinePlan();
  return {
    genesis_hash: MAINNET_GENESIS_HASH,
    mint_accounts: {
      [CLASSIC_MINT]: {
        outer_owner_program: CLASSIC_TOKEN_PROGRAM,
        account_length: 82,
        required_token_account_length: 165,
        required_account_extensions: [],
      },
      [TOKEN_2022_MINT]: {
        outer_owner_program: TOKEN_2022_PROGRAM,
        account_length: 82,
        required_token_account_length: 170,
        required_account_extensions: ['ImmutableOwner'],
      },
    },
    derived_accounts_absent: Object.fromEntries(plan.derived_accounts.map(item => [item.account, true])),
    rent_lamports_by_account: Object.fromEntries(plan.derived_accounts.map(item => [
      item.account,
      item.token_program === TOKEN_2022_PROGRAM ? 2_074_080 : 2_039_280,
    ])),
    compiled_transaction_fee_lamports: 5_000,
    latest_blockhash: publicKey(9),
    last_valid_block_height: 123,
    ...overrides,
  };
}

test('offline fixture plan derives exactly one account per program and two ATA-create instructions', () => {
  const plan = offlinePlan();

  assert.equal(plan.network, 'mainnet-beta');
  assert.equal(plan.genesis_hash, MAINNET_GENESIS_HASH);
  assert.deepEqual(plan.controls, {
    empty_control_wallet: EMPTY,
    known_control_wallet: KNOWN,
    fee_payer: PAYER,
  });
  assert.deepEqual(plan.derived_accounts.map(item => ({
    mint: item.mint,
    token_program: item.token_program,
    account: item.account,
  })), [
    { mint: CLASSIC_MINT, token_program: CLASSIC_TOKEN_PROGRAM, account: plan.derived_accounts[0].account },
    { mint: TOKEN_2022_MINT, token_program: TOKEN_2022_PROGRAM, account: plan.derived_accounts[1].account },
  ]);
  assert.equal(new Set(plan.derived_accounts.map(item => item.account)).size, 2);
  assert.equal(plan.instructions.length, 2);
  assert.deepEqual(plan.instructions.map(item => ({
    index: item.index,
    kind: item.kind,
    program_id: item.program_id,
    mint: item.mint,
    token_program: item.token_program,
  })), [
    {
      index: 0,
      kind: 'create_associated_token_account',
      program_id: ASSOCIATED_TOKEN_PROGRAM,
      mint: CLASSIC_MINT,
      token_program: CLASSIC_TOKEN_PROGRAM,
    },
    {
      index: 1,
      kind: 'create_associated_token_account',
      program_id: ASSOCIATED_TOKEN_PROGRAM,
      mint: TOKEN_2022_MINT,
      token_program: TOKEN_2022_PROGRAM,
    },
  ]);
  assert.equal(plan.instructions.every(item => item.instruction_accounts.includes(KNOWN)), true);
  assert.equal(plan.instructions.every(item => !item.instruction_accounts.includes(EMPTY)), true);
  assert.deepEqual(plan.transaction_constraints.signer_public_keys, [PAYER]);
  assert.equal(plan.transaction_constraints.known_control_must_sign, false);
  assert.equal(plan.transaction_constraints.empty_control_must_sign, false);
  assert.equal(JSON.stringify(plan).includes('private'), false);
  assert.equal(JSON.stringify(plan).includes('secret'), false);
});

test('Token-2022 ATA layout includes ImmutableOwner and the exact 165/170 contract continues preflight', async () => {
  assert.equal(requiredAssociatedAccountLength({ tlvData: Buffer.alloc(0) }, TOKEN_2022_PROGRAM), 170);
  assert.equal(requiredAssociatedAccountLength({ tlvData: Buffer.alloc(0) }, CLASSIC_TOKEN_PROGRAM), 165);

  const plan = offlinePlan();
  let accountCalls = 0;
  const connection = {
    async getGenesisHash() { return MAINNET_GENESIS_HASH; },
    async getMultipleAccountsInfoAndContext() {
      accountCalls += 1;
      if (accountCalls === 2) return { context: { slot: 401 }, value: [null, null] };
      if (accountCalls !== 1) throw new Error('unexpected_account_lookup');
      return {
        context: { slot: 400 },
        value: [
          { owner: { toBase58: () => CLASSIC_TOKEN_PROGRAM }, data: Buffer.alloc(82) },
          { owner: { toBase58: () => TOKEN_2022_PROGRAM }, data: Buffer.alloc(82) },
        ],
      };
    },
    async getMinimumBalanceForRentExemption(length) { return length === 170 ? 2_074_080 : 2_039_280; },
    async getLatestBlockhash() { return { blockhash: publicKey(9), lastValidBlockHeight: 123 }; },
    async getFeeForMessage() { return { value: 5_000 }; },
    async simulateTransaction() { return { context: { slot: 403 }, value: { err: null } }; },
  };
  const result = await collectReadOnlyPreflight(plan, connection, {
    inspectMintAccount: (_mint, _account, tokenProgram) => ({
      account_length: 82,
      required_token_account_length: tokenProgram === TOKEN_2022_PROGRAM ? 170 : 165,
      required_account_extensions: tokenProgram === TOKEN_2022_PROGRAM ? ['ImmutableOwner'] : [],
    }),
  });
  assert.deepEqual(result.preflight.account_lengths.map(item => item.required_token_account_length), [165, 170]);
  assert.equal(accountCalls, 2);
});

test('preflight accepts only the independently verified exact 165/170 layouts below 0.006 SOL', () => {
  const result = evaluatePreflightEvidence(offlinePlan(), evidence());
  assert.deepEqual(result.cost, {
    rent_lamports: 4_113_360,
    compiled_transaction_fee_lamports: 5_000,
    total_lamports: 4_118_360,
    total_sol: '0.004118360',
    maximum_lamports: MAX_SETUP_LAMPORTS,
  });
  assert.equal(result.status, 'READY_FOR_EXPLICIT_EXECUTION_AUTHORIZATION');
  assert.deepEqual(result.account_lengths.map(item => item.required_token_account_length), [165, 170]);
});

test('preflight stops on any Token-2022 layout other than exact ImmutableOwner-only 170 bytes', () => {
  for (const unexpectedLength of [165, 171, 178]) {
    const changed = evidence();
    changed.mint_accounts[TOKEN_2022_MINT].required_token_account_length = unexpectedLength;
    assert.throws(
      () => evaluatePreflightEvidence(offlinePlan(), changed),
      error => error?.code === 'token_2022_account_layout_unapproved',
    );
  }
});

test('preflight stops on any additional Token-2022 account extension even if length evidence is forged to 170', () => {
  const changed = evidence();
  changed.mint_accounts[TOKEN_2022_MINT].required_account_extensions = ['ImmutableOwner', 'TransferFeeAmount'];
  assert.throws(
    () => evaluatePreflightEvidence(offlinePlan(), changed),
    error => error?.code === 'token_2022_account_layout_unapproved',
  );
});

test('preflight stops when total exceeds 0.006 SOL', () => {
  const expensive = evidence({ compiled_transaction_fee_lamports: 2_000_000 });
  assert.throws(
    () => evaluatePreflightEvidence(offlinePlan(), expensive),
    error => error?.code === 'setup_cost_cap_exceeded',
  );
});

test('frozen manifest contains public finalized evidence and null decimals only', () => {
  const plan = offlinePlan();
  const preflight = evaluatePreflightEvidence(plan, evidence());
  const [classic, token2022] = plan.derived_accounts;
  const manifest = buildFrozenPublicManifest({
    plan,
    preflight,
    created_at_utc: '2026-08-31T00:00:00.000Z',
    setup_transaction: {
      signature: '4'.repeat(64),
      finalized_slot: 500,
      sanitized_transaction_sha256: 'a'.repeat(64),
    },
    confirmed_accounts: {
      [classic.account]: {
        outer_owner_program: CLASSIC_TOKEN_PROGRAM,
        account_length: 165,
        is_native: false,
        raw_account_data_sha256: 'b'.repeat(64),
        raw_amount: '0',
      },
      [token2022.account]: {
        outer_owner_program: TOKEN_2022_PROGRAM,
        account_length: 170,
        is_native: true,
        raw_account_data_sha256: 'c'.repeat(64),
        raw_amount: '0',
      },
    },
  });

  assert.equal(manifest.empty_control.wallet, EMPTY);
  assert.deepEqual(manifest.empty_control.setup_actions, []);
  assert.equal(manifest.known_control.wallet, KNOWN);
  assert.equal(manifest.known_control.setup_transaction.fee_payer, PAYER);
  const rows = Object.values(manifest.known_control.expected_accounts).flat();
  assert.equal(rows.length, 2);
  assert.equal(rows.every(row => row.decimals === null && row.raw_amount === '0'), true);
  assert.equal(manifest.evidence_boundary.owner_enumeration_used_to_build_expected_sets, false);
  assert.match(manifest.manifest_sha256, /^[0-9a-f]{64}$/);
  const text = JSON.stringify(manifest);
  for (const forbidden of ['secretKey', 'private_key', 'rpc_url', 'raw_base64']) assert.equal(text.includes(forbidden), false);
});

test('local key generator writes exclusive mode-0600 secrets and public-only output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slice-3b-2-controls-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secretDir = join(root, 'secrets');
  const publicOutput = join(root, 'controls-public.json');
  const generated = await generateControlFiles({
    secret_dir: secretDir,
    public_output: publicOutput,
    local_machine_attestation: LOCAL_ATTESTATION,
  }, {
    createKeypair: (() => {
      const keypairs = [Keypair.fromSeed(Buffer.alloc(32, 11)), Keypair.fromSeed(Buffer.alloc(32, 12))];
      return () => keypairs.shift();
    })(),
  });

  assert.deepEqual(generated, {
    empty_control_wallet: Keypair.fromSeed(Buffer.alloc(32, 11)).publicKey.toBase58(),
    known_control_wallet: Keypair.fromSeed(Buffer.alloc(32, 12)).publicKey.toBase58(),
    public_output: publicOutput,
  });
  const publicJson = JSON.parse(await readFile(publicOutput, 'utf8'));
  assert.deepEqual(publicJson, {
    fixture_controls_version: 'artifact_slice_3b_2_public_controls_v1',
    empty_control_wallet: generated.empty_control_wallet,
    known_control_wallet: generated.known_control_wallet,
  });
  assert.equal(JSON.stringify(publicJson).includes('secret'), false);
  for (const filename of ['empty-control.keypair.json', 'known-control.keypair.json']) {
    assert.equal((await stat(join(secretDir, filename))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(secretDir)).mode & 0o777, 0o700);
});

test('secret paths require local attestation and reject Git worktrees or symlink parents', async t => {
  await assert.rejects(
    assertSafeLocalSecretPath('/tmp/slice-3b-2-safe-path', 'wrong'),
    error => error?.code === 'trusted_local_machine_not_attested',
  );
  await assert.rejects(
    assertSafeLocalSecretPath('/root/artifact/trade-artifact/forbidden-control-secrets', LOCAL_ATTESTATION),
    error => error?.code === 'secret_path_inside_git_worktree',
  );
  await assert.doesNotReject(
    assertSafeLocalSecretPath('/tmp/slice-3b-2-safe-path', LOCAL_ATTESTATION),
  );

  const root = await mkdtemp(join(tmpdir(), 'slice-3b-2-path-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target');
  const linked = join(root, 'linked');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, linked);
  await assert.rejects(
    assertSafeLocalSecretPath(join(linked, 'secret.json'), LOCAL_ATTESTATION),
    error => error?.code === 'local_secret_parent_not_canonical',
  );
});

test('funding keypair loader rejects relative paths before reading', async () => {
  await assert.rejects(
    loadFundingKeypair('relative-funder.json', LOCAL_ATTESTATION),
    error => error?.code === 'funding_keypair_path_unsafe',
  );
});

test('read-only preflight independently verifies mints, absence, rent, fee, and simulation without signer capability', async () => {
  const plan = offlinePlan();
  const trace = [];
  let accountCall = 0;
  const connection = {
    async getGenesisHash() { trace.push('getGenesisHash'); return MAINNET_GENESIS_HASH; },
    async getMultipleAccountsInfoAndContext(keys, commitment) {
      trace.push(`getMultipleAccountsInfoAndContext:${keys.length}:${commitment}`);
      accountCall += 1;
      if (accountCall === 1) {
        return {
          context: { slot: 400 },
          value: [
            { owner: { toBase58: () => CLASSIC_TOKEN_PROGRAM }, data: Buffer.alloc(82), executable: false },
            { owner: { toBase58: () => TOKEN_2022_PROGRAM }, data: Buffer.alloc(82), executable: false },
          ],
        };
      }
      return { context: { slot: 401 }, value: [null, null] };
    },
    async getMinimumBalanceForRentExemption(length, commitment) {
      trace.push(`getMinimumBalanceForRentExemption:${length}:${commitment}`);
      return length === 170 ? 2_074_080 : 2_039_280;
    },
    async getLatestBlockhash(commitment) {
      trace.push(`getLatestBlockhash:${commitment}`);
      return { blockhash: publicKey(9), lastValidBlockHeight: 123 };
    },
    async getFeeForMessage(_message, commitment) {
      trace.push(`getFeeForMessage:${commitment}`);
      return { context: { slot: 402 }, value: 5_000 };
    },
    async simulateTransaction(_transaction) {
      trace.push('simulateTransaction');
      return { context: { slot: 403 }, value: { err: null, logs: [] } };
    },
  };
  const result = await collectReadOnlyPreflight(plan, connection, {
    inspectMintAccount(_mint, accountInfo, tokenProgram) {
      assert.equal(accountInfo.owner.toBase58(), tokenProgram);
      return {
        account_length: accountInfo.data.length,
        required_token_account_length: tokenProgram === TOKEN_2022_PROGRAM ? 170 : 165,
        required_account_extensions: tokenProgram === TOKEN_2022_PROGRAM ? ['ImmutableOwner'] : [],
      };
    },
  });

  assert.equal(result.preflight.status, 'READY_FOR_EXPLICIT_EXECUTION_AUTHORIZATION');
  assert.equal(result.preflight.cost.total_lamports, 4_118_360);
  assert.equal(result.transaction.instructions.length, 2);
  assert.deepEqual(trace, [
    'getGenesisHash',
    'getMultipleAccountsInfoAndContext:2:finalized',
    'getMultipleAccountsInfoAndContext:2:finalized',
    'getMinimumBalanceForRentExemption:165:finalized',
    'getMinimumBalanceForRentExemption:170:finalized',
    'getLatestBlockhash:finalized',
    'getFeeForMessage:finalized',
    'simulateTransaction',
  ]);
});

test('default setup-tool mode is offline and invokes no RPC, signer, or submit capability', async () => {
  const calls = { rpc: 0, signer: 0, submit: 0 };
  const result = await runFixtureSetupTool({
    mode: 'offline-plan',
    empty_control_wallet: EMPTY,
    known_control_wallet: KNOWN,
    fee_payer: PAYER,
  }, {
    createConnection() { calls.rpc += 1; throw new Error('must not run'); },
    loadFundingKeypair() { calls.signer += 1; throw new Error('must not run'); },
    submitTransaction() { calls.submit += 1; throw new Error('must not run'); },
  });
  assert.equal(result.status, 'OFFLINE_PLAN_ONLY');
  assert.deepEqual(calls, { rpc: 0, signer: 0, submit: 0 });
});

test('CLI parser requires both the explicit execution flag and exact authorization token', () => {
  assert.throws(() => parseSetupCliArguments([]), error => error?.code === 'mainnet_execution_not_authorized');
  assert.throws(() => parseSetupCliArguments([
    '--execute-authorized-mainnet-setup',
    '--authorization', 'wrong',
    '--controls-public', '/local/controls.json',
    '--fee-payer-pubkey', PAYER,
    '--funding-keypair', '/local/funder.json',
    '--local-machine-attestation', LOCAL_ATTESTATION,
    '--manifest-output', '/local/manifest.json',
  ]), error => error?.code === 'mainnet_execution_not_authorized');
  assert.deepEqual(parseSetupCliArguments([
    '--execute-authorized-mainnet-setup',
    '--authorization', 'SLICE_3B_2_ONE_MAINNET_SETUP_TRANSACTION_APPROVED',
    '--controls-public', '/local/controls.json',
    '--fee-payer-pubkey', PAYER,
    '--funding-keypair', '/local/funder.json',
    '--local-machine-attestation', LOCAL_ATTESTATION,
    '--manifest-output', '/local/manifest.json',
  ]), {
    mode: 'execute-authorized-mainnet-setup',
    execution_authorization: 'SLICE_3B_2_ONE_MAINNET_SETUP_TRANSACTION_APPROVED',
    controls_public: '/local/controls.json',
    fee_payer: PAYER,
    funding_keypair: '/local/funder.json',
    local_machine_attestation: LOCAL_ATTESTATION,
    output: '/local/manifest.json',
  });
});

test('finalized transaction evidence must match the exact local message and signature', () => {
  const expectedMessage = Buffer.from('exact-message');
  const signature = '4'.repeat(64);
  assert.equal(validateFinalizedTransactionEvidence({
    slot: 500,
    meta: { err: null },
    transaction: {
      signatures: [signature],
      message: { serialize: () => Buffer.from(expectedMessage) },
    },
  }, expectedMessage, signature), 500);

  assert.throws(() => validateFinalizedTransactionEvidence({
    slot: 500,
    meta: { err: null },
    transaction: {
      signatures: [signature],
      message: { serialize: () => Buffer.from('different-message') },
    },
  }, expectedMessage, signature), error => error?.code === 'finalized_transaction_message_mismatch');

  assert.throws(() => validateFinalizedTransactionEvidence({
    slot: 500,
    meta: { err: null },
    transaction: {
      signatures: ['5'.repeat(64)],
      message: { serialize: () => Buffer.from(expectedMessage) },
    },
  }, expectedMessage, signature), error => error?.code === 'finalized_transaction_signature_mismatch');
});

test('final account validation enforces exact 170-byte Token-2022 native and ImmutableOwner state', () => {
  const item = {
    account: publicKey(20),
    mint: TOKEN_2022_MINT,
    token_program: TOKEN_2022_PROGRAM,
  };
  const baseAccount = {
    executable: false,
    owner: { toBase58: () => TOKEN_2022_PROGRAM },
    data: Buffer.alloc(170),
  };
  const decoded = {
    mint: { toBase58: () => TOKEN_2022_MINT },
    owner: { toBase58: () => KNOWN },
    amount: 0n,
    delegate: null,
    delegatedAmount: 0n,
    closeAuthority: null,
    isInitialized: true,
    isFrozen: false,
    isNative: true,
    rentExemptReserve: 2_039_280n,
    tlvData: Buffer.from([ExtensionType.ImmutableOwner, 0, 0, 0]),
  };
  assert.equal(validateFinalizedAccount(baseAccount, item, KNOWN, { decodeAccount: () => decoded }).raw_amount, '0');
  assert.throws(
    () => validateFinalizedAccount({ ...baseAccount, data: Buffer.alloc(165) }, item, KNOWN, { decodeAccount: () => decoded }),
    error => error?.code === 'finalized_account_layout_unapproved',
  );
  assert.throws(
    () => validateFinalizedAccount(baseAccount, item, KNOWN, {
      decodeAccount: () => ({ ...decoded, isNative: false, rentExemptReserve: null }),
    }),
    error => error?.code === 'token_2022_native_state_mismatch',
  );
  assert.throws(
    () => validateFinalizedAccount(baseAccount, item, KNOWN, {
      decodeAccount: () => ({ ...decoded, tlvData: Buffer.alloc(0) }),
    }),
    error => error?.code === 'token_2022_extension_state_mismatch',
  );
  assert.throws(
    () => validateFinalizedAccount(baseAccount, item, KNOWN, {
      decodeAccount: () => ({
        ...decoded,
        tlvData: Buffer.from([ExtensionType.ImmutableOwner, 0, 1, 0]),
      }),
    }),
    error => error?.code === 'token_2022_extension_state_mismatch',
  );
  assert.throws(
    () => validateFinalizedAccount(baseAccount, item, KNOWN, {
      decodeAccount: () => ({
        ...decoded,
        tlvData: Buffer.from([
          ExtensionType.ImmutableOwner, 0, 0, 0,
          ExtensionType.TransferFeeAmount, 0, 0, 0,
        ]),
      }),
    }),
    error => error?.code === 'token_2022_extension_state_mismatch',
  );
});

test('final account validation keeps classic USDC exact 165-byte non-native state', () => {
  const item = {
    account: publicKey(21),
    mint: CLASSIC_MINT,
    token_program: CLASSIC_TOKEN_PROGRAM,
  };
  const account = {
    executable: false,
    owner: { toBase58: () => CLASSIC_TOKEN_PROGRAM },
    data: Buffer.alloc(165),
  };
  const decoded = {
    mint: { toBase58: () => CLASSIC_MINT },
    owner: { toBase58: () => KNOWN },
    amount: 0n,
    delegate: null,
    delegatedAmount: 0n,
    closeAuthority: null,
    isInitialized: true,
    isFrozen: false,
    isNative: false,
    rentExemptReserve: null,
    tlvData: Buffer.alloc(0),
  };
  assert.equal(validateFinalizedAccount(account, item, KNOWN, { decodeAccount: () => decoded }).account_length, 165);
  assert.throws(
    () => validateFinalizedAccount({ ...account, data: Buffer.alloc(170) }, item, KNOWN, {
      decodeAccount: () => decoded,
    }),
    error => error?.code === 'finalized_account_layout_unapproved',
  );
});

test('executor refuses before connection or signer access when recovery persistence is unavailable', async () => {
  let capabilityTouched = false;
  await assert.rejects(executeAuthorizedMainnetSetup({
    execution_authorization: 'SLICE_3B_2_ONE_MAINNET_SETUP_TRANSACTION_APPROVED',
    empty_control_wallet: EMPTY,
    known_control_wallet: KNOWN,
    fee_payer: PAYER,
    funding_keypair: '/local/funder.json',
    local_machine_attestation: LOCAL_ATTESTATION,
  }, {
    createConnection: () => { capabilityTouched = true; throw new Error('must not run'); },
    loadFundingKeypair: async () => { capabilityTouched = true; throw new Error('must not run'); },
  }), error => error?.code === 'submission_intent_persistence_unavailable');
  assert.equal(capabilityTouched, false);
});

test('authorized executor performs one signed submit, finalized exact-key confirmation, and emits public manifest', async () => {
  const payer = Keypair.fromSeed(Buffer.alloc(32, 3));
  let accountCall = 0;
  let sendCalls = 0;
  let submittedTransaction;
  let submissionIntent;
  const connection = {
    async getGenesisHash() { return MAINNET_GENESIS_HASH; },
    async getMultipleAccountsInfoAndContext(_keys, _commitment) {
      accountCall += 1;
      if (accountCall === 1) {
        return {
          context: { slot: 400 },
          value: [
            { owner: { toBase58: () => CLASSIC_TOKEN_PROGRAM }, data: Buffer.alloc(82), executable: false },
            { owner: { toBase58: () => TOKEN_2022_PROGRAM }, data: Buffer.alloc(82), executable: false },
          ],
        };
      }
      if (accountCall === 2) return { context: { slot: 401 }, value: [null, null] };
      return { context: { slot: 501 }, value: [{ lane: 'classic' }, { lane: 'token2022' }] };
    },
    async getMinimumBalanceForRentExemption() { return 2_039_280; },
    async getLatestBlockhash() { return { blockhash: publicKey(9), lastValidBlockHeight: 123 }; },
    async getFeeForMessage() { return { context: { slot: 402 }, value: 5_000 }; },
    async simulateTransaction() { return { context: { slot: 403 }, value: { err: null, logs: [] } }; },
    async sendRawTransaction(raw, options) {
      sendCalls += 1;
      assert.notEqual(submissionIntent, undefined);
      assert.deepEqual(options, { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 });
      submittedTransaction = Transaction.from(raw);
      assert.equal(submittedTransaction.instructions.length, 2);
      assert.equal(submissionIntent.signature, bs58.encode(submittedTransaction.signature));
      return bs58.encode(submittedTransaction.signature);
    },
    async confirmTransaction(_strategy, commitment) {
      assert.equal(commitment, 'finalized');
      return { context: { slot: 500 }, value: { err: null } };
    },
    async getTransaction(_signature, config) {
      assert.deepEqual(config, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      return {
        slot: 500,
        meta: { err: null },
        transaction: {
          signatures: [bs58.encode(submittedTransaction.signature)],
          message: submittedTransaction.compileMessage(),
        },
      };
    },
  };

  const result = await executeAuthorizedMainnetSetup({
    execution_authorization: 'SLICE_3B_2_ONE_MAINNET_SETUP_TRANSACTION_APPROVED',
    empty_control_wallet: EMPTY,
    known_control_wallet: KNOWN,
    fee_payer: PAYER,
    funding_keypair: '/local/funder.json',
    local_machine_attestation: LOCAL_ATTESTATION,
  }, {
    createConnection: () => connection,
    loadFundingKeypair: async () => payer,
    persistSubmissionIntent: async value => { submissionIntent = value; },
    inspectMintAccount: (_mint, accountInfo, tokenProgram) => {
      assert.equal(accountInfo.owner.toBase58(), tokenProgram);
      return {
        account_length: 82,
        required_token_account_length: tokenProgram === TOKEN_2022_PROGRAM ? 170 : 165,
        required_account_extensions: tokenProgram === TOKEN_2022_PROGRAM ? ['ImmutableOwner'] : [],
      };
    },
    inspectFinalizedAccount: (_account, item) => ({
      outer_owner_program: item.token_program,
      account_length: item.token_program === TOKEN_2022_PROGRAM ? 170 : 165,
      is_native: item.token_program === TOKEN_2022_PROGRAM,
      raw_account_data_sha256: item.token_program === CLASSIC_TOKEN_PROGRAM ? 'b'.repeat(64) : 'c'.repeat(64),
      raw_amount: '0',
    }),
  });

  assert.equal(sendCalls, 1);
  assert.equal(result.status, 'FINALIZED_PUBLIC_MANIFEST_READY');
  assert.equal(result.manifest.empty_control.wallet, EMPTY);
  assert.equal(result.manifest.known_control.wallet, KNOWN);
  const rows = Object.values(result.manifest.known_control.expected_accounts).flat();
  assert.equal(rows.length, 2);
  assert.equal(rows.every(row => row.decimals === null && row.raw_amount === '0'), true);
});

test('execution is denied unless the exact explicit authorization mode and token are selected', async () => {
  for (const input of [
    {
      mode: 'execute',
      empty_control_wallet: EMPTY,
      known_control_wallet: KNOWN,
      fee_payer: PAYER,
    },
    {
      mode: 'execute-authorized-mainnet-setup',
      empty_control_wallet: EMPTY,
      known_control_wallet: KNOWN,
      fee_payer: PAYER,
    },
    {
      mode: 'execute-authorized-mainnet-setup',
      execution_authorization: 'wrong',
      empty_control_wallet: EMPTY,
      known_control_wallet: KNOWN,
      fee_payer: PAYER,
    },
  ]) {
    await assert.rejects(
      runFixtureSetupTool(input, { executeAuthorizedMainnetSetup: () => assert.fail('must not execute') }),
      error => error?.code === 'mainnet_execution_not_authorized',
    );
  }
});

test('exact execution authorization delegates once to the closed execution capability', async () => {
  let calls = 0;
  const input = {
    mode: 'execute-authorized-mainnet-setup',
    execution_authorization: 'SLICE_3B_2_ONE_MAINNET_SETUP_TRANSACTION_APPROVED',
    empty_control_wallet: EMPTY,
    known_control_wallet: KNOWN,
    fee_payer: PAYER,
  };
  const result = await runFixtureSetupTool(input, {
    async executeAuthorizedMainnetSetup(received) {
      calls += 1;
      assert.equal(received, input);
      return { status: 'FINALIZED' };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: 'FINALIZED' });
});
