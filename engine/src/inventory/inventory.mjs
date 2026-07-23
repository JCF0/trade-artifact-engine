import {
  DEFAULT_ENGINE_ROOT,
  scanInventorySources,
} from './scanner.mjs';
import {
  buildReceiptArchiveBundle,
  readReceiptArchiveBundlesWithDiagnostics,
  stableJson,
} from './archive-store.mjs';
import {
  readValidatedReceiptEconomicsWithDiagnostics,
  RECEIPT_ECONOMICS_VERSION,
} from './receipt-economics-store.mjs';

export const INVENTORY_VERSION = '1.3-slice-1';

const CANONICAL_ECONOMICS_FIELDS = Object.freeze([
  'segment_index',
  'entry_tx_hashes',
  'exit_tx_hashes',
  'total_bought_qty',
  'total_bought_quote',
  'avg_buy_quote_price',
  'total_sold_qty',
  'total_sold_quote',
  'avg_sell_quote_price',
  'allocated_cost_basis_quote',
  'remaining_qty',
  'remaining_cost_basis_quote',
  'realized_pnl_quote',
  'realized_pnl_pct',
  'accounting_method',
  'hold_time_seconds',
  'num_buys',
  'num_sells',
]);

function toBoolean(value) {
  if (value === true || value === false) return value;
  if (value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildInventoryReceipt(receipt, scan) {
  const receiptHash = receipt.receipt_hash;
  const verify = scan.verifyByHash.get(receiptHash) || null;
  const valuation = scan.valuationByHash.get(receiptHash) || null;
  const image = scan.imageByHash.get(receiptHash) || null;
  const metadata = scan.metadataByHash.get(receiptHash) || null;
  const uploadDryRun = scan.uploadDryRunByHash.get(receiptHash) || null;
  const uploadResult = scan.uploadResultByHash.get(receiptHash) || null;
  const mintPlan = scan.mintPlanByHash.get(receiptHash) || null;
  const mintResult = scan.mintResultByHash.get(receiptHash) || null;
  const proofSummary = scan.proofSummaryByHash.get(receiptHash) || null;

  return {
    receipt_hash: receipt.receipt_hash,
    receipt_id: receipt.receipt_id,
    receipt_version: receipt.receipt_version,
    receipt_type: receipt.receipt_type,
    wallet: receipt.wallet,
    chain: receipt.chain,
    token_mint: receipt.token_mint,
    quote_mint: receipt.quote_mint,
    quote_symbol: receipt.quote_symbol,
    candidate_hash: receipt.candidate_hash || null,
    verification_status: receipt.verification_status,
    display_status: receipt.display_status || null,
    valuation_status: receipt.valuation_status,
    position_status: receipt.position_status || null,
    first_event_at: receipt.first_event_at ?? null,
    last_event_at: receipt.last_event_at ?? null,
    snapshot_at: receipt.snapshot_at ?? null,
    flags: Array.isArray(receipt.flags) ? receipt.flags : [],
    limitations: receipt.limitations || null,
    hash_valid: verify?.hash_valid ?? proofSummary?.hash_valid ?? null,
    recomputed_hash: verify?.recomputed_hash ?? null,
    verifier_passed: verify?.pass ?? null,
    verifier_schema_valid: verify?.schema_valid ?? null,
    verifier_consistency_valid: verify?.consistency_valid ?? null,
    verifier_rule_violations: Array.isArray(verify?.rule_violations) ? verify.rule_violations : [],
    valuation_valid: valuation?.valid ?? null,
    valuation_context: valuation ? {
      valuation_currency: valuation.valuation_currency ?? null,
      quote_is_usd_stable: valuation.quote_is_usd_stable ?? null,
      violations: Array.isArray(valuation.violations) ? valuation.violations : [],
    } : null,
    image_status: image?.render_status ?? null,
    image_artifact_path: image?.local_path ?? uploadDryRun?.image_artifact_path ?? null,
    image_artifact_hash: image?.artifact_hash ?? uploadDryRun?.image_artifact_hash ?? uploadResult?.source_image_artifact_hash ?? null,
    metadata_name: metadata?.name ?? null,
    metadata_template_path: uploadDryRun?.metadata_template_path ?? uploadResult?.source_metadata_template_path ?? null,
    resolved_metadata_path: uploadDryRun?.resolved_metadata_path ?? null,
    final_metadata_path: uploadResult?.final_metadata_path ?? null,
    upload_status: uploadResult?.upload_status ?? uploadDryRun?.upload_status ?? null,
    upload_mode: uploadResult?.upload_mode ?? uploadDryRun?.upload_mode ?? null,
    upload_network: uploadResult?.network ?? null,
    final_image_uri: uploadResult?.final_image_uri ?? null,
    final_metadata_uri: uploadResult?.final_metadata_uri ?? null,
    uploaded_at: uploadResult?.uploaded_at ?? null,
    uploader_pubkey: uploadResult?.uploader_pubkey ?? null,
    mint_ready: mintPlan?.mint_ready ?? null,
    mint_blockers: Array.isArray(mintPlan?.mint_blockers) ? mintPlan.mint_blockers : [],
    mint_required_steps: Array.isArray(mintPlan?.required_before_mint) ? mintPlan.required_before_mint : [],
    mint_status: mintResult?.mint_status ?? null,
    mint_network: mintResult?.network ?? mintPlan?.network ?? null,
    metadata_uri: mintResult?.metadata_uri ?? mintPlan?.metadata_uri ?? null,
    image_uri: mintResult?.image_uri ?? mintPlan?.image_uri ?? null,
    external_url: mintPlan?.external_url ?? metadata?.external_url ?? null,
    proof_wallet_pubkey: mintResult?.proof_wallet_pubkey ?? mintPlan?.proof_wallet_pubkey ?? null,
    mint_authority_pubkey: mintResult?.mint_authority_pubkey ?? mintPlan?.mint_authority_pubkey ?? null,
    mint_address: mintResult?.mint_address ?? null,
    token_account: mintResult?.token_account ?? null,
    transaction_signature: mintResult?.transaction_signature ?? null,
    minted_at: mintResult?.minted_at ?? null,
    proof_summary: proofSummary ? {
      verification_status: proofSummary.verification_status ?? null,
      violations: proofSummary.violations ?? null,
    } : null,
  };
}

function buildLegacyInventoryReceipt(legacyReceipt) {
  return {
    verification_hash: legacyReceipt.verification_hash,
    receipt_id: legacyReceipt.receipt_id,
    receipt_type: legacyReceipt.receipt_type,
    wallet: legacyReceipt.wallet,
    chain: legacyReceipt.chain,
    token_mint: legacyReceipt.token_mint,
    quote_mint: legacyReceipt.quote_mint,
    quote_symbol: legacyReceipt.quote_symbol,
    source_path: legacyReceipt.source_path,
    line_number: legacyReceipt.line_number,
    // The raw legacy record stays internal so the API surface remains explicit,
    // stable, and separate from the v1.2 inventory record shape.
  };
}

function compareInventoryRecordSemantics(currentRecord, archiveBundle) {
  const currentBundle = buildReceiptArchiveBundle(currentRecord, {
    provenance: { source: 'current_v12_debug_snapshot' },
  });

  if (stableJson(currentBundle.canonical_receipt_record) !== stableJson(archiveBundle.canonical_receipt_record)) {
    return 'receipt_hash_conflict';
  }
  if (stableJson(currentBundle) !== stableJson(archiveBundle)) {
    return 'receipt_archive_bundle_conflict';
  }
  return null;
}

function sortDiagnostics(diagnostics) {
  return diagnostics.sort((a, b) => {
    const aKey = `${a.code || ''}:${a.receipt_hash || ''}:${a.path || ''}`;
    const bKey = `${b.code || ''}:${b.receipt_hash || ''}:${b.path || ''}`;
    return aKey.localeCompare(bKey);
  });
}

function mergeArchiveReceipts(currentReceipts, archiveBundles) {
  const diagnostics = [];
  const byHash = new Map(currentReceipts.map(receipt => [receipt.receipt_hash, receipt]));
  const conflictedHashes = new Set();

  for (const bundle of [...archiveBundles].sort((a, b) => a.receipt_hash.localeCompare(b.receipt_hash))) {
    const receiptHash = bundle.receipt_hash;
    const current = byHash.get(receiptHash);
    if (!current) {
      byHash.set(receiptHash, bundle.inventory_record);
      continue;
    }

    const conflictCode = compareInventoryRecordSemantics(current, bundle);
    if (!conflictCode) continue;

    conflictedHashes.add(receiptHash);
    diagnostics.push({
      code: conflictCode,
      receipt_hash: receiptHash,
      path: 'receipts/' + receiptHash + '.json',
    });
  }

  for (const receiptHash of conflictedHashes) byHash.delete(receiptHash);

  return {
    receipts: [...byHash.values()].sort((a, b) => a.receipt_hash.localeCompare(b.receipt_hash)),
    diagnostics: sortDiagnostics(diagnostics),
  };
}

function attachCanonicalEconomics(receipts, archiveBundles, economicsEntries) {
  const archiveHashes = new Set(archiveBundles.map(bundle => bundle.receipt_hash));
  const economicsByHash = new Map(economicsEntries.map(entry => [entry.receipt_hash, entry]));

  return receipts.map(receipt => {
    if (!archiveHashes.has(receipt.receipt_hash)) return receipt;
    const entry = economicsByHash.get(receipt.receipt_hash);
    if (!entry) return receipt;

    const fields = {};
    for (const field of CANONICAL_ECONOMICS_FIELDS) {
      fields[field] = structuredClone(entry.economics[field]);
    }
    return {
      ...receipt,
      canonical_economics: {
        status: 'verified',
        source: RECEIPT_ECONOMICS_VERSION,
        recovery_method: entry.recovery_method,
        fields,
      },
    };
  });
}

function filterReceipts(receipts, filters = {}) {
  return receipts.filter(receipt => {
    if (filters.receipt_hash && receipt.receipt_hash !== filters.receipt_hash) return false;
    if (filters.receipt_type && receipt.receipt_type !== filters.receipt_type) return false;
    if (filters.verification_status && receipt.verification_status !== filters.verification_status) return false;
    if (filters.mint_status && receipt.mint_status !== filters.mint_status) return false;
    if (filters.upload_status && receipt.upload_status !== filters.upload_status) return false;
    if (filters.wallet && receipt.wallet !== filters.wallet) return false;
    if (filters.token_mint && receipt.token_mint !== filters.token_mint) return false;
    return true;
  });
}

export function buildInventorySnapshot({
  engineRoot = DEFAULT_ENGINE_ROOT,
  archiveRoot,
  economicsRoot,
  includeLegacy = false,
  includeExcluded = false,
  includeArchive = false,
  filters = {},
  limit,
  offset = 0,
} = {}) {
  const scanned = scanInventorySources({
    engineRoot,
    includeLegacy,
    includeExcluded,
  });

  const currentReceipts = scanned.v12.receipts
    .map(receipt => buildInventoryReceipt(receipt, scanned.v12))
    .sort((a, b) => a.receipt_hash.localeCompare(b.receipt_hash));

  const archiveRead = includeArchive
    ? readReceiptArchiveBundlesWithDiagnostics({ engineRoot, archiveRoot })
    : { bundles: [], diagnostics: [] };
  const archiveMerge = includeArchive
    ? mergeArchiveReceipts(currentReceipts, archiveRead.bundles)
    : { receipts: currentReceipts, diagnostics: [] };
  const economicsRead = includeArchive
    ? readValidatedReceiptEconomicsWithDiagnostics({ engineRoot, archiveRoot, economicsRoot })
    : { entries: [], diagnostics: [] };
  const archiveDiagnostics = sortDiagnostics([
    ...archiveRead.diagnostics,
    ...archiveMerge.diagnostics,
    ...economicsRead.diagnostics,
  ]);
  const receipts = includeArchive
    ? attachCanonicalEconomics(archiveMerge.receipts, archiveRead.bundles, economicsRead.entries)
    : archiveMerge.receipts;

  const filteredReceipts = filterReceipts(receipts, filters);
  const normalizedOffset = Math.max(0, toInteger(offset, 0));
  const normalizedLimit = limit == null ? filteredReceipts.length : Math.max(0, toInteger(limit, filteredReceipts.length));
  const pagedReceipts = filteredReceipts.slice(normalizedOffset, normalizedOffset + normalizedLimit);

  const legacyReceipts = includeLegacy
    ? scanned.legacy.map(buildLegacyInventoryReceipt)
    : [];

  return {
    generated_at: new Date().toISOString(),
    inventory_version: INVENTORY_VERSION,
    engine_root: engineRoot,
    include_legacy: includeLegacy,
    include_excluded: includeExcluded,
    counts: {
      receipts: filteredReceipts.length,
      returned_receipts: pagedReceipts.length,
      legacy_receipts: legacyReceipts.length,
    },
    filters,
    ...(includeArchive ? {
      archive: {
        included: true,
        counts: {
          bundles_read: archiveRead.bundles.length,
          diagnostics: archiveDiagnostics.length,
        },
        diagnostics: archiveDiagnostics,
      },
    } : {}),
    artifacts: Object.values(scanned.v12.artifacts).map(artifact => ({
      name: artifact.name,
      relative_path: artifact.relative_path,
      exists: artifact.exists,
    })),
    receipts: pagedReceipts,
    legacy_receipts: legacyReceipts,
  };
}

export function getInventoryReceipt(receiptHash, options = {}) {
  const snapshot = buildInventorySnapshot({
    ...options,
    filters: { receipt_hash: receiptHash },
  });
  return snapshot.receipts[0] || null;
}

export function listLegacyInventory(options = {}) {
  const snapshot = buildInventorySnapshot({
    ...options,
    includeLegacy: true,
  });
  return snapshot.legacy_receipts;
}

export function getLegacyInventoryReceipt(verificationHash, options = {}) {
  const legacyReceipts = listLegacyInventory(options);
  return legacyReceipts.find(receipt => receipt.verification_hash === verificationHash) || null;
}

export function parseInventoryQuery(query = {}) {
  return {
    includeLegacy: toBoolean(query.include_legacy),
    includeExcluded: toBoolean(query.include_excluded),
    limit: query.limit,
    offset: query.offset,
    filters: {
      receipt_type: query.receipt_type || undefined,
      verification_status: query.verification_status || undefined,
      mint_status: query.mint_status || undefined,
      upload_status: query.upload_status || undefined,
      wallet: query.wallet || undefined,
      token_mint: query.token_mint || undefined,
    },
  };
}
