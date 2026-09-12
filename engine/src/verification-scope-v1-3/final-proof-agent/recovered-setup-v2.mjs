import { createHash } from 'node:crypto';
import { canonicalJson } from '../contract.mjs';
import { domainSeparatedCanonicalBytesV1, verifyEd25519DomainSignatureV1 } from './authentication-domain-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import {
  assertExactFields,
  cloneAndFreeze,
  fail,
  sha256CanonicalJson,
} from '../contract.mjs';
import { POLICY as REVIEWED_REBROADCAST_POLICY_V1 } from './reused/bounded-rebroadcast-v1.mjs';
import { validateExecutorMandateV1, isRecoveredSetupExecutorMandateV2 } from './executor-mandate-profile-v1.mjs';

export const RECOVERED_SETUP_VERSION_V2 = 'artifact_bounded_agent_final_proof_mandate_v2';
export const REVIEWED_BOUNDED_REBROADCAST_SOURCE_SHA256_V1 =
  '9dfed7dd40e97da0f98c1eba1d374a58f98eff2a12c25df2bdf2ad6f54c5bb16';
export const REVIEWED_TRANSACTION_ERROR_SOURCE_SHA256_V1 =
  'ba39f4d5729f03394b5f619b15880397ec9c29a0d278cf7d5cf5730a23cd9066';
export const RECOVERED_SETUP_PROFILE_V2 = 'ARTIFACT_BOUNDED_AGENT_RECOVERED_SETUP_FINAL_PROOF_MANDATE_V2';

// V1 semantic checks are retained verbatim except the versioned setup shape/pins.
// No synthesized V1 mandate or historical archive identity is used.
export const RECOVERED_SETUP_AUTHORITY_V2 = cloneAndFreeze({
  setup_provenance_schema: 'ARTIFACT_PRODUCTION_RECOVERED_SETUP_V1',
  setup_freeze_schema: 'ARTIFACT_FINAL_PROOF_SETUP_FREEZE_V2',
  original_execution_archive: { status: 'UNKNOWN', sha256: null, filename: null, location: null },
  recovered_provenance_sha256: 'ddf6f419d83227806f0b64e02cd334709ded5d56888a82437b01cf08cc9dc58d',
  transfer_archive_sha256: 'eae219e7c7da6f9760145025f2a361c5565848d2d930c8a9619cee64c31d47fa',
  setup_freeze_sha256: 'c53deaebbc6f7db5463a273f6e316faa82288298e39e809fa6481df2e78f4ced',
  setup_evidence_manifest_sha256: '6541008a222ed0aafaf6044aba557901094fdcce26b6b16f0d9e093d00dcc91a',
  latest_setup_block_time: 1788611228,
});

