import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertExactFields, canonicalJson, cloneAndFreeze, sha256CanonicalJson } from '../contract.mjs';
import { buildOrcaMessageBoundaryV1 } from './orca-message-boundary-v1.mjs';
import { OFFLINE_WALLET_PROFILE_V1 } from './executor-mandate-profile-v1.mjs';
import { closeTrustedTerminalSourceV1 } from './wiggles-terminal-closure-v1.mjs';
import { POLICY, canonicalJson as schedulerJson, createFilesystemEvidencePort, inspectSignedLegacyWire,
  runBoundedRebroadcast, verifyClosedEvidence, verifyResolutionEvidence } from './reused/bounded-rebroadcast-v1.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stop = () => { throw Error('TRUSTED_SUBMISSION_EVIDENCE_OR_AUTHORITY_INVALID'); };
const uint = n => Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
const PROFILE = 'OFFLINE_INJECTED_SUBMISSION_V1';
function directory(path) {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid()
      || (s.mode & 0o777) !== 0o700 || realpathSync(path) !== path) stop();
  return s;
}
function syncDirectory(path) {
  directory(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function read(path, max = 4194304, durable = false) {
  directory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600
        || s.size < 1 || s.size > max) stop();
    if (durable) fsyncSync(fd);
    const bytes = Buffer.alloc(s.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) stop(); offset += n;
    }
    const a = fstatSync(fd), current = lstatSync(path);
    if (a.size !== s.size || a.ctimeMs !== s.ctimeMs || a.mtimeMs !== s.mtimeMs
        || current.ino !== s.ino || current.dev !== s.dev) stop();
    return bytes;
  } finally { closeSync(fd); }
}
function persist(root, name, value) {
  directory(root);
  const bytes = Buffer.from(canonicalJson(value));
  if (bytes.length > 4194304 || !/^[a-z0-9.-]+$/.test(name)) stop();
  const fd = openSync(join(root, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!n) stop(); offset += n;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(root);
  if (!read(join(root, name)).equals(bytes)) stop();
  return hash(bytes);
}
function json(path) {
  const bytes = read(path), value = JSON.parse(bytes.toString());
  if (!Buffer.from(canonicalJson(value)).equals(bytes)) stop();
  return value;
}
function snapshot(root) {
  directory(root);
  const files = new Map(), directories = new Set(['']);
  let total = 0;
  function walk(dir = '') {
    const names = readdirSync(join(root, dir));
    if (names.length > 1500) stop();
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) stop();
      const rel = dir ? `${dir}/${name}` : name, path = join(root, rel), s = lstatSync(path);
      if (s.isDirectory() && !dir) { directory(path); directories.add(rel); walk(rel); }
      else {
        const bytes = read(path);
        total += bytes.length;
        if (total > 67108864) stop();
        files.set(rel, bytes);
      }
    }
  }
  walk(); return { files, directories };
}
function port(root, guard, observed = () => {}) {
  const p = createFilesystemEvidencePort(root);
  return { ...p, reserve(options) { guard(); p.reserve(options); syncDirectory(dirname(root)); observed(null); },
    persist(...args) { guard(); const result = p.persist(...args); observed(...args); return result; } };
}
// Reconstruct the private prepared/message/intent tuple from the retained capture,
// not a caller-supplied wire or lifetime. Capture files remain content-addressed.
async function inputFor(c, authority, ordinal) {
  const episode_id = `bounded-agent-episode-${c.authorization.authorization_digest}`;
  const inspected = await authority.inspectEpisodeV1({ episode_id });
  const row = inspected.ordinals.find(r => r.ordinal === ordinal);
  if (!row || !['SIGNED_INTENT_DURABLE', 'SUBMISSION_POSSIBLE', 'FINALIZED'].includes(row.stage)) stop();
  const challenge = await authority.loadIssuedReadinessChallengeV1({ episode_id, challenge_id: row.challenge_id });
  const names = readdirSync(c.state_root).filter(n => /^readiness-evidence-[0-9a-f]{64}\.json$/.test(n));
  if (names.length > 1024) stop();
  let capture = null, capture_digest = null;
  for (const name of names) {
    const v = json(join(c.state_root, name));
    if (`readiness-evidence-${sha256CanonicalJson(v)}.json` !== name) stop();
    if (v.challenge?.challenge_digest === challenge.challenge_digest) {
      if (capture) stop(); capture = v; capture_digest = sha256CanonicalJson(v);
    }
  }
  if (!capture || canonicalJson(capture.challenge) !== canonicalJson(challenge)
      || sha256CanonicalJson({ episode_id, ordinal, source: capture.source }) !== challenge.readiness_evidence_digest) stop();
  const { fee_message_sha256, ...source } = capture.source;
  const quantity = ordinal === 1 ? c.mandate.economic_authority.acquisition_input_usdc_raw : challenge.chain_derived_disposal_jup_raw;
  const plan = buildOrcaMessageBoundaryV1({ ...source, mandate: c.mandate, phase: row.phase, ordinal,
    input_raw_quantity: quantity, retained_acquisition_jup_raw: ordinal === 1 ? null : quantity });
  const prepared = { prepared_transaction_version: 'artifact_bounded_agent_prepared_transaction_v1',
    episode_id, phase: row.phase, admission_digest: row.admission_digest, wallet: c.mandate.wallet_scope.wallet,
    pool: c.mandate.route_scope.pool, input_mint: plan.input_mint, output_mint: plan.output_mint,
    input_raw_quantity: plan.input_raw_quantity, maximum_slippage_bps: c.mandate.economic_authority.maximum_slippage_bps,
    transaction_profile: 'DIRECT_CLASSIC_ORCA_LEGACY_SWAP_V1', unsigned_transaction_digest: sha256CanonicalJson(plan),
    readiness_evidence_digest: challenge.readiness_evidence_digest };
  const signed = { signed_transaction_intent_version: 'artifact_bounded_agent_signed_transaction_intent_v1',
    episode_id, phase: row.phase, admission_digest: row.admission_digest, semantic_transaction_digest: sha256CanonicalJson(plan),
    message_sha256: row.message_sha256, signed_wire_sha256: row.signed_wire_sha256, signature: row.transaction_signature, sign_count: 1 };
  const wire = await authority.readRetainedWireV1({ episode_id, ordinal });
  const parsed = inspectSignedLegacyWire(wire.toString('base64'));
  if (fee_message_sha256 !== row.message_sha256 || plan.message_sha256 !== row.message_sha256
      || !Buffer.from(plan.message_base64, 'base64').equals(parsed.message)
      || sha256CanonicalJson(prepared) !== row.prepared_transaction_digest
      || sha256CanonicalJson(plan) !== row.semantic_transaction_digest || sha256CanonicalJson(signed) !== row.signed_intent_digest
      || parsed.expectedSignature !== row.transaction_signature) stop();
  const latest = capture.raw_evidence_digests.map(d => {
    if (!/^[0-9a-f]{64}$/.test(d)) stop();
    const v = json(join(c.state_root, `readiness-evidence-${d}.json`));
    if (sha256CanonicalJson(v) !== d) stop(); return v;
  }).filter(v => v.request.method === 'getLatestBlockhash');
  if (latest.length !== 1) stop();
  const envelope = JSON.parse(latest[0].raw_response), blockhash = envelope.result;
  if (envelope.id !== latest[0].request.id || envelope.jsonrpc !== '2.0' || envelope.error
      || blockhash?.value?.blockhash !== parsed.recentBlockhash || !uint(blockhash?.context?.slot)
      || !uint(blockhash.value.lastValidBlockHeight)) stop();
  const intent = { parent_intent_path: 'signed-intent.json', parent_intent_sha256: hash(schedulerJson(signed)),
    expected_signature: row.transaction_signature, signed_transaction_sha256: row.signed_wire_sha256,
    message_sha256: row.message_sha256, recent_blockhash: parsed.recentBlockhash,
    last_valid_block_height: blockhash.value.lastValidBlockHeight, latest_blockhash_context_slot: blockhash.context.slot,
    endpoint_capability_id: 'PRIMARY_SOLANA_RPC' };
  return { episode_id, inspected, row, wire, signed, intent, capture_digest };
}
function unresolved(x) {
  return cloneAndFreeze({ classification: 'UNRESOLVED', episode_id: x.episode_id, ordinal: x.row.ordinal,
    signed_intent_digest: x.row.signed_intent_digest, economic_authority: 'NOT_PROMOTED',
    recovery: 'NO_NEW_SENDS_OR_SIGNING; RETAIN_FOR_SUPERVISED_RECONCILIATION' });
}
function bindingFor(c, x, limits) {
  return { schema: 'artifact_trusted_submission_binding_v1', profile: PROFILE, policy: POLICY.id,
    episode_id: x.episode_id, ordinal: x.row.ordinal, mandate_digest: c.mandate.mandate_digest,
    authorization_digest: c.authorization.authorization_digest, executor_release_sha256: c.executor_release_sha256,
    signed_intent_digest: x.row.signed_intent_digest, prepared_transaction_digest: x.row.prepared_transaction_digest,
    capture_digest: x.capture_digest, intent: x.intent, limits, runtime_deadline_unix_seconds: c.deadline_unix_seconds,
    recovery_policy: 'WHOLE_SCHEDULE_CONSUMED_BEFORE_EFFECT_NO_RESTART_TRANSPORT' };
}
// Local provenance is executor custody + SQLite linearization + retained exact
// request/response bytes. Hashes detect alteration relative to a trusted binding;
// they are NOT provider signatures or independent onchain authentication.
function validateTerminal(terminal, intent) {
  verifyResolutionEvidence(terminal, intent);
  const result = JSON.parse(terminal.files.get('resolution.json'));
  // Correlate finalized observations, not merely null/non-null errors.
  if (['FINALIZED_SUCCESS', 'FINALIZED_FAILURE'].includes(result.classification)) {
    const names = [...terminal.files.keys()].filter(p => /^poll-[0-9]{4}-status-raw-response.json$/.test(p)).sort();
    const status = JSON.parse(terminal.files.get(names.at(-1))).result;
    const tx = JSON.parse(terminal.files.get('finalized-transaction-raw-response.json')).result;
    if (status?.value?.[0]?.confirmationStatus !== 'finalized'
        || status.value[0].slot !== tx.slot || status.context.slot < tx.slot
        || canonicalJson(status.value[0].err) !== canonicalJson(tx.meta.err)) stop();
  }
  return result;
}
function validateCallTiming(root, name, binding, request, retention, access = { json, read }) {
  const { json, read } = access;
  const event = json(join(root, name)), t = json(join(root, name.replace('call-', 'timing-')));
  assertExactFields(t, ['schema', 'request_id', 'call_sha256', 'request_ordinal', 'acknowledgment_origin_ms',
    'resolution_origin_ms', 'disposition', 'dispatch_ms', 'dispatch_unix_seconds', 'observed_ms',
    'observed_unix_seconds', 'late_response'], 'submission_call_timing');
  if (t.schema !== 'artifact_trusted_submission_call_timing_v1' || t.request_id !== event.request_id
      || t.call_sha256 !== hash(read(join(root, name))) || t.request_ordinal !== request.ordinal
      || !uint(t.dispatch_ms) || t.dispatch_ms < event.elapsed_ms
      || !uint(t.dispatch_unix_seconds) || t.dispatch_unix_seconds >= binding.runtime_deadline_unix_seconds
      || !uint(t.observed_ms) || t.observed_ms < t.dispatch_ms || !uint(t.observed_unix_seconds)
      || t.dispatch_ms + request.timeout_ms > binding.limits.overall_timeout_ms
      || !['ACCEPTED', 'TRANSPORT_ERROR', 'LATE_RESPONSE'].includes(t.disposition)) stop();
  if (t.acknowledgment_origin_ms !== null && !uint(t.acknowledgment_origin_ms)) stop();
  if (request.ordinal <= 3 ? t.resolution_origin_ms !== null
    : !uint(t.resolution_origin_ms) || t.resolution_origin_ms > t.dispatch_ms
      || t.dispatch_ms - t.resolution_origin_ms + request.timeout_ms > POLICY.resolutionDeadlineMs) stop();
  if (request.ordinal > 1 && request.ordinal <= 3) {
    const [due, latest] = POLICY.ordinalWindowsMs[request.ordinal - 2];
    if (t.acknowledgment_origin_ms === null || t.dispatch_ms - t.acknowledgment_origin_ms < due
        || t.dispatch_ms - t.acknowledgment_origin_ms >= latest) stop();
  }
  const onTime = t.observed_ms < t.dispatch_ms + request.timeout_ms
    && t.observed_ms < binding.limits.overall_timeout_ms
    && t.observed_unix_seconds >= t.dispatch_unix_seconds
    && t.observed_unix_seconds < binding.runtime_deadline_unix_seconds
    && (request.ordinal <= 3 || t.observed_ms - t.resolution_origin_ms < POLICY.resolutionDeadlineMs);
  if (retention.body_present !== (t.disposition === 'ACCEPTED')
      || (t.disposition === 'ACCEPTED' && !onTime)) stop();
  if (t.disposition === 'LATE_RESPONSE') {
    assertExactFields(t.late_response, ['status', 'body_base64'], 'late_response');
    if (onTime || typeof t.late_response.body_base64 !== 'string'
        || Buffer.from(t.late_response.body_base64, 'base64').toString('base64') !== t.late_response.body_base64
        || Buffer.from(t.late_response.body_base64, 'base64').length > binding.limits.max_response_bytes) stop();
  } else if (t.late_response !== null) stop();
  return t;
}
export function validateRetainedSubmissionEvidenceV1({ root, expected_binding }) {
  return validateSubmissionContents({ root, expected_binding }, { json, read, snapshot, readdirSync });
}
// Same verifier, with an immutable byte snapshot instead of executor-root I/O.
// This proves retained transmission consistency, never provider truth/economics.
export function validateRetainedSubmissionSnapshotV1({ members, expected_binding }) {
  const values = cloneAndFreeze(members), files = new Map();
  if (!Array.isArray(values) || values.length > 1500) stop();
  let total = 0;
  for (const member of values) {
    assertExactFields(member, ['path', 'base64'], 'submission_snapshot_member');
    if (typeof member.path !== 'string' || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,3}$/.test(member.path)
        || member.path.split('/').some(p => p === '.' || p === '..') || files.has(member.path)
        || typeof member.base64 !== 'string' || member.base64.length > 5592408) stop();
    const bytes = Buffer.from(member.base64, 'base64'); total += bytes.length;
    if (!bytes.length || bytes.length > 4194304 || total > 67108864 || bytes.toString('base64') !== member.base64) stop();
    files.set(member.path, bytes);
  }
  const readBytes = name => { const b = files.get(name); if (!b) stop(); return Buffer.from(b); };
  const parse = name => { const b = readBytes(name), v = JSON.parse(b); if (!Buffer.from(canonicalJson(v)).equals(b)) stop(); return v; };
  const list = prefix => [...new Set([...files.keys()].filter(p => !prefix || p.startsWith(`${prefix}/`))
    .map(p => p.slice(prefix ? prefix.length + 1 : 0).split('/')[0]))];
  const sub = prefix => {
    const subset = new Map([...files].filter(([p]) => p.startsWith(`${prefix}/`)).map(([p, b]) => [p.slice(prefix.length + 1), Buffer.from(b)]));
    const directories = new Set(['']);
    for (const p of subset.keys()) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/')); }
    return { files: subset, directories };
  };
  return validateSubmissionContents({ root: '', expected_binding }, { json: parse, read: readBytes, snapshot: sub, readdirSync: list });
}
function validateSubmissionContents({ root, expected_binding }, access) {
  const { json, read, snapshot, readdirSync } = access;
  const binding = json(join(root, 'binding.json'));
  if (canonicalJson(binding) !== canonicalJson(expected_binding)) stop();
  const signed = json(join(root, 'signed-intent.json'));
  if (hash(schedulerJson(signed)) !== binding.intent.parent_intent_sha256
      || sha256CanonicalJson(signed) !== binding.signed_intent_digest) stop();
  const scheduler = snapshot(join(root, 'rebroadcast')), terminal = snapshot(join(root, 'terminal'));
  const terminalResult = validateTerminal(terminal, binding.intent);
  verifyClosedEvidence(scheduler, terminal);
  const journal = readdirSync(root).filter(p => /^call-[0-9]{4}\.json$/.test(p)).sort();
  // The reused scheduler can record a failed callback as a transport attempt.
  // A wrapper budget refusal is not an external call: do not certify that record
  // as complete transmission evidence when our durable dispatch journal is absent.
  const retainedCalls = [...scheduler.files.keys(), ...terminal.files.keys()].filter(p => p.endsWith('-retention.json'));
  if (retainedCalls.length !== journal.length) stop();
  const completion = json(join(root, 'completion.json'));
  assertExactFields(completion, ['schema', 'binding_sha256', 'calls', 'call_record_hashes', 'timing_record_hashes', 'result', 'scheduler_sha256', 'terminal_sha256'], 'submission_completion');
  if (completion.schema !== 'artifact_trusted_submission_completion_v1'
      || completion.binding_sha256 !== sha256CanonicalJson(binding) || completion.calls !== journal.length
      || completion.calls > binding.limits.max_calls || completion.scheduler_sha256 !== hash(scheduler.files.get('manifest.json'))
      || completion.terminal_sha256 !== hash(terminal.files.get('manifest.json'))
      || canonicalJson(completion.call_record_hashes) !== canonicalJson(journal.map(name => hash(read(join(root, name)))))
      || canonicalJson(completion.timing_record_hashes) !== canonicalJson(journal.map(name => hash(read(join(root, name.replace('call-', 'timing-')))))) ) stop();
  let sends = 0, last = 0, previousId = 0;
  for (const [i, name] of journal.entries()) {
    if (name !== `call-${String(i + 1).padStart(4, '0')}.json`) stop();
    const event = json(join(root, name));
    assertExactFields(event, ['schema', 'index', 'kind', 'request_id', 'request_sha256', 'elapsed_ms', 'timeout_ms', 'send_index'], 'submission_call');
    if (event.schema !== 'artifact_trusted_submission_call_v1' || event.index !== i + 1
        || !uint(event.elapsed_ms) || event.elapsed_ms < last || !uint(event.timeout_ms) || event.timeout_ms < 1
        || !uint(event.request_id) || event.request_id <= previousId
        || event.elapsed_ms + event.timeout_ms > binding.limits.overall_timeout_ms) stop();
    last = event.elapsed_ms; previousId = event.request_id;
    if (event.kind === 'send') sends++;
    if (event.send_index !== sends || sends > POLICY.maxClientSendAttempts) stop();
    const matches = [...scheduler.files, ...terminal.files].filter(([p, b]) => p.endsWith('-request-body.json')
      && hash(b) === event.request_sha256 && JSON.parse(b).id === event.request_id);
    if (matches.length !== 1) stop();
    const [path, body] = matches[0], decoded = JSON.parse(body);
    const files = scheduler.files.has(path) ? scheduler.files : terminal.files;
    const request = JSON.parse(files.get(path.replace('-request-body.json', '-request.json')));
    validateCallTiming(root, name, binding, request, JSON.parse(files.get(path.replace('-request-body.json', '-retention.json'))), access);
    if (request.timeout_ms !== event.timeout_ms || decoded.method !== {
      send: 'sendTransaction', status: 'getSignatureStatuses', blockHeight: 'getBlockHeight', transaction: 'getTransaction',
    }[event.kind]) stop();
  }

  const overall = JSON.parse(scheduler.files.get('overall-provenance.json'));
  if (overall.client_send_attempts !== sends || completion.result.classification !== terminalResult.classification
      || canonicalJson(completion.result) !== canonicalJson({ classification: terminalResult.classification,
        episode_id: binding.episode_id, ordinal: binding.ordinal, signed_intent_digest: binding.signed_intent_digest,
        economic_authority: 'NOT_PROMOTED' })) stop();
  const allowed = ['binding.json', 'signed-intent.json', 'completion.json', 'rebroadcast', 'terminal', ...journal,
    ...journal.map(name => name.replace('call-', 'timing-'))].sort();
  if (canonicalJson(readdirSync(root).sort()) !== canonicalJson(allowed)) stop();
  return cloneAndFreeze(completion.result);
}

