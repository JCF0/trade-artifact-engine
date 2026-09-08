import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { fixedTestMandateInputV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { buildHumanEpisodeAuthorizationV1, humanAuthorizationSigningBytesV1 } from './human-authorization-v1.mjs';
import { sha256CanonicalJson } from '../contract.mjs';
import { validateProductionWigglesConfigurationV1 } from './wiggles-production-configuration-v1.mjs';
import { createOfflineTrustedWigglesRuntimeV1 } from './wiggles-trusted-runtime-v1.mjs';
import { syntheticRuntimeCaptureV1 } from './fixtures/trusted-runtime-offline-v1.mjs';

// Disposable authority keys and labeled synthetic hashes for structural checking
// ONLY. Not real human identities, an approved release, or wallet signing evidence.
function structuralFixture(change = () => {}) {
  const input = fixedTestMandateInputV1();
  const human = generateKeyPairSync('ed25519'), agent = generateKeyPairSync('ed25519');
  const publicHex = k => k.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const budget = syntheticRuntimeCaptureV1(buildBoundedAgentMandateV1(input)).budget;
  for (const key of ['setup_archive_sha256', 'setup_freeze_sha256', 'setup_evidence_manifest_sha256']) {
    input.setup_authority[key] = sha256CanonicalJson({ synthetic_not_approved: key });
  }
  input.unresolved_live_readiness = { human_authorization_public_key: publicHex(human), agent_control_public_key: publicHex(agent),
    acquisition_not_after_unix_seconds: 2000000000, rpc_budget_table_sha256: sha256CanonicalJson(budget),
    executor_release_sha256: sha256CanonicalJson({ synthetic_not_approved: 'release' }), status: 'RESOLVED' };
  change(input);
  const mandate = buildBoundedAgentMandateV1(input), live = mandate.unresolved_live_readiness;
  const unsigned = { mandate_digest: mandate.mandate_digest, human_public_key: live.human_authorization_public_key,
    agent_public_key: live.agent_control_public_key, executor_release_sha256: live.executor_release_sha256,
    authorization_nonce: 'synthetic-structural-not-approved', issued_at_unix_seconds: 1900000000,
    not_before_unix_seconds: mandate.age_gate.earliest_opening_candidate_unix_seconds,
    acquisition_not_after_unix_seconds: live.acquisition_not_after_unix_seconds,
    authorization_statement: 'AUTHORIZE_ONE_BOUNDED_AGENT_DIRECTED_TWO_SWAP_FINAL_PROOF_EPISODE', revocation_status: 'NOT_REVOKED' };
  const authorization = buildHumanEpisodeAuthorizationV1({ ...unsigned,
    signature: sign(null, humanAuthorizationSigningBytesV1(unsigned), human.privateKey).toString('hex') });
  return { mandate, authorization, executor_release_sha256: live.executor_release_sha256, budget,
    expected_wallet: mandate.wallet_scope.wallet, wallet_key_path: '/NONEXISTENT/wallet.json',
    state_root: '/NONEXISTENT/authority', deadline_unix_seconds: 2000000100 };
}

test('structural configuration checks are not production release or a test-factory bypass', () => {
  const c = structuralFixture();
  assert.ok(validateProductionWigglesConfigurationV1(c, 1900000010));
  let calls = 0;
  assert.throws(() => createOfflineTrustedWigglesRuntimeV1(c, { transport() { calls++; }, clock: { unixSeconds: () => 1900000010 } }), /offline disposable/);
  assert.equal(calls, 0);
});
for (const field of ['mandate', 'authorization', 'executor_release_sha256', 'expected_wallet', 'wallet_key_path', 'state_root', 'budget', 'deadline_unix_seconds']) {
  test(`production structural preflight rejects missing ${field}`, () => {
    const c = structuralFixture(); delete c[field];
    assert.throws(() => validateProductionWigglesConfigurationV1(c, 1900000010));
  });
}
test('production preflight refuses expired acquisition even when executor deadline remains open', () => {
  const c = structuralFixture();
  assert.throws(() => validateProductionWigglesConfigurationV1(c, 2000000000), /production authority/);
});
for (const defect of ['budget', 'release', 'wallet', 'authorization']) test(`production preflight refuses inconsistent ${defect}`, () => {
  const c = structuralFixture();
  if (defect === 'budget') c.budget.total_calls--;
  if (defect === 'release') c.executor_release_sha256 = '0'.repeat(64);
  if (defect === 'wallet') c.expected_wallet = '11111111111111111111111111111111';
  if (defect === 'authorization') c.authorization = { ...c.authorization, signature: '0'.repeat(128) };
  assert.throws(() => validateProductionWigglesConfigurationV1(c, 1900000010));
});
for (const defect of ['agent_control_public_key', 'executor_release_sha256', 'rpc_budget_table_sha256']) {
  test(`production preflight rejects placeholder ${defect} despite valid human signature`, () => {
    const c = structuralFixture(input => { input.unresolved_live_readiness[defect] = '0'.repeat(64); });
    assert.throws(() => validateProductionWigglesConfigurationV1(c, 1900000010));
  });
}
test('production preflight rejects known fixed agent identity despite valid independent human signature', () => {
  const c = structuralFixture(input => { input.unresolved_live_readiness.agent_control_public_key = input.offline_identity.agent_control_public_key; });
  assert.throws(() => validateProductionWigglesConfigurationV1(c, 1900000010));
});

test('proposed deployment template has no invented authority and remains rejected', async () => {
  const { WIGGLES_CONFIGURATION_TEMPLATE_V1: c, WIGGLES_LAUNCH_PROPOSAL_V1: launch } = await import('../../../deployment/wiggles-supervised-v1.example.mjs');
  assert.equal(c.mandate, null); assert.equal(c.authorization, null); assert.equal(c.executor_release_sha256, null);
  assert.throws(() => validateProductionWigglesConfigurationV1(c, 1900000010));
  assert.equal(launch.release_status, 'MECHANICALLY_DISABLED_NO_ENABLE_FLAG');
  assert.equal(launch.restart, 'NEVER_AUTOMATIC');
  assert.equal(launch.environment.NODE_OPTIONS, '');
});
