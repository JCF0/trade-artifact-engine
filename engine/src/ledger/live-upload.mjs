/**
 * Live Upload Integration — E6
 *
 * Guarded upload adapter: E4 templates + E3 SVGs → Irys upload
 * → final metadata + result manifest.
 *
 * Dry-run is default. Live upload requires ALL gates to pass:
 *   1. --ledger-debug
 *   2. --upload-live
 *   3. --upload-confirm
 *   4. UPLOAD_ENABLED=true
 *   5. IRYS_KEYPAIR_PATH defined
 *   6. Keypair file exists
 *   7. Network is devnet (default)
 *   8. Receipt limit set (--upload-max N or --upload-receipt-id <id>)
 *
 * This module does NOT:
 *   - Print .env contents, private keys, or keypair arrays
 *   - Mint anything on-chain
 *   - Submit Solana transactions (except Irys upload txns when live)
 *   - Change v1.1 upload/mint behavior
 *   - Modify receipt schemas, hashes, or verifier logic
 *   - Fetch prices or add USD normalization
 */

import { createHash } from 'crypto';
import { resolvePlaceholders, findUnresolvedPlaceholders } from './upload-dry-run.mjs';

// ═══════════════════════════════════════════════════════════════
// Gate checking (pure function)
// ═══════════════════════════════════════════════════════════════

/**
 * Check all upload gates. Returns { allowed, blockers }.
 *
 * @param {object} opts
 * @param {boolean} opts.ledgerDebug - --ledger-debug flag
 * @param {boolean} opts.uploadLive - --upload-live flag
 * @param {boolean} opts.uploadConfirm - --upload-confirm flag
 * @param {string|undefined} opts.uploadEnabled - UPLOAD_ENABLED env var value
 * @param {string|undefined} opts.keypairPath - IRYS_KEYPAIR_PATH env var value
 * @param {boolean} opts.keypairFileExists - whether the file exists
 * @param {string} opts.network - target network
 * @param {number|null} opts.uploadMax - --upload-max value
 * @param {string|null} opts.uploadReceiptId - --upload-receipt-id value
 * @returns {{ allowed: boolean, blockers: string[] }}
 */
export function checkUploadGates(opts) {
  const blockers = [];

  if (!opts.ledgerDebug) blockers.push('missing_ledger_debug_flag');
  if (!opts.uploadLive) blockers.push('missing_upload_live_flag');
  if (!opts.uploadConfirm) blockers.push('missing_upload_confirm_flag');
  if (opts.uploadEnabled !== 'true') blockers.push('upload_enabled_not_true');
  if (!opts.keypairPath) blockers.push('irys_keypair_path_not_defined');
  if (opts.keypairPath && !opts.keypairFileExists) blockers.push('keypair_file_not_found');
  if (opts.network !== 'devnet') blockers.push('non_devnet_network_not_approved');
  if (opts.uploadMax == null && opts.uploadReceiptId == null) {
    blockers.push('no_receipt_limit_set');
  }

  return { allowed: blockers.length === 0, blockers };
}

// ═══════════════════════════════════════════════════════════════
// Final metadata generation (pure function)
// ═══════════════════════════════════════════════════════════════

/**
 * Build final upload-ready metadata from an E4 template.
 *
 * Replaces placeholders with real hosted URIs.
 * Strips all scaffold/template/dry-run markers.
 * Result is clean Metaplex-compatible metadata.
 *
 * @param {object} template - E4 metadata template
 * @param {string} imageUri - Real hosted image URI
 * @param {string|null} [externalUrl=null] - Optional external URL
 * @returns {{ metadata: object, unresolved: Array }}
 */
