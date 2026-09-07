import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalJson, sha256CanonicalJson } from '../contract.mjs';
import { createOfflineAcquisitionClosurePortV1 } from './acquisition-closure-authority-v1.mjs';
import { agentDecisionSigningBytesV1, buildAuthenticatedAgentDecisionV1 } from './agent-decision-v1.mjs';
import { buildFinalizedLegEvidenceV1 } from './episode-evidence-graph-v1.mjs';
import { applyHumanRevocationV1, createAuthorizedEpisodeStateV1 } from './episode-state-machine-v1.mjs';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from './human-revocation-v1.mjs';
import { buildBoundedAgentMandateV1 } from './mandate-v1.mjs';
import {
  createCrashDurableDecisionAuthorityV1,
  provisionCrashDurableDecisionAuthorityV1,
} from './sqlite-decision-authority-v1.mjs';
import { createWigglesAuthenticatedControlPlaneV1 } from './wiggles-authenticated-control-plane-v1.mjs';
import { encodeBase58 } from './reused/bounded-rebroadcast-v1.mjs';
import {
  FIXED_TEST_AGENT_PUBLIC_KEY_V1,
  FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
  buildFixedTestAuthorizationV1,
  buildFixedTestChallengeV1,
  fixedTestMandateInputV1,
} from './fixtures/fixed-test-identities-v1.mjs';
import { createSyntheticAcquisitionAuthorityFixtureV1 } from './fixtures/bounded-agent-offline-v1.mjs';

