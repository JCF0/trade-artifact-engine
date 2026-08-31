import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT_2022,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

import {
  cloneAndFreeze,
  sha256CanonicalJson,
} from '../../src/verification-scope-v1-3/contract.mjs';

export const FIXTURE_VERSION = 'artifact_slice_3b_2_owner_enumeration_fixture_v1';
export const PLAN_VERSION = 'artifact_slice_3b_2_fixture_setup_plan_v1';
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const CLASSIC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const CLASSIC_TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
export const TOKEN_2022_MINT = NATIVE_MINT_2022.toBase58();
export const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();
export const ASSOCIATED_TOKEN_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
export const APPROVED_CLASSIC_ACCOUNT_LENGTH = 165;
export const APPROVED_TOKEN_2022_ACCOUNT_LENGTH = 170;
export const MAX_SETUP_LAMPORTS = 6_000_000;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export class FixtureSetupError extends Error {
  constructor(code) {
    super(code.replaceAll('_', ' '));
    this.name = 'Slice3B2FixtureSetupError';
    this.code = code;
    delete this.stack;
  }
}

function fail(code) {
  throw new FixtureSetupError(code);
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function publicKey(value) {
  if (typeof value !== 'string' || value.length > 44 || !BASE58.test(value)) fail('public_key_invalid');
  try {
    const parsed = new PublicKey(value);
    if (parsed.toBase58() !== value) fail('public_key_invalid');
    return parsed;
  } catch {
    fail('public_key_invalid');
  }
}

function exactObject(value, fields, code = 'fixture_input_invalid') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.getOwnPropertySymbols(value).length !== 0
      || Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail(code);
}

function instructionDescriptor(index, instruction, mint, tokenProgram, associatedAccount) {
  return {
    index,
    kind: 'create_associated_token_account',
    program_id: instruction.programId.toBase58(),
    mint,
    token_program: tokenProgram,
    associated_account: associatedAccount,
    instruction_accounts: instruction.keys.map(item => item.pubkey.toBase58()),
    account_metas: instruction.keys.map(item => ({
      account: item.pubkey.toBase58(),
      is_signer: item.isSigner,
      is_writable: item.isWritable,
    })),
    instruction_data_hex: Buffer.from(instruction.data).toString('hex'),
  };
}

