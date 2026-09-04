import { PublicKey } from '@solana/web3.js';

import { acquireWalletHistoryV2 } from '../../wallet-acquisition/orchestrator.mjs';
import { createWalletHistoryPortV2 } from '../../wallet-acquisition/provider-port-v2.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from '../../wallet-acquisition/request-contract.mjs';
import { createEvidenceContextTranscriptPortV1 } from '../../wallet-acquisition/evidence-context-sidecar-v1.mjs';
import { createFrozenControlledHeliusTargetAccountEnumerationPortV2 } from '../../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import { buildSourceBoundAuthoritativeEvidenceContextV13 } from '../authoritative-evidence-context.mjs';

export const CONTROLLED_MAINNET_CALIBRATION_ARCHIVE_SHA256_V1 =
  'c6579cf3dc14413d12ccabb9227aa9b931960ccc1441f76f0450b919a8f16d75';
export const CONTROLLED_MAINNET_CALIBRATION_SOURCE_MEMBERS_V1 = Object.freeze({
  acquisition_full_transaction: Object.freeze({
    archive_member_chain: Object.freeze([
      'controlled-calibration-roundtrip-v1/acquisition-finalized-evidence.tar.gz',
      'artifact-route-calibration-r5-outcome-resolution-20260903T154548430Z/acquisition-20260903T153624603Z.tar.gz',
      'acquisition-20260903T153624603Z/raw-finalized-transaction-response.json',
    ]),
    sha256: '52ca7d50c18e24cbf519986fa13c8b9f79c7ca38dfa523dc333bfa896d5a17aa',
  }),
  disposal_full_transaction: Object.freeze({
    archive_member_chain: Object.freeze([
      'controlled-calibration-roundtrip-v1/disposal-finalized-evidence.tar.gz',
      'disposal-finalized-freeze-v1/independent-getTransaction-raw-response.json',
    ]),
    sha256: '910e71083f3743a135bcc1d6ef1ddcb19855d4eb3a36c33c833e29e547508754',
  }),
});
export const CONTROLLED_MAINNET_CALIBRATION_WALLET_V1 =
  '6nHvRF1wK9T4wdnbSZES4mrAfKfJPkVX5wrHqhbkDBgs';
export const CONTROLLED_MAINNET_CALIBRATION_TARGET_MINT_V1 =
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const CONTROLLED_MAINNET_CALIBRATION_QUOTE_MINT_V1 =
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const POOL = '4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP';
const QUOTE_ACCOUNT = '5DTAMqHM14qZmkmHDmKq1b6EkCdohVd28QqsQ67WDLjJ';
const TARGET_ACCOUNT = '88RjLVrrgiowBs7ZG4NqSGhVSsqBZFVVXuMnnpWdwmr6';
const TARGET_VAULT = '9gMRWNfLXNc54ta5LxuM16p72GYap2t6rf455TTBKQW4';
const QUOTE_VAULT = 'CYcxSC2vmbScHFcTtEM6346uqMN8b9zeSGnP9qZu1E6U';
const ORACLE = 'CrkkeqLUo7n6gvzoYMPZ7CHjie1Zua2CHUPe2DFh8mmR';
export const CONTROLLED_MAINNET_CALIBRATION_TARGET_ACCOUNT_V1 = TARGET_ACCOUNT;

function account(address, isSigner, isWritable) {
  return { address, is_signer: isSigner, is_writable: isWritable, source: 'static' };
}

function tokenRow(accounts, address, mint, owner, rawAmount) {
  return {
    account_index: accounts.findIndex(item => item.address === address),
    account: address,
    mint,
    owner,
    raw_amount: rawAmount,
    decimals: 6,
    token_program: TOKEN_PROGRAM,
  };
}

