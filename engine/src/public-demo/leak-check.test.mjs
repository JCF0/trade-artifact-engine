import assert from 'assert';

import { runPublicDemoLeakCheck, assertPublicDemoLeakCheck } from './leak-check.mjs';

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
    console.log(`       ${error.message}`);
  }
}

const safeFiles = {
  'index.html': '<h1>Historical Verified Receipt Board</h1><h2>Coverage Statement</h2><p>Receipt-scoped coverage only.</p><p>Raw quote only. No USD normalization.</p><p>Not a portfolio statement. Not a trader leaderboard.</p>',
  'receipts/p-safe/index.html': '<h1>Proof</h1><h2>Coverage Statement</h2><p>Receipt-scoped coverage only.</p><p>Raw quote only. No USD normalization.</p>',
  'receipts/p-safe/proof.json': JSON.stringify({ proof: { receipt: { wallet: 'ABCDEF...1234' }, coverage_statement: { scope: { scope_type: 'receipt' } } } }, null, 2),
};

test('passes safe negative-disclosure fixtures', () => {
  const result = runPublicDemoLeakCheck(safeFiles);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
});

test('fails on API and localhost references', () => {
  const result = runPublicDemoLeakCheck({ ...safeFiles, 'bad.html': '<a href="/api/proof/x">api</a> localhost' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'api_route'));
  assert.ok(result.findings.some(finding => finding.code === 'localhost_reference'));
});

test('fails on local paths and debug/cache/raw paths', () => {
  const result = runPublicDemoLeakCheck({ ...safeFiles, 'bad.json': '{ "path": "C:\\\\Users\\\\me\\\\repo\\\\data\\\\debug\\\\raw_transactions.json" }' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'windows_absolute_path'));
  assert.ok(result.findings.some(finding => finding.code === 'debug_cache_raw_path'));
});

test('fails on secrets and keypair-shaped content', () => {
  const result = runPublicDemoLeakCheck({ ...safeFiles, 'bad.txt': 'HELIUS_API_KEY=abc\n[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64]' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'env_secret_reference'));
  assert.ok(result.findings.some(finding => finding.code === 'solana_keypair_shape'));
});

test('fails on full wallet fields', () => {
  const result = runPublicDemoLeakCheck({ ...safeFiles, 'bad.json': JSON.stringify({ receipt: { wallet: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' } }) });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'full_wallet_exposed'));
});

test('fails on affirmative forbidden claims but allows negated limitations', () => {
  const result = runPublicDemoLeakCheck({ ...safeFiles, 'bad.html': '<h2>Coverage Statement</h2><p>Receipt-scoped coverage only.</p><p>Raw quote only. No USD normalization.</p><p>verified track record score and eligible for prize</p>' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'track_record_claim'));
  assert.ok(result.findings.some(finding => finding.code === 'prize_claim'));
});

test('fails when html coverage statement is missing', () => {
  const result = runPublicDemoLeakCheck({ 'index.html': '<h1>No coverage</h1>' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'missing_coverage_statement'));
});

test('assert helper throws with findings', () => {
  assert.throws(() => assertPublicDemoLeakCheck({ 'index.html': 'localhost' }), /public demo leak check failed/);
});

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);