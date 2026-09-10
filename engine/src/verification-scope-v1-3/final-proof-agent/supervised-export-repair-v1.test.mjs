import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivateKey, sign, createHash } from 'node:crypto';
import { supervisedRuntimeFixtureV1 } from './fixtures/supervised-runtime-offline-v1.mjs';
import { buildFixedTestAgentDecisionV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { canonicalJson, sha256CanonicalJson } from '../contract.mjs';
import { createCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from './human-revocation-v1.mjs';
import { computeCandidateMemberDigestV13 } from '../explicit-candidate-selection.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const human = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')]) });
async function revocation(f) {
  const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot }); let state;
  try { state = await a.loadCurrentEpisodeStateV1({ episode_id: `bounded-agent-episode-${f.authorization.authorization_digest}` }); }
  finally { a.closeV1(); }
  const unsigned = { episode_id: state.episode_id, mandate_digest: f.mandate.mandate_digest, authorization_digest: f.authorization.authorization_digest,
    human_public_key: f.authorization.human_public_key, predecessor_state: state.state, predecessor_state_digest: state.state_digest,
    revoked_at_unix_seconds: f.source.time.wall, revocation_nonce: 'supervised-repair-revocation', revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION' };
  return Buffer.from(canonicalJson(buildHumanRevocationV1({ ...unsigned, signature: sign(null, humanRevocationSigningBytesV1(unsigned), human).toString('hex') })));
}
function replay(input, rejected = false) {
  const { source_ordinal, ...request } = input;
  const url = new URL('./final-episode-release-v1.mjs', import.meta.url).href;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', `import { reconstructFinalEpisodeReleaseV1 as replay } from ${JSON.stringify(url)}; console.log(JSON.stringify(await replay(JSON.parse(process.argv[1]))));`, JSON.stringify(request)], { cwd: '/tmp', env: {}, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (rejected) { assert.notEqual(p.status, 0, p.stdout); assert.match(p.stderr, /REVOCATION|RETAINED_SUPERVISION_INVALID/); return; }
  assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout);
}
async function acquire(f) { await f.sign(); await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1); }
async function selection(f) { const p = await f.runtime.trusted.inspectRetainedExportCandidatesV1(2); return { candidate_population_digest: p.population_digest,
  requested_candidate_digest: computeCandidateMemberDigestV13({ candidate_population_digest: p.population_digest, episode_disposition: p.episode_dispositions[0] }) }; }
