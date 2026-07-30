import { createHash } from 'node:crypto';

import {
  buildReceiptArchiveBundle,
  validateReceiptArchiveBundle,
} from './archive-store.mjs';
import {
  buildReceiptEconomicsSidecar,
  validateReceiptEconomicsSidecar,
} from './receipt-economics-store.mjs';
import { computeCandidateHash } from '../ledger/receipt-candidates.mjs';
import { renderReceiptSvg } from '../ledger/receipt-image-svg.mjs';
import { buildReceiptMetadata } from '../ledger/receipt-metadata.mjs';
import { buildReceiptPreview } from '../ledger/receipt-preview.mjs';
import { buildValuationContext, validateReceiptValuation } from '../ledger/valuation.mjs';
import { validateReceiptPackageV1 } from '../receipt-package/validator.mjs';

const CANDIDATE_VERSION = '1.2.0';
const ECONOMICS_RECOVERY_METHOD = 'hash_matched_regeneration';

export class ReceiptCompatibilityProjectionError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message);
    this.name = 'ReceiptCompatibilityProjectionError';
    this.code = code;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(code, message, details = {}, cause) {
  throw new ReceiptCompatibilityProjectionError(code, message, details, cause);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function frozenClone(value) {
  return deepFreeze(structuredClone(value));
}

function validatePackage(receiptPackage) {
  try {
    validateReceiptPackageV1(receiptPackage);
  } catch (cause) {
    fail('package_projection_invalid', 'receipt package failed complete receipt_package_v1 validation', {
      package_error_code: cause?.code || 'receipt_package_invalid',
    }, cause);
  }
}

function canonicalWithCandidateHash(canonical) {
  return {
    ...structuredClone(canonical),
    candidate_hash: computeCandidateHash({
      ...canonical,
      candidate_type: canonical.receipt_type,
      candidate_version: CANDIDATE_VERSION,
    }),
  };
}

function buildCompatibilityInventoryRecord(receiptPackage) {
  const canonical = canonicalWithCandidateHash(receiptPackage['canonical-receipt.json']);
  const verification = receiptPackage['verification.json'];
  const valuation = validateReceiptValuation(canonical);
  if (!valuation.valid) {
    fail('package_projection_invalid', 'package canonical receipt failed the existing valuation contract', {
      receipt_hash: canonical.receipt_hash,
      violation_rules: valuation.violations.map(item => item.rule),
    });
  }
  const valuationContext = buildValuationContext(canonical);
  const preview = buildReceiptPreview(canonical);
  const imageBytes = renderReceiptSvg(preview);
  const imageArtifactHash = `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`;
  const metadata = buildReceiptMetadata(canonical, preview, valuationContext);

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
    candidate_hash: canonical.candidate_hash,
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
    image_artifact_hash: imageArtifactHash,
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

export function buildArchiveV1CompatibilityBundleFromPackage(receiptPackage) {
  validatePackage(receiptPackage);
  try {
    const bundle = buildReceiptArchiveBundle(buildCompatibilityInventoryRecord(receiptPackage));
    validateReceiptArchiveBundle(bundle);
    return frozenClone(bundle);
  } catch (cause) {
    if (cause instanceof ReceiptCompatibilityProjectionError) throw cause;
    fail('package_projection_invalid', 'validated package could not be projected through the archive-v1 contract', {
      receipt_hash: receiptPackage?.['manifest.json']?.receipt_hash,
      archive_error_code: cause?.code || 'archive_projection_failed',
    }, cause);
  }
}

export function buildEconomicsV1CompatibilitySidecarFromPackage(receiptPackage) {
  validatePackage(receiptPackage);
  try {
    const canonical = receiptPackage['canonical-receipt.json'];
    const archiveBundle = buildArchiveV1CompatibilityBundleFromPackage(receiptPackage);
    const sidecar = buildReceiptEconomicsSidecar(canonical, {
      archiveBundle,
      recoveryMethod: ECONOMICS_RECOVERY_METHOD,
    });
    validateReceiptEconomicsSidecar(sidecar, {
      receiptHash: canonical.receipt_hash,
      archiveBundle,
    });
    return frozenClone(sidecar);
  } catch (cause) {
    if (cause instanceof ReceiptCompatibilityProjectionError) throw cause;
    fail('package_projection_invalid', 'validated package could not be projected through the economics-v1 contract', {
      receipt_hash: receiptPackage?.['manifest.json']?.receipt_hash,
      economics_error_code: cause?.code || 'economics_projection_failed',
    }, cause);
  }
}
