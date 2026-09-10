import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { supervisedRuntimeFixtureV1 } from './fixtures/supervised-runtime-offline-v1.mjs';
import { createOfflineSupervisedWigglesRuntimeV1 } from './wiggles-trusted-runtime-v1.mjs';
test('complete supervised acquisition and disposal close from original bounded full-population source', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open();
    for (const [ordinal, phase] of [[1, 'ACQUISITION'], [2, 'DISPOSAL']]) {
      await f.sign(phase);
      assert.equal((await f.runtime.trusted.submitRetainedIntentV1(ordinal)).classification, 'FINALIZED_SUCCESS');
      await f.runtime.trusted.finalizeRetainedIntentV1(ordinal);
    }
    const sources = f.journal.snapshot().records.filter(r => r.kind === 'economic_source');
    assert.deepEqual(sources.map(r => r.descriptor.transactions.length), [1, 2]);
    const projection = f.journal.snapshot().records.find(r => r.kind === 'terminal_record' && r.record.projection);
    assert.equal(projection.record.projection.ordinal, 2);
  } finally { f.cleanup(); }
});
test('supervised composition simulates before disposable signing and retains actual decision/capture records', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); const result = await f.sign();
    assert.equal(result.result.status, 'SIGNED_INTENT_DURABLE');
    assert.equal(f.effects.filter(k => k === 'simulateTransaction').length, 1);
    const records = f.journal.snapshot().records;
    assert.ok(records.some(r => r.kind === 'simulation'));
    assert.ok(records.some(r => r.kind === 'decision'));
    assert.ok(records.some(r => r.kind === 'readiness'));
    f.close(); f.open(); const before = f.effects.length;
    await assert.rejects(f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'));
    assert.equal(f.effects.length, before);
    assert.equal(f.journal.snapshot().records.length, records.length);
  } finally { f.cleanup(); }
});
test('failed simulation does not touch a missing wallet key or grant replacement authority', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.setSimulationError('BlockhashNotFound'); f.open(); rmSync(f.keyPath);
    await assert.rejects(f.sign(), /SIMULATION_INVALID/);
    assert.equal(existsSync(f.keyPath), false);
    assert.equal(f.effects.filter(k => k === 'simulateTransaction').length, 1);
    assert.equal(f.effects.filter(k => k === 'send').length, 0);
    await assert.rejects(f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'));
  } finally { f.cleanup(); }
});
test('closed configuration rejects agent-selected capabilities before effects', () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    assert.throws(() => createOfflineSupervisedWigglesRuntimeV1({ ...f.configuration, transport: () => {} },
      { clock: f.source.clock }), /./);
    assert.deepEqual(f.effects, []);
  } finally { f.cleanup(); }
});
