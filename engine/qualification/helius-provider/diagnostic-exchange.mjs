import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalJson } from '/accepted/engine/src/verification-scope-v1-3/contract.mjs';
import { createSupervisedSubmissionTransportV1 } from '/accepted/engine/src/verification-scope-v1-3/final-proof-agent/supervised-profile-v1.mjs';
import { observe, category } from './diagnostic-stages.mjs';

const LABEL = 'OFFLINE_INJECTED_PRIMARY_SOLANA_RPC';
const unavailable = () => Error('PRIVATE_RPC_UNAVAILABLE');
const bounded = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;

// Administrator-private construction. Nothing reads credentials, opens a socket,
// starts a timer or changes process state merely by importing this module.
export function createPrivateExchangeV1(policy) { try { return construct(policy, false); } catch { throw unavailable(); } }
// Explicit disposable transport fixture. HTTP is limited to numeric loopback;
// callers must also enforce the qualification namespace on the whole process.
export function createFixtureExchangeV1(policy) { try { return construct(policy, true); } catch { throw unavailable(); } }
export const HELIUS_CAPABILITY_V1 = 'helius-mainnet-query-v1';
const HELIUS_ENDPOINT = 'https://mainnet.helius-rpc.com/';
export function createHeliusExchangeV1(policy) { return helius(policy, HELIUS_ENDPOINT, false); }
// Endpoint substitution is solely a numeric-loopback fixture, never production policy.
export function createFixtureHeliusExchangeV1(policy, endpoint) { return helius(policy, endpoint, true); }
function helius(policy, endpoint, fixture) {
  try {
    if (!policy || types.isProxy(policy) || Object.getPrototypeOf(policy) !== Object.prototype) throw unavailable();
    const descriptors = Object.getOwnPropertyDescriptors(policy);
    const fields = ['api_key', 'ca', 'capability_id', 'timeout_ms', 'max_response_bytes'];
    if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(k => !descriptors[k] || !('value' in descriptors[k]))) throw unavailable();
    const { api_key, ca, capability_id, timeout_ms, max_response_bytes } = policy;
    if (capability_id !== HELIUS_CAPABILITY_V1 || typeof endpoint !== 'string') throw unavailable();
    return construct({ endpoint, bearer: api_key, ca, capability_id, timeout_ms, max_response_bytes }, fixture, true);
  } catch { throw unavailable(); }
}
function construct({ endpoint, bearer, ca, capability_id, timeout_ms, max_response_bytes }, fixture, query = false) {
  let target;
  try { target = new URL(endpoint); } catch { throw unavailable(); }
  if (typeof bearer !== 'string' || !/^[A-Za-z0-9._~-]{16,4096}$/.test(bearer)
    || !/^[a-z][a-z0-9-]{2,63}$/.test(capability_id)
    || target.username || target.password || target.hash || target.search
    || (target.protocol !== 'https:' && !(fixture && target.protocol === 'http:'))
    || (fixture && target.hostname !== '127.0.0.1')
    || !bounded(timeout_ms, 60000) || !bounded(max_response_bytes, 16777216)
    || (ca !== null && (typeof ca !== 'string' || Buffer.byteLength(ca) > 65536))) throw unavailable();
  // Keep private endpoint and credential in this closure, never a public record.
  const needles = [bearer, `Bearer ${bearer}`, endpoint];
  if (query) {
    target.searchParams.set('api-key', bearer);
    needles.push(target.href, target.pathname + target.search, target.search);
  }
  // Finite screening views only: originals/URI forms and standard or URL-safe
  // base64, padded or unpadded. Never substitute these views for evidence bytes.
  const encodedNeedles = query ? [...new Set(needles.flatMap(n => [n, encodeURIComponent(n)].flatMap(s =>
    [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64').replace(/=+$/, ''), Buffer.from(s).toString('base64url')])))] : [];
  function queryUnsafe(s) {
    for (let layer = 0; layer <= 2; layer++) {
      if (encodedNeedles.some(n => s.includes(n))) return true;
      // Decode ASCII percent triplets locally, including unreserved characters
      // and mixed-case hex. Malformed unrelated '%' text cannot disable checks.
      if (layer < 2) s = s.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    return false;
  }
  function contaminated(bytes) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) return true;
    const unsafe = s => query ? queryUnsafe(s) : needles.some(n => s.includes(n) || s.includes(encodeURIComponent(n))
      || s.includes(Buffer.from(n).toString('base64')));
    if (unsafe(text)) return true;
    // Escaped JSON string echoes are also contaminants. Parsing does not replace
    // the original evidence, and errors never expose the response or endpoint.
    try {
      const stack = [JSON.parse(text)];
      while (stack.length) {
        const value = stack.pop();
        if (typeof value === 'string' && unsafe(value)) return true;
        if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) { if (unsafe(k)) return true; stack.push(v); }
        }
      }
    } catch { return true; }
    return false;
  }
  const active = new Set(); let closed = false;
  function request(requestBytes, signal, requestedTimeout = timeout_ms, requestedLimit = max_response_bytes) {
    if (closed || !Buffer.isBuffer(requestBytes) || requestBytes.length < 1 || requestBytes.length > 1048576
      || !(signal instanceof AbortSignal) || signal.aborted || !bounded(requestedTimeout, 60000)
      || !bounded(requestedLimit, 16777216)) return Promise.reject(unavailable());
    const body = Buffer.from(requestBytes), limit = Math.min(max_response_bytes, requestedLimit);
    const end = performance.now() + Math.min(timeout_ms, requestedTimeout);
    return new Promise((resolve, reject) => {
      let req, response, timer, settled = false, size = 0; const chunks = [];
      function finish(error, result) {
        if (settled) return; settled = true;
        clearTimeout(timer); signal.removeEventListener('abort', abort); active.delete(abort);
        if (error) { response?.destroy(); req?.destroy(); chunks.length = 0; reject(unavailable()); }
        else resolve(result);
      }
      const abort = () => finish(true);
      active.add(abort); signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { if (!settled) observe('DEADLINE'); abort(); }, Math.max(1, end - performance.now()));
      try {
        if (signal.aborted || closed || performance.now() >= end) return abort();
        // Node's direct one-shot ClientRequest: no fetch dispatcher, environment
        // proxy, redirect handler, connection reuse or transport retry mechanism.
        observe('TRANSPORT_INVOKED');
        if (performance.now() >= end || signal.aborted || closed) return abort();
        req = (target.protocol === 'https:' ? https : http).request(target, {
          method: 'POST', agent: false, maxHeaderSize: 16384, highWaterMark: 16384,
          headers: { 'content-type': 'application/json', 'accept': 'application/json',
            'accept-encoding': 'identity', ...(query ? {} : { 'authorization': `Bearer ${bearer}` }),
            'content-length': body.length, 'connection': 'close' },
          ...(target.protocol === 'https:' ? { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca === null ? {} : { ca }) } : {}),
        }, res => {
          response = res;
          observe('HTTP_STATUS', 'NONE', res.statusCode ?? 0);
          if (settled || performance.now() >= end || signal.aborted || res.statusCode !== 200
            || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
            || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(res.headers['content-type'] ?? '')
            || (res.headers['content-length'] && (!/^\d+$/.test(res.headers['content-length'])
              || Number(res.headers['content-length']) > limit))) { observe('HEADERS_REJECTED'); return abort(); }
          res.on('error', error => { if (!settled) observe('RESPONSE_ERROR', category(error)); abort(); });
          res.on('aborted', () => { if (!settled) observe('RESPONSE_ABORTED'); abort(); });
          res.on('data', chunk => {
            if (settled || performance.now() >= end || signal.aborted || chunk.length > limit - size) {
              if (!settled) observe(chunk.length > limit - size ? 'BODY_LIMIT' : 'CANCELLED'); return abort();
            }
            size += chunk.length; chunks.push(Buffer.from(chunk));
          });
          res.on('end', () => {
            if (settled || performance.now() >= end || signal.aborted || !res.complete) return abort();
            const bytes = Buffer.concat(chunks, size); chunks.length = 0;
            observe('BODY_COMPLETE', 'NONE', size);
            if (contaminated(bytes)) { observe('SCREENING_REJECTED'); return abort(); }
            observe('SCREENING_PASSED');
            if (performance.now() >= end || signal.aborted) return abort();
            finish(false, { status: 200, body: bytes });
          });
        });
        req.on('socket', socket => {
          if (!settled) observe('SOCKET_ASSIGNED');
          socket.once('lookup', error => { if (!settled) observe('WORKER_DNS_COMPLETE', error ? category(error) : 'NONE'); });
          socket.once('connect', () => { if (!settled) observe('WORKER_TCP_CONNECTED'); });
          socket.once('secureConnect', () => { if (!settled) observe('TLS_VERIFIED', 'NONE', socket.authorized ? 1 : 0); });
        });
        req.on('error', error => { if (!settled) observe('REQUEST_ERROR', category(error)); abort(); });
        req.end(body); // Exactly one invocation. Never reconstructed or resent.
      } catch (error) { if (!settled) observe('REQUEST_ERROR', category(error)); abort(); }
    });
  }
  return Object.freeze({ request, mapping: Object.freeze({ capability_id, scheduler_label: LABEL, transport_retries: 0 }),
    close() { closed = true; for (const abort of [...active]) abort(); } });
}

// Readiness has no request_bytes field: its actual serialization is canonicalJson
// of the retained request object. Simulation/source supplied bytes must match it.
export function fixedRpcAdaptersV1(exchange, budget) {
  const transport = async ({ body, signal, request_bytes }) => {
    const expected = Buffer.from(canonicalJson(body));
    if (request_bytes !== undefined && (!Buffer.isBuffer(request_bytes) || !expected.equals(request_bytes))) throw unavailable();
    const phase = body.method === 'simulateTransaction' ? budget.simulation
      : String(body.id).startsWith('economic-') ? budget.economic_source : budget.capture;
    const result = await exchange.request(request_bytes ?? expected, signal, phase.call_timeout_ms, phase.max_response_bytes);
    return result.body.toString('utf8');
  };
  const submission = { ...budget.submission, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    transport: createSupervisedSubmissionTransportV1(request => {
      if (request.endpoint !== LABEL || !Buffer.isBuffer(request.requestBody)
        || request.options.body !== request.requestBody || request.options.redirect !== 'error') throw unavailable();
      return exchange.request(request.requestBody, request.signal, request.options.timeoutMs, budget.submission.max_response_bytes);
    }) };
  return Object.freeze({ transport, submission: Object.freeze(submission) });
}
