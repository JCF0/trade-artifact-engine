import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { supervisedRuntimeFixtureV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/supervised-runtime-offline-v1.mjs';
import { computeCandidateMemberDigestV13 } from '../../src/verification-scope-v1-3/explicit-candidate-selection.mjs';
import { createCrashDurableDecisionAuthorityV1 } from '../../src/verification-scope-v1-3/final-proof-agent/sqlite-decision-authority-v1.mjs';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from '../../src/verification-scope-v1-3/final-proof-agent/human-revocation-v1.mjs';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { copyPublishedPackageV1, publishRetainedPackageV1 } from './custody.mjs';
import { queryRpcFixture, assertPrivateTree } from './fixtures/query-rpc.mjs';
let root, inventory, release;
const hash = b => createHash('sha256').update(b).digest('hex');
before(() => {
  const parent = process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT || tmpdir(); mkdirSync(parent, { recursive: true, mode: 0o700 });
  root = mkdtempSync(join(parent, 'private-producer-replay-')); inventory = join(root, 'release.json');
  const child = spawnSync('/usr/bin/python3', [fileURLToPath(new URL('./inventory.py', import.meta.url)), inventory],
    { env: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, child.stderr); release = hash(readFileSync(inventory));
});
after(() => { if (!process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT) rmSync(root, { recursive: true, force: true }); });
function replay(descriptor, label) {
  const copy = copyPublishedPackageV1(descriptor, join(root, label));
  const args = [fileURLToPath(new URL('./verify-isolated.py', import.meta.url)), inventory, release,
    copy.root, copy.expected_manifest_sha256, copy.expected_evidence_kind];
  const child = spawnSync('/usr/bin/python3', args, { env: { PYTHONDONTWRITEBYTECODE: '1' }, cwd: '/tmp', encoding: 'utf8', timeout: 120000, maxBuffer: 8388608 });
  writeFileSync(join(root, label + '-verification.json'), canonicalJson({ argv: ['/usr/bin/python3', ...args],
    exit: child.status, stdout: child.stdout, stderr: child.stderr, descriptor: copy }), { mode: 0o600 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stderr, /VERIFIER_ISOLATION/);
  assert.equal(hash(readFileSync(join(copy.root, 'manifest.json'))), descriptor.expected_manifest_sha256);
  return JSON.parse(child.stdout);
}
for (const query of [false, true]) for (const outcome of ['complete', 'acquisition-only', 'revoked', 'finalized-failure', 'unresolved', ...(query ? ['contaminated'] : [])]) {
  test(`fixed confined independent verifier consumes ${query ? 'query' : 'original'} producer-emitted ${outcome} original bytes`, async () => {
    const f = supervisedRuntimeFixtureV1();
    const rpc = query ? await queryRpcFixture(f) : null;
    const label = name => query ? 'query-' + name : name;
    try {
      f.open(undefined, rpc?.wrap); await f.sign();
      if (query) assert.ok(rpc.requests.some(r => r.body.method === 'simulateTransaction'), 'QUERY_COMPOSITION_NOT_EXERCISED');
      if (outcome === 'finalized-failure') {
        const tx = f.transactions[0]; tx.meta.err = { InstructionError: [0, { Custom: 6001 }] };
        tx.meta.innerInstructions = []; tx.meta.postTokenBalances = structuredClone(tx.meta.preTokenBalances);
        tx.meta.postBalances = [...tx.meta.preBalances]; tx.meta.postBalances[0] -= tx.meta.fee;
      }
      if (outcome === 'unresolved') { f.setVisible(false); rpc?.fail(); f.setHandler(() => { throw Error('SYNTHETIC_UNRESOLVED'); }); }
      if (outcome === 'contaminated') { f.setVisible(false); rpc.poison(body => typeof body.id === 'number'); }
      const submission = await f.runtime.trusted.submitRetainedIntentV1(1);
      rpc?.assertHealthy();
      if (query && ['complete', 'acquisition-only', 'revoked'].includes(outcome)) assert.equal(submission.classification, 'FINALIZED_SUCCESS');
      if (['complete', 'acquisition-only', 'revoked'].includes(outcome)) await f.runtime.trusted.finalizeRetainedIntentV1(1);
      else await f.runtime.trusted.captureRetainedOutcomeSourceV1(1);
      if (outcome === 'revoked') {
        f.source.time.wall += 10;
        const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot }); let state;
        try { state = await a.loadCurrentEpisodeStateV1({ episode_id: `bounded-agent-episode-${f.authorization.authorization_digest}` }); } finally { a.closeV1(); }
        const unsigned = { episode_id: state.episode_id, mandate_digest: f.mandate.mandate_digest,
          authorization_digest: f.authorization.authorization_digest, human_public_key: f.authorization.human_public_key,
          predecessor_state: state.state, predecessor_state_digest: state.state_digest, revoked_at_unix_seconds: f.source.time.wall,
          revocation_nonce: 'private-replay-disposable', revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION' };
        const key = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')]) });
        await f.runtime.supervisor.revokeAuthenticatedBytesV1(Buffer.from(canonicalJson(buildHumanRevocationV1({ ...unsigned,
          signature: sign(null, humanRevocationSigningBytesV1(unsigned), key).toString('hex') }))));
      }
      const ordinal = outcome === 'complete' ? 2 : 1;
      if (ordinal === 2) { await f.sign('DISPOSAL'); await f.runtime.trusted.submitRetainedIntentV1(2); await f.runtime.trusted.finalizeRetainedIntentV1(2); }
      const original = await publishRetainedPackageV1(f.runtime, f.stateRoot, ordinal);
      const result = replay(original, label(outcome));
      if (query) {
        rpc.assertHealthy(); assertPrivateTree(f.stateRoot, [rpc.endpoint]); assertPrivateTree(join(root, label(outcome)), [rpc.endpoint]);
        assert.ok(rpc.requests.some(r => String(r.body.id).startsWith('economic-')));
        assert.equal(rpc.requests.filter(r => r.body.method === 'sendTransaction').length, ordinal);
      }
      assert.equal(result.control.status, outcome === 'revoked' ? 'REVOKED' : 'AUTHENTICATED');
      assert.equal(result.demonstration.contract_satisfied, false); // Unselected is never a success claim.
      if (['unresolved', 'contaminated'].includes(outcome)) { assert.equal(result.control.state.possible_submission, true); assert.equal(result.economic_observations.transactions.length, 0); }
      if (outcome === 'contaminated') {
        // Completed terminal resolution with no admissible provider body is
        // AMBIGUOUS; UNRESOLVED is the separate incomplete-evidence catch path.
        assert.equal(submission.classification, 'AMBIGUOUS');
        const retention = JSON.parse(readFileSync(join(f.stateRoot, 'submission-1/rebroadcast/send-attempt-0001/send-retention.json')));
        assert.equal(retention.body_present, false); assert.equal(retention.raw_file, null);
        // Consumed submission reopens in evidence-only mode, returning the
        // validated retained disposition without any new provider operation.
        const calls = rpc.requests.length;
        assert.deepEqual(await f.runtime.trusted.submitRetainedIntentV1(1), submission);
        assert.equal(rpc.requests.length, calls);
        assert.equal(rpc.requests.filter(r => r.body.method === 'sendTransaction').length, 1);
      }
      if (outcome === 'finalized-failure') assert.equal(result.economic_observations.transactions[0].execution_state, 'failed');
      if (outcome === 'complete') {
        const population = await f.runtime.trusted.inspectRetainedExportCandidatesV1(2);
        const selection = { candidate_population_digest: population.population_digest,
          requested_candidate_digest: computeCandidateMemberDigestV13({ candidate_population_digest: population.population_digest, episode_disposition: population.episode_dispositions[0] }) };
        const selected = await publishRetainedPackageV1(f.runtime, f.stateRoot, 2, selection);
        const selectedResult = replay(selected, label('complete-selected'));
        assert.equal(selectedResult.demonstration.contract_satisfied, true);
        assert.equal(selectedResult.demo_summary.synthetic_demonstration_success, true);
        assert.equal(selectedResult.demo_summary.full_demonstration_success, false);
        assert.notEqual(selected.root, original.root);
        assert.equal(hash(readFileSync(join(original.root, 'manifest.json'))), original.expected_manifest_sha256);
        await assert.rejects(publishRetainedPackageV1(f.runtime, f.stateRoot, 2, selection));
      }
    } catch (error) {
      if (query && process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT) {
        assertPrivateTree(f.stateRoot, [rpc.endpoint]);
        cpSync(f.stateRoot, join(root, label(outcome) + '-failed-state'), { recursive: true, errorOnExist: true, force: false });
      }
      throw error;
    } finally { rpc?.close(); f.cleanup(); }
  });
}