function buildLeg({
  signature, slot, blockTime, accounts, preLamports, postLamports,
  preAmounts, postAmounts, tickArrays, swapData, transfers,
}) {
  const tokenRows = amounts => [
    tokenRow(accounts, QUOTE_ACCOUNT, CONTROLLED_MAINNET_CALIBRATION_QUOTE_MINT_V1,
      CONTROLLED_MAINNET_CALIBRATION_WALLET_V1, amounts.quoteWallet),
    tokenRow(accounts, TARGET_ACCOUNT, CONTROLLED_MAINNET_CALIBRATION_TARGET_MINT_V1,
      CONTROLLED_MAINNET_CALIBRATION_WALLET_V1, amounts.targetWallet),
    tokenRow(accounts, TARGET_VAULT, CONTROLLED_MAINNET_CALIBRATION_TARGET_MINT_V1,
      POOL, amounts.targetVault),
    tokenRow(accounts, QUOTE_VAULT, CONTROLLED_MAINNET_CALIBRATION_QUOTE_MINT_V1,
      POOL, amounts.quoteVault),
  ].sort((left, right) => left.account_index - right.account_index);
  return {
    full_transaction_version: 'solana_full_transaction_v1',
    signature,
    slot,
    block_time: blockTime,
    execution_state: 'succeeded',
    transaction_version: 'legacy',
    fee_payer: CONTROLLED_MAINNET_CALIBRATION_WALLET_V1,
    fee_lamports: 5000,
    accounts,
    pre_lamport_balances: preLamports,
    post_lamport_balances: postLamports,
    pre_token_balances: tokenRows(preAmounts),
    post_token_balances: tokenRows(postAmounts),
    instructions: [{
      instruction_index: 0,
      program_id: WHIRLPOOL_PROGRAM,
      accounts: [
        TOKEN_PROGRAM,
        CONTROLLED_MAINNET_CALIBRATION_WALLET_V1,
        POOL,
        TARGET_ACCOUNT,
        TARGET_VAULT,
        QUOTE_ACCOUNT,
        QUOTE_VAULT,
        ...tickArrays,
        ORACLE,
      ],
      data: swapData,
    }],
    inner_instruction_groups: [{
      outer_instruction_index: 0,
      instructions: transfers.map((transfer, instructionIndex) => ({
        instruction_index: instructionIndex,
        program_id: TOKEN_PROGRAM,
        accounts: transfer.accounts,
        data: transfer.data,
      })),
    }],
  };
}

const ACQUISITION = buildLeg({
  signature: '349mg3Ai6ebgnbnZw4Yz3LafU9qn2y4wgdoroA8pUui2hsJvQyAErkm2dXroWTgtDdwNYbTXZeRK6XBd6ksy7KjC',
  slot: 444007016,
  blockTime: 1788449783,
  accounts: [
    account(CONTROLLED_MAINNET_CALIBRATION_WALLET_V1, true, true),
    account('3ABHfLYYQrR96FYYZ3P576GY4Nqg9D5LHZ2hC8fq7PQC', false, true),
    account('4n7Wn5uEcsA2PmFtTAvL1fEfn6xFJkK8WXhnkRGTjSqh', false, true),
    account(POOL, false, true), account(QUOTE_ACCOUNT, false, true),
    account(TARGET_ACCOUNT, false, true), account(TARGET_VAULT, false, true),
    account(QUOTE_VAULT, false, true),
    account('FfL7e3b6WRhfNCEgCdR5JkZ8PmGsdaQQVnWUi7WGrXK2', false, true),
    account(ORACLE, false, false), account(TOKEN_PROGRAM, false, false),
    account(WHIRLPOOL_PROGRAM, false, false),
  ],
  preLamports: [900880, 70407360, 70407360, 7754035, 2039280, 2039280, 2039484, 2039490, 70407360, 0, 198796820, 30850581],
  postLamports: [895880, 70407360, 70407360, 7754035, 2039280, 2039280, 2039484, 2039490, 70407360, 0, 198796820, 30850581],
  preAmounts: { quoteWallet: '6000000', targetWallet: '0', targetVault: '77215754038', quoteVault: '7075089856' },
  postAmounts: { quoteWallet: '1000000', targetWallet: '21437310', targetVault: '77194316728', quoteVault: '7080089856' },
  tickArrays: [
    '3ABHfLYYQrR96FYYZ3P576GY4Nqg9D5LHZ2hC8fq7PQC',
    'FfL7e3b6WRhfNCEgCdR5JkZ8PmGsdaQQVnWUi7WGrXK2',
    '4n7Wn5uEcsA2PmFtTAvL1fEfn6xFJkK8WXhnkRGTjSqh',
  ],
  swapData: '59p8WydnSZtTGLkUFA6QDBZSAEdw3AnS3p59d4ymHwB5D9ZKWaqXxrfZWF',
  transfers: [
    { accounts: [QUOTE_ACCOUNT, QUOTE_VAULT, CONTROLLED_MAINNET_CALIBRATION_WALLET_V1], data: '3QDJ9TwUE2Dm' },
    { accounts: [TARGET_VAULT, TARGET_ACCOUNT, POOL], data: '3aYxJmutJ6wy' },
  ],
});

