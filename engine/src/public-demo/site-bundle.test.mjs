import assert from 'assert';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { tmpdir } from 'os';

import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildPublicDemoBundle, writePublicDemoBundle, stableJson, PUBLIC_DEMO_HEADERS, PUBLIC_DEMO_ROBOTS } from './site-bundle.mjs';

const JUP_HASH = '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca';
const RAY_HASH = '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341';

let pass = 0;
let fail = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  PASS ${name}`);
    })
    .catch(error => {
      fail += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error.message}`);
    });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeManifest(root) {
  mkdirSync(join(root, 'samples'), { recursive: true });
  writeJson(join(root, 'samples', 'historical-receipt-board.manifest.json'), {
    version: '1.0.0',
    board_id: 'historical_verified_receipt_board_demo',
    title: 'Historical Verified Receipt Board',
    subtitle: 'Selected historical receipts only. Not a trader leaderboard.',
    selection_scope: {
      mode: 'publisher_selected',
      statement: 'Publisher-selected sample receipts for local prototype demonstration.',
    },
    ranking: {
      metric: 'trust_then_time',
      direction: 'desc',
      rank_subject: 'receipt',
      pnl_scope: 'none',
    },
    entries: [
      { receipt_hash: JUP_HASH, display_name: 'JUP Receipt 1', participant_ref: 'local-receipt-1', selection_note: 'Verified closed-position receipt selected for local prototype demonstration.' },
      { receipt_hash: RAY_HASH, display_name: 'RAY Receipt 1', participant_ref: 'local-receipt-2', selection_note: 'Verified closed-position receipt selected for local prototype demonstration.' },
    ],
  });
}

function mutateReceipt(root, oldHash, patch) {
  const path = join(root, 'data', 'debug', 'ledger-receipts-v12.json');
  const receipts = readJson(path).map(receipt => receipt.receipt_hash === oldHash ? { ...receipt, ...patch } : receipt);
  writeJson(path, receipts);
}

function mutateVerify(root, oldHash, patch) {
  const path = join(root, 'data', 'debug', 'ledger-verify-v12.json');
  const verify = readJson(path);
  verify.results = verify.results.map(result => result.receipt_hash === oldHash ? { ...result, ...patch } : result);
  writeJson(path, verify);
}

function mutateValuation(root, receiptId, patch) {
  const path = join(root, 'data', 'debug', 'ledger-valuations-v12.json');
  const valuations = readJson(path);
  valuations.contexts = valuations.contexts.map(context => context.receipt_id === receiptId ? { ...context, ...patch } : context);
  writeJson(path, valuations);
}

function createPublicDemoFixture() {
  const fixture = createInventoryFixture();
  writeManifest(fixture.root);
  const a = fixture.hashes.receiptAHash;
  const b = fixture.hashes.receiptBHash;
  mutateReceipt(fixture.root, a, {
    receipt_hash: JUP_HASH,
    receipt_id: 'art_v12_cp_JUPyiwrY_0',
    receipt_type: 'closed_position',
    token_mint: 'JUP_TOKEN',
    wallet: 'JUP_PUBLIC_WALLET_12345678901234567890',
    verification_status: 'verified',
    display_status: 'Verified Closed Position',
    valuation_status: 'raw_quote',
    position_status: 'closed',
  });
  mutateReceipt(fixture.root, b, {
    receipt_hash: RAY_HASH,
    receipt_id: 'art_v12_cp_4k3Dyjzv_0',
    receipt_type: 'closed_position',
    token_mint: 'RAY_TOKEN',
    wallet: 'RAY_PUBLIC_WALLET_12345678901234567890',
    verification_status: 'verified',
    display_status: 'Verified Closed Position',
    valuation_status: 'raw_quote',
    position_status: 'closed',
  });
  mutateVerify(fixture.root, a, { receipt_hash: JUP_HASH, receipt_id: 'art_v12_cp_JUPyiwrY_0', recomputed_hash: JUP_HASH, hash_valid: true, schema_valid: true, consistency_valid: true, pass: true });
  mutateVerify(fixture.root, b, { receipt_hash: RAY_HASH, receipt_id: 'art_v12_cp_4k3Dyjzv_0', recomputed_hash: RAY_HASH, hash_valid: true, schema_valid: true, consistency_valid: true, pass: true });
  return fixture;
}

