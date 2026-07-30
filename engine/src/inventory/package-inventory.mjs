import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createReceiptPackageFsStore,
  ReceiptPackageStoreError,
} from '../receipt-package/fs-package-store.mjs';
import { RECEIPT_HASH_PATTERN } from '../receipt-package/schema.mjs';

const ROOT_PROBE_HASH = '0'.repeat(64);

export class ReceiptPackageInventoryError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message);
    this.name = 'ReceiptPackageInventoryError';
    this.code = code;
    this.details = details;
    Object.assign(this, details);
  }
}

function fail(code, message, details = {}, cause) {
  throw new ReceiptPackageInventoryError(code, message, details, cause);
}

function requirePackageRoot(packageRoot) {
  if (typeof packageRoot !== 'string' || packageRoot.trim().length === 0) {
    fail('explicit_package_root_required', 'an explicit package root is required');
  }
  return resolve(packageRoot);
}

function diagnostic(receiptHash, reason) {
  return Object.freeze({
    code: 'receipt_package_excluded',
    receipt_hash: receiptHash,
    source: 'receipt_package_v1',
    reason,
  });
}

export async function readReceiptPackageInventory({ packageRoot } = {}) {
  const root = requirePackageRoot(packageRoot);
  const store = createReceiptPackageFsStore({ root });

  try {
    await store.inspect(ROOT_PROBE_HASH);
  } catch (error) {
    fail(
      error instanceof ReceiptPackageStoreError ? error.code : 'package_root_read_failed',
      'package root could not be validated through the receipt-package store',
      {},
      error,
    );
  }

  let directoryEntries;
  try {
    directoryEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    fail('package_root_read_failed', 'package root could not be scanned', {}, error);
  }

  const visibleEntries = directoryEntries
    .filter(entry => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (visibleEntries.some(entry => (
    !RECEIPT_HASH_PATTERN.test(entry.name)
    || !entry.isDirectory()
    || entry.isSymbolicLink()
  ))) {
    fail('unexpected_package_root_entry', 'package root contains an unexpected visible entry');
  }
  const visibleNames = visibleEntries.map(entry => entry.name);

  const entries = [];
  const diagnostics = [];
  for (const receiptHash of visibleNames) {
    try {
      const receiptPackage = await store.readCommitted(receiptHash);
      if (!receiptPackage) {
        diagnostics.push(diagnostic(receiptHash, 'committed_package_absent_during_read'));
        continue;
      }
      entries.push(Object.freeze({
        receipt_hash: receiptHash,
        source: 'receipt_package_v1',
        receipt_package: receiptPackage,
      }));
    } catch (error) {
      diagnostics.push(diagnostic(
        receiptHash,
        error instanceof ReceiptPackageStoreError ? error.code : 'receipt_package_read_failed',
      ));
    }
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
  });
}
