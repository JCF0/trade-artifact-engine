import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervisedRuntimeFixtureV1 } from './fixtures/supervised-runtime-offline-v1.mjs';
import { createSupervisedJournalV1 } from './supervised-journal-v1.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
test('SIGKILL after composed signing preserves phase consumption in a new process', async () => {
  const module = new URL('./fixtures/supervised-runtime-offline-v1.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { supervisedRuntimeFixtureV1 } from ${JSON.stringify(module)};
    const f = supervisedRuntimeFixtureV1(); f.open(); await f.sign(); process.on('message', () => {}); process.send({ root: f.root, stateRoot: f.stateRoot });`],
  { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {} });
  let root, timer; const exited = once(child, 'exit');
  try {
    const message = await Promise.race([once(child, 'message').then(([v]) => v),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('missing committed signing checkpoint')), 60000); }),
      exited.then(() => { throw Error('child exited before checkpoint'); })]);
    root = message.root; child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
    const journal = createSupervisedJournalV1(message.stateRoot);
    assert.ok(journal.snapshot().records.some(r => r.kind === 'phase_consumed' && r.phase === 'simulation'));
    assert.throws(() => journal.claimPhase('capture', 1)); assert.throws(() => journal.claimPhase('simulation', 1));
  } finally { clearTimeout(timer); child.kill('SIGKILL'); if (root) rmSync(root, { recursive: true, force: true }); }
});
test('journal open never provisions empty authority roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'supervised-unprovisioned-'));
  try { assert.throws(() => createSupervisedJournalV1(root)); } finally { rmSync(root, { recursive: true }); }
});
test('lost phase marker cannot replenish source calls after reopen', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); await f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'); f.close();
    unlinkSync(join(f.stateRoot, 'supervised-capture-1.consumed.json'));
    const before = f.effects.length;
    assert.throws(() => f.open()); assert.equal(f.effects.length, before);
  } finally { f.cleanup(); }
});
test('in-process journal snapshot rejects mutated retained records', () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); f.journal.retain({ kind: 'test-record' });
    const path = join(f.stateRoot, 'supervised-record-0001.json'); const bytes = readFileSync(path);
    writeFileSync(path, Buffer.from(bytes.toString().replace('test-record', 'lost-record')));
    assert.throws(() => f.journal.snapshot());
  } finally { f.cleanup(); }
});
