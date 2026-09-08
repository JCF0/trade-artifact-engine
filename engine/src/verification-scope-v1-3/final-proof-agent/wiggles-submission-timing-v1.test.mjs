import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { submissionRuntimeFixtureV1 } from './fixtures/submission-runtime-offline-v1.mjs';
import { createCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { validateRetainedSubmissionEvidenceV1 } from './wiggles-submission-v1.mjs';
import { canonicalJson, sha256CanonicalJson } from '../contract.mjs';

// Delay the real filesystem/authority work, not the scheduler or wrapper itself.
function delayIO(f, target, apply) {
  const open = fs.openSync, sync = fs.fsyncSync, close = fs.closeSync;
  const paths = new Map(); let observed = null;
  fs.openSync = (path, ...args) => { const fd = open(path, ...args); paths.set(fd, String(path)); return fd; };
  fs.closeSync = fd => { try { return close(fd); } finally { paths.delete(fd); } };
  fs.fsyncSync = fd => {
    const result = sync(fd);
    if (observed === null && target(paths.get(fd))) {
      observed = { before: f.source.time.mono }; apply(); observed.after = f.source.time.mono;
    }
    return result;
  };
  syncBuiltinESMExports();
  return { get observed() { return observed; }, restore() {
    fs.openSync = open; fs.fsyncSync = sync; fs.closeSync = close; syncBuiltinESMExports();
  } };
}
async function assertConsumed(f) {
  const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
  try { assert.equal((await a.inspectEpisodeV1({ episode_id: f.state.episode_id })).ordinals[0].stage, 'SUBMISSION_POSSIBLE'); }
  finally { a.closeV1(); }
  const count = f.calls.length;
  f.close(); f.open();
  assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'UNRESOLVED');
  assert.equal(f.calls.length, count);
}

for (const delay of ['authority', 'journal']) {
  test(`rebroadcast final boundary after ${delay} delay prevents external dispatch`, async () => {
    const f = submissionRuntimeFixtureV1(); let hook;
    try {
      f.open(); await f.sign();
      const prepared = join(f.stateRoot, 'submission-1/rebroadcast/send-attempt-0002/send-request-body.json');
      hook = delayIO(f, path => delay === 'journal' ? path?.endsWith('/call-0004.json')
        : path?.endsWith('/orca-signed-wire-1.bin') && fs.existsSync(prepared), () => { f.source.time.mono = 3000; });
      const result = await f.runtime.trusted.submitRetainedIntentV1(1);
      hook.restore();
      assert.deepEqual(hook.observed, { before: 2000, after: 3000 });
      assert.ok(fs.existsSync(prepared), 'scheduler prepared the permitted rebroadcast before wrapper delay');
      assert.equal(f.calls.filter(r => r.kind === 'send' && r.ordinal === 2).length, 0);
      assert.equal(result.classification, 'UNRESOLVED');
      await assertConsumed(f);
    } finally { hook?.restore(); f.cleanup(); }
  });
}

for (const kind of ['status', 'blockHeight', 'transaction']) {
  test(`resolution ${kind} initiation rechecks full timeout after journal delay`, async () => {
    const f = submissionRuntimeFixtureV1(); let hook;
    try {
      f.open(); await f.sign();
      f.setHandler(r => {
        if (r.kind === 'send') throw Error('lost acknowledgment');
        if (kind === 'blockHeight' && r.kind === 'status') return f.rpc(r, { context: { slot: 900000010 }, value: [null] });
        return f.defaultHandler(r);
      });
      const journal = kind === 'status' ? 'call-0002.json' : 'call-0003.json';
      hook = delayIO(f, path => path?.endsWith('/' + journal), () => { f.source.time.mono = 178001; });
      const result = await f.runtime.trusted.submitRetainedIntentV1(1);
      hook.restore();
      assert.ok(hook.observed);
      assert.equal(f.calls.filter(r => r.kind === kind).length, 0);
      assert.equal(result.classification, 'UNRESOLVED');
      await assertConsumed(f);
    } finally { hook?.restore(); f.cleanup(); }
  });
}

test('runtime wall deadline crossing during journal prevents first transport', async () => {
  const f = submissionRuntimeFixtureV1(); let hook;
  try {
    f.open(); await f.sign();
    hook = delayIO(f, path => path?.endsWith('/call-0001.json'), () => {
      f.source.time.wall = f.configuration.deadline_unix_seconds;
    });
    assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'UNRESOLVED');
    hook.restore(); assert.ok(hook.observed); assert.equal(f.calls.length, 0);
    f.source.time.wall = 1900000100;
    await assertConsumed(f);
  } finally { hook?.restore(); f.cleanup(); }
});