const DISPOSAL = buildLeg({
  signature: '4RACBYjo8GHXZthkgTmjoFHvzYvdqqZfwnRSdbZ5P2xYEmcNfBcHZQGRJLCzv2qzWKfSXAM7MidTwG3ik3mbrpYP',
  slot: 444223882,
  blockTime: 1788518189,
  accounts: [
    account(CONTROLLED_MAINNET_CALIBRATION_WALLET_V1, true, true), account(POOL, false, true),
    account(QUOTE_ACCOUNT, false, true), account(TARGET_ACCOUNT, false, true),
    account(TARGET_VAULT, false, true),
    account('BsuCWs4GMcm3fxRMRv41FirTjQiw51gSGUxj3xyjmGxz', false, true),
    account(QUOTE_VAULT, false, true),
    account('DPsfz7adDDEW1kAtKAwECTc4Qm4V5KvpasXwi2rWjq2E', false, true),
    account('HNmWttDCV6TgyCpTaMSLzJToifa75Fu64uxewKexeEAM', false, true),
    account(ORACLE, false, false), account(TOKEN_PROGRAM, false, false),
    account(WHIRLPOOL_PROGRAM, false, false),
  ],
  preLamports: [895880, 7754035, 2039280, 2039280, 2039484, 70407360, 2039490, 70407360, 70407360, 0, 198796820, 30850581],
  postLamports: [890880, 7754035, 2039280, 2039280, 2039484, 70407360, 2039490, 70407360, 70407360, 0, 198796820, 30850581],
  preAmounts: { quoteWallet: '1000000', targetWallet: '21437310', targetVault: '79995418173', quoteVault: '6440019496' },
  postAmounts: { quoteWallet: '5748794', targetWallet: '0', targetVault: '80016855483', quoteVault: '6435270702' },
  tickArrays: [
    'HNmWttDCV6TgyCpTaMSLzJToifa75Fu64uxewKexeEAM',
    'BsuCWs4GMcm3fxRMRv41FirTjQiw51gSGUxj3xyjmGxz',
    'DPsfz7adDDEW1kAtKAwECTc4Qm4V5KvpasXwi2rWjq2E',
  ],
  swapData: '59p8WydnSZtUfPTJkoYPsvxhQVZ6L1dMyKx4xbxUopPKvHkrHjbbXDZxKr',
  transfers: [
    { accounts: [TARGET_ACCOUNT, TARGET_VAULT, CONTROLLED_MAINNET_CALIBRATION_WALLET_V1], data: '3aYxJmutJ6wy' },
    { accounts: [QUOTE_VAULT, QUOTE_ACCOUNT, POOL], data: '3wMKYF7EMeK9' },
  ],
});

export function controlledMainnetCalibrationTransactionsV1() {
  return structuredClone([ACQUISITION, DISPOSAL]);
}

function targetAccountData() {
  const data = Buffer.alloc(165);
  new PublicKey(CONTROLLED_MAINNET_CALIBRATION_TARGET_MINT_V1).toBuffer().copy(data, 0);
  new PublicKey(CONTROLLED_MAINNET_CALIBRATION_WALLET_V1).toBuffer().copy(data, 32);
  data[108] = 1;
  return data;
}

