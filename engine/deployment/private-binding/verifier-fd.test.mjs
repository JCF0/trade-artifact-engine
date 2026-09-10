import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { supervisedRuntimeFixtureV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/supervised-runtime-offline-v1.mjs';
import { buildFixedTestAgentDecisionV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/fixed-test-identities-v1.mjs';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { publishRetainedPackageV1, copyPublishedPackageV1 } from './custody.mjs';
let root, inventory, release, descriptor;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
before(async () => {
  assert.ok(process.env.ARTIFACT_PARENT_NET_NS, 'qualified isolation required; no high-FD skips');
  const parent = process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT || tmpdir(); mkdirSync(parent, { recursive: true, mode: 0o700 });
  root = mkdtempSync(join(parent, 'verifier-fd-boundary-')); inventory = join(root, 'release.json');
  const build = spawnSync('/usr/bin/python3', [fileURLToPath(new URL('./inventory.py', import.meta.url)), inventory],
    { env: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(build.status, 0, build.stderr); release = hash(readFileSync(inventory));
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); const challenge = await f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'); f.source.time.wall++;
    await f.runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge, 'REFUSE_ACQUISITION'))));
    await f.runtime.trusted.captureRetainedOutcomeSourceV1(1);
    descriptor = copyPublishedPackageV1(await publishRetainedPackageV1(f.runtime, f.stateRoot, 1), join(root, 'package'));
  } finally { f.cleanup(); }
});
after(() => { if (root && !process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT) rmSync(root, { recursive: true, force: true }); });
function run(mode) {
  const argv = [fileURLToPath(new URL('./fixtures/verifier-fd-cases.py', import.meta.url)), 'launch', mode,
    inventory, release, descriptor.root, descriptor.expected_manifest_sha256, descriptor.expected_evidence_kind];
  const child = spawnSync('/usr/bin/python3', argv, { env: { PYTHONDONTWRITEBYTECODE: '1',
    ARTIFACT_PARENT_NET_NS: process.env.ARTIFACT_PARENT_NET_NS }, encoding: 'utf8', timeout: 150000, maxBuffer: 8388608 });
  writeFileSync(join(root, mode + '-execution.json'), canonicalJson({ argv: ['/usr/bin/python3', ...argv],
    exit: child.status, error: child.error?.message ?? null, stdout: child.stdout, stderr: child.stderr }), { mode: 0o600 });
  assert.equal(child.status, 0, 'HARNESS_FAILURE: ' + child.stderr);
  const result = JSON.parse(child.stdout);
  const inherited = JSON.parse(result.stdout.split('\n').find(s => s.startsWith('FD_BOUNDARY_INHERITED ')).slice('FD_BOUNDARY_INHERITED '.length));
  assert.equal(result.close_fds, false);
  assert.deepEqual(inherited.cases.map(c => c.fd), [200, 201, 65536, 65537]);
  assert.deepEqual(inherited.limits, [256, 256]);
  return result;
}
test('actual verifier removes low and above-limit high file/socket capabilities across confinement and Node exec', () => {
  const result = run('capabilities');
  assert.equal(result.exit, 0, 'HARNESS_OR_REPLAY_FAILURE: ' + result.stderr);
  assert.match(result.stderr, /VERIFIER_ISOLATION/); assert.match(result.stderr, /FD_BOUNDARY_STDERR_OK/);
  assert.match(result.stdout, /FD_BOUNDARY_PREEXEC/);
  const line = result.stdout.split('\n').find(s => s.startsWith('FD_BOUNDARY_PROBE '));
  const probe = JSON.parse(line.slice('FD_BOUNDARY_PROBE '.length));
  assert.equal(probe.stdinEof, true);
  const replay = JSON.parse(result.stdout.slice(result.stdout.indexOf(line) + line.length).trim());
  assert.equal(replay.control.state.state, 'AGENT_REFUSED_ACQUISITION');
  assert.equal(hash(readFileSync(join(descriptor.root, 'manifest.json'))), descriptor.expected_manifest_sha256);
  assert.deepEqual(probe.results.filter(r => r.fd < 65536).map(r => r.same), [false, false]);
  // Retain actual capability observations before the intentionally RED assertion.
  console.log('FD_CAPABILITY_OBSERVATION ' + JSON.stringify({ probe, file_effect: result.file_effect, socket_effect: result.socket_effect }));
  assert.deepEqual(probe.results.map(r => ({ same: r.same, readable: r.readable, writable: r.writable })),
    Array(4).fill({ same: false, readable: false, writable: false }), 'B1_RESIDUAL_INHERITED_CAPABILITY');
  assert.equal(result.file_effect, 'SYNTHETIC_FILE_CANARY'); assert.equal(result.socket_effect, '');
});
test('unavailable complete descriptor closure fails before confinement and Node exec', () => {
  const result = run('unavailable');
  assert.equal(result.exit, 1, 'B1_CLOSURE_UNAVAILABLE_MUST_STOP');
  assert.match(result.stderr, /PRIVATE_VERIFIER_STOPPED/);
  assert.doesNotMatch(result.stderr, /VERIFIER_ISOLATION|FD_BOUNDARY_STDERR_OK/);
  assert.doesNotMatch(result.stdout, /FD_BOUNDARY_PREEXEC|FD_BOUNDARY_PROBE/);
  assert.equal(result.file_effect, 'SYNTHETIC_FILE_CANARY'); assert.equal(result.socket_effect, '');
});
