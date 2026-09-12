import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../contract.mjs';
import { buildHumanEpisodeAuthorizationV1, humanAuthorizationSigningBytesV1 } from './human-authorization-v1.mjs';

const publicEvidence = JSON.parse(readFileSync(new URL('./fixtures/recovered-setup-v2.json', import.meta.url)));
function key() {
  const pair = generateKeyPairSync('ed25519');
  return {...pair, hex: pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex')};
}
function fixture() {
  const human = key(), custodian = key(), agent = key();
  const enrollmentPayload = {
    version: 'artifact_production_recovered_setup_enrollment_v1',
    human_public_key: human.hex, custodian_public_key: custodian.hex,
    not_before_unix_seconds: 1899999900, not_after_unix_seconds: 1900001000,
    enrollment_nonce: 'synthetic-enrollment-nonce-v2',
    recovered_provenance_sha256: core.RECOVERED_SETUP_AUTHORITY_V2.recovered_provenance_sha256,
  };
  const enrollment = {payload: enrollmentPayload, signature: sign(null, core.recoveredSetupEnrollmentSigningBytesV2(enrollmentPayload), human.privateKey).toString('hex')};
  const payload = {
    schema: 'ARTIFACT_PRODUCTION_RECOVERED_SETUP_CUSTODIAN_V1',
    custodian_public_key: custodian.hex, issued_at_unix_seconds: 1900000000,
    attestation_nonce: 'synthetic-custodian-nonce-v2',
    recovered_provenance_sha256: core.RECOVERED_SETUP_AUTHORITY_V2.recovered_provenance_sha256,
    transfer_archive_sha256: core.RECOVERED_SETUP_AUTHORITY_V2.transfer_archive_sha256,
    source_host: 'Wiggles', source_account: 'ricemachine',
    source_public_directory: '/home/ricemachine/.artifact-calibration-local/v1/public/final-proof-wallet/',
    original_execution_archive_status: 'UNKNOWN', historical_byte_continuity: 'NOT_ATTESTED',
    custody_statement: 'I_ATTEST_THE_EXACT_PINNED_RECOVERED_RECORDS_AND_SOURCE_LOCATION_AS_THE_PUBLIC_RECORDS_I_SUPPLY_FOR_THIS_SETUP_NOT_AN_ORIGINAL_EXECUTION_ARCHIVE',
    scope_statement: 'RECOVERED_SETUP_PROVENANCE_ONLY_NOT_TRADING_AUTHORIZATION_OR_CURRENT_ELIGIBILITY',
  };
  const attestation = {payload, signature: sign(null, core.recoveredSetupCustodianSigningBytesV2(payload), custodian.privateKey).toString('hex')};
  const input = fixedTestMandateInputV1();
  input.setup_authority = {...core.RECOVERED_SETUP_AUTHORITY_V2, custodian_attestation_sha256: sha256CanonicalJson(attestation)};
  input.unresolved_live_readiness = {...input.offline_identity, human_authorization_public_key: human.hex, agent_control_public_key: agent.hex, status:'RESOLVED'};
  delete input.unresolved_live_readiness.profile;
  const mandate = core.buildRecoveredSetupMandateV2(input);
  const unsigned = {
    mandate_digest: mandate.mandate_digest, human_public_key: human.hex, agent_public_key: agent.hex,
    executor_release_sha256: input.unresolved_live_readiness.executor_release_sha256,
    authorization_nonce: 'synthetic-human-authorization-v2', issued_at_unix_seconds: 1900000010,
    not_before_unix_seconds: mandate.age_gate.earliest_opening_candidate_unix_seconds,
    acquisition_not_after_unix_seconds: input.unresolved_live_readiness.acquisition_not_after_unix_seconds,
    authorization_statement: 'AUTHORIZE_ONE_BOUNDED_AGENT_DIRECTED_TWO_SWAP_FINAL_PROOF_EPISODE', revocation_status: 'NOT_REVOKED',
  };
  const authorization = buildHumanEpisodeAuthorizationV1({...unsigned, signature:sign(null,humanAuthorizationSigningBytesV1(unsigned),human.privateKey).toString('hex')});
  const evidence = {...structuredClone(publicEvidence), version:'artifact_production_recovered_setup_evidence_v2', enrollment,
    attestation_base64: Buffer.from(canonicalJson(attestation)).toString('base64')};
  return {mandate, authorization, evidence, now:1900000020, mode:'admission', human, custodian, agent};
}

test('authenticated human enrollment admits actual pinned public recovery, never claims full bundle replay', () => {
  assert.equal(typeof core.validateRecoveredSetupEvidenceV2, 'function');
  const f = fixture();
  assert.equal(core.validateRecoveredSetupEvidenceV2(f), true);
  assert.equal(core.assertLiveReadyRecoveredSetupMandateV2(f.mandate), true);
  assert.equal(core.RECOVERED_SETUP_REQUIRED_RECORD_PATHS_V2.length, 8);
  assert.equal(JSON.parse(Buffer.from(f.evidence.provenance_base64,'base64')).recovered_public.members.length, 652);
});
import { fixedTestMandateInputV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { buildBoundedAgentMandateV1, validateBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { sha256CanonicalJson } from '../contract.mjs';

test('known fixed test identities cannot enroll as production custodians', () => {
  const f = fixture();
  const payload = {...f.evidence.enrollment.payload, custodian_public_key: f.mandate.offline_identity.human_authorization_public_key};
  assert.throws(() => core.recoveredSetupEnrollmentSigningBytesV2(payload), /test|custodian/i);
});

import { domainSeparatedCanonicalBytesV1 } from './authentication-domain-v1.mjs';
import * as core from './recovered-setup-v2.mjs';
function resignAuthorization(f, overrides = {}) {
  const {authorization_id, authorization_digest, authorization_version, signature, ...unsigned} = f.authorization;
  Object.assign(unsigned, {mandate_digest:f.mandate.mandate_digest}, overrides);
  f.authorization = buildHumanEpisodeAuthorizationV1({...unsigned, signature:sign(null,humanAuthorizationSigningBytesV1(unsigned),f.human.privateKey).toString('hex')});
}
function rebindAttestation(f, mutate, signer = f.custodian) {
  const envelope = JSON.parse(Buffer.from(f.evidence.attestation_base64,'base64'));
  mutate(envelope);
  envelope.signature = sign(null, domainSeparatedCanonicalBytesV1(core.RECOVERED_SETUP_CUSTODIAN_DOMAIN_V2,envelope.payload),signer.privateKey).toString('hex');
  f.evidence.attestation_base64 = Buffer.from(canonicalJson(envelope)).toString('base64');
  const {mandate_version,mandate_profile,mandate_id,mandate_digest,...input} = structuredClone(f.mandate);
  input.setup_authority.custodian_attestation_sha256 = sha256CanonicalJson(envelope);
  f.mandate = core.buildRecoveredSetupMandateV2(input);
  resignAuthorization(f);
}
function resignEnrollment(f) {
  f.evidence.enrollment.signature = sign(null,domainSeparatedCanonicalBytesV1(core.RECOVERED_SETUP_ENROLLMENT_DOMAIN_V2,f.evidence.enrollment.payload),f.human.privateKey).toString('hex');
}

test('late historical replay verifies retained times without Date.now; admission requires actual now', () => {
  const f = fixture();
  const old = Date.now;
  Date.now = () => {throw new Error('wall clock must not be read');};
  try {
    assert.equal(core.validateRecoveredSetupEvidenceV2({...f, mode:'replay', now:undefined}),true);
    assert.equal(core.validateRecoveredSetupEvidenceV2({...f, mode:'replay', now:9000000000}),true);
    for (const now of [undefined,null,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1,1899999999,1900001001,9000000000]) {
      assert.throws(() => core.validateRecoveredSetupEvidenceV2({...f,now}), /actual now/);
    }
    assert.equal(core.validateRecoveredSetupEvidenceV2({...f,now:1900000010}),true);
    assert.equal(core.validateRecoveredSetupEvidenceV2({...f,now:1900001000}),true);
  } finally {Date.now = old;}
});

for (const [name,mutate,expected] of [
  ['unknown evidence field', f=>{f.evidence.extra=true;}, /field/],
  ['missing enrollment', f=>{delete f.evidence.enrollment;}, /field/],
  ['wrong evidence version', f=>{f.evidence.version='v1';}, /version/],
  ['missing member', f=>{f.evidence.records.pop();}, /subset/],
  ['duplicate member', f=>{f.evidence.records[1]=f.evidence.records[0];}, /duplicate/],
  ['unknown member', f=>{f.evidence.records[0].path='setup-preflight.json';}, /unknown/],
  ['traversal member', f=>{f.evidence.records[0].path='../setup-freeze.json';}, /unknown/],
  ['member unknown field', f=>{f.evidence.records[0].sha256='a'.repeat(64);}, /field/],
  ['noncanonical base64', f=>{f.evidence.provenance_base64+='\n';}, /base64/],
  ['substituted member bytes', f=>{f.evidence.records[0].base64=Buffer.from('{}\n').toString('base64');}, /differs/],
  ['reformatted original provenance', f=>{f.evidence.provenance_base64=Buffer.from(JSON.stringify(JSON.parse(Buffer.from(f.evidence.provenance_base64,'base64')))).toString('base64');}, /original provenance/],
  ['erased historical blocked admission', f=>{const p=JSON.parse(Buffer.from(f.evidence.provenance_base64,'base64'));delete p.admission;f.evidence.provenance_base64=Buffer.from(canonicalJson(p)).toString('base64');}, /original provenance/],
  ['forged enrollment signature', f=>{f.evidence.enrollment.signature='0'.repeat(128);}, /signature/],
  ['custodian self-enrollment signature', f=>{f.evidence.enrollment.signature=sign(null,core.recoveredSetupEnrollmentSigningBytesV2(f.evidence.enrollment.payload),f.custodian.privateKey).toString('hex');}, /signature/],
  ['untrusted enrollment human key', f=>{f.evidence.enrollment.payload.human_public_key=key().hex;}, /human-enrolled/],
  ['different enrolled custodian', f=>{f.evidence.enrollment.payload.custodian_public_key=key().hex;resignEnrollment(f);}, /human-enrolled/],
  ['enrollment field added', f=>{f.evidence.enrollment.payload.mandate_digest=f.mandate.mandate_digest;}, /field/],
  ['enrollment envelope field added', f=>{f.evidence.enrollment.trusted=true;}, /field/],
  ['enrollment pin substitution', f=>{f.evidence.enrollment.payload.recovered_provenance_sha256='a'.repeat(64);resignEnrollment(f);}, /scope/],
  ['enrollment after attestation', f=>{f.evidence.enrollment.payload.not_before_unix_seconds=1900000001;resignEnrollment(f);}, /times/],
  ['enrollment expires before authorization', f=>{f.evidence.enrollment.payload.not_after_unix_seconds=1900000009;resignEnrollment(f);}, /times/],
  ['custodian signature by untrusted key', f=>{rebindAttestation(f,()=>{},key());}, /signature/],
  ['custodian changed source claim', f=>{rebindAttestation(f,a=>{a.payload.source_host='Elsewhere';});}, /source_host/],
  ['custodian claims historical continuity', f=>{rebindAttestation(f,a=>{a.payload.historical_byte_continuity='ATTESTED';});}, /historical_byte_continuity/],
  ['custodian adds authority', f=>{rebindAttestation(f,a=>{a.payload.trading_authority=true;});}, /field/],
  ['custodian null time', f=>{rebindAttestation(f,a=>{a.payload.issued_at_unix_seconds=null;});}, /time/],
  ['custodian invalid nonce', f=>{rebindAttestation(f,a=>{a.payload.attestation_nonce='short';});}, /nonce/],
  ['future attestation relative to auth', f=>{rebindAttestation(f,a=>{a.payload.issued_at_unix_seconds=1900000011;});}, /times/],
  ['future authorization relative to now', f=>{resignAuthorization(f,{issued_at_unix_seconds:1900000021});}, /actual now/],
  ['authorization bound to wrong mandate', f=>{resignAuthorization(f,{mandate_digest:'b'.repeat(64)});}, /authenticate/],
  ['authorization stale signature', f=>{f.authorization={...f.authorization,signature:'0'.repeat(128)};}, /signature/],
  ['implicit mode', f=>{delete f.mode;}, /mode/],
]) {
  test(`recovered evidence rejects ${name}`, () => {
    const f=fixture(); mutate(f);
    assert.throws(()=>core.validateRecoveredSetupEvidenceV2(f),expected);
  });
}

test('historical replay still rejects a correctly signed future attestation', () => {
  const f=fixture();rebindAttestation(f,a=>{a.payload.issued_at_unix_seconds=1900000011;});
  assert.throws(()=>core.validateRecoveredSetupEvidenceV2({...f,mode:'replay',now:9000000000}),/times/);
});

for (const [name, mutate] of [
  ['mixed V1 archive field',s=>{s.setup_archive_sha256='a'.repeat(64);}],
  ['original archive claim',s=>{s.original_execution_archive={...s.original_execution_archive,sha256:'a'.repeat(64)};}],
  ['original archive nested extra field',s=>{s.original_execution_archive={...s.original_execution_archive,extra:true};}],
  ['provenance pin',s=>{s.recovered_provenance_sha256='a'.repeat(64);}],
  ['transfer pin',s=>{s.transfer_archive_sha256='a'.repeat(64);}],
  ['freeze pin',s=>{s.setup_freeze_sha256='a'.repeat(64);}],
  ['manifest pin',s=>{s.setup_evidence_manifest_sha256='a'.repeat(64);}],
  ['age boundary',s=>{s.latest_setup_block_time++;}],
  ['missing custodian',s=>{delete s.custodian_attestation_sha256;}],
]) test(`V2 mandate rejects ${name}`,()=>{
  const input=fixedTestMandateInputV1(); input.setup_authority={...core.RECOVERED_SETUP_AUTHORITY_V2,custodian_attestation_sha256:'a'.repeat(64)};
  mutate(input.setup_authority); assert.throws(()=>core.buildRecoveredSetupMandateV2(input));
});

test('V1 and V2 reject each others real discriminators and setup shape',()=>{
  const v1=buildBoundedAgentMandateV1(fixedTestMandateInputV1());
  assert.throws(()=>core.validateRecoveredSetupMandateV2(v1));
  const f=fixture();
  assert.throws(()=>validateBoundedAgentMandateV1(f.mandate));
  const mutated=structuredClone(f.mandate); mutated.mandate_digest='a'.repeat(64);
  assert.throws(()=>core.validateRecoveredSetupMandateV2(mutated),/identity/);
});
test('V1 golden mandate digest remains byte-stable', () => {
  assert.equal(buildBoundedAgentMandateV1(fixedTestMandateInputV1()).mandate_digest,
    '15c444cc0b05d1a30f8bd32203a04df3c5d700bf2dc2f7cb2e4bfc8afd3fee62');
});

test('every shared V1 field retains the same acceptance under V2', () => {
  const base = fixedTestMandateInputV1();
  const accepts = (build, input) => {try {build(input);return true;} catch {return false;}};
  for (const section of Object.keys(base).filter(name=>name!=='setup_authority')) {
    for (const field of Object.keys(base[section])) {
      for (const invalid of [null, 'OUTSIDE_SCOPE', 999, false, [], {}]) {
        const oldInput=structuredClone(base); oldInput[section][field]=invalid;
        const newInput=structuredClone(oldInput);
        newInput.setup_authority={...core.RECOVERED_SETUP_AUTHORITY_V2,custodian_attestation_sha256:'a'.repeat(64)};
        assert.equal(accepts(core.buildRecoveredSetupMandateV2,newInput),accepts(buildBoundedAgentMandateV1,oldInput), `${section}.${field}`);
      }
    }
  }
});

test('V2 builds its own digest and preserves every economic constraint', () => {
  assert.equal(typeof core.buildRecoveredSetupMandateV2, 'function');
  const input = fixedTestMandateInputV1();
  const v1 = buildBoundedAgentMandateV1(input);
  input.setup_authority = { ...core.RECOVERED_SETUP_AUTHORITY_V2, custodian_attestation_sha256: 'a'.repeat(64) };
  const v2 = core.buildRecoveredSetupMandateV2(input);
  assert.equal(core.validateRecoveredSetupMandateV2(v2), true);
  assert.notEqual(v1.mandate_digest, v2.mandate_digest);
  const {mandate_id, mandate_digest, ...preimage} = v2;
  assert.equal(mandate_digest, sha256CanonicalJson(preimage));
  assert.equal(mandate_id, `bounded-agent-mandate-${mandate_digest}`);
  assert.equal(Object.hasOwn(v2.setup_authority, 'setup_archive_sha256'), false);
  assert.throws(() => core.assertLiveReadyRecoveredSetupMandateV2(v2));
  input.economic_authority.maximum_slippage_bps = 51;
  assert.throws(() => core.buildRecoveredSetupMandateV2(input));
});
