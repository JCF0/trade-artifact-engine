export const TARGETED_RECEIPT_ORCHESTRATION_ERROR_CODES = Object.freeze([
  'invalid_orchestration_request',
  'incomplete_acquisition_input',
  'incomplete_normalization_input',
  'invalid_normalized_event',
  'target_not_found',
  'target_ambiguous',
  'target_not_eligible',
  'canonical_promotion_failed',
  'verification_failed',
  'expected_receipt_hash_mismatch',
  'package_build_failed',
  'package_validation_failed',
  'package_store_required',
  'package_store_conflict',
  'commit_unknown',
  'capability_denied',
]);

const CODE_SET = new Set(TARGETED_RECEIPT_ORCHESTRATION_ERROR_CODES);

function sanitizeDiagnostic(value) {
  if (typeof value === 'string') {
    const containsUrl = /[a-z][a-z0-9+.-]*:\/\//i.test(value);
    const containsPath = /(?:^|[=\s"'(\[])\/(?:[^/\s]+\/)*[^/\s]*|[a-z]:[\\/]|\\\\/i.test(value);
    return containsUrl || containsPath ? '<redacted>' : value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map(sanitizeDiagnostic));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sanitizeDiagnostic(child)]),
    ));
  }
  return value;
}

export class TargetedReceiptOrchestrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TargetedReceiptOrchestrationError';
    this.code = CODE_SET.has(code) ? code : 'capability_denied';
    this.details = sanitizeDiagnostic(details);
  }
}

export function orchestrationFail(code, message, details = {}) {
  throw new TargetedReceiptOrchestrationError(code, message, details);
}
