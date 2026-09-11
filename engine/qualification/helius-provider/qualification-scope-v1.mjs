// Fixed qualification-only constraints; no mandate or authority identity.
import { cloneAndFreeze } from '/accepted/engine/src/verification-scope-v1-3/contract.mjs';
export const QUALIFICATION_SCOPE_V1 = cloneAndFreeze({
  "network": {
    "chain": "solana",
    "genesis_hash": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    "network": "mainnet-beta"
  },
  "wallet_scope": {
    "ata_lifecycle": "FORBIDDEN",
    "jup_ata": "4HgYhw4FSPPGwhAs65vWFxHLyGbTNUVfZcTtKVteP6E2",
    "other_wallet_action": "FORBIDDEN",
    "token_2022_population": "REQUIRED_EMPTY",
    "token_program": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "usdc_ata": "Db7uFgxUjDFpngThm18ho6DxK9gsFcA6AZKX8ryPPBe7",
    "wallet": "5CJdSbz9d5CifzFcWL5NcbicgpSAEuDGpSZBgaLHN1tA"
  },
  "asset_scope": {
    "exact_mint_count": 2,
    "jup_mint": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    "third_mint": "FORBIDDEN",
    "usdc_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  },
  "route_scope": {
    "jup_vault": "9gMRWNfLXNc54ta5LxuM16p72GYap2t6rf455TTBKQW4",
    "jupiter": "FORBIDDEN",
    "oracle": "CrkkeqLUo7n6gvzoYMPZ7CHjie1Zua2CHUPe2DFh8mmR",
    "pool": "4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP",
    "route_profile": "DIRECT_CLASSIC_ORCA_WHIRLPOOL_ONLY",
    "usdc_vault": "CYcxSC2vmbScHFcTtEM6346uqMN8b9zeSGnP9qZu1E6U",
    "whirlpool_program": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
  },
  "opening_contract": {
    "acquisition_fee_lamports": "5000",
    "disposal_fee_lamports": "5000",
    "jup_raw": "0",
    "post_acquisition_usdc_raw": "1000000",
    "post_disposal_jup_raw": "0",
    "sol_lamports": "820624",
    "system_rent_floor_lamports": "810624",
    "usdc_raw": "6000000"
  },
  "economic_authority": {
    "acquisition_input_usdc_raw": "5000000",
    "disposal_quantity_rule": "FINALIZED_CHAIN_DERIVED_COMPLETE_ACQUIRED_JUP_BALANCE",
    "market_timing_rule": "NONE",
    "maximum_semantic_swaps": 2,
    "maximum_slippage_bps": 50,
    "required_order": [
      "ACQUISITION",
      "DISPOSAL"
    ]
  },
  "transaction_profile": {
    "address_lookup_tables": "FORBIDDEN",
    "associated_token_instructions": "FORBIDDEN",
    "classic_token_transfer_cpis_per_leg": 2,
    "cleanup": "FORBIDDEN",
    "compute_budget": "FORBIDDEN",
    "memo": "FORBIDDEN",
    "required_signatures": 1,
    "top_level_swap_instructions_per_leg": 1,
    "version": "LEGACY"
  },
  "rebroadcast_policy": {
    "maximum_client_sends_per_leg": 3,
    "maximum_rebroadcasts_per_leg": 2,
    "maximum_signings_per_leg": 1,
    "profile": "IDENTICAL_SIGNED_BYTES_BOUNDED_REBROADCAST_V1",
    "provider_retries": 0,
    "rebuild_requote_refresh_resign_replacement": "FORBIDDEN"
  },
  "age_gate": {
    "authority": "FINALIZED_CHAIN_BOUNDARY_ONLY",
    "earliest_opening_candidate_unix_seconds": 1789216029,
    "latest_setup_block_time": 1788611228,
    "lookback_seconds": 604800,
    "strict_margin_seconds": 1
  }
});
