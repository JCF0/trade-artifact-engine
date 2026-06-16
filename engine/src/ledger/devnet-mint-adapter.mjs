/**
 * Devnet Mint Adapter — E9
 *
 * Guarded adapter for minting Token-2022 NonTransferable proof NFTs
 * from v1.2 receipt metadata URIs on Solana devnet.
 *
 * Solana libraries are lazily imported — only when createMintClient is called.
 *
 * This module does NOT:
 *   - Perform live mint during implementation/tests
 *   - Print .env contents, private keys, or keypair arrays
 *   - Store secrets in output manifests
 *   - Change v1.1 behavior, receipt schemas, or verifier logic
 *   - Fetch prices or add USD normalization
 *
 * Token standard: Token-2022 with NonTransferable extension.
 * Metadata linkage: manifest_only for E9 (on-chain pointer deferred).
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const MINT_ADAPTER_VERSION = '1.0.0';

// Conservative minimum for Token-2022 mint (rent + ATA rent + tx fees)
const MIN_MINT_LAMPORTS = 20_000_000; // 0.02 SOL

// ═══════════════════════════════════════════════════════════════
// Safe error message extraction
// ═══════════════════════════════════════════════════════════════

/**
 * Extract a safe error message from a Solana transaction error.
 *
 * Includes log excerpts from SendTransactionError when available.
 * Never dumps full error objects, config, keypair, or env values.
 *
 * @param {Error} e
 * @returns {string}
 */
export function extractSafeErrorMessage(e) {
  let msg = e.message || 'unknown error';

  // SendTransactionError may have .logs directly
  if (Array.isArray(e.logs) && e.logs.length > 0) {
    const safeLogExcerpt = e.logs.slice(-3).join('; ');
    msg += ` | logs: ${safeLogExcerpt}`;
  } else if (typeof e.getLogs === 'function') {
    // Some versions expose getLogs() as async
    try {
      // getLogs may be sync or async — handle both
      const logs = e.getLogs();
      if (Array.isArray(logs) && logs.length > 0) {
        msg += ` | logs: ${logs.slice(-3).join('; ')}`;
      }
    } catch {
      // getLogs failed — ignore, we already have the base message
    }
  }

  return msg;
}

export { MIN_MINT_LAMPORTS };

// ═══════════════════════════════════════════════════════════════
// Gate checking (pure function)
// ═══════════════════════════════════════════════════════════════

/**
 * Check all mint gates. Returns { allowed, blockers }.
 *
 * @param {object} opts
 * @returns {{ allowed: boolean, blockers: string[] }}
 */
export function checkMintGates(opts) {
  const blockers = [];

  if (!opts.ledgerDebug) blockers.push('missing_ledger_debug_flag');
  if (!opts.mintLive) blockers.push('missing_mint_live_flag');
  if (!opts.mintConfirm) blockers.push('missing_mint_confirm_flag');
  if (!opts.mintReceiptId) blockers.push('missing_mint_receipt_id');
  if (!opts.proofWallet) blockers.push('missing_proof_wallet');
  if (opts.mintEnabled !== 'true') blockers.push('mint_enabled_not_true');
  if (!opts.mintAuthorityKeypairPath) blockers.push('mint_authority_keypair_path_not_defined');
  if (opts.mintAuthorityKeypairPath && !opts.mintAuthorityKeypairFileExists) {
    blockers.push('mint_authority_keypair_file_not_found');
  }
  if (opts.network !== 'devnet') blockers.push('non_devnet_not_approved');

  return { allowed: blockers.length === 0, blockers };
}

/**
 * Validate that an E8 mint-ready plan is suitable for minting.
 *
 * @param {object} plan - E8 resolved mint-ready plan
 * @returns {{ valid: boolean, blockers: string[] }}
 */
export function validatePlanForMint(plan) {
  const blockers = [];

  if (!plan) {
    blockers.push('no_plan_found');
    return { valid: false, blockers };
  }

  if (!plan.final_metadata_uri) blockers.push('metadata_uri_not_available');
  if (!plan.final_image_uri) blockers.push('image_uri_not_available');
  if (!plan.upload_result_used) blockers.push('upload_result_not_usable');
  if (plan.upload_fresh === false && plan._mint_ready_resolver?.freshness_reason !== 'uri_usable_local_write_failed') {
    blockers.push('upload_not_fresh');
  }

  return { valid: blockers.length === 0, blockers };
}

// ═══════════════════════════════════════════════════════════════
// Idempotency (pure function)
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a receipt has already been minted.
 *
 * @param {object|null} existingResult
 * @returns {{ skip: boolean, reason: string }}
 */
export function shouldSkipMint(existingResult) {
  if (!existingResult) return { skip: false, reason: 'no_existing_result' };
  if (existingResult.mint_status === 'minted' && existingResult.transaction_signature) {
    return { skip: true, reason: 'already_minted' };
  }
  return { skip: false, reason: `previous_status_${existingResult.mint_status}` };
}

