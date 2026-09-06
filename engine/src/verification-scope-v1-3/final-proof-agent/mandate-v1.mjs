import {
  assertExactFields,
  cloneAndFreeze,
  fail,
  sha256CanonicalJson,
} from '../contract.mjs';
import { POLICY as REVIEWED_REBROADCAST_POLICY_V1 } from './reused/bounded-rebroadcast-v1.mjs';

export const BOUNDED_AGENT_MANDATE_VERSION_V1 = 'artifact_bounded_agent_final_proof_mandate_v1';
export const REVIEWED_BOUNDED_REBROADCAST_SOURCE_SHA256_V1 =
  '9dfed7dd40e97da0f98c1eba1d374a58f98eff2a12c25df2bdf2ad6f54c5bb16';
export const REVIEWED_TRANSACTION_ERROR_SOURCE_SHA256_V1 =
  'ba39f4d5729f03394b5f619b15880397ec9c29a0d278cf7d5cf5730a23cd9066';
export const BOUNDED_AGENT_MANDATE_PROFILE_V1 = 'ARTIFACT_BOUNDED_AGENT_FINAL_PROOF_MANDATE_V1';

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
  setup_authority: ['setup_freeze_schema', 'setup_archive_sha256', 'setup_freeze_sha256', 'setup_evidence_manifest_sha256', 'latest_setup_block_time'],
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

export function validateBoundedAgentMandateV1(value) {
  assertExactFields(value, FIELDS, 'bounded_agent_mandate');
  if (value.mandate_version !== BOUNDED_AGENT_MANDATE_VERSION_V1
      || value.mandate_profile !== BOUNDED_AGENT_MANDATE_PROFILE_V1) {
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
  for (const field of ['setup_archive_sha256', 'setup_freeze_sha256', 'setup_evidence_manifest_sha256']) requireDigest(setup[field], field);
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

export function buildBoundedAgentMandateV1(input) {
  assertExactFields(input, INPUT_FIELDS, 'bounded_agent_mandate_input');
  const mandate = {
    mandate_version: BOUNDED_AGENT_MANDATE_VERSION_V1,
    mandate_profile: BOUNDED_AGENT_MANDATE_PROFILE_V1,
    mandate_id: `bounded-agent-mandate-${'0'.repeat(64)}`,
    mandate_digest: '0'.repeat(64),
    ...Object.fromEntries(INPUT_FIELDS.map(field => [field, input[field]])),
  };
  mandate.mandate_digest = sha256CanonicalJson(preimage(mandate));
  mandate.mandate_id = `bounded-agent-mandate-${mandate.mandate_digest}`;
  validateBoundedAgentMandateV1(mandate);
  return cloneAndFreeze(mandate);
}

export function assertLiveReadyBoundedAgentMandateV1(value) {
  validateBoundedAgentMandateV1(value);
  if (value.unresolved_live_readiness.status !== 'RESOLVED') {
    fail('bounded_agent_live_readiness_unresolved', 'real authorization identities, not-after, RPC budget, and executor release are not frozen');
  }
  return true;
}
