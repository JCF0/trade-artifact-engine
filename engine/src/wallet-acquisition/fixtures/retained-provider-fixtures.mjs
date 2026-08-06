import { readFileSync } from 'node:fs';

import { projectHeliusEnhancedTransactionV1 } from '../helius-enhanced-projector.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from '../request-contract.mjs';
import { providerPublicKey, providerSignature } from './slice4-fixtures.mjs';

const retainedFixtureUrl = new URL('../../acquisition/fixtures/retained-helius-real-shapes.json', import.meta.url);
const retainedFixture = JSON.parse(readFileSync(retainedFixtureUrl, 'utf8'));

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const EXACT_RETAINED_HELIUS_BODIES_V1 = deepFreeze(retainedFixture.transactions);
export const JUP_WALLET_V1 = '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni';
export const RAY_WALLET_V1 = '5fK3484fbh8gnmhvTsPYxTC6un7Co5LVUSoubZPVL3YA';
export const JUP_MINT_V1 = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const RAY_MINT_V1 = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
export const USDC_MINT_V1 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT_V1 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const JUPITER_PROGRAM_V1 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const BLOCKHASH = '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh';

function raw(tokenAmount, decimals = 6) {
  return { tokenAmount: String(tokenAmount), decimals };
}

export function syntheticEnhancedBodyV1({
  label,
  wallet,
  slot,
  timestamp,
  type = 'SWAP',
  inputMint = USDC_MINT_V1,
  inputRaw = '10000000',
  outputMint = JUP_MINT_V1,
  outputRaw = '5000000',
  failed = false,
  recognizedProgram = true,
  selfTransfer = false,
  omitSelfTransferMint = false,
} = {}) {
  const signature = providerSignature(`synthetic-${label}`);
  const body = {
    description: `Synthetic offline integration transaction ${label}`,
    type,
    source: 'SYNTHETIC_TEST_PROVIDER',
    fee: 5000,
    feePayer: wallet,
    signature,
    slot,
    timestamp,
    tokenTransfers: [],
    nativeTransfers: [],
    accountData: [{ account: wallet, nativeBalanceChange: -5000, tokenBalanceChanges: [] }],
    transactionError: failed ? { InstructionError: [1, 'SyntheticFailure'] } : null,
    instructions: recognizedProgram ? [{ programId: JUPITER_PROGRAM_V1, innerInstructions: [] }] : [],
    events: type === 'SWAP' ? {
      swap: {
        tokenInputs: [{ userAccount: wallet, mint: inputMint, rawTokenAmount: raw(inputRaw) }],
        tokenOutputs: [{ userAccount: wallet, mint: outputMint, rawTokenAmount: raw(outputRaw) }],
        nativeInput: null,
        nativeOutput: null,
      },
    } : {},
  };
  if (selfTransfer) {
    body.tokenTransfers = [{
      fromUserAccount: wallet,
      toUserAccount: wallet,
      ...(omitSelfTransferMint ? {} : { mint: outputMint }),
      rawTokenAmount: raw(outputRaw),
    }];
  } else {
    body.tokenTransfers = [
      { fromUserAccount: wallet, toUserAccount: providerPublicKey(`${label}-pool-in`), mint: inputMint, rawTokenAmount: raw(inputRaw) },
      { fromUserAccount: providerPublicKey(`${label}-pool-out`), toUserAccount: wallet, mint: outputMint, rawTokenAmount: raw(outputRaw) },
    ];
  }
  return body;
}

export function syntheticTransferBodyV1({
  label,
  wallet,
  slot,
  timestamp,
  inputMint,
  inputRaw = '1000000',
  outputMint,
  outputRaw = '1000000',
  failed = false,
} = {}) {
  return syntheticEnhancedBodyV1({
    label,
    wallet,
    slot,
    timestamp,
    type: 'TRANSFER',
    inputMint,
    inputRaw,
    outputMint,
    outputRaw,
    failed,
    recognizedProgram: false,
  });
}

function canonicalSource(body) {
  return {
    signature: body.signature,
    slot: body.slot,
    block_time: body.timestamp,
    execution_state: body.transactionError === null ? 'succeeded' : 'failed',
  };
}

