import { createPrivateKey, sign } from 'node:crypto';

import { agentDecisionSigningBytesV1, buildAuthenticatedAgentDecisionV1 } from '../agent-decision-v1.mjs';
import { buildHumanEpisodeAuthorizationV1, humanAuthorizationSigningBytesV1 } from '../human-authorization-v1.mjs';
import { buildBoundedAgentMandateV1 } from '../mandate-v1.mjs';
import { buildReadinessChallengeV1 } from '../readiness-challenge-v1.mjs';

const HUMAN_SEED = '9d61b19deffd5a60ba844af492ec2cc4' + '4449c5697b326919703bac031cae7f60';
export const FIXED_TEST_HUMAN_PUBLIC_KEY_V1 = 'd75a980182b10ab7d54bfed3c964073a' + '0ee172f3daa62325af021a68f707511a';
const AGENT_SEED = '4ccd089b28ff96da9db6c346ec114e0f' + '5b8a319f35aba624da8cf6ed4fb8a6fb';
export const FIXED_TEST_AGENT_PUBLIC_KEY_V1 = '3d4017c3e843895a92b70aa74d1b7ebc' + '9c982ccf2ec4968cc0cd55f12af4660c';
const D = character => character.repeat(64);
function privateKey(seed) {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]),
    format: 'der', type: 'pkcs8',
  });
}
function signExact(seed, bytes) { return sign(null, bytes, privateKey(seed)).toString('hex'); }
export function fixedTestMandateInputV1() {
  return {
    network: { chain: 'solana', network: 'mainnet-beta', genesis_hash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
    setup_authority: { setup_freeze_schema: 'ARTIFACT_FINAL_PROOF_SETUP_FREEZE_V2', setup_archive_sha256: D('1'), setup_freeze_sha256: D('2'), setup_evidence_manifest_sha256: D('3'), latest_setup_block_time: 1788611228 },
    wallet_scope: { wallet: '5CJdSbz9d5CifzFcWL5NcbicgpSAEuDGpSZBgaLHN1tA', jup_ata: '4HgYhw4FSPPGwhAs65vWFxHLyGbTNUVfZcTtKVteP6E2', usdc_ata: 'Db7uFgxUjDFpngThm18ho6DxK9gsFcA6AZKX8ryPPBe7', token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', token_2022_population: 'REQUIRED_EMPTY', ata_lifecycle: 'FORBIDDEN', other_wallet_action: 'FORBIDDEN' },
    asset_scope: { jup_mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', usdc_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', exact_mint_count: 2, third_mint: 'FORBIDDEN' },
    route_scope: { route_profile: 'DIRECT_CLASSIC_ORCA_WHIRLPOOL_ONLY', whirlpool_program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', pool: '4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP', jup_vault: '9gMRWNfLXNc54ta5LxuM16p72GYap2t6rf455TTBKQW4', usdc_vault: 'CYcxSC2vmbScHFcTtEM6346uqMN8b9zeSGnP9qZu1E6U', oracle: 'CrkkeqLUo7n6gvzoYMPZ7CHjie1Zua2CHUPe2DFh8mmR', jupiter: 'FORBIDDEN' },
    opening_contract: { jup_raw: '0', usdc_raw: '6000000', sol_lamports: '820624', acquisition_fee_lamports: '5000', disposal_fee_lamports: '5000', system_rent_floor_lamports: '810624', post_acquisition_usdc_raw: '1000000', post_disposal_jup_raw: '0' },
    age_gate: { latest_setup_block_time: 1788611228, lookback_seconds: 604800, strict_margin_seconds: 1, earliest_opening_candidate_unix_seconds: 1789216029, authority: 'FINALIZED_CHAIN_BOUNDARY_ONLY' },
    economic_authority: { acquisition_input_usdc_raw: '5000000', maximum_slippage_bps: 50, maximum_semantic_swaps: 2, required_order: ['ACQUISITION', 'DISPOSAL'], disposal_quantity_rule: 'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE', market_timing_rule: 'NONE' },
    agent_authority: { allowed_actions: ['INITIATE_ACQUISITION', 'REFUSE_ACQUISITION', 'INITIATE_FULL_DISPOSAL', 'REFUSE_DISPOSAL'], decision_ordinals: [1, 2], maximum_decisions: 2, policy: 'CHALLENGE_BOUND_INITIATION_OR_REFUSAL_ONLY', delegation: 'FORBIDDEN' },
    transaction_profile: { version: 'LEGACY', required_signatures: 1, top_level_swap_instructions_per_leg: 1, classic_token_transfer_cpis_per_leg: 2, address_lookup_tables: 'FORBIDDEN', compute_budget: 'FORBIDDEN', associated_token_instructions: 'FORBIDDEN', memo: 'FORBIDDEN', cleanup: 'FORBIDDEN' },
    rebroadcast_policy: { profile: 'IDENTICAL_SIGNED_BYTES_BOUNDED_REBROADCAST_V1', maximum_signings_per_leg: 1, maximum_client_sends_per_leg: 3, maximum_rebroadcasts_per_leg: 2, provider_retries: 0, rebuild_requote_refresh_resign_replacement: 'FORBIDDEN' },
    evidence_policy: { raw_response_before_parse: true, exact_member_inventory: true, canonical_json_lf_trailing_newline: true, agent_provenance_is_economic_authority: false, economic_authority: 'FINALIZED_ONCHAIN_EVIDENCE_THROUGH_EXISTING_V1_3_PIPELINE_ONLY' },
    offline_identity: {
      profile: 'FIXED_TEST_IDENTITIES_ONLY',
      human_authorization_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
      agent_control_public_key: FIXED_TEST_AGENT_PUBLIC_KEY_V1,
      executor_release_sha256: D('4'),
      rpc_budget_table_sha256: D('5'),
      acquisition_not_after_unix_seconds: 2000000000,
    },
    unresolved_live_readiness: { human_authorization_public_key: null, agent_control_public_key: null, acquisition_not_after_unix_seconds: null, rpc_budget_table_sha256: null, executor_release_sha256: null, status: 'UNRESOLVED' },
  };
}
export function buildFixedTestMandateV1() { return buildBoundedAgentMandateV1(fixedTestMandateInputV1()); }
export function buildFixedTestAuthorizationV1(mandate, suffix = '') {
  const unsigned = {
    mandate_digest: mandate.mandate_digest,
    human_public_key: FIXED_TEST_HUMAN_PUBLIC_KEY_V1,
    agent_public_key: FIXED_TEST_AGENT_PUBLIC_KEY_V1,
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    authorization_nonce: `fixed-offline-human-authorization-nonce-v1${suffix}`,
    issued_at_unix_seconds: 1900000000,
    not_before_unix_seconds: mandate.age_gate.earliest_opening_candidate_unix_seconds,
    acquisition_not_after_unix_seconds: mandate.offline_identity.acquisition_not_after_unix_seconds,
    authorization_statement: 'AUTHORIZE_ONE_BOUNDED_AGENT_DIRECTED_TWO_SWAP_FINAL_PROOF_EPISODE',
    revocation_status: 'NOT_REVOKED',
  };
  return buildHumanEpisodeAuthorizationV1({ ...unsigned, signature: signExact(HUMAN_SEED, humanAuthorizationSigningBytesV1(unsigned)) });
}
export function buildFixedTestChallengeV1({ mandate, authorization, state, phase, nonce, amount = null, issued_at_unix_seconds }) {
  const acquisition = phase === 'ACQUISITION';
  const issued = issued_at_unix_seconds ?? (acquisition ? 1900000010 : 1900001010);
  return buildReadinessChallengeV1({
    episode_id: state.episode_id, phase, ordinal: acquisition ? 1 : 2,
    mandate_digest: mandate.mandate_digest, authorization_digest: authorization.authorization_digest,
    predecessor_state: state.state, predecessor_state_digest: state.state_digest,
    executor_release_sha256: mandate.offline_identity.executor_release_sha256,
    challenge_nonce: nonce, readiness_evidence_digest: D(acquisition ? '6' : '7'),
    issued_at_unix_seconds: issued, expires_at_unix_seconds: issued + 100,
    readiness_status: 'READY', finalized_acquisition_evidence_digest: acquisition ? null : state.acquisition_evidence_digest,
    chain_derived_disposal_jup_raw: acquisition ? null : amount,
    disposal_quantity_rule: 'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE',
  });
}
export function buildFixedTestAgentDecisionV1(mandate, authorization, challenge, action = null) {
  const unsigned = {
    episode_id: challenge.episode_id,
    action: action ?? (challenge.phase === 'ACQUISITION' ? 'INITIATE_ACQUISITION' : 'INITIATE_FULL_DISPOSAL'),
    ordinal: challenge.ordinal, mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest, challenge_digest: challenge.challenge_digest,
    predecessor_state_digest: challenge.predecessor_state_digest,
    executor_release_sha256: challenge.executor_release_sha256, challenge_nonce: challenge.challenge_nonce,
    agent_public_key: FIXED_TEST_AGENT_PUBLIC_KEY_V1, signed_at_unix_seconds: challenge.issued_at_unix_seconds + 1,
  };
  return buildAuthenticatedAgentDecisionV1({ ...unsigned, signature: signExact(AGENT_SEED, agentDecisionSigningBytesV1(unsigned)) });
}
