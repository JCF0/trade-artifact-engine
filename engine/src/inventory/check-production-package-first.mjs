#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveTokenDisplayMetadata } from '../display-metadata/token-display-registry.mjs';
import {
  buildInventorySnapshot,
  getInventoryReceiptSource,
} from './inventory.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofVerifierView } from '../proof-verifier/view-model.mjs';
import { buildReceiptBoardView } from '../receipt-board/view-model.mjs';
import {
  PRODUCTION_SHARE_CARD_EXPECTATIONS,
  runProductionShareCardCheck,
} from '../share-card/check-production-share-cards.mjs';
import { formatShareCardViewModel } from '../share-card/share-card-format.mjs';
import { buildShareCardViewModel } from '../share-card/share-card-view-model.mjs';

function requireExplicitRoot(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`explicit ${label}Root is required`);
  }
  return resolve(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

async function snapshotTree(root) {
  const records = [];
  async function walk(path) {
    const info = await lstat(path);
    const name = relative(root, path) || '.';
    if (info.isSymbolicLink()) throw new Error('production store contains a symbolic link');
    if (info.isDirectory()) {
      records.push({ path: name, type: 'directory', mode: info.mode & 0o777 });
      const names = (await readdir(path)).sort();
      for (const child of names) await walk(join(path, child));
      return;
    }
    if (!info.isFile()) throw new Error('production store contains a special file');
    const bytes = await readFile(path);
    records.push({
      path: name,
      type: 'file',
      mode: info.mode & 0o777,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  await walk(root);
  return createHash('sha256').update(`${JSON.stringify(stable(records))}\n`).digest('hex');
}

function packageCard(receipt) {
  const links = {
    proof_href: `proof/${receipt.receipt_hash}`,
    verifier_href: `verifier/${receipt.receipt_hash}`,
  };
  return formatShareCardViewModel(buildShareCardViewModel(receipt, {
    tokenDisplayMetadata: resolveTokenDisplayMetadata(receipt.token_mint),
    links,
  }));
}

export async function runPackageFirstProductionCheck({
  engineRoot,
  packageRoot,
  archiveRoot,
  economicsRoot,
} = {}) {
  const roots = {
    engine: requireExplicitRoot(engineRoot, 'engine'),
    package: requireExplicitRoot(packageRoot, 'package'),
    archive: requireExplicitRoot(archiveRoot, 'archive'),
    economics: requireExplicitRoot(economicsRoot, 'economics'),
  };
  const before = {
    package: await snapshotTree(roots.package),
    archive: await snapshotTree(roots.archive),
    economics: await snapshotTree(roots.economics),
  };

  const inventoryOptions = {
    engineRoot: roots.engine,
    archiveRoot: roots.archive,
    economicsRoot: roots.economics,
    includeArchive: true,
    includeLegacy: false,
    includeExcluded: false,
  };
  const legacy = buildInventorySnapshot(inventoryOptions);
  const packageFirst = await buildInventorySnapshot({ ...inventoryOptions, packageRoot: roots.package });
  assert.deepStrictEqual(packageFirst.archive.diagnostics, [], 'package-first inventory diagnostics');
  assert.strictEqual(legacy.receipts.length, 66, 'expected legacy/archive receipt count');
  assert.strictEqual(packageFirst.receipts.length, 66, 'expected package-first receipt count');
  assert.deepStrictEqual(packageFirst.receipts, legacy.receipts, 'package-first inventory output changed');
  assert.deepStrictEqual(
    packageFirst.receipts.map(receipt => receipt.receipt_hash),
    legacy.receipts.map(receipt => receipt.receipt_hash),
    'inventory order changed',
  );
  const legacyBoard = buildReceiptBoardView(inventoryOptions);
  const packageFirstBoard = await buildReceiptBoardView({
    ...inventoryOptions,
    packageRoot: roots.package,
  });
  assert.deepStrictEqual(packageFirstBoard, legacyBoard, 'receipt board order or ranking changed');

  const legacyShareCards = runProductionShareCardCheck({
    engineRoot: roots.engine,
    archiveRoot: roots.archive,
    economicsRoot: roots.economics,
  });
  const assets = [];
  for (const asset of ['JUP', 'RAY']) {
    const expected = PRODUCTION_SHARE_CARD_EXPECTATIONS[asset];
    const previous = legacy.receipts.find(receipt => receipt.receipt_hash === expected.receipt_hash);
    const receipt = packageFirst.receipts.find(item => item.receipt_hash === expected.receipt_hash);
    assert.ok(previous && receipt, `missing ${asset} receipt`);
    assert.strictEqual(getInventoryReceiptSource(packageFirst, receipt.receipt_hash), 'receipt_package_v1');
    assert.deepStrictEqual(buildProofDetailView(receipt), buildProofDetailView(previous));
    assert.deepStrictEqual(buildProofVerifierView(receipt), buildProofVerifierView(previous));
    const card = packageCard(receipt);
    const baselineCard = legacyShareCards.records.find(record => record.asset === asset).formatted_model;
    assert.deepStrictEqual(card, baselineCard, `${asset} Share Card changed`);
    assert.deepStrictEqual(card.display, expected.display, `${asset} Share Card display changed`);
    const publicShapes = JSON.stringify({
      proof: buildProofDetailView(receipt),
      verifier: buildProofVerifierView(receipt),
      share_card: card,
    });
    for (const signature of [
      ...receipt.canonical_economics.fields.entry_tx_hashes,
      ...receipt.canonical_economics.fields.exit_tx_hashes,
    ]) assert.equal(publicShapes.includes(signature), false, `${asset} transaction signature leaked`);
    for (const forbidden of [roots.package, 'package_digest', 'receipt_package_v1']) {
      assert.equal(publicShapes.includes(forbidden), false, `${asset} package metadata leaked`);
    }
    assets.push(Object.freeze({
      asset,
      receipt_hash: receipt.receipt_hash,
      realized_pnl_quote: receipt.canonical_economics.fields.realized_pnl_quote,
      realized_pnl_pct: receipt.canonical_economics.fields.realized_pnl_pct,
      quote_symbol: receipt.quote_symbol,
      display: card.display,
    }));
  }

  const packageBacked = packageFirst.receipts.filter(receipt => (
    getInventoryReceiptSource(packageFirst, receipt.receipt_hash) === 'receipt_package_v1'
  )).length;
  const legacyFallback = packageFirst.receipts.filter(receipt => (
    getInventoryReceiptSource(packageFirst, receipt.receipt_hash) === 'receipt_archive_v1'
  )).length;
  const after = {
    package: await snapshotTree(roots.package),
    archive: await snapshotTree(roots.archive),
    economics: await snapshotTree(roots.economics),
  };
  assert.deepStrictEqual(after, before, 'production store content changed during read-only check');

  return Object.freeze({
    status: 'passed',
    receipts: packageFirst.receipts.length,
    package_backed: packageBacked,
    legacy_fallback: legacyFallback,
    assets: Object.freeze(assets),
    store_hashes: Object.freeze({
      package: Object.freeze({ before: before.package, after: after.package }),
      archive: Object.freeze({ before: before.archive, after: after.archive }),
      economics: Object.freeze({ before: before.economics, after: after.economics }),
    }),
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--engine-root') options.engineRoot = argv[++index];
    else if (arg === '--package-root') options.packageRoot = argv[++index];
    else if (arg === '--archive-root') options.archiveRoot = argv[++index];
    else if (arg === '--economics-root') options.economicsRoot = argv[++index];
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const result = await runPackageFirstProductionCheck(parseArgs(argv));
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`FAIL package-first production acceptance: ${error?.message || error}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
