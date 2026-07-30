import { buildDisclosureSet } from '../proof-trust/disclosures.mjs';
import { deriveTrustLevel } from '../proof-trust/trust-model.mjs';
import { buildReceiptCoverageStatement } from '../coverage-statement/view-model.mjs';
import { proofSourceInventoryRecord } from '../proof-source/package-native-proof-source.mjs';

export const RAW_QUOTE_DISCLOSURE_TEXT = 'Raw quote only. No USD normalization.';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNull(value) {
  return value == null ? null : value;
}

export function buildProofDetailView(proofSource) {
  if (!proofSource || typeof proofSource !== 'object') {
    throw new TypeError('inventoryRecord is required');
  }
  const inventoryRecord = proofSourceInventoryRecord(proofSource);

  const coverageStatement = buildReceiptCoverageStatement(inventoryRecord);
  const trust = {
    ...deriveTrustLevel(inventoryRecord),
    coverage_statement_present: true,
  };

  return {
    receipt: {
      receipt_hash: inventoryRecord.receipt_hash,
      receipt_id: inventoryRecord.receipt_id,
      receipt_version: inventoryRecord.receipt_version,
      receipt_type: inventoryRecord.receipt_type,
      verification_status: inventoryRecord.verification_status,
      display_status: asNull(inventoryRecord.display_status),
      wallet: inventoryRecord.wallet,
      chain: inventoryRecord.chain,
      token_mint: inventoryRecord.token_mint,
      quote_mint: inventoryRecord.quote_mint,
      quote_symbol: inventoryRecord.quote_symbol,
      candidate_hash: asNull(inventoryRecord.candidate_hash),
      valuation_status: inventoryRecord.valuation_status,
      position_status: asNull(inventoryRecord.position_status),
      first_event_at: asNull(inventoryRecord.first_event_at),
      last_event_at: asNull(inventoryRecord.last_event_at),
      snapshot_at: asNull(inventoryRecord.snapshot_at),
    },
    verification: {
      verification_status: inventoryRecord.verification_status,
      hash_valid: inventoryRecord.hash_valid ?? null,
      recomputed_hash: asNull(inventoryRecord.recomputed_hash),
      verifier_passed: inventoryRecord.verifier_passed ?? null,
      verifier_schema_valid: inventoryRecord.verifier_schema_valid ?? null,
      verifier_consistency_valid: inventoryRecord.verifier_consistency_valid ?? null,
      verifier_rule_violations: asArray(inventoryRecord.verifier_rule_violations),
      proof_summary: inventoryRecord.proof_summary
        ? {
            verification_status: asNull(inventoryRecord.proof_summary.verification_status),
            violations: inventoryRecord.proof_summary.violations ?? null,
          }
        : null,
    },
    coverage_statement: coverageStatement,
    valuation: {
      valuation_status: inventoryRecord.valuation_status,
      valuation_valid: inventoryRecord.valuation_valid ?? null,
      valuation_context: inventoryRecord.valuation_context
        ? {
            valuation_currency: asNull(inventoryRecord.valuation_context.valuation_currency),
            quote_is_usd_stable: inventoryRecord.valuation_context.quote_is_usd_stable ?? null,
            violations: asArray(inventoryRecord.valuation_context.violations),
          }
        : null,
      disclosure_text: RAW_QUOTE_DISCLOSURE_TEXT,
    },
    proof_lifecycle: {
      image_status: asNull(inventoryRecord.image_status),
      upload_status: asNull(inventoryRecord.upload_status),
      upload_mode: asNull(inventoryRecord.upload_mode),
      upload_network: asNull(inventoryRecord.upload_network),
      uploaded_at: asNull(inventoryRecord.uploaded_at),
      uploader_pubkey: asNull(inventoryRecord.uploader_pubkey),
      mint_ready: inventoryRecord.mint_ready ?? null,
      mint_blockers: asArray(inventoryRecord.mint_blockers),
      mint_required_steps: asArray(inventoryRecord.mint_required_steps),
      mint_status: asNull(inventoryRecord.mint_status),
      mint_network: asNull(inventoryRecord.mint_network),
      proof_wallet_pubkey: asNull(inventoryRecord.proof_wallet_pubkey),
      mint_authority_pubkey: asNull(inventoryRecord.mint_authority_pubkey),
      mint_address: asNull(inventoryRecord.mint_address),
      token_account: asNull(inventoryRecord.token_account),
      transaction_signature: asNull(inventoryRecord.transaction_signature),
      minted_at: asNull(inventoryRecord.minted_at),
    },
    artifacts: {
      image_artifact_path: asNull(inventoryRecord.image_artifact_path),
      image_artifact_hash: asNull(inventoryRecord.image_artifact_hash),
      metadata_name: asNull(inventoryRecord.metadata_name),
      metadata_template_path: asNull(inventoryRecord.metadata_template_path),
      resolved_metadata_path: asNull(inventoryRecord.resolved_metadata_path),
      final_metadata_path: asNull(inventoryRecord.final_metadata_path),
      final_image_uri: asNull(inventoryRecord.final_image_uri),
      final_metadata_uri: asNull(inventoryRecord.final_metadata_uri),
      metadata_uri: asNull(inventoryRecord.metadata_uri),
      image_uri: asNull(inventoryRecord.image_uri),
      external_url: asNull(inventoryRecord.external_url),
    },
    legacy: {
      has_legacy_match: false,
      verification_hash: null,
    },
    links: {
      inventory_path: `/inventory/${inventoryRecord.receipt_hash}`,
      inventory_api_path: `/inventory/${inventoryRecord.receipt_hash}`,
      proof_api_path: `/api/proof/${inventoryRecord.receipt_hash}`,
      legacy_path: null,
    },
    trust,
    flags_and_limitations: {
      flags: asArray(inventoryRecord.flags),
      limitations: inventoryRecord.limitations || null,
      disclosures: asArray(inventoryRecord.limitations?.disclosures),
      raw_quote_only_disclosure: RAW_QUOTE_DISCLOSURE_TEXT,
      shared_surface_disclosures: buildDisclosureSet({
        includeHostedSemantics: true,
        includeCorrelatableDisclosure: trust.correlatable,
      }),
    },
  };
}
