import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildReceiptArchiveBundle, readReceiptArchiveBundle, stableJson } from '../inventory/archive-store.mjs';
import {
  readReceiptEconomics,
} from '../inventory/receipt-economics-store.mjs';
import { computeCandidateHash } from '../ledger/receipt-candidates.mjs';
import { renderReceiptSvg } from '../ledger/receipt-image-svg.mjs';
import { buildReceiptMetadata } from '../ledger/receipt-metadata.mjs';
import { buildReceiptPreview } from '../ledger/receipt-preview.mjs';
import { buildValuationContext, validateReceiptValuation } from '../ledger/valuation.mjs';
import { createReceiptPackageFsStore } from '../receipt-package/fs-package-store.mjs';
import { ECONOMICS_FIELDS, RECEIPT_HASH_PATTERN } from '../receipt-package/schema.mjs';
import { validateReceiptPackageV1 } from '../receipt-package/validator.mjs';

export const PACKAGE_NATIVE_PROOF_SOURCE_VERSION = 'package_native_proof_source_v1';
const PROOF_ECONOMICS_FIELDS = Object.freeze([
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

export class ReceiptProofSourceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReceiptProofSourceError';
    this.code = code;
    this.details = Object.freeze({ ...details });
    Object.assign(this, details);
  }
}

function fail(code, message, details = {}) {
  throw new ReceiptProofSourceError(code, message, details);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function frozenClone(value) {
  return deepFreeze(structuredClone(value));
}

function requireRoot(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('receipt_package_proof_source_invalid', `an explicit ${label} is required`);
  }
  return resolve(value);
}

function packageNativeInventoryRecord(canonical, verification) {
  const canonicalWithCandidate = {
    ...structuredClone(canonical),
    candidate_hash: computeCandidateHash({
      ...canonical,
      candidate_type: canonical.receipt_type,
      candidate_version: '1.2.0',
    }),
  };
  const valuation = validateReceiptValuation(canonicalWithCandidate);
  if (!valuation.valid) {
    fail('receipt_package_proof_source_excluded', 'receipt package is not eligible for a proof source', {
      receipt_hash: canonical.receipt_hash,
    });
  }
  const valuationContext = buildValuationContext(canonicalWithCandidate);
  const preview = buildReceiptPreview(canonicalWithCandidate);
  const imageBytes = renderReceiptSvg(preview);
  const metadata = buildReceiptMetadata(canonicalWithCandidate, preview, valuationContext);

  return {
    receipt_hash: canonical.receipt_hash,
    receipt_id: canonical.receipt_id,
    receipt_version: canonical.receipt_version,
    receipt_type: canonical.receipt_type,
    wallet: canonical.wallet,
    chain: canonical.chain,
    token_mint: canonical.token_mint,
    quote_mint: canonical.quote_mint,
    quote_symbol: canonical.quote_symbol,
    candidate_hash: canonicalWithCandidate.candidate_hash,
    verification_status: canonical.verification_status,
    display_status: canonical.display_status,
    valuation_status: canonical.valuation_status,
    position_status: canonical.position_status,
    first_event_at: canonical.first_event_at,
    last_event_at: canonical.last_event_at,
    snapshot_at: canonical.snapshot_at,
    flags: structuredClone(canonical.flags),
    limitations: structuredClone(canonical.limitations),
    hash_valid: verification.hash_valid,
    recomputed_hash: verification.recomputed_hash,
    verifier_passed: verification.pass,
    verifier_schema_valid: verification.schema_valid,
    verifier_consistency_valid: verification.consistency_valid,
    verifier_rule_violations: structuredClone(verification.rule_violations),
    valuation_valid: valuation.valid,
    valuation_context: {
      valuation_currency: valuationContext.valuation_currency,
      quote_is_usd_stable: valuationContext.quote_is_usd_stable,
      violations: structuredClone(valuation.violations),
    },
    image_status: 'rendered',
    image_artifact_hash: `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`,
    metadata_name: metadata.name,
    upload_status: 'simulated_not_uploaded',
    upload_mode: 'dry_run',
    upload_network: null,
    final_image_uri: null,
    final_metadata_uri: null,
    uploaded_at: null,
    uploader_pubkey: null,
    mint_ready: false,
    mint_blockers: [
      'image_not_rendered',
      'metadata_not_uploaded',
      'metadata_uri_missing',
      'proof_wallet_missing',
      'mint_authority_missing',
      'explicit_mint_approval_required',
    ],
    mint_required_steps: [
      { step: 'render_image', status: 'not_started', artifact: null },
      { step: 'upload_image', status: 'not_started', artifact: null },
      { step: 'upload_metadata', status: 'not_started', artifact: null },
      { step: 'set_proof_wallet', status: 'not_started', pubkey: null },
      { step: 'set_mint_authority', status: 'not_started', pubkey: null },
      { step: 'explicit_approval', status: 'not_started', approved_by: null },
    ],
    mint_status: null,
    mint_network: 'devnet',
    metadata_uri: null,
    image_uri: null,
    external_url: null,
    proof_wallet_pubkey: null,
    mint_authority_pubkey: null,
    mint_address: null,
    token_account: null,
    transaction_signature: null,
    minted_at: null,
    proof_summary: {
      verification_status: canonical.verification_status,
      violations: verification.rule_violations.length,
    },
  };
}

