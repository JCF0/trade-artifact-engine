import test, { before, after } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, sign } from 'node:crypto';
import { copyPublishedPackageV1, publishRetainedPackageV1 } from './custody.mjs';
import { loadRetainedEpisodePackageV1 } from '../../src/verification-scope-v1-3/final-proof-agent/retained-episode-package-v1.mjs';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { computeCandidateMemberDigestV13 } from '../../src/verification-scope-v1-3/explicit-candidate-selection.mjs';
import { validateRetainedSimulationV1, validateRetainedRpcPhaseV1 } from '../../src/verification-scope-v1-3/final-proof-agent/retained-supervision-v1.mjs';
import { buildOrcaMessageBoundaryV1 } from '../../src/verification-scope-v1-3/final-proof-agent/orca-message-boundary-v1.mjs';
import assert from 'node:assert/strict';
import * as fixture from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/recovered-runtime-offline-v2.mjs';
test('V2 producer fixture supplies authentic recovered setup evidence in its own signing domain', () => {
  assert.equal(typeof fixture.recoveredRuntimeFixtureV2, 'function', 'V2 producer fixture is not implemented');
  const f = fixture.recoveredRuntimeFixtureV2();
  try {
    assert.equal(f.mandate.mandate_profile, 'ARTIFACT_DISPOSABLE_RECOVERED_SETUP_OFFLINE_TEST_ONLY_V2');
    assert.equal(f.configuration.setup_provenance.version, 'artifact_production_recovered_setup_evidence_v2');
  } finally { f.cleanup(); }
});

