// Separate human-custody endpoint. No controller peer, key access or signing API.
import { pathToFileURL } from 'node:url';
import { assertExactFields } from '../../src/verification-scope-v1-3/contract.mjs';
import { validateHumanRevocationV1 } from '../../src/verification-scope-v1-3/final-proof-agent/human-revocation-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from '../../src/verification-scope-v1-3/final-proof-agent/human-authorization-v1.mjs';
import { parseCanonicalV1, blocked } from './io.mjs';
import { readEnvelopeV1, writeFrameV1 } from './supervisor.mjs';
import { framesV2, oneFrameV2, sendEnvelopeV2, publicContextV2, fixedStreamV2 } from './control-client-v2.mjs';

export async function runHumanClientV2(p) {
  const timeout = p.timeout_ms ?? 600000;
  validateHumanEpisodeAuthorizationV1(p.authorization, {mandate:p.mandate});
  let current, pump, contextLost = false;
  const admission = new AbortController(), reader = framesV2(p.context, timeout);
  const accept = async value => {
    assertExactFields(value, ['version', 'episode_id', 'mandate_digest', 'authorization_digest', 'human_public_key',
      'predecessor_state', 'predecessor_state_digest'], 'human_context');
    if (value.version !== 'artifact_private_human_context_v1'
      || value.mandate_digest !== p.mandate.mandate_digest
      || value.authorization_digest !== p.authorization.authorization_digest
      || value.human_public_key !== p.authorization.human_public_key
      || value.episode_id !== `bounded-agent-episode-${p.authorization.authorization_digest}`
      || !/^[a-f0-9]{64}$/.test(value.predecessor_state_digest)
      || typeof value.predecessor_state !== 'string') throw blocked();
    current = value;
    await writeFrameV1(p.custody, {kind:'HUMAN_CONTEXT', value});
  };
  try {
    const first = await reader.next(); if (first.done) throw blocked();
    await accept(first.value);
    pump = (async () => {
      try { for await (const value of reader) await accept(value); }
      finally { contextLost = true; admission.abort(); }
    })();
    pump.catch(() => {});
    const bytes = await readEnvelopeV1(p.envelope, timeout, admission.signal);
    if (contextLost) throw blocked();
    const envelope = parseCanonicalV1(bytes);
    validateHumanRevocationV1(envelope); // existing canonical/domain Ed25519 verifier
    if (envelope.mandate_digest !== p.mandate.mandate_digest
      || envelope.authorization_digest !== p.authorization.authorization_digest
      || envelope.human_public_key !== p.authorization.human_public_key
      || envelope.episode_id !== current.episode_id
      || envelope.predecessor_state !== current.predecessor_state
      || envelope.predecessor_state_digest !== current.predecessor_state_digest) throw blocked();
    // Runtime revalidates the exact predecessor atomically; a race never re-signs.
    await sendEnvelopeV2(p.revoke, bytes);
    const acknowledgment = await oneFrameV2(p.acknowledgment, timeout);
    if (acknowledgment.status === 'REVOCATION_DURABLE') {
      assertExactFields(acknowledgment, ['status', 'revocation_result', 'state'], 'human_ack');
      if (!['REVOKED', 'ALREADY_REVOKED', 'REVOCATION_RECORDED_SIGNING_AMBIGUOUS', 'REVOKED_SIGNED_BYTES_DURABLE'].includes(acknowledgment.revocation_result)
        || typeof acknowledgment.state !== 'string') throw blocked();
    } else {
      assertExactFields(acknowledgment, ['status', 'recovery'], 'human_non_ack');
      if (acknowledgment.status !== 'NOT_ACKNOWLEDGED' || acknowledgment.recovery !== 'STOP_NO_REPLACEMENT') throw blocked();
    }
    await writeFrameV1(p.custody, {kind:'HUMAN_ACKNOWLEDGMENT', value:acknowledgment});
    return acknowledgment;
  } finally {
    admission.abort(); p.context.destroy(); p.envelope.destroy();
    if (pump) await pump.catch(() => {}); else await reader.return();
    p.revoke.destroy();
  }
}
export async function humanMainV2() {
  requireHumanActivationV2();
  if (process.argv.length !== 2 || process.execArgv.length !== 1
    || process.execArgv[0] !== '--openssl-config=/opt/artifact/release/engine/deployment/private-binding/openssl.cnf') throw blocked();
  const context = publicContextV2(), opened = [];
  const stream = (fd, reading) => { const s = fixedStreamV2(fd, reading); opened.push(s); return s; };
  try {
    return await runHumanClientV2({...context, revoke:stream(12,false), context:stream(13,true), acknowledgment:stream(14,true),
      envelope:stream(16,true), custody:stream(17,false)});
  } finally { opened.forEach(s => s.destroy()); }
}
export function requireHumanActivationV2() { throw Error('PRIVATE_HUMAN_V2_DISABLED_NO_EFFECTS'); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await humanMainV2(); }
  catch { process.stderr.write('HUMAN_CUSTODY_STOP_NO_REPLACEMENT\n'); process.exitCode = 1; }
}
