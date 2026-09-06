import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildBoundedAgentMandateV1,
  REVIEWED_BOUNDED_REBROADCAST_SOURCE_SHA256_V1,
  REVIEWED_TRANSACTION_ERROR_SOURCE_SHA256_V1,
  assertLiveReadyBoundedAgentMandateV1,
  validateBoundedAgentMandateV1,
} from './mandate-v1.mjs';
import { POLICY as REVIEWED_REBROADCAST_POLICY_V1 } from './reused/bounded-rebroadcast-v1.mjs';

const D = character => character.repeat(64);

export function mandateInput(overrides = {}) {
  const input = {
    network: {
      chain: 'solana',
      network: 'mainnet-beta',
      genesis_hash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    },
    setup_authority: {
      setup_freeze_schema: 'ARTIFACT_FINAL_PROOF_SETUP_FREEZE_V2',
      setup_archive_sha256: D('1'),
      setup_freeze_sha256: D('2'),
      setup_evidence_manifest_sha256: D('3'),
      latest_setup_block_time: 1788611228,
    },
    wallet_scope: {
      wallet: '5CJdSbz9d5CifzFcWL5NcbicgpSAEuDGpSZBgaLHN1tA',
      jup_ata: '4HgYhw4FSPPGwhAs65vWFxHLyGbTNUVfZcTtKVteP6E2',
      usdc_ata: 'Db7uFgxUjDFpngThm18ho6DxK9gsFcA6AZKX8ryPPBe7',
      token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      token_2022_population: 'REQUIRED_EMPTY',
      ata_lifecycle: 'FORBIDDEN',
      other_wallet_action: 'FORBIDDEN',
    },
    asset_scope: {
      jup_mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      usdc_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      exact_mint_count: 2,
      third_mint: 'FORBIDDEN',
    },
    route_scope: {
      route_profile: 'DIRECT_CLASSIC_ORCA_WHIRLPOOL_ONLY',
      whirlpool_program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      pool: '4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP',
      jup_vault: '9gMRWNfLXNc54ta5LxuM16p72GYap2t6rf455TTBKQW4',
      usdc_vault: 'CYcxSC2vmbScHFcTtEM6346uqMN8b9zeSGnP9qZu1E6U',
      oracle: 'CrkkeqLUo7n6gvzoYMPZ7CHjie1Zua2CHUPe2DFh8mmR',
      jupiter: 'FORBIDDEN',
    },
    opening_contract: {
      jup_raw: '0',
      usdc_raw: '6000000',
      sol_lamports: '820624',
      acquisition_fee_lamports: '5000',
      disposal_fee_lamports: '5000',
      system_rent_floor_lamports: '810624',
      post_acquisition_usdc_raw: '1000000',
      post_disposal_jup_raw: '0',
    },
    age_gate: {
      latest_setup_block_time: 1788611228,
      lookback_seconds: 604800,
      strict_margin_seconds: 1,
      earliest_opening_candidate_unix_seconds: 1789216029,
      authority: 'FINALIZED_CHAIN_BOUNDARY_ONLY',
    },
    economic_authority: {
      acquisition_input_usdc_raw: '5000000',
      maximum_slippage_bps: 50,
      maximum_semantic_swaps: 2,
      required_order: ['ACQUISITION', 'DISPOSAL'],
      disposal_quantity_rule: 'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE',
      market_timing_rule: 'NONE',
    },
    agent_authority: {
      allowed_actions: [
        'INITIATE_ACQUISITION',
        'REFUSE_ACQUISITION',
        'INITIATE_FULL_DISPOSAL',
        'REFUSE_DISPOSAL',
      ],
      decision_ordinals: [1, 2],
      maximum_decisions: 2,
      policy: 'CHALLENGE_BOUND_INITIATION_OR_REFUSAL_ONLY',
      delegation: 'FORBIDDEN',
    },
    transaction_profile: {
      version: 'LEGACY',
      required_signatures: 1,
      top_level_swap_instructions_per_leg: 1,
      classic_token_transfer_cpis_per_leg: 2,
      address_lookup_tables: 'FORBIDDEN',
      compute_budget: 'FORBIDDEN',
      associated_token_instructions: 'FORBIDDEN',
      memo: 'FORBIDDEN',
      cleanup: 'FORBIDDEN',
    },
    rebroadcast_policy: {
      profile: 'IDENTICAL_SIGNED_BYTES_BOUNDED_REBROADCAST_V1',
      maximum_signings_per_leg: 1,
      maximum_client_sends_per_leg: 3,
      maximum_rebroadcasts_per_leg: 2,
      provider_retries: 0,
      rebuild_requote_refresh_resign_replacement: 'FORBIDDEN',
    },
    evidence_policy: {
      raw_response_before_parse: true,
      exact_member_inventory: true,
      canonical_json_lf_trailing_newline: true,
      agent_provenance_is_economic_authority: false,
      economic_authority: 'FINALIZED_ONCHAIN_EVIDENCE_THROUGH_EXISTING_V1_3_PIPELINE_ONLY',
    },
    offline_identity: {
      profile: 'FIXED_TEST_IDENTITIES_ONLY',
      human_authorization_public_key: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
      agent_control_public_key: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
      executor_release_sha256: D('4'),
      rpc_budget_table_sha256: D('5'),
      acquisition_not_after_unix_seconds: 2000000000,
    },
    unresolved_live_readiness: {
      human_authorization_public_key: null,
      agent_control_public_key: null,
      acquisition_not_after_unix_seconds: null,
      rpc_budget_table_sha256: null,
      executor_release_sha256: null,
      status: 'UNRESOLVED',
    },
  };
  return { ...input, ...overrides };
}