let root, inventory, release;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
before(() => {
  const parent = process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT || tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  root = mkdtempSync(join(parent, 'v2-producer-replay-')); inventory = join(root, 'release.json');
  const child = spawnSync('/usr/bin/python3', [fileURLToPath(new URL('./inventory.py', import.meta.url)), inventory],
    { env: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, child.stderr); release = hash(readFileSync(inventory));
});
after(() => { if (root && !process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT) rmSync(root, { recursive: true, force: true }); });
function verifyCopy(copy, label, accepts = true) {
  const args = [fileURLToPath(new URL('./verify-isolated.py', import.meta.url)), inventory, release,
    copy.root, copy.expected_manifest_sha256, copy.expected_evidence_kind];
  const child = spawnSync('/usr/bin/python3', args, { env: { PYTHONDONTWRITEBYTECODE: '1' }, cwd: '/tmp', encoding: 'utf8', timeout: 120000, maxBuffer: 8388608 });
  writeFileSync(join(root, label + '-verification.json'), canonicalJson({ argv: ['/usr/bin/python3', ...args],
    exit: child.status, stdout: child.stdout, stderr: child.stderr, descriptor: copy }), { mode: 0o600 });
  assert.match(child.stderr, /VERIFIER_ISOLATION/);
  if (accepts === null) return child; // Inspect a semantic refusal result or a closed verifier stop.
  if (!accepts) { assert.notEqual(child.status, 0, 'tampered package admitted'); return child; }
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function replay(original, label) {
  const copy = copyPublishedPackageV1(original, join(root, label));
  assert.deepEqual(readFileSync(join(copy.root, 'manifest.json')), readFileSync(join(original.root, 'manifest.json')));
  const manifest = JSON.parse(readFileSync(join(copy.root, 'manifest.json')));
  for (const member of manifest.members) assert.deepEqual(readFileSync(join(copy.root, member.path)), readFileSync(join(original.root, member.path)));
  const control = JSON.parse(readFileSync(join(copy.root, 'control.json')));
  assert.equal(control.version, 'artifact_retained_control_v3');
  assert.equal(control.mandate.mandate_profile, 'ARTIFACT_DISPOSABLE_RECOVERED_SETUP_OFFLINE_TEST_ONLY_V2');
  assert.equal(Object.hasOwn(control.mandate.setup_authority, 'setup_archive_sha256'), false);
  assert.equal(control.setup_provenance.evidence_member, 'recovered-setup.json');
  const evidence = JSON.parse(readFileSync(join(copy.root, 'recovered-setup.json')));
  const publicEvidence = JSON.parse(readFileSync(new URL('../../src/verification-scope-v1-3/final-proof-agent/fixtures/recovered-setup-v2.json', import.meta.url)));
  assert.equal(evidence.provenance_base64, publicEvidence.provenance_base64);
  assert.deepEqual(evidence.records, publicEvidence.records);
  assert.equal(hash(Buffer.from(evidence.attestation_base64, 'base64')), control.mandate.setup_authority.custodian_attestation_sha256);
  const result = verifyCopy(copy, label);
  assert.equal(result.setup_provenance.status, 'RECOVERED_PROVENANCE_ACCEPTED_UNDER_V2');
  assert.equal(result.setup_provenance.original_execution_archive, 'UNKNOWN');
  assert.equal(result.setup_provenance.historical_byte_continuity, 'NOT_ATTESTED');
  assert.equal(result.setup_provenance.retained_subset_members_verified, 8);
  assert.equal(result.setup_provenance.recovery_inventory_member_identities_verified, 652);
  assert.equal(result.setup_provenance.full_recovery_bundle_member_bytes, 'NOT_VERIFIED_NOT_ALL_RETAINED');
  assert.equal(result.setup_provenance.transfer_archive_bytes, 'NOT_VERIFIED_NOT_RETAINED');
  assert.equal(result.demo_summary.full_demonstration_success, false);
  assert.match(result.demo_summary.public_wording, /No onchain occurrence or live final demonstration is asserted/);
  return result;
}
test('V2 producer signs and schedules both synthetic legs, publishes original bytes and independently replays explicit selection', async () => {
  const f = fixture.recoveredRuntimeFixtureV2();
  try {
    f.open();
    for (const [i, phase] of ['ACQUISITION', 'DISPOSAL'].entries()) {
      const decision = await f.sign(phase);
      assert.equal(decision.decision.mandate_digest, f.mandate.mandate_digest);
      assert.equal((await f.runtime.trusted.submitRetainedIntentV1(i + 1)).classification, 'FINALIZED_SUCCESS');
      await f.runtime.trusted.finalizeRetainedIntentV1(i + 1);
    }
    assert.equal(f.effects.filter(x => x === 'send').length, 2);
    assert.equal(f.effects.filter(x => x === 'simulateTransaction').length, 2);
    const original = await publishRetainedPackageV1(f.runtime, f.stateRoot, 2);
    const unselected = replay(original, 'complete-unselected');
    assert.equal(unselected.demonstration.contract_satisfied, false);
    const population = await f.runtime.trusted.inspectRetainedExportCandidatesV1(2);
    const selection = { candidate_population_digest: population.population_digest,
      requested_candidate_digest: computeCandidateMemberDigestV13({ candidate_population_digest: population.population_digest,
        episode_disposition: population.episode_dispositions[0] }) };
    const selected = await publishRetainedPackageV1(f.runtime, f.stateRoot, 2, selection);
    const result = replay(selected, 'complete-selected');
    assert.equal(result.control.status, 'AUTHENTICATED');
    assert.equal(result.control.state.state, 'DISPOSAL_EVIDENCE_CLOSED');
    assert.equal(result.transmission.status, 'RECONCILED');
    assert.equal(result.transmission.legs.length, 2);
    assert.equal(result.eligibility.status, 'ELIGIBLE');
    assert.equal(result.eligibility.legs.length, 2);
    assert.equal(result.economic_observations.transactions.length, 2);
    assert.equal(result.demonstration.contract_satisfied, true);
    assert.equal(result.demo_summary.synthetic_demonstration_success, true);
    assert.equal(result.demo_summary.full_demonstration_success, false);
    assert.equal(hash(readFileSync(join(original.root, 'manifest.json'))), original.expected_manifest_sha256);
  } finally { f.cleanup(); }
});

import { buildFixedTestAgentDecisionV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/fixed-test-identities-v1.mjs';
import { createCrashDurableDecisionAuthorityV1 } from '../../src/verification-scope-v1-3/final-proof-agent/sqlite-decision-authority-v1.mjs';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from '../../src/verification-scope-v1-3/final-proof-agent/human-revocation-v1.mjs';
import { validateProductionWigglesConfigurationV1 } from '../../src/verification-scope-v1-3/final-proof-agent/wiggles-production-configuration-v1.mjs';
import { validateRecoveredSetupEvidenceV2 } from '../../src/verification-scope-v1-3/final-proof-agent/recovered-setup-v2.mjs';

test('V2 authenticated refusal publishes and independently reconstructs without signing or scheduling', async () => {
  const f = fixture.recoveredRuntimeFixtureV2();
  try {
    f.open();
    const challenge = await f.runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'); f.source.time.wall++;
    const decision = buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge, 'REFUSE_ACQUISITION');
    assert.equal((await f.runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(decision)))).status, 'REFUSED');
    await f.runtime.trusted.captureRetainedOutcomeSourceV1(1);
    const original = await publishRetainedPackageV1(f.runtime, f.stateRoot, 1);
    const result = replay(original, 'refused');
    assert.equal(result.control.state.state, 'AGENT_REFUSED_ACQUISITION');
    assert.equal(result.control.status, 'AUTHENTICATED');
    assert.equal(result.demonstration.contract_satisfied, false);
    assert.equal(result.demo_summary.full_demonstration_success, false);
    assert.equal(f.effects.some(x => ['send', 'simulateTransaction'].includes(x)), false);
  } finally { f.cleanup(); }
});
test('V2 human revocation remains authenticated after publication and fresh isolated replay', async () => {
  const f = fixture.recoveredRuntimeFixtureV2();
  try {
    f.open(); await f.sign();
    await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1);
    f.source.time.wall += 10;
    const authority = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot }); let state;
    try { state = await authority.loadCurrentEpisodeStateV1({ episode_id: `bounded-agent-episode-${f.authorization.authorization_digest}` }); }
    finally { authority.closeV1(); }
    const unsigned = { episode_id: state.episode_id, mandate_digest: f.mandate.mandate_digest,
      authorization_digest: f.authorization.authorization_digest, human_public_key: f.authorization.human_public_key,
      predecessor_state: state.state, predecessor_state_digest: state.state_digest, revoked_at_unix_seconds: f.source.time.wall,
      revocation_nonce: 'v2-producer-disposable-revocation', revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION' };
    const revocation = buildHumanRevocationV1({ ...unsigned,
      signature: sign(null, humanRevocationSigningBytesV1(unsigned), fixture.syntheticRecoveredHumanPrivateKeyV2()).toString('hex') });
    await f.runtime.supervisor.revokeAuthenticatedBytesV1(Buffer.from(canonicalJson(revocation)));
    const original = await publishRetainedPackageV1(f.runtime, f.stateRoot, 1);
    const result = replay(original, 'revoked');
    assert.equal(result.control.status, 'REVOKED');
    assert.equal(result.control.state.human_revocation_status, 'REVOKED');
    assert.equal(result.demonstration.contract_satisfied, false);
    assert.equal(result.demo_summary.full_demonstration_success, false);
    assert.equal(f.effects.filter(x => x === 'send').length, 1);
  } finally { f.cleanup(); }
});
test('V2 direct production configuration validates newly enrolled non-RFC human and agent without a live factory', () => {
  const c = fixture.recoveredProductionConfigurationFixtureV2();
  assert.notEqual(c.authorization.human_public_key, c.mandate.offline_identity.human_authorization_public_key);
  assert.notEqual(c.authorization.agent_public_key, c.mandate.offline_identity.agent_control_public_key);
  assert.ok(validateProductionWigglesConfigurationV1(c, 1900000010));
  assert.equal(validateRecoveredSetupEvidenceV2({ mandate: c.mandate, authorization: c.authorization,
    evidence: c.setup_provenance, now: 1900000010, mode: 'admission' }), true);
  assert.throws(() => validateProductionWigglesConfigurationV1(c, 1900001001));
  assert.equal(validateRecoveredSetupEvidenceV2({ mandate: c.mandate, authorization: c.authorization,
    evidence: c.setup_provenance, now: 1900001001, mode: 'replay' }), true);
  for (const defect of ['missing', 'enrollment', 'provenance', 'attestation', 'record']) {
    const bad = structuredClone(c);
    if (defect === 'missing') delete bad.setup_provenance;
    if (defect === 'enrollment') bad.setup_provenance.enrollment.signature = '0'.repeat(128);
    if (defect === 'provenance') bad.setup_provenance.provenance_base64 = Buffer.from('{}\n').toString('base64');
    if (defect === 'attestation') {
      const a = JSON.parse(Buffer.from(bad.setup_provenance.attestation_base64, 'base64'));
      a.signature = '0'.repeat(128); bad.setup_provenance.attestation_base64 = Buffer.from(canonicalJson(a)).toString('base64');
    }
    if (defect === 'record') bad.setup_provenance.records.pop();
    assert.throws(() => validateProductionWigglesConfigurationV1(bad, 1900000010), defect);
  }
});

