// Custody-side relay, not a signer. It never loads a key, wallet, transport or command.
import { pathToFileURL } from 'node:url';
import { Socket } from 'node:net';
import { closeSync } from 'node:fs';
import { canonicalJson, assertExactFields } from '../../src/verification-scope-v1-3/contract.mjs';
import { validateAuthenticatedAgentDecisionV1 } from '../../src/verification-scope-v1-3/final-proof-agent/agent-decision-v1.mjs';
import { validateReadinessChallengeV1 } from '../../src/verification-scope-v1-3/final-proof-agent/readiness-challenge-v1.mjs';
import { readEnvelopeV1, writeFrameV1 } from './supervisor.mjs';
import { parseCanonicalV1, readBoundedFdV1, blocked } from './io.mjs';

// Frames are pretty canonical JSON + separator LF, NOT one JSON document per line.
export async function* framesV2(input, timeout_ms = 600000) {
  let pending = Buffer.alloc(0), count = 0;
  input.on('error', () => {});
  const timer = setTimeout(() => input.destroy(blocked()), timeout_ms);
  try {
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk)) throw blocked();
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        if (end + 2 > 131073 || ++count > 32) throw blocked();
        const value = parseCanonicalV1(pending.subarray(0, end + 1));
        pending = pending.subarray(end + 2);
        yield value;
      }
      if (pending.length > 131073) throw blocked();
    }
    if (pending.length) throw blocked();
  } finally { clearTimeout(timer); input.destroy(); }
}
export async function oneFrameV2(input, timeout_ms) {
  const reader = framesV2(input, timeout_ms);
  try { const frame = await reader.next(); if (frame.done) throw blocked(); return frame.value; }
  finally { await reader.return(); }
}
export async function sendEnvelopeV2(output, bytes, timeout_ms = 1000) {
  // Canonical envelope has ONE terminal LF. Do not turn it into an output frame.
  parseCanonicalV1(bytes);
  output.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { output.destroy(); reject(blocked()); }, timeout_ms);
    const failed = () => { clearTimeout(timer); reject(blocked()); };
    output.once('error', failed);
    output.end(bytes, () => { clearTimeout(timer); output.removeListener('error', failed); resolve(); });
  });
}
export async function runControlClientV2(p) {
  const timeout = p.timeout_ms ?? 60000;
  // This sequence is source-fixed. No operation, path, phase or transport JSON.
  for (const [ordinal, phase, challengeInput, envelopeInput, decisionOutput, resultInput] of [
    [1, 'ACQUISITION', p.acquisitionChallenge, p.acquisitionEnvelope, p.acquisition, p.acquisitionResult],
    [2, 'DISPOSAL', p.disposalChallenge, p.disposalEnvelope, p.disposal, p.disposalResult],
  ]) {
    const challenge = await oneFrameV2(challengeInput, timeout);
    validateReadinessChallengeV1(challenge);
    if (challenge.ordinal !== ordinal || challenge.phase !== phase
      || challenge.authorization_digest !== p.authorization.authorization_digest
      || challenge.mandate_digest !== p.mandate.mandate_digest) throw blocked();
    await writeFrameV1(p.custody, {kind: `${phase}_CHALLENGE`, value: challenge});
    const bytes = await readEnvelopeV1(envelopeInput, timeout);
    const decision = parseCanonicalV1(bytes);
    validateAuthenticatedAgentDecisionV1(decision, {mandate:p.mandate, authorization:p.authorization, challenge});
    await sendEnvelopeV2(decisionOutput, bytes);
    const result = await oneFrameV2(resultInput, timeout);
    assertExactFields(result, ['status', 'episode_id', 'signed_intent_digest'], 'host_result');
    if (!['REFUSED', 'SIGNED_INTENT_DURABLE'].includes(result.status) || result.episode_id !== challenge.episode_id
      || (result.status === 'REFUSED' ? result.signed_intent_digest !== null : !/^[a-f0-9]{64}$/.test(result.signed_intent_digest))) throw blocked();
    await writeFrameV1(p.custody, {kind: `${phase}_RESULT`, value: result});
    if (result.status === 'REFUSED') return 'REFUSED';
  }
  return 'CONTROL_DELIVERED_NOT_EXECUTION_ATTESTATION';
}
export function fixedStreamV2(fd, reading) { return new Socket({fd, readable:reading, writable:!reading}); }
export function publicContextV2() {
  try { return parseCanonicalV1(readBoundedFdV1(3, 262144, 0, false)).runtime; }
  finally { closeSync(3); }
}
export async function controlMainV2() {
  requireControlActivationV2();
  if (process.argv.length !== 2 || process.execArgv.length !== 1
    || process.execArgv[0] !== '--openssl-config=/opt/artifact/release/engine/deployment/private-binding/openssl.cnf') throw blocked();
  const context = publicContextV2(), opened = [];
  const stream = (fd, reading) => { const s = fixedStreamV2(fd, reading); opened.push(s); return s; };
  try {
    return await runControlClientV2({...context, acquisition:stream(6,false), acquisitionChallenge:stream(7,true), acquisitionResult:stream(8,true),
      disposal:stream(9,false), disposalChallenge:stream(10,true), disposalResult:stream(11,true),
      acquisitionEnvelope:stream(16,true), disposalEnvelope:stream(17,true), custody:stream(18,false)});
  } finally { opened.forEach(s => s.destroy()); }
}
export function requireControlActivationV2() { throw Error('PRIVATE_CONTROL_V2_DISABLED_NO_EFFECTS'); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await controlMainV2(); }
  catch { process.stderr.write('CONTROL_CUSTODY_STOP_NO_REPLACEMENT\n'); process.exitCode = 1; }
}
