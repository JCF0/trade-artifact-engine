/**
 * Upload Package Scaffold — E4
 *
 * Pure function: E1 metadata scaffolds + E3 image artifact manifest
 * → per-receipt metadata templates with structured placeholders
 * + upload package manifest.
 *
 * Templates are NOT final Metaplex metadata. They contain explicit
 * __placeholder objects that must be resolved with hosted URIs
 * and _template stripped before actual upload/mint in E5.
 *
 * This module does NOT:
 *   - Upload to Arweave/Irys or any storage
 *   - Mint anything on-chain
 *   - Create or load keypairs
 *   - Read .env / secrets
 *   - Call Solana RPC or Metaplex/UMI
 *   - Modify E1 metadata scaffolds or E2 mint plans
 *   - Use Date.now() or perform I/O
 *   - Include timestamps or random values in templates
 */

import { createHash } from 'crypto';
import { sanitizeFilename } from './receipt-image-svg.mjs';

const PACKAGE_VERSION = '1.0.0';
const TEMPLATE_VERSION = '1.0.0';

// ═══════════════════════════════════════════════════════════════
// Placeholder builders
// ═══════════════════════════════════════════════════════════════

function imagePlaceholder(localArtifactPath) {
  return {
    __placeholder: 'image_uri',
    status: 'awaiting_upload',
    local_artifact: localArtifactPath || null,
  };
}

function externalUrlPlaceholder() {
  return {
    __placeholder: 'external_url',
    status: 'awaiting_configuration',
    value: null,
  };
}

function fileUriPlaceholder() {
  return {
    __placeholder: 'image_uri',
    status: 'awaiting_upload',
  };
}

// ═══════════════════════════════════════════════════════════════
// buildMetadataTemplate
// ═══════════════════════════════════════════════════════════════

/**
 * Build a metadata template from an E1 metadata scaffold and E3 artifact info.
 *
 * Replaces E1's _scaffold with _template. Replaces null URI fields with
 * structured __placeholder objects. Deterministic — no timestamps or
 * random values in the template itself.
 *
 * @param {object} metadata - E1 metadata scaffold
 * @param {object} artifact - E3 image artifact entry from manifest
 * @returns {object} Metadata template with placeholders
 */
export function buildMetadataTemplate(metadata, artifact) {
  const localPath = artifact?.local_path || null;

  // Deep copy properties and replace files
  const properties = { ...metadata.properties };
  properties.files = [
    {
      uri: fileUriPlaceholder(),
      type: artifact?.content_type || 'image/svg+xml',
    },
  ];

  // Build template — no _scaffold, has _template
  const template = {
    name: metadata.name,
    symbol: metadata.symbol,
    description: metadata.description,
    image: imagePlaceholder(localPath),
    external_url: externalUrlPlaceholder(),
    attributes: metadata.attributes ? [...metadata.attributes] : [],
    properties: {
      ...properties,
      limitations: properties.limitations
        ? { ...properties.limitations, disclosures: [...(properties.limitations.disclosures || [])] }
        : properties.limitations,
    },
    _template: {
      version: TEMPLATE_VERSION,
      status: 'pending_upload',
      placeholders: ['image_uri', 'external_url'],
      source_scaffold: 'E1 metadata scaffold',
      image_artifact_hash: artifact?.artifact_hash || null,
      notes: 'Template with placeholders. Replace __placeholder objects with hosted URIs before upload. Strip _template block before minting.',
    },
  };

  return template;
}

/**
 * Compute a deterministic hash for a metadata template.
 * @param {object} template
 * @returns {string} sha256:<hex>
 */
export function hashTemplate(template) {
  const str = JSON.stringify(template, null, 2);
  const hash = createHash('sha256').update(str).digest('hex');
  return `sha256:${hash}`;
}

// ═══════════════════════════════════════════════════════════════
// buildUploadPackageEntry
// ═══════════════════════════════════════════════════════════════

/**
 * Build a single upload package entry.
 *
 * @param {object} metadata - E1 metadata scaffold
 * @param {object} artifact - E3 image artifact entry
 * @param {object} template - Built metadata template
 * @param {string} templateHash - Hash of the template
 * @returns {object} Package entry
 */
function buildPackageEntry(metadata, artifact, template, templateHash) {
  const receiptId = metadata.properties?.receipt_id || metadata.name;
  const safeName = sanitizeFilename(receiptId);
  const templatePath = `data/debug/metadata-packages-v12/${safeName}.metadata.template.json`;

  const blockers = ['image_not_uploaded', 'metadata_not_uploaded'];

  return {
    receipt_id: receiptId,
    receipt_hash: metadata.properties?.receipt_hash || null,
    candidate_hash: metadata.properties?.candidate_hash || null,

    metadata_template_path: templatePath,
    metadata_template_hash: templateHash,
    metadata_content_type: 'application/json',

    image_artifact_path: artifact?.local_path || null,
    image_artifact_hash: artifact?.artifact_hash || null,
    image_content_type: artifact?.content_type || 'image/svg+xml',

    upload_status: 'not_uploaded',
    image_uri: null,
    metadata_uri: null,
    external_url: null,

    upload_order: ['image', 'metadata'],

    upload_blockers: blockers,
    required_before_upload: [
      { step: 'upload_image', status: 'not_started', uri: null },
      { step: 'upload_metadata', status: 'not_started', uri: null },
    ],

    _upload_scaffold: {
      version: PACKAGE_VERSION,
      status: 'blocked',
      notes: 'Upload package scaffold. Image must be uploaded first, then metadata template populated with hosted URIs and uploaded.',
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// buildUploadPackage (batch)
// ═══════════════════════════════════════════════════════════════

/**
 * Build upload package entries + metadata templates for arrays of
 * E1 metadata scaffolds and E3 image artifacts.
 *
 * Pure function: no I/O, no Date.now().
 *
 * @param {object[]} metadataList - E1 metadata scaffolds
 * @param {object[]} artifacts - E3 image artifact entries (same order)
 * @returns {{ packages: object[], templates: Array<{ receiptId: string, template: object, templateHash: string }> }}
 */
export function buildUploadPackage(metadataList, artifacts) {
  const packages = [];
  const templates = [];

  for (let i = 0; i < metadataList.length; i++) {
    const metadata = metadataList[i];
    const artifact = artifacts[i] || {};

    const template = buildMetadataTemplate(metadata, artifact);
    const templateHash = hashTemplate(template);
    const entry = buildPackageEntry(metadata, artifact, template, templateHash);

    packages.push(entry);
    templates.push({
      receiptId: metadata.properties?.receipt_id || `unknown_${i}`,
      template,
      templateHash,
    });
  }

  return { packages, templates };
}
