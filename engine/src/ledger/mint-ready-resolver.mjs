/**
 * Mint-Ready Resolver — E8
 *
 * Pure function: receipts + metadata scaffolds + upload results + package hashes
 * → resolved mint-readiness plans.
 *
 * Bridges E2 mint-plan builder with E7 upload result URIs.
 * Does NOT mutate E2 mint plans, upload results, or any other artifact.
 *
 * This module does NOT:
 *   - Upload to Arweave/Irys or any storage
 *   - Mint anything on-chain
 *   - Create or load keypairs
 *   - Read .env / secrets
 *   - Call Solana RPC, Metaplex/UMI, Irys, Arweave, or any network service
 *   - Use Date.now() or perform I/O
 */

import { buildMintPlan } from './mint-plan.mjs';

const RESOLVER_VERSION = '1.0.0';

// ═══════════════════════════════════════════════════════════════
// Upload freshness check
// ═══════════════════════════════════════════════════════════════

/**
 * Check whether an upload result's URIs can be trusted.
 *
 * Compares source hashes from the upload result against current
 * package hashes. Stale uploads are not trusted.
 *
 * @param {object|null} uploadResult - E7 upload result entry
 * @param {string} currentImageHash - Current E3/E4 image artifact hash
 * @param {string} currentTemplateHash - Current E4 template hash
 * @returns {{ fresh: boolean, uriUsable: boolean, reason: string }}
 */
export function checkUploadFreshness(uploadResult, currentImageHash, currentTemplateHash) {
  if (!uploadResult) {
    return { fresh: false, uriUsable: false, reason: 'no_upload_result' };
  }

  const status = uploadResult.upload_status;

  if (status === 'failed') {
    return { fresh: false, uriUsable: false, reason: 'upload_failed' };
  }

  if (status === 'partial_image_only') {
    return { fresh: false, uriUsable: false, reason: 'upload_partial' };
  }

  const hasUris = !!uploadResult.final_image_uri && !!uploadResult.final_metadata_uri;
  if (!hasUris) {
    return { fresh: false, uriUsable: false, reason: 'uris_missing' };
  }

  const imageMatch = uploadResult.source_image_artifact_hash === currentImageHash;
  const templateMatch = uploadResult.source_metadata_template_hash === currentTemplateHash;

  if (!imageMatch) {
    return { fresh: false, uriUsable: false, reason: 'image_hash_stale' };
  }
  if (!templateMatch) {
    return { fresh: false, uriUsable: false, reason: 'template_hash_stale' };
  }

  if (status === 'complete') {
    return { fresh: true, uriUsable: true, reason: 'complete_and_fresh' };
  }

  if (status === 'uploaded_but_local_write_failed') {
    return { fresh: false, uriUsable: true, reason: 'uri_usable_local_write_failed' };
  }

  return { fresh: false, uriUsable: false, reason: `unknown_status_${status}` };
}

// ═══════════════════════════════════════════════════════════════
// Single plan resolver
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve a single mint-readiness plan from receipt + metadata + upload state.
 *
 * @param {object} receipt - Canonical v1.2 receipt
 * @param {object} metadata - E1 metadata scaffold
 * @param {object|null} uploadResult - E7 upload result entry, or null
 * @param {string} currentImageHash - Current image artifact hash
 * @param {string} currentTemplateHash - Current template hash
 * @param {object} [extraOpts] - Additional opts for buildMintPlan (wallet, authority, approval)
 * @returns {object} Resolved mint-readiness plan with annotations
 */