async function enumerationPort(boundaryKind, slot) {
  const data = targetAccountData();
  return createFrozenControlledHeliusTargetAccountEnumerationPortV2({
    wallet: CONTROLLED_MAINNET_CALIBRATION_WALLET_V1,
    target_mint: CONTROLLED_MAINNET_CALIBRATION_TARGET_MINT_V1,
    boundary_kind: boundaryKind,
    minimum_context_slot: slot,
  }, {
    clock: () => 0,
    sleep: async () => {},
    async request({ body }) {
      const rows = body.params[1].programId === TOKEN_PROGRAM ? [{
        pubkey: TARGET_ACCOUNT,
        account: {
          data: [data.toString('base64'), 'base64'], executable: false, lamports: 2_039_280,
          owner: TOKEN_PROGRAM, rentEpoch: 0, space: data.length,
        },
      }] : [];
      return {
        status: 200,
        data: { jsonrpc: '2.0', id: body.id, result: { context: { slot }, value: rows } },
        raw_body_sha256: boundaryKind === 'OPENING' ? 'b'.repeat(64) : 'c'.repeat(64),
      };
    },
  });
}

function acquisitionRequest() {
  return {
    request_version: 'wallet_wide_acquisition_request_v2',
    chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    wallet: CONTROLLED_MAINNET_CALIBRATION_WALLET_V1,
    window: {
      window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1',
      requested_lookback_seconds: 2_592_000, initial_before_signature: null,
    },
    finality: { commitment: 'finalized', boundary_profile: 'solana_finalized_anchor_v1', max_anchor_search_slots: 32 },
    budgets: {
      pagination_profile: 'solana_full_transaction_page_100_v1', page_size: 100, max_pages: 100,
      max_transactions: 10_000, retry_profile: 'bounded_exponential_retry_v1', max_attempts_per_operation: 8,
      timeout_profile: 'bounded_provider_timeout_v1', request_timeout_ms: 60_000, overall_timeout_ms: 300_000,
      exact_fallback_profile: 'finalized_get_transaction_missing_only_v1', max_exact_fallback_transactions: 0,
    },
    profiles: {
      wallet_acquisition_profile: 'wallet_wide_bounded_history_v1',
      wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1',
    },
  };
}

async function acquireCalibration(transactions) {
  const descending = [...transactions].reverse();
  const sources = descending.map(({ signature, slot, block_time, execution_state }) => ({
    signature, slot, block_time, execution_state,
  }));
  const rawPort = {
    async getNetworkIdentityV1() { return { chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH }; },
    async getFinalizedSlotV1() { return 444223891; },
    async getFinalizedBlockV1({ slot }) {
      return { slot, block_time: 1788518190, blockhash: '11111111111111111111111111111111', commitment: 'finalized' };
    },
    async getFinalizedWalletSignaturePageV1() { return structuredClone(sources); },
    async getFinalizedFullTransactionPageV1() {
      return { transactions: structuredClone(descending), pagination_token: null };
    },
    async getFinalizedTransactionV1() { throw new TypeError('calibration fixture forbids fallback'); },
  };
  return acquireWalletHistoryV2(acquisitionRequest(), {
    walletHistoryPort: createWalletHistoryPortV2(rawPort, { beginAcquisitionV2() {} }),
  });
}

export async function createControlledMainnetCalibrationAuthorityV1(options = {}) {
  const transactions = controlledMainnetCalibrationTransactionsV1();
  if (typeof options.mutate_transactions === 'function') options.mutate_transactions(transactions);
  const descending = [...transactions].reverse();
  const legacyAcquisitionResult = await acquireCalibration(transactions);
  const transcriptPort = createEvidenceContextTranscriptPortV1({
    async getAuthoritativeTransactionTranscriptV1() {
      return {
        authoritative_population: descending.map(({ signature, slot, block_time, execution_state }) => ({
          signature, slot, block_time, execution_state,
        })),
        full_transactions: structuredClone(descending),
      };
    },
  });
  const contextAuthority = {
    transaction_transcript_port: transcriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
    opening_enumeration_port: await enumerationPort('OPENING', 444006969),
    ending_enumeration_port: await enumerationPort('ENDING_AS_OF', 444223890),
    target_mint: CONTROLLED_MAINNET_CALIBRATION_TARGET_MINT_V1,
    opening_basis_reference: null,
  };
  const context = await buildSourceBoundAuthoritativeEvidenceContextV13(contextAuthority);
  return {
    archive_sha256: CONTROLLED_MAINNET_CALIBRATION_ARCHIVE_SHA256_V1,
    context,
    context_authority: contextAuthority,
    exact_quote_mint: CONTROLLED_MAINNET_CALIBRATION_QUOTE_MINT_V1,
  };
}
