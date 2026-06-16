/**
 * Mint Plan — E2
 *
 * Pure function: v1.2 receipt + E1 metadata scaffold + optional opts
 * → mint-readiness plan showing what is required before minting.
 *
 * This module does NOT:
 *   - Upload to Arweave/Irys or any storage
 *   - Mint anything on-chain
 *   - Create or load keypairs
 *   - Read .env / secrets
 *   - Call Solana RPC or Metaplex/UMI
 *   - Modify receipts, hashes, or verification logic
 *   - Fetch prices or convert to USD
 *   - Use Date.now() or perform I/O
 */

const PLAN_VERSION = '1.0.0';
const DEFAULT_NETWORK = 'devnet';
const TOKEN_STANDARD = 'metaplex_token_metadata_v3';
const PROOF_NFT_TYPE = 'non_transferable';

// ═══════════════════════════════════════════════════════════════
// Blocker computation
// ═══════════════════════════════════════════════════════════════

/**
 * Compute mint blockers from current state.
 *
 * metadata_uri comes only from opts.metadataUri — never from
 * metadata.external_url (they are separate concepts).
 */
function computeBlockers(metadata, opts) {
  const blockers = [];

  // Image not rendered (metadata scaffold has image: null)
  if (!opts.imageUri && (metadata.image == null)) {
    blockers.push('image_not_rendered');
  }

  // Metadata not uploaded (no metadata_uri from opts)
  if (!opts.metadataUri) {
    blockers.push('metadata_not_uploaded');
    blockers.push('metadata_uri_missing');
  }

  // Proof wallet missing
  if (!opts.proofWalletPubkey) {
    blockers.push('proof_wallet_missing');
  }

  // Mint authority missing
  if (!opts.mintAuthorityPubkey) {
    blockers.push('mint_authority_missing');
  }

  // Explicit approval always required unless explicitly given
  if (!opts.approved) {
    blockers.push('explicit_mint_approval_required');
  }

  return blockers;
}

// ═══════════════════════════════════════════════════════════════
// Required steps builder
// ═══════════════════════════════════════════════════════════════

function buildRequiredSteps(metadata, opts) {
  const hasImage = !!(opts.imageUri || metadata.image);
  const hasMetadataUri = !!opts.metadataUri;
  const hasProofWallet = !!opts.proofWalletPubkey;
  const hasMintAuthority = !!opts.mintAuthorityPubkey;
  const hasApproval = !!opts.approved;

  return [
    {
      step: 'render_image',
      status: hasImage ? 'done' : 'not_started',
      artifact: opts.imageUri || metadata.image || null,
    },
    {
      step: 'upload_image',
      status: hasImage ? 'done' : 'not_started',
      artifact: opts.imageUri || null,
    },
    {
      step: 'upload_metadata',
      status: hasMetadataUri ? 'done' : 'not_started',
      artifact: opts.metadataUri || null,
    },
    {
      step: 'set_proof_wallet',
      status: hasProofWallet ? 'done' : 'not_started',
      pubkey: opts.proofWalletPubkey || null,
    },
    {
      step: 'set_mint_authority',
      status: hasMintAuthority ? 'done' : 'not_started',
      pubkey: opts.mintAuthorityPubkey || null,
    },
    {
      step: 'explicit_approval',
      status: hasApproval ? 'done' : 'not_started',
      approved_by: opts.approvedBy || null,
    },
  ];
}

// ═══════════════════════════════════════════════════════════════
// buildMintPlan
// ═══════════════════════════════════════════════════════════════

/**
 * Build a mint-readiness plan from a canonical v1.2 receipt and
 * E1 metadata scaffold.
 *
 * Pure function: no I/O, no Date.now(), fully deterministic.
 *
 * @param {object} receipt - Canonical v1.2 receipt record
 * @param {object} metadata - E1 metadata scaffold from buildReceiptMetadata
 * @param {object} [opts] - Optional overrides for readiness state
 * @param {string} [opts.metadataUri] - Uploaded metadata JSON URI
 * @param {string} [opts.imageUri] - Uploaded image URI
 * @param {string} [opts.externalUrl] - Public receipt/proof page URL
 * @param {string} [opts.proofWalletPubkey] - Proof wallet public key
 * @param {string} [opts.mintAuthorityPubkey] - Mint authority public key
 * @param {boolean} [opts.approved] - Explicit mint approval given
 * @param {string} [opts.approvedBy] - Who approved (human-readable)
 * @param {string} [opts.network] - Override default network
 * @returns {object} Mint-readiness plan
 */
export function buildMintPlan(receipt, metadata, opts = {}) {
  const blockers = computeBlockers(metadata, opts);
  const steps = buildRequiredSteps(metadata, opts);
  const mintReady = blockers.length === 0;

  return {
    // Proof references
    receipt_id: receipt.receipt_id,
    receipt_hash: receipt.receipt_hash,
    candidate_hash: receipt.candidate_hash,
    receipt_type: receipt.receipt_type,
    verification_status: receipt.verification_status,
    receipt_version: receipt.receipt_version,

    // Mint target
    network: opts.network || DEFAULT_NETWORK,
    token_standard: TOKEN_STANDARD,
    proof_nft_type: PROOF_NFT_TYPE,

    // References
    metadata_scaffold_ref: metadata.name,
    metadata_uri: opts.metadataUri || null,
    image_uri: opts.imageUri || null,
    external_url: opts.externalUrl || metadata.external_url || null,
    proof_wallet_pubkey: opts.proofWalletPubkey || null,
    mint_authority_pubkey: opts.mintAuthorityPubkey || null,

    // Readiness
    mint_ready: mintReady,
    mint_blockers: blockers,
    required_before_mint: steps,

    // Safety
    _mint_scaffold: {
      version: PLAN_VERSION,
      status: mintReady ? 'ready' : 'blocked',
      notes: mintReady
        ? 'All blockers resolved. Ready for mint execution with explicit approval on record.'
        : 'Mint plan only. All blockers must be resolved and explicit approval given before minting.',
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Batch
// ═══════════════════════════════════════════════════════════════

/**
 * Build mint plans for arrays of receipts and metadata scaffolds.
 *
 * @param {object[]} receipts - Canonical v1.2 receipts
 * @param {object[]} metadataList - E1 metadata scaffolds (same order)
 * @param {object} [opts] - Optional overrides applied to all plans
 * @returns {object[]} Array of mint-readiness plans
 */
export function buildMintPlanBatch(receipts, metadataList, opts = {}) {
  return receipts.map((r, i) => {
    const meta = metadataList[i];
    return buildMintPlan(r, meta, opts);
  });
}
