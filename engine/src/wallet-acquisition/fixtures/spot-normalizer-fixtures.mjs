import { SOLANA_SPOT_EVIDENCE_VERSION_V1 } from '../solana-spot-evidence.mjs';
import { providerSignature } from './test-identities.mjs';

export const WALLET = '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni';
export const OTHER_WALLET = '9xQeWvG816bUx9EPfEZvT3XgG5QvQx8x6vW9pN5R3m2A';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const RAY = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
export const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6o1pPB263hYhNaWH';

export const PROGRAMS = Object.freeze({
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  raydium: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  orca: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
});

function tokenLeg(leg_id, mint, raw_amount, decimals = 6) {
  return { leg_id, owner: WALLET, mint, raw_amount: String(raw_amount), decimals };
}

function nativeLeg(leg_id, amount_lamports) {
  return { leg_id, owner: WALLET, amount_lamports };
}

function transfer(leg_id, economic_group, direction, mint, raw_amount, decimals = 6) {
  return { leg_id, economic_group, direction, owner: WALLET, mint, raw_amount: String(raw_amount), decimals };
}

function nativeTransfer(leg_id, economic_group, direction, amount_lamports) {
  return { leg_id, economic_group, direction, owner: WALLET, amount_lamports };
}

export function spotEvidence(name, overrides = {}) {
  return {
    spot_evidence_version: SOLANA_SPOT_EVIDENCE_VERSION_V1,
    signature: providerSignature(name),
    slot: 1000,
    block_time: 1_780_000_000,
    execution_state: 'succeeded',
    wallet: WALLET,
    fee_payer: WALLET,
    provider_transaction_type: 'SWAP',
    recognized_programs: [{ program_id: PROGRAMS.jupiter }],
    structured_swap_groups: [],
    token_transfer_legs: [],
    native_sol_transfer_legs: [],
    account_closures: [],
    unresolved_wallet_effects: [],
    ...overrides,
  };
}

export function structured(name, {
  inputMint = USDC,
  inputRaw = '25000000',
  inputDecimals = 6,
  outputMint = JUP,
  outputRaw = '100000000',
  outputDecimals = 6,
  program = PROGRAMS.jupiter,
  type = 'SWAP',
  inputs,
  outputs,
} = {}) {
  return spotEvidence(name, {
    provider_transaction_type: type,
    recognized_programs: [{ program_id: program }],
    structured_swap_groups: [{
      group_id: 'swap-1',
      token_inputs: inputs ?? [tokenLeg('input-1', inputMint, inputRaw, inputDecimals)],
      token_outputs: outputs ?? [tokenLeg('output-1', outputMint, outputRaw, outputDecimals)],
      native_inputs: [],
      native_outputs: [],
    }],
  });
}

export function fallback(name, {
  inputMint = USDC,
  inputRaw = '25000000',
  inputDecimals = 6,
  outputMint = JUP,
  outputRaw = '100000000',
  outputDecimals = 6,
  program = PROGRAMS.jupiter,
  type = 'UNKNOWN',
} = {}) {
  return spotEvidence(name, {
    provider_transaction_type: type,
    recognized_programs: program === null ? [] : [{ program_id: program }],
    token_transfer_legs: [
      transfer('input-1', 'fallback-1', 'debit', inputMint, inputRaw, inputDecimals),
      transfer('output-1', 'fallback-1', 'credit', outputMint, outputRaw, outputDecimals),
    ],
  });
}

export const leg = Object.freeze({ token: tokenLeg, native: nativeLeg, transfer, nativeTransfer });
