#!/usr/bin/env node
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

const sampleHash = receiptHashes[0];
const sampleReceipt = getInventoryReceipt(sampleHash, {
  engineRoot,
  includeExcluded: false,
});

if (!sampleReceipt) {
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
    if (stats.isDirectory()) {
      listTree(root, path, entriesOut);
    }
  }
  return entriesOut.sort((a, b) => a.path.localeCompare(b.path));
}

const beforeTree = listTree(engineRoot);
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async (...args) => {
  fetchCalls += 1;
  if (typeof originalFetch === 'function') {
    return originalFetch(...args);
  }
  throw new Error(`Unexpected fetch call: ${String(args[0])}`);
};

const { app } = await import('./api/server.mjs');
const server = await new Promise((resolveServer, reject) => {
  const listener = app.listen(0, () => resolveServer(listener));
  listener.on('error', reject);
});
const port = server.address().port;

function httpGet(path) {
  return new Promise((resolveRequest, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, res => {
      res.resume();
      res.on('end', () => {
        resolveRequest({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
        });
      });
    }).on('error', reject);
  });
}

const checks = [
  { path: '/api/receipt-board', status: 200, contentType: 'application/json' },
  { path: '/api/receipt-board/preview', status: 200, contentType: 'text/html' },
  { path: `/api/proof/${sampleHash}`, status: 200, contentType: 'application/json' },
  { path: `/api/verifier/${sampleHash}`, status: 200, contentType: 'application/json' },
  { path: `/api/proof/${sampleHash}/card`, status: 200, contentType: 'application/json' },
  { path: `/api/proof/${sampleHash}/card/preview`, status: 200, contentType: 'text/html' },
  { path: `/api/proof/${sampleHash}/hosted-preview`, status: 200, contentType: 'text/html' },
];

let failures = 0;
try {
  for (const check of checks) {
    const response = await httpGet(check.path);
    const ok = response.status === check.status && response.contentType.includes(check.contentType);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.path}  status=${response.status} content-type=${response.contentType}`);
    if (!ok) failures += 1;
  }
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
  globalThis.fetch = originalFetch;
  delete process.env.TRADE_ARTIFACT_TEST;
}

const afterTree = listTree(engineRoot);
if (JSON.stringify(beforeTree) !== JSON.stringify(afterTree)) {
  console.error('FAIL  filesystem changed during v1.6 receipt-board demo checks');
  failures += 1;
}

if (fetchCalls !== 0) {
  console.error(`FAIL  unexpected fetch calls observed: ${fetchCalls}`);
  failures += 1;
}

console.log(`Demo sample hash: ${sampleHash}`);
console.log(`Checks run: ${checks.length}`);
console.log(`Result: ${failures === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failures > 0 ? 1 : 0);
