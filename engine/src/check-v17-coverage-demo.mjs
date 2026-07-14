#!/usr/bin/env node
import assert from 'assert';
import { readFileSync, readdirSync, statSync } from 'fs';
import http from 'http';
import { join, relative, resolve } from 'path';

import { getInventoryReceipt } from './inventory/inventory.mjs';

process.env.TRADE_ARTIFACT_TEST = '1';

const engineRoot = resolve('engine');
const manifestPath = resolve(engineRoot, 'samples', 'historical-receipt-board.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
const receiptHashes = entries
  .map(entry => entry?.receipt_hash)
  .filter(value => typeof value === 'string' && value.length > 0);

if (receiptHashes.length === 0) {
  console.error('No receipt board entries found in engine/samples/historical-receipt-board.manifest.json');
  process.exit(1);
}

const sampleHash = receiptHashes.find(receiptHash => getInventoryReceipt(receiptHash, {
  engineRoot,
  includeExcluded: false,
}));

if (!sampleHash) {
  console.error('historical receipt board sample hash not found in local inventory; run/generate sample inventory first');
  process.exit(1);
}

function listTree(root, current = root, entriesOut = []) {
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stats = statSync(path);
    entriesOut.push({
      path: relative(root, path),
      isDirectory: stats.isDirectory(),
      size: stats.isFile() ? stats.size : null,
    });
    if (stats.isDirectory()) listTree(root, path, entriesOut);
  }
  return entriesOut.sort((a, b) => a.path.localeCompare(b.path));
}

function parseBody(body, contentType) {
  if (contentType.includes('application/json')) return JSON.parse(body);
  return body;
}

function httpGet(port, path) {
  return new Promise((resolveRequest, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        resolveRequest({
          path,
          status: res.statusCode,
          contentType,
          body: parseBody(body, contentType),
        });
      });
    }).on('error', reject);
  });
}

function coverageSection(html) {
  const h2 = html.indexOf('<h2>Coverage Statement</h2>');
  const h3 = html.indexOf('<h3>Coverage Statement</h3>');
  const aria = html.indexOf('aria-label="Coverage Statement"');
  const starts = [h2, h3, aria].filter(index => index >= 0);
  assert.ok(starts.length > 0, 'missing coverage statement section');
  const start = Math.min(...starts);
  const sectionEnd = html.indexOf('</section>', start + 1);
  const headingEnds = [html.indexOf('<h2>', start + 1), html.indexOf('<h3>', start + 1)]
    .filter(index => index >= 0);
  const end = sectionEnd >= 0
    ? sectionEnd
    : headingEnds.length > 0
      ? Math.min(...headingEnds)
      : -1;
  return end >= 0 ? html.slice(start, end) : html.slice(start);
}

function assertCompactCoverageHtml(html, { board = false } = {}) {
  const section = coverageSection(html);
  assert.ok(section.includes('Coverage Statement'));
  assert.ok(section.includes('Receipt-scoped coverage only.'));
  assert.ok(section.includes('Receipt event bounds:'));
  assert.ok(section.includes('Raw quote only. No USD normalization.'));
  assert.ok(section.includes('Not wallet, trader, portfolio, or track-record coverage.'));
  if (board) assert.ok(section.includes('Publisher-selected board entry.'));
  else assert.ok(!section.includes('Publisher-selected board entry.'));
  assert.ok(!section.includes('coverage_codes'));
  assert.ok(!section.includes('event_bounds_complete'));
  assert.ok(!section.includes('Verifier Passed'));
  assert.ok(!section.includes('Upload Status'));
  assert.ok(!section.includes('Mint Status'));
  assert.ok(!section.includes('Transaction Signature'));
  assert.ok(!section.includes('realized_pnl'));
  assert.ok(!section.includes('usd_value'));
  assert.ok(!section.includes('usd_amount'));
}

function assertCardCoverageHtml(html) {
  const section = coverageSection(html);
  assert.ok(section.includes('Coverage Statement'));
  assert.ok(section.includes('Receipt-scoped coverage only.'));
  assert.ok(section.includes('Receipt event bounds:'));
  assert.ok(section.includes('Raw quote only. No USD normalization.'));
  assert.ok(section.includes('Not wallet, trader, portfolio, or track-record coverage.'));
  assert.ok(!section.includes('coverage_codes'));
  assert.ok(!section.includes('event_bounds_complete'));
  assert.ok(!section.includes('Publisher-selected board entry.'));
}

function assertCoverageObjectSafe(coverage) {
  const serialized = JSON.stringify(coverage).toLowerCase();
  assert.equal(coverage.coverage_statement_version, 'receipt_coverage_v1');
  assert.equal(coverage.scope.scope_type, 'receipt');
  assert.equal(coverage.valuation_basis.valuation_status, 'raw_quote');
  assert.equal(coverage.valuation_basis.usd_normalized, false);
  assert.ok(!serialized.includes('wallet_address'));
  assert.ok(!serialized.includes('realized_pnl'));
  assert.ok(!serialized.includes('pnl_pct'));
  assert.ok(!serialized.includes('usd_value'));
  assert.ok(!serialized.includes('usd_amount'));
  assert.ok(!serialized.includes('upload_status'));
  assert.ok(!serialized.includes('mint_status'));
  assert.ok(!serialized.includes('transaction_signature'));
  assert.ok(!serialized.includes('signing'));
}

