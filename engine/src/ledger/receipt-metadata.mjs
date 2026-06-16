/**
 * Receipt Metadata Scaffold — E1
 *
 * Pure function: v1.2 receipt + D1 preview + optional valuation context
 * → Metaplex-compatible metadata-ready JSON scaffold.
 *
 * This module does NOT:
 *   - Upload to Arweave/Irys or any storage
 *   - Mint anything on-chain
 *   - Use keypairs or read .env / secrets
 *   - Modify receipts, hashes, or verification logic
 *   - Fetch prices or convert to USD
 *   - Use Date.now() or perform I/O
 *
 * Metadata scaffold includes placeholder fields (image, external_url,
 * files) marked via `_scaffold` block. These must be populated and
 * `_scaffold` stripped before actual minting in E2/E3.
 */

const SCAFFOLD_VERSION = '1.0.0';
const SYMBOL = 'TREC';

// USD-stable mints (display-only, no semantic change)
const USD_STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// ═══════════════════════════════════════════════════════════════
// Description builder
// ═══════════════════════════════════════════════════════════════

/**
 * Build the metadata description string from a preview object.
 * Strictly raw_quote wording — never implies USD normalization.
 */
function buildDescription(preview) {
  const parts = [];

  // Status
  parts.push(`${preview.display_status}:`);

  // Token pair
  parts.push(`${preview.header.token_display} / ${preview.header.quote_symbol} on ${preview.header.chain}.`);

  // PnL (only if present)
  if (preview.pnl.has_pnl) {
    parts.push(`PnL: ${preview.pnl.realized_pnl_pct_display} (${preview.pnl.realized_pnl_display}).`);
  } else {
    parts.push('No PnL claim.');
  }

  // Valuation
  parts.push(`Valuation: ${preview.valuation.status}.`);

  // USD-stable guardrail
  if (preview.valuation.quote_is_usd_stable) {
    parts.push('USD-stable quote asset, but still raw quote; no historical USD normalization applied.');
  } else {
    parts.push('No USD normalization.');
  }

  return parts.join(' ');
}

// ═══════════════════════════════════════════════════════════════
// Attributes builder
// ═══════════════════════════════════════════════════════════════

function buildAttributes(receipt, preview, quoteIsUsdStable) {
  const attrs = [
    { trait_type: 'receipt_type', value: receipt.receipt_type },
    { trait_type: 'verification_status', value: receipt.verification_status },
    { trait_type: 'display_status', value: preview.display_status },
    { trait_type: 'chain', value: receipt.chain },
    { trait_type: 'wallet', value: receipt.wallet },
    { trait_type: 'token_mint', value: receipt.token_mint },
    { trait_type: 'quote_symbol', value: preview.header.quote_symbol },
    { trait_type: 'valuation_status', value: receipt.valuation_status },
  ];

  // PnL attributes (null-safe for snapshots)
  if (receipt.realized_pnl_pct != null) {
    attrs.push({ trait_type: 'realized_pnl_pct', value: receipt.realized_pnl_pct, display_type: 'number' });
  }
  if (receipt.realized_pnl_quote != null) {
    attrs.push({ trait_type: 'realized_pnl_quote', value: receipt.realized_pnl_quote, display_type: 'number' });
  }

  // Time/trade attributes
  if (receipt.hold_time_seconds != null) {
    attrs.push({ trait_type: 'hold_time_seconds', value: receipt.hold_time_seconds, display_type: 'number' });
  }
  attrs.push({ trait_type: 'num_buys', value: receipt.num_buys ?? 0, display_type: 'number' });
  attrs.push({ trait_type: 'num_sells', value: receipt.num_sells ?? 0, display_type: 'number' });

  if (receipt.first_event_at != null) {
    attrs.push({ trait_type: 'first_event_at', value: receipt.first_event_at, display_type: 'date' });
  }
  if (receipt.last_event_at != null) {
    attrs.push({ trait_type: 'last_event_at', value: receipt.last_event_at, display_type: 'date' });
  }

  attrs.push({ trait_type: 'quote_is_usd_stable', value: quoteIsUsdStable });

  return attrs;
}

// ═══════════════════════════════════════════════════════════════
// buildReceiptMetadata
// ═══════════════════════════════════════════════════════════════

/**
 * Build a metadata scaffold from a canonical v1.2 receipt, D1 preview,
 * and optional valuation context.
 *
 * Pure function: no I/O, no Date.now(), fully deterministic.
 *
 * @param {object} receipt - Canonical v1.2 receipt record
 * @param {object} preview - D1 preview object from buildReceiptPreview
 * @param {object} [valuationCtx] - Optional valuation context from buildValuationContext
 * @returns {object} Metadata scaffold (Metaplex-compatible structure + _scaffold block)
 */
export function buildReceiptMetadata(receipt, preview, valuationCtx) {
  const quoteIsUsdStable = valuationCtx
    ? !!valuationCtx.quote_is_usd_stable
    : USD_STABLE_MINTS.has(receipt.quote_mint || '');

  const description = buildDescription(preview);
  const attributes = buildAttributes(receipt, preview, quoteIsUsdStable);

  const limitations = receipt.limitations || {};

  return {
    name: `Trade Receipt #${receipt.receipt_id}`,
    symbol: SYMBOL,
    description,
    image: null,
    external_url: null,
    attributes,
    properties: {
      receipt_version: receipt.receipt_version,
      receipt_id: receipt.receipt_id,
      receipt_hash: receipt.receipt_hash,
      candidate_hash: receipt.candidate_hash,
      accounting_method: receipt.accounting_method,
      valuation_status: receipt.valuation_status,
      valuation_currency: limitations.valuation_currency || null,
      limitations: {
        receipt_scope: limitations.receipt_scope || receipt.receipt_type,
        pnl_type: limitations.pnl_type || null,
        price_source: limitations.price_source || null,
        disclosures: Array.isArray(limitations.disclosures) ? [...limitations.disclosures] : [],
      },
      category: 'image',
      files: [],
    },
    _scaffold: {
      version: SCAFFOLD_VERSION,
      status: 'placeholder',
      image_status: 'not_rendered',
      upload_status: 'not_uploaded',
      notes: 'Metadata scaffold only. Image, external_url, and files[] are placeholders awaiting render and upload.',
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Batch
// ═══════════════════════════════════════════════════════════════

/**
 * Build metadata scaffolds for arrays of receipts and previews.
 *
 * @param {object[]} receipts - Canonical v1.2 receipts
 * @param {object[]} previews - D1 preview objects (same order as receipts)
 * @param {object[]} [valuationCtxs] - Optional valuation contexts (same order)
 * @returns {object[]} Array of metadata scaffolds
 */
export function buildReceiptMetadataBatch(receipts, previews, valuationCtxs) {
  return receipts.map((r, i) => {
    const preview = previews[i];
    const ctx = valuationCtxs ? valuationCtxs[i] : undefined;
    return buildReceiptMetadata(r, preview, ctx);
  });
}
