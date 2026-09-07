import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, chown, copyFile, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { canonicalJson, sha256CanonicalJson } from '../contract.mjs';
import { applyHumanRevocationV1, recordSignedIntentV1 } from './episode-state-machine-v1.mjs';
import { buildReadinessChallengeV1 } from './readiness-challenge-v1.mjs';
import { encodeBase58 } from './reused/bounded-rebroadcast-v1.mjs';
import {
  createCrashDurableDecisionAuthorityV1,
  provisionCrashDurableDecisionAuthorityV1,
} from './sqlite-decision-authority-v1.mjs';

const D = character => character.repeat(64);
const EPISODE = `bounded-agent-episode-${D('2')}`;
const AUTHORIZATION = D('2');
const MANDATE = D('3');
const RELEASE = D('4');

function createSignedLegacyWire({ trailing_message_bytes = Buffer.alloc(0) } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const message = Buffer.concat([
    Buffer.from([1, 0, 0, 1]), signer, Buffer.alloc(32, 7), Buffer.from([0]), trailing_message_bytes,
  ]);
  const signature = sign(null, message, privateKey);
  return {
    wire: Buffer.concat([Buffer.from([1]), signature, message]),
    message_sha256: createHash('sha256').update(message).digest('hex'),
    transaction_signature: encodeBase58(signature),
  };
}

function issueState(fields) {
  const value = {
    episode_state_version: 'artifact_bounded_agent_episode_state_v1',
    state_id: `episode-state-${D('0')}`,
    state_digest: D('0'),
    ...fields,
  };
  const preimage = Object.fromEntries(Object.entries(value).filter(([field]) => !['state_id', 'state_digest'].includes(field)));
  value.state_digest = sha256CanonicalJson(preimage);
  value.state_id = `episode-state-${value.state_digest}`;
  return Object.freeze(value);
}
function initialState() {
  return issueState({
    episode_id: EPISODE,
    mandate_digest: MANDATE,
    authorization_digest: AUTHORIZATION,
    state: 'AUTHORIZED_DORMANT',
    next_ordinal: 1,
    possible_submission: false,
    human_revocation_status: 'NOT_REVOKED',
    consumed_decision_ids: [],
    consumed_challenge_ids: [],
    signed_intent_digest: null,
    acquisition_evidence_digest: null,
    chain_derived_acquired_jup_raw: null,
    disposal_evidence_digest: null,
  });
}
function challengeFor(state, nonce = 'durable-challenge-0001') {
  return buildReadinessChallengeV1({
    episode_id: state.episode_id,
    phase: 'ACQUISITION',
    ordinal: 1,
    mandate_digest: state.mandate_digest,
    authorization_digest: state.authorization_digest,
    predecessor_state: state.state,
    predecessor_state_digest: state.state_digest,
    executor_release_sha256: RELEASE,
    challenge_nonce: nonce,
    readiness_evidence_digest: D('7'),
    issued_at_unix_seconds: 1900000010,
    expires_at_unix_seconds: 1900000310,
    readiness_status: 'READY',
    finalized_acquisition_evidence_digest: null,
    chain_derived_disposal_jup_raw: null,
    disposal_quantity_rule: 'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE',
  });
}
function admittedState(state, decisionId, challengeId) {
  return issueState({
    ...Object.fromEntries(Object.entries(state).filter(([field]) => !['episode_state_version', 'state_id', 'state_digest'].includes(field))),
    state: 'ACQUISITION_ADMITTED',
    consumed_decision_ids: [...state.consumed_decision_ids, decisionId],
    consumed_challenge_ids: [...state.consumed_challenge_ids, challengeId],
  });
}
function reservation({ decisionCharacter = '6', nonce = 'durable-challenge-0001' } = {}) {
  const predecessor = initialState();
  const challenge = challengeFor(predecessor, nonce);
  const decisionId = `agent-decision-${D(decisionCharacter)}`;
  return {
    challenge,
    value: {
      episode_id: EPISODE,
      mandate_digest: MANDATE,
      authorization_digest: AUTHORIZATION,
      executor_release_sha256: RELEASE,
      ordinal: 1,
      phase: 'ACQUISITION',
      predecessor_state: predecessor.state,
      predecessor_state_digest: predecessor.state_digest,
      decision_id: decisionId,
      challenge_id: challenge.challenge_id,
      admission_digest: D('8'),
      successor_state: admittedState(predecessor, decisionId, challenge.challenge_id),
    },
  };
}
function provision(root) {
  return provisionCrashDurableDecisionAuthorityV1({
    state_root: root,
    initial_episode_state: initialState(),
    executor_release_sha256: RELEASE,
  });
}
async function openWithChallenge(root, request = reservation()) {
  const authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  await authority.registerReadinessChallengeV1(request.challenge);
  return authority;
}
async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-decision-authority-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('startup rejects any SQLite schema extension or mutation', async () => withRoot(async root => {
  provision(root);
  const databasePath = join(root, 'bounded-agent-decision-authority-v1.sqlite');
  let database = new DatabaseSync(databasePath);
  database.exec('CREATE TRIGGER hostile_checkpoint_trigger AFTER UPDATE ON ordinals BEGIN DELETE FROM ordinals WHERE episode_id = NEW.episode_id AND ordinal = NEW.ordinal; END;');
  database.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');

  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  provision(root);
  database = new DatabaseSync(databasePath);
  database.exec('ALTER TABLE authority_metadata ADD COLUMN unexpected TEXT;');
  database.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
}));