const beforeTree = listTree(engineRoot);
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async (...args) => {
  fetchCalls += 1;
  if (typeof originalFetch === 'function') return originalFetch(...args);
  throw new Error(`Unexpected fetch call: ${String(args[0])}`);
};

const { app } = await import('./api/server.mjs');
const server = await new Promise((resolveServer, reject) => {
  const listener = app.listen(0, () => resolveServer(listener));
  listener.on('error', reject);
});
const port = server.address().port;

const routeChecks = [
  { path: '/api/receipt-board', status: 200, contentType: 'application/json' },
  { path: '/api/receipt-board/preview', status: 200, contentType: 'text/html' },
  { path: `/api/proof/${sampleHash}`, status: 200, contentType: 'application/json' },
  { path: `/api/verifier/${sampleHash}`, status: 200, contentType: 'application/json' },
  { path: `/api/proof/${sampleHash}/card`, status: 200, contentType: 'application/json' },
  { path: `/api/proof/${sampleHash}/card/preview`, status: 200, contentType: 'text/html' },
  { path: `/api/proof/${sampleHash}/hosted-preview`, status: 200, contentType: 'text/html' },
  { path: `/api/proof/${sampleHash}/export`, status: 200, contentType: 'text/html' },
];

let failures = 0;
const responses = new Map();
try {
  for (const check of routeChecks) {
    const response = await httpGet(port, check.path);
    responses.set(check.path, response);
    const ok = response.status === check.status && response.contentType.includes(check.contentType);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.path}  status=${response.status} content-type=${response.contentType}`);
    if (!ok) failures += 1;
  }

  const board = responses.get('/api/receipt-board').body;
  const boardPreview = responses.get('/api/receipt-board/preview').body;
  const proof = responses.get(`/api/proof/${sampleHash}`).body;
  const verifier = responses.get(`/api/verifier/${sampleHash}`).body;
  const card = responses.get(`/api/proof/${sampleHash}/card`).body;
  const cardPreview = responses.get(`/api/proof/${sampleHash}/card/preview`).body;
  const hostedPreview = responses.get(`/api/proof/${sampleHash}/hosted-preview`).body;
  const exportHtml = responses.get(`/api/proof/${sampleHash}/export`).body;

  assert.deepEqual(proof.coverage_statement, verifier.coverage_statement);
  assert.equal(proof.coverage_statement.publication_context, null);
  assert.equal(verifier.coverage_statement.publication_context, null);
  assertCoverageObjectSafe(proof.coverage_statement);

  const boardRow = board.rows.find(row => row.receipt_hash === sampleHash);
  assert.ok(boardRow, 'board row missing sample hash');
  assert.equal(boardRow.coverage_statement.publication_context.surface, 'historical_receipt_board');
  assert.equal(boardRow.coverage_statement.publication_context.selection_mode, 'publisher_selected');
  assertCoverageObjectSafe(boardRow.coverage_statement);

  assert.equal(card.coverage_summary.heading, 'Coverage Statement');
  assert.equal(card.coverage_summary.scope, 'Receipt-scoped coverage only.');
  assert.equal(card.coverage_summary.valuation, 'Raw quote only. No USD normalization.');
  assert.equal(card.coverage_summary.limitation, 'Not wallet, trader, portfolio, or track-record coverage.');

  assertCardCoverageHtml(cardPreview);
  assertCompactCoverageHtml(boardPreview, { board: true });
  assertCompactCoverageHtml(hostedPreview, { board: false });
  assertCompactCoverageHtml(exportHtml, { board: false });

  console.log('PASS  coverage equality across proof-detail and verifier');
  console.log('PASS  board-only publisher context');
  console.log('PASS  compact coverage wording across card, board, hosted-preview, and export');
} catch (error) {
  failures += 1;
  console.error(`FAIL  coverage assertions  ${error.message}`);
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
  globalThis.fetch = originalFetch;
  delete process.env.TRADE_ARTIFACT_TEST;
}

const afterTree = listTree(engineRoot);
if (JSON.stringify(beforeTree) !== JSON.stringify(afterTree)) {
  console.error('FAIL  filesystem changed during v1.7 coverage demo checks');
  failures += 1;
} else {
  console.log('PASS  filesystem unchanged during v1.7 coverage demo checks');
}

if (fetchCalls !== 0) {
  console.error(`FAIL  unexpected fetch calls observed: ${fetchCalls}`);
  failures += 1;
} else {
  console.log('PASS  zero fetch calls observed during v1.7 coverage demo checks');
}

console.log(`Demo sample hash: ${sampleHash}`);
console.log(`Route checks run: ${routeChecks.length}`);
console.log(`Result: ${failures === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failures > 0 ? 1 : 0);