function tamper(input, parent, name, mutate) {
  const root = join(parent, name); cpSync(input.root, root, { recursive: true });
  const path = join(root, 'control.json'), c = JSON.parse(readFileSync(path)); mutate(c); writeFileSync(path, canonicalJson(c));
  const mp = join(root, 'manifest.json'), m = JSON.parse(readFileSync(mp));
  for (const row of m.members) { const b = readFileSync(join(root, row.path)); row.bytes = b.length; row.sha256 = hash(b); }
  writeFileSync(mp, canonicalJson(m)); return { ...input, root, expected_manifest_sha256: hash(readFileSync(mp)) };
}
test('B4 export selects durable admitted request between authenticated rejected deliveries', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); let invalid;
    const { decision } = await f.sign('ACQUISITION', async challenge => {
      invalid = Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, { ...challenge, challenge_nonce: 'invalid-context-but-authenticated' })));
      await assert.rejects(f.runtime.agent.submitDecisionBytesV1(invalid), /context|challenge/i);
      const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
      try { assert.equal((await a.inspectEpisodeV1({ episode_id: challenge.episode_id })).ordinals.length, 0); }
      finally { a.closeV1(); }
    });
    await assert.rejects(f.runtime.agent.submitDecisionBytesV1(invalid));
    await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1);
    f.close(); f.open();
    const input = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 1, selection: null });
    const c = JSON.parse(readFileSync(join(input.root, 'control.json')));
    const requests = c.supervision.journal_members.map(m => JSON.parse(readFileSync(join(input.root, m))).record).filter(r => r.kind === 'authenticated_decision_request');
    assert.equal(requests.length, 3);
    assert.deepEqual(c.legs[0].decision, decision);
    assert.notEqual(requests[0].record.decision.decision_id, decision.decision_id);
    assert.notEqual(requests.at(-1).record.decision.decision_id, decision.decision_id);
    assert.equal(replay(input).control.state.state, 'ACQUISITION_EVIDENCE_CLOSED');
    assert.equal(f.effects.filter(e => e === 'simulateTransaction').length, 1);
  } finally { f.cleanup(); }
});
test('B6 original unselected export survives digest-bound selected derived export of the same ordinal', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); await acquire(f); await f.sign('DISPOSAL');
    await f.runtime.trusted.submitRetainedIntentV1(2); await f.runtime.trusted.finalizeRetainedIntentV1(2);
    const original = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 2, selection: null });
    const before = Object.fromEntries(readdirSync(original.root).map(p => [p, readFileSync(join(original.root, p))]));
    const unselected = replay(original); assert.equal(unselected.demonstration.contract_satisfied, false);
    f.close(); f.open(); const chosen = await selection(f);
    await assert.rejects(f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 2, selection: { ...chosen, candidate_population_digest: '0'.repeat(64) } }));
    const derived = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 2, selection: chosen });
    assert.notEqual(derived.root, original.root);
    assert.equal(replay(derived).demonstration.contract_satisfied, true);
    assert.equal(replay(original).demonstration.contract_satisfied, false);
    assert.deepEqual(Object.fromEntries(readdirSync(original.root).map(p => [p, readFileSync(join(original.root, p))])), before);
    for (const [p, b] of Object.entries(before)) if (!['manifest.json', 'episode.json'].includes(p)) assert.deepEqual(readFileSync(join(derived.root, p)), b, p);
    assert.deepEqual(JSON.parse(readFileSync(join(derived.root, 'episode.json'))).selection, chosen);
    assert.equal(f.effects.filter(e => e === 'simulateTransaction').length, 2);
    await assert.rejects(f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 2, selection: chosen }), /EEXIST/);
  } finally { f.cleanup(); }
});
test('B5 exact revocation delivery survives reopen and ALREADY_REVOKED replay with both records retained', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); await acquire(f); f.source.time.wall += 10;
    const bytes = await revocation(f);
    assert.equal((await f.runtime.supervisor.revokeAuthenticatedBytesV1(bytes)).revocation_result, 'REVOKED');
    f.close(); f.open();
    assert.equal((await f.runtime.supervisor.revokeAuthenticatedBytesV1(bytes)).revocation_result, 'ALREADY_REVOKED');
    const conflicting = JSON.parse(bytes); conflicting.revocation_digest = '0'.repeat(64);
    await assert.rejects(f.runtime.supervisor.revokeAuthenticatedBytesV1(Buffer.from(canonicalJson(conflicting))));
    const input = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 1, selection: null });
    const c = JSON.parse(readFileSync(join(input.root, 'control.json')));
    const deliveries = c.supervision.journal_members.map(m => JSON.parse(readFileSync(join(input.root, m))).record).filter(r => r.kind === 'revocation');
    assert.equal(deliveries.length, 2);
    assert.deepEqual(deliveries.map(r => r.revocation_bytes_base64), [bytes.toString('base64'), bytes.toString('base64')]);
    const result = replay(input); assert.equal(result.control.status, 'REVOKED');
    assert.equal(result.control.revocation_status, 'AUTHENTICATED');
    assert.equal(result.demonstration.contract_satisfied, false);
  } finally { f.cleanup(); }
});
test('B3 committed revocation interrupted before wrapper retention cannot export as unrevoked after reopen', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(j => ({ ...j, retain(r) { if (r.kind === 'revocation') throw Error('INTERRUPTED_AFTER_AUTHORITY_COMMIT'); return j.retain(r); } }));
    await acquire(f); f.source.time.wall += 10;
    await assert.rejects(f.runtime.supervisor.revokeAuthenticatedBytesV1(await revocation(f)), /INTERRUPTED_AFTER_AUTHORITY_COMMIT/);
    assert.equal(f.journal.snapshot().records.filter(r => r.kind === 'revocation').length, 0);
    f.close(); f.open();
    const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
    try { assert.equal((await a.inspectEpisodeV1({ episode_id: `bounded-agent-episode-${f.authorization.authorization_digest}` })).revoked, true); }
    finally { a.closeV1(); }
    await assert.rejects(f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 1, selection: null }), /REVOCATION_EVIDENCE_INCOMPLETE/);
  } finally { f.cleanup(); }
});
test('B3 rehashed null or contradictory control revocation cannot override retained authenticated journal evidence', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); await acquire(f); f.source.time.wall += 10;
    await f.runtime.supervisor.revokeAuthenticatedBytesV1(await revocation(f));
    const input = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 1, selection: null });
    assert.equal(replay(input).control.status, 'REVOKED');
    replay(tamper(input, f.root, 'null-revocation', c => { c.revocation = null; }), true);
    replay(tamper(input, f.root, 'contradictory-revocation', c => { c.revocation.revoked_at_unix_seconds++; }), true);
  } finally { f.cleanup(); }
});
test('B3 disposal revoked after dispatch retains later finalized economics without demonstration success', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); await acquire(f); await f.sign('DISPOSAL');
    f.setHandler(async r => {
      const raw = f.transactions.at(-1);
      if (r.kind === 'send') { await f.runtime.supervisor.revokeAuthenticatedBytesV1(await revocation(f)); f.setHandler(null); }
      return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: r.expectedSignature })) };
    });
    await f.runtime.trusted.submitRetainedIntentV1(2);
    await f.runtime.trusted.finalizeRetainedIntentV1(2);
    f.close(); f.open();
    const input = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 2, selection: await selection(f) });
    const result = replay(input);
    assert.equal(result.economic_observations.transactions.length, 2);
    assert.equal(result.control.status, 'REVOKED', JSON.stringify(result));
    assert.equal(result.control.state.human_revocation_status, 'REVOKED');
    assert.equal(result.demonstration.contract_satisfied, false);
    replay(tamper(input, f.root, 'disposal-null-revocation', c => { c.revocation = null; }), true);
  } finally { f.cleanup(); }
});