const HUMAN_SEED = '9d61b19deffd5a60ba844af492ec2cc4' + '4449c5697b326919703bac031cae7f60';
const AGENT_SEED = '4ccd089b28ff96da9db6c346ec114e0f' + '5b8a319f35aba624da8cf6ed4fb8a6fb';
const ATTACKER_SEED = '1'.repeat(64);
function key(seed) {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]),
    format: 'der', type: 'pkcs8',
  });
}
function signBytes(seed, bytes) { return sign(null, bytes, key(seed)).toString('hex'); }
function publicKeyHex(seed) { return createPublicKey(key(seed)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'); }
function signedLegacyFixture() {
  const privateKey = key(AGENT_SEED);
  const signer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const message = Buffer.concat([Buffer.from([1, 0, 0, 1]), signer, Buffer.alloc(32, 7), Buffer.from([0])]);
  const signatureBytes = sign(null, message, privateKey);
  return {
    wire: Buffer.concat([Buffer.from([1]), signatureBytes, message]),
    message_sha256: createHash('sha256').update(message).digest('hex'),
    signature: encodeBase58(signatureBytes),
  };
}
function liveMandate() {
  const input = fixedTestMandateInputV1();
  input.unresolved_live_readiness = {
    human_authorization_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
    agent_control_public_key: FIXED_TEST_AGENT_PUBLIC_KEY_V1,
    acquisition_not_after_unix_seconds: input.offline_identity.acquisition_not_after_unix_seconds,
    rpc_budget_table_sha256: input.offline_identity.rpc_budget_table_sha256,
    executor_release_sha256: input.offline_identity.executor_release_sha256,
    status: 'RESOLVED',
  };
  return buildBoundedAgentMandateV1(input);
}
function decision(mandate, authorization, challenge, overrides = {}) {
  const unsigned = {
    episode_id: challenge.episode_id,
    action: 'INITIATE_ACQUISITION',
    ordinal: challenge.ordinal,
    mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest,
    challenge_digest: challenge.challenge_digest,
    predecessor_state_digest: challenge.predecessor_state_digest,
    executor_release_sha256: challenge.executor_release_sha256,
    challenge_nonce: challenge.challenge_nonce,
    agent_public_key: FIXED_TEST_AGENT_PUBLIC_KEY_V1,
    signed_at_unix_seconds: challenge.issued_at_unix_seconds + 1,
    ...overrides,
  };
  return buildAuthenticatedAgentDecisionV1({
    ...unsigned,
    signature: signBytes(AGENT_SEED, agentDecisionSigningBytesV1(unsigned)),
  });
}
async function withHarness(run, { pause_signer = false, pause_after_signed_durable = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-wiggles-control-'));
  const mandate = liveMandate();
  const authorization = buildFixedTestAuthorizationV1(mandate);
  const initialState = createAuthorizedEpisodeStateV1({ mandate, authorization });
  provisionCrashDurableDecisionAuthorityV1({
    state_root: root,
    initial_episode_state: initialState,
    executor_release_sha256: mandate.unresolved_live_readiness.executor_release_sha256,
  });
  const authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  const calls = { prepare: 0, load: 0, sign: 0 };
  let markSignerStarted;
  let releaseSigner;
  const signerStarted = new Promise(resolve => { markSignerStarted = resolve; });
  const signerReleased = new Promise(resolve => { releaseSigner = resolve; });
  const signerControl = Object.freeze({ signerStarted, releaseSigner });
  let markSignedDurable;
  let releaseSignedDurable;
  const signedDurableStarted = new Promise(resolve => { markSignedDurable = resolve; });
  const signedDurableReleased = new Promise(resolve => { releaseSignedDurable = resolve; });
  const signedDurableControl = Object.freeze({ signedDurableStarted, releaseSignedDurable });
  const durableAuthorityPort = Object.freeze({
    ...authority,
    async recordSignedIntentDurableV1(value) {
      const result = await authority.recordSignedIntentDurableV1(value);
      markSignedDurable();
      if (pause_after_signed_durable) await signedDurableReleased;
      return result;
    },
  });
  let challengeCounter = 0;
  const signedFixture = signedLegacyFixture();
  const acquisitionSource = await createSyntheticAcquisitionAuthorityFixtureV1(mandate, { signature: signedFixture.signature });
  const acquisitionClosurePort = createOfflineAcquisitionClosurePortV1({
    async capture_authority(request) {
      const source = acquisitionSource;
      const transaction = source.transactions[0];
      return {
        context: source.context,
        context_authority: source.context_authority,
        exact_quote_mint: source.exact_quote_mint,
        finalized_acquisition: buildFinalizedLegEvidenceV1({
          episode_id: request.episode_id,
          phase: 'ACQUISITION',
          signed_intent_digest: request.signed_intent_digest,
          signed_wire_sha256: request.signed_wire_sha256,
          message_sha256: signedFixture.message_sha256,
          signature: transaction.signature,
          finalized_transaction_digest: sha256CanonicalJson(transaction),
          slot: transaction.slot,
          block_time: transaction.block_time,
          execution_status: 'SUCCEEDED',
          wallet: mandate.wallet_scope.wallet,
          input_mint: mandate.asset_scope.usdc_mint,
          output_mint: mandate.asset_scope.jup_mint,
          input_raw_quantity: mandate.economic_authority.acquisition_input_usdc_raw,
          chain_derived_target_raw_quantity: '21437310',
        }),
      };
    },
  });
  const control = createWigglesAuthenticatedControlPlaneV1({
    mandate,
    authorization,
    executor_release_sha256: mandate.unresolved_live_readiness.executor_release_sha256,
    durable_episode_authority: durableAuthorityPort,
    acquisition_closure_port: acquisitionClosurePort,
    readiness_challenge_port: {
      async issueReadinessChallengeV1({ state, phase }) {
        challengeCounter += 1;
        return buildFixedTestChallengeV1({
          mandate, authorization, state, phase,
          nonce: `wiggles-issued-challenge-${String(challengeCounter).padStart(2, '0')}`,
          amount: state.chain_derived_acquired_jup_raw,
        });
      },
    },
    execution_port: {
      async prepareBoundedLegV1({ challenge, admission }) {
        calls.prepare += 1;
        return {
          prepared_transaction_version: 'artifact_bounded_agent_prepared_transaction_v1',
          episode_id: challenge.episode_id,
          phase: challenge.phase,
          admission_digest: admission.admission_digest,
          wallet: mandate.wallet_scope.wallet,
          pool: mandate.route_scope.pool,
          input_mint: challenge.phase === 'ACQUISITION' ? mandate.asset_scope.usdc_mint : mandate.asset_scope.jup_mint,
          output_mint: challenge.phase === 'ACQUISITION' ? mandate.asset_scope.jup_mint : mandate.asset_scope.usdc_mint,
          input_raw_quantity: challenge.phase === 'ACQUISITION'
            ? mandate.economic_authority.acquisition_input_usdc_raw : challenge.chain_derived_disposal_jup_raw,
          maximum_slippage_bps: mandate.economic_authority.maximum_slippage_bps,
          transaction_profile: 'DIRECT_CLASSIC_ORCA_LEGACY_SWAP_V1',
          unsigned_transaction_digest: 'a'.repeat(64),
          readiness_evidence_digest: challenge.readiness_evidence_digest,
        };
      },
    },
    wallet_signer_port: {
      async signAdmittedTransactionV1({ admission, prepared_transaction }) {
        calls.load += 1;
        calls.sign += 1;
        markSignerStarted();
        if (pause_signer) await signerReleased;
        const signedWire = signedFixture.wire;
        const signedWirePath = join(root, `signed-wire-${admission.ordinal}.bin`);
        await writeFile(signedWirePath, signedWire, { mode: 0o600 });
        return { signed_wire_path: signedWirePath, signed_transaction_intent: {
          signed_transaction_intent_version: 'artifact_bounded_agent_signed_transaction_intent_v1',
          episode_id: prepared_transaction.episode_id,
          phase: prepared_transaction.phase,
          admission_digest: admission.admission_digest,
          semantic_transaction_digest: prepared_transaction.unsigned_transaction_digest,
          message_sha256: signedFixture.message_sha256,
          signed_wire_sha256: createHash('sha256').update(signedWire).digest('hex'),
          signature: signedFixture.signature,
          sign_count: 1,
        } };
      },
    },
  });
  try { await run({ root, authority, mandate, authorization, calls, control, signerControl, signedDurableControl, acquisitionSource, signedFixture }); }
  finally { authority.closeV1(); await rm(root, { recursive: true, force: true }); }
}

test('accepts only canonical authenticated Hermes decision bytes and checkpoints before key loading', async () => withHarness(async ({ authority, mandate, authorization, calls, control }) => {
  assert.deepEqual(Object.keys(control).sort(), ['closeAcquisitionFromFinalizedEvidenceV1', 'executeAuthenticatedDecisionBytesV1', 'issueReadinessChallengeV1', 'revokeAuthenticatedBytesV1']);
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const signedDecision = decision(mandate, authorization, challenge);
  const result = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(signedDecision)), now_unix_seconds: 1900000012,
  });
  assert.equal(result.admission.status, 'ADMITTED');
  assert.deepEqual(calls, { prepare: 1, load: 1, sign: 1 });
  const durable = await authority.inspectEpisodeV1({ episode_id: state.episode_id });
  assert.equal(durable.ordinals[0].stage, 'SIGNED_INTENT_DURABLE');
}));