export function buildFinalMetadata(template, imageUri, externalUrl) {
  const resolutions = {
    image_uri: imageUri,
    external_url: externalUrl != null ? externalUrl : null,
  };

  let metadata = resolvePlaceholders(template, resolutions);

  // Strip all internal marker blocks
  delete metadata._template;
  delete metadata._scaffold;
  delete metadata._dry_run;
  delete metadata._upload_scaffold;
  delete metadata._mint_scaffold;

  const unresolved = findUnresolvedPlaceholders(metadata);

  return { metadata, unresolved };
}

/**
 * Hash final metadata deterministically.
 * @param {object} metadata
 * @returns {string} sha256:<hex>
 */
export function hashFinalMetadata(metadata) {
  const str = JSON.stringify(metadata, null, 2);
  return `sha256:${createHash('sha256').update(str).digest('hex')}`;
}

// ═══════════════════════════════════════════════════════════════
// Idempotency (pure function)
// ═══════════════════════════════════════════════════════════════

/**
 * Check whether an upload can be skipped based on existing results.
 *
 * Compares source artifact/template hashes, not final metadata hash.
 *
 * @param {object|null} existingResult - Previous upload result entry, or null
 * @param {string} currentImageHash - Current E3 image artifact hash
 * @param {string} currentTemplateHash - Current E4 metadata template hash
 * @returns {{ skip: boolean, reason: string }}
 */
export function shouldSkipUpload(existingResult, currentImageHash, currentTemplateHash) {
  if (!existingResult) {
    return { skip: false, reason: 'no_existing_result' };
  }

  if (existingResult.upload_status !== 'complete') {
    return { skip: false, reason: 'previous_upload_incomplete' };
  }

  if (!existingResult.final_image_uri || !existingResult.final_metadata_uri) {
    return { skip: false, reason: 'previous_uris_missing' };
  }

  if (existingResult.source_image_artifact_hash !== currentImageHash) {
    return { skip: false, reason: 'image_artifact_changed' };
  }

  if (existingResult.source_metadata_template_hash !== currentTemplateHash) {
    return { skip: false, reason: 'metadata_template_changed' };
  }

  return { skip: true, reason: 'unchanged_artifacts' };
}

// ═══════════════════════════════════════════════════════════════
// Result entry builder (pure function)
// ═══════════════════════════════════════════════════════════════

/**
 * Build an upload result entry.
 *
 * Does not contain secrets, keypair paths, raw keys, or env values.
 *
 * @param {object} params
 * @returns {object} Result manifest entry
 */
export function buildUploadResultEntry(params) {
  return {
    receipt_id: params.receiptId,
    receipt_hash: params.receiptHash,
    candidate_hash: params.candidateHash,

    source_image_artifact_path: params.imageArtifactPath,
    source_image_artifact_hash: params.imageArtifactHash,
    source_metadata_template_path: params.metadataTemplatePath,
    source_metadata_template_hash: params.metadataTemplateHash,

    final_metadata_path: params.finalMetadataPath,
    final_metadata_hash: params.finalMetadataHash,
    final_image_uri: params.finalImageUri,
    final_metadata_uri: params.finalMetadataUri,

    upload_mode: 'live',
    upload_status: params.uploadStatus || 'complete',
    network: params.network || 'devnet',
    uploaded_at: params.uploadedAt || null,
    uploader_pubkey: params.uploaderPubkey || null,
  };
}

/**
 * Build a partial/failed result entry.
 */
export function buildPartialResultEntry(params, error) {
  return {
    receipt_id: params.receiptId,
    receipt_hash: params.receiptHash,
    candidate_hash: params.candidateHash,

    source_image_artifact_path: params.imageArtifactPath,
    source_image_artifact_hash: params.imageArtifactHash,
    source_metadata_template_path: params.metadataTemplatePath,
    source_metadata_template_hash: params.metadataTemplateHash,

    final_metadata_path: null,
    final_metadata_hash: null,
    final_image_uri: params.finalImageUri || null,
    final_metadata_uri: null,

    upload_mode: 'live',
    upload_status: params.finalImageUri ? 'partial_image_only' : 'failed',
    network: params.network || 'devnet',
    uploaded_at: params.uploadedAt || null,
    uploader_pubkey: params.uploaderPubkey || null,
    error_message: error?.message || 'unknown error',
  };
}

