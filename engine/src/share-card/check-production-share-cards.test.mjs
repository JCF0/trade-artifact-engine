import assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  PRODUCTION_SHARE_CARD_EXPECTATIONS,
  runProductionShareCardCheck,
} from './check-production-share-cards.mjs';

const ENGINE_ROOT = resolve('engine');
const ARCHIVE_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-archive-v1');
const ECONOMICS_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-economics-v1');
const TARGET_PATHS = Object.values(PRODUCTION_SHARE_CARD_EXPECTATIONS).flatMap(expected => [
  resolve(ARCHIVE_ROOT, 'receipts', `${expected.receipt_hash}.json`),
  resolve(ECONOMICS_ROOT, 'receipts', `${expected.receipt_hash}.json`),
]);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

test('requires explicit engine, archive, and economics roots', () => {
  assert.throws(
    () => runProductionShareCardCheck({ archiveRoot: ARCHIVE_ROOT, economicsRoot: ECONOMICS_ROOT }),
    /explicit engine root/i,
  );
  assert.throws(
    () => runProductionShareCardCheck({ engineRoot: ENGINE_ROOT, economicsRoot: ECONOMICS_ROOT }),
    /explicit archive root/i,
  );
  assert.throws(
    () => runProductionShareCardCheck({ engineRoot: ENGINE_ROOT, archiveRoot: ARCHIVE_ROOT }),
    /explicit economics root/i,
  );
});

test('builds only the exact production JUP and RAY models without network access or writes', () => {
  const before = new Map(TARGET_PATHS.map(path => [path, readFileSync(path, 'utf8')]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call not allowed'); };
  try {
    const result = runProductionShareCardCheck({
      engineRoot: ENGINE_ROOT,
      archiveRoot: ARCHIVE_ROOT,
      economicsRoot: ECONOMICS_ROOT,
    });

    assert.equal(result.status, 'passed');
    assert.deepEqual(result.records.map(record => record.asset), ['JUP', 'RAY']);
    assert.deepEqual(result.records.map(record => record.display_status), [
      'Verified Closed Position',
      'Verified Closed Position',
    ]);
    assert.deepEqual(result.records.map(record => record.summary), [
      'JUP/USDC | +8287.838847 USDC | +16.6661% | weighted_average_position_accounting_v1 | 1 buy / 1 sell',
      'RAY/USDT | +2347.717902 USDT | +9.39087% | weighted_average_position_accounting_v1 | 1 buy / 1 sell',
    ]);

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      '"wallet":',
      '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni',
      '5fK3484fbh8gnmhvTsPYxTC6un7Co5LVUSoubZPVL3YA',
      'entry_tx_hashes',
      'exit_tx_hashes',
      'transaction_signature',
      '2ArLuJC2JEuWiavk1jYxLQ2E4xhq63BbeDV2kCWPcZ9zZNc4XyugUEFEryKrYfqcWnxkUvyacRmj2YNTfZGq17yV',
      '2SUoNBBTkQBBGVCinvLQbVZq5LDZS5M8ikx5PLH7QiCuLdf6GWCPSM7wLd6gJsNUbLSousAhbkSX9eXgt1dAeBKm',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  for (const [path, contents] of before) assert.equal(readFileSync(path, 'utf8'), contents, path);
});

console.log(`\nProduction Share Card checker tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
