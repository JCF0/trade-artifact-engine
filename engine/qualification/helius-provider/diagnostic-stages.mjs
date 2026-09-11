// Diagnostic-only closed observations. No error object or arbitrary text is retained.
import { openSync, writeSync, closeSync, fsyncSync } from 'node:fs';
const stages = new Set(['WORKER_STARTED', 'CAPABILITY_LOADED', 'TRANSPORT_INVOKED', 'SOCKET_ASSIGNED',
  'WORKER_DNS_COMPLETE', 'WORKER_TCP_CONNECTED', 'TLS_VERIFIED', 'HTTP_STATUS', 'HEADERS_REJECTED',
  'BODY_LIMIT', 'BODY_COMPLETE', 'SCREENING_REJECTED', 'SCREENING_PASSED', 'REQUEST_ERROR',
  'RESPONSE_ERROR', 'RESPONSE_ABORTED', 'DEADLINE', 'CANCELLED', 'ADMITTED', 'WORKER_STOP']);
const errors = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
let ordinal = 0;
export function category(error) { return errors.has(error?.code) ? error.code : 'UNKNOWN'; }
export function observe(stage, code = 'NONE', value = 0) {
  if (!stages.has(stage) || !(code === 'NONE' || code === 'UNKNOWN' || errors.has(code))
    || !Number.isSafeInteger(value) || value < 0 || value > 16777216 || ordinal >= 40) throw Error('DIAGNOSTIC_SCHEMA_STOP');
  const record = { version: 1, stage, code, value, monotonic_ns: Number(process.hrtime.bigint()) };
  if (!Number.isSafeInteger(record.monotonic_ns)) throw Error('DIAGNOSTIC_CLOCK_STOP');
  const fd = openSync(`/evidence/diagnostic-worker-${String(++ordinal).padStart(2, '0')}.json`, 'wx', 0o600);
  try { const bytes = Buffer.from(JSON.stringify(record) + '\n'); let n = 0;
    while (n < bytes.length) n += writeSync(fd, bytes, n); fsyncSync(fd);
  } finally { closeSync(fd); }
}