test('response at runtime deadline cannot establish terminal success', async () => {
  const f = submissionRuntimeFixtureV1();
  try {
    f.open(); await f.sign();
    f.setHandler(r => {
      if (r.kind === 'transaction') f.source.time.wall = f.configuration.deadline_unix_seconds;
      return f.defaultHandler(r);
    });
    const result = await f.runtime.trusted.submitRetainedIntentV1(1);
    assert.notEqual(result.classification, 'FINALIZED_SUCCESS');
    await assert.rejects(f.runtime.trusted.finalizeRetainedIntentV1(1));
    const t = JSON.parse(fs.readFileSync(join(f.stateRoot, 'submission-1/timing-0009.json')));
    assert.equal(t.disposition, 'LATE_RESPONSE');
    assert.equal(JSON.parse(Buffer.from(t.late_response.body_base64, 'base64')).result.meta.err, null);
  } finally { f.cleanup(); }
});

for (const ordinal of [2, 3]) for (const edge of ['lower', 'inside', 'equal', 'after']) {
  test(`ordinal ${ordinal} actual wrapper window ${edge} with nonzero origin`, async () => {
    const f = submissionRuntimeFixtureV1(); let hook;
    const base = 123, due = ordinal === 2 ? 2000 : 5000, latest = ordinal === 2 ? 3000 : 6000;
    const relative = { lower: due, inside: latest - 1, equal: latest, after: latest + 1 }[edge];
    const allowed = ['lower', 'inside'].includes(edge);
    try {
      f.open(); await f.sign(); f.source.time.mono = base;
      hook = delayIO(f, p => p?.endsWith(ordinal === 2 ? '/call-0004.json' : '/call-0007.json'),
        () => { f.source.time.mono = base + relative; });
      const result = await f.runtime.trusted.submitRetainedIntentV1(1); hook.restore();
      assert.deepEqual(hook.observed, { before: base + due, after: base + relative });
      assert.equal(f.calls.filter(r => r.kind === 'send' && r.ordinal === ordinal).length, allowed ? 1 : 0);
      assert.equal(result.classification, allowed ? 'FINALIZED_SUCCESS' : 'UNRESOLVED');
      if (!allowed) {
        const suffix = ordinal === 2 ? '0004' : '0007';
        const t = JSON.parse(fs.readFileSync(join(f.stateRoot, `submission-1/timing-${suffix}.json`)));
        assert.equal(t.disposition, 'NOT_DISPATCHED_DEADLINE'); assert.equal(t.dispatch_ms, null);
        assert.ok(fs.existsSync(join(f.stateRoot, `submission-1/call-${suffix}.json`)));
        await assertConsumed(f);
      }
    } finally { hook?.restore(); f.cleanup(); }
  });
}

for (const kind of ['status', 'blockHeight']) {
  test(`eligibility ${kind} cannot start outside its wrapper window`, async () => {
    const f = submissionRuntimeFixtureV1(); let hook;
    try {
      f.open(); await f.sign();
      hook = delayIO(f, p => p?.endsWith(kind === 'status' ? '/call-0002.json' : '/call-0003.json'),
        () => { f.source.time.mono = 3000; });
      const result = await f.runtime.trusted.submitRetainedIntentV1(1); hook.restore();
      assert.ok(hook.observed);
      assert.equal(f.calls.filter(r => r.kind === kind && r.ordinal === 2).length, 0);
      assert.equal(result.classification, 'UNRESOLVED'); await assertConsumed(f);
    } finally { hook?.restore(); f.cleanup(); }
  });
}

for (const kind of ['status', 'blockHeight', 'transaction']) {
  test(`resolution ${kind} accepts exact full-timeout-fit initiation`, async () => {
    const f = submissionRuntimeFixtureV1(); let hook;
    try {
      f.open(); await f.sign();
      f.setHandler(r => {
        if (r.kind === 'send') throw Error('lost acknowledgment');
        if (kind === 'blockHeight' && r.kind === 'status') return f.rpc(r, { context: { slot: 900000010 }, value: [null] });
        return f.defaultHandler(r);
      });
      hook = delayIO(f, p => p?.endsWith(kind === 'status' ? '/call-0002.json' : '/call-0003.json'),
        () => { f.source.time.mono = 178000; });
      const result = await f.runtime.trusted.submitRetainedIntentV1(1); hook.restore();
      assert.ok(hook.observed);
      assert.equal(f.calls.filter(r => r.kind === kind).length, 1);
      assert.equal(result.classification, kind === 'blockHeight' ? 'AMBIGUOUS' : 'FINALIZED_SUCCESS');
    } finally { hook?.restore(); f.cleanup(); }
  });
}

