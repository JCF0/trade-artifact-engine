#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';

import {
  readReceiptPackageInventory,
  ReceiptPackageInventoryError,
} from './package-inventory.mjs';

const PACKAGE_ROOT = '/root/artifact-data/receipt-packages-v1';
const JUP_HASH = '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca';
const RAY_HASH = '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341';

const result = await readReceiptPackageInventory({ packageRoot: resolve(PACKAGE_ROOT) });
assert.deepEqual(result.entries.map(entry => entry.receipt_hash), [RAY_HASH, JUP_HASH]);
assert.deepEqual(result.diagnostics, []);
for (const entry of result.entries) {
  assert.equal(entry.source, 'receipt_package_v1');
  assert.equal(entry.receipt_package['manifest.json'].receipt_hash, entry.receipt_hash);
}

await assert.rejects(
  readReceiptPackageInventory(),
  error => error instanceof ReceiptPackageInventoryError
    && error.code === 'explicit_package_root_required',
);

const missingRoot = join(tmpdir(), `artifact-package-inventory-missing-${process.pid}-${Date.now()}`);
await assert.rejects(
  readReceiptPackageInventory({ packageRoot: missingRoot }),
  error => {
    assert.ok(error instanceof ReceiptPackageInventoryError);
    assert.equal(error.cause, undefined);
    assert.equal(error.stack.includes(missingRoot), false);
    assert.equal(inspect(error).includes(missingRoot), false);
    return true;
  },
);

const hiddenRoot = await mkdtemp(join(tmpdir(), 'artifact-package-inventory-hidden-'));
try {
  await cp(PACKAGE_ROOT, hiddenRoot, { recursive: true });
  await mkdir(join(hiddenRoot, `.${JUP_HASH}.lock`));
  await mkdir(join(hiddenRoot, `.${RAY_HASH}.fixture.tmp`));
  const hiddenResult = await readReceiptPackageInventory({ packageRoot: hiddenRoot });
  assert.deepEqual(hiddenResult.entries.map(entry => entry.receipt_hash), [RAY_HASH, JUP_HASH]);
  assert.deepEqual(hiddenResult.diagnostics, []);
} finally {
  await rm(hiddenRoot, { recursive: true, force: true });
}

const unexpectedRoot = await mkdtemp(join(tmpdir(), 'artifact-package-inventory-unexpected-'));
try {
  await writeFile(join(unexpectedRoot, 'README'), 'unexpected visible entry\n');
  await assert.rejects(
    readReceiptPackageInventory({ packageRoot: unexpectedRoot }),
    error => error instanceof ReceiptPackageInventoryError
      && error.code === 'unexpected_package_root_entry'
      && !JSON.stringify(error).includes(unexpectedRoot),
  );
  await rm(join(unexpectedRoot, 'README'));
  await writeFile(join(unexpectedRoot, RAY_HASH), 'not a committed package directory\n');
  await assert.rejects(
    readReceiptPackageInventory({ packageRoot: unexpectedRoot }),
    error => error instanceof ReceiptPackageInventoryError
      && error.code === 'unexpected_package_root_entry',
  );
} finally {
  await rm(unexpectedRoot, { recursive: true, force: true });
}

const malformedRoot = await mkdtemp(join(tmpdir(), 'artifact-package-inventory-malformed-'));
try {
  await cp(join(PACKAGE_ROOT, JUP_HASH), join(malformedRoot, JUP_HASH), { recursive: true });
  await writeFile(join(malformedRoot, JUP_HASH, 'economics.json'), '{ malformed package');
  const malformed = await readReceiptPackageInventory({ packageRoot: malformedRoot });
  assert.deepEqual(malformed.entries, []);
  assert.deepEqual(malformed.diagnostics, [{
    code: 'receipt_package_excluded',
    receipt_hash: JUP_HASH,
    source: 'receipt_package_v1',
    reason: 'committed_package_invalid',
  }]);
  assert.equal(JSON.stringify(malformed.diagnostics).includes(malformedRoot), false);
} finally {
  await rm(malformedRoot, { recursive: true, force: true });
}

console.log('receipt package inventory reader: PASS');
