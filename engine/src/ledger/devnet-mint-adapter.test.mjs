/**
 * Devnet Mint Adapter Tests — E9
 *
 * Tests for gate logic, plan validation, idempotency, result schema,
 * and mock mint execution. No real Solana calls. No live mint.
 */

import {
  checkMintGates,
  validatePlanForMint,
  shouldSkipMint,
  buildMintResultEntry,
  buildFailedMintResultEntry,
  checkMintEnvPresence,
  executeSingleMint,
  extractSafeErrorMessage,
  MIN_MINT_LAMPORTS,
} from './devnet-mint-adapter.mjs';

// ═══════════════════════════════════════════════════════════════
// Test harness
// ═══════════════════════════════════════════════════════════════

const _tests = [];
let _passed = 0;
let _failed = 0;
let _total = 0;

function t(name, fn) { _tests.push({ name, fn }); }
function assert(condition, msg) { if (!condition) throw new Error(msg || 'assertion failed'); }

// ═══════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════

function allMintGatesOpts() {
  return {
    ledgerDebug: true,
    mintLive: true,
    mintConfirm: true,
    mintReceiptId: 'art_v12_cp_TESTMINT_0',
    proofWallet: 'PROOF_WALLET_PUBKEY_12345',
    mintEnabled: 'true',
    mintAuthorityKeypairPath: '/path/to/mint-auth.json',
    mintAuthorityKeypairFileExists: true,
    network: 'devnet',
  };
}

function makeMintReadyPlan(overrides = {}) {
  return {
    receipt_id: 'art_v12_cp_TESTMINT_0',
    receipt_hash: 'a'.repeat(64),
    candidate_hash: 'c'.repeat(64),
    upload_result_used: true,
    upload_fresh: true,
    final_image_uri: 'https://gateway.irys.xyz/img_001',
    final_metadata_uri: 'https://gateway.irys.xyz/meta_002',
    _mint_ready_resolver: { freshness_reason: 'complete_and_fresh' },
    ...overrides,
  };
}

function mockMintClient(mintAddr, tokenAcct, sig, opts = {}) {
  return {
    authorityPubkey: 'MOCK_AUTHORITY_PUBKEY',
    calls: [],
    async checkPreflight() {
      if (opts.balance !== undefined && opts.balance < MIN_MINT_LAMPORTS) {
        return {
          ready: false,
          blocker: 'mint_authority_unfunded',
          message: `Mint authority has ${(opts.balance / 1e9).toFixed(4)} SOL`,
          balance: opts.balance,
        };
      }
      return { ready: true, balance: opts.balance ?? 100_000_000 };
    },
    async mintNonTransferableToken(proofWallet, metadataUri) {
      this.calls.push({ proofWallet, metadataUri });
      return {
        mintAddress: mintAddr || 'MINT_ADDRESS_123',
        tokenAccount: tokenAcct || 'TOKEN_ACCOUNT_456',
        signature: sig || 'TX_SIG_789',
      };
    },
  };
}

function failingMintClient(error) {
  return {
    authorityPubkey: 'MOCK_AUTHORITY_PUBKEY',
    async checkPreflight() { return { ready: true, balance: 100_000_000 }; },
    async mintNonTransferableToken() {
      throw new Error(error || 'mint_failed');
    },
  };
}

function unfundedMintClient(balance) {
  return mockMintClient(null, null, null, { balance: balance ?? 0 });
}

// ═══════════════════════════════════════════════════════════════
// 1. All mint gates blocked by default
// ═══════════════════════════════════════════════════════════════

t('gates: all gates pass when all provided', () => {
  const { allowed, blockers } = checkMintGates(allMintGatesOpts());
  assert(allowed === true, `should be allowed, blockers: [${blockers.join(', ')}]`);
});

t('gates: default empty opts → all blocked', () => {
  const { allowed, blockers } = checkMintGates({});
  assert(allowed === false);
  assert(blockers.length >= 7, `expected >=7 blockers, got ${blockers.length}`);
});

