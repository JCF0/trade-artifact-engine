/**
 * Upload Package Scaffold Tests — E4
 *
 * Tests for metadata template generation and upload package building.
 */

import {
  buildMetadataTemplate,
  hashTemplate,
  buildUploadPackage,
} from './upload-package.mjs';
import { buildReceiptMetadata } from './receipt-metadata.mjs';
import { buildReceiptPreview } from './receipt-preview.mjs';
import { SOL_MINT } from '../pipeline/constants.mjs';

// ═══════════════════════════════════════════════════════════════
// Test harness
// ═══════════════════════════════════════════════════════════════

let _passed = 0;
let _failed = 0;
let _total = 0;

function test(name, fn) {
  _total++;
  try {
    fn();
    _passed++;
  } catch (e) {
    _failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

// ═══════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════

function makeReceipt(type) {
  const base = {
    receipt_id: `art_v12_xx_TESTMINT_0`,
    receipt_version: '1.2.0',
    receipt_type: type,
    token_mint: 'TESTMINT1234567890123456789012345678901234abcd',
    wallet: 'TESTWALLET12345678901234567890123456789012345',
    chain: 'solana',
    segment_index: 0,
    receipt_hash: 'a'.repeat(64),
    verification_status: 'verified',
    display_status: 'Verified Closed Position',
    accounting_method: 'weighted_average_position_accounting_v1',
    quote_mint: SOL_MINT,
    quote_symbol: 'SOL',
    valuation_status: 'raw_quote',
    total_bought_qty: 1000,
    total_bought_quote: 10,
    avg_buy_quote_price: 0.01,
    total_sold_qty: 1000,
    total_sold_quote: 15,
    avg_sell_quote_price: 0.015,
    allocated_cost_basis_quote: 10,
    remaining_qty: 0,
    remaining_cost_basis_quote: 0,
    realized_pnl_quote: 5,
    realized_pnl_pct: 50,
    first_event_at: 1700000000,
    last_event_at: 1700100000,
    snapshot_at: null,
    hold_time_seconds: 100000,
    entry_tx_hashes: ['aaaa1111'],
    exit_tx_hashes: ['bbbb2222'],
    num_buys: 1,
    num_sells: 1,
    candidate_hash: 'c'.repeat(64),
    limitations: {
      receipt_scope: 'closed_position',
      pnl_type: 'realized_closed',
      price_source: 'on_chain_swaps',
      valuation_currency: 'raw_quote',
      disclosures: ['no_usd_normalization'],
    },
    flags: [],
  };
  return base;
}

function makeMetadata() {
  const receipt = makeReceipt('closed_position');
  const preview = buildReceiptPreview(receipt);
  return buildReceiptMetadata(receipt, preview);
}

function makeArtifact(receiptId) {
  return {
    receipt_id: receiptId || 'art_v12_xx_TESTMINT_0',
    receipt_type: 'closed_position',
    display_status: 'Verified Closed Position',
    artifact_type: 'svg',
    local_path: `data/debug/receipt-images-v12/${receiptId || 'art_v12_xx_TESTMINT_0'}.svg`,
    content_type: 'image/svg+xml',
    render_status: 'rendered',
    upload_status: 'not_uploaded',
    file_size_bytes: 4000,
    artifact_hash: 'sha256:' + 'b'.repeat(64),
    proof: {
      receipt_hash_short: 'aaaaaaaaaaaa...',
      candidate_hash_short: 'cccccccccccc...',
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATE GENERATION (4 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Template generation ──');

test('has _template block, not _scaffold', () => {
  const t = buildMetadataTemplate(makeMetadata(), makeArtifact());
  assert(t._template, '_template should exist');
  assert(t._template.version === '1.0.0');
  assert(t._template.status === 'pending_upload');
  assert(!t._scaffold, '_scaffold should NOT exist');
});

test('image is placeholder object', () => {
  const t = buildMetadataTemplate(makeMetadata(), makeArtifact());
  assert(t.image && t.image.__placeholder === 'image_uri', 'image should be placeholder');
  assert(t.image.status === 'awaiting_upload');
  assert(t.image.local_artifact.includes('.svg'), 'should reference SVG');
});

test('external_url is placeholder object', () => {
  const t = buildMetadataTemplate(makeMetadata(), makeArtifact());
  assert(t.external_url && t.external_url.__placeholder === 'external_url');
  assert(t.external_url.status === 'awaiting_configuration');
});

test('properties.files[0].uri is placeholder object', () => {
  const t = buildMetadataTemplate(makeMetadata(), makeArtifact());
  assert(t.properties.files.length === 1, 'should have 1 file entry');
  assert(t.properties.files[0].uri.__placeholder === 'image_uri');
  assert(t.properties.files[0].type === 'image/svg+xml');
});

// ═══════════════════════════════════════════════════════════════
// PLACEHOLDER STRUCTURE (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Placeholder structure ──');

test('__placeholder key present in all URI fields', () => {
  const t = buildMetadataTemplate(makeMetadata(), makeArtifact());
  assert(typeof t.image.__placeholder === 'string');
  assert(typeof t.external_url.__placeholder === 'string');
  assert(typeof t.properties.files[0].uri.__placeholder === 'string');
});

test('status is string on all placeholders', () => {
  const t = buildMetadataTemplate(makeMetadata(), makeArtifact());
  assert(typeof t.image.status === 'string');
  assert(typeof t.external_url.status === 'string');
  assert(typeof t.properties.files[0].uri.status === 'string');
});

test('local_artifact links to image path', () => {
  const art = makeArtifact();
  const t = buildMetadataTemplate(makeMetadata(), art);
  assert(t.image.local_artifact === art.local_path, `got ${t.image.local_artifact}`);
});

// ═══════════════════════════════════════════════════════════════
// PACKAGE ENTRY (4 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Package entry ──');

test('has all required fields', () => {
  const { packages } = buildUploadPackage([makeMetadata()], [makeArtifact()]);
  const p = packages[0];
  assert(p.receipt_id === 'art_v12_xx_TESTMINT_0');
  assert(p.receipt_hash === 'a'.repeat(64));
  assert(p.candidate_hash === 'c'.repeat(64));
  assert(p.metadata_content_type === 'application/json');
  assert(p.image_content_type === 'image/svg+xml');
  assert(p.upload_status === 'not_uploaded');
  assert(p.image_uri === null);
  assert(p.metadata_uri === null);
  assert(p.external_url === null);
});

test('paths correct', () => {
  const { packages } = buildUploadPackage([makeMetadata()], [makeArtifact()]);
  const p = packages[0];
  assert(p.metadata_template_path === 'data/debug/metadata-packages-v12/art_v12_xx_TESTMINT_0.metadata.template.json');
  assert(p.image_artifact_path === 'data/debug/receipt-images-v12/art_v12_xx_TESTMINT_0.svg');
});

test('hashes present and sha256 prefixed', () => {
  const { packages } = buildUploadPackage([makeMetadata()], [makeArtifact()]);
  const p = packages[0];
  assert(p.metadata_template_hash.startsWith('sha256:'), `got ${p.metadata_template_hash}`);
  assert(p.metadata_template_hash.length === 7 + 64, 'sha256: + 64 hex chars');
  assert(p.image_artifact_hash.startsWith('sha256:'));
});

test('content types correct', () => {
  const { packages } = buildUploadPackage([makeMetadata()], [makeArtifact()]);
  const p = packages[0];
  assert(p.metadata_content_type === 'application/json');
  assert(p.image_content_type === 'image/svg+xml');
});

// ═══════════════════════════════════════════════════════════════
// UPLOAD BLOCKERS (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Upload blockers ──');

test('default has 2 blockers', () => {
  const { packages } = buildUploadPackage([makeMetadata()], [makeArtifact()]);
  const p = packages[0];
  assert(p.upload_blockers.length === 2, `expected 2, got ${p.upload_blockers.length}`);
  assert(p.upload_blockers.includes('image_not_uploaded'));
  assert(p.upload_blockers.includes('metadata_not_uploaded'));
});

test('upload_status is not_uploaded, scaffold is blocked', () => {
  const { packages } = buildUploadPackage([makeMetadata()], [makeArtifact()]);
  const p = packages[0];
  assert(p.upload_status === 'not_uploaded');
  assert(p._upload_scaffold.status === 'blocked');
  assert(p._upload_scaffold.version === '1.0.0');
});

// ═══════════════════════════════════════════════════════════════
// UPLOAD ORDER (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Upload order ──');

test('upload order is image then metadata', () => {
  const { packages } = buildUploadPackage([makeMetadata()], [makeArtifact()]);
  const p = packages[0];
  assert(p.upload_order[0] === 'image');
  assert(p.upload_order[1] === 'metadata');
  assert(p.required_before_upload.length === 2);
  assert(p.required_before_upload[0].step === 'upload_image');
  assert(p.required_before_upload[1].step === 'upload_metadata');
});

// ═══════════════════════════════════════════════════════════════
// DETERMINISM (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Determinism ──');

test('same inputs → identical template + hash', () => {
  const meta = makeMetadata();
  const art = makeArtifact();
  const t1 = buildMetadataTemplate(meta, art);
  const t2 = buildMetadataTemplate(meta, art);
  const h1 = hashTemplate(t1);
  const h2 = hashTemplate(t2);
  assert(JSON.stringify(t1) === JSON.stringify(t2), 'templates should be identical');
  assert(h1 === h2, 'hashes should be identical');
});

// ═══════════════════════════════════════════════════════════════
// FILENAME SAFETY (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Filename safety ──');

test('unsafe receipt_id in metadata throws during package build', () => {
  const meta = makeMetadata();
  meta.properties.receipt_id = '../etc/passwd';
  const art = makeArtifact('../etc/passwd');
  let threw = false;
  try {
    buildUploadPackage([meta], [art]);
  } catch {
    threw = true;
  }
  assert(threw, 'should throw for unsafe filename');
});

// ═══════════════════════════════════════════════════════════════
// TEMPLATE PRESERVES METADATA CONTENT (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Template content ──');

test('template preserves name, symbol, description, attributes from E1', () => {
  const meta = makeMetadata();
  const t = buildMetadataTemplate(meta, makeArtifact());
  assert(t.name === meta.name, 'name');
  assert(t.symbol === meta.symbol, 'symbol');
  assert(t.description === meta.description, 'description');
  assert(t.attributes.length === meta.attributes.length, 'attributes count');
  assert(t.properties.receipt_hash === meta.properties.receipt_hash, 'receipt_hash');
  assert(t.properties.valuation_status === meta.properties.valuation_status, 'valuation_status');
});

// ═══════════════════════════════════════════════════════════════
// BATCH (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Batch ──');

test('batch: multiple entries', () => {
  const metas = [makeMetadata(), makeMetadata()];
  metas[1].properties.receipt_id = 'art_v12_xx_TESTMINT_1';
  metas[1].name = 'Trade Receipt #art_v12_xx_TESTMINT_1';
  const arts = [makeArtifact('art_v12_xx_TESTMINT_0'), makeArtifact('art_v12_xx_TESTMINT_1')];
  const { packages, templates } = buildUploadPackage(metas, arts);
  assert(packages.length === 2, `expected 2 packages, got ${packages.length}`);
  assert(templates.length === 2, `expected 2 templates, got ${templates.length}`);
  assert(packages[0].receipt_id === 'art_v12_xx_TESTMINT_0');
  assert(packages[1].receipt_id === 'art_v12_xx_TESTMINT_1');
});

test('batch: empty arrays', () => {
  const { packages, templates } = buildUploadPackage([], []);
  assert(packages.length === 0);
  assert(templates.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Upload Package: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
