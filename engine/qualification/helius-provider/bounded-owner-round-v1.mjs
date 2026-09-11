// Complete-round qualification allocation; predecessor and production are unchanged.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalJson } from '/accepted/engine/src/verification-scope-v1-3/contract.mjs';
import { reviveSolanaRentEpochV1 } from '/accepted/engine/src/wallet-acquisition/solana-rent-epoch-v1.mjs';
import { MAXIMA as PREVIOUS_MAXIMA, LIMITS, put, loadExchange } from './bounded-successor.mjs';
export { LIMITS, put, loadExchange };
export const MAXIMA = Object.freeze({ ...PREVIOUS_MAXIMA, getMultipleAccounts: 3, getTokenAccountsByOwner: 4 });
export const VERSION = 'ARTIFACT_QUALIFICATION_OWNER_ROUND_SESSION_V1';
export const RETRY_POLICY = Object.freeze({ additional_attempts: 2,
  backoff_ms: Object.freeze([250, 500]), rpc_code: -32016, transport_retries: 0 });
const READ_ONLY = new Set(Object.keys(MAXIMA).filter(method => method !== 'simulateTransaction'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const monotonic = () => Number(process.hrtime.bigint()) / 1e6;

// workDeadlineMonotonicMs is the launcher's original CLOCK_MONOTONIC work cutoff.
// limits can only tighten the existing envelope; they cannot replenish authority.
export function createSession(exchange, root, workDeadlineMonotonicMs, limits = LIMITS) {
  if (!Number.isFinite(workDeadlineMonotonicMs) || workDeadlineMonotonicMs <= monotonic()
    || Object.keys(limits).sort().join(',') !== Object.keys(LIMITS).sort().join(',')
    || Object.entries(limits).some(([k, v]) => !Number.isSafeInteger(v) || v < 1 || v > LIMITS[k])) {
    exchange.close(); throw Error('QUALIFICATION_POLICY_STOP');
  }
  limits = Object.freeze({ ...limits });
  const end = Math.min(workDeadlineMonotonicMs, monotonic() + limits.overall_ms);
  let consumed = 0, admitted = 0, logical = 0, retries = 0, closed = false, busy = false, reason = null;
  const counts = Object.create(null), logicalCounts = Object.create(null), ledger = [], retryLedger = [];
  const remaining = () => end - monotonic();
  function stop(code) { reason ??= code; closed = true; exchange.close(); throw Error(code); }
  function gate() {
    if (closed) stop('QUALIFICATION_CLOSED');
    if (consumed >= limits.calls) stop('QUALIFICATION_CALL_BUDGET');
    if (admitted >= limits.aggregate_bytes) stop('QUALIFICATION_BYTE_BUDGET');
    if (remaining() < 1) stop('QUALIFICATION_DEADLINE');
  }
  return Object.freeze({
    requireCapacity(calls) {
      gate();
      if (!Number.isSafeInteger(calls) || calls < 1 || consumed + calls > limits.calls) stop('QUALIFICATION_DOWNSTREAM_CALL_BUDGET');
    },
    async call(method, params) {
      if (closed || busy) stop('QUALIFICATION_CLOSED');
      if (!Object.hasOwn(MAXIMA, method)) stop('QUALIFICATION_METHOD_DENIED');
      if (!Array.isArray(params)) stop('QUALIFICATION_PARAMETERS_DENIED');
      if ((logicalCounts[method] ?? 0) >= MAXIMA[method]) stop('QUALIFICATION_LOGICAL_METHOD_BUDGET');
      gate(); busy = true;
      try {
        // Snapshot once. Caller mutations during backoff cannot alter any retry.
        const template = canonicalJson({ method, params });
        const templateIdentity = hash(template);
        logical++; logicalCounts[method] = (logicalCounts[method] ?? 0) + 1;
        let attempt = 0, retryOrdinal = 0;
        for (;;) {
          gate(); attempt++;
          const body = { jsonrpc: '2.0', id: `qualification-${consumed + 1}`, ...JSON.parse(template) };
          const request = Buffer.from(canonicalJson(body));
          if (request.length > limits.request_bytes) stop('QUALIFICATION_REQUEST_BUDGET');
          const ordinal = consumed + 1, stem = `call-${String(ordinal).padStart(2, '0')}`;
          let row, eligible = false;
          try {
            const request_identity = put(root, `${stem}-request.json`, request);
            gate(); consumed++; counts[method] = (counts[method] ?? 0) + 1;
            row = { ordinal, logical_ordinal: logical, attempt_ordinal: attempt, retry_ordinal: retryOrdinal,
              method, template_sha256: templateIdentity, request_identity, started_monotonic_ms: performance.now(),
              started_unix_ms: Date.now(), disposition: 'RESERVED_POSSIBLY_DISPATCHED' };
            ledger.push(row); put(root, `${stem}-reserved.json`, row);
            const controller = new AbortController();
            // No asynchronous turn between this post-retention check and transport.
            const timeout = Math.floor(Math.min(limits.request_ms, remaining()));
            if (closed || timeout < 1) stop('QUALIFICATION_DEADLINE');
            const response = await exchange.request(request, controller.signal, timeout,
              Math.min(limits.response_bytes, limits.aggregate_bytes - admitted));
            if (response.status !== 200) stop('QUALIFICATION_TRANSPORT_SCREENING_OR_LOCAL_STOP');
            admitted += response.body.length;
            row.response_identity = put(root, `${stem}-response.json`, response.body);
            const envelope = JSON.parse(response.body.toString('utf8'), reviveSolanaRentEpochV1);
            if (envelope?.jsonrpc !== '2.0' || envelope.id !== body.id
              || Object.keys(envelope).some(k => !['jsonrpc', 'id', 'result', 'error'].includes(k))
              || Object.hasOwn(envelope, 'result') === Object.hasOwn(envelope, 'error')) stop('QUALIFICATION_CONTRACT_STOP');
            if (Object.hasOwn(envelope, 'error')) {
              row.disposition = 'OBSERVED_RPC_REFUSAL';
              if (Number.isSafeInteger(envelope.error?.code)) row.rpc_code = envelope.error.code;
              eligible = READ_ONLY.has(method) && envelope.error?.code === RETRY_POLICY.rpc_code
                && typeof envelope.error.message === 'string';
              row.context_lag_retry_eligible = eligible;
              if (!eligible) stop('QUALIFICATION_RPC_REFUSAL');
            } else row.disposition = 'ADMITTED_RESULT_NOT_YET_QUALIFIED';
            if (remaining() < 1) stop('QUALIFICATION_DEADLINE');
            if (!eligible) return envelope.result;
          } finally {
            if (row) {
              if (row.disposition === 'RESERVED_POSSIBLY_DISPATCHED') row.disposition = 'TRANSPORT_SCREENING_OR_LOCAL_STOP';
              row.elapsed_ms = performance.now() - row.started_monotonic_ms;
              put(root, `${stem}-completion.json`, row);
            }
          }
          // Only an explicitly correlated, retained -32016 on a read reaches here.
          gate();
          if (retries >= RETRY_POLICY.additional_attempts) stop('QUALIFICATION_CONTEXT_LAG_ALLOWANCE');
          const delay = RETRY_POLICY.backoff_ms[retries];
          if (remaining() <= delay) stop('QUALIFICATION_DEADLINE');
          retries++; retryOrdinal = retries;
          const reservation = { retry_ordinal: retries, logical_ordinal: logical, after_ordinal: ordinal,
            next_attempt_ordinal: attempt + 1, template_sha256: templateIdentity, backoff_ms: delay,
            work_deadline_monotonic_ms: end, disposition: 'RETRY_RESERVED_NO_REFUND' };
          retryLedger.push(reservation); put(root, `retry-${retries}-reserved.json`, reservation);
          if (remaining() <= delay) stop('QUALIFICATION_DEADLINE');
          await sleep(delay);
          // Sleeping, retention and unrelated worker computation never reset end.
          gate();
        }
      } catch {
        stop(reason ?? 'QUALIFICATION_TRANSPORT_SCREENING_OR_LOCAL_STOP');
      } finally { busy = false; }
    },
    snapshot() { return JSON.parse(JSON.stringify({ version: VERSION, policy: RETRY_POLICY, limits, maxima: MAXIMA,
      work_deadline_monotonic_ms: end, consumed, logical_calls: logical, retries_reserved: retries,
      admitted_bytes: admitted, counts, logical_counts: logicalCounts, ledger, retry_ledger: retryLedger,
      closed, stop_reason: reason })); },
    close() { closed = true; exchange.close(); },
  });
}

