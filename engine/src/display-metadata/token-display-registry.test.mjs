import assert from 'assert';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

import {
  buildTokenDisplayRegistry,
  parseTokenDisplayRegistry,
  resolveTokenDisplayMetadata,
} from './token-display-registry.mjs';

const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const RAY_MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const UNKNOWN_MINT = 'So11111111111111111111111111111111111111112';
const DATA_URL = new URL('../../assets/data/token-display-metadata-v1.json', import.meta.url);

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.stack || error.message}`);
  }
}

function sortStable(value) {
  if (Array.isArray(value)) return value.map(sortStable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortStable(value[key])]));
}

function stableJson(value) {
  return `${JSON.stringify(sortStable(value), null, 2)}\n`;
}

function recordHash(record) {
  const { metadata_record_hash: omitted, ...payload } = record;
  return createHash('sha256').update(stableJson(payload), 'utf8').digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertRegistryError(code) {
  return error => error?.name === 'TokenDisplayRegistryError' && error?.code === code;
}

const rawRegistry = readFileSync(DATA_URL, 'utf8');
const document = JSON.parse(rawRegistry);

test('exact JUP lookup returns curated symbol display metadata', () => {
  assert.deepEqual(resolveTokenDisplayMetadata(JUP_MINT), {
    mint: JUP_MINT,
    display: 'JUP',
    display_kind: 'symbol',
    symbol: 'JUP',
    name: 'Jupiter',
    source: {
      type: 'curated_snapshot',
      provider: 'project_review',
    },
  });
});

test('exact RAY lookup returns curated symbol display metadata', () => {
  assert.deepEqual(resolveTokenDisplayMetadata(RAY_MINT), {
    mint: RAY_MINT,
    display: 'RAY',
    display_kind: 'symbol',
    symbol: 'RAY',
    name: 'Raydium',
    source: {
      type: 'curated_snapshot',
      provider: 'project_review',
    },
  });
});

test('unknown full mint returns a typed shortened-mint fallback', () => {
  assert.deepEqual(resolveTokenDisplayMetadata(UNKNOWN_MINT), {
    mint: UNKNOWN_MINT,
    display: 'So111111...',
    display_kind: 'mint_prefix',
  });
});

test('fallback is never exposed as symbol and a similar full mint does not match by prefix', () => {
  const similarMint = `${JUP_MINT.slice(0, -1)}P`;
  const result = resolveTokenDisplayMetadata(similarMint);
  assert.equal(result.display_kind, 'mint_prefix');
  assert.equal(Object.hasOwn(result, 'symbol'), false);
  assert.equal(Object.hasOwn(result, 'name'), false);
  assert.equal(result.display, 'JUPyiwrY...');
});

test('duplicate and conflicting full-mint entries both fail closed', () => {
  const duplicate = clone(document);
  duplicate.records.push(clone(duplicate.records[0]));
  assert.throws(() => buildTokenDisplayRegistry(duplicate), assertRegistryError('duplicate_mint'));

  const conflict = clone(document);
  const conflictingRecord = clone(conflict.records[0]);
  conflictingRecord.symbol = 'OTHER';
  conflictingRecord.metadata_record_hash = recordHash(conflictingRecord);
  conflict.records.push(conflictingRecord);
  assert.throws(() => buildTokenDisplayRegistry(conflict), assertRegistryError('duplicate_mint'));
});

test('tampered record metadata fails its deterministic hash check', () => {
  const tampered = clone(document);
  tampered.records[0].name = 'Tampered';
  assert.throws(() => buildTokenDisplayRegistry(tampered), assertRegistryError('record_hash_mismatch'));
});

test('registry resolution performs no live or network behavior', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error('network access is forbidden');
  };
  try {
    resolveTokenDisplayMetadata(JUP_MINT);
    resolveTokenDisplayMetadata(UNKNOWN_MINT);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('static registry contains no remote URL or URI fields', () => {
  const serialized = JSON.stringify(document).toLowerCase();
  assert.ok(!serialized.includes('http://'));
  assert.ok(!serialized.includes('https://'));

  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!/(^|_)(url|uri)$/.test(key.toLowerCase()), `remote locator field is forbidden: ${key}`);
      visit(child);
    }
  }
  visit(document);
});

test('LF and CRLF registry text produce identical validated records', () => {
  const lf = parseTokenDisplayRegistry(rawRegistry.replace(/\r\n/g, '\n'));
  const crlf = parseTokenDisplayRegistry(rawRegistry.replace(/\r?\n/g, '\r\n'));
  assert.deepEqual(lf.records, crlf.records);
  assert.deepEqual(lf.resolve(JUP_MINT), crlf.resolve(JUP_MINT));
});

test('registry JSON is recursively key-sorted, record-sorted, LF-terminated, and hash-stable', () => {
  assert.equal(rawRegistry, stableJson(document));
  assert.ok(!rawRegistry.includes('\r'));
  assert.deepEqual(document.records.map(record => record.mint), [RAY_MINT, JUP_MINT]);
  for (const record of document.records) {
    assert.match(record.metadata_record_hash, /^[a-f0-9]{64}$/);
    assert.equal(record.metadata_record_hash, recordHash(record));
  }
});

test('conservative symbol and name rules fail closed', () => {
  const badSymbol = clone(document);
  badSymbol.records[0].symbol = 'RAY/USDC';
  badSymbol.records[0].metadata_record_hash = recordHash(badSymbol.records[0]);
  assert.throws(() => buildTokenDisplayRegistry(badSymbol), assertRegistryError('invalid_symbol'));

  const badName = clone(document);
  badName.records[0].name = 'Raydium™';
  badName.records[0].metadata_record_hash = recordHash(badName.records[0]);
  assert.throws(() => buildTokenDisplayRegistry(badName), assertRegistryError('invalid_name'));
});

test('metadata lookup does not mutate receipt or canonical economics objects', () => {
  const inventoryReceipt = {
    receipt_hash: 'a'.repeat(64),
    receipt_id: 'receipt_0001_JUPyiwrY',
    token_mint: JUP_MINT,
    canonical_economics: {
      status: 'verified',
      fields: { realized_pnl_quote: 12.5, accounting_method: 'weighted_average' },
    },
  };
  const economics = inventoryReceipt.canonical_economics;
  const beforeReceipt = structuredClone(inventoryReceipt);
  const beforeEconomics = structuredClone(economics);

  const metadata = resolveTokenDisplayMetadata(inventoryReceipt.token_mint);

  assert.equal(metadata.symbol, 'JUP');
  assert.deepEqual(inventoryReceipt, beforeReceipt);
  assert.deepEqual(economics, beforeEconomics);
});

test('validated registry records and nested provenance are immutable', () => {
  const registry = parseTokenDisplayRegistry(rawRegistry);
  assert.throws(() => {
    registry.records[0].source.provider = 'runtime_override';
  }, TypeError);
  assert.equal(registry.resolve(RAY_MINT).source.provider, 'project_review');
});

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
