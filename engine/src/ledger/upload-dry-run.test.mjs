/**
 * Upload Dry Run Tests — E5
 *
 * Tests for placeholder resolution, fake URI generation,
 * unresolved detection, and dry-run manifest building.
 */

import {
  resolvePlaceholders,
  findUnresolvedPlaceholders,
  buildResolvedMetadata,
  hashResolved,
  buildDryRunEntry,
  buildDryRunBatch,
} from './upload-dry-run.mjs';
import { buildMetadataTemplate } from './upload-package.mjs';
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

function makeReceipt() {
  return {
    receipt_id: 'art_v12_xx_TESTMINT_0',
    receipt_version: '1.2.0',
    receipt_type: 'closed_position',
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
}

function makeArtifact() {
  return {
    receipt_id: 'art_v12_xx_TESTMINT_0',
    local_path: 'data/debug/receipt-images-v12/art_v12_xx_TESTMINT_0.svg',
    content_type: 'image/svg+xml',
    artifact_hash: 'sha256:' + 'b'.repeat(64),
  };
}

function makePackageEntry() {
  return {
    receipt_id: 'art_v12_xx_TESTMINT_0',
    receipt_hash: 'a'.repeat(64),
    candidate_hash: 'c'.repeat(64),
    metadata_template_path: 'data/debug/metadata-packages-v12/art_v12_xx_TESTMINT_0.metadata.template.json',
    metadata_template_hash: 'sha256:' + 'd'.repeat(64),
    image_artifact_path: 'data/debug/receipt-images-v12/art_v12_xx_TESTMINT_0.svg',
    image_artifact_hash: 'sha256:' + 'b'.repeat(64),
    image_content_type: 'image/svg+xml',
  };
}

function makeTemplate() {
  const receipt = makeReceipt();
  const preview = buildReceiptPreview(receipt);
  const metadata = buildReceiptMetadata(receipt, preview);
  return buildMetadataTemplate(metadata, makeArtifact());
}

// ═══════════════════════════════════════════════════════════════
// PLACEHOLDER RESOLUTION (4 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Placeholder resolution \u2500\u2500');

test('image resolved to string', () => {
  const tmpl = makeTemplate();
  const { resolved } = buildResolvedMetadata(tmpl, 'artifact-dryrun://image/test/hash', 'sha256:src');
  assert(typeof resolved.image === 'string', `image should be string, got ${typeof resolved.image}`);
  assert(resolved.image.startsWith('artifact-dryrun://'), `got ${resolved.image}`);
});

test('files[0].uri resolved to same image URI', () => {
  const tmpl = makeTemplate();
  const { resolved } = buildResolvedMetadata(tmpl, 'artifact-dryrun://image/test/hash', 'sha256:src');
  assert(resolved.properties.files[0].uri === resolved.image, 'files[0].uri should match image');
});

test('external_url resolved to null', () => {
  const tmpl = makeTemplate();
  const { resolved } = buildResolvedMetadata(tmpl, 'artifact-dryrun://image/test/hash', 'sha256:src');
  assert(resolved.external_url === null, `got ${resolved.external_url}`);
});

test('no __placeholder objects remain after resolution', () => {
  const tmpl = makeTemplate();
  const { resolved, unresolved } = buildResolvedMetadata(tmpl, 'artifact-dryrun://image/test/hash', 'sha256:src');
  assert(unresolved.length === 0, `unresolved: ${JSON.stringify(unresolved)}`);
  const remaining = findUnresolvedPlaceholders(resolved);
  assert(remaining.length === 0, `remaining: ${JSON.stringify(remaining)}`);
});

// ═══════════════════════════════════════════════════════════════
// FAKE URI FORMAT (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Fake URI format \u2500\u2500');

test('simulated image URI has correct format', () => {
  const { entry } = buildDryRunEntry(makePackageEntry(), makeTemplate());
  assert(entry.simulated_image_uri.startsWith('artifact-dryrun://image/'), `got ${entry.simulated_image_uri}`);
  assert(entry.simulated_image_uri.includes('art_v12_xx_TESTMINT_0'), 'should contain receipt_id');
  assert(entry.simulated_image_uri.includes('sha256:'), 'should contain hash');
});

test('simulated metadata URI has correct format', () => {
  const { entry } = buildDryRunEntry(makePackageEntry(), makeTemplate());
  assert(entry.simulated_metadata_uri.startsWith('artifact-dryrun://metadata/'), `got ${entry.simulated_metadata_uri}`);
  assert(entry.simulated_metadata_uri.includes('art_v12_xx_TESTMINT_0'));
  assert(entry.simulated_metadata_uri.includes('sha256:'));
});

// ═══════════════════════════════════════════════════════════════
// TEMPLATE STRIPPING (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Template stripping \u2500\u2500');

test('_template removed from resolved metadata', () => {
  const tmpl = makeTemplate();
  assert(tmpl._template, 'template should have _template before resolution');
  const { resolved } = buildResolvedMetadata(tmpl, 'artifact-dryrun://image/test/hash', 'sha256:src');
  assert(!resolved._template, '_template should be removed');
});

test('_dry_run present with correct fields', () => {
  const { resolved } = buildResolvedMetadata(makeTemplate(), 'artifact-dryrun://image/test/hash', 'sha256:src');
  assert(resolved._dry_run, '_dry_run should exist');
  assert(resolved._dry_run.version === '1.0.0');
  assert(resolved._dry_run.status === 'simulated_upload_only');
  assert(typeof resolved._dry_run.simulated_image_uri === 'string');
  assert(typeof resolved._dry_run.source_template_hash === 'string');
  assert(typeof resolved._dry_run.notes === 'string');
  // simulated_metadata_uri must NOT be in file (correction 1)
  assert(!resolved._dry_run.simulated_metadata_uri, 'must not have simulated_metadata_uri in file');
});

// ═══════════════════════════════════════════════════════════════
// UNRESOLVED DETECTION (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Unresolved detection \u2500\u2500');

test('known placeholders fully resolved \u2192 unresolved empty', () => {
  const { entry } = buildDryRunEntry(makePackageEntry(), makeTemplate());
  assert(entry.placeholders_resolved === true);
  assert(entry.unresolved_placeholders.length === 0);
});

test('unknown placeholder type left intact and reported', () => {
  const tmpl = makeTemplate();
  // Inject an unknown placeholder
  tmpl.properties.custom_field = { __placeholder: 'mystery_uri', status: 'unknown' };
  const { resolved, unresolved } = buildResolvedMetadata(tmpl, 'artifact-dryrun://image/test/hash', 'sha256:src');
  assert(unresolved.length === 1, `expected 1 unresolved, got ${unresolved.length}`);
  assert(unresolved[0].placeholder === 'mystery_uri', `got ${unresolved[0].placeholder}`);
  // The unknown placeholder should still be an object in the resolved output
  assert(resolved.properties.custom_field.__placeholder === 'mystery_uri', 'should be left intact');
});

// ═══════════════════════════════════════════════════════════════
// MANIFEST ENTRY (3 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Manifest entry \u2500\u2500');

test('all required fields present', () => {
  const { entry } = buildDryRunEntry(makePackageEntry(), makeTemplate());
  assert(entry.receipt_id === 'art_v12_xx_TESTMINT_0');
  assert(entry.receipt_hash === 'a'.repeat(64));
  assert(entry.candidate_hash === 'c'.repeat(64));
  assert(entry.image_artifact_path);
  assert(entry.metadata_template_path);
  assert(entry.resolved_metadata_path.includes('.metadata.resolved.dryrun.json'));
  assert(entry.upload_mode === 'dry_run');
  assert(entry.upload_status === 'simulated_not_uploaded');
  assert(entry.live_upload_ready === false);
});

test('hashes are sha256 prefixed', () => {
  const { entry } = buildDryRunEntry(makePackageEntry(), makeTemplate());
  assert(entry.image_artifact_hash.startsWith('sha256:'));
  assert(entry.metadata_template_hash.startsWith('sha256:'));
  assert(entry.resolved_metadata_hash.startsWith('sha256:'));
});

test('live_upload_blockers has 3 entries', () => {
  const { entry } = buildDryRunEntry(makePackageEntry(), makeTemplate());
  assert(entry.live_upload_blockers.length === 3, `got ${entry.live_upload_blockers.length}`);
  assert(entry.live_upload_blockers.includes('real_uploader_not_configured'));
  assert(entry.live_upload_blockers.includes('actual_upload_not_performed'));
  assert(entry.live_upload_blockers.includes('explicit_upload_approval_required'));
});

// ═══════════════════════════════════════════════════════════════
// DETERMINISM (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Determinism \u2500\u2500');

test('same inputs \u2192 identical resolved file + hash', () => {
  const pkg = makePackageEntry();
  const tmpl = makeTemplate();
  const r1 = buildDryRunEntry(pkg, tmpl);
  const r2 = buildDryRunEntry(pkg, tmpl);
  assert(JSON.stringify(r1.resolved) === JSON.stringify(r2.resolved), 'resolved should match');
  assert(r1.entry.resolved_metadata_hash === r2.entry.resolved_metadata_hash, 'hashes should match');
});

// ═══════════════════════════════════════════════════════════════
// FILENAME SAFETY (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Filename safety \u2500\u2500');

test('unsafe receipt_id throws', () => {
  const pkg = makePackageEntry();
  pkg.receipt_id = '../etc/passwd';
  let threw = false;
  try { buildDryRunEntry(pkg, makeTemplate()); } catch { threw = true; }
  assert(threw, 'should throw for unsafe filename');
});

// ═══════════════════════════════════════════════════════════════
// NO REAL URIS (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 No real URIs \u2500\u2500');

test('no https://, ipfs://, or ar:// in resolved output', () => {
  const { resolved, entry } = buildDryRunEntry(makePackageEntry(), makeTemplate());
  const fullStr = JSON.stringify(resolved) + JSON.stringify(entry);
  assert(!fullStr.includes('https://'), 'no https://');
  assert(!fullStr.includes('ipfs://'), 'no ipfs://');
  assert(!fullStr.includes('ar://'), 'no ar://');
});

// ═══════════════════════════════════════════════════════════════
// NO SELF-REFERENTIAL HASH (1 test)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 No self-referential hash \u2500\u2500');

test('resolved metadata file does not contain simulated_metadata_uri', () => {
  const { resolved, entry } = buildDryRunEntry(makePackageEntry(), makeTemplate());
  const fileStr = JSON.stringify(resolved);
  // simulated_metadata_uri should be in the manifest entry, not the file
  assert(entry.simulated_metadata_uri, 'manifest should have it');
  assert(!fileStr.includes(entry.simulated_metadata_uri), 'file must not contain simulated_metadata_uri');
  assert(!fileStr.includes('simulated_metadata_uri'), 'file must not have the key at all');
});

// ═══════════════════════════════════════════════════════════════
// BATCH (2 tests)
// ═══════════════════════════════════════════════════════════════

console.log('\n\u2500\u2500 Batch \u2500\u2500');

test('batch: multiple entries', () => {
  const pkgs = [makePackageEntry(), makePackageEntry()];
  pkgs[1].receipt_id = 'art_v12_xx_TESTMINT_1';
  const tmpls = [makeTemplate(), makeTemplate()];
  const { entries, resolvedFiles } = buildDryRunBatch(pkgs, tmpls);
  assert(entries.length === 2, `expected 2, got ${entries.length}`);
  assert(resolvedFiles.length === 2);
  assert(entries[0].receipt_id === 'art_v12_xx_TESTMINT_0');
  assert(entries[1].receipt_id === 'art_v12_xx_TESTMINT_1');
});

test('batch: empty arrays', () => {
  const { entries, resolvedFiles } = buildDryRunBatch([], []);
  assert(entries.length === 0);
  assert(resolvedFiles.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`);
console.log(`Upload Dry Run: ${_passed}/${_total} passed, ${_failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(_failed > 0 ? 1 : 0);