export function createOfflineFixturePlan(input) {
  exactObject(input, ['empty_control_wallet', 'known_control_wallet', 'fee_payer']);
  const empty = publicKey(input.empty_control_wallet);
  const known = publicKey(input.known_control_wallet);
  const payer = publicKey(input.fee_payer);
  if (empty.equals(known) || empty.equals(payer) || known.equals(payer)) fail('control_wallets_not_distinct');

  const classicMint = publicKey(CLASSIC_MINT);
  const token2022Mint = publicKey(TOKEN_2022_MINT);
  const classicAccount = getAssociatedTokenAddressSync(
    classicMint, known, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const token2022Account = getAssociatedTokenAddressSync(
    token2022Mint, known, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const instructions = [
    createAssociatedTokenAccountInstruction(
      payer, classicAccount, known, classicMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountInstruction(
      payer, token2022Account, known, token2022Mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  ];

  return cloneAndFreeze({
    plan_version: PLAN_VERSION,
    network: 'mainnet-beta',
    genesis_hash: MAINNET_GENESIS_HASH,
    controls: {
      empty_control_wallet: empty.toBase58(),
      known_control_wallet: known.toBase58(),
      fee_payer: payer.toBase58(),
    },
    mints: [
      { mint: CLASSIC_MINT, token_program: CLASSIC_TOKEN_PROGRAM, approved_account_length: APPROVED_CLASSIC_ACCOUNT_LENGTH },
      { mint: TOKEN_2022_MINT, token_program: TOKEN_2022_PROGRAM, approved_account_length: APPROVED_TOKEN_2022_ACCOUNT_LENGTH },
    ],
    derived_accounts: [
      { account: classicAccount.toBase58(), mint: CLASSIC_MINT, token_program: CLASSIC_TOKEN_PROGRAM },
      { account: token2022Account.toBase58(), mint: TOKEN_2022_MINT, token_program: TOKEN_2022_PROGRAM },
    ],
    instructions: [
      instructionDescriptor(0, instructions[0], CLASSIC_MINT, CLASSIC_TOKEN_PROGRAM, classicAccount.toBase58()),
      instructionDescriptor(1, instructions[1], TOKEN_2022_MINT, TOKEN_2022_PROGRAM, token2022Account.toBase58()),
    ],
    transaction_constraints: {
      instruction_count: 2,
      signer_public_keys: [payer.toBase58()],
      known_control_must_sign: false,
      empty_control_must_sign: false,
      prohibited_instruction_classes: [
        'mint_creation', 'mint_to', 'token_transfer', 'sol_transfer_to_control', 'sync_native',
        'authority_change', 'delegate', 'close_account', 'memo', 'unrelated_instruction',
      ],
    },
  });
}

function mintEvidence(value, mint, expectedProgram) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('mint_evidence_invalid');
  if (value.outer_owner_program !== expectedProgram) fail('mint_program_identity_mismatch');
  if (!safeNonnegativeInteger(value.account_length) || value.account_length === 0) fail('mint_evidence_invalid');
  if (!safeNonnegativeInteger(value.required_token_account_length)
      || value.required_token_account_length === 0) fail('mint_evidence_invalid');
  if (!Array.isArray(value.required_account_extensions)) fail('mint_evidence_invalid');
  if (mint === TOKEN_2022_MINT
      && (value.required_token_account_length !== APPROVED_TOKEN_2022_ACCOUNT_LENGTH
        || value.required_account_extensions.length !== 1
        || value.required_account_extensions[0] !== 'ImmutableOwner')) {
    fail('token_2022_account_layout_unapproved');
  }
  if (mint === CLASSIC_MINT
      && (value.required_token_account_length !== APPROVED_CLASSIC_ACCOUNT_LENGTH
        || value.required_account_extensions.length !== 0)) {
    fail('classic_account_layout_unapproved');
  }
  return value;
}

export function evaluatePreflightEvidence(plan, evidence) {
  if (plan?.plan_version !== PLAN_VERSION) fail('fixture_plan_invalid');
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) fail('preflight_evidence_invalid');
  if (evidence.genesis_hash !== MAINNET_GENESIS_HASH) fail('mainnet_identity_mismatch');

  const classicEvidence = mintEvidence(evidence.mint_accounts?.[CLASSIC_MINT], CLASSIC_MINT, CLASSIC_TOKEN_PROGRAM);
  const token2022Evidence = mintEvidence(evidence.mint_accounts?.[TOKEN_2022_MINT], TOKEN_2022_MINT, TOKEN_2022_PROGRAM);
  const accountLengths = [
    { mint: CLASSIC_MINT, token_program: CLASSIC_TOKEN_PROGRAM, required_token_account_length: classicEvidence.required_token_account_length },
    { mint: TOKEN_2022_MINT, token_program: TOKEN_2022_PROGRAM, required_token_account_length: token2022Evidence.required_token_account_length },
  ];

  let rentLamports = 0;
  for (const item of plan.derived_accounts) {
    if (evidence.derived_accounts_absent?.[item.account] !== true) fail('derived_account_already_exists');
    const rent = evidence.rent_lamports_by_account?.[item.account];
    if (!safeNonnegativeInteger(rent) || rent === 0) fail('rent_evidence_invalid');
    rentLamports += rent;
  }
  const fee = evidence.compiled_transaction_fee_lamports;
  if (!safeNonnegativeInteger(fee) || fee === 0) fail('compiled_fee_invalid');
  publicKey(evidence.latest_blockhash);
  if (!safeNonnegativeInteger(evidence.last_valid_block_height)) fail('blockhash_evidence_invalid');
  const total = rentLamports + fee;
  if (!Number.isSafeInteger(total) || total > MAX_SETUP_LAMPORTS) fail('setup_cost_cap_exceeded');

  return cloneAndFreeze({
    status: 'READY_FOR_EXPLICIT_EXECUTION_AUTHORIZATION',
    network: 'mainnet-beta',
    genesis_hash: MAINNET_GENESIS_HASH,
    mint_program_verification: accountLengths.map(item => ({
      mint: item.mint,
      expected_token_program: item.token_program,
      verified: true,
    })),
    account_lengths: accountLengths,
    cost: {
      rent_lamports: rentLamports,
      compiled_transaction_fee_lamports: fee,
      total_lamports: total,
      total_sol: (total / 1_000_000_000).toFixed(9),
      maximum_lamports: MAX_SETUP_LAMPORTS,
    },
    recent_blockhash: evidence.latest_blockhash,
    last_valid_block_height: evidence.last_valid_block_height,
  });
}

function confirmedAccount(value, expectedProgram) {
  const expectedNative = expectedProgram === TOKEN_2022_PROGRAM;
  const expectedLength = expectedNative
    ? APPROVED_TOKEN_2022_ACCOUNT_LENGTH
    : APPROVED_CLASSIC_ACCOUNT_LENGTH;
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.outer_owner_program !== expectedProgram
      || value.account_length !== expectedLength || value.is_native !== expectedNative
      || typeof value.raw_account_data_sha256 !== 'string' || !HEX_64.test(value.raw_account_data_sha256)
      || value.raw_amount !== '0') fail('confirmed_account_evidence_invalid');
  return value;
}

export function buildFrozenPublicManifest(input) {
  exactObject(input, ['plan', 'preflight', 'created_at_utc', 'setup_transaction', 'confirmed_accounts']);
  const { plan, preflight } = input;
  if (plan?.plan_version !== PLAN_VERSION
      || preflight?.status !== 'READY_FOR_EXPLICIT_EXECUTION_AUTHORIZATION') fail('manifest_input_invalid');
  if (typeof input.created_at_utc !== 'string' || !Number.isFinite(Date.parse(input.created_at_utc))) {
    fail('manifest_input_invalid');
  }
  const transaction = input.setup_transaction;
  if (transaction === null || typeof transaction !== 'object' || Array.isArray(transaction)
      || typeof transaction.signature !== 'string' || transaction.signature.length < 64
      || transaction.signature.length > 88 || !BASE58.test(transaction.signature)
      || !safeNonnegativeInteger(transaction.finalized_slot)
      || typeof transaction.sanitized_transaction_sha256 !== 'string'
      || !HEX_64.test(transaction.sanitized_transaction_sha256)) fail('manifest_input_invalid');

  const expectedAccounts = {};
  for (const program of [CLASSIC_TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) expectedAccounts[program] = [];
  for (const [index, item] of plan.derived_accounts.entries()) {
    const confirmation = confirmedAccount(input.confirmed_accounts[item.account], item.token_program);
    const instruction = plan.instructions[index];
    expectedAccounts[item.token_program].push({
      account: item.account,
      mint: item.mint,
      token_program: item.token_program,
      creation_instruction_index: instruction.index,
      creation_transaction_signature: transaction.signature,
      creation_finalized_slot: transaction.finalized_slot,
      instruction_accounts: [...instruction.instruction_accounts],
      outer_owner_program: confirmation.outer_owner_program,
      account_length: confirmation.account_length,
      is_native: confirmation.is_native,
      raw_account_data_sha256: confirmation.raw_account_data_sha256,
      raw_amount: '0',
      decimals: null,
    });
  }
  for (const rows of Object.values(expectedAccounts)) rows.sort((left, right) => left.account.localeCompare(right.account));

  const preimage = {
    fixture_version: FIXTURE_VERSION,
    network: 'mainnet-beta',
    genesis_hash: MAINNET_GENESIS_HASH,
    created_at_utc: input.created_at_utc,
    empty_control: {
      wallet: plan.controls.empty_control_wallet,
      setup_actions: [],
      controlled_condition: 'locally_generated_never_funded_never_used',
    },
    known_control: {
      wallet: plan.controls.known_control_wallet,
      setup_transaction: {
        signature: transaction.signature,
        finalized_slot: transaction.finalized_slot,
        fee_payer: plan.controls.fee_payer,
        sanitized_transaction_sha256: transaction.sanitized_transaction_sha256,
      },
      expected_accounts: expectedAccounts,
    },
    evidence_boundary: {
      population_basis: 'fresh_control_plus_exact_locally_constructed_finalized_setup',
      known_row_confirmation: ['finalized_getTransaction', 'finalized_getMultipleAccounts'],
      owner_enumeration_used_to_build_expected_sets: false,
      ata_derivation_used_as_completeness_proof: false,
    },
  };
  return cloneAndFreeze({ ...preimage, manifest_sha256: sha256CanonicalJson(preimage) });
}