test('readiness challenges must match the durable episode executor release', async () => withRoot(async root => {
  provision(root);
  const authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  const trusted = challengeFor(initialState(), 'release-binding-challenge-01');
  const fields = Object.fromEntries(Object.entries(trusted).filter(([field]) => !['readiness_challenge_version', 'challenge_id', 'challenge_digest'].includes(field)));
  const substituted = buildReadinessChallengeV1({ ...fields, executor_release_sha256: D('f') });
  await assert.rejects(() => authority.registerReadinessChallengeV1(substituted),
    error => error.code === 'bounded_agent_challenge_state_mismatch');
  authority.closeV1();
  const database = new DatabaseSync(join(root, 'bounded-agent-decision-authority-v1.sqlite'));
  database.prepare('INSERT INTO readiness_challenges VALUES (?, ?, ?, ?)').run(
    substituted.challenge_id, substituted.episode_id, substituted.predecessor_state_digest, canonicalJson(substituted));
  database.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
}));

test('refused acquisition ordinal remains a durable terminal successor after restart', async () => withRoot(async root => {
  provision(root);
  const request = reservation();
  request.value.successor_state = issueState({
    ...Object.fromEntries(Object.entries(initialState()).filter(([field]) => !['episode_state_version', 'state_id', 'state_digest'].includes(field))),
    state: 'AGENT_REFUSED_ACQUISITION', next_ordinal: null,
    consumed_decision_ids: [request.value.decision_id], consumed_challenge_ids: [request.value.challenge_id],
  });
  let authority = await openWithChallenge(root, request);
  await authority.consumeEpisodeOrdinalV1(request.value);
  authority.closeV1();
  authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await authority.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).state, 'AGENT_REFUSED_ACQUISITION');
  authority.closeV1();
}));

test('runtime open cannot initialize; provision is one-time and missing state fails closed', async () => withRoot(async root => {
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root, initialize: true }),
    error => error.code === 'unknown_field');
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
  const invalidRoot = await mkdtemp(join(root, 'invalid-provisioning-'));
  assert.throws(() => provisionCrashDurableDecisionAuthorityV1({
    state_root: invalidRoot,
    initial_episode_state: reservation().value.successor_state,
    executor_release_sha256: RELEASE,
  }), error => error.code === 'bounded_agent_durable_state_untrustworthy');
  if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
    const foreignRoot = await mkdtemp(join(root, 'foreign-owned-'));
    await chown(foreignRoot, 65534, 65534);
    assert.throws(() => provisionCrashDurableDecisionAuthorityV1({
      state_root: foreignRoot,
      initial_episode_state: initialState(),
      executor_release_sha256: RELEASE,
    }), error => error.code === 'bounded_agent_durable_state_untrustworthy');
  }
  assert.equal(provision(root), 'PROVISIONED');
  assert.throws(() => provision(root), error => error.code === 'bounded_agent_durable_state_untrustworthy');
  const authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await authority.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).state, 'AUTHORIZED_DORMANT');
  assert.equal(Object.hasOwn(authority, 'initializeEpisodeStateV1'), false);
  assert.equal(Object.hasOwn(authority, 'compareAndSetEpisodeStateV1'), false);
  authority.closeV1();
}));

