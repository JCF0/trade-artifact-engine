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

const result = await runPackageFirstProductionCheck(options);

assert.equal(result.status, 'passed');
assert.equal(result.receipts, 66);
assert.equal(result.package_backed, 2);
assert.equal(result.legacy_fallback, 64);
assert.deepEqual(result.assets.map(asset => asset.asset), ['JUP', 'RAY']);
assert.ok(result.store_hashes.package.before === result.store_hashes.package.after);
assert.ok(result.store_hashes.archive.before === result.store_hashes.archive.after);
assert.ok(result.store_hashes.economics.before === result.store_hashes.economics.after);

console.log('package-first production checker: PASS');
