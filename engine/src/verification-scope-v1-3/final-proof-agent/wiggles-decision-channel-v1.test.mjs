import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { canonicalJson } from '../contract.mjs';

test('one-shot stdio channel forwards only bounded bytes and writes a closed result', async () => {
  const { serveSingleWigglesDecisionV1 } = await import('./wiggles-decision-channel-v1.mjs');
  const input = new PassThrough(), output = new PassThrough(); const chunks = [];
  output.on('data', b => chunks.push(b)); let seen;
  const done = serveSingleWigglesDecisionV1({ input, output, timeout_ms: 1000,
    agent: { async submitDecisionBytesV1(bytes) { seen = bytes; return { status: 'REFUSED', episode_id: 'test', signed_intent_digest: null }; } } });
  input.write(Buffer.from('{')); input.end(Buffer.from('}'));
  await done;
  assert.deepEqual(seen, Buffer.from('{}'));
  assert.equal(Buffer.concat(chunks).toString(), canonicalJson({ status: 'REFUSED', episode_id: 'test', signed_intent_digest: null }));
});

test('oversized and stalled channels cannot enter authenticated decision ingress', async () => {
  const { serveSingleWigglesDecisionV1 } = await import('./wiggles-decision-channel-v1.mjs');
  for (const oversized of [true, false]) {
    const input = new PassThrough(), output = new PassThrough(); let calls = 0;
    output.resume();
    const done = serveSingleWigglesDecisionV1({ input, output, timeout_ms: 20,
      agent: { async submitDecisionBytesV1() { calls++; } } });
    if (oversized) input.end(Buffer.alloc(131073));
    await done; assert.equal(calls, 0);
  }
});

test('intended supervised CLI remains blocked even with attempted enable flags', () => {
  const entry = new URL('./run-wiggles-supervised-v1.mjs', import.meta.url);
  for (const flags of [[], ['--enable-live', '--wallet-key', '/DO-NOT-READ']]) {
    const result = spawnSync(process.execPath, [entry.pathname, ...flags], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: '/nonexistent', NODE_OPTIONS: '' }, input: '{}',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /bounded_agent_live_executor_not_released/);
  }
});