test('durably consumes one typed episode transition across duplicates, instances, and restart', async () => withRoot(async root => {
  provision(root);
  const firstRequest = reservation();
  const conflictingRequest = reservation({ decisionCharacter: '9', nonce: 'durable-challenge-0002' });
  const first = await openWithChallenge(root, firstRequest);
  const exactReplay = await openWithChallenge(root, firstRequest);
  const conflicting = await openWithChallenge(root, conflictingRequest);
  const outcomes = await Promise.all([
    first.consumeEpisodeOrdinalV1(firstRequest.value),
    exactReplay.consumeEpisodeOrdinalV1(firstRequest.value),
  ]);
  assert.deepEqual([...outcomes].sort(), ['ALREADY_CONSUMED', 'CONSUMED']);
  await assert.rejects(() => conflicting.consumeEpisodeOrdinalV1(conflictingRequest.value),
    error => error.code === 'bounded_agent_durable_identity_conflict');
  first.closeV1();
  exactReplay.closeV1();
  conflicting.closeV1();
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: EPISODE })).ordinals.length, 1);
  assert.equal((await restarted.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).state, 'ACQUISITION_ADMITTED');
  restarted.closeV1();
}));

test('cross-process concurrent requests linearize to one consumed ordinal', async () => withRoot(async root => {
  provision(root);
  const one = reservation();
  const bootstrap = await openWithChallenge(root, one);
  bootstrap.closeV1();
  const workerPath = join(root, 'consume-worker.mjs');
  const moduleUrl = new URL('./sqlite-decision-authority-v1.mjs', import.meta.url).href;
  await writeFile(workerPath, `import { createCrashDurableDecisionAuthorityV1 as create } from ${JSON.stringify(moduleUrl)};\nconst authority=create({state_root:process.argv[2]});\ntry{process.stdout.write(await authority.consumeEpisodeOrdinalV1(JSON.parse(process.argv[3])))}finally{authority.closeV1()}\n`);
  const run = request => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, root, JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errorOutput = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errorOutput += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(errorOutput)));
  });
  assert.deepEqual((await Promise.all([run(one.value), run(one.value)])).sort(), ['ALREADY_CONSUMED', 'CONSUMED']);
}));

test('committed checkpoints survive SIGKILL without an orderly authority close', async () => withRoot(async root => {
  provision(root);
  const request = reservation();
  const bootstrap = await openWithChallenge(root, request);
  bootstrap.closeV1();
  const checkpoint = { episode_id: EPISODE, ordinal: 1, admission_digest: D('8'), prepared_transaction_digest: D('d') };
  const signed = createSignedLegacyWire();
  const signedWirePath = join(root, 'signed-wire-killed-worker.bin');
  await writeFile(signedWirePath, signed.wire, { mode: 0o600 });
  const signedValue = {
    ...checkpoint,
    signed_intent_digest: D('e'),
    semantic_transaction_digest: D('a'),
    message_sha256: signed.message_sha256,
    transaction_signature: signed.transaction_signature,
    signed_wire_sha256: createHash('sha256').update(signed.wire).digest('hex'),
    signed_wire_path: signedWirePath,
  };
  const workerPath = join(root, 'crash-checkpoint-worker.mjs');
  const moduleUrl = new URL('./sqlite-decision-authority-v1.mjs', import.meta.url).href;
  await writeFile(workerPath, `import { createCrashDurableDecisionAuthorityV1 as create } from ${JSON.stringify(moduleUrl)};
const authority=create({state_root:process.argv[2]});
const operation=process.argv[3];
const value=JSON.parse(process.argv[4]);
if(operation==='consume')await authority.consumeEpisodeOrdinalV1(value);
if(operation==='prepared')await authority.recordPreparedV1(value);
if(operation==='key')await authority.recordKeyLoadStartedV1(value);
if(operation==='signed')await authority.recordSignedIntentDurableV1(value);
if(operation==='submission')await authority.recordSubmissionPossibleV1(value);
process.stdout.write('READY');
setInterval(()=>{},1000);
`);
  const killAfterCommit = (operation, value) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, root, operation, JSON.stringify(value)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('READY')) child.kill('SIGKILL');
    });
    child.on('close', (code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)));
  });
  await killAfterCommit('consume', request.value);
  let restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: EPISODE })).ordinals[0].stage, 'RESERVED');
  restarted.closeV1();
  await killAfterCommit('prepared', { ...checkpoint, semantic_transaction_digest: D('a') });
  restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: EPISODE })).ordinals[0].stage, 'PREPARED');
  restarted.closeV1();
  await killAfterCommit('key', checkpoint);
  restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: EPISODE })).ordinals[0].stage, 'KEY_LOAD_STARTED_AMBIGUOUS');
  restarted.closeV1();
  await killAfterCommit('signed', signedValue);
  restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: EPISODE })).ordinals[0].stage, 'SIGNED_INTENT_DURABLE');
  restarted.closeV1();
}));