test('builds one closed canonical mandate with the exact narrow agent authority', () => {
  const mandate = buildBoundedAgentMandateV1(mandateInput());
  assert.equal(validateBoundedAgentMandateV1(mandate), true);
  assert.match(mandate.mandate_digest, /^[0-9a-f]{64}$/);
  assert.equal(mandate.mandate_id, `bounded-agent-mandate-${mandate.mandate_digest}`);
  assert.deepEqual(mandate.agent_authority.allowed_actions, [
    'INITIATE_ACQUISITION', 'REFUSE_ACQUISITION',
    'INITIATE_FULL_DISPOSAL', 'REFUSE_DISPOSAL',
  ]);
  assert.equal(mandate.economic_authority.disposal_quantity_rule,
    'FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE');
  assert.equal(Object.isFrozen(mandate), true);
  assert.throws(() => assertLiveReadyBoundedAgentMandateV1(mandate),
    error => error.code === 'bounded_agent_live_readiness_unresolved');
});

test('rejects mandate drift, unknown fields, and arithmetic contradictions', () => {
  const valid = buildBoundedAgentMandateV1(mandateInput());
  assert.throws(() => validateBoundedAgentMandateV1({ ...valid, extra: true }),
    error => error.code === 'unknown_field');
  assert.throws(() => buildBoundedAgentMandateV1(mandateInput({
    economic_authority: { ...mandateInput().economic_authority, maximum_slippage_bps: 51 },
  })), error => error.code === 'bounded_agent_mandate_semantics_invalid');
  assert.throws(() => buildBoundedAgentMandateV1(mandateInput({
    opening_contract: { ...mandateInput().opening_contract, sol_lamports: '820625' },
  })), error => error.code === 'bounded_agent_mandate_opening_invalid');
});

test('rejects proxies, accessors, and custom prototypes before executing hostile input', () => {
  let getterCalls = 0;
  const accessor = mandateInput();
  Object.defineProperty(accessor, 'network', { enumerable: true, get() { getterCalls += 1; return {}; } });
  assert.throws(() => buildBoundedAgentMandateV1(accessor), error => error.code === 'accessor_not_allowed');
  assert.equal(getterCalls, 0);
  assert.throws(() => buildBoundedAgentMandateV1(new Proxy(mandateInput(), {})),
    error => error.code === 'proxy_not_allowed');
  assert.throws(() => buildBoundedAgentMandateV1(Object.assign(Object.create(null), mandateInput())),
    error => error.code === 'custom_prototype_not_allowed');
});

test('pins the byte-identical reviewed rebroadcast scheduler and transaction-error validator', async () => {
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(await readFile(new URL('./reused/bounded-rebroadcast-v1.mjs', import.meta.url))),
    REVIEWED_BOUNDED_REBROADCAST_SOURCE_SHA256_V1);
  assert.equal(digest(await readFile(new URL('./reused/transaction-error-v1.cjs', import.meta.url))),
    REVIEWED_TRANSACTION_ERROR_SOURCE_SHA256_V1);
  assert.deepEqual(REVIEWED_REBROADCAST_POLICY_V1, {
    id: 'IDENTICAL_SIGNED_BYTES_BOUNDED_REBROADCAST_V1',
    maxClientSendAttempts: 3,
    providerMaxRetries: 0,
    ordinalWindowsMs: [[2000, 3000], [5000, 6000]],
    schedulerDeadlineMs: 6000,
    sendTimeoutMs: 2000,
    resolutionDeadlineMs: 180000,
    resolutionPollMs: 2000,
    maxResolutionPolls: 90,
    maxResolutionCalls: 181,
  });
});
