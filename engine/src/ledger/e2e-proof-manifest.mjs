/**
 * End-to-End Proof Manifest — F
 *
 * Pure function: all v1.2 stage outputs → unified proof manifest.
 *
 * Ties together canonical receipts, verification, valuation, preview,
 * image artifacts, metadata, upload results, and mint results into
 * a single manifest showing the proof status of each receipt.
 *
 * This module does NOT:
 *   - Upload, mint, or perform any network calls
 *   - Access keypairs, .env, or secrets
 *   - Modify any input artifacts
 *   - Use Date.now() or perform I/O
 */

const MANIFEST_VERSION = '1.0.0';

// ═══════════════════════════════════════════════════════════════
// Proof status derivation
// ═══════════════════════════════════════════════════════════════

/**
 * Derive proof_status for a single receipt.
 *
 * @param {object} opts
 * @param {boolean} opts.verified - Receipt passed verification
 * @param {boolean} opts.uploaded - Upload complete with usable URIs
 * @param {boolean} opts.minted - Mint completed with tx signature
 * @returns {string}
 */
export function deriveProofStatus(opts) {
  if (!opts.verified) return 'UNVERIFIED';
  if (opts.minted) return 'PROVEN';
  if (opts.uploaded) return 'UPLOADED_NOT_MINTED';
  return 'VERIFIED_NOT_UPLOADED';
}

/**
 * Derive summary status from proof statuses.
 *
 * @param {string[]} statuses
 * @returns {string}
 */
export function deriveSummaryStatus(statuses) {
  if (statuses.length === 0) return 'NONE';
  const hasUnverified = statuses.includes('UNVERIFIED');
  const allProven = statuses.every(s => s === 'PROVEN');
  const someProven = statuses.some(s => s === 'PROVEN');

  if (hasUnverified) return 'FAIL';
  if (allProven) return 'FULL';
  if (someProven) return 'PARTIAL';
  return 'NONE';
}

// ═══════════════════════════════════════════════════════════════
// Single receipt manifest entry
// ═══════════════════════════════════════════════════════════════

/**
 * Build an e2e manifest entry for a single receipt.
 *
 * @param {object} params
 * @param {object} params.receipt - Canonical v1.2 receipt
 * @param {object|null} params.verifyResult - B3 verify result
 * @param {object|null} params.valuationCtx - C1 valuation context
 * @param {boolean} params.previewGenerated - D1 preview exists
 * @param {boolean} params.htmlPreviewGenerated - D2 HTML exists
 * @param {object|null} params.imageArtifact - E3 artifact entry
 * @param {boolean} params.metadataScaffoldExists - E1 scaffold exists
 * @param {boolean} params.metadataTemplateExists - E4 template exists
 * @param {object|null} params.uploadResult - E7 upload result
 * @param {object|null} params.mintReadyPlan - E8 plan
 * @param {object|null} params.mintResult - E9 mint result
 * @returns {object}
 */