function listTree(root, current = root, output = []) {
  if (!existsSync(root)) return [];
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stats = statSync(path);
    output.push({ path: relative(root, path), isDirectory: stats.isDirectory(), size: stats.isFile() ? stats.size : null });
    if (stats.isDirectory()) listTree(root, path, output);
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

function assertNoApi(files) {
  const serialized = Object.values(files).join('\n');
  assert.ok(!serialized.includes('/api/'));
  assert.ok(!serialized.includes('localhost'));
  assert.ok(!serialized.includes('127.0.0.1'));
}

function assertInternalLinksResolvable(outRoot) {
  const index = readFileSync(join(outRoot, 'index.html'), 'utf8');
  const hrefs = [...index.matchAll(/href="([^"]+)"/g)].map(match => match[1]).filter(href => href && !href.startsWith('#'));
  for (const href of hrefs) {
    assert.ok(existsSync(join(outRoot, href)), `missing linked file: ${href}`);
  }
}

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async (...args) => {
  fetchCalls += 1;
  throw new Error(`Unexpected fetch call: ${String(args[0])}`);
};

try {
  await test('builds deterministic file plan and byte-stable repeated builds from tracked inputs', () => {
    const first = buildPublicDemoBundle();
    const second = buildPublicDemoBundle();
    assert.deepEqual(first.fileList, second.fileList);
    assert.deepEqual(first.files, second.files);
    assert.equal(first.fileList.length, 14);
    assert.deepEqual(first.fileList, [...first.fileList].sort());
  });

  await test('exposes selected JUP and RAY receipts only', () => {
    const bundle = buildPublicDemoBundle();
    const board = JSON.parse(bundle.files['board.json']);
    assert.deepEqual(board.rows.map(row => row.receipt_hash).sort(), [JUP_HASH, RAY_HASH].sort());
    assert.equal(bundle.fileList.filter(file => file.startsWith('receipts/') && file.endsWith('/proof.json')).length, 2);
    assert.ok(!bundle.files['manifest.json'].includes('receipt_count": 66'));
  });

  await test('rewrites links to relative static paths with no api routes', () => {
    const bundle = buildPublicDemoBundle();
    assertNoApi(bundle.files);
    const board = JSON.parse(bundle.files['board.json']);
    for (const row of board.rows) {
      assert.ok(row.links.proof_api_path.startsWith('receipts/p-'));
      assert.ok(row.links.verifier_api_path.startsWith('verifier/'));
      assert.ok(row.links.card_api_path.endsWith('/proof.json'));
    }
    for (const [filename, content] of Object.entries(bundle.files).filter(([name]) => name.endsWith('/proof.json'))) {
      const proof = JSON.parse(content);
      assert.ok(proof.proof.links.verifier_path.startsWith('../../verifier/'), filename);
      assert.equal(proof.proof.links.board_path, '../../index.html');
      assert.equal(proof.proof.links.proof_api_path, './proof.json');
    }
  });

  await test('includes Cloudflare static metadata files without cache rules', () => {
    const bundle = buildPublicDemoBundle();
    assert.equal(bundle.files['_headers'], PUBLIC_DEMO_HEADERS);
    assert.equal(bundle.files['robots.txt'], PUBLIC_DEMO_ROBOTS);
    assert.ok(bundle.files['404.html'].includes('static unlisted Artifact demonstration'));
    assert.ok(bundle.files['404.html'].includes('href="/index.html"'));
    assert.ok(bundle.files['_headers'].includes("Content-Security-Policy: default-src 'none'"));
    assert.ok(bundle.files['_headers'].includes('X-Robots-Tag: noindex, nofollow'));
    assert.ok(!bundle.files['_headers'].includes('Cache-Control'));
  });

  await test('dry-run build performs no writes', () => {
    const dir = join(tmpdir(), `trade-artifact-public-demo-dry-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const before = listTree(dir);
    buildPublicDemoBundle();
    const after = listTree(dir);
    assert.deepEqual(after, before);
    rmSync(dir, { recursive: true, force: true });
  });

  await test('write mode stays within output root and links resolve locally', () => {
    const dir = join(tmpdir(), `trade-artifact-public-demo-write-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const bundle = buildPublicDemoBundle();
    try {
      const written = writePublicDemoBundle(bundle, { outRoot: dir });
      assert.equal(resolve(written.outRoot), resolve(dir));
      for (const path of written.files) {
        assert.ok(relative(dir, path) && !relative(dir, path).startsWith('..'));
      }
      assertInternalLinksResolvable(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('write mode refuses non-empty output without force', () => {
    const dir = join(tmpdir(), `trade-artifact-public-demo-nonempty-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'existing.txt'), 'keep', 'utf8');
    try {
      assert.throws(() => writePublicDemoBundle(buildPublicDemoBundle(), { outRoot: dir }), /not empty/);
      assert.equal(readFileSync(join(dir, 'existing.txt'), 'utf8'), 'keep');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('fails closed for unverified selected receipt', () => {
    const fixture = createPublicDemoFixture();
    try {
      mutateReceipt(fixture.root, JUP_HASH, { verification_status: 'unverified' });
      assert.throws(() => buildPublicDemoBundle({ engineRoot: fixture.root }), /verification_status/);
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('fails closed for non-closed selected receipt', () => {
    const fixture = createPublicDemoFixture();
    try {
      mutateReceipt(fixture.root, JUP_HASH, { receipt_type: 'open_snapshot' });
      assert.throws(() => buildPublicDemoBundle({ engineRoot: fixture.root }), /receipt_type/);
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('fails closed for non-raw-quote selected receipt', () => {
    const fixture = createPublicDemoFixture();
    try {
      mutateReceipt(fixture.root, JUP_HASH, { valuation_status: 'usd_normalized' });
      mutateValuation(fixture.root, 'art_v12_cp_JUPyiwrY_0', { valuation_status: 'usd_normalized' });
      assert.throws(() => buildPublicDemoBundle({ engineRoot: fixture.root }), /valuation_status/);
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('fails closed for verifier failures', () => {
    const fixture = createPublicDemoFixture();
    try {
      mutateVerify(fixture.root, JUP_HASH, { pass: false });
      assert.throws(() => buildPublicDemoBundle({ engineRoot: fixture.root }), /verifier_passed/);
    } finally {
      removeInventoryFixture(fixture.root);
    }
  });

  await test('omits diagnostic metadata, archive records, local paths, and full wallets', () => {
    const bundle = buildPublicDemoBundle();
    const serialized = Object.values(bundle.files).join('\n');
    assert.ok(!serialized.includes('diagnostics'));
    assert.ok(!serialized.includes('canonical_receipt_record'));
    assert.ok(!serialized.includes('inventory_record'));
    assert.ok(!serialized.includes('C:\\'));
    assert.ok(!serialized.includes('data/debug'));
    const proofFiles = Object.entries(bundle.files).filter(([name]) => name.endsWith('/proof.json'));
    for (const [, content] of proofFiles) {
      const proof = JSON.parse(content);
      assert.ok(proof.proof.receipt.wallet.includes('...') || proof.proof.receipt.wallet === '[redacted]');
    }
  });

  await test('does not mutate archive/canonical receipt files and performs no network calls', () => {
    const indexPath = 'engine/data/inventory/receipt-archive-v1/index.json';
    const before = readFileSync(indexPath, 'utf8');
    const beforeFetch = fetchCalls;
    buildPublicDemoBundle();
    const after = readFileSync(indexPath, 'utf8');
    assert.equal(after, before);
    assert.equal(fetchCalls, beforeFetch);
  });

  await test('stableJson orders keys recursively', () => {
    assert.equal(stableJson({ b: 1, a: { d: 2, c: 3 } }), '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);