import { validateWigglesRuntimeConfigurationV1 } from '../../src/verification-scope-v1-3/final-proof-agent/wiggles-trusted-runtime-v1.mjs';
test('V2 expired enrollment refuses new admission but retained attestation still publishes and independently replays', async () => {
  const f = fixture.recoveredRuntimeFixtureV2({ enrollment_not_after: 1900000020 });
  try {
    f.open(); await f.sign();
    await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1);
    f.source.time.wall = 1900000021;
    assert.throws(() => validateWigglesRuntimeConfigurationV1(f.configuration, f.source.time.wall));
    const before = f.effects.length;
    const original = await publishRetainedPackageV1(f.runtime, f.stateRoot, 1);
    const result = replay(original, 'expired-attestation');
    assert.equal(result.control.status, 'AUTHENTICATED');
    assert.equal(result.control.state.state, 'ACQUISITION_EVIDENCE_CLOSED');
    assert.equal(result.demonstration.contract_satisfied, false);
    assert.equal(result.demo_summary.full_demonstration_success, false);
    assert.equal(f.effects.length, before, 'retained replay must not dispatch additional effects');
  } finally { f.cleanup(); }
});

function rewritePackageMember(copy, name, bytes) {
  writeFileSync(join(copy.root, name), bytes, { mode: 0o600 });
  const manifest = JSON.parse(readFileSync(join(copy.root, 'manifest.json')));
  const member = manifest.members.find(m => m.path === name);
  assert.ok(member); member.bytes = bytes.length; member.sha256 = hash(bytes);
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  writeFileSync(join(copy.root, 'manifest.json'), manifestBytes, { mode: 0o600 });
  return { ...copy, expected_manifest_sha256: hash(manifestBytes) };
}
test('V3 replay binds original runtime deadline to activity and submission after complete rehash', async t => {
  const f = fixture.recoveredRuntimeFixtureV2();
  try {
    f.open(); await f.sign();
    await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1);
    const original = await publishRetainedPackageV1(f.runtime, f.stateRoot, 1);
    const originalControl = JSON.parse(readFileSync(join(original.root, 'control.json')));
    for (const defect of ['control-at-admission', 'submission-beyond-enrollment']) await t.test(defect, () => {
      let copy = copyPublishedPackageV1(original, join(root, 'deadline-' + defect));
      const control = structuredClone(originalControl);
      if (defect === 'control-at-admission') {
        control.runtime_deadline_unix_seconds = control.legs[0].admitted_at_unix_seconds;
        assert.ok(control.runtime_deadline_unix_seconds > control.authorization.issued_at_unix_seconds);
        copy = rewritePackageMember(copy, 'control.json', Buffer.from(canonicalJson(control)));
      } else {
        const refs = control.legs[0].submission_members;
        const bindingName = refs.find(r => r.path === 'binding.json').member;
        const completionName = refs.find(r => r.path === 'completion.json').member;
        const binding = JSON.parse(readFileSync(join(copy.root, bindingName)));
        const setup = JSON.parse(readFileSync(join(copy.root, 'recovered-setup.json')));
        binding.runtime_deadline_unix_seconds = setup.enrollment.payload.not_after_unix_seconds + 1;
        const bytes = Buffer.from(canonicalJson(binding));
        const completion = JSON.parse(readFileSync(join(copy.root, completionName)));
        completion.binding_sha256 = hash(bytes);
        copy = rewritePackageMember(copy, bindingName, bytes);
        copy = rewritePackageMember(copy, completionName, Buffer.from(canonicalJson(completion)));
      }
      assert.ok(loadRetainedEpisodePackageV1({ root: copy.root, expected_manifest_sha256: copy.expected_manifest_sha256 }));
      const child = verifyCopy(copy, 'deadline-' + defect, null);
      if (defect === 'control-at-admission' && child.status !== 0) {
        // Economic RPC rows at the same boundary can close the whole replay
        // before per-leg eligibility is reconstructed. Byte custody passed above.
        assert.equal(child.status, 1);
        assert.match(child.stderr, /PRIVATE_VERIFIER_STOPPED/);
        return;
      }
      assert.equal(child.status, 0, child.stderr); // Reach the semantic result, not confinement or byte-custody failure.
      const result = JSON.parse(child.stdout);
      if (defect === 'control-at-admission') assert.equal(result.eligibility.status, 'INELIGIBLE');
      else {
        assert.equal(result.eligibility.status, 'ELIGIBLE');
        assert.equal(result.transmission.status, 'UNRESOLVED');
      }
      assert.equal(hash(readFileSync(join(original.root, 'manifest.json'))), original.expected_manifest_sha256);
    });
  } finally { f.cleanup(); }
});
test('V3 replay enforces strict runtime bounds on simulation and economic RPC timing', async t => {
  const f = fixture.recoveredRuntimeFixtureV2();
  try {
    f.open(); await f.sign();
    await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1);
    const original = await publishRetainedPackageV1(f.runtime, f.stateRoot, 1);
    const loaded = loadRetainedEpisodePackageV1({ root: original.root, expected_manifest_sha256: original.expected_manifest_sha256 });
    const control = loaded.parseMemberV1('control.json'), leg = control.legs[0];
    const records = control.supervision.journal_members.map(p => loaded.parseMemberV1(p).record);
    const capture = loaded.parseMemberV1(leg.capture_member), { fee_message_sha256, ...source } = capture.source;
    const plan = buildOrcaMessageBoundaryV1({ ...source, mandate: control.mandate, phase: leg.challenge.phase, ordinal: 1,
      input_raw_quantity: control.mandate.economic_authority.acquisition_input_usdc_raw, retained_acquisition_jup_raw: null });
    const fact = records.find(r => r.kind === 'simulation').record;
    await t.test('simulation at runtime boundary', async () => {
      const altered = structuredClone(control);
      altered.runtime_deadline_unix_seconds = fact.completed_unix_seconds + 1;
      assert.ok(altered.runtime_deadline_unix_seconds < leg.challenge.expires_at_unix_seconds);
      let copy = copyPublishedPackageV1(original, join(root, 'simulation-deadline')), previous = null;
      for (const name of control.supervision.journal_members) {
        const entry = loaded.parseMemberV1(name);
        if (entry.record.kind === 'simulation') {
          const { simulation_digest, ...changed } = entry.record.record;
          changed.completed_unix_seconds = altered.runtime_deadline_unix_seconds;
          entry.record.record = { ...changed, simulation_digest: hash(Buffer.from(canonicalJson(changed))) };
        }
        entry.previous_sha256 = previous;
        const bytes = Buffer.from(canonicalJson(entry)); previous = hash(bytes);
        copy = rewritePackageMember(copy, name, bytes);
      }
      altered.supervision.head_sha256 = previous;
      copy = rewritePackageMember(copy, 'control.json', Buffer.from(canonicalJson(altered)));
      const retained = loadRetainedEpisodePackageV1({ root: copy.root, expected_manifest_sha256: copy.expected_manifest_sha256 });
      await assert.rejects(validateRetainedSimulationV1({ loaded: retained, control: altered, leg, plan, capture }), /RETAINED_SUPERVISION_INVALID/);
    });
    await t.test('economic request at runtime boundary', () => {
      const economic = records.filter(r => r.kind === 'economic_rpc' && r.ordinal === 1);
      const deadline = economic[0].record.started_unix_seconds;
      assert.throws(() => validateRetainedRpcPhaseV1(economic, control.supervision.phase_budgets.economic_source, 'economic_source', deadline), /RETAINED_SUPERVISION_INVALID/);
    });
  } finally { f.cleanup(); }
});
test('V2 producer originals survive byte tamper and fully rehashed provenance/enrollment/attestation/control downgrade refusals', async () => {
  const f = fixture.recoveredRuntimeFixtureV2();
  try {
    f.open(); await f.sign();
    await f.runtime.trusted.submitRetainedIntentV1(1); await f.runtime.trusted.finalizeRetainedIntentV1(1);
    const original = await publishRetainedPackageV1(f.runtime, f.stateRoot, 1);
    replay(original, 'tamper-original');
    for (const defect of ['raw-byte', 'enrollment-signature', 'attestation-signature', 'provenance-byte', 'record-byte', 'missing-record', 'v2-downgrade']) {
      let copy = copyPublishedPackageV1(original, join(root, 'tamper-' + defect));
      const name = defect === 'v2-downgrade' ? 'control.json' : 'recovered-setup.json';
      const value = JSON.parse(readFileSync(join(copy.root, name)));
      if (defect === 'raw-byte') {
        const bytes = readFileSync(join(copy.root, name));
        bytes[0] ^= 1; // Same size reaches the digest gate, not the size ceiling.
        writeFileSync(join(copy.root, name), bytes, { mode: 0o600 });
      } else {
        if (defect === 'enrollment-signature') value.enrollment.signature = '0'.repeat(128);
        if (defect === 'attestation-signature') {
          const a = JSON.parse(Buffer.from(value.attestation_base64, 'base64'));
          a.signature = '0'.repeat(128); value.attestation_base64 = Buffer.from(canonicalJson(a)).toString('base64');
        }
        if (defect === 'provenance-byte') value.provenance_base64 = Buffer.concat([Buffer.from(value.provenance_base64, 'base64'), Buffer.from(' ')]).toString('base64');
        if (defect === 'record-byte') value.records[0].base64 = Buffer.concat([Buffer.from(value.records[0].base64, 'base64'), Buffer.from(' ')]).toString('base64');
        if (defect === 'missing-record') value.records.pop();
        if (defect === 'v2-downgrade') {
          value.version = 'artifact_retained_control_v2'; delete value.setup_provenance;
          delete value.runtime_deadline_unix_seconds;
        }
        copy = rewritePackageMember(copy, name, Buffer.from(canonicalJson(value)));
      }
      const load = () => loadRetainedEpisodePackageV1({ root: copy.root, expected_manifest_sha256: copy.expected_manifest_sha256 });
      if (defect === 'raw-byte') assert.throws(load, /RETAINED_MEMBER_MISMATCH/);
      else assert.ok(load(), 'rehashing must pass byte-custody checks before semantic replay refusal');
      const child = verifyCopy(copy, 'tamper-' + defect, false);
      assert.match(child.stderr, /PRIVATE_VERIFIER_STOPPED/);
      assert.equal(hash(readFileSync(join(original.root, 'manifest.json'))), original.expected_manifest_sha256);
    }
    replay(original, 'tamper-original-after');
  } finally { f.cleanup(); }
});