// ═══════════════════════════════════════════════════════════════
// 2-7. Individual gate blockers
// ═══════════════════════════════════════════════════════════════

t('gates: missing --mint-confirm blocks', () => {
  const opts = { ...allMintGatesOpts(), mintConfirm: false };
  const { allowed, blockers } = checkMintGates(opts);
  assert(allowed === false);
  assert(blockers.includes('missing_mint_confirm_flag'));
});

t('gates: missing --mint-receipt-id blocks', () => {
  const opts = { ...allMintGatesOpts(), mintReceiptId: null };
  const { allowed, blockers } = checkMintGates(opts);
  assert(allowed === false);
  assert(blockers.includes('missing_mint_receipt_id'));
});

t('gates: missing --proof-wallet blocks', () => {
  const opts = { ...allMintGatesOpts(), proofWallet: null };
  const { allowed, blockers } = checkMintGates(opts);
  assert(allowed === false);
  assert(blockers.includes('missing_proof_wallet'));
});

t('gates: missing MINT_ENABLED blocks', () => {
  const opts = { ...allMintGatesOpts(), mintEnabled: undefined };
  const { allowed, blockers } = checkMintGates(opts);
  assert(allowed === false);
  assert(blockers.includes('mint_enabled_not_true'));
});

t('gates: missing mint authority keypair path blocks', () => {
  const opts = { ...allMintGatesOpts(), mintAuthorityKeypairPath: null };
  const { allowed, blockers } = checkMintGates(opts);
  assert(allowed === false);
  assert(blockers.includes('mint_authority_keypair_path_not_defined'));
});

t('gates: non-devnet blocks', () => {
  const opts = { ...allMintGatesOpts(), network: 'mainnet-beta' };
  const { allowed, blockers } = checkMintGates(opts);
  assert(allowed === false);
  assert(blockers.includes('non_devnet_not_approved'));
});

// ═══════════════════════════════════════════════════════════════
// 8. Plan without metadata URI blocks
// ═══════════════════════════════════════════════════════════════

t('plan validation: no metadata_uri → blocked', () => {
  const plan = makeMintReadyPlan({ final_metadata_uri: null });
  const { valid, blockers } = validatePlanForMint(plan);
  assert(valid === false);
  assert(blockers.includes('metadata_uri_not_available'));
});

t('plan validation: valid plan passes', () => {
  const plan = makeMintReadyPlan();
  const { valid } = validatePlanForMint(plan);
  assert(valid === true);
});

// ═══════════════════════════════════════════════════════════════
// 9. Stale upload blocks
// ═══════════════════════════════════════════════════════════════

t('plan validation: stale upload → blocked', () => {
  const plan = makeMintReadyPlan({ upload_fresh: false, upload_result_used: false });
  const { valid, blockers } = validatePlanForMint(plan);
  assert(valid === false);
  assert(blockers.includes('upload_result_not_usable'));
});

// ═══════════════════════════════════════════════════════════════
// 10. Already minted receipt skips
// ═══════════════════════════════════════════════════════════════

t('idempotency: already minted → skip', () => {
  const existing = { mint_status: 'minted', transaction_signature: 'TX_SIG_123' };
  const { skip, reason } = shouldSkipMint(existing);
  assert(skip === true);
  assert(reason === 'already_minted');
});

t('idempotency: no existing → do not skip', () => {
  const { skip } = shouldSkipMint(null);
  assert(skip === false);
});

t('idempotency: failed existing → do not skip', () => {
  const existing = { mint_status: 'submit_failed' };
  const { skip } = shouldSkipMint(existing);
  assert(skip === false);
});

// ═══════════════════════════════════════════════════════════════
// 11. Successful mock mint
// ═══════════════════════════════════════════════════════════════

