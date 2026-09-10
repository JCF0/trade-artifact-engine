import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { decodeFixedWhirlpoolV1 } from '../../../../orca-readiness-sdk/index.mjs';
import { syntheticSupervisedFinalizedTransactionV1 } from './supervised-finalized-offline-v1.mjs';
import { inspectSignedLegacyWire } from '../reused/bounded-rebroadcast-v1.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedTestMandateInputV1, buildFixedTestAuthorizationV1, buildFixedTestAgentDecisionV1 } from './fixed-test-identities-v1.mjs';
import { syntheticRuntimeCaptureV1 } from './trusted-runtime-offline-v1.mjs';
import { buildOfflineWalletMandateV1 } from '../executor-mandate-profile-v1.mjs';
import { createAuthorizedEpisodeStateV1 } from '../episode-state-machine-v1.mjs';
import { provisionCrashDurableDecisionAuthorityV1 } from '../sqlite-decision-authority-v1.mjs';
import { createOfflineSupervisedWigglesRuntimeV1 } from '../wiggles-trusted-runtime-v1.mjs';
import { createSupervisedJournalV1, provisionSupervisedJournalV1 } from '../supervised-journal-v1.mjs';
import { SUPERVISED_BUDGET_VERSION_V1, SUPERVISED_SUBMISSION_PROFILE_V1, createSupervisedSubmissionTransportV1 } from '../supervised-profile-v1.mjs';
import { canonicalJson, sha256CanonicalJson } from '../../contract.mjs';
// Disposable synthetic identities and controlled in-process effects only.
export function supervisedRuntimeFixtureV1({ opening_time, authorization_factory = buildFixedTestAuthorizationV1, distinct_setup = false } = {}) {
  const input = fixedTestMandateInputV1(), source = syntheticRuntimeCaptureV1(buildOfflineWalletMandateV1(input));
  const budget = { version: SUPERVISED_BUDGET_VERSION_V1, capture: source.budget,
    simulation: { total_calls: 1, call_timeout_ms: 1000, overall_timeout_ms: 1000, max_response_bytes: 1048576, methods: { simulateTransaction: 1 } },
    submission: { profile: SUPERVISED_SUBMISSION_PROFILE_V1, max_calls: 188, overall_timeout_ms: 190000, max_response_bytes: 1048576 },
    economic_source: { total_calls: 128, call_timeout_ms: 1000, overall_timeout_ms: 60000, max_response_bytes: 1048576,
      methods: { getGenesisHash: 1, getSlot: 1, getBlock: 32, getTokenAccountsByOwner: 6, getSignaturesForAddress: 32, getTransaction: 32 } } };
  input.offline_identity.rpc_budget_table_sha256 = sha256CanonicalJson(budget);
  input.unresolved_live_readiness = { ...input.offline_identity, status: 'RESOLVED' }; delete input.unresolved_live_readiness.profile;
  const mandate = buildOfflineWalletMandateV1(input), authorization = authorization_factory(mandate);
  if (opening_time !== undefined) source.time.wall = opening_time;
  const root = mkdtempSync(join(tmpdir(), 'artifact-supervised-fixture-')), stateRoot = join(root, 'authority');
  mkdirSync(stateRoot, { mode: 0o700 });
  const keyPath = join(root, 'disposable-key.json');
  writeFileSync(keyPath, JSON.stringify([...Keypair.fromSeed(Buffer.alloc(32, 7)).secretKey]), { mode: 0o600 });
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  provisionCrashDurableDecisionAuthorityV1({ state_root: stateRoot, initial_episode_state: state, executor_release_sha256: authorization.executor_release_sha256 });
  provisionSupervisedJournalV1(stateRoot);
  const configuration = { mandate, authorization, executor_release_sha256: authorization.executor_release_sha256,
    expected_wallet: mandate.wallet_scope.wallet, wallet_key_path: keyPath, state_root: stateRoot, budget, deadline_unix_seconds: 2000000000 };
  let runtime, journal, wire, simulationError = null, handler, phaseOrdinal = 1, acquired = null, visible = true;
  const setupTx = new Transaction({ feePayer: new PublicKey(mandate.wallet_scope.wallet), recentBlockhash: new PublicKey(Buffer.alloc(32, 8)).toBase58() });
  for (const toPubkey of [mandate.wallet_scope.jup_ata, mandate.wallet_scope.usdc_ata]) setupTx.add(SystemProgram.transfer({
    fromPubkey: new PublicKey(mandate.wallet_scope.wallet), toPubkey: new PublicKey(toPubkey), lamports: 1 }));
  setupTx.sign(Keypair.fromSeed(Buffer.alloc(32, 7))); const setupWire = setupTx.serialize();
  const setupSignature = inspectSignedLegacyWire(setupWire.toString('base64')).expectedSignature;
  const setupBody = { slot: 1, blockTime: mandate.setup_authority.latest_setup_block_time, version: 'legacy',
    transaction: [setupWire.toString('base64'), 'base64'], meta: { err: null, fee: 5000,
      preBalances: [1000000, 2039280, 2039280, 0], postBalances: [994998, 2039281, 2039281, 0],
      preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: [], rewards: [], loadedAddresses: { writable: [], readonly: [] } } };
  const transactions = [];
  const setups = new Map([[setupSignature, setupBody]]);
  const setupByAddress = new Map();
  if (distinct_setup) for (const [i, address] of [mandate.wallet_scope.jup_ata, mandate.wallet_scope.usdc_ata].entries()) {
    const tx = new Transaction({ feePayer: new PublicKey(mandate.wallet_scope.wallet), recentBlockhash: new PublicKey(Buffer.alloc(32, 10 + i)).toBase58() });
    tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(mandate.wallet_scope.wallet), toPubkey: new PublicKey(address), lamports: 1 }));
    tx.sign(Keypair.fromSeed(Buffer.alloc(32, 7)));
    const bytes = tx.serialize(), signature = inspectSignedLegacyWire(bytes.toString('base64')).expectedSignature;
    const body = { ...setupBody, blockTime: setupBody.blockTime - i - 1, transaction: [bytes.toString('base64'), 'base64'],
      meta: { ...setupBody.meta, preBalances: [1000000, 2039280, 0], postBalances: [994999, 2039281, 0] } };
    setups.set(signature, body); setupByAddress.set(address, signature);
  }
  const effects = [];
  const transport = async r => {
    effects.push(r.body.method);
    const economic = String(r.body.id).startsWith('economic-'), slot = economic ? (transactions.at(-1)?.slot ?? 900000000) + 2 : 900000000 + (phaseOrdinal - 1) * 20;
    if (r.body.method === 'simulateTransaction') return JSON.stringify({ jsonrpc: '2.0', id: r.body.id,
      result: { context: { slot }, value: { err: simulationError, unitsConsumed: 1000, logs: [] } } });
    if (r.body.method === 'getTransaction') {
      if (setups.has(r.body.params[0])) return JSON.stringify({ jsonrpc: '2.0', id: r.body.id, result: setups.get(r.body.params[0]) });
      const raw = visible ? transactions.find(t => inspectSignedLegacyWire(t.transaction[0]).expectedSignature === r.body.params[0]) : null;
      return JSON.stringify({ jsonrpc: '2.0', id: r.body.id, result: raw ?? null });
    }
    const envelope = JSON.parse(await source.transport(r)), result = envelope.result;
    if (r.body.method === 'getSignaturesForAddress') for (const row of result) {
      row.signature = setupByAddress.get(r.body.params[0]) ?? setupSignature;
      row.blockTime = setups.get(row.signature).blockTime;
    }
    if (result?.context) result.context.slot = slot;
    if (r.body.method === 'getSlot') envelope.result = slot;
    if (economic && r.body.method === 'getBlock') result.blockTime = (transactions.at(-1)?.blockTime ?? source.time.wall) + 2;
    if (visible && r.body.method === 'getSignaturesForAddress' && !r.body.params[1].before) result.unshift(...[...transactions].reverse().map(t => ({
      signature: inspectSignedLegacyWire(t.transaction[0]).expectedSignature, slot: t.slot, blockTime: t.blockTime, err: t.meta.err, memo: null, confirmationStatus: 'finalized' })));
    if (phaseOrdinal === 2 && r.body.method === 'getMultipleAccounts' && r.body.params[0].length === 6) {
      const pool = decodeFixedWhirlpoolV1(Buffer.from(result.value[0].data[0], 'base64'));
      const width = pool.tickSpacing * 88, base = Math.floor(pool.tickCurrentIndex / width) * width;
      result.value.slice(1, 4).forEach((a, i) => { const b = Buffer.from(a.data[0], 'base64'); b.writeInt32LE(base - i * width, 8); a.data[0] = b.toString('base64'); });
    }
    if (phaseOrdinal === 2 || economic) {
      const update = a => { const b = Buffer.from(a.data[0], 'base64'), target = new PublicKey(mandate.asset_scope.jup_mint).toBuffer().equals(b.subarray(0, 32));
        const successfulAcquisition = visible && transactions[0]?.meta.err === null;
        b.writeBigUInt64LE(target ? BigInt(!successfulAcquisition || (economic && phaseOrdinal === 2) ? '0' : acquired)
          : successfulAcquisition ? 1000000n : 6000000n, 64); a.data[0] = b.toString('base64'); };
      if (r.body.method === 'getTokenAccountsByOwner') result.value.forEach(row => update(row.account));
      if (r.body.method === 'getMultipleAccounts' && r.body.params[0].length === 3) { result.value[0].lamports = 815624; result.value.slice(1).forEach(update); }
    }
    return JSON.stringify(envelope);
  };
  const submission = { ...budget.submission, sleep: async ms => { source.time.mono += ms; },
    transport: createSupervisedSubmissionTransportV1(r => {
      effects.push(r.kind);
      if (handler) return handler(r);
      const raw = transactions.at(-1);
      const result = r.kind === 'send' ? r.expectedSignature : r.kind === 'status'
        ? { context: { slot: raw.slot }, value: [{ slot: raw.slot, confirmations: null, err: raw.meta.err, confirmationStatus: 'finalized' }] }
        : r.kind === 'blockHeight' ? 900000000 : raw;
      return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: r.id, result })) };
    }) };
  const f = { root, stateRoot, keyPath, mandate, authorization, configuration, source, effects, transport, submission, transactions,
    get runtime() { return runtime; }, get journal() { return journal; }, get wire() { return wire; },
    setSimulationError(v) { simulationError = v; }, setHandler(v) { handler = v; },
    setVisible(v) { visible = v; },
    open(wrapJournal = j => j, wrapDependencies = d => d) { journal = createSupervisedJournalV1(stateRoot); runtime = createOfflineSupervisedWigglesRuntimeV1(configuration,
      wrapDependencies({ transport, clock: source.clock, submission, supervision: wrapJournal(journal) })); return runtime; },
    close() { runtime?.closeV1(); runtime = undefined; },
    async sign(phase = 'ACQUISITION', beforeDecision = async () => {}) {
      phaseOrdinal = phase === 'ACQUISITION' ? 1 : 2;
      if (phaseOrdinal === 2) { source.time.wall += 20; source.time.mono += 20000; }
      const challenge = await runtime.supervisor.issueReadinessChallengeV1(phase); source.time.wall++;
      await beforeDecision(challenge);
      const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
      const result = await runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(decision)));
      wire = await runtime.trusted.readRetainedWireV1(phase === 'ACQUISITION' ? 1 : 2);
      const captured = journal.snapshot().records.filter(r => r.kind === 'readiness' && r.record.challenge?.ordinal === phaseOrdinal).at(-1).record;
      transactions.push(syntheticSupervisedFinalizedTransactionV1(mandate, wire, phase, phaseOrdinal === 1 ? '5000000' : acquired,
        captured.source.quoted_output_raw, 900000010 + (phaseOrdinal - 1) * 20, source.time.wall + 5));
      if (phaseOrdinal === 1) acquired = captured.source.quoted_output_raw;
      return { challenge, decision, result };
    },
    cleanup() { f.close(); rmSync(root, { recursive: true, force: true }); },
  };
  return f;
}
