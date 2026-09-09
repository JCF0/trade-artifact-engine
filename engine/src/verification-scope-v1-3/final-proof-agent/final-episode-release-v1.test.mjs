import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeCandidateMemberDigestV13 } from '../explicit-candidate-selection.mjs';
import { hash, retainedEpisodeFixtureV1, writeRetainedEpisodeFixtureV1 } from './fixtures/retained-episode-offline-v1.mjs';

test('final episode replay reconstructs retained real legs, preserving explicit selection and evidence separation', async () => {
  const { reconstructFinalEpisodeReleaseV1 } = await import('./final-episode-release-v1.mjs');
  const root = mkdtempSync(join(tmpdir(), 'artifact-episode-'));
  try {
    const fixture = retainedEpisodeFixtureV1();
    const preview = await reconstructFinalEpisodeReleaseV1(writeRetainedEpisodeFixtureV1(root, fixture));
    assert.equal(preview.operation.status, 'COMPLETED');
    assert.equal(preview.claim, null);
    assert.equal(preview.selection, null);
    assert.equal(preview.population.source_transaction_count, 2);
    fixture.descriptor.selection = { candidate_population_digest: preview.population.population_digest,
      requested_candidate_digest: computeCandidateMemberDigestV13({ candidate_population_digest: preview.population.population_digest, episode_disposition: preview.population.episode_dispositions[0] }) };
    const result = await reconstructFinalEpisodeReleaseV1(writeRetainedEpisodeFixtureV1(root, fixture));
    assert.equal(result.claim.claim_evaluation.claim_outcome, 'VERIFIED');
    assert.equal(result.claim.claim_evaluation.position_state, 'CLOSED');
    assert.deepEqual(result.population.episode_dispositions[0].episode.realized_pnl, { numerator: '-251206', denominator: '1' });
    assert.equal(result.demonstration.eligible, false);
    assert.equal(result.control.status, 'MISSING');
    assert.equal(result.source_admission.evidence_kind, 'CALIBRATION_TRANSACTIONS_SYNTHETIC_BOUNDARIES');
    assert.equal(result.transaction_reconciliation.length, 2);
    assert.ok(result.transaction_reconciliation.every(t => t.signature_verified));
    assert.equal(result.demo_summary.full_demonstration_success, false);
    assert.equal(result.demo_summary.claim_outcome, 'VERIFIED');
    const snapshot = () => readdirSync(root).sort().map(name => [name, hash(readFileSync(join(root, name)))]);
    const before = snapshot();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
      import { syncBuiltinESMExports } from 'node:module';
      const denied = () => { throw Error('REPLAY_FORBIDDEN_SIDE_EFFECT'); };
      globalThis.fetch = denied; http.request = denied; https.request = denied; net.connect = denied; net.createConnection = denied; net.createServer = denied;
      for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'renameSync', 'rmSync']) fs[name] = denied;
      const originalOpen = fs.openSync;
      fs.openSync = (path, flags, ...args) => {
        if (/\\.env|keypair|credential|secret/i.test(String(path))) denied();
        if (typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) : !['r', 'rs'].includes(flags)) denied();
        return originalOpen(path, flags, ...args);
      };
      syncBuiltinESMExports();
      const { reconstructFinalEpisodeReleaseV1 } = await import(${JSON.stringify(new URL('./final-episode-release-v1.mjs', import.meta.url).href)});
      process.stdout.write(JSON.stringify(await reconstructFinalEpisodeReleaseV1(JSON.parse(process.argv[1]))));
    `, JSON.stringify(writeRetainedEpisodeFixtureV1(root, fixture))], { encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), result);
    assert.deepEqual(snapshot(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ['wallet', 'signature', 'route', 'quantity', 'history', 'boundary', 'control-label', 'final-episode-relabel']) {
  test(`final episode replay refuses fully rehashed ${scenario} inconsistency`, async () => {
    const { reconstructFinalEpisodeReleaseV1 } = await import('./final-episode-release-v1.mjs');
    const root = mkdtempSync(join(tmpdir(), 'artifact-episode-'));
    try {
      const fixture = retainedEpisodeFixtureV1(), d = fixture.descriptor;
      if (scenario === 'wallet') d.scope.wallet = '5CJdSbz9d5CifzFcWL5NcbicgpSAEuDGpSZBgaLHN1tA';
      if (scenario === 'signature') d.transactions[0].signature = d.transactions[1].signature;
      if (scenario === 'route') d.scope.route_pool = d.scope.wallet;
      if (scenario === 'quantity') {
        const raw = JSON.parse(fixture.files.get('acquisition.json')); raw.result.meta.postTokenBalances[1].uiTokenAmount.amount = '1';
        fixture.files.set('acquisition.json', Buffer.from(JSON.stringify(raw)));
      }
      if (scenario === 'history') {
        const raw = JSON.parse(fixture.files.get('history.json')); raw.result.pop(); fixture.files.set('history.json', Buffer.from(JSON.stringify(raw)));
      }
      if (scenario === 'boundary') {
        const raw = JSON.parse(fixture.files.get('opening-0.json')); raw.result.value = []; fixture.files.set('opening-0.json', Buffer.from(JSON.stringify(raw)));
      }
      if (scenario === 'control-label') d.evidence_kind = 'AUTHENTICATED_FINAL_SUCCESS';
      if (scenario === 'final-episode-relabel') d.evidence_kind = 'SUPERVISED_FINAL_EPISODE';
      await assert.rejects(() => reconstructFinalEpisodeReleaseV1(writeRetainedEpisodeFixtureV1(root, fixture)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('wrong digest-bound selection preserves the existing mismatch exception without manufacturing a claim', async () => {
  const { reconstructFinalEpisodeReleaseV1 } = await import('./final-episode-release-v1.mjs');
  const root = mkdtempSync(join(tmpdir(), 'artifact-episode-'));
  try {
    const fixture = retainedEpisodeFixtureV1();
    fixture.descriptor.selection = { candidate_population_digest: '0'.repeat(64), requested_candidate_digest: '0'.repeat(64) };
    await assert.rejects(() => reconstructFinalEpisodeReleaseV1(writeRetainedEpisodeFixtureV1(root, fixture)),
      error => error.code === 'candidate_population_digest_mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('acquisition-only sources cannot be promoted through the two-leg production bridge', async () => {
  const { reconstructFinalEpisodeReleaseV1 } = await import('./final-episode-release-v1.mjs');
  const root = mkdtempSync(join(tmpdir(), 'artifact-episode-'));
  try {
    const fixture = retainedEpisodeFixtureV1(); fixture.descriptor.transactions.pop();
    const raw = JSON.parse(fixture.files.get('history.json')); raw.result.shift(); fixture.files.set('history.json', Buffer.from(JSON.stringify(raw)));
    await assert.rejects(() => reconstructFinalEpisodeReleaseV1(writeRetainedEpisodeFixtureV1(root, fixture)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