for (const edge of [179999, 180000, 180001]) {
  test(`terminal response resolution boundary ${edge}`, async () => {
    const f = submissionRuntimeFixtureV1(); let hook;
    try {
      f.open(); await f.sign();
      f.setHandler(r => {
        if (r.kind === 'send') throw Error('lost acknowledgment');
        if (r.kind === 'transaction') f.source.time.mono = edge;
        return f.defaultHandler(r);
      });
      hook = delayIO(f, p => p?.endsWith('/call-0003.json'), () => { f.source.time.mono = 178000; });
      const result = await f.runtime.trusted.submitRetainedIntentV1(1); hook.restore();
      assert.equal(result.classification, edge < 180000 ? 'FINALIZED_SUCCESS' : 'AMBIGUOUS');
      if (edge >= 180000) {
        const t = JSON.parse(fs.readFileSync(join(f.stateRoot, 'submission-1/timing-0003.json')));
        assert.equal(t.disposition, 'LATE_RESPONSE'); assert.ok(t.late_response.body_base64);
        await assert.rejects(f.runtime.trusted.finalizeRetainedIntentV1(1));
      }
    } finally { hook?.restore(); f.cleanup(); }
  });
}

test('timing evidence rejects omission and fully rehashed out-of-window dispatch', async () => {
  const f = submissionRuntimeFixtureV1();
  try {
    f.open(); await f.sign(); await f.runtime.trusted.submitRetainedIntentV1(1);
    const root = join(f.stateRoot, 'submission-1');
    const binding = JSON.parse(fs.readFileSync(join(root, 'binding.json')));
    const check = () => validateRetainedSubmissionEvidenceV1({ root, expected_binding: binding });
    assert.equal(check().classification, 'FINALIZED_SUCCESS');
    const p = join(root, 'timing-0004.json'), original = fs.readFileSync(p), t = JSON.parse(original);
    t.dispatch_ms = 3000; t.observed_ms = 3000;
    const completionPath = join(root, 'completion.json'), completion = JSON.parse(fs.readFileSync(completionPath));
    completion.timing_record_hashes[3] = sha256CanonicalJson(t);
    fs.writeFileSync(p, canonicalJson(t)); fs.writeFileSync(completionPath, canonicalJson(completion));
    assert.throws(check);
    fs.unlinkSync(p); assert.throws(check);
  } finally { f.cleanup(); }
});

test('journal fsync exception retains consumption without external dispatch or restart budget', async () => {
  const f = submissionRuntimeFixtureV1(); let hook;
  try {
    f.open(); await f.sign();
    hook = delayIO(f, p => p?.endsWith('/call-0004.json'), () => { throw Error('injected journal failure'); });
    assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'UNRESOLVED'); hook.restore();
    assert.equal(f.calls.filter(r => r.kind === 'send' && r.ordinal === 2).length, 0);
    await assertConsumed(f);
  } finally { hook?.restore(); f.cleanup(); }
});

for (const delay of [0, 1]) {
  test(`overall full-timeout-fit after journal delay ${delay}`, async () => {
    const f = submissionRuntimeFixtureV1(); let hook;
    f.submission.overall_timeout_ms = 2000;
    try {
      f.open(); await f.sign();
      hook = delayIO(f, p => p?.endsWith('/call-0001.json'), () => { f.source.time.mono = delay; });
      assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'UNRESOLVED'); hook.restore();
      assert.equal(f.calls.filter(r => r.kind === 'send').length, delay === 0 ? 1 : 0);
      await assertConsumed(f);
    } finally { hook?.restore(); f.cleanup(); }
  });
}

test('wall deadline minus one permits a valid entire submission', async () => {
  const f = submissionRuntimeFixtureV1(); let hook;
  try {
    f.open(); await f.sign();
    hook = delayIO(f, p => p?.endsWith('/call-0001.json'), () => { f.source.time.wall = f.configuration.deadline_unix_seconds - 1; });
    assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'FINALIZED_SUCCESS'); hook.restore();
    assert.equal(f.calls.filter(r => r.kind === 'send').length, 3);
  } finally { hook?.restore(); f.cleanup(); }
});

test('no promise turn intervenes after final checked clock and actual transport', async () => {
  const f = submissionRuntimeFixtureV1(); let hook;
  const original = f.source.clock.monotonicMs;
  let armed = false, queued = false, sent = false, sentBeforeMicrotask = false;
  f.source.clock.monotonicMs = () => {
    const n = original();
    if (armed && !queued) { queued = true; queueMicrotask(() => { sentBeforeMicrotask = sent; }); }
    return n;
  };
  try {
    f.open(); await f.sign();
    f.setHandler(r => { if (r.kind === 'send' && r.ordinal === 2) sent = true; return f.defaultHandler(r); });
    hook = delayIO(f, p => p?.endsWith('/call-0004.json'), () => { armed = true; });
    assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'FINALIZED_SUCCESS'); hook.restore();
    assert.equal(queued, true); assert.equal(sentBeforeMicrotask, true);
  } finally { hook?.restore(); f.source.clock.monotonicMs = original; f.cleanup(); }
});
