import { createHash } from 'crypto';

const SLUG_PREFIX = 'p-';
const SLUG_DIGEST_LENGTH = 24;
const SLUG_SOURCE_PREFIX = 'artifact-publish-slug:v1:';

function normalizeReceiptHash(receiptHash) {
  if (typeof receiptHash !== 'string' || receiptHash.length === 0) {
    throw new TypeError('receipt_hash is required');
  }
  return receiptHash;
}

export function buildPublishSlug(receiptHash) {
  const normalizedReceiptHash = normalizeReceiptHash(receiptHash);
  const digest = createHash('sha256')
    .update(`${SLUG_SOURCE_PREFIX}${normalizedReceiptHash}`)
    .digest('hex')
    .slice(0, SLUG_DIGEST_LENGTH)
    .toLowerCase();

  return `${SLUG_PREFIX}${digest}`;
}