// ═══════════════════════════════════════════════════════════════
// Mint result builders (pure functions)
// ═══════════════════════════════════════════════════════════════

/**
 * Build a successful mint result entry.
 * Contains NO secrets, keypair paths, or env values.
 */
export function buildMintResultEntry(params) {
  return {
    receipt_id: params.receiptId,
    receipt_hash: params.receiptHash,
    candidate_hash: params.candidateHash,
    metadata_uri: params.metadataUri,
    image_uri: params.imageUri,

    mint_address: params.mintAddress,
    token_account: params.tokenAccount,
    proof_wallet_pubkey: params.proofWalletPubkey,
    mint_authority_pubkey: params.mintAuthorityPubkey,

    transaction_signature: params.transactionSignature,
    network: params.network || 'devnet',
    token_standard: 'token_2022',
    proof_nft_type: 'non_transferable',
    transferability: 'non_transferable_extension',
    metadata_linkage: 'manifest_only',

    mint_status: params.mintStatus || 'minted',
    minted_at: params.mintedAt || null,
  };
}

/**
 * Build a failed/partial mint result entry.
 */
export function buildFailedMintResultEntry(params, error) {
  return {
    receipt_id: params.receiptId,
    receipt_hash: params.receiptHash,
    candidate_hash: params.candidateHash,
    metadata_uri: params.metadataUri,
    image_uri: params.imageUri,

    mint_address: params.mintAddress || null,
    token_account: params.tokenAccount || null,
    proof_wallet_pubkey: params.proofWalletPubkey,
    mint_authority_pubkey: params.mintAuthorityPubkey,

    transaction_signature: null,
    network: params.network || 'devnet',
    token_standard: 'token_2022',
    proof_nft_type: 'non_transferable',
    transferability: 'non_transferable_extension',
    metadata_linkage: 'manifest_only',

    mint_status: params.mintStatus || 'submit_failed',
    minted_at: null,
    error_message: error?.message || 'unknown error',
  };
}

// ═══════════════════════════════════════════════════════════════
// Safe env presence checks
// ═══════════════════════════════════════════════════════════════

/**
 * Check mint env presence without returning secret values.
 */
export function checkMintEnvPresence() {
  return {
    mintEnabled: process.env.MINT_ENABLED === 'true',
    mintAuthorityPathDefined: !!process.env.MINT_AUTHORITY_KEYPAIR_PATH,
    mintAuthorityPathPresence: process.env.MINT_AUTHORITY_KEYPAIR_PATH ? 'defined' : 'not defined',
  };
}

/**
 * Check mint authority keypair file exists.
 */
export function mintAuthorityFileExists() {
  const p = process.env.MINT_AUTHORITY_KEYPAIR_PATH;
  if (!p) return false;
  return existsSync(resolve(p));
}

// ═══════════════════════════════════════════════════════════════
// Mint executor (async, uses injected Solana client)
// ═══════════════════════════════════════════════════════════════

/**
 * Execute a single-receipt Token-2022 NonTransferable mint.
 *
 * Accepts an injected solanaClient for testability.
 *
 * @param {object} plan - E8 mint-ready plan for the receipt
 * @param {object} opts - { proofWallet, mintAuthorityPubkey, network }
 * @param {object} solanaClient - Injected client interface:
 *   { mintNonTransferableToken(proofWallet, metadataUri) → { mintAddress, tokenAccount, signature } }
 * @returns {Promise<object>} Mint result entry
 */
export async function executeSingleMint(plan, opts, solanaClient) {
  const baseParams = {
    receiptId: plan.receipt_id,
    receiptHash: plan.receipt_hash,
    candidateHash: plan.candidate_hash,
    metadataUri: plan.final_metadata_uri,
    imageUri: plan.final_image_uri,
    proofWalletPubkey: opts.proofWallet,
    mintAuthorityPubkey: opts.mintAuthorityPubkey,
    network: opts.network || 'devnet',
  };

  // Preflight: check mint authority balance if client supports it
  if (typeof solanaClient.checkPreflight === 'function') {
    const preflight = await solanaClient.checkPreflight();
    if (!preflight.ready) {
      return buildFailedMintResultEntry(
        { ...baseParams, mintStatus: preflight.blocker || 'preflight_failed' },
        new Error(preflight.message || 'Preflight check failed')
      );
    }
  }

  try {
    const result = await solanaClient.mintNonTransferableToken(
      opts.proofWallet,
      plan.final_metadata_uri
    );

    return buildMintResultEntry({
      ...baseParams,
      mintAddress: result.mintAddress,
      tokenAccount: result.tokenAccount,
      transactionSignature: result.signature,
      mintStatus: 'minted',
      mintedAt: new Date().toISOString(),
    });
  } catch (e) {
    // Safe error extraction — never dump full error/config/keypair objects
    const errorMsg = extractSafeErrorMessage(e);
    return buildFailedMintResultEntry(baseParams, { message: errorMsg });
  }
}