test('source-bound acquisition closure durably fixes disposal predecessor, evidence, and quantity', async () => withHarness(async ({ authority, mandate, authorization, control }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const result = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, challenge))),
    now_unix_seconds: 1900000012,
  });
  await authority.recordSubmissionPossibleV1({
    episode_id: result.admission.episode_id,
    ordinal: 1,
    signed_intent_digest: result.signed_transaction_intent_digest,
    signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
  });
  await assert.rejects(() => control.closeAcquisitionFromFinalizedEvidenceV1({
    finalized_evidence_digest: 'f'.repeat(64),
    chain_derived_acquired_jup_raw: '999',
  }), error => error.code === 'verification_scope_unknown_field');
  const closed = await control.closeAcquisitionFromFinalizedEvidenceV1({});
  assert.equal(closed.state, 'ACQUISITION_EVIDENCE_CLOSED');
  assert.equal(closed.chain_derived_acquired_jup_raw, '21437310');
  await assert.rejects(() => authority.registerReadinessChallengeV1(challenge),
    error => error.code === 'bounded_agent_challenge_state_mismatch');
  const substitutedQuantity = buildFixedTestChallengeV1({
    mandate,
    authorization,
    state: closed,
    phase: 'DISPOSAL',
    nonce: 'wiggles-substituted-disposal-quantity-01',
    amount: '21437311',
  });
  await assert.rejects(() => authority.registerReadinessChallengeV1(substitutedQuantity),
    error => error.code === 'bounded_agent_challenge_state_mismatch');
  const disposal = await control.issueReadinessChallengeV1({ phase: 'DISPOSAL', now_unix_seconds: 1900001010 });
  assert.equal(disposal.predecessor_state_digest, closed.state_digest);
  assert.equal(disposal.finalized_acquisition_evidence_digest, closed.acquisition_evidence_digest);
  assert.equal(disposal.chain_derived_disposal_jup_raw, closed.chain_derived_acquired_jup_raw);
  const durable = await authority.inspectEpisodeV1({ episode_id: closed.episode_id });
  assert.equal(durable.ordinals[0].finalized_evidence_digest, closed.acquisition_evidence_digest);
}));

test('direct post-acquisition revocation remains reconstructable after restart', async () => withHarness(async ({ root, authority, mandate, authorization, control }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const result = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, challenge))), now_unix_seconds: 1900000012,
  });
  await authority.recordSubmissionPossibleV1({
    episode_id: result.admission.episode_id, ordinal: 1,
    signed_intent_digest: result.signed_transaction_intent_digest,
    signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
  });
  const closed = await control.closeAcquisitionFromFinalizedEvidenceV1({});
  const unsigned = {
    episode_id: closed.episode_id, mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest, human_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
    predecessor_state: closed.state, predecessor_state_digest: closed.state_digest,
    revoked_at_unix_seconds: 1900001013, revocation_nonce: 'post-acquisition-restart-revocation-01',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION',
  };
  const revocation = buildHumanRevocationV1({ ...unsigned, signature: signBytes(HUMAN_SEED, humanRevocationSigningBytesV1(unsigned)) });
  const acknowledged = await control.revokeAuthenticatedBytesV1({
    revocation_bytes: Buffer.from(canonicalJson(revocation)), now_unix_seconds: 1900001013,
  });
  assert.equal(acknowledged.episode_state.state, 'REVOKED_AFTER_ACQUISITION');
  authority.closeV1();
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.loadCurrentEpisodeStateV1({ episode_id: closed.episode_id })).state, 'REVOKED_AFTER_ACQUISITION');
  restarted.closeV1();
}));

test('revoked in-flight acquisition closes only from authoritative finalized evidence', async () => withHarness(async ({ authority, mandate, authorization, control }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const result = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, challenge))), now_unix_seconds: 1900000012,
  });
  await authority.recordSubmissionPossibleV1({
    episode_id: result.admission.episode_id, ordinal: 1,
    signed_intent_digest: result.signed_transaction_intent_digest,
    signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
  });
  const predecessor = await authority.loadCurrentEpisodeStateV1({ episode_id: challenge.episode_id });
  const unsigned = {
    episode_id: predecessor.episode_id, mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest, human_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
    predecessor_state: predecessor.state, predecessor_state_digest: predecessor.state_digest,
    revoked_at_unix_seconds: 1900000013, revocation_nonce: 'in-flight-acquisition-resolution-revocation-01',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION',
  };
  const revocation = buildHumanRevocationV1({ ...unsigned, signature: signBytes(HUMAN_SEED, humanRevocationSigningBytesV1(unsigned)) });
  const acknowledged = await control.revokeAuthenticatedBytesV1({
    revocation_bytes: Buffer.from(canonicalJson(revocation)), now_unix_seconds: 1900000013,
  });
  assert.equal(acknowledged.episode_state.state, 'RESOLUTION_REQUIRED_AFTER_REVOCATION');
  const closed = await control.closeAcquisitionFromFinalizedEvidenceV1({});
  assert.equal(closed.state, 'REVOKED_AFTER_ACQUISITION');
}));

test('refused disposal ordinal remains a durable terminal successor after restart', async () => withHarness(async ({ root, authority, mandate, authorization, control }) => {
  const acquisition = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const result = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, acquisition))), now_unix_seconds: 1900000012,
  });
  await authority.recordSubmissionPossibleV1({
    episode_id: result.admission.episode_id, ordinal: 1, signed_intent_digest: result.signed_transaction_intent_digest,
    signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
  });
  await control.closeAcquisitionFromFinalizedEvidenceV1({});
  const disposal = await control.issueReadinessChallengeV1({ phase: 'DISPOSAL', now_unix_seconds: 1900001010 });
  const refused = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, disposal, { action: 'REFUSE_DISPOSAL' }))),
    now_unix_seconds: 1900001012,
  });
  assert.equal(refused.state.state, 'AGENT_REFUSED_DISPOSAL');
  authority.closeV1();
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.loadCurrentEpisodeStateV1({ episode_id: disposal.episode_id })).state, 'AGENT_REFUSED_DISPOSAL');
  restarted.closeV1();
}));

