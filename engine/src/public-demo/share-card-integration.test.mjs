import assert from 'assert';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { buildReceiptBoardView, readReceiptBoardManifest } from '../receipt-board/view-model.mjs';
import {
  buildPublicDemoBundle,
  PUBLIC_DEMO_HEADERS,
  PUBLIC_DEMO_ROBOTS,
} from './site-bundle.mjs';

const ENGINE_ROOT = resolve('engine');
const ARCHIVE_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-archive-v1');
const ECONOMICS_ROOT = resolve(ENGINE_ROOT, 'data/inventory/receipt-economics-v1');
const JUP_HASH = '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca';
const RAY_HASH = '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341';

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

function build(options = {}) {
  return buildPublicDemoBundle({
    engineRoot: ENGINE_ROOT,
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
    ...options,
  });
}

function withTempDirectory(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function snapshotFiles(root) {
  const snapshot = {};
  function visit(current) {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) visit(path);
      else snapshot[path.slice(root.length + 1)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  visit(root);
  return snapshot;
}

test('requires explicit engine, archive, and economics roots', () => {
  assert.throws(
    () => buildPublicDemoBundle({ archiveRoot: ARCHIVE_ROOT, economicsRoot: ECONOMICS_ROOT }),
    /explicit engine root/i,
  );
  assert.throws(
    () => buildPublicDemoBundle({ engineRoot: ENGINE_ROOT, economicsRoot: ECONOMICS_ROOT }),
    /explicit archive root/i,
  );
  assert.throws(
    () => buildPublicDemoBundle({ engineRoot: ENGINE_ROOT, archiveRoot: ARCHIVE_ROOT }),
    /explicit economics root/i,
  );
});

test('generates the exact production JUP and RAY Share Card routes', () => {
  const bundle = build();
  const expected = [
    [`share/${JUP_HASH}/index.html`, [
      'JUP/USDC', '+8,287.84 USDC', '+16.67%', '0.186984 USDC', '0.218147 USDC',
      '265,951.319268 JUP', '49,728.69 USDC', '58,016.53 USDC',
    ]],
    [`share/${RAY_HASH}/index.html`, [
      'RAY/USDT', '+2,347.72 USDT', '+9.39%', '0.93827 USDT', '1.0264 USDT',
      '26,644.791399 RAY', '25,000.00 USDT', '27,347.72 USDT',
    ]],
  ];

  assert.deepEqual(
    bundle.fileList.filter(path => /^share\/[a-f0-9]{64}\/index\.html$/.test(path)),
    expected.map(([path]) => path).sort(),
  );
  for (const [path, displayStrings] of expected) {
    const html = bundle.files[path];
    assert.ok(html, path);
    for (const value of displayStrings) assert.ok(html.includes(value), `${path}: ${value}`);
    assert.ok(html.includes('src="/assets/artifact-logo-header.png"'), path);
  }
});

test('uses existing proof and verifier routes and exposes eligible navigation', () => {
  const bundle = build();
  const manifest = JSON.parse(bundle.files['manifest.json']);
  const board = JSON.parse(bundle.files['board.json']);
  for (const receipt of manifest.receipts) {
    const hash = receipt.receipt_hash;
    const sharePath = `share/${hash}/index.html`;
    const proofHref = `../../${receipt.index_path}`;
    const verifierHref = `../../${receipt.verifier_json_path}`;
    const shareHtml = bundle.files[sharePath];
    assert.ok(shareHtml.includes(`href="${proofHref}"`), `${sharePath}: proof`);
    assert.ok(shareHtml.includes(`href="${verifierHref}"`), `${sharePath}: verifier`);
    assert.ok(bundle.files[receipt.index_path].includes(`href="../../${sharePath}"`), `${receipt.index_path}: share`);
    const row = board.rows.find(item => item.receipt_hash === hash);
    assert.equal(row.links.share_card_path, sharePath);
    assert.ok(bundle.files['index.html'].includes(`href="${sharePath}"`), `index.html: ${sharePath}`);
    assert.ok(shareHtml.includes(`<title>Artifact Verified Receipt — ${manifest.share_cards.find(card => card.receipt_hash === hash).pair}</title>`));
    assert.ok(shareHtml.includes('<meta name="description" content="Verified closed-position receipt'));
    assert.equal(/<meta[^>]+property="og:image"/i.test(shareHtml), false);
  }
});

test('omits Share Cards and actions when verified economics are missing', () => withTempDirectory('artifact-share-card-missing-economics-', economicsRoot => {
  mkdirSync(join(economicsRoot, 'receipts'), { recursive: true });
  const bundle = build({ economicsRoot });
  assert.deepEqual(bundle.shareCards, []);
  assert.equal(bundle.fileList.some(path => path.startsWith('share/')), false);
  for (const row of bundle.board.rows) assert.equal(Object.hasOwn(row.links, 'share_card_path'), false);
  for (const path of bundle.fileList.filter(value => /^receipts\/[^/]+\/index\.html$/.test(value))) {
    assert.equal(bundle.files[path].includes('>Share Card<'), false, path);
  }
}));

test('adds Share Card actions only to receipts with verified economics', () => withTempDirectory('artifact-share-card-mixed-economics-', economicsRoot => {
  const receiptsRoot = join(economicsRoot, 'receipts');
  mkdirSync(receiptsRoot, { recursive: true });
  writeFileSync(
    join(receiptsRoot, `${JUP_HASH}.json`),
    readFileSync(join(ECONOMICS_ROOT, 'receipts', `${JUP_HASH}.json`)),
  );
  const bundle = build({ economicsRoot });
  assert.deepEqual(bundle.shareCards.map(card => card.receiptHash), [JUP_HASH]);
  const jupRow = bundle.board.rows.find(row => row.receipt_hash === JUP_HASH);
  const rayRow = bundle.board.rows.find(row => row.receipt_hash === RAY_HASH);
  assert.equal(jupRow.links.share_card_path, `share/${JUP_HASH}/index.html`);
  assert.equal(Object.hasOwn(rayRow.links, 'share_card_path'), false);
  assert.ok(bundle.files[`share/${JUP_HASH}/index.html`]);
  assert.equal(bundle.files[`share/${RAY_HASH}/index.html`], undefined);
}));

test('fails closed without producing a partial bundle for corrupt economics', () => withTempDirectory('artifact-share-card-corrupt-economics-', economicsRoot => {
  const receiptsRoot = join(economicsRoot, 'receipts');
  mkdirSync(receiptsRoot, { recursive: true });
  writeFileSync(join(receiptsRoot, `${JUP_HASH}.json`), '{ corrupt\n', 'utf8');
  assert.throws(() => build({ economicsRoot }), /archive diagnostics present/);
}));

test('keeps Share Cards private, static, local, and free of economics sidecars', () => {
  const bundle = build();
  const shareFiles = bundle.fileList.filter(path => path.startsWith('share/'));
  assert.equal(shareFiles.length, 2);
  assert.equal(bundle.fileList.some(path => /economics|sidecar|recovery/i.test(path)), false);
  for (const path of shareFiles) {
    const html = bundle.files[path];
    assert.equal(/<script\b|\son[a-z]+\s*=|\b(?:src|href)="https?:/i.test(html), false, path);
    assert.equal(/recovery_method|Helius|provider|file:\/\/|\/root\//i.test(html), false, path);
    for (const receipt of bundle.receipts) {
      assert.equal(html.includes(receipt.wallet), false, `${path}: wallet`);
      for (const signature of [
        ...(receipt.canonical_economics?.fields?.entry_tx_hashes || []),
        ...(receipt.canonical_economics?.fields?.exit_tx_hashes || []),
      ]) assert.equal(html.includes(signature), false, `${path}: signature`);
    }
  }
});

test('preserves board ranking, robots, 404, headers, determinism, and source stores', () => {
  const archiveBefore = snapshotFiles(ARCHIVE_ROOT);
  const economicsBefore = snapshotFiles(ECONOMICS_ROOT);
  const first = build();
  const second = build();
  const originalBoard = buildReceiptBoardView({
    engineRoot: ENGINE_ROOT,
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
    includeExcluded: false,
    manifest: readReceiptBoardManifest({ engineRoot: ENGINE_ROOT }),
  });
  assert.deepEqual(first.fileList, second.fileList);
  assert.deepEqual(first.files, second.files);
  assert.deepEqual(
    first.board.rows.map(({ receipt_hash, rank }) => ({ receipt_hash, rank })),
    originalBoard.rows.map(({ receipt_hash, rank }) => ({ receipt_hash, rank })),
  );
  assert.equal(first.files['_headers'], PUBLIC_DEMO_HEADERS);
  assert.equal(first.files['robots.txt'], PUBLIC_DEMO_ROBOTS);
  assert.ok(first.files['404.html'].includes('static unlisted Artifact demonstration'));
  assert.deepEqual(snapshotFiles(ARCHIVE_ROOT), archiveBefore);
  assert.deepEqual(snapshotFiles(ECONOMICS_ROOT), economicsBefore);
});

console.log(`\nShare Card public-demo integration tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