const DIGEST = /^[0-9a-f]{64}$/;
const RAW = /^(?:0|[1-9][0-9]*)$/;
const FIELDS = [
  'mandate_version', 'mandate_profile', 'mandate_id', 'mandate_digest',
  'network', 'setup_authority', 'wallet_scope', 'asset_scope', 'route_scope',
  'opening_contract', 'age_gate', 'economic_authority', 'agent_authority',
  'transaction_profile', 'rebroadcast_policy', 'evidence_policy',
  'offline_identity', 'unresolved_live_readiness',
];
const INPUT_FIELDS = FIELDS.filter(field => !['mandate_version', 'mandate_profile', 'mandate_id', 'mandate_digest'].includes(field));
const EXPECTED = Object.freeze({
  network: Object.freeze({
    chain: 'solana', network: 'mainnet-beta',
    genesis_hash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  }),
  wallet_scope: Object.freeze({
    wallet: '5CJdSbz9d5CifzFcWL5NcbicgpSAEuDGpSZBgaLHN1tA',
    jup_ata: '4HgYhw4FSPPGwhAs65vWFxHLyGbTNUVfZcTtKVteP6E2',
    usdc_ata: 'Db7uFgxUjDFpngThm18ho6DxK9gsFcA6AZKX8ryPPBe7',
    token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    token_2022_population: 'REQUIRED_EMPTY', ata_lifecycle: 'FORBIDDEN', other_wallet_action: 'FORBIDDEN',
  }),
  asset_scope: Object.freeze({
    jup_mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    usdc_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    exact_mint_count: 2, third_mint: 'FORBIDDEN',
  }),
  route_scope: Object.freeze({
    route_profile: 'DIRECT_CLASSIC_ORCA_WHIRLPOOL_ONLY',
    whirlpool_program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    pool: '4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP',
    jup_vault: '9gMRWNfLXNc54ta5LxuM16p72GYap2t6rf455TTBKQW4',
    usdc_vault: 'CYcxSC2vmbScHFcTtEM6346uqMN8b9zeSGnP9qZu1E6U',
    oracle: 'CrkkeqLUo7n6gvzoYMPZ7CHjie1Zua2CHUPe2DFh8mmR', jupiter: 'FORBIDDEN',
  }),
});
const SHAPES = Object.freeze({
  network: ['chain', 'network', 'genesis_hash'],
  setup_authority: [...Object.keys(RECOVERED_SETUP_AUTHORITY_V2), 'custodian_attestation_sha256'],
  wallet_scope: ['wallet', 'jup_ata', 'usdc_ata', 'token_program', 'token_2022_population', 'ata_lifecycle', 'other_wallet_action'],
  asset_scope: ['jup_mint', 'usdc_mint', 'exact_mint_count', 'third_mint'],
  route_scope: ['route_profile', 'whirlpool_program', 'pool', 'jup_vault', 'usdc_vault', 'oracle', 'jupiter'],
  opening_contract: ['jup_raw', 'usdc_raw', 'sol_lamports', 'acquisition_fee_lamports', 'disposal_fee_lamports', 'system_rent_floor_lamports', 'post_acquisition_usdc_raw', 'post_disposal_jup_raw'],
  age_gate: ['latest_setup_block_time', 'lookback_seconds', 'strict_margin_seconds', 'earliest_opening_candidate_unix_seconds', 'authority'],
  economic_authority: ['acquisition_input_usdc_raw', 'maximum_slippage_bps', 'maximum_semantic_swaps', 'required_order', 'disposal_quantity_rule', 'market_timing_rule'],
  agent_authority: ['allowed_actions', 'decision_ordinals', 'maximum_decisions', 'policy', 'delegation'],
  transaction_profile: ['version', 'required_signatures', 'top_level_swap_instructions_per_leg', 'classic_token_transfer_cpis_per_leg', 'address_lookup_tables', 'compute_budget', 'associated_token_instructions', 'memo', 'cleanup'],
  rebroadcast_policy: ['profile', 'maximum_signings_per_leg', 'maximum_client_sends_per_leg', 'maximum_rebroadcasts_per_leg', 'provider_retries', 'rebuild_requote_refresh_resign_replacement'],
  evidence_policy: ['raw_response_before_parse', 'exact_member_inventory', 'canonical_json_lf_trailing_newline', 'agent_provenance_is_economic_authority', 'economic_authority'],
  offline_identity: ['profile', 'human_authorization_public_key', 'agent_control_public_key', 'executor_release_sha256', 'rpc_budget_table_sha256', 'acquisition_not_after_unix_seconds'],
  unresolved_live_readiness: ['human_authorization_public_key', 'agent_control_public_key', 'acquisition_not_after_unix_seconds', 'rpc_budget_table_sha256', 'executor_release_sha256', 'status'],
});
const ACTIONS = [
  'INITIATE_ACQUISITION', 'REFUSE_ACQUISITION',
  'INITIATE_FULL_DISPOSAL', 'REFUSE_DISPOSAL',
];