// ═══════════════════════════════════════════════════════════════
// Upload orchestrator (async, uses injected uploader)
// ═══════════════════════════════════════════════════════════════

/**
 * Execute live upload for a single receipt.
 *
 * Accepts an injected uploader for testability.
 *
 * @param {object} pkg - E4 upload package entry
 * @param {object} template - E4 metadata template
 * @param {object} uploader - { uploadFile(localPath, opts) → { id } }
 * @param {object} opts - { network, gatewayBase, uploaderPubkey, uploadedAt }
 * @returns {Promise<object>} Upload result entry
 */
export async function uploadSingleReceipt(pkg, template, uploader, opts = {}) {
  const gatewayBase = opts.gatewayBase || 'https://gateway.irys.xyz';
  const receiptId = pkg.receipt_id;
  const baseParams = {
    receiptId,
    receiptHash: pkg.receipt_hash,
    candidateHash: pkg.candidate_hash,
    imageArtifactPath: pkg.image_artifact_path,
    imageArtifactHash: pkg.image_artifact_hash,
    metadataTemplatePath: pkg.metadata_template_path,
    metadataTemplateHash: pkg.metadata_template_hash,
    network: opts.network || 'devnet',
    uploaderPubkey: opts.uploaderPubkey || null,
    uploadedAt: opts.uploadedAt || new Date().toISOString(),
  };

  let imageUri = null;

  // Step 1: Upload image
  try {
    const imageResult = await uploader.uploadFile(pkg.image_artifact_path, {
      tags: [
        { name: 'Content-Type', value: pkg.image_content_type || 'image/svg+xml' },
        { name: 'App-Name', value: 'trade-artifact-engine-v12' },
        { name: 'Receipt-Id', value: receiptId },
        { name: 'Artifact-Hash', value: pkg.image_artifact_hash },
      ],
    });
    imageUri = `${gatewayBase}/${imageResult.id}`;
  } catch (e) {
    return buildPartialResultEntry(baseParams, e);
  }

  // Step 2: Build final metadata
  const { metadata: finalMeta, unresolved } = buildFinalMetadata(template, imageUri, null);
  if (unresolved.length > 0) {
    return buildPartialResultEntry(
      { ...baseParams, finalImageUri: imageUri },
      new Error(`Unresolved placeholders: ${unresolved.map(u => u.placeholder).join(', ')}`)
    );
  }

  const finalMetaStr = JSON.stringify(finalMeta, null, 2);
  const finalMetaHash = `sha256:${createHash('sha256').update(finalMetaStr).digest('hex')}`;

  // Step 3: Upload metadata
  let metadataUri = null;
  try {
    const metaResult = await uploader.uploadFile('__metadata_json__', {
      content: finalMetaStr,
      tags: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'App-Name', value: 'trade-artifact-engine-v12' },
        { name: 'Receipt-Id', value: receiptId },
        { name: 'Metadata-Hash', value: finalMetaHash },
      ],
    });
    metadataUri = `${gatewayBase}/${metaResult.id}`;
  } catch (e) {
    return buildPartialResultEntry(
      { ...baseParams, finalImageUri: imageUri },
      e
    );
  }

  // Step 4: Build complete result
  const safeName = receiptId.replace(/[^A-Za-z0-9_-]/g, '_');
  const finalMetadataPath = `data/debug/upload-results-v12/${safeName}.metadata.final.json`;

  return {
    result: buildUploadResultEntry({
      ...baseParams,
      finalMetadataPath,
      finalMetadataHash: finalMetaHash,
      finalImageUri: imageUri,
      finalMetadataUri: metadataUri,
    }),
    finalMetadata: finalMeta,
    finalMetadataStr: finalMetaStr,
    finalMetadataPath,
  };
}
