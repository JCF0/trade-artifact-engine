import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer as createTlsServer } from 'node:https';
import { fixedRpcAdaptersV1 } from './exchange.mjs';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
const url = new URL('./exchange.mjs', import.meta.url);
const candidate = existsSync(url) ? await import(url) : {};
const canary = 'SYNTHETIC_CREDENTIAL_CANARY_0192837465';
async function server(t, handler) {
  const s = createServer(handler); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  t.after(() => { s.closeAllConnections(); s.close(); });
  return `http://127.0.0.1:${s.address().port}/rpc`;
}
test('fixed exchange transmits exact request bytes once and returns exact UTF-8 bytes', async t => {
  assert.equal(typeof candidate.createFixtureExchangeV1, 'function', 'missing concrete bounded exchange');
  const bytes = Buffer.from('{"jsonrpc":"2.0", "id":1,"method":"getSlot","params":[]}');
  let calls = 0;
  const endpoint = await server(t, async (req, res) => {
    calls++; const chunks = []; for await (const c of req) chunks.push(c);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(req.headers.authorization, `Bearer ${canary}`);
    res.setHeader('content-type', 'application/json'); res.end('{"result":7}\n');
  });
  const exchange = candidate.createFixtureExchangeV1({ endpoint, bearer: canary, ca: null,
    capability_id: 'synthetic-provider-v1', timeout_ms: 500, max_response_bytes: 1024 });
  const response = await exchange.request(bytes, new AbortController().signal);
  assert.deepEqual(response, { status: 200, body: Buffer.from('{"result":7}\n') });
  assert.equal(calls, 1); exchange.close();
});
for (const fault of ['stream-overflow', 'declared-overflow', 'stalled-headers', 'stalled-body', 'redirect',
  '429', '500', 'gzip', 'invalid-utf8', 'credential', 'escaped-credential', 'cancel', 'late-body']) {
  test(`actual exchange refuses ${fault} without hidden resend or admissible contaminated bytes`, async t => {
    let calls = 0, socketClosed = false, late;
    const endpoint = await server(t, (req, res) => {
      calls++; req.socket.on('close', () => { socketClosed = true; });
      res.setHeader('content-type', 'application/json');
      if (fault === 'stalled-headers' || fault === 'cancel') return;
      if (fault === 'redirect') { res.writeHead(307, { location: '/elsewhere' }); res.end(canary); return; }
      if (['429', '500'].includes(fault)) { res.writeHead(Number(fault), { 'retry-after': '0' }); res.end(canary); return; }
      if (fault === 'gzip') { res.setHeader('content-encoding', 'gzip'); res.end('compressed'); return; }
      if (fault === 'declared-overflow') { res.setHeader('content-length', '999999999'); res.flushHeaders(); return; }
      if (fault === 'invalid-utf8') { res.end(Buffer.from([0xff])); return; }
      if (fault === 'credential') { res.end(JSON.stringify({ result: canary })); return; }
      if (fault === 'escaped-credential') { res.end('{"result":"' + [...canary].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}'); return; }
      if (fault === 'stream-overflow') { res.write(Buffer.alloc(128, 32)); res.write(Buffer.alloc(128, 32)); return; }
      res.flushHeaders(); res.write('{"result":');
      if (fault === 'late-body') late = setTimeout(() => res.end('7}'), 150);
    });
    const exchange = candidate.createFixtureExchangeV1({ endpoint, bearer: canary, ca: null,
      capability_id: 'synthetic-provider-v1', timeout_ms: 80, max_response_bytes: 128 });
    t.after(() => { clearTimeout(late); exchange.close(); });
    const controller = new AbortController();
    const promise = exchange.request(Buffer.from('{}'), controller.signal);
    if (fault === 'cancel') setTimeout(() => controller.abort(), 20);
    await assert.rejects(promise, e => e.message === 'PRIVATE_RPC_UNAVAILABLE' && !e.stack.includes(canary));
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(calls, 1); assert.equal(socketClosed, true);
  });
}
test('aborted before dispatch and closed exchange cause zero connections', async t => {
  let calls = 0;
  const endpoint = await server(t, () => { calls++; });
  const exchange = candidate.createFixtureExchangeV1({ endpoint, bearer: canary, ca: null,
    capability_id: 'synthetic-provider-v1', timeout_ms: 100, max_response_bytes: 128 });
  const c = new AbortController(); c.abort();
  await assert.rejects(exchange.request(Buffer.from('{}'), c.signal));
  exchange.close(); await assert.rejects(exchange.request(Buffer.from('{}'), new AbortController().signal));
  assert.equal(calls, 0);
});
test('actual TLS validates certificate, rejects untrusted TLS, and connect refusal is sanitized', async t => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-local-tls-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = join(root, 'synthetic.key'), cert = join(root, 'synthetic.crt');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { env: {}, stdio: 'ignore' });
  let calls = 0;
  const s = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    calls++; res.setHeader('content-type', 'application/json'); res.end('{"result":1}');
  });
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const endpoint = `https://127.0.0.1:${s.address().port}/rpc`;
  const policy = { endpoint, bearer: canary, ca: readFileSync(cert, 'utf8'), capability_id: 'synthetic-provider-v1', timeout_ms: 500, max_response_bytes: 128 };
  const good = candidate.createFixtureExchangeV1(policy), bad = candidate.createFixtureExchangeV1({ ...policy, ca: null });
  t.after(() => { good.close(); bad.close(); s.closeAllConnections(); s.close(); });
  assert.equal((await good.request(Buffer.from('{}'), new AbortController().signal)).status, 200);
  await assert.rejects(bad.request(Buffer.from('{}'), new AbortController().signal), /PRIVATE_RPC_UNAVAILABLE/);
  assert.equal(calls, 1);
  s.closeAllConnections(); await new Promise(resolve => s.close(resolve));
  await assert.rejects(good.request(Buffer.from('{}'), new AbortController().signal), /PRIVATE_RPC_UNAVAILABLE/);
  assert.equal(calls, 1);
});
test('trusted readiness/source/submission adapters preserve contracts and honest compatibility-label mapping', async t => {
  const observed = [];
  const endpoint = await server(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); observed.push(Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json'); res.end('{"result":1}');
  });
  const exchange = candidate.createFixtureExchangeV1({ endpoint, bearer: canary, ca: null,
    capability_id: 'synthetic-provider-v1', timeout_ms: 500, max_response_bytes: 1024 });
  t.after(() => exchange.close());
  const b = { call_timeout_ms: 500, max_response_bytes: 1024 };
  const adapters = fixedRpcAdaptersV1(exchange, { capture: b, simulation: b, economic_source: b, submission: b });
  const body = { jsonrpc: '2.0', id: 'readiness', method: 'getSlot', params: [] }, signal = new AbortController().signal;
  assert.equal(await adapters.transport({ body, signal }), '{"result":1}');
  const simulation = { ...body, id: 'simulation-1', method: 'simulateTransaction' }, exact = Buffer.from(canonicalJson(simulation));
  await adapters.transport({ body: simulation, signal, request_bytes: exact });
  const requestBody = Buffer.from('{"method":"sendTransaction"}');
  const request = { endpoint: 'OFFLINE_INJECTED_PRIMARY_SOLANA_RPC', requestBody, signal,
    options: { body: requestBody, redirect: 'error', timeoutMs: 500 } };
  await adapters.submission.transport(request);
  assert.deepEqual(observed, [Buffer.from(canonicalJson(body)), exact, requestBody]);
  assert.throws(() => adapters.submission.transport({ ...request, endpoint }));
  await assert.rejects(adapters.transport({ body, signal, request_bytes: Buffer.from('{}') }));
  assert.deepEqual(exchange.mapping, { capability_id: 'synthetic-provider-v1', scheduler_label: request.endpoint, transport_retries: 0 });
});
