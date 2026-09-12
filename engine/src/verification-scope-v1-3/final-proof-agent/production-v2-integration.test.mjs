import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedTestMandateInputV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { buildRecoveredSetupMandateV2, RECOVERED_SETUP_AUTHORITY_V2 } from './recovered-setup-v2.mjs';
import * as profiles from './executor-mandate-profile-v1.mjs';
import { supervisedRuntimeFixtureV1 } from './fixtures/supervised-runtime-offline-v1.mjs';
import { recoveredSetupEvidenceFixtureV2 } from './fixtures/recovered-runtime-offline-v2.mjs';
import { createBoundedAgentOfflineEpisodeFixtureV1 } from './fixtures/bounded-agent-offline-v1.mjs';
import { validateEpisodeEvidenceGraphStructureV1 } from './episode-evidence-graph-v1.mjs';
import { createHash } from 'node:crypto';

test('V2 evidence graph binds authenticated recovered evidence without changing V1 graph preimages', async () => {
  const evidence = recoveredSetupEvidenceFixtureV2(), input = fixedTestMandateInputV1();
  input.setup_authority = { ...RECOVERED_SETUP_AUTHORITY_V2,
    custodian_attestation_sha256: createHash('sha256').update(Buffer.from(evidence.attestation_base64, 'base64')).digest('hex') };
  const mandate = buildRecoveredSetupMandateV2(input);
  const f = await createBoundedAgentOfflineEpisodeFixtureV1({ mandate, setup_provenance: evidence });
  assert.equal(f.mandate.mandate_digest, mandate.mandate_digest);
  assert.equal(f.evidence_graph.episode_evidence_graph_version, 'artifact_bounded_agent_episode_evidence_graph_v2');
  assert.equal(validateEpisodeEvidenceGraphStructureV1(f.evidence_graph), true);
  assert.ok(f.evidence_graph.manifest.members.some(m => m.path === 'setup/recovered-evidence.json'));
  const altered = structuredClone(f.evidence_graph); delete altered.setup_provenance;
  assert.throws(() => validateEpisodeEvidenceGraphStructureV1(altered));
});

test('production composition fixture preserves a separately supplied V2 mandate end to end', () => {
  const f = supervisedRuntimeFixtureV1({ mandate_factory: input => profiles.buildOfflineRecoveredSetupMandateV2({ ...input,
    setup_authority: { ...RECOVERED_SETUP_AUTHORITY_V2, custodian_attestation_sha256: 'a'.repeat(64) } }) });
  try {
    assert.equal(f.mandate.mandate_profile, profiles.OFFLINE_RECOVERED_SETUP_PROFILE_V2);
    assert.equal(f.configuration.mandate.mandate_digest, f.authorization.mandate_digest);
    assert.throws(() => f.open(), 'V2 runtime must reject absent custodian evidence before key/state use');
  } finally { f.cleanup(); }
});

test('executor dispatch admits real V2 identity without synthesizing V1 authority', () => {
  const input = fixedTestMandateInputV1();
  input.setup_authority = { ...RECOVERED_SETUP_AUTHORITY_V2, custodian_attestation_sha256: 'a'.repeat(64) };
  const m = buildRecoveredSetupMandateV2(input);
  assert.equal(profiles.validateExecutorMandateV1(m), true);
  assert.throws(() => profiles.assertConfiguredExecutorMandateV1(m));
});

test('V2 synthetic episode profile is disjoint from production wallet and V1', () => {
  assert.equal(typeof profiles.buildOfflineRecoveredSetupMandateV2, 'function');
  const input = fixedTestMandateInputV1();
  input.setup_authority = { ...RECOVERED_SETUP_AUTHORITY_V2, custodian_attestation_sha256: 'a'.repeat(64) };
  const m = profiles.buildOfflineRecoveredSetupMandateV2(input);
  assert.equal(profiles.validateExecutorMandateV1(m), true);
  assert.equal(m.wallet_scope.wallet, profiles.OFFLINE_WALLET_SCOPE_V1.wallet);
  assert.notEqual(m.mandate_profile, profiles.OFFLINE_WALLET_PROFILE_V1);
  assert.throws(() => profiles.validateExecutorMandateV1({ ...m, wallet_scope: input.wallet_scope }));
});

test('successor runtime inventory closes over new production source and test members', () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-inventory-'));
  try {
    const output = join(root, 'runtime.json');
    const child = spawnSync('/usr/bin/python3', [fileURLToPath(new URL('../../../deployment/private-binding/inventory.py', import.meta.url)), output],
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, child.stderr);
    const inventory = JSON.parse(readFileSync(output));
    assert.ok(inventory.members.some(m => m.path === 'source/engine/src/verification-scope-v1-3/final-proof-agent/production-v2-integration.test.mjs'), 'NEW_SUCCESSOR_SOURCE_OMITTED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