export function resolveMintPlan(receipt, metadata, uploadResult, currentImageHash, currentTemplateHash, extraOpts = {}) {
  const freshness = checkUploadFreshness(uploadResult, currentImageHash, currentTemplateHash);

  // Build E2 mint plan opts based on upload freshness
  const mintOpts = { ...extraOpts };
  let uploadStatus = 'not_uploaded';
  let imageUri = null;
  let metadataUri = null;

  if (freshness.uriUsable) {
    mintOpts.imageUri = uploadResult.final_image_uri;
    mintOpts.metadataUri = uploadResult.final_metadata_uri;
    imageUri = uploadResult.final_image_uri;
    metadataUri = uploadResult.final_metadata_uri;
    uploadStatus = uploadResult.upload_status;
  } else if (uploadResult) {
    uploadStatus = uploadResult.upload_status || 'unknown';
  }

  // Call E2's buildMintPlan with resolved opts
  const plan = buildMintPlan(receipt, metadata, mintOpts);

  // Compute resolved blockers (blockers that were present without upload but are now gone)
  const baselinePlan = buildMintPlan(receipt, metadata, extraOpts);
  const resolvedBlockers = baselinePlan.mint_blockers.filter(b => !plan.mint_blockers.includes(b));

  return {
    receipt_id: plan.receipt_id,
    receipt_hash: plan.receipt_hash,
    candidate_hash: plan.candidate_hash,
    receipt_type: plan.receipt_type,
    verification_status: plan.verification_status,

    upload_status: uploadStatus,
    upload_fresh: freshness.fresh,
    upload_result_used: freshness.uriUsable,
    source_hashes_verified: freshness.fresh || (freshness.uriUsable && freshness.reason === 'uri_usable_local_write_failed'),
    final_image_uri: imageUri,
    final_metadata_uri: metadataUri,

    mint_ready: plan.mint_ready,
    mint_blockers: plan.mint_blockers,
    resolved_blockers: resolvedBlockers,
    required_before_mint: plan.required_before_mint,

    network: plan.network,
    token_standard: plan.token_standard,
    proof_nft_type: plan.proof_nft_type,

    _mint_ready_resolver: {
      version: RESOLVER_VERSION,
      upload_result_used: freshness.uriUsable,
      source_hashes_verified: freshness.fresh || (freshness.uriUsable && freshness.reason === 'uri_usable_local_write_failed'),
      freshness_reason: freshness.reason,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Batch resolver
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve mint-readiness plans for a batch.
 *
 * @param {object[]} receipts - Canonical v1.2 receipts
 * @param {object[]} metadataList - E1 metadata scaffolds (same order)
 * @param {Map<string, object>} uploadResultsMap - E7 results indexed by receipt_id
 * @param {Map<string, object>} packageMap - E4 packages indexed by receipt_id
 * @param {object} [extraOpts] - Additional opts (wallet, authority, approval)
 * @returns {{ plans: object[], summary: object }}
 */
export function resolveMintPlanBatch(receipts, metadataList, uploadResultsMap, packageMap, extraOpts = {}) {
  const plans = [];

  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];
    const metadata = metadataList[i];
    const receiptId = receipt.receipt_id;
    const uploadResult = uploadResultsMap.get(receiptId) || null;
    const pkg = packageMap.get(receiptId) || {};

    const plan = resolveMintPlan(
      receipt, metadata, uploadResult,
      pkg.image_artifact_hash || '',
      pkg.metadata_template_hash || '',
      extraOpts
    );
    plans.push(plan);
  }

  // Summary
  const uploadCompleteCount = plans.filter(p =>
    p.upload_status === 'complete' && p.upload_fresh === true
  ).length;

  const uploadUriUsableCount = plans.filter(p => p.upload_result_used === true).length;
  const mintReadyCount = plans.filter(p => p.mint_ready === true).length;
  const mintBlockedCount = plans.filter(p => p.mint_ready === false).length;

  const blockersSummary = {};
  for (const p of plans) {
    for (const b of p.mint_blockers) {
      blockersSummary[b] = (blockersSummary[b] || 0) + 1;
    }
  }

  return {
    plans,
    summary: {
      receipt_count: plans.length,
      upload_complete_count: uploadCompleteCount,
      upload_uri_usable_count: uploadUriUsableCount,
      mint_ready_count: mintReadyCount,
      mint_blocked_count: mintBlockedCount,
      blockers_summary: blockersSummary,
    },
  };
}
