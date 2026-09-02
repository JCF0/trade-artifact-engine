import { PublicKey } from '@solana/web3.js';

import { acquireWalletHistoryV2 } from '../../wallet-acquisition/orchestrator.mjs';
import { createWalletHistoryPortV2 } from '../../wallet-acquisition/provider-port-v2.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from '../../wallet-acquisition/request-contract.mjs';
import { createEvidenceContextTranscriptPortV1 } from '../../wallet-acquisition/evidence-context-sidecar-v1.mjs';
import { createFrozenControlledHeliusTargetAccountEnumerationPortV2 } from '../../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import { providerPublicKey, providerSignature } from '../../wallet-acquisition/fixtures/test-identities.mjs';
import { buildSourceBoundAuthoritativeEvidenceContextV13 } from '../authoritative-evidence-context.mjs';
import { sha256CanonicalJson } from '../contract.mjs';
import { createPositionEconomicEvidencePortV13 } from '../position-episode.mjs';
import { projectSolanaFullTransactionEffectV13 } from '../solana-full-transaction-effect-projector.mjs';

export const CONTROLLED_CASE_FIXTURE_VERSION_V1 = 'artifact_verification_scope_v1_3_controlled_case_fixture_v1';
export const CLASSIC_TOKEN_PROGRAM_V1 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_V1 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const USDC_MINT_V1 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const CONTROLLED_WALLET_V1 = providerPublicKey('v13-slice8-controlled-wallet');
export const CONTROLLED_TARGET_MINT_V1 = providerPublicKey('v13-slice8-classic-target-mint');
export const CONTROLLED_TARGET_ACCOUNT_V1 = providerPublicKey('v13-slice8-target-ata');
export const CONTROLLED_QUOTE_ACCOUNT_V1 = providerPublicKey('v13-slice8-usdc-account');
export const JUPITER_V6_PROGRAM_V1 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const RAYDIUM_AMM_V4_PROGRAM_V1 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

const OPENING_SLOT = 10_000;
const ACQUISITION_SLOT = 10_010;
const DISPOSAL_SLOT = 10_020;
const ENDING_SLOT = 10_030;
const ANCHOR_SLOT = 10_031;
const BASE_TIME = 1_780_000_000;
const BLOCKHASH = providerPublicKey('v13-slice8-finalized-blockhash');
const TARGET_DECIMALS = 6;
const FEE_LAMPORTS = 5_000;

function u32(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; }
function u64(value) { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; }
function tokenAccountData(rawAmount) {
  const out = Buffer.alloc(165);
  new PublicKey(CONTROLLED_TARGET_MINT_V1).toBuffer().copy(out, 0);
  new PublicKey(CONTROLLED_WALLET_V1).toBuffer().copy(out, 32);
  u64(rawAmount).copy(out, 64);
  u32(0).copy(out, 72);
  out[108] = 1;
  u32(0).copy(out, 109);
  u64(0).copy(out, 121);
  u32(0).copy(out, 129);
  return out;
}
function ownerRow(rawAmount = '0') {
  const data = tokenAccountData(rawAmount);
  return {
    pubkey: CONTROLLED_TARGET_ACCOUNT_V1,
    account: {
      data: [data.toString('base64'), 'base64'], executable: false, lamports: 2_039_280,
      owner: CLASSIC_TOKEN_PROGRAM_V1, rentEpoch: 0, space: data.length,
    },
  };
}
function rpc(id, slot, rows) {
  return { jsonrpc: '2.0', id, result: { context: { slot }, value: rows } };
}
async function enumerationPort(boundaryKind, slot, options = {}) {
  const { classicRows = [ownerRow('0')], token2022Rows = [], observe = null } = options;
  return createFrozenControlledHeliusTargetAccountEnumerationPortV2({
    wallet: CONTROLLED_WALLET_V1,
    target_mint: CONTROLLED_TARGET_MINT_V1,
    boundary_kind: boundaryKind,
    minimum_context_slot: slot,
  }, {
    clock: () => 0,
    sleep: async () => {},
    async request({ body }) {
      if (observe !== null) observe(structuredClone(body));
      const rows = body.params[1].programId === CLASSIC_TOKEN_PROGRAM_V1 ? classicRows : token2022Rows;
      return { status: 200, data: rpc(body.id, slot, structuredClone(rows)), raw_body_sha256: 'a'.repeat(64) };
    },
  });
}

