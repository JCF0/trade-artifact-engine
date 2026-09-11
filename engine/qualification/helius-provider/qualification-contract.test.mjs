// Focused offline contract tests; no transport or signer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { admitQualificationInputV1, buildQualificationMessageV1 } from './qualification-contract-v1.mjs';
import { buildOrcaMessageBoundaryV1 } from '/accepted/engine/src/verification-scope-v1-3/final-proof-agent/orca-message-boundary-v1.mjs';
import { validateExecutorMandateV1 } from '/accepted/engine/src/verification-scope-v1-3/final-proof-agent/executor-mandate-profile-v1.mjs';
import { createHash } from 'node:crypto';
import { constructAndSimulate } from './construction.mjs';
const root = '/root/artifact-private-helius-provider-qualification/qualification-construction-v1';
const envelope = JSON.parse(readFileSync(root + '/candidate-input.json'));
const oldInput = JSON.parse(readFileSync('/root/artifact-private-helius-provider-qualification-continuation/local-2/confined/evidence/build-positive/construction.json')).input;
function input(context) {
  const { mandate, retained_acquisition_jup_raw, ...values } = oldInput;
  return { version: 'ARTIFACT_QUALIFICATION_CONSTRUCTION_INPUT_V1', qualification_provenance_sha256: context.qualification_provenance_sha256,
    scope: context.scope, ...values };
}
test('recovered provenance produces an explicitly distinct qualification plan with identical message bytes', () => {
  const context = admitQualificationInputV1(envelope);
  const q = buildQualificationMessageV1(context, input(context));
  const old = buildOrcaMessageBoundaryV1(oldInput);
  assert.equal(q.version, 'ARTIFACT_QUALIFICATION_UNSIGNED_PLAN_V1');
  assert.equal(q.message_base64, old.message_base64);
  assert.equal(q.message_sha256, old.message_sha256);
  assert.notEqual(q.qualification_input_sha256, old.input_digest);
  assert.equal(Object.hasOwn(q, 'mandate_digest'), false);
  assert.equal(Object.hasOwn(context, 'setup_archive_sha256'), false);
  assert.equal(q.qualification_provenance_sha256, envelope.qualification_provenance_sha256);
});
const copy = x => JSON.parse(JSON.stringify(x));
test('forged context is rejected before any provider call in orchestration', async () => {
  let calls = 0;
  const session = { call() { calls++; throw Error('must not dispatch'); } };
  const c = admitQualificationInputV1(envelope);
  await assert.rejects(constructAndSimulate(session, copy(c), 1, '/unused'));
  assert.equal(calls, 0);
});
const digest = b => createHash('sha256').update(b).digest('hex');
test('member alterations, hash mismatches and self-rehashed contradictory setup cannot be admitted', () => {
  const variants = [];
  let v = copy(envelope); v.members[0].base64 = Buffer.from('altered').toString('base64'); variants.push(v);
  v = copy(envelope); v.members[0].path = 'unexpected'; variants.push(v);
  v = copy(envelope); v.members.push(v.members[0]); variants.push(v);
  v = copy(envelope); v.validation_base64 = Buffer.from('{}').toString('base64'); variants.push(v);
  v = copy(envelope);
  const i = v.members.findIndex(m => m.path === 'ata-creation-finalized.json');
  const ata = JSON.parse(Buffer.from(v.members[i].base64, 'base64')); ata.block_time += 1;
  const bytes = Buffer.from(JSON.stringify(ata)); v.members[i].base64 = bytes.toString('base64');
  variants.push(copy(v));
  const provenance = JSON.parse(Buffer.from(v.provenance_base64, 'base64'));
  provenance.recovered_public.members[i].sha256 = digest(bytes); provenance.recovered_public.members[i].bytes = bytes.length;
  const raw = Buffer.from(JSON.stringify(provenance)); v.provenance_base64 = raw.toString('base64'); v.qualification_provenance_sha256 = digest(raw);
  variants.push(v);
  for (const variant of variants) assert.throws(() => admitQualificationInputV1(variant));
});
test('input and provenance versions, unknown nested fields and hostile accessors fail closed', () => {
  for (const change of [v => v.version = 'ARTIFACT_QUALIFICATION_INPUT_V2', v => v.extra = true,
    v => v.members[0].extra = true, v => v.members = '', v => v.qualification_provenance_sha256 = '0'.repeat(64),
    v => { const p = JSON.parse(Buffer.from(v.provenance_base64, 'base64')); p.schema += '_UNSUPPORTED'; v.provenance_base64 = Buffer.from(JSON.stringify(p)).toString('base64'); }]) {
    const v = copy(envelope); change(v); assert.throws(() => admitQualificationInputV1(v));
  }
  let hits = 0; const v = copy(envelope); Object.defineProperty(v, 'version', { enumerable: true, get() { hits++; throw Error('getter'); } });
  assert.throws(() => admitQualificationInputV1(v)); assert.equal(hits, 0);
});
test('all fixed scopes and construction/economic contradictions are rejected', () => {
  const c = admitQualificationInputV1(envelope);
  const changes = [v => v.version += '_UNSUPPORTED', v => v.extra = 1, v => v.phase = 'DISPOSAL', v => v.ordinal = 2,
    v => v.input_raw_quantity = '5000001', v => v.fee_lamports = '5001', v => v.blockhash = 'invalid',
    v => v.tick_spacing = 0, v => v.tick_spacing = 65536, v => v.tick_current_index = 443637,
    v => v.tick_current_index = 1.5, v => v.quoted_output_raw = '0', v => v.minimum_output_raw = v.quoted_output_raw + '0',
    v => v.minimum_output_raw = '1', v => v.qualification_provenance_sha256 = '1'.repeat(64)];
  for (const key of Object.keys(c.scope)) changes.push(v => { v.scope[key].extra = true; });
  for (const change of changes) { const v = copy(input(c)); change(v); assert.throws(() => buildQualificationMessageV1(c, v)); }
  assert.throws(() => buildQualificationMessageV1(copy(c), input(c)));
});
test('qualification input, context and plan cannot enter production mandate or builder boundaries', () => {
  const c = admitQualificationInputV1(envelope), i = input(c), p = buildQualificationMessageV1(c, i);
  for (const value of [envelope, c, i, p]) {
    assert.throws(() => validateExecutorMandateV1(value));
    assert.throws(() => buildOrcaMessageBoundaryV1({ ...oldInput, mandate: value }));
  }
});
test('message equivalence covers negative, shifted and maximum tick cases; identity and output detach', () => {
  const c = admitQualificationInputV1(envelope);
  for (const tick of [-1, 0, 63, 443635]) {
    const v = { ...input(c), tick_spacing: 64, tick_current_index: tick };
    const q = buildQualificationMessageV1(c, v);
    const old = buildOrcaMessageBoundaryV1({ ...oldInput, tick_spacing: 64, tick_current_index: tick });
    assert.equal(q.message_base64, old.message_base64);
    assert.notEqual(q.qualification_input_sha256, old.input_digest);
    const identity = q.qualification_plan_sha256; v.blockhash = 'invalid'; assert.equal(q.qualification_plan_sha256, identity);
    assert.throws(() => { q.message_base64 = ''; });
  }
});
