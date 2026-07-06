import { deriveTrustLevel } from '../proof-trust/trust-model.mjs';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function buildProofVerifierView(inventoryRecord) {
  if (!inventoryRecord || typeof inventoryRecord !== 'object') {
    throw new TypeError('inventoryRecord is required');
  }

  const trust = deriveTrustLevel(inventoryRecord);

  return {
    receipt_hash: inventoryRecord.receipt_hash,
    receipt_id: inventoryRecord.receipt_id,
    receipt_type: inventoryRecord.receipt_type,
    valuation_status: inventoryRecord.valuation_status,
    verification: {
      recomputed_hash: inventoryRecord.recomputed_hash ?? null,
      hash_valid: inventoryRecord.hash_valid ?? null,
      verifier_passed: inventoryRecord.verifier_passed ?? null,
      verifier_schema_valid: inventoryRecord.verifier_schema_valid ?? null,
      verifier_consistency_valid: inventoryRecord.verifier_consistency_valid ?? null,
      verifier_rule_violations: asArray(inventoryRecord.verifier_rule_violations),
    },
    trust: {
      current_level: trust.current_level,
      current_code: trust.current_code,
      current_label: trust.current_label,
    },
    disclosures: trust.disclosures,
    instructions: {
      mode: 'local_inventory_backed',
      summary: 'Local inventory-backed verifier view only. This surface does not rerun the ledger verifier and does not perform network verification.',
      proof_api_path: `/api/proof/${inventoryRecord.receipt_hash}`,
      inventory_api_path: `/inventory/${inventoryRecord.receipt_hash}`,
      local_command_template: 'node engine/src/verify/verify-receipt.mjs <receipt.json>',
    },
  };
}