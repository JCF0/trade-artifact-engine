export class ReceiptPackageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReceiptPackageError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  throw new ReceiptPackageError(code, message, details);
}
