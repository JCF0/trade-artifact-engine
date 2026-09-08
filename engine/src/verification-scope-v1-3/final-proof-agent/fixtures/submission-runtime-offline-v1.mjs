import { Keypair } from '@solana/web3.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedTestMandateInputV1, buildFixedTestAuthorizationV1, buildFixedTestAgentDecisionV1 } from './fixed-test-identities-v1.mjs';
import { syntheticRuntimeCaptureV1 } from './trusted-runtime-offline-v1.mjs';
import { buildOfflineWalletMandateV1 } from '../executor-mandate-profile-v1.mjs';
import { createAuthorizedEpisodeStateV1 } from '../episode-state-machine-v1.mjs';
import { provisionCrashDurableDecisionAuthorityV1 } from '../sqlite-decision-authority-v1.mjs';
import { createOfflineTrustedWigglesRuntimeV1 } from '../wiggles-trusted-runtime-v1.mjs';
import { canonicalJson, sha256CanonicalJson } from '../../contract.mjs';

// Transport-only synthetic source and disposable deterministic key. Never RPC.
export function submissionRuntimeFixtureV1() {
  const input = fixedTestMandateInputV1();
  const source = syntheticRuntimeCaptureV1(buildOfflineWalletMandateV1(input));
  input.offline_identity.rpc_budget_table_sha256 = sha256CanonicalJson(source.budget);
  input.unresolved_live_readiness = { ...input.offline_identity, status: 'RESOLVED' };
  delete input.unresolved_live_readiness.profile;
  const mandate = buildOfflineWalletMandateV1(input), authorization = buildFixedTestAuthorizationV1(mandate);
  const root = mkdtempSync(join(tmpdir(), 'artifact-submission-test-')), stateRoot = join(root, 'authority');
  mkdirSync(stateRoot, { mode: 0o700 });
  const keyPath = join(root, 'disposable-key.json');
  writeFileSync(keyPath, JSON.stringify([...Keypair.fromSeed(Buffer.alloc(32, 7)).secretKey]), { mode: 0o600 });
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  provisionCrashDurableDecisionAuthorityV1({ state_root: stateRoot, initial_episode_state: state,
    executor_release_sha256: authorization.executor_release_sha256 });
  const configuration = { mandate, authorization, executor_release_sha256: authorization.executor_release_sha256,
    expected_wallet: mandate.wallet_scope.wallet, wallet_key_path: keyPath, state_root: stateRoot,
    budget: source.budget, deadline_unix_seconds: 2000000000 };
  const calls = []; let wire, runtime, handler;
  const rpc = (r, result) => ({ status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: r.id, result })) });
  const defaultHandler = r => {
    if (r.kind === 'send') return rpc(r, r.expectedSignature);
    if (r.kind === 'status') return rpc(r, { context: { slot: 900000010 }, value: r.ordinal < 1000 ? [null]
      : [{ slot: 900000010, confirmations: null, err: null, confirmationStatus: 'finalized' }] });
    if (r.kind === 'blockHeight') return rpc(r, 900000000);
    if (r.kind === 'transaction') return rpc(r, { slot: 900000010, transaction: [wire.toString('base64'), 'base64'], meta: { err: null } });
    throw Error('unexpected fixture call');
  };
  const submission = { profile: 'OFFLINE_INJECTED_SUBMISSION_V1', max_calls: 188,
    overall_timeout_ms: 190000, max_response_bytes: 1048576,
    sleep: async ms => { source.time.mono += ms; },
    transport: async request => { calls.push(request); return (handler ?? defaultHandler)(request); } };
  const fixture = { root, stateRoot, keyPath, state, mandate, authorization, configuration, source, submission, calls, rpc, defaultHandler,
    setHandler(value) { handler = value; },
    get runtime() { return runtime; }, get wire() { return wire; },
    open() { runtime = createOfflineTrustedWigglesRuntimeV1(configuration, { ...source, submission }); return runtime; },
    close() { runtime?.closeV1(); runtime = undefined; },
    async sign(phase = 'ACQUISITION') {
      const challenge = await runtime.supervisor.issueReadinessChallengeV1(phase);
      source.time.wall++;
      await runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(mandate, authorization, challenge))));
      wire = await runtime.trusted.readRetainedWireV1(phase === 'ACQUISITION' ? 1 : 2);
      return challenge;
    },
    cleanup() { fixture.close(); rmSync(root, { recursive: true, force: true }); } };
  return fixture;
}
