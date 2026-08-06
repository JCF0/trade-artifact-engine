import { SOLANA_MAINNET_GENESIS_HASH } from '../request-contract.mjs';
import { projectHeliusEnhancedTransactionV1 } from '../helius-enhanced-projector.mjs';
import { JUP, PROGRAMS, RAY, USDC, USDT } from './spot-normalizer-fixtures.mjs';
import { providerPublicKey, providerSignature } from './test-identities.mjs';

export { JUP, PROGRAMS, RAY, USDC, USDT };
export { providerPublicKey, providerSignature } from './test-identities.mjs';
export const WALLET = '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni';
export const ANCHOR_SLOT = 1000;
export const ANCHOR_TIME = 1_780_604_800;
export const BLOCKHASH = '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh';


export function request(overrides = {}) {
  const value = {
    request_version: 'wallet_wide_acquisition_request_v1',
    chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH, wallet: WALLET,
    window: { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_7d_v1', requested_lookback_seconds: 604800, initial_before_signature: null },
    finality: { commitment: 'finalized', boundary_profile: 'solana_finalized_anchor_v1', max_anchor_search_slots: 32 },
    budgets: { pagination_profile: 'helius_wallet_history_page_100_v1', page_size: 100, max_pages: 100, max_transactions: 10000, retry_profile: 'bounded_exponential_retry_v1', max_attempts_per_operation: 8, timeout_profile: 'bounded_provider_timeout_v1', request_timeout_ms: 60000, overall_timeout_ms: 300000 },
    profiles: { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1' },
  };
  return { ...value, ...overrides };
}

export function canonical(signature, slot, block_time, execution_state = 'succeeded') {
  return { signature: providerSignature(signature), slot, block_time, execution_state };
}

function raw(tokenAmount, decimals = 6) { return { tokenAmount: String(tokenAmount), decimals }; }
export function enhanced(signature, {
  slot = ANCHOR_SLOT, timestamp = ANCHOR_TIME, type = 'SWAP', program = PROGRAMS.jupiter,
  inputMint = USDC, inputRaw = '25000000', outputMint = JUP, outputRaw = '100000000',
  failed = false, transfers = true, unresolved = false,
} = {}) {
  const body = {
    signature: providerSignature(signature), slot, timestamp, type, feePayer: WALLET, transactionError: failed ? { InstructionError: [1, 'Custom'] } : null,
    events: type === 'SWAP' ? { swap: { tokenInputs: [{ userAccount: WALLET, mint: inputMint, rawTokenAmount: raw(inputRaw) }], tokenOutputs: [{ userAccount: WALLET, mint: outputMint, rawTokenAmount: raw(outputRaw) }], nativeInput: null, nativeOutput: null } } : {},
    tokenTransfers: transfers ? [
      { fromUserAccount: WALLET, toUserAccount: 'Other11111111111111111111111111111111111', mint: inputMint, rawTokenAmount: raw(inputRaw) },
      { fromUserAccount: 'Other11111111111111111111111111111111111', toUserAccount: WALLET, mint: outputMint, rawTokenAmount: raw(outputRaw) },
    ] : [],
    fee: 0,
    nativeTransfers: [], accountData: [{ account: WALLET, nativeBalanceChange: 0, tokenBalanceChanges: [] }], instructions: program === null ? [] : [{ programId: program, innerInstructions: [] }],
  };
  if (unresolved) body.tokenTransfers = [{ fromUserAccount: WALLET, toUserAccount: WALLET, mint: outputMint, rawTokenAmount: raw(outputRaw) }];
  return body;
}

export function fakePort({ pages = [[]], recheckPages = null, enhancedBodies = [], slot = ANCHOR_SLOT, blocks = {}, genesisHash = SOLANA_MAINNET_GENESIS_HASH } = {}) {
  let pageCall = 0;
  const initialCount = pages.length;
  return {
    async getNetworkIdentityV1() { return { chain: 'solana', network: 'mainnet-beta', genesis_hash: genesisHash }; },
    async getFinalizedSlotV1() { return slot; },
    async getFinalizedBlockV1({ slot: requestedSlot }) {
      if (Object.hasOwn(blocks, requestedSlot)) return structuredClone(blocks[requestedSlot]);
      return { slot: requestedSlot, block_time: ANCHOR_TIME, blockhash: BLOCKHASH, commitment: 'finalized' };
    },
    async getFinalizedWalletSignaturePageV1() {
      const source = pageCall < initialCount ? pages : (recheckPages ?? pages);
      const index = pageCall < initialCount ? pageCall : pageCall - initialCount;
      pageCall += 1;
      return structuredClone(source[Math.min(index, source.length - 1)] ?? []);
    },
    async getEnhancedTransactionsBySignatureV1() {
      return structuredClone(enhancedBodies.map(body => {
        try { return projectHeliusEnhancedTransactionV1({ wallet: WALLET, transaction: body }); }
        catch { return body; }
      }));
    },
  };
}