test('unauthorized state transitions and forged acquisition closure are rejected', async () => withRoot(async root => {
  provision(root);
  const request = reservation();
  const authority = await openWithChallenge(root, request);
  const forged = { ...request.value.successor_state, state: 'ACQUISITION_EVIDENCE_CLOSED' };
  await assert.rejects(() => authority.consumeEpisodeOrdinalV1({ ...request.value, successor_state: forged }));
  await assert.rejects(() => authority.closeAcquisitionFromFinalizedEvidenceV1({
    episode_id: EPISODE,
    finalized_evidence_digest: D('f'),
    chain_derived_acquired_jup_raw: '21437310',
  }), error => error.code === 'bounded_agent_acquisition_closure_capability_denied');
  authority.closeV1();
}));

test('revocation is a typed atomic state transition and survives restart', async () => withRoot(async root => {
  provision(root);
  const authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  const predecessor = initialState();
  const successor = applyHumanRevocationV1({ state: predecessor, authorization_digest: AUTHORIZATION });
  const revocation = {
    episode_id: EPISODE,
    mandate_digest: MANDATE,
    authorization_digest: AUTHORIZATION,
    executor_release_sha256: RELEASE,
    predecessor_state: predecessor.state,
    predecessor_state_digest: predecessor.state_digest,
    revoked_state_digest: successor.state_digest,
    revoked_at_unix_seconds: 1900000010,
    revocation_digest: D('c'),
    successor_state: successor,
  };
  assert.equal(await authority.revokeAuthorizationV1(revocation), 'REVOKED');
  assert.equal(await authority.revokeAuthorizationV1(revocation), 'ALREADY_REVOKED');
  authority.closeV1();
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).human_revocation_status, 'REVOKED');
  restarted.closeV1();
}));

test('a committed revocation survives SIGKILL without an orderly authority close', async () => withRoot(async root => {
  provision(root);
  const predecessor = initialState();
  const successor = applyHumanRevocationV1({ state: predecessor, authorization_digest: AUTHORIZATION });
  const revocation = {
    episode_id: EPISODE, mandate_digest: MANDATE, authorization_digest: AUTHORIZATION,
    executor_release_sha256: RELEASE, predecessor_state: predecessor.state,
    predecessor_state_digest: predecessor.state_digest, revoked_state_digest: successor.state_digest,
    revoked_at_unix_seconds: 1900000010, revocation_digest: D('c'), successor_state: successor,
  };
  const workerPath = join(root, 'crash-revocation-worker.mjs');
  const moduleUrl = new URL('./sqlite-decision-authority-v1.mjs', import.meta.url).href;
  await writeFile(workerPath, `import { createCrashDurableDecisionAuthorityV1 as create } from ${JSON.stringify(moduleUrl)};
const authority=create({state_root:process.argv[2]});
await authority.revokeAuthorizationV1(JSON.parse(process.argv[3]));
process.stdout.write('READY');
setInterval(()=>{},1000);
`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, root, JSON.stringify(revocation)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) child.kill('SIGKILL'); });
    child.on('close', (code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)));
  });
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).state, 'REVOKED_BEFORE_FIRST_ADMISSION');
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: EPISODE })).revocation.authenticated_revocation_digest, D('c'));
  restarted.closeV1();
}));

test('revocation after reservation blocks key loading and remains terminal after restart', async () => withRoot(async root => {
  provision(root);
  const request = reservation();
  const authority = await openWithChallenge(root, request);
  await authority.consumeEpisodeOrdinalV1(request.value);
  const checkpoint = { episode_id: EPISODE, ordinal: 1, admission_digest: D('8'), prepared_transaction_digest: D('d') };
  await authority.recordPreparedV1({ ...checkpoint, semantic_transaction_digest: D('a') });
  const predecessor = request.value.successor_state;
  const successor = applyHumanRevocationV1({ state: predecessor, authorization_digest: AUTHORIZATION });
  assert.equal(await authority.revokeAuthorizationV1({
    episode_id: EPISODE,
    mandate_digest: MANDATE,
    authorization_digest: AUTHORIZATION,
    executor_release_sha256: RELEASE,
    predecessor_state: predecessor.state,
    predecessor_state_digest: predecessor.state_digest,
    revoked_state_digest: successor.state_digest,
    revoked_at_unix_seconds: 1900000011,
    revocation_digest: D('c'),
    successor_state: successor,
  }), 'REVOKED');
  await assert.rejects(() => authority.recordKeyLoadStartedV1(checkpoint),
    error => error.code === 'bounded_agent_authorization_revoked');
  authority.closeV1();
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).state, 'REVOKED_BEFORE_ACQUISITION_SIGNING');
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: EPISODE })).ordinals[0].stage, 'PREPARED');
  restarted.closeV1();
}));

