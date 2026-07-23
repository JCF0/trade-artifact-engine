import assert from 'assert';
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

import {
  PRODUCTION_SHARE_CARD_LOGO_HREF,
  PRODUCTION_SHARE_CARD_EXPECTATIONS,
  runProductionShareCardCheck,
} from './check-production-share-cards.mjs';

const ENGINE_ROOT = resolve('engine');
const ARCHIVE_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-archive-v1');
const ECONOMICS_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-economics-v1');

function listStoreFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listStoreFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function snapshotStores() {
  const paths = [...listStoreFiles(ARCHIVE_ROOT), ...listStoreFiles(ECONOMICS_ROOT)].sort();
  return new Map(paths.map(path => [path, readFileSync(path)]));
}

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

test('uses the existing sanctioned derived public-demo header logo path', () => {
  assert.equal(PRODUCTION_SHARE_CARD_LOGO_HREF, '/assets/artifact-logo-header.png');
});

test('builds only the exact production JUP and RAY models without network access or writes', () => {
  const before = snapshotStores();
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
      'JUP/USDC | +8,287.84 USDC | +16.67% | weighted_average_position_accounting_v1 | 1 buy / 1 sell',
      'RAY/USDT | +2,347.72 USDT | +9.39% | weighted_average_position_accounting_v1 | 1 buy / 1 sell',
    ]);
    assert.deepEqual(result.records.map(record => record.formatted_model.display), [
      {
        pair: 'JUP/USDC',
        realized_pnl_quote: '+8,287.84 USDC',
        realized_pnl_pct: '+16.67%',
        avg_entry_quote_price: '0.186984 USDC',
        avg_exit_quote_price: '0.218147 USDC',
        quantity_closed: '265,951.319268 JUP',
        entry_cost_quote: '49,728.69 USDC',
        exit_proceeds_quote: '58,016.53 USDC',
        opened_at: '2026-06-19 21:24 UTC',
        closed_at: '2026-06-21 19:06 UTC',
        duration: '1d 21h 42m 26s',
        receipt_hash_short: '5fb5732d248a...5ddf02a0bbca',
      },
      {
        pair: 'RAY/USDT',
        realized_pnl_quote: '+2,347.72 USDT',
        realized_pnl_pct: '+9.39%',
        avg_entry_quote_price: '0.93827 USDT',
        avg_exit_quote_price: '1.0264 USDT',
        quantity_closed: '26,644.791399 RAY',
        entry_cost_quote: '25,000.00 USDT',
        exit_proceeds_quote: '27,347.72 USDT',
        opened_at: '2026-01-25 23:04 UTC',
        closed_at: '2026-01-28 20:37 UTC',
        duration: '2d 21h 32m 55s',
        receipt_hash_short: '4d33969c45a0...84d4570e4341',
      },
    ]);
    for (const record of result.records) {
      assert.strictEqual(
        record.formatted_model.hero.realized_pnl_quote.value,
        record.model.hero.realized_pnl_quote.value,
      );
      assert.strictEqual(
        record.formatted_model.accounting_summary.exit_proceeds_quote,
        record.model.accounting_summary.exit_proceeds_quote,
      );
      assert.equal(Object.isFrozen(record.formatted_model.display), true);
      assert.equal(record.html.startsWith('<!doctype html>\n'), true);
      assert.equal(record.html.includes(`Artifact Verified Receipt — ${record.formatted_model.display.pair}`), true);
      for (const displayValue of Object.values(record.formatted_model.display)) {
        assert.equal(record.html.includes(displayValue), true, `${record.asset} HTML display: ${displayValue}`);
      }
    }
    assert.deepEqual(result.records.map(record => record.html_sha256), [
      '36a7d18426aaeb67290932eb2d70439bb4812f0245cb5d038150b0d7f2455027',
      'ded1a0e200213e11aa761272535f23050ea40c7f0023b85cc34e226efdcf40c8',
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
      '<script',
      'Helius',
      '/root/',
      'file://',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const after = snapshotStores();
  assert.deepEqual([...after.keys()], [...before.keys()], 'production input store file inventory changed');
  for (const [path, contents] of before) assert.deepEqual(after.get(path), contents, path);
});

console.log(`\nProduction Share Card checker tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
