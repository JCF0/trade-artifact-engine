import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { buildOfflineWalletMandateV1 } from '../../src/verification-scope-v1-3/final-proof-agent/executor-mandate-profile-v1.mjs';
import { fixedTestMandateInputV1, buildFixedTestAuthorizationV1, buildFixedTestChallengeV1, buildFixedTestAgentDecisionV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/fixed-test-identities-v1.mjs';
import { createAuthorizedEpisodeStateV1 } from '../../src/verification-scope-v1-3/final-proof-agent/episode-state-machine-v1.mjs';
import { createPrivateKey, sign } from 'node:crypto';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from '../../src/verification-scope-v1-3/final-proof-agent/human-revocation-v1.mjs';
const url = new URL('./control-client-v2.mjs', import.meta.url);
const client = existsSync(url) ? await import(url) : {};
const mandate = buildOfflineWalletMandateV1(fixedTestMandateInputV1());
const authorization = buildFixedTestAuthorizationV1(mandate);
const state = createAuthorizedEpisodeStateV1({mandate, authorization});
const challenge = buildFixedTestChallengeV1({mandate, authorization, state, phase:'ACQUISITION', nonce:'host-fixture-acquisition-0001'});
const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge, 'REFUSE_ACQUISITION');
const input = b => { const p = new PassThrough(); p.end(Buffer.from(b)); return p; };
const framed = v => input(canonicalJson(v) + '\n');
function ports(envelope = canonicalJson(decision)) {
  const sent = new PassThrough(), custody = new PassThrough();
  let exact = '', frames = '';
  sent.on('data', b => exact += b); custody.on('data', b => frames += b);
  return {mandate, authorization, acquisitionChallenge:framed(challenge), acquisitionResult:framed({status:'REFUSED', episode_id:challenge.episode_id, signed_intent_digest:null}),
    acquisitionEnvelope:input(envelope), acquisition:sent, custody, timeout_ms:100,
    exact:() => exact, frames:() => frames};
}
test('custody client validates externally signed canonical decision and forwards exact bytes once with EOF', async () => {
  assert.equal(typeof client.runControlClientV2, 'function', 'missing custody control client');
  const p = ports();
  assert.equal(await client.runControlClientV2(p), 'REFUSED');
  assert.equal(p.exact(), canonicalJson(decision)); assert.equal(p.acquisition.writableEnded, true);
  assert.match(p.frames(), /ACQUISITION_CHALLENGE/); assert.match(p.frames(), /ACQUISITION_RESULT/);
});
test('independent human client authenticates external revocation without controller admission', async () => {
  const url = new URL('./human-client-v2.mjs', import.meta.url);
  assert.ok(existsSync(url), 'missing independent human custody client');
  const human = await import(url);
  const unsigned = {episode_id:state.episode_id, mandate_digest:mandate.mandate_digest,
    authorization_digest:authorization.authorization_digest, human_public_key:authorization.human_public_key,
    predecessor_state:state.state, predecessor_state_digest:state.state_digest,
    revoked_at_unix_seconds:1900000011, revocation_nonce:'host-human-revocation-0001',
    revocation_statement:'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION'};
  const key = createPrivateKey({key:Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex'), format:'der', type:'pkcs8'});
  const envelope = buildHumanRevocationV1({...unsigned, signature:sign(null,humanRevocationSigningBytesV1(unsigned),key).toString('hex')});
  const context = new PassThrough(), custody = new PassThrough(), revoke = new PassThrough();
  let exact = '', frames = ''; revoke.on('data', b => exact += b); custody.on('data', b => frames += b);
  context.write(Buffer.from(canonicalJson({version:'artifact_private_human_context_v1', episode_id:state.episode_id,
    mandate_digest:mandate.mandate_digest, authorization_digest:authorization.authorization_digest,
    human_public_key:authorization.human_public_key, predecessor_state:state.state,
    predecessor_state_digest:state.state_digest}) + '\n'));
  const result = await human.runHumanClientV2({mandate,authorization,context,custody,revoke,
    envelope:input(canonicalJson(envelope)), acknowledgment:framed({status:'REVOCATION_DURABLE', revocation_result:'REVOKED', state:'REVOKED_BEFORE_ACQUISITION'}), timeout_ms:200});
  assert.equal(result.status, 'REVOCATION_DURABLE'); assert.equal(exact, canonicalJson(envelope));
  assert.ok(revoke.writableEnded); assert.match(frames, /HUMAN_CONTEXT/); assert.match(frames, /HUMAN_ACKNOWLEDGMENT/);
});
for (const [name, bytes] of [
  ['duplicate', canonicalJson(decision) + canonicalJson(decision)],
  ['selector', canonicalJson({...decision, op:'send', path:'/opt/wallet', transport:'rpc'})],
  ['bad-signature', canonicalJson({...decision, signature:'0'.repeat(128)})],
  ['noncanonical', JSON.stringify(decision)], ['eof', ''], ['over-limit', ' '.repeat(131073)],
]) test(`external control ${name} refuses without forwarding an envelope`, async () => {
  const p = ports(bytes);
  await assert.rejects(client.runControlClientV2(p)); assert.equal(p.exact(), '');
});
test('withheld envelope EOF reaches finite STOP, never admission', async () => {
  const p = ports(); p.acquisitionEnvelope = new PassThrough();
  p.acquisitionEnvelope.write(Buffer.from(canonicalJson(decision)));
  await assert.rejects(client.runControlClientV2(p)); assert.equal(p.exact(), '');
});
test('frames survive chunk boundaries and pretty-print newlines; partial EOF refuses', async () => {
  const p = new PassThrough();
  const work = (async () => { const values = []; for await (const v of client.framesV2(p, 200)) values.push(v); return values; })();
  const bytes = canonicalJson({a:1}) + '\n' + canonicalJson({b:2}) + '\n';
  for (const byte of Buffer.from(bytes)) p.write(Buffer.from([byte])); p.end();
  assert.deepEqual(await work, [{a:1},{b:2}]);
  await assert.rejects(async () => { for await (const v of client.framesV2(input('{\n'), 100)) void v; });
});
test('independent human relay reaches existing durable runtime revocation while controller withholds EOF', async () => {
  const {supervisedRuntimeFixtureV1} = await import('../../src/verification-scope-v1-3/final-proof-agent/fixtures/supervised-runtime-offline-v1.mjs');
  const {createCrashDurableDecisionAuthorityV1} = await import('../../src/verification-scope-v1-3/final-proof-agent/sqlite-decision-authority-v1.mjs');
  const {runFiniteEpisodeV1} = await import('./supervisor.mjs');
  const {runHumanClientV2} = await import('./human-client-v2.mjs');
  const f = supervisedRuntimeFixtureV1(), runtime = f.open();
  const authority = createCrashDurableDecisionAuthorityV1({state_root:f.stateRoot});
  const episode_id = `bounded-agent-episode-${f.authorization.authorization_digest}`;
  const channels = Object.fromEntries(['acquisition','challenge1','result1','disposal','challenge2','result2','human','context','acknowledgment','result'].map(k => [k,new PassThrough()]));
  const envelope = new PassThrough(), custody = new PassThrough();
  let signed = false;
  const signer = (async () => {
    for await (const frame of client.framesV2(custody, 5000)) {
      if (frame.kind !== 'HUMAN_CONTEXT' || signed) continue;
      signed = true;
      const c = frame.value;
      const unsigned = {episode_id, mandate_digest:f.mandate.mandate_digest, authorization_digest:f.authorization.authorization_digest,
        human_public_key:f.authorization.human_public_key, predecessor_state:c.predecessor_state, predecessor_state_digest:c.predecessor_state_digest,
        revoked_at_unix_seconds:f.source.clock.unixSeconds(), revocation_nonce:'host-runtime-revocation-0001',
        revocation_statement:'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION'};
      const key = createPrivateKey({key:Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex'), format:'der', type:'pkcs8'});
      envelope.end(Buffer.from(canonicalJson(buildHumanRevocationV1({...unsigned, signature:sign(null,humanRevocationSigningBytesV1(unsigned),key).toString('hex')}))));
    }
  })();
  signer.catch(() => {});
  try {
    const human = runHumanClientV2({mandate:f.mandate, authorization:f.authorization, context:channels.context,
      revoke:channels.human, acknowledgment:channels.acknowledgment, envelope,custody,timeout_ms:5000});
    const work = runFiniteEpisodeV1({runtime,channels,decision_timeout_ms:4000,episode_timeout_ms:5000,
      humanContext:async () => { const s = await authority.loadCurrentEpisodeStateV1({episode_id});
        return {version:'artifact_private_human_context_v1',episode_id,mandate_digest:f.mandate.mandate_digest,
          authorization_digest:f.authorization.authorization_digest,human_public_key:f.authorization.human_public_key,
          predecessor_state:s.state,predecessor_state_digest:s.state_digest}; }, publish:async () => { throw Error('NO_PACKAGE_CLAIM'); }});
    const [ack, result] = await Promise.all([human,work]);
    assert.equal(ack.status,'REVOCATION_DURABLE'); assert.equal(result.status,'STOPPED');
    const durable = await authority.inspectEpisodeV1({episode_id}); assert.equal(durable.revoked,true);
    assert.equal(durable.ordinals.length,0); assert.ok(signed);
  } finally {
    custody.destroy(); await signer.catch(() => {});
    Object.values(channels).forEach(s => s.destroy()); envelope.destroy();
    authority.closeV1(); f.cleanup();
  }
});
