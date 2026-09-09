import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { canonicalJson, sha256CanonicalJson as digest } from '../contract.mjs';
import { computeCandidateMemberDigestV13 } from '../explicit-candidate-selection.mjs';
import { reconstructFinalEpisodeReleaseV1 } from './final-episode-release-v1.mjs';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from './human-revocation-v1.mjs';
import { createAuthorizedEpisodeStateV1, admitAgentDecisionStateV1, recordSignedIntentV1 } from './episode-state-machine-v1.mjs';
import { retainedFinalEpisodeFixtureV1 } from './fixtures/retained-final-episode-v1.mjs';
import { hash } from './fixtures/retained-episode-offline-v1.mjs';

let base;
async function fixture() {
  base ??= retainedFinalEpisodeFixtureV1(); const f = await base;
  return { ...f, descriptor: structuredClone(f.descriptor), control: structuredClone(f.control), files: new Map([...f.files].map(([p, b]) => [p, Buffer.from(b)])) };
}
function edit(f, p, action) { const v = JSON.parse(f.files.get(p)); action(v); f.files.set(p, Buffer.from(canonicalJson(v))); }
async function evaluate(f) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-final-outcome-'));
  try { return await reconstructFinalEpisodeReleaseV1(f.write(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function acquisitionOnly(f) {
  f.descriptor.selection = null; f.descriptor.transactions.pop(); f.control.legs.pop();
  edit(f, 'history.json', v => v.result.shift());
  edit(f, 'ending-classic.json', v => { const data = Buffer.from(v.result.value[0].account.data[0], 'base64');
    data.writeBigUInt64LE(BigInt(f.control.legs[0].finalized.chain_derived_target_raw_quantity), 64); v.result.value[0].account.data[0] = data.toString('base64'); });
}
async function selectedFixture() {
  const f = await fixture();
  if (f.descriptor.selection === null) {
    const preview = await evaluate(f);
    (await base).descriptor.selection = { candidate_population_digest: preview.population.population_digest,
      requested_candidate_digest: computeCandidateMemberDigestV13({ candidate_population_digest: preview.population.population_digest,
        episode_disposition: preview.population.episode_dispositions[0] }) };
  }
  return fixture();
}
function signedState(f) {
  const c = f.control, leg = c.legs[0];
  const state = createAuthorizedEpisodeStateV1({ mandate: c.mandate, authorization: c.authorization });
  const admitted = admitAgentDecisionStateV1({ state, mandate: c.mandate, authorization: c.authorization,
    challenge: leg.challenge, decision: leg.decision, executor_release_sha256: c.authorization.executor_release_sha256,
    now_unix_seconds: leg.admitted_at_unix_seconds });
  return recordSignedIntentV1({ state: admitted.state, signed_intent_digest: digest(leg.signed_intent) });
}
function revoke(f, state) {
  const c = f.control;
  const unsigned = { episode_id: state.episode_id, mandate_digest: c.mandate.mandate_digest,
    authorization_digest: c.authorization.authorization_digest, human_public_key: c.authorization.human_public_key,
    predecessor_state: state.state, predecessor_state_digest: state.state_digest, revoked_at_unix_seconds: 1900000012,
    revocation_nonce: 'retained-offline-revocation-fixture-v1', revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION' };
  // Public RFC8032 disposable test vector; no external keys or credentials.
  const key = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')]) });
  c.revocation = buildHumanRevocationV1({ ...unsigned, signature: sign(null, humanRevocationSigningBytesV1(unsigned), key).toString('hex') });
}
for (const scenario of ['missing', 'human-signature', 'agent-signature', 'principal', 'challenge', 'ordinal']) {
  test(`valid economics cannot promote ${scenario} control provenance`, async () => {
    const f = await selectedFixture();
    if (scenario === 'missing') f.descriptor.control = null;
    if (scenario === 'human-signature') f.control.authorization.signature = '0'.repeat(128);
    if (scenario === 'agent-signature') f.control.legs[0].decision.signature = '0'.repeat(128);
    if (scenario === 'principal') f.control.configured_principals.agent_public_key = f.control.authorization.human_public_key;
    if (scenario === 'challenge') f.control.legs[0].challenge.challenge_nonce += '-changed';
    if (scenario === 'ordinal') f.control.legs[1].challenge.ordinal = 1;
    const result = await evaluate(f);
    assert.equal(result.claim.claim_evaluation.claim_outcome, 'VERIFIED');
    assert.equal(result.control.status, scenario === 'missing' ? 'MISSING' : 'INVALID');
    assert.equal(result.demonstration.contract_satisfied, false);
    assert.equal(result.demo_summary.full_demonstration_success, false);
  });
}
test('otherwise valid trades cannot overcome strict age equality at the retained original opening', async () => {
  const f = await selectedFixture(), leg = f.control.legs[0];
  const equality = f.control.mandate.setup_authority.latest_setup_block_time + f.control.mandate.age_gate.lookback_seconds;
  for (const p of leg.record_members) edit(f, p, r => {
    r.started_unix_seconds = equality; r.observed_unix_seconds = equality;
    if (r.request.method === 'getBlock') { const raw = JSON.parse(r.raw_response); raw.result.blockTime = equality; r.raw_response = JSON.stringify(raw); }
  });
  edit(f, leg.capture_member, m => { m.raw_evidence_digests = leg.record_members.map(p => digest(JSON.parse(f.files.get(p)))); });
  const result = await evaluate(f);
  assert.equal(result.claim.claim_evaluation.claim_outcome, 'VERIFIED');
  assert.equal(result.eligibility.status, 'INELIGIBLE');
  assert.match(result.eligibility.legs[0].issue.detail, /strict age equality\/ineligibility/);
  assert.equal(result.demonstration.contract_satisfied, false);
});
test('retained terminal success contradicted by independently finalized failure stays contradictory, not economic success', async () => {
  const f = await fixture(); acquisitionOnly(f); f.control.legs[0].finalized = null;
  edit(f, 'transaction-1.json', v => { v.result.meta.err = { InstructionError: [0, { Custom: 1 }] };
    v.result.meta.postTokenBalances = structuredClone(v.result.meta.preTokenBalances); v.result.meta.innerInstructions = []; });
  edit(f, 'history.json', v => { v.result[0].err = { InstructionError: [0, { Custom: 1 }] }; });
  edit(f, 'ending-classic.json', v => { const b = Buffer.from(v.result.value[0].account.data[0], 'base64'); b.writeBigUInt64LE(0n, 64); v.result.value[0].account.data[0] = b.toString('base64'); });
  const result = await evaluate(f);
  assert.equal(result.claim, null); assert.equal(result.transaction_reconciliation[0].finalized_execution_state, 'failed');
  assert.equal(result.transmission.status, 'UNRESOLVED');
  assert.equal(result.transmission.legs[0].issues[0].code, 'TERMINAL_FINALIZED_CONTRADICTION');
  assert.equal(result.demonstration.contract_satisfied, false);
});
test('signed unresolved episode preserves ambiguity without inventing a finalized economic claim', async () => {
  const f = await fixture(); f.descriptor.selection = null; f.descriptor.transactions = []; f.control.legs = [f.control.legs[0]];
  f.control.legs[0].finalized = null; f.control.legs[0].submission_members = [];
  edit(f, 'history.json', v => { v.result = []; });
  const result = await evaluate(f);
  assert.equal(result.claim, null); assert.equal(result.control.status, 'AUTHENTICATED');
  assert.equal(result.control.state.state, 'ACQUISITION_SUBMISSION_RESOLVING');
  assert.equal(result.transmission.status, 'UNRESOLVED'); assert.equal(result.demonstration.contract_satisfied, false);
});
test('authenticated revocation before first admission produces an honest empty result package', async () => {
  const f = await fixture(); f.descriptor.selection = null; f.descriptor.transactions = []; f.control.legs = [];
  edit(f, 'history.json', v => { v.result = []; });
  revoke(f, createAuthorizedEpisodeStateV1({ mandate: f.control.mandate, authorization: f.control.authorization }));
  const result = await evaluate(f);
  assert.equal(result.control.status, 'REVOKED'); assert.equal(result.control.state.state, 'REVOKED_BEFORE_FIRST_ADMISSION');
  assert.equal(result.claim, null); assert.equal(result.demonstration.contract_satisfied, false);
});
test('revocation after signing does not erase a subsequently finalized acquisition', async () => {
  const f = await fixture(); acquisitionOnly(f); revoke(f, signedState(f));
  const result = await evaluate(f);
  assert.equal(result.control.status, 'REVOKED'); assert.equal(result.control.state.state, 'REVOKED_AFTER_ACQUISITION');
  assert.equal(result.transaction_reconciliation[0].finalized_execution_state, 'succeeded');
  assert.equal(result.claim, null); assert.equal(result.demonstration.contract_satisfied, false);
});
test('a consistently finalized failed transaction preserves fees and failure without a success claim', async () => {
  const f = await retainedFinalEpisodeFixtureV1({ failed: true });
  const result = await evaluate(f);
  assert.equal(result.claim, null); assert.equal(result.control.status, 'AUTHENTICATED');
  assert.equal(result.transaction_reconciliation.length, 1);
  assert.equal(result.transaction_reconciliation[0].finalized_execution_state, 'failed');
  assert.equal(result.economic_observations.transactions[0].fee_lamports, 5000);
  assert.equal(result.transmission.legs[0].terminal_classification, 'FINALIZED_FAILURE');
  assert.equal(result.transmission.status, 'RECONCILED');
  assert.equal(result.demonstration.contract_satisfied, false);
});
test('distinct valid non-null finalized errors are contradictions, not matching failures', async () => {
  const f = await retainedFinalEpisodeFixtureV1({ failed: true });
  edit(f, 'transaction-1.json', v => { v.result.meta.err = { InstructionError: [0, { Custom: 2 }] }; });
  edit(f, 'history.json', v => { v.result[0].err = { InstructionError: [0, { Custom: 2 }] }; });
  const result = await evaluate(f);
  assert.equal(result.transmission.status, 'UNRESOLVED');
  assert.equal(result.transmission.legs[0].issues[0].code, 'TERMINAL_FINALIZED_BODY_CONTRADICTION');
  assert.equal(result.claim, null);
});
test('outer rehashing cannot bless altered nested submission evidence', async () => {
  const f = await selectedFixture();
  const p = f.control.legs[0].submission_members.find(x => x.path === 'rebroadcast/overall-provenance.json').member;
  edit(f, p, v => { v.client_send_attempts = 3; });
  const result = await evaluate(f);
  assert.equal(result.claim.claim_evaluation.claim_outcome, 'VERIFIED');
  assert.equal(result.transmission.status, 'UNRESOLVED');
  assert.equal(result.demonstration.contract_satisfied, false);
});
test('eligible capture cannot qualify a different economic opening boundary', async () => {
  const f = await selectedFixture();
  f.descriptor.opening.minimum_context_slot--;
  for (const p of [f.descriptor.opening.classic, f.descriptor.opening.token_2022]) edit(f, p, v => { v.result.context.slot--; });
  // The earlier zero boundary still admits valid economics, but is not the
  // authenticated episode's captured opening boundary.
  f.descriptor.selection = null;
  const result = await evaluate(f);
  assert.equal(result.eligibility.status, 'INELIGIBLE');
  assert.equal(result.eligibility.legs[0].issue.code, 'ECONOMIC_OPENING_CAPTURE_MISMATCH');
});
test('qualified retained episode reproduces exact result bytes in a fresh process with RPC, signing, keys and state writes denied', async () => {
  const f = await selectedFixture(), root = mkdtempSync(join(tmpdir(), 'artifact-fresh-final-'));
  try {
    const input = f.write(root), expected = canonicalJson(await reconstructFinalEpisodeReleaseV1(input));
    const snapshot = () => readdirSync(root).sort().map(p => [p, hash(readFileSync(join(root, p)))]);
    const before = snapshot();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs'; import crypto from 'node:crypto'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
      import { syncBuiltinESMExports } from 'node:module';
      const denied = () => { throw Error('REPLAY_FORBIDDEN_SIDE_EFFECT'); };
      globalThis.fetch = denied; http.request = denied; https.request = denied; net.connect = denied; net.createConnection = denied;
      crypto.sign = denied; crypto.createPrivateKey = denied; Date.now = denied;
      for (const name of ['writeFileSync','appendFileSync','mkdirSync','unlinkSync','renameSync','rmSync','writeSync']) fs[name] = denied;
      const open = fs.openSync; fs.openSync = (p, flags, ...args) => {
        if (/\\.env|keypair|credential|secret/i.test(String(p))) denied();
        if (typeof flags === 'number' ? flags & (fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC) : !['r','rs'].includes(flags)) denied();
        return open(p, flags, ...args);
      };
      syncBuiltinESMExports();
      const { reconstructFinalEpisodeReleaseV1 } = await import(${JSON.stringify(new URL('./final-episode-release-v1.mjs', import.meta.url).href)});
      const { canonicalJson } = await import(${JSON.stringify(new URL('../contract.mjs', import.meta.url).href)});
      process.stdout.write(canonicalJson(await reconstructFinalEpisodeReleaseV1(JSON.parse(process.argv[1]))));
    `, JSON.stringify(input)], { encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, expected); assert.deepEqual(snapshot(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