function packageNativeEconomics(economics) {
  // This is the authoritative economics identity for package-backed proofs.
  // Compatibility-sidecar provenance belongs only on inventory_record.
  return {
    status: 'verified',
    source: 'receipt_package_v1',
    fields: Object.fromEntries(PROOF_ECONOMICS_FIELDS.map(field => [field, structuredClone(economics[field])])),
  };
}

function compatibilityEconomics(economicsEntry, packageEconomics, receiptHash) {
  if (!economicsEntry) return packageEconomics;
  if (typeof economicsEntry.recovery_method !== 'string'
      || !economicsEntry.economics
      || PROOF_ECONOMICS_FIELDS.some(field => (
        stableJson(economicsEntry.economics[field]) !== stableJson(packageEconomics.fields[field])
      ))) {
    fail('receipt_package_legacy_overlap_mismatch', 'receipt package and legacy compatibility records disagree', {
      receipt_hash: receiptHash,
    });
  }
  return {
    status: 'verified',
    source: 'receipt_economics_v1',
    recovery_method: economicsEntry.recovery_method,
    fields: Object.fromEntries(PROOF_ECONOMICS_FIELDS.map(field => [
      field,
      structuredClone(economicsEntry.economics[field]),
    ])),
  };
}

/**
 * Build the immutable package-native proof contract. canonical_economics and
 * the builder's inventory_record.canonical_economics are sourced only from the
 * validated package economics.json and carry no migration/recovery provenance.
 */
export function buildPackageNativeProofSourceV1(receiptPackage) {
  try {
    validateReceiptPackageV1(receiptPackage);
    const canonicalReceipt = receiptPackage['canonical-receipt.json'];
    const verificationResult = receiptPackage['verification.json'];
    const canonicalEconomics = packageNativeEconomics(receiptPackage['economics.json']);
    const inventoryRecord = {
      ...JSON.parse(stableJson(packageNativeInventoryRecord(canonicalReceipt, verificationResult))),
      canonical_economics: canonicalEconomics,
    };
    return frozenClone({
      source_version: PACKAGE_NATIVE_PROOF_SOURCE_VERSION,
      receipt_hash: canonicalReceipt.receipt_hash,
      inventory_record: inventoryRecord,
      canonical_receipt: canonicalReceipt,
      verification_result: verificationResult,
      canonical_economics: canonicalEconomics,
    });
  } catch (error) {
    if (error instanceof ReceiptProofSourceError) throw error;
    fail('receipt_package_proof_source_invalid', 'receipt package cannot produce a valid proof source');
  }
}

function withCompatibilityEconomics(source, economicsEntry) {
  return frozenClone({
    ...source,
    inventory_record: {
      ...source.inventory_record,
      canonical_economics: compatibilityEconomics(
        economicsEntry,
        source.canonical_economics,
        source.receipt_hash,
      ),
    },
  });
}

function isMissingFile(error) {
  return error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT';
}

function packageArchiveBundle(source) {
  const { canonical_economics: _canonicalEconomics, ...inventoryRecord } = source.inventory_record;
  return buildReceiptArchiveBundle(inventoryRecord);
}

