#!/usr/bin/env node
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'path';
import { pathToFileURL } from 'url';

import { runPublicDemoLeakCheck } from './leak-check.mjs';
import { buildPublicDemoBundle, PUBLIC_DEMO_HEADERS, PUBLIC_DEMO_ROBOTS, writePublicDemoBundle } from './site-bundle.mjs';

const REQUIRED_CSP = "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const REQUIRED_HEADER_LINES = [
  '/*',
  REQUIRED_CSP,
  'X-Content-Type-Options: nosniff',
  'Referrer-Policy: no-referrer',
  'Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy: same-origin',
  'Cross-Origin-Resource-Policy: same-origin',
  'X-Robots-Tag: noindex, nofollow',
];
const NETWORK_PATTERNS = [
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\bWebSocket\b/i,
  /\bEventSource\b/i,
  /\bsendBeacon\s*\(/i,
  /\bimport\s*\(/i,
];

function slashPath(value) {
  return value.split('\\').join('/');
}

function readBundleFiles(root) {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) throw new Error(`bundle root does not exist: ${root}`);
  if (!statSync(resolvedRoot).isDirectory()) throw new Error(`bundle root is not a directory: ${root}`);

  const files = {};
  function visit(current) {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else files[slashPath(relative(resolvedRoot, path))] = readFileSync(path, 'utf8');
    }
  }
  visit(resolvedRoot);
  return files;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashFiles(files) {
  return Object.keys(files).sort().map(path => ({ path, hash: sha256(files[path]) }));
}

function addFinding(findings, code, details = {}) {
  findings.push({ ...details, code });
}

function assertInsideBundle(root, fromFile, href) {
  if (href.startsWith('#') || href === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    return { external: true, target: href };
  }
  const cleanHref = href.split('#')[0].split('?')[0];
  const fromDir = dirname(fromFile);
  const target = cleanHref.startsWith('/')
    ? normalize(cleanHref.slice(1))
    : normalize(join(fromDir === '.' ? '' : fromDir, cleanHref));
  const normalizedTarget = slashPath(target);
  if (normalizedTarget.startsWith('../') || isAbsolute(normalizedTarget)) {
    return { outside: true, target: normalizedTarget };
  }
  return { target: normalizedTarget };
}

function validateInternalLinks(files, findings) {
  for (const [filename, content] of Object.entries(files)) {
    if (!filename.endsWith('.html')) continue;
    const attrs = [...content.matchAll(/\b(?:href|src)="([^"]*)"/g)];
    for (const match of attrs) {
      const href = match[1];
      if (href.startsWith('mailto:') || href.startsWith('tel:')) {
        addFinding(findings, 'external_link_rejected', { filename, href });
        continue;
      }
      const resolved = assertInsideBundle('', filename, href);
      if (!resolved) continue;
      if (resolved.external) addFinding(findings, 'external_link_rejected', { filename, href });
      else if (resolved.outside) addFinding(findings, 'link_outside_bundle', { filename, href, target: resolved.target });
      else if (!Object.hasOwn(files, resolved.target)) addFinding(findings, 'broken_internal_link', { filename, href, target: resolved.target });
    }
  }
}

function validateCspCompatibility(files, findings) {
  for (const [filename, content] of Object.entries(files)) {
    if (/<script\b/i.test(content)) addFinding(findings, 'script_tag_present', { filename });
    if (/\son[a-z]+\s*=/i.test(content)) addFinding(findings, 'inline_event_handler_present', { filename });
    if (/javascript:/i.test(content)) addFinding(findings, 'javascript_url_present', { filename });
    for (const pattern of NETWORK_PATTERNS) {
      if (pattern.test(content)) addFinding(findings, 'network_primitive_present', { filename, pattern: String(pattern) });
    }
  }

  for (const [filename, content] of Object.entries(files)) {
    if (!filename.endsWith('.html')) continue;
    for (const match of content.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
      const src = match[1];
      if (src.startsWith('data:')) addFinding(findings, 'image_data_url_rejected', { filename, src: 'data:' });
      else if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) addFinding(findings, 'external_image_rejected', { filename, src });
      else {
        const resolved = assertInsideBundle('', filename, src);
        if (!resolved || resolved.external || resolved.outside || !Object.hasOwn(files, resolved.target)) {
          addFinding(findings, 'broken_self_image', { filename, src, target: resolved?.target || null });
        }
      }
    }
    for (const match of content.matchAll(/url\(([^)]+)\)/gi)) {
      const raw = match[1].trim().replace(/^['"]|['"]$/g, '');
      if (raw.startsWith('data:')) addFinding(findings, 'css_data_url_rejected', { filename });
      else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) addFinding(findings, 'external_css_asset_rejected', { filename, url: raw });
    }
  }
}