export function buildManifestEntry(params) {
  const { receipt, verifyResult, valuationCtx, imageArtifact, uploadResult, mintReadyPlan, mintResult } = params;

  const verified = verifyResult ? verifyResult.pass === true : false;
  const uploaded = uploadResult
    && (uploadResult.upload_status === 'complete' || uploadResult.upload_status === 'uploaded_but_local_write_failed')
    && !!uploadResult.final_image_uri
    && !!uploadResult.final_metadata_uri;
  const minted = mintResult
    && mintResult.mint_status === 'minted'
    && !!mintResult.transaction_signature;

  const proofStatus = deriveProofStatus({ verified, uploaded, minted });

  return {
    receipt_id: receipt.receipt_id,
    receipt_type: receipt.receipt_type,
    receipt_hash: receipt.receipt_hash,
    candidate_hash: receipt.candidate_hash,

    verification: {
      status: receipt.verification_status,
      pass: verified,
      violations: verifyResult ? verifyResult.rule_violations.length : null,
    },

    valuation: {
      status: valuationCtx?.valuation_status || receipt.valuation_status || 'raw_quote',
      valid: valuationCtx ? valuationCtx.has_no_usd_normalization_disclosure === true : null,
      quote_symbol: receipt.quote_symbol,
      quote_is_usd_stable: valuationCtx?.quote_is_usd_stable ?? null,
    },

    preview: {
      generated: !!params.previewGenerated,
    },

    html_preview: {
      generated: !!params.htmlPreviewGenerated,
    },

    image: {
      generated: !!imageArtifact,
      artifact_type: imageArtifact?.artifact_type || null,
      local_path: imageArtifact?.local_path || null,
      artifact_hash: imageArtifact?.artifact_hash || null,
    },

    metadata: {
      scaffold: !!params.metadataScaffoldExists,
      template: !!params.metadataTemplateExists,
    },

    upload: uploaded ? {
      status: uploadResult.upload_status,
      image_uri: uploadResult.final_image_uri,
      metadata_uri: uploadResult.final_metadata_uri,
    } : {
      status: uploadResult?.upload_status || 'not_uploaded',
      image_uri: null,
      metadata_uri: null,
    },

    mint_ready: {
      upload_result_used: mintReadyPlan?.upload_result_used ?? false,
      remaining_blockers: mintReadyPlan?.mint_blockers || [],
    },

    mint: minted ? {
      status: mintResult.mint_status,
      mint_address: mintResult.mint_address,
      token_account: mintResult.token_account,
      transaction_signature: mintResult.transaction_signature,
      network: mintResult.network,
      token_standard: mintResult.token_standard,
      transferability: mintResult.transferability,
      metadata_linkage: mintResult.metadata_linkage,
      proof_wallet_pubkey: mintResult.proof_wallet_pubkey,
      mint_authority_pubkey: mintResult.mint_authority_pubkey,
    } : {
      status: mintResult?.mint_status || 'not_minted',
    },

    proof_status: proofStatus,

    _e2e_manifest: {
      version: MANIFEST_VERSION,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Full manifest builder
// ═══════════════════════════════════════════════════════════════

/**
 * Build the complete e2e proof manifest.
 *
 * @param {object} inputs
 * @param {string} inputs.wallet
 * @param {string} inputs.chain
 * @param {string} inputs.network
 * @param {object[]} inputs.receipts - Canonical v1.2 receipts
 * @param {object} inputs.verifyReport - B3 batch verify report
 * @param {object[]} inputs.valuationContexts - C1 contexts (same order as receipts)
 * @param {boolean} inputs.previewsGenerated - D1 previews exist
 * @param {boolean} inputs.htmlPreviewGenerated - D2 HTML exists
 * @param {object[]} inputs.imageArtifacts - E3 artifacts (same order)
 * @param {boolean} inputs.metadataScaffoldsExist - E1 scaffolds exist
 * @param {boolean} inputs.metadataTemplatesExist - E4 templates exist
 * @param {Map<string,object>} inputs.uploadResultsMap - E7 results by receipt_id
 * @param {Map<string,object>} inputs.mintReadyPlansMap - E8 plans by receipt_id
 * @param {Map<string,object>} inputs.mintResultsMap - E9 results by receipt_id
 * @returns {object} Complete manifest
 */
export function buildE2EProofManifest(inputs) {
  const verifyByReceiptId = new Map();
  if (inputs.verifyReport?.results) {
    for (const r of inputs.verifyReport.results) {
      verifyByReceiptId.set(r.receipt_id, r);
    }
  }

  const entries = inputs.receipts.map((receipt, i) => {
    const receiptId = receipt.receipt_id;
    return buildManifestEntry({
      receipt,
      verifyResult: verifyByReceiptId.get(receiptId) || null,
      valuationCtx: inputs.valuationContexts?.[i] || null,
      previewGenerated: inputs.previewsGenerated,
      htmlPreviewGenerated: inputs.htmlPreviewGenerated,
      imageArtifact: inputs.imageArtifacts?.[i] || null,
      metadataScaffoldExists: inputs.metadataScaffoldsExist,
      metadataTemplateExists: inputs.metadataTemplatesExist,
      uploadResult: inputs.uploadResultsMap?.get(receiptId) || null,
      mintReadyPlan: inputs.mintReadyPlansMap?.get(receiptId) || null,
      mintResult: inputs.mintResultsMap?.get(receiptId) || null,
    });
  });

  const statuses = entries.map(e => e.proof_status);
  const summaryStatus = deriveSummaryStatus(statuses);

  return {
    manifest_version: MANIFEST_VERSION,
    wallet: inputs.wallet,
    chain: inputs.chain,
    network: inputs.network || 'devnet',
    receipt_count: entries.length,
    summary: {
      verified_count: entries.filter(e => e.verification.pass).length,
      uploaded_count: entries.filter(e => e.upload.image_uri !== null).length,
      minted_count: entries.filter(e => e.mint.status === 'minted').length,
      fully_proven_count: entries.filter(e => e.proof_status === 'PROVEN').length,
      status: summaryStatus,
    },
    receipts: entries,
  };
}
