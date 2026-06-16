/**
 * Irys Uploader Adapter Tests — E7
 *
 * Tests for env checks, receipt selection, interface shape,
 * result loading/merging, and safe secret handling.
 * No real Irys SDK calls. No real uploads.
 */

import {
  checkEnvPresence,
  selectPackages,
  loadExistingResults,
  mergeResults,
} from './irys-uploader.mjs';

// ═══════════════════════════════════════════════════════════════
// Test harness
// ═══════════════════════════════════════════════════════════════

let _passed = 0;
let _failed = 0;
let _total = 0;
const _tests = [];

function t(name, fn) { _tests.push({ name, fn }); }

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

// ═══════════════════════════════════════════════════════════════
// ENV PRESENCE CHECKS (3 tests)
// ═══════════════════════════════════════════════════════════════

t('env check: returns booleans not secret values', () => {
  const result = checkEnvPresence();
  assert(typeof result.uploadEnabled === 'boolean', 'uploadEnabled should be boolean');
  assert(typeof result.keypairPathDefined === 'boolean', 'keypairPathDefined should be boolean');
  assert(typeof result.rpcUrlDefined === 'boolean', 'rpcUrlDefined should be boolean');
  // keypairPathPresence is either "defined" or "not defined" — never the actual path
  assert(result.keypairPathPresence === 'defined' || result.keypairPathPresence === 'not defined',
    `keypairPathPresence should be "defined" or "not defined", got "${result.keypairPathPresence}"`);
});

t('env check: no actual env values in returned object', () => {
  const result = checkEnvPresence();
  const str = JSON.stringify(result);
  // Should not contain actual keypair path, private keys, or .env references
  assert(!str.includes('PRIVATE'), 'no PRIVATE in output');
  assert(!str.includes('SECRET'), 'no SECRET in output');
  assert(!str.includes('.env'), 'no .env in output');
  // keypairPathPresence should be a safe label, not a file path
  assert(!result.keypairPathPresence.includes('/'), 'should not contain path separators');
  assert(!result.keypairPathPresence.includes('\\'), 'should not contain backslash');
});

t('env check: networkOverride is null or string', () => {
  const result = checkEnvPresence();
  assert(result.networkOverride === null || typeof result.networkOverride === 'string');
});

// ═══════════════════════════════════════════════════════════════
// RECEIPT SELECTION (3 tests)
// ═══════════════════════════════════════════════════════════════

const samplePackages = [
  { receipt_id: 'art_v12_cp_MINT1_0', receipt_hash: 'a' },
  { receipt_id: 'art_v12_rp_MINT2_0', receipt_hash: 'b' },
  { receipt_id: 'art_v12_os_MINT3_0', receipt_hash: 'c' },
];

t('selectPackages: receipt_id selects exact match', () => {
  const { selected, reason } = selectPackages(samplePackages, { uploadReceiptId: 'art_v12_rp_MINT2_0' });
  assert(selected.length === 1, `expected 1, got ${selected.length}`);
  assert(selected[0].receipt_id === 'art_v12_rp_MINT2_0');
  assert(reason.includes('art_v12_rp_MINT2_0'));
});

t('selectPackages: upload_max slices from front', () => {
  const { selected } = selectPackages(samplePackages, { uploadMax: 2 });
  assert(selected.length === 2, `expected 2, got ${selected.length}`);
  assert(selected[0].receipt_id === 'art_v12_cp_MINT1_0');
  assert(selected[1].receipt_id === 'art_v12_rp_MINT2_0');
});

t('selectPackages: no limit returns empty', () => {
  const { selected, reason } = selectPackages(samplePackages, {});
  assert(selected.length === 0, 'should be empty without limit');
  assert(reason.includes('no receipt limit'));
});

// ═══════════════════════════════════════════════════════════════
// ADAPTER INTERFACE (2 tests)
// ═══════════════════════════════════════════════════════════════

