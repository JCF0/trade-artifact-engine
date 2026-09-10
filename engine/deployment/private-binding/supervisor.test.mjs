import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
const url = new URL('./supervisor.mjs', import.meta.url);
const candidate = existsSync(url) ? await import(url) : {};
test('finite supervisor services separate durable human revocation while controller EOF is withheld', async () => {
  assert.equal(typeof candidate.runFiniteEpisodeV1, 'function', 'missing finite independent channels');
  const ports = Array.from({ length: 10 }, () => new PassThrough());
  const [acquisition, challenge1, result1, disposal, challenge2, result2, human, context, acknowledgment, result] = ports;
  let revocations = 0, decisions = 0, sends = 0;
  const runtime = { agent: { async submitDecisionBytesV1() { decisions++; throw Error('not allowed'); } },
    supervisor: { async issueReadinessChallengeV1() { return { challenge: 'synthetic' }; },
      async revokeAuthenticatedBytesV1(bytes) { assert.equal(bytes.toString(), 'synthetic-human-envelope'); revocations++;
        return { revocation_result: 'REVOKED', episode_state: { state: 'REVOKED_BEFORE_ACQUISITION' } }; } },
    trusted: { async submitRetainedIntentV1() { sends++; }, async captureRetainedOutcomeSourceV1() { throw Error('incomplete'); } } };
  const work = candidate.runFiniteEpisodeV1({ runtime, channels: { acquisition, challenge1, result1, disposal, challenge2, result2,
    human, context, acknowledgment, result }, decision_timeout_ms: 100, episode_timeout_ms: 300,
    humanContext: async () => ({ version: 'synthetic-context', predecessor_state: 'AUTHORIZED' }), publish: async () => {} });
  human.end(Buffer.from('synthetic-human-envelope'));
  let ack = ''; acknowledgment.on('data', b => { ack += b; });
  const output = await work;
  assert.equal(revocations, 1); assert.equal(decisions, 0); assert.equal(sends, 0);
  assert.equal(JSON.parse(ack).status, 'REVOCATION_DURABLE'); assert.equal(output.status, 'STOPPED');
  ports.forEach(p => p.destroy());
});
test('already-delivered revocation settles before the final package snapshot', async () => {
  const channels = Object.fromEntries(['acquisition', 'challenge1', 'result1', 'disposal', 'challenge2', 'result2', 'human', 'context', 'acknowledgment', 'result'].map(k => [k, new PassThrough()]));
  let durable = false, sawHuman = false;
  channels.acquisition.end(Buffer.from('fixture-only-decision'));
  channels.result1.on('data', () => channels.human.end(Buffer.from('fixture-only-envelope')));
  const runtime = { supervisor: {
    issueReadinessChallengeV1: async () => ({ fixture: true }),
    revokeAuthenticatedBytesV1: async () => { sawHuman = true; await new Promise(r => setTimeout(r, 50)); durable = true;
      return { revocation_result: 'REVOKED', episode_state: { state: 'HUMAN_REVOKED' } }; },
  }, agent: { submitDecisionBytesV1: async () => ({ status: 'REFUSED', episode_id: 'fixture', signed_intent_digest: null }) },
  trusted: { captureRetainedOutcomeSourceV1: async () => {} } };
  try {
    const result = await candidate.runFiniteEpisodeV1({ runtime, channels, humanContext: async () => ({ fixture: true }),
      publish: async () => { assert.equal(durable, true); return { expected_manifest_sha256: 'a'.repeat(64) }; },
      decision_timeout_ms: 1000, episode_timeout_ms: 2000 });
    assert.equal(sawHuman, true); assert.equal(result.evidence, 'DURABLE_PACKAGE');
  } finally { Object.values(channels).forEach(s => s.destroy()); }
});