function validateCoverage(files, findings) {
  const coverageFiles = ['index.html', ...Object.keys(files).filter(path => /^receipts\/[^/]+\/index\.html$/.test(path)).sort()];
  for (const filename of coverageFiles) {
    const content = files[filename] || '';
    if (!content.includes('Coverage Statement')) addFinding(findings, 'missing_coverage_statement', { filename });
    if (!content.includes('Receipt-scoped coverage only')) addFinding(findings, 'missing_receipt_scope_disclosure', { filename });
    if (!content.includes('Raw quote only. No USD normalization.')) addFinding(findings, 'missing_raw_quote_disclosure', { filename });
  }
}

function validateHeaders(files, findings) {
  const headers = files['_headers'];
  if (headers !== PUBLIC_DEMO_HEADERS) addFinding(findings, 'headers_file_not_exact');
  for (const line of REQUIRED_HEADER_LINES) {
    if (!headers?.includes(line)) addFinding(findings, 'required_header_missing', { line });
  }
  if (!headers?.includes('X-Robots-Tag: noindex, nofollow')) addFinding(findings, 'x_robots_tag_missing');
}

function validateRobots(files, findings) {
  if (files['robots.txt'] !== PUBLIC_DEMO_ROBOTS) addFinding(findings, 'robots_file_not_exact');
  if (!files['robots.txt']?.includes('User-agent: *')) addFinding(findings, 'robots_user_agent_missing');
  if (!files['robots.txt']?.includes('Disallow: /')) addFinding(findings, 'robots_disallow_missing');
}

function validateNotFound(files, findings) {
  const content = files['404.html'];
  if (!content) {
    addFinding(findings, 'not_found_missing');
    return;
  }
  if (!content.includes('static unlisted Artifact demonstration')) addFinding(findings, 'not_found_unlisted_copy_missing');
  if (!content.includes('href="/index.html"')) addFinding(findings, 'not_found_board_link_missing');
}

function compareExpectedInventory(files, expectedFiles, findings) {
  const actual = Object.keys(files).sort();
  const expected = Object.keys(expectedFiles).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    addFinding(findings, 'file_inventory_mismatch', { actual, expected });
  }
}

function compareByteStable(rootFiles, regeneratedFiles, findings) {
  const actual = hashFiles(rootFiles);
  const regenerated = hashFiles(regeneratedFiles);
  if (JSON.stringify(actual) !== JSON.stringify(regenerated)) {
    addFinding(findings, 'byte_stable_regeneration_mismatch', { actual, regenerated });
  }
}

export function runPublicDemoPredeployCheck(options = {}) {
  const root = options.root ? resolve(options.root) : resolve('engine/data/public-demo');
  const findings = [];
  const files = readBundleFiles(root);
  const generated = buildPublicDemoBundle(options.buildOptions || {});

  compareExpectedInventory(files, generated.files, findings);
  validateInternalLinks(files, findings);
  const leak = runPublicDemoLeakCheck(files, {
    expectedReceiptHashes: generated.receipts.map(receipt => receipt.receipt_hash),
  });
  for (const finding of leak.findings) addFinding(findings, `leak_${finding.code}`, finding);
  validateCoverage(files, findings);
  validateHeaders(files, findings);
  validateRobots(files, findings);
  validateNotFound(files, findings);
  validateCspCompatibility(files, findings);

  const tempRoot = mkdtempSync(join(tmpdir(), 'trade-artifact-public-demo-predeploy-'));
  try {
    writePublicDemoBundle(generated, { outRoot: tempRoot });
    const tempFiles = readBundleFiles(tempRoot);
    compareByteStable(files, tempFiles, findings);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  return {
    ok: findings.length === 0,
    root,
    file_count: Object.keys(files).length,
    findings,
    csp: {
      scripts_present: findings.some(finding => finding.code === 'script_tag_present' || finding.code === 'inline_event_handler_present' || finding.code === 'javascript_url_present'),
      network_primitives_present: findings.some(finding => finding.code === 'network_primitive_present'),
      non_self_images_present: findings.some(finding => finding.code === 'image_data_url_rejected' || finding.code === 'external_image_rejected' || finding.code === 'external_css_asset_rejected'),
    },
  };
}

export function assertPublicDemoPredeployCheck(options = {}) {
  const result = runPublicDemoPredeployCheck(options);
  if (!result.ok) {
    const error = new Error(`public demo predeploy check failed: ${result.findings.map(finding => finding.code).join(', ')}`);
    error.result = result;
    throw error;
  }
  return result;
}

function parseArgs(argv) {
  const args = { root: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      args.root = argv[i + 1] || '';
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.root) throw new Error('--root is required');
  return args;
}

export function runCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const args = parseArgs(argv);
    const result = runPublicDemoPredeployCheck({ root: args.root });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr.write('Usage: node engine/src/public-demo/predeploy-check.mjs --root <public-demo-dir>\n');
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}