test('acquisition finalization fails closed when exact retained signed bytes disappear', async () => withHarness(async ({ root, authority, mandate, authorization, control }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const result = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, challenge))),
    now_unix_seconds: 1900000012,
  });
  await authority.recordSubmissionPossibleV1({
    episode_id: result.admission.episode_id,
    ordinal: 1,
    signed_intent_digest: result.signed_transaction_intent_digest,
    signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
  });
  await rm(join(root, 'signed-wire-1.bin'));
  await assert.rejects(() => control.closeAcquisitionFromFinalizedEvidenceV1({}),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
}));

test('acquisition source-bound finalization commit survives SIGKILL', async () => withHarness(async ({ root, authority, mandate, authorization, control, acquisitionSource, signedFixture }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const result = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, challenge))), now_unix_seconds: 1900000012,
  });
  await authority.recordSubmissionPossibleV1({
    episode_id: result.admission.episode_id, ordinal: 1,
    signed_intent_digest: result.signed_transaction_intent_digest,
    signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
  });
  const predecessor = await authority.loadCurrentEpisodeStateV1({ episode_id: challenge.episode_id });
  const unsignedRevocation = {
    episode_id: predecessor.episode_id, mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest, human_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
    predecessor_state: predecessor.state, predecessor_state_digest: predecessor.state_digest,
    revoked_at_unix_seconds: 1900000013, revocation_nonce: 'crash-revoked-acquisition-finalization-01',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION',
  };
  const revocation = buildHumanRevocationV1({
    ...unsignedRevocation, signature: signBytes(HUMAN_SEED, humanRevocationSigningBytesV1(unsignedRevocation)),
  });
  assert.equal((await control.revokeAuthenticatedBytesV1({
    revocation_bytes: Buffer.from(canonicalJson(revocation)), now_unix_seconds: 1900000013,
  })).episode_state.state, 'RESOLUTION_REQUIRED_AFTER_REVOCATION');
  authority.closeV1();
  const workerPath = join(root, 'crash-acquisition-finalization-worker.mjs');
  const authorityUrl = new URL('./sqlite-decision-authority-v1.mjs', import.meta.url).href;
  const closureUrl = new URL('./acquisition-closure-authority-v1.mjs', import.meta.url).href;
  const fixtureUrl = new URL('./fixtures/bounded-agent-offline-v1.mjs', import.meta.url).href;
  await writeFile(workerPath, `import { createCrashDurableDecisionAuthorityV1 as create } from ${JSON.stringify(authorityUrl)};
import { captureAuthoritativeAcquisitionClosureV1 as capture, createOfflineAcquisitionClosurePortV1 as createPort } from ${JSON.stringify(closureUrl)};
import { createSyntheticAcquisitionAuthorityFixtureV1 as createFixture } from ${JSON.stringify(fixtureUrl)};
const root=process.argv[2];
const input=JSON.parse(process.argv[3]);
const source=await createFixture(input.mandate,{signature:input.signed_transaction_signature});
const port=createPort({capture_authority:async()=>({context:source.context,context_authority:source.context_authority,exact_quote_mint:source.exact_quote_mint,finalized_acquisition:input.finalized_acquisition})});
const proof=await capture({acquisition_closure_port:port,...input});
const authority=create({state_root:root});
await authority.closeAcquisitionFromFinalizedEvidenceV1(proof);
process.stdout.write('READY');
setInterval(()=>{},1000);
`);
  const transaction = acquisitionSource.transactions[0];
  const input = {
    mandate, authorization, signed_intent_digest: result.signed_transaction_intent_digest,
    semantic_transaction_digest: result.signed_transaction_intent.semantic_transaction_digest,
    message_sha256: result.signed_transaction_intent.message_sha256,
    signed_transaction_signature: result.signed_transaction_intent.signature,
    signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
    finalized_acquisition: buildFinalizedLegEvidenceV1({
      episode_id: challenge.episode_id, phase: 'ACQUISITION',
      signed_intent_digest: result.signed_transaction_intent_digest,
      signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
      message_sha256: signedFixture.message_sha256, signature: transaction.signature,
      finalized_transaction_digest: sha256CanonicalJson(transaction), slot: transaction.slot,
      block_time: transaction.block_time, execution_status: 'SUCCEEDED', wallet: mandate.wallet_scope.wallet,
      input_mint: mandate.asset_scope.usdc_mint, output_mint: mandate.asset_scope.jup_mint,
      input_raw_quantity: mandate.economic_authority.acquisition_input_usdc_raw,
      chain_derived_target_raw_quantity: '21437310',
    }),
  };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, root, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) child.kill('SIGKILL'); });
    child.on('close', (code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)));
  });
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.loadCurrentEpisodeStateV1({ episode_id: challenge.episode_id })).state, 'REVOKED_AFTER_ACQUISITION');
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: challenge.episode_id })).ordinals[0].stage, 'FINALIZED');
  restarted.closeV1();
}));

