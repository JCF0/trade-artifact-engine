import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { assertExactFields, canonicalJson, cloneAndFreeze } from '../contract.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const READ = ['getGenesisHash', 'getSlot', 'getBlock', 'getMultipleAccounts', 'getAccountInfo', 'getTokenAccountsByOwner',
  'getSignaturesForAddress', 'getLatestBlockhash', 'getFeeForMessage', 'getBlockHeight', 'getTransaction', 'getSignatureStatuses'];
const ALLOWED = { capture: READ, economic_source: READ, simulation: ['simulateTransaction'], submission: ['sendTransaction', 'getSignatureStatuses', 'getBlockHeight', 'getTransaction'] };
function stop() { throw Error('SUPERVISED_RPC_UNAVAILABLE'); }
const positive = n => Number.isSafeInteger(n) && n > 0;
export function validateSupervisedRpcBudgetV1(budget, phase) {
  const b = cloneAndFreeze(budget);
  assertExactFields(b, ['total_calls', 'call_timeout_ms', 'overall_timeout_ms', 'max_response_bytes', 'methods'], 'supervised_rpc_budget');
  if (!Object.hasOwn(ALLOWED, phase) || !positive(b.total_calls) || b.total_calls > 512
    || !positive(b.call_timeout_ms) || !positive(b.overall_timeout_ms) || b.overall_timeout_ms > 600000
    || b.call_timeout_ms > b.overall_timeout_ms || !positive(b.max_response_bytes) || b.max_response_bytes > 16777216
    || !b.methods || Object.keys(b.methods).length === 0
    || Object.entries(b.methods).some(([k, v]) => !ALLOWED[phase].includes(k) || !positive(v) || v > b.total_calls)) stop();
  return b;
}
// Trusted construction only: each instance owns one phase's finite budget.
// The release binds its transport; the agent receives no method/transport port.
export function createBoundedSupervisedRpcV1({ phase, budget, transport, clock, retain, deadline_unix_seconds = null, assert_dispatch = () => {} }) {
  const b = validateSupervisedRpcBudgetV1(budget, phase);
  if (typeof transport !== 'function' || typeof retain !== 'function') stop();
  let start = null, last = null, calls = 0, closed = false;
  const counts = Object.create(null);
  function applicableWindow() {
    if (deadline_unix_seconds !== null) {
      const wall = clock.unixSeconds();
      if (!Number.isSafeInteger(deadline_unix_seconds) || !Number.isSafeInteger(wall) || wall >= deadline_unix_seconds) stop();
    }
    // Administrator-owned synchronous check: no promise turn may intervene
    // between challenge/freshness validation and actual transport invocation.
    const result = assert_dispatch();
    if (result !== undefined) stop();
  }
  function now() {
    const n = clock.monotonicMs();
    if (!Number.isFinite(n) || n < 0 || Object.is(n, -0) || (last !== null && n < last)) stop();
    last = n; return n;
  }
  return async function request(input) {
    if (!input || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) stop();
    const d = Object.getOwnPropertyDescriptors(input);
    if (!d.body || !Object.hasOwn(d.body, 'value') || Object.keys(d).some(k => !['body', 'signal'].includes(k))
      || (d.signal && !Object.hasOwn(d.signal, 'value'))) stop();
    const body = cloneAndFreeze(d.body.value), upstream = d.signal?.value;
    assertExactFields(body, ['jsonrpc', 'id', 'method', 'params'], 'supervised_rpc_request');
    if (closed || body.jsonrpc !== '2.0' || !Object.hasOwn(b.methods, body.method) || !Array.isArray(body.params)
      || !(typeof body.id === 'string' || Number.isSafeInteger(body.id)) || upstream?.aborted
      || calls >= b.total_calls || (counts[body.method] ?? 0) >= b.methods[body.method]) stop();
    applicableWindow();
    start ??= now();
    const begun = now(), remaining = Math.min(b.call_timeout_ms, b.overall_timeout_ms - (begun - start));
    if (remaining <= 0) stop();
    const requestBytes = Buffer.from(canonicalJson(body));
    if (requestBytes.length > b.max_response_bytes) stop();
    calls++; counts[body.method] = (counts[body.method] ?? 0) + 1;
    const identity = { version: 'artifact_supervised_rpc_attempt_v1', phase, ordinal: calls,
      request_sha256: hash(requestBytes), request_base64: requestBytes.toString('base64'),
      started_monotonic_ms: begun, started_unix_seconds: clock.unixSeconds(), provider_retries: 0 };
    const controller = new AbortController(); let timer, ended = false, rejectAbort;
    const abort = () => { controller.abort(); if (rejectAbort) rejectAbort(Error('SUPERVISED_RPC_UNAVAILABLE')); };
    try {
      const timeout = new Promise((_, reject) => { rejectAbort = reject;
        timer = setTimeout(abort, remaining - (now() - begun)); });
      upstream?.addEventListener('abort', abort, { once: true });
      const work = async () => {
        await retain({ ...identity, stage: 'REQUEST_DURABLE_BEFORE_EFFECT' });
        applicableWindow();
        if (controller.signal.aborted || upstream?.aborted || now() - begun >= remaining) stop();
        const value = await transport({ body, signal: controller.signal, request_bytes: Buffer.from(requestBytes) });
        applicableWindow();
        if (controller.signal.aborted || now() - begun >= remaining) stop();
        const raw = typeof value === 'string' ? Buffer.from(value) : Buffer.isBuffer(value) ? Buffer.from(value) : null;
        if (raw === null || raw.length > b.max_response_bytes || !Buffer.from(raw.toString('utf8')).equals(raw)) stop();
        await retain({ ...identity, stage: 'RESPONSE_DURABLE', response_base64: raw.toString('base64'), response_sha256: hash(raw),
          completed_monotonic_ms: now(), completed_unix_seconds: clock.unixSeconds() });
        applicableWindow();
        if (controller.signal.aborted || now() - begun >= remaining) stop();
        return raw;
      };
      const raw = await Promise.race([work(), timeout]);
      ended = true;
      return raw.toString('utf8');
    } catch { closed = true; stop(); }
    finally { clearTimeout(timer); upstream?.removeEventListener('abort', abort); if (!ended) controller.abort(); }
  };
}
