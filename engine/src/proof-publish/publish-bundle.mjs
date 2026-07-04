import { renderStaticProofPage } from '../proof-export/render-static-page.mjs';
import { applyWalletDisplayPolicy } from './wallet-policy.mjs';
import { buildPublishSlug } from './slug.mjs';

const VALID_VISIBILITY = new Set(['unlisted', 'public', 'private']);

function normalizeVisibility(value) {
  if (value == null) return 'unlisted';
  if (!VALID_VISIBILITY.has(value)) {
    throw new TypeError(`Unsupported visibility: ${value}`);
  }
  return value;
}

const VALID_WALLET_DISPLAY_MODES = new Set(['truncated', 'redacted', 'full']);

function normalizeWalletDisplayMode(value) {
  if (value == null) return 'truncated';
  if (!VALID_WALLET_DISPLAY_MODES.has(value)) {
    throw new TypeError('Unsupported wallet display mode: ' + value);
  }
  return value;
}

function normalizeBaseUrl(value) {
  if (value == null || value === '') return null;
  return String(value).replace(/\/+$/g, '');
}

function buildHostedUrl(baseUrl, slug) {
  if (baseUrl == null) return './index.html';
  return `${baseUrl}/${slug}/index.html`;
}

function toJsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildPublishBundle(proofDetail, options = {}) {
  if (!proofDetail || typeof proofDetail !== 'object') {
    throw new TypeError('proofDetail is required');
  }

  const receiptHash = proofDetail.receipt?.receipt_hash;
  if (typeof receiptHash !== 'string' || receiptHash.length === 0) {
    throw new TypeError('proofDetail.receipt.receipt_hash is required');
  }

  const generatedAt = options.generatedAt || new Date().toISOString();
  const visibility = normalizeVisibility(options.visibility);
  const walletDisplayMode = normalizeWalletDisplayMode(options.wallet_display_mode);
  const baseUrl = normalizeBaseUrl(options.base_url);
  const slug = buildPublishSlug(receiptHash);
  const hostedUrl = buildHostedUrl(baseUrl, slug);
  const publishedProofDetail = applyWalletDisplayPolicy(proofDetail, { mode: walletDisplayMode });

  const manifest = {
    bundle_version: 'v1.4',
    bundle_type: 'hosted_proof_bundle',
    receipt_hash: receiptHash,
    slug,
    visibility,
    wallet_display_mode: walletDisplayMode,
    base_url: baseUrl,
    hosted_url: hostedUrl,
    generated_at: generatedAt,
    files: {
      'index.html': 'index.html',
      'proof.json': 'proof.json',
    },
    render_context: {
      hosted: true,
      selected_receipt_only: true,
      raw_quote_only: true,
      unlisted_not_private: visibility === 'unlisted',
    },
  };

  const proofJson = {
    publish: {
      bundle_version: 'v1.4',
      slug,
      visibility,
      wallet_display_mode: walletDisplayMode,
      base_url: baseUrl,
      hosted_url: hostedUrl,
    },
    proof: publishedProofDetail,
  };

  const indexHtml = renderStaticProofPage(proofDetail, {
    generatedAt,
    hosted: {
      walletDisplayMode,
      visibility,
    },
  });

  const files = {
    'index.html': indexHtml,
    'proof.json': toJsonFile(proofJson),
    'manifest.json': toJsonFile(manifest),
  };

  return {
    slug,
    manifest,
    proofJson,
    indexHtml,
    files,
  };
}