test('disposal submission and finalization commits survive SIGKILL', async () => withHarness(async ({ root, authority, mandate, authorization, control }) => {
  const acquisitionChallenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const acquisition = await control.executeAuthenticatedDecisionBytesV1({ decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, acquisitionChallenge))), now_unix_seconds: 1900000012 });
  await authority.recordSubmissionPossibleV1({
    episode_id: acquisition.admission.episode_id, ordinal: 1,
    signed_intent_digest: acquisition.signed_transaction_intent_digest,
    signed_wire_sha256: acquisition.signed_transaction_intent.signed_wire_sha256,
  });
  await control.closeAcquisitionFromFinalizedEvidenceV1({});
  const disposalChallenge = await control.issueReadinessChallengeV1({ phase: 'DISPOSAL', now_unix_seconds: 1900001010 });
  const disposal = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, disposalChallenge, { action: 'INITIATE_FULL_DISPOSAL' }))), now_unix_seconds: 1900001012,
  });
  const signed = disposal.signed_transaction_intent;
  authority.closeV1();
  const workerPath = join(root, 'disposal-crash-worker.mjs');
  const moduleUrl = new URL('./sqlite-decision-authority-v1.mjs', import.meta.url).href;
  await writeFile(workerPath, `import { createCrashDurableDecisionAuthorityV1 as create } from ${JSON.stringify(moduleUrl)};
const authority=create({state_root:process.argv[2]});
const operation=process.argv[3];
const value=JSON.parse(process.argv[4]);
if(operation==='submission')await authority.recordSubmissionPossibleV1(value);
if(operation==='finalized')await authority.recordFinalizedV1(value);
process.stdout.write('READY');
setInterval(()=>{},1000);
`);
  const killAfterCommit = (operation, value) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, root, operation, JSON.stringify(value)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) child.kill('SIGKILL'); });
    child.on('close', (code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)));
  });
  const identity = { episode_id: disposalChallenge.episode_id, ordinal: 2, signed_intent_digest: disposal.signed_transaction_intent_digest, signed_wire_sha256: signed.signed_wire_sha256 };
  await killAfterCommit('submission', identity);
  let restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: disposalChallenge.episode_id })).ordinals[1].stage, 'SUBMISSION_POSSIBLE');
  const predecessor = await restarted.loadCurrentEpisodeStateV1({ episode_id: disposalChallenge.episode_id });
  const unsignedRevocation = {
    episode_id: predecessor.episode_id, mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest, human_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
    predecessor_state: predecessor.state, predecessor_state_digest: predecessor.state_digest,
    revoked_at_unix_seconds: 1900001013, revocation_nonce: 'crash-revoked-disposal-finalization-01',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION',
  };
  const revocation = buildHumanRevocationV1({
    ...unsignedRevocation, signature: signBytes(HUMAN_SEED, humanRevocationSigningBytesV1(unsignedRevocation)),
  });
  const revokedState = applyHumanRevocationV1({ state: predecessor, authorization_digest: authorization.authorization_digest });
  await restarted.revokeAuthorizationV1({
    episode_id: predecessor.episode_id, mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest,
    executor_release_sha256: authorization.executor_release_sha256,
    predecessor_state: predecessor.state, predecessor_state_digest: predecessor.state_digest,
    revoked_state_digest: revokedState.state_digest, revoked_at_unix_seconds: revocation.revoked_at_unix_seconds,
    revocation_digest: revocation.revocation_digest, successor_state: revokedState,
  });
  restarted.closeV1();
  await killAfterCommit('finalized', { ...identity, finalized_evidence_digest: 'f'.repeat(64) });
  restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  const durable = await restarted.inspectEpisodeV1({ episode_id: disposalChallenge.episode_id });
  assert.equal(durable.ordinals[1].stage, 'FINALIZED');
  const terminal = await restarted.loadCurrentEpisodeStateV1({ episode_id: disposalChallenge.episode_id });
  assert.equal(terminal.state, 'REVOKED_AFTER_DISPOSAL');
  assert.equal(terminal.disposal_evidence_digest, 'f'.repeat(64));
  restarted.closeV1();
}));

