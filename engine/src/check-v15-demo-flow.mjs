#!/usr/bin/env node
import { readFileSync } from 'fs';
import http from 'http';
import { resolve } from 'path';

process.env.TRADE_ARTIFACT_TEST = '1';

const manifestPath = resolve('engine', 'samples', 'sample-gallery.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const receiptHashes = Array.isArray(manifest?.receipt_hashes) ? manifest.receipt_hashes.filter(value => typeof value === 'string' && value.length > 0) : [];

if (receiptHashes.length === 0) {
  console.error('No sample receipt hashes found in engine/samples/sample-gallery.manifest.json');
  process.exit(1);
}

const sampleHash = receiptHashes[0];
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
      let body = '';
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => {
        resolveRequest({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          body,
        });
      });
    }).on('error', reject);
  });
}

const checks = [
  { path: '/api/gallery', status: 200, contentType: 'application/json' },
  { path: '/api/gallery/preview', status: 200, contentType: 'text/html' },
  { path: `/api/proof/${sampleHash}`, status: 200, contentType: 'application/json' },
  { path: `/api/verifier/${sampleHash}`, status: 200, contentType: 'application/json' },
  { path: `/api/proof/${sampleHash}/card`, status: 200, contentType: 'application/json' },
  { path: `/api/proof/${sampleHash}/card/preview`, status: 200, contentType: 'text/html' },
  { path: `/api/proof/${sampleHash}/hosted-preview`, status: 200, contentType: 'text/html' },
];

let failures = 0;
for (const check of checks) {
  const response = await httpGet(check.path);
  const ok = response.status === check.status && response.contentType.includes(check.contentType);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.path}  status=${response.status} content-type=${response.contentType}`);
  if (!ok) failures += 1;
}

await new Promise(resolveClose => server.close(resolveClose));
globalThis.fetch = originalFetch;
delete process.env.TRADE_ARTIFACT_TEST;

if (fetchCalls !== 0) {
  console.error(`FAIL  unexpected fetch calls observed: ${fetchCalls}`);
  process.exit(1);
}

console.log(`Demo sample hash: ${sampleHash}`);
console.log(`Checks run: ${checks.length}`);
console.log(`Result: ${failures === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failures > 0 ? 1 : 0);