test('ambiguous and signed-after-revocation commits survive SIGKILL', async () => withRoot(async root => {
  provision(root);
  const request = reservation();
  let authority = await openWithChallenge(root, request);
  await authority.consumeEpisodeOrdinalV1(request.value);
  const checkpoint = { episode_id: EPISODE, ordinal: 1, admission_digest: D('8'), prepared_transaction_digest: D('d') };
  await authority.recordPreparedV1({ ...checkpoint, semantic_transaction_digest: D('a') });
  await authority.recordKeyLoadStartedV1(checkpoint);
  authority.closeV1();
  const predecessor = request.value.successor_state;
  const successor = applyHumanRevocationV1({ state: predecessor, authorization_digest: AUTHORIZATION });
  const revocation = {
    episode_id: EPISODE, mandate_digest: MANDATE, authorization_digest: AUTHORIZATION,
    executor_release_sha256: RELEASE, predecessor_state: predecessor.state,
    predecessor_state_digest: predecessor.state_digest, revoked_state_digest: successor.state_digest,
    revoked_at_unix_seconds: 1900000012, revocation_digest: D('c'), successor_state: successor,
  };
  const signed = createSignedLegacyWire();
  const signedWirePath = join(root, 'signed-wire-raced-revocation.bin');
  await writeFile(signedWirePath, signed.wire, { mode: 0o600 });
  const signedValue = {
    ...checkpoint, signed_intent_digest: D('e'), semantic_transaction_digest: D('a'),
    message_sha256: signed.message_sha256, transaction_signature: signed.transaction_signature,
    signed_wire_sha256: createHash('sha256').update(signed.wire).digest('hex'), signed_wire_path: signedWirePath,
  };
  const workerPath = join(root, 'crash-revocation-race-worker.mjs');
  const moduleUrl = new URL('./sqlite-decision-authority-v1.mjs', import.meta.url).href;
  await writeFile(workerPath, `import { createCrashDurableDecisionAuthorityV1 as create } from ${JSON.stringify(moduleUrl)};
const authority=create({state_root:process.argv[2]});
const operation=process.argv[3];
const value=JSON.parse(process.argv[4]);
if(operation==='revoke')await authority.revokeAuthorizationV1(value);
if(operation==='signed')await authority.recordSignedIntentDurableV1(value);
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
  await killAfterCommit('revoke', revocation);
  authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await authority.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).state, 'ACQUISITION_ADMITTED');
  assert.equal((await authority.inspectEpisodeV1({ episode_id: EPISODE })).revoked, true);
  authority.closeV1();
  await killAfterCommit('signed', signedValue);
  authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await authority.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).state, 'RESOLUTION_REQUIRED_AFTER_REVOCATION');
  assert.equal((await authority.inspectEpisodeV1({ episode_id: EPISODE })).ordinals[0].stage, 'SIGNED_INTENT_DURABLE');
  authority.closeV1();
}));

test('signed-bytes-durable revocation commit survives SIGKILL', async () => withRoot(async root => {
  provision(root);
  const request = reservation();
  let authority = await openWithChallenge(root, request);
  await authority.consumeEpisodeOrdinalV1(request.value);
  const checkpoint = { episode_id: EPISODE, ordinal: 1, admission_digest: D('8'), prepared_transaction_digest: D('d') };
  await authority.recordPreparedV1({ ...checkpoint, semantic_transaction_digest: D('a') });
  await authority.recordKeyLoadStartedV1(checkpoint);
  const signed = createSignedLegacyWire();
  const signedWirePath = join(root, 'signed-wire-before-revocation.bin');
  await writeFile(signedWirePath, signed.wire, { mode: 0o600 });
  await authority.recordSignedIntentDurableV1({
    ...checkpoint, signed_intent_digest: D('e'), semantic_transaction_digest: D('a'),
    message_sha256: signed.message_sha256, transaction_signature: signed.transaction_signature,
    signed_wire_sha256: createHash('sha256').update(signed.wire).digest('hex'), signed_wire_path: signedWirePath,
  });
  authority.closeV1();
  const predecessor = request.value.successor_state;
  const successor = applyHumanRevocationV1({ state: predecessor, authorization_digest: AUTHORIZATION });
  const revocation = {
    episode_id: EPISODE, mandate_digest: MANDATE, authorization_digest: AUTHORIZATION,
    executor_release_sha256: RELEASE, predecessor_state: predecessor.state,
    predecessor_state_digest: predecessor.state_digest, revoked_state_digest: successor.state_digest,
    revoked_at_unix_seconds: 1900000012, revocation_digest: D('c'), successor_state: successor,
  };
  const workerPath = join(root, 'crash-signed-revocation-worker.mjs');
  const moduleUrl = new URL('./sqlite-decision-authority-v1.mjs', import.meta.url).href;
  await writeFile(workerPath, `import { createCrashDurableDecisionAuthorityV1 as create } from ${JSON.stringify(moduleUrl)};
const authority=create({state_root:process.argv[2]});
await authority.revokeAuthorizationV1(JSON.parse(process.argv[3]));
process.stdout.write('READY');
setInterval(()=>{},1000);
`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, root, JSON.stringify(revocation)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) child.kill('SIGKILL'); });
    child.on('close', (code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)));
  });
  authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await authority.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).state, 'RESOLUTION_REQUIRED_AFTER_REVOCATION');
  assert.equal((await authority.inspectEpisodeV1({ episode_id: EPISODE })).revoked, true);
  authority.closeV1();
}));

test('crash checkpoints remain monotonic and exact signed bytes cannot be replaced', async () => withRoot(async root => {
  provision(root);
  const request = reservation();
  const authority = await openWithChallenge(root, request);
  assert.equal(await authority.consumeEpisodeOrdinalV1(request.value), 'CONSUMED');
  const checkpoint = { episode_id: EPISODE, ordinal: 1, admission_digest: D('8'), prepared_transaction_digest: D('d') };
  await authority.recordPreparedV1({ ...checkpoint, semantic_transaction_digest: D('a') });
  await authority.recordKeyLoadStartedV1(checkpoint);
  const trailing = createSignedLegacyWire({ trailing_message_bytes: Buffer.from([0x99]) });
  const trailingPath = join(root, 'signed-wire-trailing.bin');
  await writeFile(trailingPath, trailing.wire, { mode: 0o600 });
  await assert.rejects(() => authority.recordSignedIntentDurableV1({
    ...checkpoint,
    signed_intent_digest: D('e'),
    semantic_transaction_digest: D('a'),
    message_sha256: trailing.message_sha256,
    transaction_signature: trailing.transaction_signature,
    signed_wire_sha256: createHash('sha256').update(trailing.wire).digest('hex'),
    signed_wire_path: trailingPath,
  }), error => error.code === 'bounded_agent_durable_state_untrustworthy');
  const oversizedPath = join(root, 'signed-wire-oversized.bin');
  const oversized = Buffer.alloc(1233, 1);
  await writeFile(oversizedPath, oversized, { mode: 0o600 });
  await assert.rejects(() => authority.recordSignedIntentDurableV1({
    ...checkpoint,
    signed_intent_digest: D('e'),
    semantic_transaction_digest: D('a'),
    message_sha256: D('b'),
    transaction_signature: '3'.repeat(88),
    signed_wire_sha256: createHash('sha256').update(oversized).digest('hex'),
    signed_wire_path: oversizedPath,
  }), error => error.code === 'bounded_agent_durable_state_untrustworthy');
  const signed = createSignedLegacyWire();
  const signedWire = signed.wire;
  const signedWirePath = join(root, 'signed-wire-acquisition.bin');
  await writeFile(signedWirePath, signedWire, { mode: 0o600 });
  await chmod(signedWirePath, 0o600);
  const wireHash = createHash('sha256').update(signedWire).digest('hex');
  await authority.recordSignedIntentDurableV1({
    ...checkpoint,
    signed_intent_digest: D('e'),
    semantic_transaction_digest: D('a'),
    message_sha256: signed.message_sha256,
    transaction_signature: signed.transaction_signature,
    signed_wire_sha256: wireHash,
    signed_wire_path: signedWirePath,
  });
  await assert.rejects(() => authority.recordSignedIntentDurableV1({
    ...checkpoint,
    signed_intent_digest: D('f'),
    semantic_transaction_digest: D('a'),
    message_sha256: signed.message_sha256,
    transaction_signature: '4'.repeat(88),
    signed_wire_sha256: wireHash,
    signed_wire_path: signedWirePath,
  }), error => error.code === 'bounded_agent_durable_state_untrustworthy');
  authority.closeV1();
  const restarted = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await restarted.inspectEpisodeV1({ episode_id: EPISODE })).ordinals[0].stage, 'SIGNED_INTENT_DURABLE');
  await writeFile(signedWirePath, Buffer.from(signedWire).fill(0));
  await assert.rejects(() => restarted.inspectEpisodeV1({ episode_id: EPISODE }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
  restarted.closeV1();
}));

test('individually valid but impossible episode-state and ordinal-stage combinations fail on restart', async () => withRoot(async root => {
  provision(root);
  const request = reservation();
  const authority = await openWithChallenge(root, request);
  await authority.consumeEpisodeOrdinalV1(request.value);
  authority.closeV1();
  const impossibleState = recordSignedIntentV1({
    state: request.value.successor_state,
    signed_intent_digest: D('e'),
  });
  const statePath = join(root, 'bounded-agent-decision-authority-v1.sqlite');
  const tamper = new DatabaseSync(statePath);
  tamper.prepare('UPDATE episode_states SET state_digest = ?, state_json = ? WHERE episode_id = ?')
    .run(impossibleState.state_digest, canonicalJson(impossibleState), EPISODE);
  tamper.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
}));

test('startup binds self-hashed state authority and ordinal successor identities', async () => withRoot(async root => {
  provision(root);
  const request = reservation();
  let authority = await openWithChallenge(root, request);
  await authority.consumeEpisodeOrdinalV1(request.value);
  authority.closeV1();
  const statePath = join(root, 'bounded-agent-decision-authority-v1.sqlite');
  let tamper = new DatabaseSync(statePath);
  const row = tamper.prepare('SELECT * FROM ordinals WHERE episode_id = ? AND ordinal = 1').get(EPISODE);
  row.successor_state_digest = D('f');
  row.row_digest = sha256CanonicalJson({
    authority_version: 'artifact_bounded_agent_durable_decision_authority_v1',
    ...Object.fromEntries(['episode_id', 'ordinal', 'phase', 'predecessor_state', 'predecessor_state_digest',
      'decision_id', 'challenge_id', 'admission_digest', 'successor_state_digest', 'stage',
      'prepared_transaction_digest', 'signed_intent_digest', 'semantic_transaction_digest', 'message_sha256',
      'transaction_signature', 'signed_wire_sha256', 'signed_wire_path', 'finalized_evidence_digest'].map(field => [field, row[field]])),
  });
  tamper.prepare('UPDATE ordinals SET successor_state_digest = ?, row_digest = ? WHERE episode_id = ? AND ordinal = 1')
    .run(row.successor_state_digest, row.row_digest, EPISODE);
  tamper.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');

  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  provision(root);
  tamper = new DatabaseSync(statePath);
  const trustedState = initialState();
  const alteredState = { ...trustedState, mandate_digest: D('f'), state_id: `episode-state-${'0'.repeat(64)}`, state_digest: '0'.repeat(64) };
  const preimage = Object.fromEntries(Object.entries(alteredState).filter(([field]) => !['state_id', 'state_digest'].includes(field)));
  alteredState.state_digest = sha256CanonicalJson(preimage);
  alteredState.state_id = `episode-state-${alteredState.state_digest}`;
  tamper.prepare('UPDATE episode_states SET state_digest = ?, state_json = ? WHERE episode_id = ?')
    .run(alteredState.state_digest, canonicalJson(alteredState), EPISODE);
  tamper.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
}));

test('self-hashed revocation rows must reconstruct to the retained terminal revoked state', async () => withRoot(async root => {
  provision(root);
  let authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  const predecessor = await authority.loadCurrentEpisodeStateV1({ episode_id: EPISODE });
  const successor = applyHumanRevocationV1({ state: predecessor, authorization_digest: AUTHORIZATION });
  await authority.revokeAuthorizationV1({
    episode_id: EPISODE, mandate_digest: MANDATE, authorization_digest: AUTHORIZATION,
    executor_release_sha256: RELEASE, predecessor_state: predecessor.state,
    predecessor_state_digest: predecessor.state_digest, revoked_state_digest: successor.state_digest,
    revoked_at_unix_seconds: 1900000012, revocation_digest: D('c'), successor_state: successor,
  });
  authority.closeV1();
  const statePath = join(root, 'bounded-agent-decision-authority-v1.sqlite');
  const tamper = new DatabaseSync(statePath);
  const row = tamper.prepare('SELECT * FROM revocations WHERE episode_id = ?').get(EPISODE);
  row.predecessor_state_digest = D('f');
  row.row_digest = sha256CanonicalJson({
    authority_version: 'artifact_bounded_agent_durable_decision_authority_v1',
    episode_id: row.episode_id, predecessor_state: row.predecessor_state,
    predecessor_state_digest: row.predecessor_state_digest, revoked_state_digest: row.revoked_state_digest,
    revoked_at_unix_seconds: row.revoked_at_unix_seconds,
    authenticated_revocation_digest: row.authenticated_revocation_digest,
  });
  tamper.prepare('UPDATE revocations SET predecessor_state_digest = ?, row_digest = ? WHERE episode_id = ?')
    .run(row.predecessor_state_digest, row.row_digest, EPISODE);
  tamper.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
}));

test('database and SQLite sidecars must remain executor-owned, private, and bounded before open', async () => withRoot(async root => {
  provision(root);
  const statePath = join(root, 'bounded-agent-decision-authority-v1.sqlite');
  if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
    await chown(statePath, 65534, 65534);
    assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
      error => error.code === 'bounded_agent_durable_state_untrustworthy');
    await chown(statePath, 0, 0);
  }
  const walPath = `${statePath}-wal`;
  await writeFile(walPath, Buffer.alloc(0), { mode: 0o600 });
  await truncate(walPath, 64 * 1024 * 1024 + 1);
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
}));

test('missing ordinal and revocation rows are rejected against their retained episode state', async () => withRoot(async root => {
  provision(root);
  const statePath = join(root, 'bounded-agent-decision-authority-v1.sqlite');
  const baselinePath = join(root, 'cross-product-baseline.sqlite');
  await copyFile(statePath, baselinePath);
  const request = reservation();
  let authority = await openWithChallenge(root, request);
  await authority.consumeEpisodeOrdinalV1(request.value);
  authority.closeV1();
  let tamper = new DatabaseSync(statePath);
  tamper.exec('PRAGMA foreign_keys=OFF; DELETE FROM ordinals;');
  tamper.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
  await copyFile(baselinePath, statePath);
  authority = createCrashDurableDecisionAuthorityV1({ state_root: root });
  const predecessor = initialState();
  const successor = applyHumanRevocationV1({ state: predecessor, authorization_digest: AUTHORIZATION });
  await authority.revokeAuthorizationV1({
    episode_id: EPISODE, mandate_digest: MANDATE, authorization_digest: AUTHORIZATION,
    executor_release_sha256: RELEASE, predecessor_state: predecessor.state,
    predecessor_state_digest: predecessor.state_digest, revoked_state_digest: successor.state_digest,
    revoked_at_unix_seconds: 1900000010, revocation_digest: D('c'), successor_state: successor,
  });
  authority.closeV1();
  tamper = new DatabaseSync(statePath);
  tamper.exec('PRAGMA foreign_keys=OFF; DELETE FROM revocations;');
  tamper.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
}));

test('corrupt, missing, and valid empty replacement databases fail closed', async () => withRoot(async root => {
  provision(root);
  const statePath = join(root, 'bounded-agent-decision-authority-v1.sqlite');
  const snapshotPath = join(root, 'snapshot.sqlite');
  await copyFile(statePath, snapshotPath);
  const tamper = new DatabaseSync(statePath);
  tamper.prepare('DELETE FROM episode_states').run();
  tamper.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
  await copyFile(snapshotPath, statePath);
  const empty = new DatabaseSync(statePath);
  empty.exec('PRAGMA foreign_keys=OFF; DELETE FROM episode_states; DELETE FROM episodes;');
  empty.close();
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
  await rm(statePath);
  await rm(`${statePath}-wal`, { force: true });
  await rm(`${statePath}-shm`, { force: true });
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
  await writeFile(statePath, '');
  assert.throws(() => createCrashDurableDecisionAuthorityV1({ state_root: root }),
    error => error.code === 'bounded_agent_durable_state_untrustworthy');
  assert.equal(typeof snapshotPath, 'string');
}));

test('older internally valid snapshot is not locally detectable without an external non-rollback anchor', async () => withRoot(async root => {
  provision(root);
  const statePath = join(root, 'bounded-agent-decision-authority-v1.sqlite');
  const snapshotPath = join(root, 'older-valid.sqlite');
  await copyFile(statePath, snapshotPath);
  const request = reservation();
  const authority = await openWithChallenge(root, request);
  await authority.consumeEpisodeOrdinalV1(request.value);
  authority.closeV1();
  await copyFile(snapshotPath, statePath);
  const rolledBack = createCrashDurableDecisionAuthorityV1({ state_root: root });
  assert.equal((await rolledBack.loadCurrentEpisodeStateV1({ episode_id: EPISODE })).state, 'AUTHORIZED_DORMANT');
  rolledBack.closeV1();
}));
