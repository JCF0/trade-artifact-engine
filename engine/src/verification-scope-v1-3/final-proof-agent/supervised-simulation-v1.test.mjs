import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../contract.mjs';
import { buildFixedTestMandateV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { buildOrcaMessageBoundaryV1 } from './orca-message-boundary-v1.mjs';
import { simulateExactPreparedMessageV1 } from './supervised-simulation-v1.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function input() {
  const plan = buildOrcaMessageBoundaryV1({ mandate: buildFixedTestMandateV1(), phase: 'ACQUISITION', ordinal: 1,
    input_raw_quantity: '5000000', retained_acquisition_jup_raw: null, blockhash: '11111111111111111111111111111111',
    tick_spacing: 64, tick_current_index: 0, quoted_output_raw: '10000000', minimum_output_raw: '9950000', fee_lamports: '5000' });
  const calls = [], records = [], time = { now: 1900000000 };
  const response = { context: { slot: 100 }, value: { err: null, unitsConsumed: 100, logs: [] } };
  return { calls, records, time, response, args: { message: Buffer.from(plan.message_base64, 'base64'),
    expected_message_sha256: plan.message_sha256, minimum_context_slot: 100,
    challenge: { ordinal: 1, challenge_digest: 'a'.repeat(64), expires_at_unix_seconds: 1900000010 },
    clock: { monotonicMs: () => 0, unixSeconds: () => time.now }, assertFresh: async () => {
      if (time.now >= 1900000010) throw Error('stale'); }, retain: async v => { records.push(v); },
    rpc: async ({ body }) => { calls.push(body); return JSON.stringify({ jsonrpc: '2.0', id: body.id, result: response }); } } };
}
test('unsigned exact message simulation binds the actual canonical RPC request and remains distinct from signature/finality', async () => {
  const f = input(), result = await simulateExactPreparedMessageV1(f.args);
  assert.equal(result.request_sha256, hash(canonicalJson(f.calls[0])));
  assert.equal(result.message_sha256, f.args.expected_message_sha256);
  assert.equal(result.signature_verification, 'NOT_PERFORMED_UNSIGNED');
  assert.equal(result.finalized_occurrence, 'NOT_ESTABLISHED');
  assert.equal(f.calls[0].params[1].replaceRecentBlockhash, false);
  assert.ok(Buffer.from(f.calls[0].params[0], 'base64').subarray(1, 65).every(v => v === 0));
});
test('simulation mismatch, failure, stale context and stale completion prevent success', async () => {
  for (const mutate of [f => { f.args.message[0] ^= 1; }, f => { f.response.value.err = 'BlockhashNotFound'; },
    f => { f.response.context.slot = 99; }, f => { f.response.value.unitsConsumed = null; },
    f => { f.response.value.replacementBlockhash = { blockhash: 'replacement' }; },
    f => { const rpc = f.args.rpc; f.args.rpc = async r => { const result = await rpc(r); f.time.now += 10; return result; }; }]) {
    const f = input(); mutate(f); await assert.rejects(simulateExactPreparedMessageV1(f.args)); assert.equal(f.records.length, 0);
  }
});
