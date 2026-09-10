import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { createSupervisedSubmissionTransportV1 } from '../../src/verification-scope-v1-3/final-proof-agent/supervised-profile-v1.mjs';

const LABEL = 'OFFLINE_INJECTED_PRIMARY_SOLANA_RPC';
const unavailable = () => Error('PRIVATE_RPC_UNAVAILABLE');
const bounded = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;

// Administrator-private construction. Nothing reads credentials, opens a socket,
// starts a timer or changes process state merely by importing this module.
export function createPrivateExchangeV1(policy) { return construct(policy, false); }
// Explicit disposable transport fixture. HTTP is limited to numeric loopback;
// callers must also enforce the qualification namespace on the whole process.
export function createFixtureExchangeV1(policy) { return construct(policy, true); }
function construct({ endpoint, bearer, ca, capability_id, timeout_ms, max_response_bytes }, fixture) {
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
  function contaminated(bytes) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) return true;
    const unsafe = s => needles.some(n => s.includes(n) || s.includes(encodeURIComponent(n))
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
      timer = setTimeout(abort, Math.max(1, end - performance.now()));
      try {
        if (signal.aborted || closed || performance.now() >= end) return abort();
        // Node's direct one-shot ClientRequest: no fetch dispatcher, environment
        // proxy, redirect handler, connection reuse or transport retry mechanism.
        req = (target.protocol === 'https:' ? https : http).request(target, {
          method: 'POST', agent: false, maxHeaderSize: 16384, highWaterMark: 16384,
          headers: { 'content-type': 'application/json', 'accept': 'application/json',
            'accept-encoding': 'identity', 'authorization': `Bearer ${bearer}`,
            'content-length': body.length, 'connection': 'close' },
          ...(target.protocol === 'https:' ? { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca === null ? {} : { ca }) } : {}),
        }, res => {
          response = res;
          if (settled || performance.now() >= end || signal.aborted || res.statusCode !== 200
            || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
            || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(res.headers['content-type'] ?? '')
            || (res.headers['content-length'] && (!/^\d+$/.test(res.headers['content-length'])
              || Number(res.headers['content-length']) > limit))) return abort();
          res.on('error', abort); res.on('aborted', abort);
          res.on('data', chunk => {
            if (settled || performance.now() >= end || signal.aborted || chunk.length > limit - size) return abort();
            size += chunk.length; chunks.push(Buffer.from(chunk));
          });
          res.on('end', () => {
            if (settled || performance.now() >= end || signal.aborted || !res.complete) return abort();
            const bytes = Buffer.concat(chunks, size); chunks.length = 0;
            if (contaminated(bytes)) return abort();
            finish(false, { status: 200, body: bytes });
          });
        });
        req.on('error', abort);
        req.end(body); // Exactly one invocation. Never reconstructed or resent.
      } catch { abort(); }
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