test('normal acquisition FINALIZED commit survives SIGKILL with exact reopened disposal authority', async () => withHarness(async ({ root, authority, mandate, authorization, control, acquisitionSource, signedFixture }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const result = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, challenge))), now_unix_seconds: 1900000012,
  });
  await authority.recordSubmissionPossibleV1({
    episode_id: result.admission.episode_id, ordinal: 1,
    signed_intent_digest: result.signed_transaction_intent_digest,
    signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
  });
  const predecessor = await authority.loadCurrentEpisodeStateV1({ episode_id: challenge.episode_id });
  authority.closeV1();
  const workerPath = join(root, 'crash-acquisition-finalization-worker.mjs');
  const authorityUrl = new URL('./sqlite-decision-authority-v1.mjs', import.meta.url).href;
  const closureUrl = new URL('./acquisition-closure-authority-v1.mjs', import.meta.url).href;
  const fixtureUrl = new URL('./fixtures/bounded-agent-offline-v1.mjs', import.meta.url).href;
  await writeFile(workerPath, `import { createCrashDurableDecisionAuthorityV1 as create } from ${JSON.stringify(authorityUrl)};
import { captureAuthoritativeAcquisitionClosureV1 as capture, createOfflineAcquisitionClosurePortV1 as createPort } from ${JSON.stringify(closureUrl)};
import { createSyntheticAcquisitionAuthorityFixtureV1 as createFixture } from ${JSON.stringify(fixtureUrl)};
const root=process.argv[2];
const input=JSON.parse(process.argv[3]);
const source=await createFixture(input.mandate,{signature:input.signed_transaction_signature});
const port=createPort({capture_authority:async()=>({context:source.context,context_authority:source.context_authority,exact_quote_mint:source.exact_quote_mint,finalized_acquisition:input.finalized_acquisition})});
const proof=await capture({acquisition_closure_port:port,...input});
const authority=create({state_root:root});
await authority.closeAcquisitionFromFinalizedEvidenceV1(proof);
process.stdout.write('READY');
setInterval(()=>{},1000);
`);
  const transaction = acquisitionSource.transactions[0];
  const input = {
    mandate, authorization, signed_intent_digest: result.signed_transaction_intent_digest,
    semantic_transaction_digest: result.signed_transaction_intent.semantic_transaction_digest,
    message_sha256: result.signed_transaction_intent.message_sha256,
    signed_transaction_signature: result.signed_transaction_intent.signature,
    signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
    finalized_acquisition: buildFinalizedLegEvidenceV1({
      episode_id: challenge.episode_id, phase: 'ACQUISITION',
      signed_intent_digest: result.signed_transaction_intent_digest,
      signed_wire_sha256: result.signed_transaction_intent.signed_wire_sha256,
      message_sha256: signedFixture.message_sha256, signature: transaction.signature,
      finalized_transaction_digest: sha256CanonicalJson(transaction), slot: transaction.slot,
      block_time: transaction.block_time, execution_status: 'SUCCEEDED', wallet: mandate.wallet_scope.wallet,
      input_mint: mandate.asset_scope.usdc_mint, output_mint: mandate.asset_scope.jup_mint,
      input_raw_quantity: mandate.economic_authority.acquisition_input_usdc_raw,
      chain_derived_target_raw_quantity: '21437310',
    }),
  };
  const { state_id, state_digest, ...expectedPreimage } = {
    ...predecessor, state: 'ACQUISITION_EVIDENCE_CLOSED', next_ordinal: 2,
    possible_submission: false, signed_intent_digest: null,
    acquisition_evidence_digest: input.finalized_acquisition.finalized_evidence_digest,
    chain_derived_acquired_jup_raw: '21437310',
  };
  const expectedDigest = sha256CanonicalJson(expectedPreimage);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, root, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout === 'READY') child.kill('SIGKILL');
    });
    child.on('close', (code, signal) => stdout === 'READY' && signal === 'SIGKILL'
      ? resolve() : reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)));
  });
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  try {
    const closed = await restarted.loadCurrentEpisodeStateV1({ episode_id: challenge.episode_id });
    const durable = await restarted.inspectEpisodeV1({ episode_id: challenge.episode_id });
    assert.equal(durable.revoked, false);
    assert.equal(durable.ordinals[0].stage, 'FINALIZED');
    assert.equal(closed.state, 'ACQUISITION_EVIDENCE_CLOSED');
    assert.equal(closed.state_digest, expectedDigest);
    assert.equal(closed.acquisition_evidence_digest, input.finalized_acquisition.finalized_evidence_digest);
    assert.equal(durable.ordinals[0].finalized_evidence_digest, closed.acquisition_evidence_digest);
    assert.equal(closed.chain_derived_acquired_jup_raw, '21437310');
    const disposal = buildFixedTestChallengeV1({
      mandate, authorization, state: closed, phase: 'DISPOSAL',
      nonce: 'normal-acquisition-crash-disposal-01', amount: closed.chain_derived_acquired_jup_raw,
    });
    assert.equal(await restarted.registerReadinessChallengeV1(disposal), 'REGISTERED');
    const retained = await restarted.loadIssuedReadinessChallengeV1({
      episode_id: closed.episode_id, challenge_id: disposal.challenge_id,
    });
    assert.equal(retained.predecessor_state_digest, expectedDigest);
    assert.equal(retained.finalized_acquisition_evidence_digest, closed.acquisition_evidence_digest);
    assert.equal(retained.chain_derived_disposal_jup_raw, closed.chain_derived_acquired_jup_raw);
  } finally { restarted.closeV1(); }
}));

test('normal disposal FINALIZED commit survives SIGKILL with exact terminal evidence', async () => withHarness(async ({ root, authority, mandate, authorization, control }) => {
  const acquisitionChallenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const acquisition = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, acquisitionChallenge))), now_unix_seconds: 1900000012,
  });
  await authority.recordSubmissionPossibleV1({
    episode_id: acquisition.admission.episode_id, ordinal: 1,
    signed_intent_digest: acquisition.signed_transaction_intent_digest,
    signed_wire_sha256: acquisition.signed_transaction_intent.signed_wire_sha256,
  });
  const closedAcquisition = await control.closeAcquisitionFromFinalizedEvidenceV1({});
  const disposalChallenge = await control.issueReadinessChallengeV1({ phase: 'DISPOSAL', now_unix_seconds: 1900001010 });
  const disposal = await control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, disposalChallenge, { action: 'INITIATE_FULL_DISPOSAL' }))), now_unix_seconds: 1900001012,
  });
  const identity = {
    episode_id: disposalChallenge.episode_id, ordinal: 2,
    signed_intent_digest: disposal.signed_transaction_intent_digest,
    signed_wire_sha256: disposal.signed_transaction_intent.signed_wire_sha256,
  };
  await authority.recordSubmissionPossibleV1(identity);
  const predecessor = await authority.loadCurrentEpisodeStateV1({ episode_id: disposalChallenge.episode_id });
  const finalizedEvidenceDigest = 'f'.repeat(64);
  const { state_id, state_digest, ...expectedPreimage } = {
    ...predecessor, state: 'DISPOSAL_EVIDENCE_CLOSED', next_ordinal: null,
    possible_submission: false, signed_intent_digest: null, disposal_evidence_digest: finalizedEvidenceDigest,
  };
  const expectedDigest = sha256CanonicalJson(expectedPreimage);
  authority.closeV1();
  const workerPath = join(root, 'disposal-crash-worker.mjs');
  const moduleUrl = new URL('./sqlite-decision-authority-v1.mjs', import.meta.url).href;
  await writeFile(workerPath, `import { createCrashDurableDecisionAuthorityV1 as create } from ${JSON.stringify(moduleUrl)};
const authority=create({state_root:process.argv[2]});
const operation=process.argv[3];
const value=JSON.parse(process.argv[4]);
if(operation==='submission')await authority.recordSubmissionPossibleV1(value);
if(operation==='finalized')await authority.recordFinalizedV1(value);
process.stdout.write('READY');
setInterval(()=>{},1000);
`);
  const killAfterCommit = (operation, value) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, root, operation, JSON.stringify(value)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout === 'READY') child.kill('SIGKILL');
    });
    child.on('close', (code, signal) => stdout === 'READY' && signal === 'SIGKILL'
      ? resolve() : reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)));
  });
  await killAfterCommit('finalized', { ...identity, finalized_evidence_digest: finalizedEvidenceDigest });
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  try {
    const durable = await restarted.inspectEpisodeV1({ episode_id: disposalChallenge.episode_id });
    const terminal = await restarted.loadCurrentEpisodeStateV1({ episode_id: disposalChallenge.episode_id });
    assert.equal(durable.revoked, false);
    assert.equal(durable.ordinals[1].stage, 'FINALIZED');
    assert.equal(terminal.state, 'DISPOSAL_EVIDENCE_CLOSED');
    assert.equal(terminal.state_digest, expectedDigest);
    assert.equal(durable.ordinals[1].finalized_evidence_digest, finalizedEvidenceDigest);
    assert.equal(terminal.disposal_evidence_digest, finalizedEvidenceDigest);
    assert.equal(terminal.acquisition_evidence_digest, closedAcquisition.acquisition_evidence_digest);
    assert.equal(durable.ordinals[0].finalized_evidence_digest, closedAcquisition.acquisition_evidence_digest);
    assert.equal(terminal.chain_derived_acquired_jup_raw, closedAcquisition.chain_derived_acquired_jup_raw);
    assert.equal(terminal.next_ordinal, null);
  } finally { restarted.closeV1(); }
}));