t('mock mint: success returns minted result', async () => {
  const plan = makeMintReadyPlan();
  const client = mockMintClient('MINT_001', 'ATA_001', 'SIG_001');
  const result = await executeSingleMint(plan, {
    proofWallet: 'PROOF_WALLET',
    mintAuthorityPubkey: 'AUTH_PUBKEY',
    network: 'devnet',
  }, client);

  assert(result.mint_status === 'minted', `got ${result.mint_status}`);
  assert(result.mint_address === 'MINT_001');
  assert(result.token_account === 'ATA_001');
  assert(result.transaction_signature === 'SIG_001');
  assert(result.proof_wallet_pubkey === 'PROOF_WALLET');
  assert(result.token_standard === 'token_2022');
  assert(result.proof_nft_type === 'non_transferable');
  assert(result.transferability === 'non_transferable_extension');
  assert(result.metadata_linkage === 'manifest_only');
  assert(result.minted_at !== null);
});

// ═══════════════════════════════════════════════════════════════
// 12. Failed mock submit
// ═══════════════════════════════════════════════════════════════

t('mock mint: failure returns submit_failed', async () => {
  const plan = makeMintReadyPlan();
  const client = failingMintClient('tx_timeout');
  const result = await executeSingleMint(plan, {
    proofWallet: 'PROOF_WALLET',
    mintAuthorityPubkey: 'AUTH_PUBKEY',
  }, client);

  assert(result.mint_status === 'submit_failed', `got ${result.mint_status}`);
  assert(result.error_message === 'tx_timeout');
  assert(result.transaction_signature === null);
});

// ═══════════════════════════════════════════════════════════════
// 13. No secrets in result
// ═══════════════════════════════════════════════════════════════

t('result: no secrets, no keypair path, no env values', () => {
  const result = buildMintResultEntry({
    receiptId: 'r1', receiptHash: 'h', candidateHash: 'c',
    metadataUri: 'u', imageUri: 'u',
    mintAddress: 'm', tokenAccount: 'a',
    proofWalletPubkey: 'PW', mintAuthorityPubkey: 'MA',
    transactionSignature: 's', network: 'devnet',
  });
  const str = JSON.stringify(result);
  assert(!str.includes('PRIVATE'), 'no PRIVATE');
  assert(!str.includes('SECRET'), 'no SECRET');
  assert(!str.includes('keypair'), 'no keypair');
  assert(!str.includes('.env'), 'no .env');
  assert(!str.includes('path'), 'no path reference');
});

// ═══════════════════════════════════════════════════════════════
// 14. Token-2022 / NonTransferable labels present
// ═══════════════════════════════════════════════════════════════

t('result: Token-2022 labels correct', () => {
  const result = buildMintResultEntry({
    receiptId: 'r1', receiptHash: 'h', candidateHash: 'c',
    metadataUri: 'u', imageUri: 'u',
    mintAddress: 'm', tokenAccount: 'a',
    proofWalletPubkey: 'PW', mintAuthorityPubkey: 'MA',
    transactionSignature: 's',
  });
  assert(result.token_standard === 'token_2022');
  assert(result.proof_nft_type === 'non_transferable');
  assert(result.transferability === 'non_transferable_extension');
  assert(result.metadata_linkage === 'manifest_only');
});

// ═══════════════════════════════════════════════════════════════
// 15. Proof wallet is explicit, not inferred
// ═══════════════════════════════════════════════════════════════

t('gates: proof wallet must be explicitly provided', () => {
  // Even if all other gates pass, missing proof wallet blocks
  const opts = { ...allMintGatesOpts(), proofWallet: undefined };
  const { allowed, blockers } = checkMintGates(opts);
  assert(allowed === false);
  assert(blockers.includes('missing_proof_wallet'));
});

// ═══════════════════════════════════════════════════════════════
// 16. Env presence checks safe
// ═══════════════════════════════════════════════════════════════

