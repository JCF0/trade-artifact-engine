import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { buildPublicDemoBundle, writePublicDemoBundle } from './site-bundle.mjs';
import { runPublicDemoPredeployCheck } from './predeploy-check.mjs';

const ENGINE_ROOT = resolve('engine');
const BUILD_OPTIONS = {
  engineRoot: ENGINE_ROOT,
  archiveRoot: resolve(ENGINE_ROOT, 'data/inventory/receipt-archive-v1'),
  economicsRoot: resolve(ENGINE_ROOT, 'data/inventory/receipt-economics-v1'),
};

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

function withBundle(fn) {
  const root = mkdtempSync(join(tmpdir(), 'trade-artifact-predeploy-test-'));
  try {
    writePublicDemoBundle(buildPublicDemoBundle(BUILD_OPTIONS), { outRoot: root });
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function append(path, value) {
  writeFileSync(path, `${readFileSync(path, 'utf8')}${value}`, 'utf8');
}

test('passes complete generated bundle', () => withBundle(root => {
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.file_count, 18);
  assert.deepEqual(result.csp, {
    scripts_present: false,
    network_primitives_present: false,
    non_self_images_present: false,
  });
}));

test('fails on unexpected file inventory', () => withBundle(root => {
  writeFileSync(join(root, 'extra.txt'), 'unexpected', 'utf8');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'file_inventory_mismatch'));
}));

test('fails on broken internal link', () => withBundle(root => {
  append(join(root, 'index.html'), '<a href="missing.html">missing</a>');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'broken_internal_link'));
}));

test('fails on unexpected external link', () => withBundle(root => {
  append(join(root, 'index.html'), '<a href="https://example.com">external</a>');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'external_link_rejected'));
}));

test('fails on missing CSP and X-Robots-Tag headers', () => withBundle(root => {
  writeFileSync(join(root, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n', 'utf8');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'headers_file_not_exact'));
  assert.ok(result.findings.some(finding => finding.code === 'x_robots_tag_missing'));
}));

test('fails on robots rule changes', () => withBundle(root => {
  writeFileSync(join(root, 'robots.txt'), 'User-agent: *\nAllow: /\n', 'utf8');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'robots_file_not_exact'));
  assert.ok(result.findings.some(finding => finding.code === 'robots_disallow_missing'));
}));

test('fails on 404 claim drift', () => withBundle(root => {
  writeFileSync(join(root, '404.html'), '<a href="./index.html">Board</a>', 'utf8');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'not_found_unlisted_copy_missing'));
}));

test('fails on script and network primitives', () => withBundle(root => {
  append(join(root, 'index.html'), '<script>fetch("/x")</script>');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'script_tag_present'));
  assert.ok(result.findings.some(finding => finding.code === 'network_primitive_present'));
}));

test('fails on data or external image sources', () => withBundle(root => {
  append(join(root, 'index.html'), '<img src="data:image/png;base64,AA=="><img src="https://example.com/a.png">');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'image_data_url_rejected'));
  assert.ok(result.findings.some(finding => finding.code === 'external_image_rejected'));
}));

test('fails when coverage copy is removed', () => withBundle(root => {
  const path = join(root, 'index.html');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/Coverage Statement/g, 'Coverage Removed'), 'utf8');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'leak_missing_coverage_statement' || finding.code === 'missing_coverage_statement'));
}));

test('fails deterministic comparison after byte drift', () => withBundle(root => {
  append(join(root, 'manifest.json'), ' ');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'byte_stable_regeneration_mismatch'));
}));

test('fails on API route leak through reused leak checker', () => withBundle(root => {
  append(join(root, 'index.html'), '<a href="/api/proof/test">api</a>');
  const result = runPublicDemoPredeployCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some(finding => finding.code === 'leak_api_route'));
}));

test('writes nothing outside provided temp roots during check', () => {
  const sentinelRoot = mkdtempSync(join(tmpdir(), 'trade-artifact-predeploy-sentinel-'));
  try {
    writeFileSync(join(sentinelRoot, 'sentinel.txt'), 'keep', 'utf8');
    withBundle(root => {
      const result = runPublicDemoPredeployCheck({ root });
      assert.equal(result.ok, true);
    });
    assert.equal(readFileSync(join(sentinelRoot, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(sentinelRoot, { recursive: true, force: true });
  }
});

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);