test('authenticated request shells reject accessors before reading caller values', async () => withHarness(async ({ control }) => {
  let reads = 0;
  const decisionRequest = {};
  Object.defineProperties(decisionRequest, {
    decision_bytes: { enumerable: true, get() { reads += 1; return Buffer.from('{}'); } },
    now_unix_seconds: { enumerable: true, value: 0 },
  });
  await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1(decisionRequest),
    error => error.code === 'verification_scope_unknown_field');
  const revocationRequest = {};
  Object.defineProperties(revocationRequest, {
    revocation_bytes: { enumerable: true, get() { reads += 1; return Buffer.from('{}'); } },
    now_unix_seconds: { enumerable: true, value: 0 },
  });
  await assert.rejects(() => control.revokeAuthenticatedBytesV1(revocationRequest),
    error => error.code === 'verification_scope_unknown_field');
  assert.equal(reads, 0);
}));

test('authorized signer identity is established before executor-owned durable reads', async () => withHarness(async ({ authority, mandate, authorization, control }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const invalid = { ...decision(mandate, authorization, challenge), signature: '00'.repeat(64) };
  const attackerAgentUnsigned = {
    episode_id: challenge.episode_id, action: 'INITIATE_ACQUISITION', ordinal: challenge.ordinal,
    mandate_digest: mandate.mandate_digest, authorization_digest: authorization.authorization_digest,
    challenge_digest: challenge.challenge_digest, predecessor_state_digest: challenge.predecessor_state_digest,
    executor_release_sha256: challenge.executor_release_sha256, challenge_nonce: challenge.challenge_nonce,
    agent_public_key: publicKeyHex(ATTACKER_SEED), signed_at_unix_seconds: 1900000011,
  };
  const attackerDecision = buildAuthenticatedAgentDecisionV1({
    ...attackerAgentUnsigned,
    signature: signBytes(ATTACKER_SEED, agentDecisionSigningBytesV1(attackerAgentUnsigned)),
  });
  const current = await authority.loadCurrentEpisodeStateV1({ episode_id: challenge.episode_id });
  const attackerRevocationUnsigned = {
    episode_id: current.episode_id, mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest, human_public_key: publicKeyHex(ATTACKER_SEED),
    predecessor_state: current.state, predecessor_state_digest: current.state_digest,
    revoked_at_unix_seconds: 1900000012, revocation_nonce: 'attacker-self-authorized-revocation-01',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION',
  };
  const attackerRevocation = buildHumanRevocationV1({
    ...attackerRevocationUnsigned,
    signature: signBytes(ATTACKER_SEED, humanRevocationSigningBytesV1(attackerRevocationUnsigned)),
  });
  authority.closeV1();
  await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(invalid)), now_unix_seconds: 1900000012,
  }), error => error.code === 'bounded_agent_authentication_signature_invalid');
  await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(attackerDecision)), now_unix_seconds: 1900000012,
  }), error => error.code === 'bounded_agent_decision_context_mismatch');
  await assert.rejects(() => control.revokeAuthenticatedBytesV1({
    revocation_bytes: Buffer.from(canonicalJson(attackerRevocation)), now_unix_seconds: 1900000012,
  }), error => error.code === 'bounded_agent_revocation_context_mismatch');
}));

test('altered, noncanonical, expired, or unauthorized decision bytes never reach preparation or signing', async () => withHarness(async ({ mandate, authorization, calls, control }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const signedDecision = decision(mandate, authorization, challenge);
  const callerState = createAuthorizedEpisodeStateV1({ mandate, authorization });
  await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1({
    state: callerState,
    challenge,
    decision_bytes: Buffer.from(canonicalJson(signedDecision)),
    now_unix_seconds: 1900000012,
  }), error => error.code === 'verification_scope_unknown_field');
  const altered = structuredClone(signedDecision);
  altered.action = 'REFUSE_ACQUISITION';
  await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(altered)), now_unix_seconds: 1900000012,
  }));
  await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(JSON.stringify(signedDecision)), now_unix_seconds: 1900000012,
  }), error => error.code === 'bounded_agent_decision_channel_noncanonical');
  await assert.rejects(() => control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(signedDecision)),
    now_unix_seconds: authorization.acquisition_not_after_unix_seconds,
  }), error => error.code === 'bounded_agent_decision_stale');
  assert.deepEqual(calls, { prepare: 0, load: 0, sign: 0 });
}));

