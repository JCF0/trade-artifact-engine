/**
 * Pipeline constants — shared across all pipeline modules.
 * Extracted from mint-one.mjs v1 (Phase 0.5).
 */

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
export const SYMS = { [SOL_MINT]: 'SOL', [USDC_MINT]: 'USDC', [USDT_MINT]: 'USDT', MIXED: 'MIXED' };

export const DUST_ABS = 0.001;
export const DUST_PCT = 0.001; // 0.1%

export const BASE_URL = 'https://api-mainnet.helius-rpc.com';
export const PAGE_SIZE = 100;
export const RATE_DELAY_MS = 350;

export const RECEIPT_VERSION = '1.0';
export const CHAIN = 'solana';
export const ACCOUNTING_METHOD = 'weighted_average_cost_basis';

export const GATEWAY_BASE = 'https://gateway.irys.xyz';

// Known DEX program IDs
export const DEX_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CPMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
]);
