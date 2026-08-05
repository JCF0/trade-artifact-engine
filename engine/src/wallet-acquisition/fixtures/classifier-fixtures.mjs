export const WALLET = '7YWHMfk9JZe0LMKx5fYJEE9HDSKPQpJiX5wV8QvB7vvV';
export const OTHER_WALLET = '9xQeWvG816bUx9EPfEZvT3XgG5QvQx8x6vW9pN5R3m2A';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const RAY = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function token(operation_id, economic_group, operation_kind, direction, mint, amount, decimals = 6) {
  return { operation_id, economic_group, operation_kind, direction, owner: WALLET, mint, amount, decimals };
}

function native(operation_id, economic_group, operation_kind, direction, amount_lamports) {
  return { operation_id, economic_group, operation_kind, direction, owner: WALLET, amount_lamports };
}

function source(name, overrides = {}) {
  return {
    source_transaction_version: 'wallet_source_transaction_v1',
    signature: `signature-${name}`,
    slot: 1000,
    block_time: 1_780_000_000,
    execution_state: 'succeeded',
    provider_failure_indicator: 'succeeded',
    wallet: WALLET,
    fee_payer: WALLET,
    token_operations: [],
    native_sol_operations: [],
    provider_classification_code: 'SWAP',
    recognized_programs: [{ program_id: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', program_role: 'spot_swap' }],
    ...overrides,
  };
}

function eventFor(transaction, {
  token_in_mint,
  token_in_amount,
  token_in_decimals,
  token_out_mint,
  token_out_amount,
  token_out_decimals,
}) {
  return {
    wallet: transaction.wallet,
    timestamp: transaction.block_time,
    tx_hash: transaction.signature,
    source: 'wallet_source_transaction_v1',
    token_in_mint,
    token_in_amount,
    token_in_decimals,
    token_out_mint,
    token_out_amount,
    token_out_decimals,
    extraction_method: 'injected_wallet_spot_normalizer_v1',
    raw_index: 0,
  };
}

const buy = source('supported-buy', {
  token_operations: [
    token('buy-usdc', 'swap-1', 'swap', 'debit', USDC, 25, 6),
    token('buy-jup', 'swap-1', 'swap', 'credit', JUP, 100, 6),
  ],
});
const sell = source('supported-sell', {
  token_operations: [
    token('sell-jup', 'swap-1', 'swap', 'debit', JUP, 100, 6),
    token('sell-usdt', 'swap-1', 'swap', 'credit', USDT, 30, 6),
  ],
});
const unknownProvider = source('unknown-provider', {
  provider_classification_code: 'UNKNOWN',
  token_operations: [
    token('unknown-usdc', 'swap-1', 'swap', 'debit', USDC, 20, 6),
    token('unknown-ray', 'swap-1', 'swap', 'credit', RAY, 40, 6),
  ],
});

export const CLASSIFIER_FIXTURES = deepFreeze({
  supportedBuy: buy,
  supportedSell: sell,
  failed: source('failed', { execution_state: 'failed', provider_failure_indicator: 'failed', token_operations: [token('failed-jup', 'swap-1', 'swap', 'credit', JUP, 100)] }),
  quoteOnlyTransfer: source('quote-transfer', { provider_classification_code: 'TRANSFER', recognized_programs: [], token_operations: [token('quote-in', 'transfer-1', 'transfer', 'credit', USDC, 5)] }),
  nonquoteTransferIn: source('token-transfer-in', { provider_classification_code: 'TRANSFER', recognized_programs: [], token_operations: [token('jup-in', 'transfer-1', 'transfer', 'credit', JUP, 5)] }),
  nonquoteTransferOut: source('token-transfer-out', { provider_classification_code: 'TRANSFER', recognized_programs: [], token_operations: [token('ray-out', 'transfer-1', 'transfer', 'debit', RAY, 5)] }),
  tokenToToken: source('token-token', { token_operations: [token('jup-out', 'swap-1', 'swap', 'debit', JUP, 5), token('ray-in', 'swap-1', 'swap', 'credit', RAY, 10)] }),
  ambiguousOneToken: source('ambiguous-one', { token_operations: [token('usdc-unknown', 'swap-1', 'swap', 'unknown', USDC, null, null), token('jup-unknown', 'swap-1', 'swap', 'unknown', JUP, null, null)] }),
  ambiguousSeveralTokens: source('ambiguous-several', { token_operations: [token('jup-unknown', 'swap-1', 'swap', 'unknown', JUP, null, null), token('ray-unknown', 'swap-1', 'swap', 'unknown', RAY, null, null), token('usdc-unknown', 'swap-1', 'swap', 'unknown', USDC, null, null)] }),
  walletWideUnknownMint: source('wallet-wide', { token_operations: [token('unknown-mint', 'unknown-1', 'unknown', 'unknown', null, null, null)] }),
  swapPlusTransfer: source('swap-plus-transfer', { token_operations: [token('usdc-out', 'swap-1', 'swap', 'debit', USDC, 25), token('jup-in', 'swap-1', 'swap', 'credit', JUP, 100), token('jup-extra', 'transfer-2', 'transfer', 'debit', JUP, 1)] }),
  twoSwaps: source('two-swaps', { token_operations: [token('usdc-out', 'swap-1', 'swap', 'debit', USDC, 25), token('jup-in', 'swap-1', 'swap', 'credit', JUP, 100), token('usdt-out', 'swap-2', 'swap', 'debit', USDT, 30), token('ray-in', 'swap-2', 'swap', 'credit', RAY, 50)] }),
  severalOutputs: source('several-outputs', { token_operations: [token('usdc-out', 'swap-1', 'swap', 'debit', USDC, 25), token('jup-in', 'swap-1', 'swap', 'credit', JUP, 50), token('ray-in', 'swap-1', 'swap', 'credit', RAY, 10)] }),
  metadataOnly: source('metadata-only', { provider_classification_code: 'NFT_METADATA', recognized_programs: [{ program_id: 'meta-program', program_role: 'metadata' }], token_operations: [token('metadata-jup', null, 'metadata', 'none', JUP, null, null)] }),
  closeAccountNoMovement: source('close-account', { provider_classification_code: 'CLOSE_ACCOUNT', recognized_programs: [{ program_id: 'token-program', program_role: 'token' }], token_operations: [token('close-jup', null, 'account_close', 'none', JUP, null, 6)] }),
  unknownProvider,
  wrongFeePayer: source('wrong-fee-payer', { fee_payer: OTHER_WALLET, token_operations: [token('usdc-out', 'swap-1', 'swap', 'debit', USDC, 25), token('jup-in', 'swap-1', 'swap', 'credit', JUP, 100)] }),
  commonQuoteContext: source('common-quote-jup', { provider_classification_code: 'TRANSFER', recognized_programs: [], token_operations: [token('usdc-context', 'transfer-1', 'transfer', 'credit', USDC, 25), token('jup-inventory', 'transfer-2', 'transfer', 'credit', JUP, 100)] }),
  commonQuoteContextRay: source('common-quote-ray', { provider_classification_code: 'TRANSFER', recognized_programs: [], token_operations: [token('usdc-context', 'transfer-1', 'transfer', 'debit', USDC, 25), token('ray-inventory', 'transfer-2', 'transfer', 'debit', RAY, 100)] }),
  nativeSolBuy: source('native-sol-buy', { token_operations: [token('jup-in', 'swap-1', 'swap', 'credit', JUP, 100)], native_sol_operations: [native('sol-out', 'swap-1', 'swap', 'debit', 25_000_000)] }),
});

export const SUPPORTED_EVENTS = deepFreeze({
  supportedBuy: eventFor(buy, { token_in_mint: USDC, token_in_amount: 25, token_in_decimals: 6, token_out_mint: JUP, token_out_amount: 100, token_out_decimals: 6 }),
  supportedSell: eventFor(sell, { token_in_mint: JUP, token_in_amount: 100, token_in_decimals: 6, token_out_mint: USDT, token_out_amount: 30, token_out_decimals: 6 }),
  unknownProvider: eventFor(unknownProvider, { token_in_mint: USDC, token_in_amount: 20, token_in_decimals: 6, token_out_mint: RAY, token_out_amount: 40, token_out_decimals: 6 }),
});

export function supportedNormalizer(event) {
  return () => ({ outcome: 'supported_event', event });
}

export function outcomeNormalizer(outcome) {
  return () => ({ outcome, event: null });
}