function requestFor(wallet) {
  return {
    request_version: 'wallet_wide_acquisition_request_v1',
    chain: 'solana',
    network: 'mainnet-beta',
    genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    wallet,
    window: {
      window_version: 'fixed_lookback_latest_state_v1',
      lookback_profile: 'lookback_30d_v1',
      requested_lookback_seconds: 2592000,
      initial_before_signature: null,
    },
    finality: {
      commitment: 'finalized',
      boundary_profile: 'solana_finalized_anchor_v1',
      max_anchor_search_slots: 32,
    },
    budgets: {
      pagination_profile: 'helius_wallet_history_page_100_v1',
      page_size: 100,
      max_pages: 100,
      max_transactions: 10000,
      retry_profile: 'bounded_exponential_retry_v1',
      max_attempts_per_operation: 8,
      timeout_profile: 'bounded_provider_timeout_v1',
      request_timeout_ms: 60000,
      overall_timeout_ms: 300000,
    },
    profiles: {
      wallet_acquisition_profile: 'wallet_wide_bounded_history_v1',
      wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1',
    },
  };
}

function pagesFor(sources, anchorSlot, anchorTime, layout) {
  if (layout === 'short') return { initial: [sources], recheck: [sources] };
  if (layout !== 'synthetic_full_prefix') throw new TypeError('unknown synthetic page layout');
  const fillers = Array.from({ length: 99 }, (_, index) => ({
    signature: providerSignature(`synthetic-pagination-filler-${index}`),
    slot: anchorSlot + 100 - index,
    block_time: anchorTime + 100 - index,
    execution_state: 'succeeded',
  }));
  return {
    initial: [[...fillers, sources[0]], sources.slice(1)],
    recheck: [[...fillers, sources[0]]],
  };
}

export function offlineWalletHistoryFixtureV1({
  wallet,
  retainedBodyNames = [],
  syntheticBodies = [],
  enhancedOrder = 'canonical',
  pageLayout = 'short',
} = {}) {
  const exactRetainedBodies = retainedBodyNames.map(name => {
    if (!Object.hasOwn(EXACT_RETAINED_HELIUS_BODIES_V1, name)) throw new TypeError(`unknown retained body: ${name}`);
    return EXACT_RETAINED_HELIUS_BODIES_V1[name];
  });
  const bodies = [...exactRetainedBodies, ...syntheticBodies];
  const sources = bodies.map(canonicalSource).sort((left, right) => right.slot - left.slot || right.block_time - left.block_time || (left.signature < right.signature ? -1 : 1));
  const anchorSlot = Math.max(...sources.map(source => source.slot)) + 1;
  const anchorTime = Math.max(...sources.map(source => source.block_time)) + 1;
  const pages = pagesFor(sources, anchorSlot, anchorTime, pageLayout);
  const enriched = bodies.map(transaction => projectHeliusEnhancedTransactionV1({ wallet, transaction }));
  if (enhancedOrder === 'reversed') enriched.reverse();
  else if (enhancedOrder !== 'canonical') throw new TypeError('unknown Enhanced response order');
  let pageCall = 0;
  const observed = { enhanced_calls: 0, requested_signatures: null };
  const port = {
    async getNetworkIdentityV1() {
      return { chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH };
    },
    async getFinalizedSlotV1() { return anchorSlot; },
    async getFinalizedBlockV1({ slot }) {
      return { slot, block_time: anchorTime, blockhash: BLOCKHASH, commitment: 'finalized' };
    },
    async getFinalizedWalletSignaturePageV1() {
      const queue = pageCall < pages.initial.length ? pages.initial : pages.recheck;
      const index = pageCall < pages.initial.length ? pageCall : pageCall - pages.initial.length;
      pageCall += 1;
      return structuredClone(queue[Math.min(index, queue.length - 1)] ?? []);
    },
    async getEnhancedTransactionsBySignatureV1({ signatures }) {
      observed.enhanced_calls += 1;
      observed.requested_signatures = structuredClone(signatures);
      return structuredClone(enriched);
    },
  };
  return {
    request: requestFor(wallet),
    port,
    observed,
    exactRetainedBodies,
    syntheticBodies,
    syntheticPageFillersUsed: pageLayout === 'synthetic_full_prefix' ? 99 : 0,
    evidenceFidelity: Object.freeze({
      enhancedBodies: retainedBodyNames.length === 0
        ? 'clearly_synthetic_enhanced_bodies'
        : retainedBodyNames.length === bodies.length
          ? 'exact_retained_helius_enhanced_bodies'
          : 'exact_retained_plus_clearly_synthetic_enhanced_bodies',
      finalizedRpcEnvelopes: 'synthetic_finalized_rpc_envelopes',
      canonicalSignaturePages: 'synthetic_canonical_signature_pages',
      paginationFillers: pageLayout === 'synthetic_full_prefix'
        ? 'synthetic_post_anchor_unrelated_fillers'
        : 'none',
    }),
  };
}