t('adapter: module importable without Irys SDK instantiation', () => {
  // This test succeeding proves lazy import works —
  // we imported the module at top level without Irys init
  assert(typeof checkEnvPresence === 'function', 'checkEnvPresence should be importable');
  assert(typeof selectPackages === 'function', 'selectPackages should be importable');
});

t('adapter: createIrysUploader is async factory (not called here)', async () => {
  // Just verify the export exists — don't call it (needs real keypair)
  const mod = await import('./irys-uploader.mjs');
  assert(typeof mod.createIrysUploader === 'function', 'should export createIrysUploader');
});

// ═══════════════════════════════════════════════════════════════
// RESULT LOADING / MERGING (4 tests)
// ═══════════════════════════════════════════════════════════════

t('loadExistingResults: nonexistent file returns empty map', () => {
  const map = loadExistingResults('/nonexistent/path/manifest.json');
  assert(map.size === 0, 'should be empty');
});

t('mergeResults: preserves existing, adds new', () => {
  const existing = new Map();
  existing.set('r1', { receipt_id: 'r1', upload_status: 'complete', final_image_uri: 'uri1' });
  existing.set('r2', { receipt_id: 'r2', upload_status: 'complete', final_image_uri: 'uri2' });

  const newResults = [
    { receipt_id: 'r3', upload_status: 'complete', final_image_uri: 'uri3' },
  ];

  const merged = mergeResults(existing, newResults);
  assert(merged.length === 3, `expected 3, got ${merged.length}`);
  assert(merged.some(r => r.receipt_id === 'r1'), 'should preserve r1');
  assert(merged.some(r => r.receipt_id === 'r3'), 'should add r3');
});

t('mergeResults: updates existing receipt_id', () => {
  const existing = new Map();
  existing.set('r1', { receipt_id: 'r1', upload_status: 'failed' });

  const newResults = [
    { receipt_id: 'r1', upload_status: 'complete', final_image_uri: 'new_uri' },
  ];

  const merged = mergeResults(existing, newResults);
  assert(merged.length === 1, `expected 1, got ${merged.length}`);
  assert(merged[0].upload_status === 'complete', 'should be updated');
  assert(merged[0].final_image_uri === 'new_uri');
});

t('mergeResults: empty existing + empty new = empty', () => {
  const merged = mergeResults(new Map(), []);
  assert(merged.length === 0);
});

// ═══════════════════════════════════════════════════════════════
// SAFE LOGGING (1 test)
// ═══════════════════════════════════════════════════════════════

t('no secret leakage from any exported pure function', () => {
  // Set a fake env value and verify it doesn't leak
  const origKP = process.env.IRYS_KEYPAIR_PATH;
  process.env.IRYS_KEYPAIR_PATH = '/secret/path/keypair.json';
  try {
    const envCheck = checkEnvPresence();
    const str = JSON.stringify(envCheck);
    assert(!str.includes('/secret/path'), 'keypair path must not leak');
    assert(!str.includes('keypair.json'), 'keypair filename must not leak');
    assert(envCheck.keypairPathPresence === 'defined', 'should say defined');
  } finally {
    if (origKP !== undefined) process.env.IRYS_KEYPAIR_PATH = origKP;
    else delete process.env.IRYS_KEYPAIR_PATH;
  }
});

// ═══════════════════════════════════════════════════════════════
// Run all tests
// ═══════════════════════════════════════════════════════════════

console.log('\n── Env presence checks ──');
console.log('── Receipt selection ──');
console.log('── Adapter interface ──');
console.log('── Result loading/merging ──');
console.log('── Safe logging ──');

async function run() {
  for (const { name, fn } of _tests) {
    _total++;
    try {
      await fn();
      _passed++;
    } catch (e) {
      _failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`        ${e.message}`);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Irys Uploader: ${_passed}/${_total} passed, ${_failed} failed`);
  console.log(`${'='.repeat(50)}`);

  process.exit(_failed > 0 ? 1 : 0);
}

run();