t('env check: no secret values returned', () => {
  const check = checkMintEnvPresence();
  const str = JSON.stringify(check);
  assert(!str.includes('/'), 'no paths');
  assert(!str.includes('\\'), 'no backslash paths');
  assert(typeof check.mintEnabled === 'boolean');
  assert(check.mintAuthorityPathPresence === 'defined' || check.mintAuthorityPathPresence === 'not defined');
});

// ═══════════════════════════════════════════════════════════════
// E9.1 Preflight tests
// ═══════════════════════════════════════════════════════════════

t('preflight: unfunded mint authority fails with mint_authority_unfunded', async () => {
  const plan = makeMintReadyPlan();
  const client = unfundedMintClient(0);
  const result = await executeSingleMint(plan, {
    proofWallet: 'PROOF_WALLET',
    mintAuthorityPubkey: 'AUTH_PUBKEY',
  }, client);
  assert(result.mint_status === 'mint_authority_unfunded', `got ${result.mint_status}`);
  assert(result.error_message.includes('SOL'), `error should mention SOL: ${result.error_message}`);
  assert(result.transaction_signature === null);
});

t('preflight: low but nonzero balance still fails', async () => {
  const plan = makeMintReadyPlan();
  const client = unfundedMintClient(5_000_000); // 0.005 SOL, below 0.02 threshold
  const result = await executeSingleMint(plan, {
    proofWallet: 'PROOF_WALLET',
    mintAuthorityPubkey: 'AUTH_PUBKEY',
  }, client);
  assert(result.mint_status === 'mint_authority_unfunded');
});

t('preflight: funded balance passes and mint proceeds', async () => {
  const plan = makeMintReadyPlan();
  const client = mockMintClient('MINT_OK', 'ATA_OK', 'SIG_OK', { balance: 100_000_000 });
  const result = await executeSingleMint(plan, {
    proofWallet: 'PROOF_WALLET',
    mintAuthorityPubkey: 'AUTH_PUBKEY',
  }, client);
  assert(result.mint_status === 'minted', `got ${result.mint_status}`);
  assert(result.mint_address === 'MINT_OK');
});

t('extractSafeErrorMessage: includes log excerpt from e.logs', () => {
  const err = new Error('Transaction simulation failed');
  err.logs = ['Program log: ix 0', 'Program log: ix 1', 'Program log: custom error 0x1', 'Program log: failed'];
  const msg = extractSafeErrorMessage(err);
  assert(msg.includes('Transaction simulation failed'), 'base message');
  assert(msg.includes('logs:'), 'should include logs');
  assert(msg.includes('custom error'), 'should include log content');
  // Only last 3 logs
  assert(!msg.includes('ix 0'), 'should not include earliest log');
});

t('extractSafeErrorMessage: generic error has no log dump', () => {
  const err = new Error('Connection timeout');
  const msg = extractSafeErrorMessage(err);
  assert(msg === 'Connection timeout', `got ${msg}`);
  assert(!msg.includes('logs:'));
});

t('preflight: failed result contains no secrets', async () => {
  const plan = makeMintReadyPlan();
  const client = unfundedMintClient(0);
  const result = await executeSingleMint(plan, {
    proofWallet: 'PROOF_WALLET',
    mintAuthorityPubkey: 'AUTH_PUBKEY',
  }, client);
  const str = JSON.stringify(result);
  assert(!str.includes('PRIVATE'), 'no PRIVATE');
  assert(!str.includes('SECRET'), 'no SECRET');
  assert(!str.includes('keypair'), 'no keypair');
  assert(!str.includes('.env'), 'no .env');
});

// ═══════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════

console.log('\n-- Devnet mint adapter tests --');

async function run() {
  for (const { name, fn } of _tests) {
    _total++;
    try {
      await fn();
      _passed++;
    } catch (e) {
      _failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`        ${e.message}`);
    }
  }
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Devnet Mint Adapter: ${_passed}/${_total} passed, ${_failed} failed`);
  console.log(`${'='.repeat(50)}`);
  process.exit(_failed > 0 ? 1 : 0);
}

run();