// ═══════════════════════════════════════════════════════════════
// Real Solana client factory (lazy imports)
// ═══════════════════════════════════════════════════════════════

/**
 * Create a real Solana client for Token-2022 NonTransferable minting.
 *
 * Lazily imports @solana/web3.js and @solana/spl-token.
 * Keypair loaded internally — NEVER logged or returned.
 *
 * @param {object} opts
 * @param {string} opts.keypairPath - Absolute path to mint authority keypair
 * @param {string} [opts.rpcUrl] - Solana RPC URL
 * @param {boolean} [opts.devnet=true]
 * @returns {Promise<{ mintNonTransferableToken, authorityPubkey, close }>}
 */
export async function createSolanaMintClient(opts) {
  const { keypairPath, rpcUrl, devnet = true } = opts;

  if (!keypairPath || !existsSync(resolve(keypairPath))) {
    throw new Error('Mint authority keypair file not found (path checked, not logged)');
  }

  // Lazy imports
  const { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } =
    await import('@solana/web3.js');
  const {
    TOKEN_2022_PROGRAM_ID,
    createInitializeNonTransferableMintInstruction,
    createInitializeMintInstruction,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    getAssociatedTokenAddress,
    getMintLen,
    ExtensionType,
  } = await import('@solana/spl-token');

  // Load keypair internally — NEVER log or return bytes
  const keypairBytes = JSON.parse(readFileSync(resolve(keypairPath), 'utf-8'));
  const mintAuthority = Keypair.fromSecretKey(Uint8Array.from(keypairBytes));
  const authorityPubkey = mintAuthority.publicKey.toBase58();

  const endpoint = rpcUrl || (devnet
    ? 'https://api.devnet.solana.com'
    : 'https://api.mainnet-beta.solana.com');
  const connection = new Connection(endpoint, 'confirmed');

  return {
    authorityPubkey,

    /**
     * Preflight check: verify mint authority has enough SOL.
     * @returns {Promise<{ ready: boolean, blocker?: string, message?: string, balance?: number }>}
     */
    async checkPreflight() {
      try {
        const balance = await connection.getBalance(mintAuthority.publicKey);
        if (balance < MIN_MINT_LAMPORTS) {
          return {
            ready: false,
            blocker: 'mint_authority_unfunded',
            message: `Mint authority has ${(balance / 1e9).toFixed(4)} SOL, needs ~${(MIN_MINT_LAMPORTS / 1e9).toFixed(2)} SOL minimum`,
            balance,
          };
        }
        return { ready: true, balance };
      } catch (e) {
        return {
          ready: false,
          blocker: 'preflight_rpc_error',
          message: `Balance check failed: ${e.message}`,
        };
      }
    },

    async mintNonTransferableToken(proofWalletPubkey, metadataUri) {
      const { PublicKey } = await import('@solana/web3.js');
      const proofWallet = new PublicKey(proofWalletPubkey);
      const mintKeypair = Keypair.generate();

      // Calculate space for mint with NonTransferable extension
      const mintLen = getMintLen([ExtensionType.NonTransferable]);
      const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

      const transaction = new Transaction().add(
        // Create account for mint
        SystemProgram.createAccount({
          fromPubkey: mintAuthority.publicKey,
          newAccountPubkey: mintKeypair.publicKey,
          space: mintLen,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        // Initialize NonTransferable extension
        createInitializeNonTransferableMintInstruction(
          mintKeypair.publicKey,
          TOKEN_2022_PROGRAM_ID
        ),
        // Initialize mint (decimals=0, supply will be 1)
        createInitializeMintInstruction(
          mintKeypair.publicKey,
          0, // decimals
          mintAuthority.publicKey, // mint authority
          null, // freeze authority (null = no freeze needed, NonTransferable handles it)
          TOKEN_2022_PROGRAM_ID
        )
      );

      // Get ATA for proof wallet
      const ata = await getAssociatedTokenAddress(
        mintKeypair.publicKey,
        proofWallet,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      transaction.add(
        // Create ATA
        createAssociatedTokenAccountInstruction(
          mintAuthority.publicKey, // payer
          ata,
          proofWallet,
          mintKeypair.publicKey,
          TOKEN_2022_PROGRAM_ID
        ),
        // Mint 1 token
        createMintToInstruction(
          mintKeypair.publicKey,
          ata,
          mintAuthority.publicKey,
          1, // amount
          [],
          TOKEN_2022_PROGRAM_ID
        )
      );

      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [mintAuthority, mintKeypair]
      );

      return {
        mintAddress: mintKeypair.publicKey.toBase58(),
        tokenAccount: ata.toBase58(),
        signature,
      };
    },

    close() {
      // No-op
    },
  };
}