export function createOfflineTrustedSubmissionV1(c, { authority, clock, submission }) {
  if (c.mandate.mandate_profile !== OFFLINE_WALLET_PROFILE_V1) stop();
  if (submission === undefined) return Object.freeze({ async submit() { throw Error('SUBMISSION_CONFIGURATION_NOT_APPROVED'); } });
  const { transport, sleep, finalization_source, ...values } = submission;
  const limits = cloneAndFreeze(values);
  assertExactFields(limits, ['profile', 'max_calls', 'overall_timeout_ms', 'max_response_bytes'], 'offline_submission_configuration');
  if (limits.profile !== PROFILE || typeof transport !== 'function' || typeof sleep !== 'function'
      || !uint(limits.max_calls) || limits.max_calls < 1 || limits.max_calls > 188
      || !uint(limits.overall_timeout_ms) || limits.overall_timeout_ms < 1 || limits.overall_timeout_ms > 190000
      || !uint(limits.max_response_bytes) || limits.max_response_bytes < 1 || limits.max_response_bytes > 1048576) stop();
  return Object.freeze({ async submit(ordinal) {
    if (![1, 2].includes(ordinal)) stop();
    const x = await inputFor(c, authority, ordinal), root = join(c.state_root, `submission-${ordinal}`);
    const binding = bindingFor(c, x, limits);
    if (x.row.stage !== 'SIGNED_INTENT_DURABLE') {
      try { return validateRetainedSubmissionEvidenceV1({ root, expected_binding: binding }); }
      catch { return unresolved(x); }
    }
    // This existing SQLite transition is the only submission owner election.
    // Losing/crashed/restarted invocations never receive a renewed call budget.
    try { await authority.recordSubmissionPossibleV1({ episode_id: x.episode_id, ordinal,
      signed_intent_digest: x.row.signed_intent_digest, signed_wire_sha256: x.row.signed_wire_sha256 }); }
    catch { return unresolved(x); }
    try {
      mkdirSync(root, { mode: 0o700 }); syncDirectory(c.state_root);
      persist(root, 'binding.json', binding); persist(root, 'signed-intent.json', x.signed);
      const origin = clock.monotonicMs(); let last = origin, calls = 0, sends = 0, closed = false;
      if (!uint(origin)) stop();
      let acknowledgmentOrigin = null, captureAcknowledgmentOrigin = false;
      let resolutionOrigin = null, captureResolutionOrigin = false;
      let overallTimer; const controllers = new Set();
      const retiredRequests = new Set(), activeRequests = new Map();
      const guard = () => { if (closed) stop(); };
      const observeRetention = (path, bytes) => {
        if (path?.endsWith('-retention.json')) {
          const retained = JSON.parse(bytes);
          if (!retained.body_present) {
            retiredRequests.add(retained.request_id);
            activeRequests.get(retained.request_id)?.();
          }
        }
      };
      // The pinned scheduler reads its origin immediately after retaining r1.
      // Observe that exact clock read; do not start a competing schedule clock.
      const evidence = port(join(root, 'rebroadcast'), guard, (path, bytes) => {
        observeRetention(path, bytes);
        if (path === 'send-attempt-0001/result.json' && JSON.parse(bytes).send_outcome === 'ACK_MATCH') {
          captureAcknowledgmentOrigin = true;
        }
      }), terminalEvidence = port(join(root, 'terminal'), guard, (path, bytes) => {
        observeRetention(path, bytes);
        if (path === null) captureResolutionOrigin = true;
      });
      function now() {
        guard();
        const n = clock.monotonicMs();
        if (!uint(n) || n < last) stop(); last = n;
        if (captureAcknowledgmentOrigin) { acknowledgmentOrigin = n; captureAcknowledgmentOrigin = false; }
        if (captureResolutionOrigin) { resolutionOrigin = n; captureResolutionOrigin = false; }
        return n;
      }
      async function boundedTransport(request) {
        if (closed) stop();
        const current = await authority.inspectEpisodeV1({ episode_id: x.episode_id });
        const wire = await authority.readRetainedWireV1({ episode_id: x.episode_id, ordinal });
        if (retiredRequests.has(request.id)) stop();
        if (!wire.equals(x.wire) || (request.kind === 'send' && (current.revoked || sends >= POLICY.maxClientSendAttempts))) stop();
        if (calls >= limits.max_calls || now() - origin + request.options.timeoutMs > limits.overall_timeout_ms
            || clock.unixSeconds() >= c.deadline_unix_seconds) stop();
        if (request.kind === 'send') sends++;
        calls++;
        const elapsed = now() - origin;
        persist(root, `call-${String(calls).padStart(4, '0')}.json`, {
          schema: 'artifact_trusted_submission_call_v1', index: calls, kind: request.kind, request_id: request.id,
          request_sha256: hash(request.requestBody), elapsed_ms: elapsed, timeout_ms: request.options.timeoutMs, send_index: sends });
        const controller = new AbortController(); let timer;
        controllers.add(controller);
        let dispatchedAt = null, dispatchedWall = null, deadline, outcomeWritten = false;
        const index = calls;
        const timing = {
          schema: 'artifact_trusted_submission_call_timing_v1', request_id: request.id,
          call_sha256: hash(read(join(root, `call-${String(index).padStart(4, '0')}.json`))),
          request_ordinal: request.ordinal,
          acknowledgment_origin_ms: acknowledgmentOrigin === null ? null : acknowledgmentOrigin - origin,
          resolution_origin_ms: resolutionOrigin === null ? null : resolutionOrigin - origin,
        };
        const outcome = (disposition, at, wall, late_response = null) => {
          guard();
          persist(root, `timing-${String(index).padStart(4, '0')}.json`, { ...timing, disposition,
            dispatch_ms: dispatchedAt === null ? null : dispatchedAt - origin, dispatch_unix_seconds: dispatchedWall,
            observed_ms: at - origin, observed_unix_seconds: wall, late_response });
          outcomeWritten = true;
        };
        const wallNow = () => { const wall = clock.unixSeconds(); if (!uint(wall)) stop(); return wall; };
        // The scheduler's outer timeout may win first. Retire the invocation
        // before its next call; a late settlement cannot write or be accepted.
        activeRequests.set(request.id, () => {
          controller.abort();
          if (!outcomeWritten && !closed) outcome('TRANSPORT_ERROR', now(), wallNow());
        });
        try {
          const externalRequest = Object.freeze({ ...request, expectedSignature: x.row.transaction_signature,
            signal: controller.signal });
          const invoke = () => {
            if (retiredRequests.has(request.id)) stop();
            const wall = wallNow();
            const checked = now();
            if (wall >= c.deadline_unix_seconds
                || checked - origin + request.options.timeoutMs > limits.overall_timeout_ms
                || (request.ordinal >= 1000 && (resolutionOrigin === null
                  || checked - resolutionOrigin + request.options.timeoutMs > POLICY.resolutionDeadlineMs))
                || (request.ordinal > 1 && request.ordinal <= 3
                && (acknowledgmentOrigin === null
                  || checked - acknowledgmentOrigin < POLICY.ordinalWindowsMs[request.ordinal - 2][0]
                  || checked - acknowledgmentOrigin >= POLICY.ordinalWindowsMs[request.ordinal - 2][1]))) {
              outcome('NOT_DISPATCHED_DEADLINE', checked, wall);
              stop();
            }
            dispatchedAt = checked; dispatchedWall = wall; deadline = checked + request.options.timeoutMs;
            // No await, persistence, or promise turn between this check and effect.
            return transport(externalRequest);
          };
          const result = await Promise.race([
            Promise.resolve().then(invoke),
            new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('SUBMISSION_TIMEOUT')); }, request.options.timeoutMs); }),
          ]);
          const wall = wallNow(), observed = now();
          if (retiredRequests.has(request.id)) stop();
          if (!result || !Buffer.isBuffer(result.body) || result.body.length > limits.max_response_bytes) stop();
          if (observed >= deadline || observed - origin >= limits.overall_timeout_ms
              || wall < dispatchedWall || wall >= c.deadline_unix_seconds
              || (request.ordinal >= 1000 && observed - resolutionOrigin >= POLICY.resolutionDeadlineMs)) {
            outcome('LATE_RESPONSE', observed, wall, { status: result.status, body_base64: result.body.toString('base64') });
            stop();
          }
          outcome('ACCEPTED', observed, wall);
          return { status: result.status, body: Buffer.from(result.body) };
        } catch {
          if (!outcomeWritten && !closed) outcome('TRANSPORT_ERROR', now(), wallNow());
          stop();
        } finally { clearTimeout(timer); controller.abort(); controllers.delete(controller); activeRequests.delete(request.id); }
      }
      let output;
      try {
        output = await Promise.race([runBoundedRebroadcast({ intent: x.intent, signedTransactionBase64: x.wire.toString('base64'),
          endpoint: 'OFFLINE_INJECTED_PRIMARY_SOLANA_RPC', clock: { now, sleep: async ms => {
            if (now() - origin + ms >= limits.overall_timeout_ms) stop(); await sleep(ms); now();
          } }, transport: boundedTransport, evidence, terminalEvidence }),
        new Promise((_, reject) => { overallTimer = setTimeout(() => {
          closed = true; for (const controller of controllers) controller.abort();
          reject(Error('SUBMISSION_OVERALL_DEADLINE'));
        }, limits.overall_timeout_ms); })]);
      } finally { closed = true; clearTimeout(overallTimer); }
      const result = { classification: output.resolution.classification, episode_id: x.episode_id, ordinal,
        signed_intent_digest: x.row.signed_intent_digest, economic_authority: 'NOT_PROMOTED' };
      persist(root, 'completion.json', { schema: 'artifact_trusted_submission_completion_v1',
        binding_sha256: sha256CanonicalJson(binding), calls, result,
        call_record_hashes: Array.from({ length: calls }, (_, i) => hash(read(join(root, `call-${String(i + 1).padStart(4, '0')}.json`)))),
        timing_record_hashes: Array.from({ length: calls }, (_, i) => hash(read(join(root, `timing-${String(i + 1).padStart(4, '0')}.json`)))),
        scheduler_sha256: hash(evidence.list().files.get('manifest.json')),
        terminal_sha256: hash(terminalEvidence.list().files.get('manifest.json')) });
      return validateRetainedSubmissionEvidenceV1({ root, expected_binding: binding });
    } catch {
      const result = unresolved(x);
      // Best-effort diagnostic closure cannot turn uncertain storage into proof
      // of non-transmission. The previously committed SQLite consumption remains
      // authoritative even when this write fails or the process is killed.
      try { persist(root, 'unresolved-outcome.json', { schema: 'artifact_trusted_submission_unresolved_v1',
        binding_sha256: sha256CanonicalJson(binding), schedule_consumed: true, result }); } catch { /* preserve partial evidence */ }
      return result;
    }
  }, async finalize(ordinal) {
    if (![1, 2].includes(ordinal)) stop();
    const x = await inputFor(c, authority, ordinal), root = join(c.state_root, `submission-${ordinal}`);
    // Reconciliation is independent of complete transmission provenance: a
    // withheld rebroadcast after revocation must not erase actual finality.
    // This does NOT bless an incomplete scheduler journal or permit another send.
    const binding = json(join(root, 'binding.json'));
    if (canonicalJson(binding) !== canonicalJson(bindingFor(c, x, limits))
        || canonicalJson(json(join(root, 'signed-intent.json'))) !== canonicalJson(x.signed)) stop();
    const terminalSnapshot = snapshot(join(root, 'terminal'));
    const result = validateTerminal(terminalSnapshot, x.intent);
    // Even the independent terminal-only recovery path must verify timing custody.
    const journal = readdirSync(root).filter(p => /^call-[0-9]{4}\.json$/.test(p));
    for (const [path, body] of terminalSnapshot.files) {
      if (!path.endsWith('-request-body.json')) continue;
      const matches = journal.filter(name => json(join(root, name)).request_sha256 === hash(body));
      if (matches.length !== 1) stop();
      const request = JSON.parse(terminalSnapshot.files.get(path.replace('-request-body.json', '-request.json')));
      validateCallTiming(root, matches[0], binding, request,
        JSON.parse(terminalSnapshot.files.get(path.replace('-request-body.json', '-retention.json'))));
    }
    if (result.classification !== 'FINALIZED_SUCCESS') stop();
    const terminal = JSON.parse(read(join(root, 'terminal', 'finalized-transaction-raw-response.json'))).result;
    return closeTrustedTerminalSourceV1({ c, authority, x, terminal, capture: finalization_source,
      retain: async record => {
        const name = `economic-evidence-${sha256CanonicalJson(record)}.json`;
        try { persist(c.state_root, name, record); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!read(join(c.state_root, name), 4194304, true).equals(Buffer.from(canonicalJson(record)))) stop();
          syncDirectory(c.state_root);
        }
      } });
  } });
}
