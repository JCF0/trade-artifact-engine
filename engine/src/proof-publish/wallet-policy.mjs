const WALLET_DISPLAY_MODES = new Set(['truncated', 'redacted', 'full']);
const REDACTED_WALLET_TEXT = '[redacted]';

function truncateWallet(wallet) {
  if (typeof wallet !== 'string' || wallet.length === 0) return wallet;
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function normalizeMode(mode) {
  if (mode == null) return 'full';
  if (!WALLET_DISPLAY_MODES.has(mode)) {
    throw new TypeError(`Unsupported wallet display mode: ${mode}`);
  }
  return mode;
}

function displayWallet(wallet, mode) {
  if (typeof wallet !== 'string' || wallet.length === 0) return wallet ?? null;
  if (mode === 'redacted') return REDACTED_WALLET_TEXT;
  if (mode === 'truncated') return truncateWallet(wallet);
  return wallet;
}

export function applyWalletDisplayPolicy(proofDetail, options = {}) {
  if (!proofDetail || typeof proofDetail !== 'object') {
    throw new TypeError('proofDetail is required');
  }

  const mode = normalizeMode(options.mode);
  const next = structuredClone(proofDetail);
  const renderedWallet = displayWallet(next.receipt?.wallet, mode);

  if (next.receipt && Object.hasOwn(next.receipt, 'wallet')) {
    next.receipt.wallet = renderedWallet;
  }

  return next;
}

export { REDACTED_WALLET_TEXT };
