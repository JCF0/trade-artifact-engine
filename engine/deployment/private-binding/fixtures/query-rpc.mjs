// Local-only synthetic provider. Never imported by a production module.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/verification-scope-v1-3/contract.mjs';
import { inspectSignedLegacyWire, canonicalJson as schedulerJson } from '../../../src/verification-scope-v1-3/final-proof-agent/reused/bounded-rebroadcast-v1.mjs';
import { createFixtureHeliusExchangeV1, fixedRpcAdaptersV1 } from '../exchange.mjs';
export const QUERY_CANARY = 'SYNTHETIC_RETENTION_QUERY_CANARY_987654321.~';
export async function queryRpcFixture(f) {
  const requests = [], responses = []; let poison = () => false, failure = false, serverError;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/?' + new URLSearchParams({ 'api-key': QUERY_CANARY }));
      assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['x-api-key'], undefined);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes);
      assert.deepEqual(bytes, typeof body.id === 'number' ? schedulerJson(body) : Buffer.from(canonicalJson(body))); requests.push({ body, bytes });
      let raw;
      if (poison(body)) raw = JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000,
        message: 'synthetic', data: { [encodeURIComponent([...QUERY_CANARY].map(c => '%' + c.charCodeAt(0).toString(16)).join(''))]: 1 } } });
      else if (failure && ['sendTransaction', 'getSignatureStatuses', 'getBlockHeight', 'getTransaction'].includes(body.method) && !String(body.id).startsWith('economic-')) {
        res.writeHead(500); res.end(); return;
      } else if (body.method === 'sendTransaction') {
        assert.deepEqual(body.params[1], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 });
        raw = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: inspectSignedLegacyWire(body.params[0]).expectedSignature });
      } else if (body.method === 'getSignatureStatuses') {
        const tx = f.transactions.at(-1);
        raw = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot: tx.slot }, value: [
          { slot: tx.slot, confirmations: null, err: tx.meta.err, confirmationStatus: 'finalized' }] } });
      } else {
        if (body.method === 'simulateTransaction') {
          assert.equal(body.params[1].commitment, 'finalized'); assert.equal(body.params[1].sigVerify, false);
          assert.equal(body.params[1].replaceRecentBlockhash, false);
          const wire = Buffer.from(body.params[0], 'base64'); assert.equal(wire[0], 1); assert.ok(wire.subarray(1, 65).every(b => b === 0));
        }
        raw = await f.transport({ body, signal: new AbortController().signal });
      }
      responses.push(Buffer.from(raw)); res.setHeader('content-type', 'application/json'); res.end(raw);
    } catch (e) { serverError = e; res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/`;
  const exchange = createFixtureHeliusExchangeV1({ capability_id: 'helius-mainnet-query-v1', api_key: QUERY_CANARY,
    ca: null, timeout_ms: 60000, max_response_bytes: 16777216 }, endpoint);
  return { requests, responses, exchange, endpoint,
    wrap: dependencies => {
      const adapters = fixedRpcAdaptersV1(exchange, f.configuration.budget);
      // Keep the original disposable scheduler clock/sleep paired. HTTP's own
      // enclosing deadline still uses real performance.now and actual sockets.
      return { ...dependencies, ...adapters, submission: { ...adapters.submission, sleep: f.submission.sleep } };
    },
    poison: predicate => { poison = predicate; }, fail: () => { failure = true; },
    assertHealthy() { assert.equal(serverError, undefined); },
    close() { exchange.close(); server.closeAllConnections(); server.close(); },
  };
}
export function assertPrivateTree(root, extra = []) {
  const percent = s => [...s].map(c => '%' + c.charCodeAt(0).toString(16)).join('');
  const needles = [QUERY_CANARY, ...extra].flatMap(s => [s, encodeURIComponent(s), percent(s), encodeURIComponent(percent(s)),
    Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url')]);
  function check(bytes) { for (const n of needles) assert.equal(bytes.includes(Buffer.from(n)), false, 'PRIVATE_ECHO_IN_RETAINED_TREE'); }
  let files = 0;
  function walk(path) {
    for (const d of readdirSync(path, { withFileTypes: true })) {
      const p = join(path, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) {
        const bytes = readFileSync(p); files++;
        check(bytes);
        let json; try { json = JSON.parse(bytes); } catch { /* SQLite/raw files are checked bytewise. */ }
        const stack = [json];
        while (stack.length) {
          const v = stack.pop();
          if (typeof v === 'string') check(Buffer.from(v));
          else if (v && typeof v === 'object') for (const [k, value] of Object.entries(v)) {
            check(Buffer.from(k));
            if (k.endsWith('_base64') && typeof value === 'string') check(Buffer.from(value, 'base64'));
            stack.push(value);
          }
        }
      } else assert.fail('unexpected fixture file type');
    }
  }
  walk(root); assert.ok(files > 0); return files;
}
