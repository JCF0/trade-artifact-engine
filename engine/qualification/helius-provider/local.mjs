// Synthetic only: runs inside the dedicated loopback/PID/chroot boundary.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, readFileSync, existsSync, fstatSync } from 'node:fs';
import { createFixtureHeliusExchangeV1 } from '/accepted/engine/deployment/private-binding/exchange.mjs';
import { createSession, loadExchange, LIMITS, MAXIMA, put } from './bounded.mjs';
import { probe, PUBLIC } from './probe.mjs';
const key = 'SYNTHETIC_QUALIFICATION_KEY_0001';
let received = 0, mode = 'normal';
const sockets = new Set(), cases = [];
const account = { lamports: 1, owner: PUBLIC.token, executable: false, rentEpoch: 0, data: ['', 'base64'] };
const server = http.createServer((req, res) => {
  received++;
  const target = new URL(req.url, 'http://127.0.0.1');
  if (target.searchParams.get('api-key') !== key || target.searchParams.size !== 1 || req.headers.authorization || req.headers['x-api-key']) {
    res.destroy(); return;
  }
  let text = ''; req.on('data', b => { text += b; });
  req.on('end', () => {
    if (mode === 'stall') return;
    if (mode === '401' || mode === '429') { res.writeHead(Number(mode)); res.end(key); return; }
    res.setHeader('content-type', 'application/json');
    if (mode === 'echo') { res.end(JSON.stringify({ secret: key })); return; }
    if (mode === 'overflow') { res.end(JSON.stringify({ data: 'x'.repeat(1000) })); return; }
    const body = JSON.parse(text), cfg = body.params.at(-1);
    let result = null;
    if (mode === 'probe') {
      const context = { slot: 100 };
      switch (body.method) {
        case 'getGenesisHash': result = PUBLIC.genesis; break;
        case 'getSlot': result = 100; break;
        case 'getBlock': result = { blockTime: Math.floor(Date.now() / 1000) }; break;
        case 'getMultipleAccounts': result = { context, value: body.params[0].map(() => account) }; break;
        case 'getAccountInfo': result = { context, value: account }; break;
        case 'getTokenAccountsByOwner': result = { context, value: body.params[1].programId === PUBLIC.token
          ? [PUBLIC.jup_ata, PUBLIC.usdc_ata].map(pubkey => ({ pubkey, account })) : [] }; break;
        case 'getSignaturesForAddress': result = cfg.before ? [] : [{ signature: '2'.repeat(88), slot: 99, blockTime: Math.floor(Date.now() / 1000) - 10, err: null }]; break;
        case 'getLatestBlockhash': result = { context, value: { blockhash: PUBLIC.pool, lastValidBlockHeight: 200 } }; break;
        case 'getBlockHeight': result = 199; break;
        default: res.destroy(); return;
      }
    }
    res.end(`{ "jsonrpc": "2.0", "id": ${JSON.stringify(body.id)}, "result": ${JSON.stringify(result)} }\n`);
  });
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/`;
const exchange = () => createFixtureHeliusExchangeV1({ capability_id: 'helius-mainnet-query-v1', api_key: key, ca: null, timeout_ms: 5000, max_response_bytes: 1048576 }, endpoint);
let serial = 0;
function session(limits = LIMITS, maxima = MAXIMA, port = exchange()) {
  const root = `/evidence/case-${++serial}`; mkdirSync(root, { mode: 0o700 });
  return { rpc: createSession(port, root, limits, maxima), root };
}
async function test(name, fn) { try { await fn(); cases.push({ name, pass: true }); }
  catch { cases.push({ name, pass: false }); } }
await test('fd5-private-loader-exact-clean-bytes-and-close', async () => {
  const port = loadExchange(endpoint);
  assert.throws(() => fstatSync(5)); // Before unrelated I/O can reuse the number.
  const { rpc, root } = session(LIMITS, MAXIMA, port);
  await rpc.call('getGenesisHash', []); rpc.close();
  const response = readFileSync(`${root}/call-01-response.json`);
  assert(response.toString().startsWith('{ "jsonrpc":'));

  assert.equal(rpc.snapshot().consumed, 1);
});
await test('closed-method-allowlist-zero-dispatch-including-submission-and-simulation', async () => {
  const before = received;
  for (const method of ['sendTransaction', 'sendBundle', 'sendRawTransaction', 'simulateTransaction', '__proto__', 'getBalance']) {
    const { rpc } = session(); await assert.rejects(rpc.call(method, [])); assert.equal(rpc.snapshot().consumed, 0);
  }
  assert.equal(received, before);
});
await test('total-call-exhaustion-before-dispatch', async () => {
  const { rpc } = session({ ...LIMITS, calls: 1 });
  await rpc.call('getGenesisHash', []); const before = received;
  await assert.rejects(rpc.call('getSlot', [])); assert.equal(received, before); assert.equal(rpc.snapshot().consumed, 1);
});
await test('per-method-exhaustion-before-dispatch', async () => {
  const { rpc } = session(); await rpc.call('getGenesisHash', []); const before = received;
  await assert.rejects(rpc.call('getGenesisHash', [])); assert.equal(received, before);
});
await test('request-byte-exhaustion-zero-dispatch', async () => {
  const { rpc } = session({ ...LIMITS, request_bytes: 1 }); const before = received;
  await assert.rejects(rpc.call('getGenesisHash', [])); assert.equal(received, before);
});
await test('aggregate-admission-exhaustion-before-next-dispatch', async () => {
  const size = Buffer.byteLength('{ "jsonrpc": "2.0", "id": "qualification-1", "result": null }\n');
  const { rpc } = session({ ...LIMITS, aggregate_bytes: size });
  await rpc.call('getGenesisHash', []); const before = received;
  await assert.rejects(rpc.call('getSlot', [])); assert.equal(received, before); assert.equal(rpc.snapshot().admitted_bytes, size);
});
await test('streamed-body-overflow-no-admitted-body-no-retry', async () => {
  mode = 'overflow'; const { rpc, root } = session({ ...LIMITS, response_bytes: 64 }); const before = received;
  await assert.rejects(rpc.call('getGenesisHash', [])); assert.equal(received, before + 1);
  assert(!existsSync(`${root}/call-01-response.json`)); assert.equal(rpc.snapshot().admitted_bytes, 0); mode = 'normal';
});
await test('aggregate-remaining-bound-passed-into-streaming-transport', async () => {
  mode = 'overflow'; const { rpc, root } = session({ ...LIMITS, aggregate_bytes: 64 });
  await assert.rejects(rpc.call('getGenesisHash', [])); assert(!existsSync(`${root}/call-01-response.json`)); mode = 'normal';
});
await test('absolute-deadline-refuses-later-call', async () => {
  const { rpc } = session({ ...LIMITS, overall_ms: 80 }); await rpc.call('getGenesisHash', []);
  await new Promise(resolve => setTimeout(resolve, 100)); const before = received;
  await assert.rejects(rpc.call('getSlot', [])); assert.equal(received, before);
});
await test('in-flight-deadline-sanitized-no-retry-late-call-closed', async () => {
  mode = 'stall'; const { rpc, root } = session({ ...LIMITS, overall_ms: 80, request_ms: 50 }); const before = received;
  await assert.rejects(rpc.call('getGenesisHash', []), e => e.message === 'QUALIFICATION_STOP' && e.cause === undefined);
  await assert.rejects(rpc.call('getSlot', [])); assert.equal(received, before + 1);
  assert(!existsSync(`${root}/call-01-response.json`)); mode = 'normal';
});
await test('credential-echo-refused-before-retention', async () => {
  mode = 'echo'; const { rpc, root } = session();
  await assert.rejects(rpc.call('getGenesisHash', []), e => !String(e).includes(key) && e.cause === undefined);
  assert(!existsSync(`${root}/call-01-response.json`)); mode = 'normal';
});
for (const status of ['401', '429']) await test(`http-${status}-safe-stop-no-retry`, async () => {
  mode = status; const { rpc, root } = session(); const before = received;
  await assert.rejects(rpc.call('getGenesisHash', [])); await assert.rejects(rpc.call('getSlot', []));
  assert.equal(received, before + 1); assert(!existsSync(`${root}/call-01-response.json`)); mode = 'normal';
});
await test('exclusive-evidence-no-overwrite', async () => {
  const { root } = session(); put(root, 'canary.json', { test: 1 });
  assert.throws(() => put(root, 'canary.json', { test: 2 })); assert.equal(JSON.parse(readFileSync(`${root}/canary.json`)).test, 1);
});
await test('complete-planned-read-path-synthetic-not-provider-qualification', async () => {
  mode = 'probe'; const { rpc, root } = session(); const findings = await probe(rpc, root);
  assert.equal(findings.disposition, 'PARTIAL_QUALIFICATION_ONLY'); assert.equal(rpc.snapshot().counts.getSignaturesForAddress, 9);
  assert(rpc.snapshot().consumed <= LIMITS.calls); mode = 'normal';
});
await test('closed-transport-owned-socket-cleanup', async () => {
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(sockets.size, 0);
});
await new Promise(resolve => server.close(resolve));
put('/evidence', 'local-results.json', { tests: cases.length, passed: cases.filter(x => x.pass).length, cases, application_requests_received: received, real_provider_requests: 0, sockets_remaining: sockets.size });
console.log(JSON.stringify({ tests: cases.length, passed: cases.filter(x => x.pass).length, real_provider_requests: 0 }));
process.exitCode = cases.every(x => x.pass) ? 0 : 1;