function exact(value, expected) {
  return sha256CanonicalJson(value) === sha256CanonicalJson(expected);
}
function requireDigest(value, context) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('bounded_agent_mandate_digest_invalid', `${context} must be a digest`);
}
function requireRaw(value, context) {
  if (typeof value !== 'string' || !RAW.test(value)) fail('bounded_agent_mandate_semantics_invalid', `${context} must be raw integer text`);
}
function preimage(value) {
  return Object.fromEntries(FIELDS
    .filter(field => !['mandate_id', 'mandate_digest'].includes(field))
    .map(field => [field, value[field]]));
}

export function validateRecoveredSetupMandateV2(value) {
  assertExactFields(value, FIELDS, 'bounded_agent_mandate');
  if (value.mandate_version !== RECOVERED_SETUP_VERSION_V2
      || value.mandate_profile !== RECOVERED_SETUP_PROFILE_V2) {
    fail('bounded_agent_mandate_version_invalid', 'bounded agent mandate version is invalid');
  }
  for (const [field, shape] of Object.entries(SHAPES)) assertExactFields(value[field], shape, `bounded_agent_mandate.${field}`);
  for (const field of ['network', 'wallet_scope', 'asset_scope', 'route_scope']) {
    if (!exact(value[field], EXPECTED[field])) fail('bounded_agent_mandate_scope_invalid', `${field} is outside the final-proof scope`);
  }
  const setup = value.setup_authority;
  if (setup.setup_freeze_schema !== 'ARTIFACT_FINAL_PROOF_SETUP_FREEZE_V2'
      || setup.latest_setup_block_time !== 1788611228) {
    fail('bounded_agent_mandate_setup_invalid', 'setup authority is invalid');
  }
  for (const [field, expected] of Object.entries(RECOVERED_SETUP_AUTHORITY_V2)) {
    if (!exact(setup[field], expected)) fail('recovered_setup_pin_invalid', `setup ${field} differs from the approved recovered basis`);
  }
  requireDigest(setup.custodian_attestation_sha256, 'custodian_attestation_sha256');
  const opening = value.opening_contract;
  for (const field of SHAPES.opening_contract) requireRaw(opening[field], field);
  if (opening.jup_raw !== '0' || opening.usdc_raw !== '6000000' || opening.sol_lamports !== '820624'
      || opening.post_acquisition_usdc_raw !== '1000000' || opening.post_disposal_jup_raw !== '0'
      || BigInt(opening.sol_lamports) !== BigInt(opening.system_rent_floor_lamports)
        + BigInt(opening.acquisition_fee_lamports) + BigInt(opening.disposal_fee_lamports)) {
    fail('bounded_agent_mandate_opening_invalid', 'opening balances and fee/rent equation are invalid');
  }
  const age = value.age_gate;
  if (age.latest_setup_block_time !== setup.latest_setup_block_time || age.lookback_seconds !== 604800
      || age.strict_margin_seconds !== 1
      || age.earliest_opening_candidate_unix_seconds !== age.latest_setup_block_time + age.lookback_seconds + 1
      || age.authority !== 'FINALIZED_CHAIN_BOUNDARY_ONLY') {
    fail('bounded_agent_mandate_age_gate_invalid', 'strict age gate is invalid');
  }
  const economics = value.economic_authority;
  if (economics.acquisition_input_usdc_raw !== '5000000' || economics.maximum_slippage_bps !== 50
      || economics.maximum_semantic_swaps !== 2
      || !exact(economics.required_order, ['ACQUISITION', 'DISPOSAL'])
      || economics.disposal_quantity_rule !== 'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE'
      || economics.market_timing_rule !== 'NONE') {
    fail('bounded_agent_mandate_semantics_invalid', 'economic authority is not the exact bounded profile');
  }
  const agent = value.agent_authority;
  if (!exact(agent.allowed_actions, ACTIONS) || !exact(agent.decision_ordinals, [1, 2])
      || agent.maximum_decisions !== 2 || agent.policy !== 'CHALLENGE_BOUND_INITIATION_OR_REFUSAL_ONLY'
      || agent.delegation !== 'FORBIDDEN') {
    fail('bounded_agent_mandate_agent_authority_invalid', 'agent authority is not exact and narrow');
  }
  const tx = value.transaction_profile;
  if (tx.version !== 'LEGACY' || tx.required_signatures !== 1
      || tx.top_level_swap_instructions_per_leg !== 1 || tx.classic_token_transfer_cpis_per_leg !== 2
      || ['address_lookup_tables', 'compute_budget', 'associated_token_instructions', 'memo', 'cleanup']
        .some(field => tx[field] !== 'FORBIDDEN')) {
    fail('bounded_agent_mandate_transaction_profile_invalid', 'transaction profile is invalid');
  }
  const rebroadcast = value.rebroadcast_policy;
  if (rebroadcast.profile !== REVIEWED_REBROADCAST_POLICY_V1.id
      || rebroadcast.maximum_signings_per_leg !== 1
      || rebroadcast.maximum_client_sends_per_leg !== REVIEWED_REBROADCAST_POLICY_V1.maxClientSendAttempts
      || rebroadcast.maximum_rebroadcasts_per_leg !== REVIEWED_REBROADCAST_POLICY_V1.maxClientSendAttempts - 1
      || rebroadcast.provider_retries !== REVIEWED_REBROADCAST_POLICY_V1.providerMaxRetries
      || rebroadcast.rebuild_requote_refresh_resign_replacement !== 'FORBIDDEN') {
    fail('bounded_agent_mandate_rebroadcast_invalid', 'rebroadcast policy is invalid');
  }
  const evidence = value.evidence_policy;
  if (evidence.raw_response_before_parse !== true || evidence.exact_member_inventory !== true
      || evidence.canonical_json_lf_trailing_newline !== true
      || evidence.agent_provenance_is_economic_authority !== false
      || evidence.economic_authority !== 'FINALIZED_ONCHAIN_EVIDENCE_THROUGH_EXISTING_V1_3_PIPELINE_ONLY') {
    fail('bounded_agent_mandate_evidence_policy_invalid', 'evidence authority boundary is invalid');
  }
  if (value.offline_identity.profile !== 'FIXED_TEST_IDENTITIES_ONLY') {
    fail('bounded_agent_mandate_offline_identity_invalid', 'offline identity profile is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(value.offline_identity.human_authorization_public_key)
      || !/^[0-9a-f]{64}$/.test(value.offline_identity.agent_control_public_key)
      || value.offline_identity.human_authorization_public_key === value.offline_identity.agent_control_public_key) {
    fail('bounded_agent_mandate_offline_identity_invalid', 'offline human and agent identities must be distinct Ed25519 public keys');
  }
  requireDigest(value.offline_identity.executor_release_sha256, 'offline executor release');
  requireDigest(value.offline_identity.rpc_budget_table_sha256, 'offline rpc budget');
  if (!Number.isSafeInteger(value.offline_identity.acquisition_not_after_unix_seconds)
      || value.offline_identity.acquisition_not_after_unix_seconds <= age.earliest_opening_candidate_unix_seconds) {
    fail('bounded_agent_mandate_offline_identity_invalid', 'offline not-after fixture is invalid');
  }
  const live = value.unresolved_live_readiness;
  for (const field of ['human_authorization_public_key', 'agent_control_public_key']) {
    if (live[field] !== null && (typeof live[field] !== 'string' || !/^[0-9a-f]{64}$/.test(live[field]))) {
      fail('bounded_agent_live_readiness_invalid', `${field} is invalid`);
    }
  }
  if (live.human_authorization_public_key !== null
      && live.human_authorization_public_key === live.agent_control_public_key) {
    fail('bounded_agent_live_readiness_invalid', 'live human and agent identities must be distinct');
  }
  for (const field of ['rpc_budget_table_sha256', 'executor_release_sha256']) {
    if (live[field] !== null) requireDigest(live[field], field);
  }
  if (live.acquisition_not_after_unix_seconds !== null
      && (!Number.isSafeInteger(live.acquisition_not_after_unix_seconds)
        || live.acquisition_not_after_unix_seconds <= age.earliest_opening_candidate_unix_seconds)) {
    fail('bounded_agent_live_readiness_invalid', 'live not-after is invalid');
  }
  const resolved = Object.entries(live).filter(([field]) => field !== 'status').every(([, item]) => item !== null);
  if (live.status !== (resolved ? 'RESOLVED' : 'UNRESOLVED')) {
    fail('bounded_agent_live_readiness_invalid', 'live readiness status does not reconcile');
  }
  requireDigest(value.mandate_digest, 'mandate_digest');
  if (value.mandate_digest !== sha256CanonicalJson(preimage(value))
      || value.mandate_id !== `bounded-agent-mandate-${value.mandate_digest}`) {
    fail('bounded_agent_mandate_identity_invalid', 'mandate identity is invalid');
  }
  return true;
}

export function buildRecoveredSetupMandateV2(input) {
  assertExactFields(input, INPUT_FIELDS, 'bounded_agent_mandate_input');
  const mandate = {
    mandate_version: RECOVERED_SETUP_VERSION_V2,
    mandate_profile: RECOVERED_SETUP_PROFILE_V2,
    mandate_id: `bounded-agent-mandate-${'0'.repeat(64)}`,
    mandate_digest: '0'.repeat(64),
    ...Object.fromEntries(INPUT_FIELDS.map(field => [field, input[field]])),
  };
  mandate.mandate_digest = sha256CanonicalJson(preimage(mandate));
  mandate.mandate_id = `bounded-agent-mandate-${mandate.mandate_digest}`;
  validateRecoveredSetupMandateV2(mandate);
  return cloneAndFreeze(mandate);
}

export function assertLiveReadyRecoveredSetupMandateV2(value) {
  validateRecoveredSetupMandateV2(value);
  if (value.unresolved_live_readiness.status !== 'RESOLVED') {
    fail('bounded_agent_live_readiness_unresolved', 'real authorization identities, not-after, RPC budget, and executor release are not frozen');
  }
  return true;
}

export const RECOVERED_SETUP_EVIDENCE_VERSION_V2 = 'artifact_production_recovered_setup_evidence_v2';
export const RECOVERED_SETUP_ENROLLMENT_VERSION_V2 = 'artifact_production_recovered_setup_enrollment_v1';
export const RECOVERED_SETUP_ENROLLMENT_DOMAIN_V2 = 'ARTIFACT_PRODUCTION_RECOVERED_SETUP_ENROLLMENT_ED25519_V1';
export const RECOVERED_SETUP_CUSTODIAN_DOMAIN_V2 = 'ARTIFACT_PRODUCTION_RECOVERED_SETUP_CUSTODIAN_ED25519_V1';
export const RECOVERED_SETUP_REQUIRED_RECORD_PATHS_V2 = Object.freeze([
  'setup-freeze.json', 'ata-creation-finalized.json', 'funding-finalized.json',
  'setup-freeze-20260905T122815146Z/evidence-manifest.json',
  'ata-creation-20260905T122418886Z/evidence-manifest.json',
  'funding-20260905T122706742Z/evidence-manifest.json',
  'ata-creation-20260905T122418886Z/effects.json',
  'funding-20260905T122706742Z/effects.json',
]);
const ENROLLMENT_FIELDS = ['version', 'human_public_key', 'custodian_public_key',
  'not_before_unix_seconds', 'not_after_unix_seconds', 'enrollment_nonce', 'recovered_provenance_sha256'];
const CUSTODIAN_FIXED = Object.freeze({
  schema: 'ARTIFACT_PRODUCTION_RECOVERED_SETUP_CUSTODIAN_V1',
  recovered_provenance_sha256: RECOVERED_SETUP_AUTHORITY_V2.recovered_provenance_sha256,
  transfer_archive_sha256: RECOVERED_SETUP_AUTHORITY_V2.transfer_archive_sha256,
  source_host: 'Wiggles', source_account: 'ricemachine',
  source_public_directory: '/home/ricemachine/.artifact-calibration-local/v1/public/final-proof-wallet/',
  original_execution_archive_status: 'UNKNOWN', historical_byte_continuity: 'NOT_ATTESTED',
  custody_statement: 'I_ATTEST_THE_EXACT_PINNED_RECOVERED_RECORDS_AND_SOURCE_LOCATION_AS_THE_PUBLIC_RECORDS_I_SUPPLY_FOR_THIS_SETUP_NOT_AN_ORIGINAL_EXECUTION_ARCHIVE',
  scope_statement: 'RECOVERED_SETUP_PROVENANCE_ONLY_NOT_TRADING_AUTHORIZATION_OR_CURRENT_ELIGIBILITY',
});
const CUSTODIAN_FIELDS = [...Object.keys(CUSTODIAN_FIXED), 'custodian_public_key', 'issued_at_unix_seconds', 'attestation_nonce'];
function recoveredRequire(condition, message) {
  if (!condition) fail('recovered_setup_evidence_invalid', message);
}
function time(value) { return Number.isSafeInteger(value) && value >= 0; }
function nonce(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{15,127}$/.test(value); }
function rawHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function requireCustodianKey(value) {
  requireDigest(value, 'custodian');
  // Public RFC8032 fixture identities are never production custody identities.
  recoveredRequire(![
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
  ].includes(value), 'known test identity cannot be a custodian');
}
function validateEnrollmentPayload(value) {
  assertExactFields(value, ENROLLMENT_FIELDS, 'recovered_setup_enrollment_payload');
  requireDigest(value.human_public_key, 'enrolling human');
  requireCustodianKey(value.custodian_public_key);
  recoveredRequire(value.version === RECOVERED_SETUP_ENROLLMENT_VERSION_V2
    && value.recovered_provenance_sha256 === RECOVERED_SETUP_AUTHORITY_V2.recovered_provenance_sha256
    && value.human_public_key !== value.custodian_public_key
    && time(value.not_before_unix_seconds) && time(value.not_after_unix_seconds)
    && value.not_before_unix_seconds < value.not_after_unix_seconds && nonce(value.enrollment_nonce), 'enrollment scope or interval invalid');
}
function validateCustodianPayload(value) {
  assertExactFields(value, CUSTODIAN_FIELDS, 'recovered_setup_custodian_payload');
  for (const [field, expected] of Object.entries(CUSTODIAN_FIXED)) recoveredRequire(value[field] === expected, `custodian ${field} mismatch`);
  requireCustodianKey(value.custodian_public_key);
  recoveredRequire(time(value.issued_at_unix_seconds) && nonce(value.attestation_nonce), 'custodian time or nonce invalid');
}
export function recoveredSetupEnrollmentSigningBytesV2(payload) {
  validateEnrollmentPayload(payload);
  return domainSeparatedCanonicalBytesV1(RECOVERED_SETUP_ENROLLMENT_DOMAIN_V2, payload);
}
export function recoveredSetupCustodianSigningBytesV2(payload) {
  validateCustodianPayload(payload);
  return domainSeparatedCanonicalBytesV1(RECOVERED_SETUP_CUSTODIAN_DOMAIN_V2, payload);
}
function decodeBase64(text) {
  recoveredRequire(typeof text === 'string' && text.length > 0 && text.length <= 400000
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text), 'bounded canonical base64 required');
  const bytes = Buffer.from(text, 'base64');
  recoveredRequire(bytes.toString('base64') === text, 'base64 is not canonical');
  return bytes;
}
function parseRaw(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
  catch { fail('recovered_setup_evidence_invalid', 'retained JSON is invalid'); }
}

