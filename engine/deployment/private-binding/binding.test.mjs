import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervisedRuntimeFixtureV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/supervised-runtime-offline-v1.mjs';
import { createAuthorizedEpisodeStateV1 } from '../../src/verification-scope-v1-3/final-proof-agent/episode-state-machine-v1.mjs';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { buildFixedTestAgentDecisionV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/fixed-test-identities-v1.mjs';
const url = new URL('./provision.mjs', import.meta.url);
const candidate = existsSync(url) ? await import(url) : {};
test('first-time provisioner records an exclusive stopped marker before both stores; ordinary open never repairs partial state', async () => {
  assert.equal(typeof candidate.provisionFixtureBindingV1, 'function', 'missing finite provisioning disposition');
  const f = supervisedRuntimeFixtureV1();
  try {
    const root = join(f.root, 'new-authority'); mkdirSync(root, { mode: 0o700 });
    const configuration = { ...f.configuration, state_root: root };
    const result = candidate.provisionFixtureBindingV1(configuration, f.source.clock.unixSeconds());
    assert.equal(result.status, 'PROVISIONED');
    assert.equal(JSON.parse(readFileSync(join(root, 'binding-provision-started.json'))).disposition, 'STOP_UNLESS_COMPLETION_VERIFIED');
    assert.ok(readdirSync(root).includes('supervised-head.json'));
    assert.throws(() => candidate.provisionFixtureBindingV1(configuration, f.source.clock.unixSeconds()));
    candidate.verifyProvisionedBindingV1(configuration);
  } finally { f.cleanup(); }
});
test('closed administrator config rejects controller-selected imports before private effects', async () => {
  const url = new URL('./binding.mjs', import.meta.url);
  const module = existsSync(url) ? await import(url) : {};
  assert.equal(typeof module.validatePublicBindingV1, 'function', 'missing closed fixed configuration');
  assert.throws(() => module.validatePublicBindingV1(Buffer.from(canonicalJson({ module: '/tmp/controller.mjs' }))));
  const f = supervisedRuntimeFixtureV1();
  try {
    const c = { version: 'artifact_private_binding_v1', release_sha256: f.configuration.executor_release_sha256,
      runtime: f.configuration, provider_capability_id: 'synthetic-provider-v1', decision_timeout_ms: 1000, episode_timeout_ms: 60000 };
    assert.equal(module.validateFixturePublicBindingV1(Buffer.from(canonicalJson(c)), f.source.clock.unixSeconds()).version, c.version);
    assert.throws(() => module.validatePublicBindingV1(Buffer.from(canonicalJson(c))));
    assert.throws(() => module.validateFixturePublicBindingV1(Buffer.from(canonicalJson({ ...c, command: 'node' })), f.source.clock.unixSeconds()));
    assert.throws(() => module.validateFixturePublicBindingV1(Buffer.from(JSON.stringify(c)), f.source.clock.unixSeconds()));
  } finally { f.cleanup(); }
});
for (const failedName of ['supervised-head.json', 'binding-provision-complete.json']) {
  test(`provisioning ${failedName} fsync failure leaves permanent STOP and cannot reopen or reset`, () => {
    const f = supervisedRuntimeFixtureV1(), original = fs.fsyncSync;
    try {
      const root = join(f.root, 'fault-authority'); mkdirSync(root, { mode: 0o700 });
      const c = { ...f.configuration, state_root: root }; let faults = 0;
      fs.fsyncSync = fd => {
        if (fs.readlinkSync(`/proc/self/fd/${fd}`) === join(root, failedName)) { faults++; throw Error('synthetic-fsync'); }
        return original(fd);
      }; syncBuiltinESMExports();
      assert.throws(() => candidate.provisionFixtureBindingV1(c, f.source.clock.unixSeconds()));
      fs.fsyncSync = original; syncBuiltinESMExports();
      assert.equal(faults, 1);
      assert.throws(() => candidate.verifyProvisionedBindingV1(c));
      assert.throws(() => candidate.provisionFixtureBindingV1(c, f.source.clock.unixSeconds()));
      assert.ok(readdirSync(root).includes('binding-provision-started.json'));
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); f.cleanup(); }
  });
}
test('fixed disposable composer signs once through real bounded HTTP readiness/simulation and rejects consumed reopen', async () => {
  const { composeFixtureBindingV1 } = await import('./binding.mjs');
  const f = supervisedRuntimeFixtureV1(); let binding, server;
  try {
    const root = join(f.root, 'composed-authority'); mkdirSync(root, { mode: 0o700 });
    const runtime = { ...f.configuration, state_root: root };
    candidate.provisionFixtureBindingV1(runtime, f.source.clock.unixSeconds());
    const methods = [];
    server = createServer(async (request, response) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const bytes = Buffer.concat(chunks), body = JSON.parse(bytes);
        assert.deepEqual(bytes, Buffer.from(canonicalJson(body))); methods.push(body.method);
        const raw = await f.transport({ body, signal: new AbortController().signal }); response.setHeader('content-type', 'application/json'); response.end(raw);
      } catch { response.statusCode = 500; response.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const c = { version: 'artifact_private_binding_v1', release_sha256: runtime.executor_release_sha256, runtime,
      provider_capability_id: 'synthetic-provider-v1', decision_timeout_ms: 1000, episode_timeout_ms: 60000 };
    const credential = { endpoint: `http://127.0.0.1:${server.address().port}/rpc`, bearer: 'SYNTHETIC_BINDING_CANARY_123456', ca: null,
      capability_id: c.provider_capability_id };
    binding = composeFixtureBindingV1(Buffer.from(canonicalJson(c)), credential, f.source.clock);
    const challenge = await binding.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'); f.source.time.wall++;
    const bytes = Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge)));
    const result = await binding.runtime.agent.submitDecisionBytesV1(bytes);
    assert.equal(result.status, 'SIGNED_INTENT_DURABLE'); assert.equal(methods.filter(m => m === 'simulateTransaction').length, 1);
    binding.close(); binding = composeFixtureBindingV1(Buffer.from(canonicalJson(c)), credential, f.source.clock);
    const count = methods.length;
    await assert.rejects(binding.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'));
    await assert.rejects(binding.runtime.agent.submitDecisionBytesV1(bytes));
    assert.equal(methods.length, count);
  } finally { binding?.close(); server?.closeAllConnections(); server?.close(); f.cleanup(); }
});
