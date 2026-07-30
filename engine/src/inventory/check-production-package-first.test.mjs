#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { runPackageFirstProductionCheck } from './check-production-package-first.mjs';

const options = {
  engineRoot: resolve('engine'),
  packageRoot: '/root/artifact-data/receipt-packages-v1',
  archiveRoot: resolve('engine/data/inventory/receipt-archive-v1'),
  economicsRoot: resolve('engine/data/inventory/receipt-economics-v1'),
};

for (const key of ['engineRoot', 'packageRoot', 'archiveRoot', 'economicsRoot']) {
  const incomplete = { ...options };
  delete incomplete[key];
  await assert.rejects(runPackageFirstProductionCheck(incomplete), TypeError);
}

const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error('network access is forbidden in production acceptance');
};
let result;
try {
  result = await runPackageFirstProductionCheck(options);
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(result.status, 'passed');
assert.equal(result.receipts, 66);
assert.equal(result.package_backed, 2);
assert.equal(result.legacy_fallback, 64);
assert.equal(result.compatibility.package_archive_byte_matches, 2);
assert.equal(result.compatibility.package_economics_byte_matches, 2);
assert.equal(result.compatibility.legacy_archive_fallback_records, 64);
assert.equal(result.compatibility.legacy_archive_bytes_unchanged, 64);
assert.equal(result.compatibility.public_demo_byte_equivalent, true);
assert.deepEqual(result.assets.map(asset => asset.asset), ['JUP', 'RAY']);
assert.ok(result.store_hashes.engine.before === result.store_hashes.engine.after);
assert.ok(result.store_hashes.package.before === result.store_hashes.package.after);
assert.ok(result.store_hashes.archive.before === result.store_hashes.archive.after);
assert.ok(result.store_hashes.economics.before === result.store_hashes.economics.after);
assert.deepEqual(result.side_effects, {
  filesystem_roots_unchanged: true,
  network_access: 'blocked',
});
assert.equal(networkCalls, 0);

console.log('package-first production checker: PASS');
