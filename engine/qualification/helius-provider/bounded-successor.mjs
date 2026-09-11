// Qualification-only. No production composer, authority, signer or submission imports.
import { openSync, closeSync, writeSync, fsyncSync, fstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from '/accepted/engine/src/verification-scope-v1-3/contract.mjs';
import { readBoundedFdV1, parseCanonicalV1 } from '/accepted/engine/deployment/private-binding/io.mjs';
import { createHeliusExchangeV1, createFixtureHeliusExchangeV1 } from '/accepted/engine/deployment/private-binding/exchange.mjs';

export const MAXIMA = Object.freeze({ getGenesisHash: 1, getSlot: 1, getBlock: 1,
  getMultipleAccounts: 2, getAccountInfo: 1, getTokenAccountsByOwner: 2,
  getSignaturesForAddress: 15, getLatestBlockhash: 1, getBlockHeight: 1, getTransaction: 2, getFeeForMessage: 1, simulateTransaction: 1 });
export const LIMITS = Object.freeze({ calls: 29, response_bytes: 1048576,
  aggregate_bytes: 16777216, request_bytes: 1048576, request_ms: 5000, overall_ms: 55000 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Error(code); };
export function put(root, name, bytes) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) fail('QUALIFICATION_LOCAL_STOP');
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(canonicalJson(bytes));
  const fd = openSync(`${root}/${name}`, 'wx', 0o600);
  try { let offset = 0; while (offset < data.length) offset += writeSync(fd, data, offset); fsyncSync(fd); }
  finally { closeSync(fd); }
  const dir = openSync(root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  return { bytes: data.length, sha256: hash(data) };
}
export function loadExchange(fixtureEndpoint = null) {
  let raw;
  try {
    // FD 5 is the sole private capability. No environment/path/key selection.
    const info = readFileSync('/proc/self/fdinfo/5', 'utf8');
    if ((parseInt(/^flags:\s+([0-7]+)/m.exec(info)?.[1] ?? '', 8) & 3) !== 0) fail('QUALIFICATION_CREDENTIAL_STOP');
    const st = fstatSync(5);
    if (!st.isFile() || st.nlink !== 1) fail('QUALIFICATION_CREDENTIAL_STOP');
    raw = readBoundedFdV1(5, 73728, process.getuid());
    const secret = parseCanonicalV1(raw);
    const policy = { ...secret, timeout_ms: LIMITS.request_ms, max_response_bytes: LIMITS.response_bytes };
    // The accepted constructor checks all private fields and key/CA grammar.
    if (Object.keys(secret).sort().join(',') !== 'api_key,ca,capability_id') fail('QUALIFICATION_CREDENTIAL_STOP');
    return fixtureEndpoint === null ? createHeliusExchangeV1(policy) : createFixtureHeliusExchangeV1(policy, fixtureEndpoint);
  } catch { fail('QUALIFICATION_CREDENTIAL_STOP'); }
  finally { raw?.fill(0); try { closeSync(5); } catch { /* Missing capability remains a fixed refusal. */ } }
}
export function createSession(exchange, root, limits = LIMITS, maxima = MAXIMA) {
  if (Object.keys(limits).sort().join(',') !== Object.keys(LIMITS).sort().join(',')
    || Object.entries(limits).some(([k, v]) => !Number.isSafeInteger(v) || v < 1 || v > LIMITS[k])
    || Object.entries(maxima).some(([k, v]) => !Object.hasOwn(MAXIMA, k) || !Number.isSafeInteger(v) || v < 1 || v > MAXIMA[k])) fail('QUALIFICATION_POLICY_STOP');
  limits = Object.freeze({ ...limits }); maxima = Object.freeze({ ...maxima });
  let consumed = 0, admitted = 0, start = null, closed = false, busy = false;
  const counts = Object.create(null), ledger = [];
  function stop(code) { closed = true; exchange.close(); fail(code); }
  function remaining() { return start === null ? limits.overall_ms : limits.overall_ms - (performance.now() - start); }
  return Object.freeze({
    async call(method, params) {
      if (closed || busy) stop('QUALIFICATION_CLOSED');
      if (!Object.hasOwn(maxima, method)) stop('QUALIFICATION_METHOD_DENIED');
      if (!Array.isArray(params)) stop('QUALIFICATION_PARAMETERS_DENIED');
      if (consumed >= limits.calls || (counts[method] ?? 0) >= maxima[method]) stop('QUALIFICATION_CALL_BUDGET');
      if (admitted >= limits.aggregate_bytes) stop('QUALIFICATION_BYTE_BUDGET');
      if (remaining() <= 0) stop('QUALIFICATION_DEADLINE');
      busy = true;
      const body = { jsonrpc: '2.0', id: `qualification-${consumed + 1}`, method, params };
      const request = Buffer.from(canonicalJson(body));
      if (request.length > limits.request_bytes) stop('QUALIFICATION_REQUEST_BUDGET');
      const ordinal = consumed + 1, stem = `call-${String(ordinal).padStart(2, '0')}`;
      let row;
      try {
        const request_identity = put(root, `${stem}-request.json`, request);
        if (remaining() <= 0) stop('QUALIFICATION_DEADLINE');
        if (start === null) start = performance.now();
        consumed++; counts[method] = (counts[method] ?? 0) + 1;
        row = { ordinal, method, request_identity, started_monotonic_ms: performance.now(),
          started_unix_ms: Date.now(), disposition: 'RESERVED_POSSIBLY_DISPATCHED' };
        ledger.push(row);
        put(root, `${stem}-reserved.json`, row);
        // Last check after all synchronous retention and before the actual exchange.
        const timeout = Math.floor(Math.min(limits.request_ms, remaining()));
        if (timeout < 1) stop('QUALIFICATION_DEADLINE');
        const controller = new AbortController();
        const response = await exchange.request(request, controller.signal, timeout,
          Math.min(limits.response_bytes, limits.aggregate_bytes - admitted));
        admitted += response.body.length;
        row.response_identity = put(root, `${stem}-response.json`, response.body);
        const envelope = JSON.parse(response.body.toString('utf8'));
        if (envelope?.jsonrpc !== '2.0' || envelope.id !== body.id
          || Object.keys(envelope).some(k => !['jsonrpc', 'id', 'result', 'error'].includes(k))
          || Object.hasOwn(envelope, 'result') === Object.hasOwn(envelope, 'error')) stop('QUALIFICATION_CONTRACT_STOP');
        if (Object.hasOwn(envelope, 'error')) {
          row.disposition = 'OBSERVED_RPC_REFUSAL';
          if (Number.isSafeInteger(envelope.error?.code)) row.rpc_code = envelope.error.code;
          stop('QUALIFICATION_RPC_REFUSAL');
        }
        row.disposition = 'ADMITTED_RESULT_NOT_YET_QUALIFIED';
        return envelope.result;
      } catch {
        if (row && row.disposition === 'RESERVED_POSSIBLY_DISPATCHED') row.disposition = 'TRANSPORT_SCREENING_OR_LOCAL_STOP';
        closed = true; exchange.close();
        fail('QUALIFICATION_STOP');
      } finally {
        busy = false;
        if (row) { row.elapsed_ms = performance.now() - row.started_monotonic_ms; put(root, `${stem}-completion.json`, row); }
      }
    },
    snapshot() { return JSON.parse(JSON.stringify({ consumed, admitted_bytes: admitted, counts, ledger, closed })); },
    close() { closed = true; exchange.close(); },
  });
}
