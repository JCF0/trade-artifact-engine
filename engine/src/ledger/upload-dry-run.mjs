/**
 * Upload Dry Run — E5
 *
 * Pure function: E4 upload package entries + E4 metadata templates
 * → resolved dry-run metadata with simulated URIs + manifest.
 *
 * Proves placeholder resolution works without real upload.
 * Simulated URIs use `artifact-dryrun://` protocol — never real URLs.
 *
 * This module does NOT:
 *   - Upload to Arweave/Irys or any storage
 *   - Mint anything on-chain
 *   - Create or load keypairs
 *   - Read .env / secrets
 *   - Call Solana RPC, Metaplex/UMI, Irys, Arweave, or any network service
 *   - Mutate E1/E2/E3/E4 artifacts
 *   - Use Date.now() or perform I/O
 *   - Include timestamps or random values in resolved files
 */

import { createHash } from 'crypto';
import { sanitizeFilename } from './receipt-image-svg.mjs';

const DRY_RUN_VERSION = '1.0.0';

// Known placeholder types and their resolution strategy
const KNOWN_PLACEHOLDERS = new Set(['image_uri', 'external_url']);

// ═══════════════════════════════════════════════════════════════
// Fake URI builders
// ═══════════════════════════════════════════════════════════════

function buildSimulatedImageUri(receiptId, imageArtifactHash) {
  return `artifact-dryrun://image/${receiptId}/${imageArtifactHash}`;
}

function buildSimulatedMetadataUri(receiptId, resolvedMetadataHash) {
  return `artifact-dryrun://metadata/${receiptId}/${resolvedMetadataHash}`;
}

// ═══════════════════════════════════════════════════════════════
// Placeholder resolution
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve placeholders in a template object. Returns a new object.
 *
 * Known placeholders are replaced with resolved values.
 * Unknown placeholders are left intact for post-scan detection.
 *
 * @param {*} obj - Template value (may be object, array, or primitive)
 * @param {object} resolutions - Map of placeholder name → resolved value
 * @returns {*} Resolved copy
 */
export function resolvePlaceholders(obj, resolutions) {
  if (obj == null || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => resolvePlaceholders(item, resolutions));
  }

  // Check if this object IS a placeholder
  if (obj.__placeholder) {
    const name = obj.__placeholder;
    if (resolutions.hasOwnProperty(name)) {
      return resolutions[name];
    }
    // Unknown placeholder — leave intact for detection
    return { ...obj };
  }

  // Regular object — recurse into values
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolvePlaceholders(value, resolutions);
  }
  return result;
}

/**
 * Find any remaining unresolved placeholders in a resolved object.
 *
 * @param {*} obj
 * @param {string} [path='']
 * @returns {Array<{ path: string, placeholder: string }>}
 */
export function findUnresolvedPlaceholders(obj, path = '') {
  const found = [];
  if (obj == null || typeof obj !== 'object') return found;

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      found.push(...findUnresolvedPlaceholders(item, `${path}[${i}]`));
    });
    return found;
  }

  if (obj.__placeholder) {
    found.push({ path: path || '(root)', placeholder: obj.__placeholder });
    return found;
  }

  for (const [key, value] of Object.entries(obj)) {
    found.push(...findUnresolvedPlaceholders(value, path ? `${path}.${key}` : key));
  }
  return found;
}

// ═══════════════════════════════════════════════════════════════
// Resolved metadata builder
// ═══════════════════════════════════════════════════════════════

/**
 * Build a resolved dry-run metadata object from an E4 template.
 *
 * - Replaces image_uri placeholders with simulated image URI
 * - Replaces external_url placeholders with null
 * - Strips _template block
 * - Adds _dry_run block (without simulated_metadata_uri to avoid circular hash)
 *
 * @param {object} template - E4 metadata template
 * @param {string} simulatedImageUri - Fake image URI
 * @param {string} sourceTemplateHash - Hash of the source template
 * @returns {{ resolved: object, unresolved: Array }}
 */
