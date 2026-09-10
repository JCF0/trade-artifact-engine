import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { supervisedRuntimeFixtureV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/supervised-runtime-offline-v1.mjs';
import { buildFixedTestAgentDecisionV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/fixed-test-identities-v1.mjs';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const url = new URL('./custody.mjs', import.meta.url);
const candidate = fs.existsSync(url) ? await import(url) : {};
test('producer publication acknowledgment requires verified parent fsync and never replaces partial package', async () => {
  assert.equal(typeof candidate.publishRetainedPackageV1, 'function', 'missing parent publication custody');
  const f = supervisedRuntimeFixtureV1(); const original = fs.fsyncSync;
  try {
    f.open(); const challenge = await f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'); f.source.time.wall++;
    await f.runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge, 'REFUSE_ACQUISITION'))));
    await f.runtime.trusted.captureRetainedOutcomeSourceV1(1);
    let parentSyncs = 0;
    fs.fsyncSync = fd => {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) === f.stateRoot) { parentSyncs++; throw Error('synthetic fsync failure'); }
      return original(fd);
    }; syncBuiltinESMExports();
    await assert.rejects(candidate.publishRetainedPackageV1(f.runtime, f.stateRoot, 1));
    assert.equal(parentSyncs, 1);
    assert.ok(fs.existsSync(join(f.stateRoot, 'retained-export-1', 'manifest.json')));
    fs.fsyncSync = original; syncBuiltinESMExports();
    await assert.rejects(candidate.publishRetainedPackageV1(f.runtime, f.stateRoot, 1));
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); f.cleanup(); }
});
test('producer-emitted refusal passes the fixed fresh pinned network/signer/authority-inaccessible verifier', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    const inventory = join(f.root, 'release.json');
    const build = spawnSync('/usr/bin/python3', [fileURLToPath(new URL('./inventory.py', import.meta.url)), inventory],
      { encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(build.status, 0, build.stderr);
    const { verifyReleaseInventoryV1 } = await import('./binding.mjs');
    const inventoryBytes = fs.readFileSync(inventory), releaseHash = createHash('sha256').update(inventoryBytes).digest('hex');
    assert.doesNotThrow(() => verifyReleaseInventoryV1(inventoryBytes, releaseHash, true));
    assert.throws(() => verifyReleaseInventoryV1(inventoryBytes, releaseHash)); // root is not a deployed executor
    assert.throws(() => verifyReleaseInventoryV1(Buffer.concat([inventoryBytes, Buffer.from(' ')]), releaseHash));
    f.open(); const challenge = await f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'); f.source.time.wall++;
    await f.runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge, 'REFUSE_ACQUISITION'))));
    await f.runtime.trusted.captureRetainedOutcomeSourceV1(1);
    const produced = await candidate.publishRetainedPackageV1(f.runtime, f.stateRoot, 1);
    const destination = join(f.root, 'custody-copy');
    const descriptor = candidate.copyPublishedPackageV1(produced, destination);
    assert.equal(descriptor.expected_manifest_sha256, produced.expected_manifest_sha256);
    assert.throws(() => candidate.copyPublishedPackageV1(produced, destination));
    const originalSync = fs.fsyncSync;
    try {
      fs.fsyncSync = fd => { if (fs.readlinkSync(`/proc/self/fd/${fd}`) === f.root) throw Error('synthetic-copy-parent-fsync'); return originalSync(fd); };
      syncBuiltinESMExports();
      assert.throws(() => candidate.copyPublishedPackageV1(produced, join(f.root, 'partial-custody')));
    } finally { fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
    assert.ok(fs.existsSync(join(f.root, 'partial-custody', 'manifest.json')));
    assert.throws(() => candidate.copyPublishedPackageV1(produced, join(f.root, 'partial-custody')));
    const snapshot = () => Object.fromEntries(fs.readdirSync(descriptor.root).sort().map(n => [n,
      createHash('sha256').update(fs.readFileSync(join(descriptor.root, n))).digest('hex')]));
    const before = snapshot();
    const child = spawnSync('/usr/bin/python3', [fileURLToPath(new URL('./verify-isolated.py', import.meta.url)), inventory,
      createHash('sha256').update(fs.readFileSync(inventory)).digest('hex'), descriptor.root,
      descriptor.expected_manifest_sha256, descriptor.expected_evidence_kind],
    { cwd: '/tmp', env: { PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 120000, maxBuffer: 8388608 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stderr, /VERIFIER_ISOLATION/);
    assert.equal(JSON.parse(child.stdout).control.state.state, 'AGENT_REFUSED_ACQUISITION');
    assert.deepEqual(snapshot(), before);
  } finally { f.cleanup(); }
});