test('authenticated revocation acknowledges the signed-bytes-durable race outcome', async () => withHarness(async ({ authority, mandate, authorization, calls, control, signedDurableControl }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const execution = control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, challenge))), now_unix_seconds: 1900000012,
  });
  await signedDurableControl.signedDurableStarted;
  const state = await authority.loadCurrentEpisodeStateV1({ episode_id: challenge.episode_id });
  const unsigned = {
    episode_id: state.episode_id, mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest, human_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
    predecessor_state: state.state, predecessor_state_digest: state.state_digest,
    revoked_at_unix_seconds: 1900000013, revocation_nonce: 'authenticated-signed-race-revocation-01',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION',
  };
  const revocation = buildHumanRevocationV1({ ...unsigned, signature: signBytes(HUMAN_SEED, humanRevocationSigningBytesV1(unsigned)) });
  const acknowledged = await control.revokeAuthenticatedBytesV1({
    revocation_bytes: Buffer.from(canonicalJson(revocation)), now_unix_seconds: 1900000013,
  });
  assert.equal(acknowledged.revocation_result, 'REVOKED_SIGNED_BYTES_DURABLE');
  assert.equal(acknowledged.episode_state.state, 'RESOLUTION_REQUIRED_AFTER_REVOCATION');
  signedDurableControl.releaseSignedDurable();
  await assert.rejects(execution);
  assert.deepEqual(calls, { prepare: 1, load: 1, sign: 1 });
}, { pause_after_signed_durable: true }));

test('authenticated revocation acknowledges the durable key-load race outcome', async () => withHarness(async ({ authority, mandate, authorization, calls, control, signerControl }) => {
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const execution = control.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(decision(mandate, authorization, challenge))),
    now_unix_seconds: 1900000012,
  });
  await signerControl.signerStarted;
  const state = await authority.loadCurrentEpisodeStateV1({ episode_id: challenge.episode_id });
  const unsigned = {
    episode_id: state.episode_id,
    mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest,
    human_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
    predecessor_state: state.state,
    predecessor_state_digest: state.state_digest,
    revoked_at_unix_seconds: 1900000013,
    revocation_nonce: 'authenticated-race-window-revocation-01',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION',
  };
  const revocation = buildHumanRevocationV1({
    ...unsigned,
    signature: signBytes(HUMAN_SEED, humanRevocationSigningBytesV1(unsigned)),
  });
  const acknowledged = await control.revokeAuthenticatedBytesV1({
    revocation_bytes: Buffer.from(canonicalJson(revocation)), now_unix_seconds: 1900000013,
  });
  assert.equal(acknowledged.revocation_result, 'REVOCATION_RECORDED_SIGNING_AMBIGUOUS');
  assert.equal(acknowledged.episode_state.state, 'ACQUISITION_ADMITTED');
  signerControl.releaseSigner();
  await assert.rejects(execution);
  assert.deepEqual(calls, { prepare: 1, load: 1, sign: 1 });
}, { pause_signer: true }));

test('human revocation is separately authenticated and blocks stale decision delivery after restart', async () => withHarness(async ({ root, authority, mandate, authorization, calls, control }) => {
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: 1900000010 });
  const signedDecision = decision(mandate, authorization, challenge);
  const unsigned = {
    episode_id: state.episode_id,
    mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest,
    human_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
    predecessor_state: state.state,
    predecessor_state_digest: state.state_digest,
    revoked_at_unix_seconds: 1900000011,
    revocation_nonce: 'authenticated-human-revocation-01',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION',
  };
  const revocation = buildHumanRevocationV1({
    ...unsigned,
    signature: signBytes(HUMAN_SEED, humanRevocationSigningBytesV1(unsigned)),
  });
  const revoked = await control.revokeAuthenticatedBytesV1({
    revocation_bytes: Buffer.from(canonicalJson(revocation)), now_unix_seconds: 1900000011,
  });
  assert.equal(revoked.revocation_result, 'REVOKED');
  assert.equal(revoked.episode_state.human_revocation_status, 'REVOKED');
  const replayed = await control.revokeAuthenticatedBytesV1({
    revocation_bytes: Buffer.from(canonicalJson(revocation)), now_unix_seconds: 1900000011,
  });
  assert.equal(replayed.revocation_result, 'ALREADY_REVOKED');
  assert.equal(replayed.episode_state.state, 'REVOKED_BEFORE_FIRST_ADMISSION');
  authority.closeV1();

  const restartedAuthority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  const restarted = createWigglesAuthenticatedControlPlaneV1({
    mandate,
    authorization,
    executor_release_sha256: mandate.unresolved_live_readiness.executor_release_sha256,
    durable_episode_authority: restartedAuthority,
    acquisition_closure_port: {},
    readiness_challenge_port: { async issueReadinessChallengeV1() { throw new Error('must not issue'); } },
    execution_port: { async prepareBoundedLegV1() { calls.prepare += 1; throw new Error('must not prepare'); } },
    wallet_signer_port: { async signAdmittedTransactionV1() { calls.sign += 1; throw new Error('must not sign'); } },
  });
  await assert.rejects(() => restarted.executeAuthenticatedDecisionBytesV1({
    decision_bytes: Buffer.from(canonicalJson(signedDecision)), now_unix_seconds: 1900000012,
  }), error => error.code === 'bounded_agent_authorization_revoked');
  assert.deepEqual(calls, { prepare: 0, load: 0, sign: 0 });
  restartedAuthority.closeV1();
}));
