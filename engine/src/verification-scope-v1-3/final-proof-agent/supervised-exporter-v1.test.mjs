import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { supervisedRuntimeFixtureV1 } from './fixtures/supervised-runtime-offline-v1.mjs';
import { computeCandidateMemberDigestV13 } from '../explicit-candidate-selection.mjs';
import { buildFixedTestAgentDecisionV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { canonicalJson, sha256CanonicalJson } from '../contract.mjs';
import { createPrivateKey, sign, createHash } from 'node:crypto';
import { createCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from './human-revocation-v1.mjs';
const replayUrl = new URL('./final-episode-release-v1.mjs', import.meta.url).href;
export function replayFresh(input) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { reconstructFinalEpisodeReleaseV1 } from ${JSON.stringify(replayUrl)}; console.log(JSON.stringify(await reconstructFinalEpisodeReleaseV1(JSON.parse(process.argv[1]))));`, JSON.stringify(input)],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, cwd: '/tmp', env: {} });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
test('operational export reconstructs a refused acquisition without signing or submission', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); const challenge = await f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'); f.source.time.wall++;
    const decision = buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge, 'REFUSE_ACQUISITION');
    assert.equal((await f.runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(decision)))).status, 'REFUSED');
    await f.runtime.trusted.captureRetainedOutcomeSourceV1(1);
    const { source_ordinal, ...input } = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 1, selection: null });
    const result = replayFresh(input);
    assert.equal(result.control.state.state, 'AGENT_REFUSED_ACQUISITION');
    assert.equal(result.demonstration.contract_satisfied, false);
    assert.equal(f.effects.includes('simulateTransaction') || f.effects.includes('send'), false);
  } finally { f.cleanup(); }
});
for (const outcome of ['acquisition-only', 'revoked', 'finalized-failure', 'unresolved']) {
  test(`operational export independently reconstructs ${outcome} and preserves consumed authority`, async () => {
    const f = supervisedRuntimeFixtureV1();
    try {
      f.open(); await f.sign();
      if (outcome === 'finalized-failure') {
        const tx = f.transactions[0]; tx.meta.err = { InstructionError: [0, { Custom: 6001 }] };
        tx.meta.innerInstructions = []; tx.meta.postTokenBalances = structuredClone(tx.meta.preTokenBalances);
        tx.meta.postBalances = [...tx.meta.preBalances]; tx.meta.postBalances[0] -= tx.meta.fee;
      }
      if (outcome === 'unresolved') { f.setVisible(false); f.setHandler(() => { throw Error('CONTROLLED_TRANSPORT_FAILURE'); }); }
      const submitted = await f.runtime.trusted.submitRetainedIntentV1(1);
      if (['acquisition-only', 'revoked'].includes(outcome)) await f.runtime.trusted.finalizeRetainedIntentV1(1);
      else await f.runtime.trusted.captureRetainedOutcomeSourceV1(1);
      if (outcome === 'revoked') {
        f.source.time.wall += 10;
        const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot }); let state;
        try { state = await a.loadCurrentEpisodeStateV1({ episode_id: `bounded-agent-episode-${f.authorization.authorization_digest}` }); }
        finally { a.closeV1(); }
        const unsigned = { episode_id: state.episode_id, mandate_digest: f.mandate.mandate_digest,
          authorization_digest: f.authorization.authorization_digest, human_public_key: f.authorization.human_public_key,
          predecessor_state: state.state, predecessor_state_digest: state.state_digest, revoked_at_unix_seconds: f.source.time.wall,
          revocation_nonce: 'supervised-disposable-revocation', revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION' };
        const key = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')]) });
        await f.runtime.supervisor.revokeAuthenticatedBytesV1(Buffer.from(canonicalJson(buildHumanRevocationV1({ ...unsigned,
          signature: sign(null, humanRevocationSigningBytesV1(unsigned), key).toString('hex') }))));
      }
      f.close(); f.open(); const before = f.effects.length;
      await assert.rejects(f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'));
      const repeated = await f.runtime.trusted.submitRetainedIntentV1(1);
      assert.equal(repeated.classification, submitted.classification);
      const { source_ordinal, ...input } = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 1, selection: null });
      const result = replayFresh(input);
      assert.equal(f.effects.length, before);
      assert.equal(result.control.status, outcome === 'revoked' ? 'REVOKED' : 'AUTHENTICATED', JSON.stringify(result.control));
      assert.equal(result.demonstration.contract_satisfied, false);
      if (outcome === 'acquisition-only') assert.equal(result.control.state.state, 'ACQUISITION_EVIDENCE_CLOSED');
      if (outcome === 'revoked') assert.equal(result.control.state.human_revocation_status, 'REVOKED');
      if (outcome === 'finalized-failure') {
        assert.equal(submitted.classification, 'FINALIZED_FAILURE');
        assert.equal(result.economic_observations.transactions[0].execution_state, 'failed');
      }
      if (outcome === 'unresolved') {
        assert.notEqual(submitted.classification, 'FINALIZED_SUCCESS');
        assert.equal(result.control.state.possible_submission, true);
        assert.equal(result.economic_observations.transactions.length, 0);
      }
    } finally { f.cleanup(); }
  });
}
test('source capture retains transaction bodies for setup outside the economic lookback', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); await f.sign(); await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1);
    const source = f.journal.snapshot().records.find(r => r.kind === 'economic_source');
    assert.equal(source.setup_transactions.length, 1);
    assert.equal(source.descriptor.transactions.length, 1);
    const member = source.members.find(m => m.path === source.setup_transactions[0].response);
    assert.equal(JSON.parse(Buffer.from(member.base64, 'base64')).result.blockTime, f.mandate.setup_authority.latest_setup_block_time);
  } finally { f.cleanup(); }
});
test('operational exporter rejects rehashed economic RPC deadline laundering', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); await f.sign(); await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1);
    const { source_ordinal, ...original } = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 1, selection: null });
    const root = join(f.root, 'tampered-export'); cpSync(original.root, root, { recursive: true });
    const read = name => JSON.parse(readFileSync(join(root, name))), write = (name, value) => writeFileSync(join(root, name), canonicalJson(value));
    const control = read('control.json'); let previous = null, changed = false;
    for (const member of control.supervision.journal_members) {
      const entry = read(member);
      if (!changed && entry.record.kind === 'economic_rpc' && entry.record.record.stage === 'RESPONSE_DURABLE') {
        entry.record.record.completed_monotonic_ms += control.supervision.phase_budgets.economic_source.overall_timeout_ms; changed = true;
      }
      entry.previous_sha256 = previous; previous = sha256CanonicalJson(entry); write(member, entry);
    }
    assert.equal(changed, true); control.supervision.head_sha256 = previous; write('control.json', control);
    const manifest = read('manifest.json'), hash = b => createHash('sha256').update(b).digest('hex');
    for (const m of manifest.members) { const bytes = readFileSync(join(root, m.path)); m.bytes = bytes.length; m.sha256 = hash(bytes); }
    write('manifest.json', manifest);
    assert.throws(() => replayFresh({ ...original, root, expected_manifest_sha256: hash(readFileSync(join(root, 'manifest.json'))) }), /RETAINED_SUPERVISION_INVALID/);
  } finally { f.cleanup(); }
});
test('rehashed operational source fee contradicts the authenticated exact-message fee', async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.open(); await f.sign(); await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1);
    const { source_ordinal, ...original } = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 1, selection: null });
    const root = join(f.root, 'fee-contradiction'); cpSync(original.root, root, { recursive: true });
    const read = name => JSON.parse(readFileSync(join(root, name))), write = (name, value) => writeFileSync(join(root, name), canonicalJson(value));
    const control = read('control.json'); let previous = null;
    const change = bytes => {
      const v = JSON.parse(bytes);
      if (v.result?.transaction && v.result.blockTime > f.mandate.setup_authority.latest_setup_block_time) {
        v.result.meta.fee++; v.result.meta.postBalances[0]--;
      }
      return Buffer.from(canonicalJson(v));
    };
    for (const member of control.supervision.journal_members) {
      const entry = read(member), r = entry.record;
      if (r.kind === 'economic_rpc' && r.record.stage === 'RESPONSE_DURABLE') {
        const bytes = change(Buffer.from(r.record.response_base64, 'base64'));
        r.record.response_base64 = bytes.toString('base64'); r.record.response_sha256 = createHash('sha256').update(bytes).digest('hex');
      }
      if (r.kind === 'economic_source') for (const m of r.members) {
        if (!m.path.endsWith('-response.json')) continue;
        const bytes = change(Buffer.from(m.base64, 'base64')); m.base64 = bytes.toString('base64'); writeFileSync(join(root, m.path), bytes);
      }
      entry.previous_sha256 = previous; previous = sha256CanonicalJson(entry); write(member, entry);
    }
    control.supervision.head_sha256 = previous; write('control.json', control);
    const manifest = read('manifest.json'), hash = b => createHash('sha256').update(b).digest('hex');
    for (const m of manifest.members) { const bytes = readFileSync(join(root, m.path)); m.bytes = bytes.length; m.sha256 = hash(bytes); }
    write('manifest.json', manifest);
    const result = replayFresh({ ...original, root, expected_manifest_sha256: hash(readFileSync(join(root, 'manifest.json'))) });
    assert.equal(result.control.status, 'INVALID');
    assert.ok(result.control.issues.some(issue => issue.code === 'FINALIZED_FEE_MISMATCH'), JSON.stringify(result.control));
    assert.equal(result.demonstration.contract_satisfied, false);
  } finally { f.cleanup(); }
});
test('actual supervised composition exports complete bytes for independent fresh-process reconstruction', async () => {
  const f = await supervisedRuntimeFixtureV1();
  try {
    f.open();
    for (const ordinal of [1, 2]) {
      await f.sign(ordinal === 1 ? 'ACQUISITION' : 'DISPOSAL'); await f.runtime.trusted.submitRetainedIntentV1(ordinal); await f.runtime.trusted.finalizeRetainedIntentV1(ordinal);
    }
    const population = await f.runtime.trusted.inspectRetainedExportCandidatesV1(2);
    assert.equal(population.episode_dispositions.length, 1);
    const selection = { candidate_population_digest: population.population_digest,
      requested_candidate_digest: computeCandidateMemberDigestV13({ candidate_population_digest: population.population_digest,
        episode_disposition: population.episode_dispositions[0] }) };
    const { source_ordinal, ...input } = await f.runtime.trusted.exportRetainedEpisodeV1({ ordinal: 2, selection });
    assert.equal(source_ordinal, 2);
    const result = replayFresh(input);
    assert.equal(result.control.status, 'AUTHENTICATED', JSON.stringify(result));
    assert.equal(result.demonstration.contract_satisfied, true, JSON.stringify(result));
    // Rehashing the outer inventory cannot authenticate altered controller intent.
    for (const [name, mutate, controlInvalid] of [
      ['controller', c => { c.legs[1].decision.action = 'REFUSE_DISPOSAL'; }, true],
      ['ordinal', c => { c.legs[1].challenge.ordinal = 1; }, true],
      ['signature', c => { c.legs[1].signed_intent.signature = c.legs[0].signed_intent.signature; }, true],
      ['inventory-provenance', c => { c.legs[1].record_members.pop(); }, false],
      ['transmission-binding', c => { c.legs[1].submission_members = c.legs[1].submission_members.filter(m => m.path !== 'binding.json'); }, false],
    ]) {
      const alteredRoot = join(f.root, `altered-${name}`); cpSync(input.root, alteredRoot, { recursive: true });
      const alteredControl = JSON.parse(readFileSync(join(alteredRoot, 'control.json'))); mutate(alteredControl);
      writeFileSync(join(alteredRoot, 'control.json'), canonicalJson(alteredControl));
      const inventory = JSON.parse(readFileSync(join(alteredRoot, 'manifest.json'))), hash = bytes => createHash('sha256').update(bytes).digest('hex');
      for (const member of inventory.members) { const bytes = readFileSync(join(alteredRoot, member.path)); member.bytes = bytes.length; member.sha256 = hash(bytes); }
      writeFileSync(join(alteredRoot, 'manifest.json'), canonicalJson(inventory));
      const rejected = replayFresh({ ...input, root: alteredRoot, expected_manifest_sha256: hash(readFileSync(join(alteredRoot, 'manifest.json'))) });
      if (name === 'inventory-provenance') assert.equal(rejected.eligibility.legs[1].status, 'INELIGIBLE', name);
      else if (controlInvalid) assert.equal(rejected.control.status, 'INVALID', name);
      else assert.notEqual(rejected.transmission.status, 'RECONCILED', name);
      assert.equal(rejected.demonstration.contract_satisfied, false, name);
    }
    assert.equal(result.demo_summary.synthetic_demonstration_success, true);
    assert.equal(result.demo_summary.full_demonstration_success, false);
    assert.deepEqual(result.transmission.legs.map(l => l.status), ['RECONCILED', 'RECONCILED']);
    if (process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT) {
      const parent = process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT; mkdirSync(parent, { recursive: true, mode: 0o700 });
      const root = mkdtempSync(join(parent, 'complete-export-')); cpSync(input.root, join(root, 'package'), { recursive: true });
      writeFileSync(join(root, 'reconstruction.json'), JSON.stringify(result, null, 2) + '\n');
      writeFileSync(join(root, 'input.json'), JSON.stringify({ ...input, root: join(root, 'package') }, null, 2) + '\n');
      console.log(`Retained composition-export-replay evidence: ${root}`);
    }
  } finally { f.cleanup(); }
});
