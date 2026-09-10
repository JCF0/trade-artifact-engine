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
import { types } from 'node:util';
import { assertExactFields } from '../../src/verification-scope-v1-3/contract.mjs';
import { parseCanonicalV1, blocked } from './io.mjs';
import { queryRpcFixture, assertPrivateTree, QUERY_CANARY } from './fixtures/query-rpc.mjs';
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
for (const query of [false, true]) test(`fixed disposable ${query ? 'query' : 'bearer'} composer signs once through real bounded HTTP readiness/simulation and rejects consumed reopen`, async () => {
  const { composeFixtureBindingV1, composeFixtureHeliusBindingV1 } = await import('./binding.mjs');
  if (query) assert.equal(typeof composeFixtureHeliusBindingV1, 'function', 'MISSING_QUERY_COMPOSITION');
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
        if (query) {
          assert.equal(request.url, '/rpc?api-key=SYNTHETIC_BINDING_CANARY_123456');
          assert.equal(request.headers.authorization, undefined); assert.equal(request.headers['x-api-key'], undefined);
        }
        assert.deepEqual(bytes, Buffer.from(canonicalJson(body))); methods.push(body.method);
        const raw = await f.transport({ body, signal: new AbortController().signal }); response.setHeader('content-type', 'application/json'); response.end(raw);
      } catch { response.statusCode = 500; response.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const c = { version: 'artifact_private_binding_v1', release_sha256: runtime.executor_release_sha256, runtime,
      provider_capability_id: query ? 'helius-mainnet-query-v1' : 'synthetic-provider-v1', decision_timeout_ms: 1000, episode_timeout_ms: 60000 };
    const credential = { endpoint: `http://127.0.0.1:${server.address().port}/rpc`, bearer: 'SYNTHETIC_BINDING_CANARY_123456', ca: null,
      capability_id: c.provider_capability_id };
    const open = () => query ? composeFixtureHeliusBindingV1(Buffer.from(canonicalJson(c)),
      { capability_id: c.provider_capability_id, api_key: credential.bearer, ca: null }, credential.endpoint, f.source.clock)
      : composeFixtureBindingV1(Buffer.from(canonicalJson(c)), credential, f.source.clock);
    binding = open();
    const challenge = await binding.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'); f.source.time.wall++;
    const bytes = Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge)));
    const result = await binding.runtime.agent.submitDecisionBytesV1(bytes);
    assert.equal(result.status, 'SIGNED_INTENT_DURABLE'); assert.equal(methods.filter(m => m === 'simulateTransaction').length, 1);
    binding.close(); binding = open();
    const count = methods.length;
    await assert.rejects(binding.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'));
    await assert.rejects(binding.runtime.agent.submitDecisionBytesV1(bytes));
    assert.equal(methods.length, count);
  } finally { binding?.close(); server?.closeAllConnections(); server?.close(); f.cleanup(); }
});
for (const phase of ['capture', 'simulation', 'economic_source']) test(`query contamination cannot cross actual ${phase} journal/evidence boundary`, async () => {
  const f = supervisedRuntimeFixtureV1(), rpc = await queryRpcFixture(f);
  try {
    f.open(undefined, rpc.wrap);
    if (phase === 'economic_source') { await f.sign(); await f.runtime.trusted.submitRetainedIntentV1(1); }
    const before = rpc.requests.length;
    rpc.poison(body => phase === 'simulation' ? body.method === 'simulateTransaction' : phase === 'economic_source'
      ? String(body.id).startsWith('economic-') : true);
    const refuse = async () => phase === 'capture' ? f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION')
      : phase === 'simulation' ? f.sign() : f.runtime.trusted.finalizeRetainedIntentV1(1);
    await assert.rejects(refuse(), e => !e.stack.includes(QUERY_CANARY) && e.cause === undefined);
    rpc.assertHealthy(); assert.ok(rpc.requests.length > before);
    const records = f.journal.snapshot().records.map(r => r.record).filter(r => r?.phase === phase);
    if (phase === 'capture') {
      assert.equal(f.journal.snapshot().records.filter(r => r.kind === 'readiness').length, 0);
      assert.equal(rpc.requests.length - before, 1);
    } else assert.ok(records.some(r => r.stage === 'REQUEST_DURABLE_BEFORE_EFFECT'));
    assert.equal(records.filter(r => r.stage === 'RESPONSE_DURABLE').length, 0);
    assertPrivateTree(f.stateRoot, [rpc.endpoint]);
    if (phase === 'simulation') {
      const calls = rpc.requests.length;
      await assert.rejects(f.runtime.trusted.readRetainedWireV1(1));
      f.close(); f.open(undefined, rpc.wrap);
      await assert.rejects(f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'));
      assert.equal(rpc.requests.length, calls);
    }
  } finally { rpc.close(); f.cleanup(); }
});
test('query fixture refuses mixed credentials and production profiles without dispatch or getter calls', async () => {
  const { composeFixtureBindingV1, composeFixtureHeliusBindingV1 } = await import('./binding.mjs');
  const f = supervisedRuntimeFixtureV1(), rpc = await queryRpcFixture(f);
  try {
    let getters = 0;
    const c = { version: 'artifact_private_binding_v1', release_sha256: f.configuration.executor_release_sha256, runtime: f.configuration,
      provider_capability_id: 'helius-mainnet-query-v1', decision_timeout_ms: 1000, episode_timeout_ms: 60000 };
    const secret = { capability_id: c.provider_capability_id, api_key: QUERY_CANARY, ca: null };
    for (const bad of [{ ...secret, endpoint: rpc.endpoint }, { ...secret, bearer: QUERY_CANARY }, { ...secret, [QUERY_CANARY]: 1 },
      { ...secret, capability_id: 'unknown-provider' }, Object.defineProperty({ ...secret }, 'api_key', { get() { getters++; throw Error(QUERY_CANARY); } })]) {
      assert.throws(() => composeFixtureHeliusBindingV1(Buffer.from(canonicalJson(c)), bad, rpc.endpoint, f.source.clock),
        e => e.message === 'PRIVATE_BINDING_STOPPED' && e.cause === undefined && !e.stack.includes(QUERY_CANARY));
    }
    assert.throws(() => composeFixtureBindingV1(Buffer.from(canonicalJson(c)),
      { capability_id: c.provider_capability_id, bearer: QUERY_CANARY, endpoint: rpc.endpoint, ca: null }, f.source.clock), /PRIVATE_BINDING_STOPPED/);
    const productionClaim = structuredClone(c); productionClaim.runtime.mandate.mandate_profile = 'PRODUCTION';
    assert.throws(() => composeFixtureHeliusBindingV1(Buffer.from(canonicalJson(productionClaim)), secret, rpc.endpoint, f.source.clock), /PRIVATE_BINDING_STOPPED/);
    assert.equal(getters, 0); assert.equal(rpc.requests.length, 0);
  } finally { rpc.close(); f.cleanup(); }
});
test('actual private FD loader accepts only query capability and wipes/closes on all dispositions', () => {
  // Exact private function with only descriptor input substituted; no activation hook.
  const source = readFileSync(new URL('./binding.mjs', import.meta.url), 'utf8');
  const start = source.includes('function credentialFor(') ? source.indexOf('function credentialFor(') : source.indexOf('function loadCredential(');
  const code = source.slice(start, source.indexOf('// Mechanical candidate stop.'));
  const secret = 'SYNTHETIC_FD_QUERY_CANARY_0192837465';
  const valid = { capability_id: 'helius-mainnet-query-v1', api_key: secret, ca: null };
  for (const [value, good] of [[valid, true], [{ ...valid, [secret]: secret }, false], [{ ...valid, endpoint: 'https://example.invalid/' }, false],
    [{ ...valid, bearer: secret }, false], [{ ...valid, capability_id: 'other-provider' }, false], [{ ...valid, api_key: '' }, false],
    [{ ...valid, api_key: secret + '\n' }, false], [{ capability_id: valid.capability_id, endpoint: 'https://example.invalid/', bearer: secret, ca: null }, false]]) {
    const bytes = Buffer.from(canonicalJson(value)); let closed = 0, reads = 0;
    const load = new Function('readBoundedFdV1', 'FD_ROLES_V1', 'parseCanonicalV1', 'assertExactFields', 'blocked', 'closeSync', 'types', 'HELIUS_CAPABILITY_V1',
      code + '; return loadCredential;')((fd, max, owner) => { reads++; assert.equal(fd, 5); assert.equal(max, 73728); assert.equal(owner, process.getuid()); return bytes; },
      { credential: 5 }, parseCanonicalV1, assertExactFields, blocked, fd => { assert.equal(fd, 5); closed++; }, types, valid.capability_id);
    if (good) assert.deepEqual(load({ provider_capability_id: valid.capability_id }), valid, 'MISSING_QUERY_FD_CONTRACT');
    else assert.throws(() => load({ provider_capability_id: valid.capability_id }), e => e.message === 'PRIVATE_BINDING_STOPPED' && !e.stack.includes(secret) && e.cause === undefined);
    assert.equal(reads, 1); assert.equal(closed, 1); assert.ok(bytes.every(b => b === 0));
  }
});
