export const BOUNDED_ACQUISITION_ERROR_CODES = Object.freeze([
  'invalid_acquisition_request',
  'acquisition_capability_denied',
  'api_key_unavailable',
  'provider_auth_failed',
  'provider_request_invalid',
  'provider_transient_failure',
  'provider_retry_exhausted',
  'provider_timeout',
  'acquisition_deadline_exceeded',
  'malformed_provider_page',
  'pagination_cursor_repeated',
  'pagination_order_invalid',
  'pagination_terminal_ambiguous',
  'acquisition_capped',
  'acquisition_truncated',
  'acquisition_incomplete',
  'normalization_failed',
  'normalization_ambiguous',
  'unsupported_target_activity',
]);

const ERROR_CODE_SET = new Set(BOUNDED_ACQUISITION_ERROR_CODES);

export class BoundedAcquisitionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'BoundedAcquisitionError';
    this.code = code;
    if (details !== undefined) this.details = Object.freeze({ ...details });
  }
}

export function acquisitionFail(code, message, details = undefined) {
  throw new BoundedAcquisitionError(code, message, details);
}

export function rethrowSanitizedAcquisitionError(error, fallbackCode, message) {
  let code = fallbackCode;
  try {
    const descriptor = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? Object.getOwnPropertyDescriptor(error, 'code')
      : undefined;
    if (descriptor && Object.hasOwn(descriptor, 'value') && ERROR_CODE_SET.has(descriptor.value)) {
      code = descriptor.value;
    }
  } catch {}
  acquisitionFail(code, message);
}