/**
 * Evidence is closed {version,enrollment,provenance_base64,attestation_base64,records}.
 * enrollment is closed {payload,signature}, human-signed in the enrollment domain.
 * records is the fixed eight-path subset, each closed {path,base64}; array order is
 * not authority. The exact original provenance retains ALL 652 member identities
 * and its historical blocked-admission statements. Only these eight bytes are
 * rehashed here: full-bundle custody remains a separate archival obligation.
 * Admission requires explicit actual `now`; replay intentionally never reads a
 * wall clock and authenticates the retained authorization issue/attestation times.
 */
export function validateRecoveredSetupEvidenceV2({mandate, authorization, evidence, now, mode} = {}) {
  validateRecoveredSetupMandateV2(mandate);
  return validateEvidenceBindings({mandate, authorization, evidence, now, mode});
}
// Executor-only dispatcher supports the disjoint disposable V2 test domain.
// It validates the ACTUAL signed mandate and authorization, never substitutes a
// V1 mandate, V2 production mandate, or authentication preimage for the fixture.
export function validateExecutorRecoveredSetupEvidenceV2({mandate, authorization, evidence, now, mode} = {}) {
  recoveredRequire(isRecoveredSetupExecutorMandateV2(mandate), 'recovered V2 domain required');
  validateExecutorMandateV1(mandate);
  return validateEvidenceBindings({mandate, authorization, evidence, now, mode});
}
function validateEvidenceBindings({mandate, authorization, evidence, now, mode}) {
  validateHumanEpisodeAuthorizationV1(authorization);
  const authority = mandate.unresolved_live_readiness.status === 'RESOLVED'
    ? mandate.unresolved_live_readiness : mandate.offline_identity;
  recoveredRequire(authorization.mandate_digest === mandate.mandate_digest
    && authorization.human_public_key === authority.human_authorization_public_key
    && authorization.agent_public_key === authority.agent_control_public_key
    && authorization.executor_release_sha256 === authority.executor_release_sha256
    && authorization.acquisition_not_after_unix_seconds === authority.acquisition_not_after_unix_seconds
    && authorization.not_before_unix_seconds === mandate.age_gate.earliest_opening_candidate_unix_seconds,
  'authorization does not authenticate this mandate');
  assertExactFields(evidence, ['version','enrollment','provenance_base64','attestation_base64','records'], 'recovered_setup_evidence');
  recoveredRequire(evidence.version === RECOVERED_SETUP_EVIDENCE_VERSION_V2, 'evidence version invalid');
  const provenanceBytes = decodeBase64(evidence.provenance_base64);
  recoveredRequire(rawHash(provenanceBytes) === RECOVERED_SETUP_AUTHORITY_V2.recovered_provenance_sha256, 'original provenance bytes do not match pinned recovery');
  const provenance = parseRaw(provenanceBytes);
  const members = provenance.recovered_public.members;
  recoveredRequire(Array.isArray(members) && members.length === 652, 'complete provenance inventory required');
  const inventory = new Map();
  for (const member of members) {
    assertExactFields(member, ['path','bytes','sha256'], 'recovered_provenance_member');
    recoveredRequire(typeof member.path === 'string' && /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(member.path)
      && !inventory.has(member.path) && time(member.bytes), 'unsafe or duplicate recovery member');
    requireDigest(member.sha256, 'recovery member hash');
    inventory.set(member.path, member);
  }
  recoveredRequire(Array.isArray(evidence.records) && evidence.records.length === RECOVERED_SETUP_REQUIRED_RECORD_PATHS_V2.length, 'exact required retained subset missing');
  const records = new Map();
  for (const record of evidence.records) {
    assertExactFields(record, ['path','base64'], 'recovered_setup_record');
    recoveredRequire(RECOVERED_SETUP_REQUIRED_RECORD_PATHS_V2.includes(record.path) && !records.has(record.path), 'unknown or duplicate retained member');
    const bytes = decodeBase64(record.base64), member = inventory.get(record.path);
    recoveredRequire(member !== undefined && bytes.length === member.bytes && rawHash(bytes) === member.sha256, 'retained record differs from provenance inventory');
    records.set(record.path, {bytes, value:parseRaw(bytes)});
  }
  const freeze = records.get('setup-freeze.json').value;
  const original = provenance.original_setup;
  recoveredRequire(rawHash(records.get('setup-freeze.json').bytes) === mandate.setup_authority.setup_freeze_sha256
    && rawHash(records.get(`${original.freeze.evidence_directory}/evidence-manifest.json`).bytes) === mandate.setup_authority.setup_evidence_manifest_sha256
    && freeze.schema === mandate.setup_authority.setup_freeze_schema
    && freeze.latest_setup_or_funding_block_time === mandate.setup_authority.latest_setup_block_time
    && freeze.earliest_integer_proof_opening_unix === mandate.age_gate.earliest_opening_candidate_unix_seconds, 'original setup freeze boundary mismatch');
  for (const transaction of original.transactions) {
    const record = records.get(transaction.record.path).value;
    for (const field of ['signature','signed_bytes_sha256','slot','block_time','effects_digest','evidence_directory','evidence_manifest_sha256']) {
      recoveredRequire(record[field] === transaction[field] && freeze[transaction.role][field] === transaction[field], `original setup ${field} mismatch`);
    }
    recoveredRequire(rawHash(records.get(`${transaction.evidence_directory}/evidence-manifest.json`).bytes) === transaction.evidence_manifest_sha256
      // Historical setup effects use compact canonical JSON without LF, unlike
      // the new signed envelope. Preserve that original preimage exactly.
      && rawHash(Buffer.from(JSON.stringify(JSON.parse(canonicalJson(records.get(`${transaction.evidence_directory}/effects.json`).value))))) === transaction.effects_digest
      && exact(records.get(`${transaction.evidence_directory}/effects.json`).value, freeze[transaction.role].effects), 'original setup manifest or effects mismatch');
  }
  const attestationBytes = decodeBase64(evidence.attestation_base64);
  recoveredRequire(rawHash(attestationBytes) === mandate.setup_authority.custodian_attestation_sha256, 'custodian envelope does not bind mandate');
  const attestation = parseRaw(attestationBytes);
  assertExactFields(attestation, ['payload','signature'], 'recovered_setup_custodian_envelope');
  recoveredRequire(Buffer.from(canonicalJson(attestation)).equals(attestationBytes), 'custodian envelope must be canonical JSON with trailing LF');
  validateCustodianPayload(attestation.payload);
  const enrollment = evidence.enrollment;
  assertExactFields(enrollment, ['payload','signature'], 'recovered_setup_enrollment');
  validateEnrollmentPayload(enrollment.payload);
  const ep = enrollment.payload, ap = attestation.payload;
  recoveredRequire(ep.human_public_key === authorization.human_public_key
    && ep.custodian_public_key === ap.custodian_public_key
    && ep.custodian_public_key !== authorization.agent_public_key, 'custodian not independently human-enrolled');
  verifyEd25519DomainSignatureV1({domain:RECOVERED_SETUP_ENROLLMENT_DOMAIN_V2, value:ep, public_key:ep.human_public_key, signature:enrollment.signature});
  verifyEd25519DomainSignatureV1({domain:RECOVERED_SETUP_CUSTODIAN_DOMAIN_V2, value:ap, public_key:ep.custodian_public_key, signature:attestation.signature});
  recoveredRequire(mode === 'admission' || mode === 'replay', 'explicit admission or replay mode required');
  recoveredRequire(ep.not_before_unix_seconds <= ap.issued_at_unix_seconds
    && ap.issued_at_unix_seconds <= authorization.issued_at_unix_seconds
    && authorization.issued_at_unix_seconds <= ep.not_after_unix_seconds, 'enrollment, attestation and authorization times inconsistent');
  if (mode === 'admission') recoveredRequire(time(now) && now >= authorization.issued_at_unix_seconds
    && now <= ep.not_after_unix_seconds, 'admission requires actual now within authenticated enrollment interval');
  return true;
}

