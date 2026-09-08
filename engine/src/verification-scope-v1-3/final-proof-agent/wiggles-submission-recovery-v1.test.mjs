import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionRuntimeFixtureV1 } from './fixtures/submission-runtime-offline-v1.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';

test('absolute overall timer bounds an abort-ignoring injected sleep', async () => {
  const f = submissionRuntimeFixtureV1(); let watchdog;
  f.submission.overall_timeout_ms = 2100;
  f.submission.sleep = () => new Promise(() => {});
  try {
    f.open(); await f.sign();
    const result = await Promise.race([f.runtime.trusted.submitRetainedIntentV1(1),
      new Promise(resolve => { watchdog = setTimeout(() => resolve({ classification: 'HUNG' }), 3100); })]);
    assert.equal(result.classification, 'UNRESOLVED');
    assert.equal(f.calls.filter(r => r.kind === 'send').length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(f.stateRoot, 'submission-1', 'unresolved-outcome.json'))).result, result);
  } finally { clearTimeout(watchdog); f.cleanup(); }
});

function worker(f, mode) {
  const sourceURL = new URL('./fixtures/trusted-runtime-offline-v1.mjs', import.meta.url).href;
  const runtimeURL = new URL('./wiggles-trusted-runtime-v1.mjs', import.meta.url).href;
  const code = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const c = ${JSON.stringify(f.configuration)}, mode = ${JSON.stringify(mode)};
    const effect = c.state_root + '/mock-external-effect.log';
    if (mode === 'before-send') {
      const mkdir = fs.mkdirSync;
      fs.mkdirSync = (path, ...args) => { const r = mkdir(path, ...args);
        if (path === c.state_root + '/submission-1') { fs.writeSync(1, 'CHECKPOINT\\n'); process.kill(process.pid, 'SIGSTOP'); }
        return r; };
      syncBuiltinESMExports();
    }
    const { syntheticRuntimeCaptureV1 } = await import(${JSON.stringify(sourceURL)});
    const { createOfflineTrustedWigglesRuntimeV1 } = await import(${JSON.stringify(runtimeURL)});
    const source = syntheticRuntimeCaptureV1(c.mandate); let wire;
    const rpc = (r,result) => ({status:200,body:Buffer.from(JSON.stringify({jsonrpc:'2.0',id:r.id,result}))});
    source.submission = {profile:'OFFLINE_INJECTED_SUBMISSION_V1',max_calls:188,overall_timeout_ms:190000,max_response_bytes:1048576,
      sleep: async ms => { source.time.mono += ms; }, transport: async r => {
        if (r.kind === 'send') {
          fs.appendFileSync(effect, r.params[0] + '\\n', {mode:0o600});
          if (mode === 'after-send') { fs.writeSync(1, 'CHECKPOINT\\n'); process.kill(process.pid, 'SIGSTOP'); }
          return rpc(r,r.expectedSignature);
        }
        if(r.kind==='status') return rpc(r,{context:{slot:900000010},value:r.ordinal<1000?[null]:[{slot:900000010,confirmations:null,err:null,confirmationStatus:'finalized'}]});
        if(r.kind==='blockHeight') return rpc(r,900000000);
        return rpc(r,{slot:900000010,transaction:[wire.toString('base64'),'base64'],meta:{err:null}});
      }};
    const runtime=createOfflineTrustedWigglesRuntimeV1(c,source);
    wire=await runtime.trusted.readRetainedWireV1(1);
    const result=await runtime.trusted.submitRetainedIntentV1(1);
    runtime.closeV1(); process.stdout.write(JSON.stringify(result)+'\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH, HOME: '/nonexistent-artifact-submission-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, output, stderr }));
  });
  const marker = new Promise((resolve, reject) => {
    child.stdout.on('data', b => { output += b; if (output.includes('CHECKPOINT\n')) resolve(); });
    child.on('exit', () => { if (!output.includes('CHECKPOINT\n') && mode !== 'complete') reject(Error(stderr || 'missing checkpoint')); });
  });
  return { child, done, marker };
}

for (const mode of ['before-send', 'after-send']) {
  test(`SIGKILL ${mode}: reopen consumes whole schedule, no replacement signing`, { timeout: 30000 }, async () => {
    const f = submissionRuntimeFixtureV1(); let w, timer;
    try {
      f.open(); await f.sign(); f.close(); unlinkSync(f.keyPath);
      w = worker(f, mode);
      await Promise.race([w.marker, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('checkpoint timeout')), 20000); })]);
      clearTimeout(timer); w.child.kill('SIGKILL');
      assert.equal((await w.done).signal, 'SIGKILL');
      const log = join(f.stateRoot, 'mock-external-effect.log');
      assert.equal(existsSync(log), mode === 'after-send');
      if (mode === 'after-send') assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [f.wire.toString('base64')]);
      f.open();
      assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'UNRESOLVED');
      assert.equal(f.calls.length, 0);
      const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
      try {
        const inspected = await a.inspectEpisodeV1({ episode_id: f.state.episode_id });
        assert.equal(inspected.ordinals[0].stage, 'SUBMISSION_POSSIBLE');
        assert.equal(inspected.ordinals[0].transaction_signature.length > 0, true);
      } finally { a.closeV1(); }
    } finally { clearTimeout(timer); w?.child.kill('SIGKILL'); if (w) await w.done; f.cleanup(); }
  });
}

test('separate runtime processes elect one submission owner and consume one shared send budget', { timeout: 30000 }, async () => {
  const f = submissionRuntimeFixtureV1(); const workers = [];
  try {
    f.open(); await f.sign(); f.close(); unlinkSync(f.keyPath);
    workers.push(worker(f, 'complete'), worker(f, 'complete'));
    const outputs = await Promise.all(workers.map(w => w.done));
    assert.ok(outputs.every(r => r.code === 0 && r.signal === null), JSON.stringify(outputs));
    assert.deepEqual(outputs.map(r => JSON.parse(r.output.trim()).classification).sort(), ['FINALIZED_SUCCESS', 'UNRESOLVED']);
    const sends = readFileSync(join(f.stateRoot, 'mock-external-effect.log'), 'utf8').trim().split('\n');
    assert.deepEqual(sends, [f.wire, f.wire, f.wire].map(b => b.toString('base64')));
    f.open(); assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'FINALIZED_SUCCESS');
    assert.equal(f.calls.length, 0);
  } finally { for (const w of workers) w.child.kill('SIGKILL'); await Promise.all(workers.map(w => w.done)); f.cleanup(); }
});

test('late abort-ignoring transport settlement cannot mutate retained evidence or trigger a send', async () => {
  const f = submissionRuntimeFixtureV1(); let settled = false;
  try {
    f.open(); await f.sign();
    f.setHandler(async r => {
      if (r.kind !== 'send') return f.defaultHandler(r);
      await new Promise(resolve => setTimeout(resolve, 2200)); settled = true;
      return f.rpc(r, r.expectedSignature);
    });
    const result = await f.runtime.trusted.submitRetainedIntentV1(1);
    const root = join(f.stateRoot, 'submission-1');
    const names = readdirSync(root), count = f.calls.length;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(settled, true);
    assert.equal(result.classification, 'FINALIZED_SUCCESS');
    assert.deepEqual(readdirSync(root), names);
    assert.equal(f.calls.length, count);
    assert.equal(f.calls.filter(r => r.kind === 'send').length, 1);
  } finally { f.cleanup(); }
});