function account(address, { signer = false, writable = false, source = 'static' } = {}) {
  return { address, is_signer: signer, is_writable: writable, source };
}
function tokenRow(accountIndex, address, mint, rawAmount) {
  return {
    account_index: accountIndex,
    account: address,
    mint,
    owner: CONTROLLED_WALLET_V1,
    raw_amount: rawAmount,
    decimals: TARGET_DECIMALS,
    token_program: CLASSIC_TOKEN_PROGRAM_V1,
  };
}
function controlledTransaction({ label, slot, blockTime, quotePre, quotePost, targetPre, targetPost, realisticRoute = false }) {
  const accounts = [
    account(CONTROLLED_WALLET_V1, { signer: true, writable: true }),
    account(JUPITER_V6_PROGRAM_V1),
    account(CLASSIC_TOKEN_PROGRAM_V1),
    ...(realisticRoute ? [account(RAYDIUM_AMM_V4_PROGRAM_V1)] : []),
    account(CONTROLLED_QUOTE_ACCOUNT_V1, { writable: true, source: 'lookup_writable' }),
    account(CONTROLLED_TARGET_ACCOUNT_V1, { writable: true, source: 'lookup_writable' }),
  ];
  const quoteAccountIndex = realisticRoute ? 4 : 3;
  const targetAccountIndex = realisticRoute ? 5 : 4;
  const preLamports = [1_000_000_000, 0, 0, ...(realisticRoute ? [0] : []), 2_039_280, 2_039_280];
  const postLamports = [1_000_000_000 - FEE_LAMPORTS, 0, 0, ...(realisticRoute ? [0] : []), 2_039_280, 2_039_280];
  return {
    full_transaction_version: 'solana_full_transaction_v1',
    signature: providerSignature(`v13-slice8-${label}`),
    slot,
    block_time: blockTime,
    execution_state: 'succeeded',
    transaction_version: 0,
    fee_payer: CONTROLLED_WALLET_V1,
    fee_lamports: FEE_LAMPORTS,
    accounts,
    pre_lamport_balances: preLamports,
    post_lamport_balances: postLamports,
    pre_token_balances: [
      tokenRow(quoteAccountIndex, CONTROLLED_QUOTE_ACCOUNT_V1, USDC_MINT_V1, quotePre),
      tokenRow(targetAccountIndex, CONTROLLED_TARGET_ACCOUNT_V1, CONTROLLED_TARGET_MINT_V1, targetPre),
    ],
    post_token_balances: [
      tokenRow(quoteAccountIndex, CONTROLLED_QUOTE_ACCOUNT_V1, USDC_MINT_V1, quotePost),
      tokenRow(targetAccountIndex, CONTROLLED_TARGET_ACCOUNT_V1, CONTROLLED_TARGET_MINT_V1, targetPost),
    ],
    instructions: [{
      instruction_index: 0,
      program_id: JUPITER_V6_PROGRAM_V1,
      accounts: realisticRoute ? [CONTROLLED_WALLET_V1, CONTROLLED_QUOTE_ACCOUNT_V1, CONTROLLED_TARGET_ACCOUNT_V1] : [],
      data: realisticRoute ? '3Bxs4' : '',
    }],
    inner_instruction_groups: realisticRoute ? [{
      outer_instruction_index: 0,
      instructions: [
        {
          instruction_index: 0,
          program_id: RAYDIUM_AMM_V4_PROGRAM_V1,
          accounts: [CONTROLLED_QUOTE_ACCOUNT_V1, CONTROLLED_TARGET_ACCOUNT_V1, CONTROLLED_WALLET_V1],
          data: '3Bxs4',
        },
        {
          instruction_index: 1,
          program_id: RAYDIUM_AMM_V4_PROGRAM_V1,
          accounts: [CONTROLLED_TARGET_ACCOUNT_V1, CONTROLLED_QUOTE_ACCOUNT_V1, CONTROLLED_WALLET_V1],
          data: '3Bxs4',
        },
      ],
    }] : [],
  };
}

