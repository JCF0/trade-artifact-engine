// Importing this test helper performs no I/O, key generation, provisioning, or runtime launch.
// Every private key below is created in memory for an explicitly invoked synthetic test.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '../recovered-setup-v2.mjs';
import { supervisedRuntimeFixtureV1 } from './supervised-runtime-offline-v1.mjs';
import { fixedTestMandateInputV1 } from './fixed-test-identities-v1.mjs';
import { buildOfflineRecoveredSetupMandateV2 } from '../executor-mandate-profile-v1.mjs';
import { syntheticRuntimeCaptureV1 } from './trusted-runtime-offline-v1.mjs';
import { buildHumanEpisodeAuthorizationV1, humanAuthorizationSigningBytesV1 } from '../human-authorization-v1.mjs';
import { canonicalJson, sha256CanonicalJson } from '../../contract.mjs';

export function syntheticRecoveredHumanPrivateKeyV2() {
  return privateKey(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
}
function privateKey(seed) {
  return createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), seed,
  ]) });
}
const publicHex = key => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

export function recoveredSetupEvidenceFixtureV2({ human_private_key = syntheticRecoveredHumanPrivateKeyV2(),
  enrollment_not_after = 1900001000 } = {}) {
  const custodian = privateKey(createHash('sha256').update('DISPOSABLE-NOT-APPROVED-V2-PRODUCER-CUSTODIAN').digest());
  const enrollmentPayload = { version: 'artifact_production_recovered_setup_enrollment_v1',
    human_public_key: publicHex(human_private_key), custodian_public_key: publicHex(custodian),
    not_before_unix_seconds: 1899999900, not_after_unix_seconds: enrollment_not_after,
    enrollment_nonce: 'synthetic-producer-v2-enrollment',
    recovered_provenance_sha256: core.RECOVERED_SETUP_AUTHORITY_V2.recovered_provenance_sha256 };
  const enrollment = { payload: enrollmentPayload,
    signature: sign(null, core.recoveredSetupEnrollmentSigningBytesV2(enrollmentPayload), human_private_key).toString('hex') };
  const payload = { schema: 'ARTIFACT_PRODUCTION_RECOVERED_SETUP_CUSTODIAN_V1',
    custodian_public_key: publicHex(custodian), issued_at_unix_seconds: 1900000000,
    attestation_nonce: 'synthetic-producer-v2-custodian',
    recovered_provenance_sha256: core.RECOVERED_SETUP_AUTHORITY_V2.recovered_provenance_sha256,
    transfer_archive_sha256: core.RECOVERED_SETUP_AUTHORITY_V2.transfer_archive_sha256,
    source_host: 'Wiggles', source_account: 'ricemachine',
    source_public_directory: '/home/ricemachine/.artifact-calibration-local/v1/public/final-proof-wallet/',
    original_execution_archive_status: 'UNKNOWN', historical_byte_continuity: 'NOT_ATTESTED',
    custody_statement: 'I_ATTEST_THE_EXACT_PINNED_RECOVERED_RECORDS_AND_SOURCE_LOCATION_AS_THE_PUBLIC_RECORDS_I_SUPPLY_FOR_THIS_SETUP_NOT_AN_ORIGINAL_EXECUTION_ARCHIVE',
    scope_statement: 'RECOVERED_SETUP_PROVENANCE_ONLY_NOT_TRADING_AUTHORIZATION_OR_CURRENT_ELIGIBILITY' };
  const attestation = { payload, signature: sign(null, core.recoveredSetupCustodianSigningBytesV2(payload), custodian).toString('hex') };
  const publicEvidence = JSON.parse(readFileSync(new URL('./recovered-setup-v2.json', import.meta.url)));
  return { ...publicEvidence, version: 'artifact_production_recovered_setup_evidence_v2', enrollment,
    attestation_base64: Buffer.from(canonicalJson(attestation)).toString('base64') };
}
function setupAuthority(evidence) {
  return { ...core.RECOVERED_SETUP_AUTHORITY_V2,
    custodian_attestation_sha256: createHash('sha256').update(Buffer.from(evidence.attestation_base64, 'base64')).digest('hex') };
}
export function recoveredRuntimeFixtureV2(options = {}) {
  const { enrollment_not_after, ...runtimeOptions } = options;
  const evidence = recoveredSetupEvidenceFixtureV2({ enrollment_not_after });
  const f = supervisedRuntimeFixtureV1({ ...runtimeOptions, setup_provenance: evidence,
    mandate_factory: input => buildOfflineRecoveredSetupMandateV2({ ...input, setup_authority: setupAuthority(evidence) }) });
  // This synthetic episode must end within its signed custody interval.
  f.configuration.deadline_unix_seconds = evidence.enrollment.payload.not_after_unix_seconds;
  const cleanup = f.cleanup;
  f.cleanup = () => {
    f.close();
    const parent = process.env.ARTIFACT_SUPERVISED_EVIDENCE_ROOT;
    if (parent) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      cpSync(f.root, join(parent, `v2-original-${f.root.split('/').at(-1)}`), { recursive: true, errorOnExist: true, force: false });
    }
    cleanup();
  };
  return f;
}

// Pure configuration validator input, never passed to a live runtime factory.
// Paths are deliberately nonexistent. Public recovery bytes are the only read.
export function recoveredProductionConfigurationFixtureV2() {
  const human = generateKeyPairSync('ed25519').privateKey, agent = generateKeyPairSync('ed25519').privateKey;
  const evidence = recoveredSetupEvidenceFixtureV2({ human_private_key: human });
  const input = fixedTestMandateInputV1(); input.setup_authority = setupAuthority(evidence);
  const budget = syntheticRuntimeCaptureV1(core.buildRecoveredSetupMandateV2(input)).budget;
  input.unresolved_live_readiness = { human_authorization_public_key: publicHex(human), agent_control_public_key: publicHex(agent),
    executor_release_sha256: sha256CanonicalJson({ synthetic_not_approved: 'v2-producer-structural-release' }),
    rpc_budget_table_sha256: sha256CanonicalJson(budget), acquisition_not_after_unix_seconds: 2000000000, status: 'RESOLVED' };
  const mandate = core.buildRecoveredSetupMandateV2(input), live = mandate.unresolved_live_readiness;
  const unsigned = { mandate_digest: mandate.mandate_digest, human_public_key: publicHex(human), agent_public_key: publicHex(agent),
    executor_release_sha256: live.executor_release_sha256, authorization_nonce: 'synthetic-v2-producer-configuration-only',
    issued_at_unix_seconds: 1900000000, not_before_unix_seconds: mandate.age_gate.earliest_opening_candidate_unix_seconds,
    acquisition_not_after_unix_seconds: live.acquisition_not_after_unix_seconds,
    authorization_statement: 'AUTHORIZE_ONE_BOUNDED_AGENT_DIRECTED_TWO_SWAP_FINAL_PROOF_EPISODE', revocation_status: 'NOT_REVOKED' };
  const authorization = buildHumanEpisodeAuthorizationV1({ ...unsigned,
    signature: sign(null, humanAuthorizationSigningBytesV1(unsigned), human).toString('hex') });
  return { mandate, authorization, executor_release_sha256: live.executor_release_sha256, budget,
    expected_wallet: mandate.wallet_scope.wallet, wallet_key_path: '/NONEXISTENT/v2-synthetic-wallet.json',
    state_root: '/NONEXISTENT/v2-synthetic-authority',
    deadline_unix_seconds: evidence.enrollment.payload.not_after_unix_seconds, setup_provenance: evidence };
}
