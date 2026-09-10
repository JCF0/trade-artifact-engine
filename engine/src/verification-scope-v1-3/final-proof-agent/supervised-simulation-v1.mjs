import { createHash } from 'node:crypto';
import { Message, Transaction } from '@solana/web3.js';
import { assertExactFields, canonicalJson, cloneAndFreeze, sha256CanonicalJson } from '../contract.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
function stop() { throw Error('SUPERVISED_EXACT_MESSAGE_SIMULATION_INVALID'); }
// No key loading, signing, blockhash replacement, transaction rebuilding or retry.
export async function simulateExactPreparedMessageV1({ message, expected_message_sha256, minimum_context_slot,
  challenge, rpc, clock, assertFresh, retain }) {
  const bytes = Buffer.from(message);
  if (hash(bytes) !== expected_message_sha256 || !Number.isSafeInteger(minimum_context_slot) || minimum_context_slot < 0) stop();
  const parsed = Message.from(bytes);
  if (!parsed.serialize().equals(bytes) || parsed.header.numRequiredSignatures !== 1) stop();
  const transaction = Transaction.populate(parsed);
  const wire = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (!transaction.serializeMessage().equals(bytes) || wire[0] !== 1 || wire.subarray(1, 65).some(b => b !== 0)) stop();
  await assertFresh();
  const started = clock.monotonicMs(), issued = clock.unixSeconds();
  if (issued >= challenge.expires_at_unix_seconds) stop();
  const request = { jsonrpc: '2.0', id: `simulation-${challenge.ordinal}`, method: 'simulateTransaction', params: [wire.toString('base64'),
    { encoding: 'base64', commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot: minimum_context_slot }] };
  const raw = await rpc({ body: request });
  let response;
  try { response = JSON.parse(raw, (key, value) => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || Object.is(value, -0))) stop();
    return value;
  }); } catch { stop(); }
  assertExactFields(response, ['jsonrpc', 'id', 'result'], 'simulation_response');
  if (response.jsonrpc !== '2.0' || response.id !== request.id) stop();
  const r = response.result;
  assertExactFields(r, ['context', 'value'], 'simulation_result');
  if (!Number.isSafeInteger(r.context?.slot) || r.context.slot < minimum_context_slot || r.value?.err !== null
    || !Number.isSafeInteger(r.value.unitsConsumed) || r.value.unitsConsumed < 0
    || !Array.isArray(r.value.logs) || r.value.logs.some(v => typeof v !== 'string')
    || (r.value.replacementBlockhash !== undefined && r.value.replacementBlockhash !== null)) stop();
  await assertFresh();
  if (clock.unixSeconds() >= challenge.expires_at_unix_seconds || clock.monotonicMs() < started) stop();
  const facts = { version: 'artifact_unsigned_exact_message_simulation_v1', challenge_digest: challenge.challenge_digest,
    message_sha256: hash(bytes), unsigned_wire_sha256: hash(wire), request_sha256: hash(Buffer.from(canonicalJson(request))),
    response_sha256: hash(Buffer.from(raw)), context_slot: r.context.slot, minimum_context_slot,
    started_unix_seconds: issued, completed_unix_seconds: clock.unixSeconds(), started_monotonic_ms: started,
    completed_monotonic_ms: clock.monotonicMs(), execution_simulation: 'SUCCEEDED', signature_verification: 'NOT_PERFORMED_UNSIGNED',
    finalized_occurrence: 'NOT_ESTABLISHED', blockhash_replacement: false };
  const evidence = cloneAndFreeze({ ...facts, simulation_digest: sha256CanonicalJson(facts) });
  await retain(evidence);
  await assertFresh();
  return evidence;
}
