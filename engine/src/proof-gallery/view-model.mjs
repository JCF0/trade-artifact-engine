import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { DISCLOSURE_TEXT } from '../proof-trust/disclosures.mjs';
import { DEFAULT_ENGINE_ROOT, V12_DEBUG_ARTIFACTS } from '../inventory/scanner.mjs';
import { buildInventorySnapshot, getInventoryReceiptProofSource } from '../inventory/inventory.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofCardView } from '../proof-card/view-model.mjs';

export const SAMPLE_GALLERY_MANIFEST_PATH = 'samples/sample-gallery.manifest.json';

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasCanonicalInventory(engineRoot) {
  const receiptsPath = resolve(engineRoot, V12_DEBUG_ARTIFACTS.receipts);
  return existsSync(receiptsPath);
}

function shortenHash(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function buildGalleryItem(cardView) {
  return {
    receipt_hash: cardView.receipt.receipt_hash,
    receipt_hash_short: cardView.receipt.receipt_hash_short,
    receipt_id: cardView.receipt.receipt_id,
    receipt_type: cardView.receipt.receipt_type,
    display_status: cardView.receipt.display_status,
    verification_status: cardView.receipt.verification_status,
    valuation_status: cardView.receipt.valuation_status,
    token_display: cardView.receipt.token_display,
    token_mint: cardView.receipt.token_mint,
    trust: cardView.trust,
    disclosures: cardView.disclosures,
    links: {
      proof_api_path: cardView.links.proof_api_path,
      verifier_api_path: cardView.links.verifier_api_path,
      card_api_path: cardView.receipt.receipt_hash ? `/api/proof/${cardView.receipt.receipt_hash}/card` : null,
      card_preview_path: cardView.receipt.receipt_hash ? `/api/proof/${cardView.receipt.receipt_hash}/card/preview` : null,
      hosted_preview_path: cardView.receipt.receipt_hash ? `/api/proof/${cardView.receipt.receipt_hash}/hosted-preview` : null,
    },
  };
}

export function readSampleGalleryManifest({ engineRoot = DEFAULT_ENGINE_ROOT } = {}) {
  const manifestPath = resolve(engineRoot, SAMPLE_GALLERY_MANIFEST_PATH);
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return {
    path: manifestPath,
    version: manifest?.version || null,
    title: manifest?.title || 'Artifact Sample Gallery',
    receipt_hashes: Array.isArray(manifest?.receipt_hashes) ? manifest.receipt_hashes.filter(value => typeof value === 'string') : [],
  };
}

export function buildProofGalleryView(options = {}) {
  const engineRoot = options.engineRoot || DEFAULT_ENGINE_ROOT;
  const walletDisplayMode = options.walletDisplayMode || 'full';
  const limit = Math.max(0, toInteger(options.limit, Number.MAX_SAFE_INTEGER));
  const offset = Math.max(0, toInteger(options.offset, 0));
  const receiptType = options.receiptType || null;
  const manifest = options.manifest === undefined
    ? readSampleGalleryManifest({ engineRoot })
    : options.manifest;

  if (options.packageRoot === undefined && !hasCanonicalInventory(engineRoot)) {
    return {
      gallery_type: 'artifact_sample_gallery',
      title: manifest?.title || 'Artifact Sample Gallery',
      subtitle: 'Selected sample receipts only. Not a portfolio statement.',
      count: 0,
      empty: true,
      disclosures: [
        DISCLOSURE_TEXT.selectedReceiptOnly,
        DISCLOSURE_TEXT.rawQuoteOnly,
      ],
      items: [],
    };
  }

  const snapshot = buildInventorySnapshot({
    engineRoot,
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    ...(options.archiveRoot === undefined ? {} : { archiveRoot: options.archiveRoot }),
    ...(options.economicsRoot === undefined ? {} : { economicsRoot: options.economicsRoot }),
    includeLegacy: false,
    includeExcluded: false,
  });

  const finish = resolvedSnapshot => {
    const receiptByHash = new Map(resolvedSnapshot.receipts.map(receipt => [receipt.receipt_hash, receipt]));
    let orderedReceipts;

    if (manifest && Array.isArray(manifest.receipt_hashes)) {
      orderedReceipts = manifest.receipt_hashes
        .map(receiptHash => receiptByHash.get(receiptHash))
        .filter(Boolean);
    } else {
      orderedReceipts = [...resolvedSnapshot.receipts];
    }

    if (receiptType) {
      orderedReceipts = orderedReceipts.filter(receipt => receipt.receipt_type === receiptType);
    }

    const pagedReceipts = orderedReceipts.slice(offset, offset + limit);
    const items = pagedReceipts.map(receipt => {
      const proofSource = getInventoryReceiptProofSource(resolvedSnapshot, receipt.receipt_hash);
      const proofDetail = buildProofDetailView(proofSource);
      const cardView = buildProofCardView(proofDetail, { walletDisplayMode });
      return buildGalleryItem(cardView);
    });

    return {
      gallery_type: 'artifact_sample_gallery',
      title: manifest?.title || 'Artifact Sample Gallery',
      subtitle: 'Selected sample receipts only. Not a portfolio statement.',
      count: items.length,
      empty: items.length === 0,
      disclosures: [
        DISCLOSURE_TEXT.selectedReceiptOnly,
        DISCLOSURE_TEXT.rawQuoteOnly,
      ],
      items,
    };
  };
  return typeof snapshot?.then === 'function' ? snapshot.then(finish) : finish(snapshot);
}

export { shortenHash };