function assertLegacyOverlap(source, archiveRoot, economicsRoot) {
  const receiptHash = source.receipt_hash;
  const archivePath = join(archiveRoot, 'receipts', `${receiptHash}.json`);
  let actualArchive = null;
  if (existsSync(archivePath)) {
    try {
      actualArchive = readReceiptArchiveBundle(receiptHash, { archiveRoot });
      const expectedArchive = packageArchiveBundle(source);
      if (stableJson(actualArchive) !== stableJson(expectedArchive)) throw new Error('archive mismatch');
    } catch {
      fail('receipt_package_legacy_overlap_mismatch', 'receipt package and legacy compatibility records disagree', {
        receipt_hash: receiptHash,
      });
    }
  }

  const economicsPath = join(economicsRoot, 'receipts', `${receiptHash}.json`);
  if (!existsSync(economicsPath)) return null;
  try {
    const actual = readReceiptEconomics(receiptHash, { archiveRoot, economicsRoot });
    if (PROOF_ECONOMICS_FIELDS.some(field => (
      stableJson(actual.economics[field]) !== stableJson(source.canonical_economics.fields[field])
    ))) {
      throw new Error('economics mismatch');
    }
    return {
      recovery_method: actual.sidecar.provenance.recovery_method,
      economics: actual.economics,
    };
  } catch {
    fail('receipt_package_legacy_overlap_mismatch', 'receipt package and legacy compatibility records disagree', {
      receipt_hash: receiptHash,
    });
  }
  return null;
}

function resolveLegacy(receiptHash, archiveRoot, economicsRoot) {
  let archive;
  try {
    archive = readReceiptArchiveBundle(receiptHash, { archiveRoot });
  } catch (error) {
    if (isMissingFile(error)) fail('receipt_proof_source_not_found', 'receipt proof source was not found', { receipt_hash: receiptHash });
    fail('receipt_proof_source_ambiguous', 'receipt proof source could not be resolved unambiguously', { receipt_hash: receiptHash });
  }

  let economics;
  try {
    economics = readReceiptEconomics(receiptHash, { archiveRoot, economicsRoot });
  } catch (error) {
    if (!isMissingFile(error) && error?.code !== 'missing_economics_sidecar') {
      fail('receipt_proof_source_ambiguous', 'receipt proof source could not be resolved unambiguously', { receipt_hash: receiptHash });
    }
  }
  if (!economics) return frozenClone(archive.inventory_record);
  return frozenClone({
    ...archive.inventory_record,
    canonical_economics: {
      status: 'verified',
      source: 'receipt_economics_v1',
      recovery_method: economics.sidecar.provenance.recovery_method,
      fields: Object.fromEntries(ECONOMICS_FIELDS.map(field => [field, economics.economics[field]])),
    },
  });
}

/**
 * Resolve package authority first. A validated matching economics-v1 sidecar
 * may decorate inventory_record for compatibility, but canonical_economics
 * remains the package-native authority consumed by proof-facing builders.
 */
export async function resolveReceiptProofSourceV1({
  receiptHash,
  packageRoot,
  archiveRoot,
  economicsRoot,
} = {}) {
  if (typeof receiptHash !== 'string' || !RECEIPT_HASH_PATTERN.test(receiptHash)) {
    fail('receipt_package_proof_source_invalid', 'receiptHash must be a canonical receipt hash');
  }
  const roots = {
    package: requireRoot(packageRoot, 'packageRoot'),
    archive: requireRoot(archiveRoot, 'archiveRoot'),
    economics: requireRoot(economicsRoot, 'economicsRoot'),
  };
  let receiptPackage;
  try {
    receiptPackage = await createReceiptPackageFsStore({ root: roots.package }).readCommitted(receiptHash);
  } catch {
    fail('receipt_package_proof_source_invalid', 'committed receipt package is invalid', { receipt_hash: receiptHash });
  }
  if (!receiptPackage) return resolveLegacy(receiptHash, roots.archive, roots.economics);
  const source = buildPackageNativeProofSourceV1(receiptPackage);
  const compatibilityEconomicsEntry = assertLegacyOverlap(source, roots.archive, roots.economics);
  return compatibilityEconomicsEntry
    ? withCompatibilityEconomics(source, compatibilityEconomicsEntry)
    : source;
}

export function proofSourceInventoryRecord(value) {
  if (value?.source_version === PACKAGE_NATIVE_PROOF_SOURCE_VERSION) {
    // Proof, verifier, and Share Card builders consume package authority even
    // when inventory_record retains a validated legacy compatibility marker.
    return frozenClone({
      ...value.inventory_record,
      canonical_economics: value.canonical_economics,
    });
  }
  return value;
}
