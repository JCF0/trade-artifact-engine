import { canonicalJson, assertExactFields } from '../../src/verification-scope-v1-3/contract.mjs';
import { performance } from 'node:perf_hooks';
import { blocked } from './io.mjs';

export async function readEnvelopeV1(input, timeout_ms, signal) {
  const chunks = []; let size = 0, timer;
  const deadline = performance.now() + timeout_ms;
  const abort = () => input.destroy(blocked());
  input.on('error', () => {});
  if (signal?.aborted) throw blocked();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    timer = setTimeout(abort, timeout_ms);
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk) || chunk.length > 131072 - size || performance.now() >= deadline || signal?.aborted) throw blocked();
      chunks.push(Buffer.from(chunk)); size += chunk.length;
    }
    if (!size || performance.now() >= deadline || signal?.aborted) throw blocked();
    return Buffer.concat(chunks, size);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); input.destroy(); }
}
export function writeFrameV1(output, value, timeout_ms = 1000) {
  const bytes = Buffer.from(canonicalJson(value) + '\n');
  if (bytes.length > 131073) return Promise.reject(blocked());
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer);
      output.removeListener('error', failed); error ? reject(blocked()) : resolve(); };
    const failed = () => finish(true);
    // Retain a safe listener even on a late EPIPE after the bounded acknowledgment.
    output.on('error', () => {}); output.once('error', failed);
    const timer = setTimeout(() => { finish(true); output.destroy(); }, timeout_ms);
    try { output.write(bytes, error => finish(Boolean(error))); } catch { finish(true); }
  });
}

// Trusted worker-only orchestration. This function is never given to Hermes.
// No caller operation selector: the only execution order is ordinal 1 then 2.
// Ports and callbacks are fixed by composition, not deserialized controller data.
export async function runFiniteEpisodeV1({ runtime, channels, humanContext, publish,
  decision_timeout_ms, episode_timeout_ms, stopExchange = () => {} }) {
  if (!Number.isSafeInteger(decision_timeout_ms) || decision_timeout_ms < 1 || decision_timeout_ms > 60000
    || !Number.isSafeInteger(episode_timeout_ms) || episode_timeout_ms < 1 || episode_timeout_ms > 600000) throw blocked();
  const admission = new AbortController(), humanWait = new AbortController();
  let stopped = false, expired = false, ordinal = 1, contextBusy = false, previousContext = null, contextCount = 0;
  let exportIdentity = null, outcome = 'STOPPED', started = false;
  let contextTask = Promise.resolve();
  const stop = () => { stopped = true; admission.abort(); };
  const expiry = setTimeout(() => { expired = true; stop(); stopExchange(); humanWait.abort(); }, episode_timeout_ms);
  async function sendContext() {
    if (contextBusy || humanWait.signal.aborted) return;
    contextBusy = true;
    try {
      const value = await humanContext(), encoded = canonicalJson(value);
      if (encoded !== previousContext) {
        if (++contextCount > 32) throw blocked();
        await writeFrameV1(channels.context, value); previousContext = encoded;
      }
    } catch { stop(); } finally { contextBusy = false; }
  }
  const poll = setInterval(() => { if (!contextBusy) contextTask = sendContext(); }, 100);
  // Start human input immediately, not after a readiness/decision/sign/send await.
  const human = (async () => {
    try {
      const bytes = await readEnvelopeV1(channels.human, episode_timeout_ms, humanWait.signal);
      const durable = await runtime.supervisor.revokeAuthenticatedBytesV1(bytes);
      if (!['REVOKED', 'ALREADY_REVOKED', 'REVOCATION_RECORDED_SIGNING_AMBIGUOUS', 'REVOKED_SIGNED_BYTES_DURABLE'].includes(durable.revocation_result)) throw blocked();
      stop();
      // The runtime returns only after authority commit AND wrapper retention.
      await writeFrameV1(channels.acknowledgment, { status: 'REVOCATION_DURABLE',
        revocation_result: durable.revocation_result, state: durable.episode_state.state });
    } catch {
      if (!humanWait.signal.aborted) {
        stop();
        try { await writeFrameV1(channels.acknowledgment, { status: 'NOT_ACKNOWLEDGED', recovery: 'STOP_NO_REPLACEMENT' }); } catch { /* custody loss remains STOP */ }
      }
    }
  })();
  try {
    await sendContext();
    for (ordinal = 1; ordinal <= 2; ordinal++) {
      if (stopped) break;
      const challenge = await runtime.supervisor.issueReadinessChallengeV1(ordinal === 1 ? 'ACQUISITION' : 'DISPOSAL');
      started = true;
      if (stopped) break;
      const input = ordinal === 1 ? channels.acquisition : channels.disposal;
      const output = ordinal === 1 ? channels.result1 : channels.result2;
      await writeFrameV1(ordinal === 1 ? channels.challenge1 : channels.challenge2, challenge);
      const bytes = await readEnvelopeV1(input, decision_timeout_ms, admission.signal);
      if (stopped) break;
      const result = await runtime.agent.submitDecisionBytesV1(bytes);
      assertExactFields(result, ['status', 'episode_id', 'signed_intent_digest'], 'private_decision_result');
      if (!['REFUSED', 'SIGNED_INTENT_DURABLE'].includes(result.status)) throw blocked();
      await writeFrameV1(output, result);
      if (stopped || result.status === 'REFUSED') break;
      const submitted = await runtime.trusted.submitRetainedIntentV1(ordinal);
      if (submitted.classification !== 'FINALIZED_SUCCESS') break;
      // Revocation after dispatch does not erase observed occurrence; the existing
      // finalizer reconciles it. No next signing/submission starts after STOP.
      await runtime.trusted.finalizeRetainedIntentV1(ordinal);
      await sendContext();
      if (stopped) break;
      if (ordinal === 2) { outcome = 'EPISODE_CLOSED'; break; }
    }
  } catch { stop(); }
  finally {
    stop();
    // Close revocation admission before the final custody snapshot. An envelope
    // already at EOF gets one event-loop drain; an already-authenticating request
    // must finish its durable wrapper/ack before export. Lost partial input is STOP.
    await new Promise(setImmediate);
    humanWait.abort(); await human;
    clearInterval(poll); await contextTask;
    if (started && !expired) {
      try {
        await runtime.trusted.captureRetainedOutcomeSourceV1(ordinal);
        const descriptor = await publish(ordinal);
        exportIdentity = descriptor.expected_manifest_sha256;
      } catch { exportIdentity = null; }
    }
    clearTimeout(expiry);
    channels.acquisition.destroy(); channels.disposal.destroy(); channels.human.destroy();
  }
  const result = Object.freeze({ status: expired ? 'STOPPED' : outcome,
    evidence: exportIdentity === null ? 'INCOMPLETE_PRESERVE_PRIVATE_ROOT' : 'DURABLE_PACKAGE',
    manifest_sha256: exportIdentity, recovery: 'SUPERVISOR_RECONCILIATION_ONLY_NO_REPLACEMENT' });
  await writeFrameV1(channels.result, result);
  return result;
}
