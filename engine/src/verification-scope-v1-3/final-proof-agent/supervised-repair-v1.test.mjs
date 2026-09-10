import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { supervisedRuntimeFixtureV1 } from './fixtures/supervised-runtime-offline-v1.mjs';
import { buildFixedTestAuthorizationV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { buildHumanEpisodeAuthorizationV1, humanAuthorizationSigningBytesV1 } from './human-authorization-v1.mjs';
import { computeCandidateMemberDigestV13 } from '../explicit-candidate-selection.mjs';
const human = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')]) });
function earlyAuthorization(m) {
  const { authorization_version, authorization_id, authorization_digest, signature, ...unsigned } = buildFixedTestAuthorizationV1(m);
  unsigned.issued_at_unix_seconds = m.setup_authority.latest_setup_block_time;
  return buildHumanEpisodeAuthorizationV1({ ...unsigned, signature: sign(null, humanAuthorizationSigningBytesV1(unsigned), human).toString('hex') });
}
function replay(input) {
  const { source_ordinal, ...request } = input;
  const url = new URL('./final-episode-release-v1.mjs', import.meta.url).href;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', `import { reconstructFinalEpisodeReleaseV1 as replay } from ${JSON.stringify(url)}; console.log(JSON.stringify(await replay(JSON.parse(process.argv[1]))));`, JSON.stringify(request)], { cwd: '/tmp', env: {}, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout);
}
async function selected(f, ordinal) {
  const p = await f.runtime.trusted.inspectRetainedExportCandidatesV1(ordinal);
  assert.equal(p.episode_dispositions.length, 1);
  return { candidate_population_digest: p.population_digest, requested_candidate_digest: computeCandidateMemberDigestV13({ candidate_population_digest: p.population_digest, episode_disposition: p.episode_dispositions[0] }) };
}
for (const age of [604801, 10 * 86400]) test(`B1 complete producer closure export replay with distinct in-lookback setup, original age ${age}`, async () => {
  const f = supervisedRuntimeFixtureV1({ opening_time: 1788611228 + age, authorization_factory: earlyAuthorization, distinct_setup: true });
  try {
    f.open();
    for (const ordinal of [1, 2]) {
      await f.sign(ordinal === 1 ? 'ACQUISITION' : 'DISPOSAL');
      assert.equal((await f.runtime.trusted.submitRetainedIntentV1(ordinal)).classification, 'FINALIZED_SUCCESS');
      await f.runtime.trusted.finalizeRetainedIntentV1(ordinal);
    }
    const sources = f.journal.snapshot().records.filter(r => r.kind === 'economic_source');
    assert.deepEqual(sources.map(s => s.setup_transactions.length), [3, 3]);
    assert.deepEqual(sources.map(s => s.descriptor.transactions.length), [1, 2]);
    const input = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 2, selection: await selected(f, 2) });
    const out = replay(input);
    assert.equal(out.control.status, 'AUTHENTICATED');
    assert.equal(out.demonstration.contract_satisfied, true, JSON.stringify(out));
    assert.equal(out.history_admission.rows.length, 9);
    assert.equal(out.history_admission.rows.filter(r => r.classification === 'IN_WINDOW_SETUP_HISTORY').length, 3);
    for (const member of sources[1].members) assert.deepEqual(readFileSync(join(input.root, member.path)), Buffer.from(member.base64, 'base64'));
  } finally { f.cleanup(); }
});
test('B1 seven-day equality remains refused by original finalized evidence even with a later wall clock', async () => {
  const f = supervisedRuntimeFixtureV1({ opening_time: 1788611228 + 604800, authorization_factory: earlyAuthorization });
  try {
    // Construction wall time is eligible; original finalized block remains equality.
    const original = f.source.transport;
    f.source.transport = async r => { const v = JSON.parse(await original(r)); if (r.body.method === 'getBlock') v.result.blockTime = 1788611228 + 604800; return JSON.stringify(v); };
    f.source.time.wall++;
    f.open(); await assert.rejects(f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'), /strict age equality\/ineligibility/);
    assert.equal(f.effects.includes('simulateTransaction') || f.effects.includes('send'), false);
  } finally { f.cleanup(); }
});
