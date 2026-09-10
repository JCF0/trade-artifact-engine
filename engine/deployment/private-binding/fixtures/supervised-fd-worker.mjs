// Explicit disposable fixture worker. No production configuration input exists.
import { supervisedRuntimeFixtureV1 } from '../../../src/verification-scope-v1-3/final-proof-agent/fixtures/supervised-runtime-offline-v1.mjs';
import { createOfflineSupervisedWigglesRuntimeV1 } from '../../../src/verification-scope-v1-3/final-proof-agent/wiggles-trusted-runtime-v1.mjs';
import { createCrashDurableDecisionAuthorityV1 } from '../../../src/verification-scope-v1-3/final-proof-agent/sqlite-decision-authority-v1.mjs';
import { createSupervisedJournalV1 } from '../../../src/verification-scope-v1-3/final-proof-agent/supervised-journal-v1.mjs';
import { validateDescriptorTableV1, descriptorChannelsV1 } from '../binding.mjs';
import { runFiniteEpisodeV1 } from '../supervisor.mjs';
import { publishRetainedPackageV1 } from '../custody.mjs';
const scenario = process.argv[2];
if (!['wait', 'simulation', 'submission'].includes(scenario)) throw Error('FIXTURE_ONLY');
validateDescriptorTableV1();
const f = supervisedRuntimeFixtureV1(), channels = descriptorChannelsV1();
let runtime, authority, release;
const pause = new Promise(resolve => { release = resolve; });
try {
  const transport = async r => {
    if (scenario === 'simulation' && r.body.method === 'simulateTransaction') {
      process.stdout.write('IN_FLIGHT\n'); await pause;
    }
    return f.transport(r);
  };
  if (scenario === 'submission') f.setHandler(async () => { process.stdout.write('IN_FLIGHT\n'); await pause; throw Error('synthetic-unresolved'); });
  runtime = createOfflineSupervisedWigglesRuntimeV1(f.configuration, { transport, clock: f.source.clock,
    submission: f.submission, supervision: createSupervisedJournalV1(f.stateRoot) });
  authority = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
  const episode_id = `bounded-agent-episode-${f.authorization.authorization_digest}`;
  process.stdout.write(JSON.stringify({ mandate: f.mandate, authorization: f.authorization }) + '\n');
  const supervised = Object.freeze({ ...runtime, supervisor: Object.freeze({ ...runtime.supervisor,
    async issueReadinessChallengeV1(phase) {
      const challenge = await runtime.supervisor.issueReadinessChallengeV1(phase); f.source.time.wall++; return challenge;
    },
    async revokeAuthenticatedBytesV1(bytes) {
      const result = await runtime.supervisor.revokeAuthenticatedBytesV1(bytes);
      release(); return result;
    } }) });
  const output = await runFiniteEpisodeV1({ runtime: supervised, channels,
    humanContext: async () => {
      const s = await authority.loadCurrentEpisodeStateV1({ episode_id });
      return { episode_id, predecessor_state: s.state, predecessor_state_digest: s.state_digest,
        now: f.source.clock.unixSeconds() };
    }, publish: ordinal => publishRetainedPackageV1(runtime, f.stateRoot, ordinal), decision_timeout_ms: 5000, episode_timeout_ms: 15000 });
  const s = await authority.inspectEpisodeV1({ episode_id });
  process.stdout.write(JSON.stringify({ status: output.status, revoked: s.revoked, ordinals: s.ordinals.map(r => ({ ordinal: r.ordinal, stage: r.stage })) }) + '\n');
  // Reopen validates conservative consumed state; no new phase or signing.
  authority.closeV1(); runtime.closeV1(); authority = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
  const reopened = await authority.inspectEpisodeV1({ episode_id });
  if (!reopened.revoked || JSON.stringify(reopened.ordinals) !== JSON.stringify(s.ordinals)) throw Error('FIXTURE_REOPEN_CHANGED');
} finally {
  release(); authority?.closeV1(); runtime?.closeV1(); f.cleanup();
  for (const stream of Object.values(channels)) stream.destroy();
}