export function buildResolvedMetadata(template, simulatedImageUri, sourceTemplateHash) {
  const resolutions = {
    image_uri: simulatedImageUri,
    external_url: null,
  };

  // Resolve placeholders
  let resolved = resolvePlaceholders(template, resolutions);

  // Strip _template, add _dry_run
  delete resolved._template;
  resolved._dry_run = {
    version: DRY_RUN_VERSION,
    status: 'simulated_upload_only',
    simulated_image_uri: simulatedImageUri,
    source_template_hash: sourceTemplateHash,
    notes: 'This file contains simulated URIs and must not be uploaded or minted.',
  };

  // Detect unresolved
  const unresolved = findUnresolvedPlaceholders(resolved);

  return { resolved, unresolved };
}

/**
 * Compute deterministic hash of a resolved metadata object.
 * @param {object} resolved
 * @returns {string} sha256:<hex>
 */
export function hashResolved(resolved) {
  const str = JSON.stringify(resolved, null, 2);
  return `sha256:${createHash('sha256').update(str).digest('hex')}`;
}

// ═══════════════════════════════════════════════════════════════
// Dry-run entry builder
// ═══════════════════════════════════════════════════════════════

const LIVE_UPLOAD_BLOCKERS = [
  'real_uploader_not_configured',
  'actual_upload_not_performed',
  'explicit_upload_approval_required',
];

/**
 * Build a single dry-run manifest entry.
 *
 * @param {object} packageEntry - E4 upload package entry
 * @param {object} template - E4 metadata template
 * @returns {object} Dry-run manifest entry + resolved metadata + path info
 */
export function buildDryRunEntry(packageEntry, template) {
  const receiptId = packageEntry.receipt_id;
  const safeName = sanitizeFilename(receiptId);
  const imageArtifactHash = packageEntry.image_artifact_hash || 'sha256:unknown';

  // Build simulated image URI
  const simulatedImageUri = buildSimulatedImageUri(receiptId, imageArtifactHash);
  const sourceTemplateHash = packageEntry.metadata_template_hash || 'sha256:unknown';

  // Resolve
  const { resolved, unresolved } = buildResolvedMetadata(template, simulatedImageUri, sourceTemplateHash);
  const resolvedHash = hashResolved(resolved);

  // Build simulated metadata URI (uses resolved hash, only in manifest — not in file)
  const simulatedMetadataUri = buildSimulatedMetadataUri(receiptId, resolvedHash);

  const resolvedPath = `data/debug/upload-dry-run-v12/${safeName}.metadata.resolved.dryrun.json`;

  const entry = {
    receipt_id: receiptId,
    receipt_hash: packageEntry.receipt_hash,
    candidate_hash: packageEntry.candidate_hash,

    image_artifact_path: packageEntry.image_artifact_path,
    image_artifact_hash: imageArtifactHash,
    metadata_template_path: packageEntry.metadata_template_path,
    metadata_template_hash: sourceTemplateHash,

    resolved_metadata_path: resolvedPath,
    resolved_metadata_hash: resolvedHash,

    simulated_image_uri: simulatedImageUri,
    simulated_metadata_uri: simulatedMetadataUri,

    upload_mode: 'dry_run',
    upload_status: 'simulated_not_uploaded',
    placeholders_resolved: unresolved.length === 0,
    unresolved_placeholders: unresolved,

    live_upload_ready: false,
    live_upload_blockers: [...LIVE_UPLOAD_BLOCKERS],

    _dry_run_entry: {
      version: DRY_RUN_VERSION,
      status: 'simulated_upload_only',
    },
  };

  return { entry, resolved, resolvedPath: safeName };
}

// ═══════════════════════════════════════════════════════════════
// Batch
// ═══════════════════════════════════════════════════════════════

/**
 * Build dry-run entries for arrays of E4 package entries and templates.
 *
 * @param {object[]} packageEntries - E4 upload package entries
 * @param {object[]} templates - E4 metadata templates (same order)
 * @returns {{ entries: object[], resolvedFiles: Array<{ safeName: string, resolved: object }> }}
 */
export function buildDryRunBatch(packageEntries, templates) {
  const entries = [];
  const resolvedFiles = [];

  for (let i = 0; i < packageEntries.length; i++) {
    const pkg = packageEntries[i];
    const tmpl = templates[i];
    const { entry, resolved, resolvedPath } = buildDryRunEntry(pkg, tmpl);
    entries.push(entry);
    resolvedFiles.push({ safeName: resolvedPath, resolved });
  }

  return { entries, resolvedFiles };
}
