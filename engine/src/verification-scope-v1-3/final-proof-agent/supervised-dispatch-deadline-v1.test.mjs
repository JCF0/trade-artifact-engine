import test from 'node:test';
import assert from 'node:assert/strict';
import { supervisedRuntimeFixtureV1 } from './fixtures/supervised-runtime-offline-v1.mjs';
import { buildFixedTestAgentDecisionV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { canonicalJson } from '../contract.mjs';
import { createCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
for (const boundary of ['already-expired', 'phase-consumption', 'request-retention']) test(`B2 economic source refuses late dispatch: ${boundary}`, async () => {
  const f = supervisedRuntimeFixtureV1();
  try {
    f.configuration.deadline_unix_seconds = f.source.time.wall + 10;
    const expire = () => { f.source.time.wall = f.configuration.deadline_unix_seconds; };
    f.open(j => ({ ...j,
      async claimPhase(phase, ordinal) { j.claimPhase(phase, ordinal); if (phase === 'economic_source' && boundary === 'phase-consumption') { await Promise.resolve(); expire(); } },
      retain(r) { const v = j.retain(r); if (r.kind === 'economic_rpc' && r.record.stage === 'REQUEST_DURABLE_BEFORE_EFFECT' && boundary === 'request-retention') expire(); return v; },
    }));
    await f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION');
    if (boundary === 'already-expired') expire();
    const before = f.effects.length;
    let rejected = false; try { await f.runtime.trusted.captureRetainedOutcomeSourceV1(1); } catch { rejected = true; }
    assert.equal(f.effects.length, before, 'no transport starts outside runtime deadline');
    assert.equal(rejected, true);
    assert.equal(f.journal.snapshot().records.filter(r => r.kind === 'phase_consumed' && r.phase === 'economic_source').length, 1);
    await assert.rejects(f.runtime.trusted.captureRetainedOutcomeSourceV1(1));
    assert.equal(f.effects.length, before, 'no renewed phase');
  } finally { f.cleanup(); }
});
for (const boundary of ['challenge', 'runtime', 'monotonic-freshness']) test(`B2 simulation ${boundary} expiry in durable request retention makes zero late calls`, async () => {
  const f = supervisedRuntimeFixtureV1(); let challenge;
  try {
    if (boundary === 'runtime') f.configuration.deadline_unix_seconds = f.source.time.wall + 10;
    f.open(j => ({ ...j, retain(r) {
      const v = j.retain(r);
      if (r.kind === 'simulation_rpc' && r.record.stage === 'REQUEST_DURABLE_BEFORE_EFFECT') {
        if (boundary === 'monotonic-freshness') f.source.time.mono = f.configuration.budget.capture.freshness_seconds * 1000;
        else f.source.time.wall = boundary === 'runtime' ? f.configuration.deadline_unix_seconds : challenge.expires_at_unix_seconds;
      }
      return v;
    } }));
    challenge = await f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'); f.source.time.wall++;
    if (boundary === 'monotonic-freshness') f.source.time.mono = 29500;
    const bytes = Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge)));
    await assert.rejects(f.runtime.agent.submitDecisionBytesV1(bytes));
    assert.equal(f.effects.includes('simulateTransaction'), false, 'no late simulation transport');
    const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
    try { assert.equal((await a.inspectEpisodeV1({ episode_id: `bounded-agent-episode-${f.authorization.authorization_digest}` })).ordinals[0].stage, 'KEY_LOAD_STARTED_AMBIGUOUS'); }
    finally { a.closeV1(); }
    await assert.rejects(f.runtime.trusted.readRetainedWireV1(1));
    assert.equal(f.journal.snapshot().records.filter(r => r.kind === 'phase_consumed' && r.phase === 'simulation').length, 1);
    f.close();
    if (boundary === 'runtime') assert.throws(() => f.open());
    else { f.open(); await assert.rejects(f.runtime.agent.submitDecisionBytesV1(bytes)); }
    assert.equal(f.effects.includes('simulateTransaction'), false);
  } finally { f.cleanup(); }
});