export function controlledFullTransactionsV1({ realisticRoute = false } = {}) {
  const acquisition = controlledTransaction({
    label: realisticRoute ? 'realistic-acquisition' : 'acquisition',
    slot: ACQUISITION_SLOT,
    blockTime: BASE_TIME + 10,
    quotePre: '100000000', quotePost: '75000000',
    targetPre: '0', targetPost: '100000000',
    realisticRoute,
  });
  const disposal = controlledTransaction({
    label: realisticRoute ? 'realistic-disposal' : 'disposal',
    slot: DISPOSAL_SLOT,
    blockTime: BASE_TIME + 20,
    quotePre: '75000000', quotePost: '107500000',
    targetPre: '100000000', targetPost: '0',
    realisticRoute,
  });
  return [disposal, acquisition];
}

function acquisitionRequest() {
  return {
    request_version: 'wallet_wide_acquisition_request_v2',
    chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    wallet: CONTROLLED_WALLET_V1,
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
async function acquisition(transactions) {
  const sources = transactions.map(({ signature, slot, block_time, execution_state }) => ({
    signature, slot, block_time, execution_state,
  }));
  const rawPort = {
    async getNetworkIdentityV1() { return { chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH }; },
    async getFinalizedSlotV1() { return ANCHOR_SLOT; },
    async getFinalizedBlockV1({ slot }) {
      return { slot, block_time: BASE_TIME + 31, blockhash: BLOCKHASH, commitment: 'finalized' };
    },
    async getFinalizedWalletSignaturePageV1() { return structuredClone(sources); },
    async getFinalizedFullTransactionPageV1() { return { transactions: structuredClone(transactions), pagination_token: null }; },
    async getFinalizedTransactionV1() { throw new TypeError('controlled case does not permit fallback'); },
  };
  return acquireWalletHistoryV2(acquisitionRequest(), {
    walletHistoryPort: createWalletHistoryPortV2(rawPort, { beginAcquisitionV2() {} }),
  });
}

function allEffectIds(effects) {
  return [...effects.values()].flatMap(effect => [
    ...effect.established_effects.map(item => item.effect_id),
    ...effect.residual_unresolved_effects.map(item => item.residual_id),
  ]).sort();
}
function eventFor(effect, coordinate, eventKind, targetQuantity, quoteAmount) {
  const sourceEffectIds = effect.established_effects
    .filter(item => item.effect_kind === 'token_balance_observation'
      && [CONTROLLED_TARGET_MINT_V1, USDC_MINT_V1].includes(item.mint))
    .map(item => item.effect_id).sort();
  return {
    transaction_signature: effect.transaction_identity.signature,
    authoritative_intra_transaction_coordinate: coordinate,
    event_kind: eventKind,
    payload: {
      target_raw_quantity: targetQuantity,
      quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: quoteAmount,
    },
    source_effect_ids: sourceEffectIds,
    corroborating_effect_ids: [],
    dependency_references: [],
  };
}
function economicEvidence(context, effects, sourceEvents) {
  const roles = new Map();
  for (const event of sourceEvents) {
    const locator = {
      transaction_signature: event.transaction_signature,
      authoritative_intra_transaction_coordinate: event.authoritative_intra_transaction_coordinate,
      event_kind: event.event_kind,
    };
    for (const effectId of event.source_effect_ids) {
      roles.set(effectId, { disposition: 'PRIMARY', event_locator: locator, reason_code: null });
    }
  }
  const evidence = {
    economic_evidence_profile: 'ARTIFACT_AUTHORITATIVE_POSITION_ECONOMIC_EFFECTS_V1',
    evidence_context_digest: context.evidence_context_digest,
    exact_quote_mint: USDC_MINT_V1,
    opening_basis_evidence: null,
    source_events: sourceEvents,
    effect_dispositions: allEffectIds(effects).map(effectId => ({
      effect_id: effectId,
      ...(roles.get(effectId) ?? {
        disposition: 'NON_ECONOMIC', event_locator: null, reason_code: 'NO_POSITION_ECONOMIC_EFFECT',
      }),
    })),
    economic_evidence_digest: null,
  };
  evidence.economic_evidence_digest = sha256CanonicalJson(Object.fromEntries(
    Object.entries(evidence).filter(([field]) => field !== 'economic_evidence_digest'),
  ));
  return evidence;
}

export async function createControlledCaseAuthorityV1(options = {}) {
  const transactions = controlledFullTransactionsV1({ realisticRoute: options.realisticRoute === true });
  if (typeof options.mutate_transactions === 'function') options.mutate_transactions(transactions);
  const legacyAcquisitionResult = await acquisition(transactions);
  const transcriptTransactions = structuredClone(transactions);
  if (typeof options.mutate_transcript_transactions === 'function') {
    options.mutate_transcript_transactions(transcriptTransactions);
  }
  let transcriptCaptureCount = 0;
  const transcriptPort = createEvidenceContextTranscriptPortV1({
    async getAuthoritativeTransactionTranscriptV1() {
      transcriptCaptureCount += 1;
      const capture = structuredClone(transcriptTransactions);
      if (typeof options.mutate_transcript_capture === 'function' && transcriptCaptureCount > 1) {
        options.mutate_transcript_capture(capture, transcriptCaptureCount);
      }
      return {
        authoritative_population: capture.map(({ signature, slot, block_time, execution_state }) => ({
          signature, slot, block_time, execution_state,
        })),
        full_transactions: capture,
      };
    },
  });
  const enumerationRequests = [];
  const openingPort = await enumerationPort('OPENING', OPENING_SLOT, { observe: body => enumerationRequests.push(body) });
  const endingPort = await enumerationPort('ENDING_AS_OF', ENDING_SLOT, { observe: body => enumerationRequests.push(body) });
  const contextAuthority = {
    transaction_transcript_port: transcriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
    opening_enumeration_port: openingPort,
    ending_enumeration_port: endingPort,
    target_mint: CONTROLLED_TARGET_MINT_V1,
    opening_basis_reference: null,
  };
  const context = await buildSourceBoundAuthoritativeEvidenceContextV13(contextAuthority);
  const effects = new Map(context.transaction_population.transactions.map(row => [
    row.canonical_transaction_coordinate,
    projectSolanaFullTransactionEffectV13({ wallet: CONTROLLED_WALLET_V1, transaction: row.full_transaction }),
  ]));
  const sourceEvents = [
    eventFor(effects.get(0), 0, 'TARGET_ACQUISITION', '100000000', '25000000'),
    eventFor(effects.get(1), 0, 'TARGET_DISPOSAL', '100000000', '32500000'),
  ];
  const evidence = economicEvidence(context, effects, sourceEvents);
  if (typeof options.mutate_economic_evidence === 'function') {
    options.mutate_economic_evidence(evidence, effects);
    evidence.economic_evidence_digest = sha256CanonicalJson(Object.fromEntries(
      Object.entries(evidence).filter(([field]) => field !== 'economic_evidence_digest'),
    ));
  }
  const economicEvidencePort = createPositionEconomicEvidencePortV13({
    async captureAuthoritativePositionEconomicsV13() { return structuredClone(evidence); },
  });
  return {
    fixture_manifest: {
      fixture_version: CONTROLLED_CASE_FIXTURE_VERSION_V1,
      wallet: CONTROLLED_WALLET_V1,
      target_mint: CONTROLLED_TARGET_MINT_V1,
      target_account: CONTROLLED_TARGET_ACCOUNT_V1,
      quote_mint: USDC_MINT_V1,
      opening_slot: OPENING_SLOT,
      ending_slot: ENDING_SLOT,
      transaction_signatures: transactions.map(item => item.signature).sort(),
    },
    enumeration_requests: enumerationRequests,
    context,
    context_authority: contextAuthority,
    effects,
    economic_evidence: evidence,
    economic_evidence_port: economicEvidencePort,
    exact_quote_mint: USDC_MINT_V1,
  };
}
