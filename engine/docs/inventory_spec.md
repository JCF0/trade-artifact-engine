# Inventory Spec

## Scope

This document defines the v1.3 Slice 1 local receipt inventory view.

Default inventory input is limited to canonical/debug v1.2 artifacts already present under `engine/data/debug/`.
It does not call the network, sign, upload, mint, or mutate receipt artifacts.

Legacy v1.1 JSONL receipt discovery is optional and separate.
It is available only through explicit opt-in (`--include-legacy` in the CLI entrypoint, or explicit legacy inventory route usage).

Inventory is part of the broader v1.3 local read-only proof surfaces release and should be treated as a local artifact index around committed v1.2 proof outputs.

## Primary Key

- v1.2 inventory primary key: `receipt_hash`
- legacy compatibility key: `verification_hash`

`verification_hash` is never used as the primary key for v1.2 inventory records.

## Default Sources

The scanner reads these v1.2 artifacts when present:

- `data/debug/ledger-receipts-v12.json`
- `data/debug/ledger-verify-v12.json`
- `data/debug/ledger-valuations-v12.json`
- `data/debug/ledger-image-artifacts-v12.json`
- `data/debug/ledger-metadata-v12.json`
- `data/debug/ledger-upload-dry-run-v12.json`
- `data/debug/ledger-upload-results-v12.json`
- `data/debug/ledger-mint-plan-v12.json`
- `data/debug/ledger-mint-results-v12.json`
- `data/debug/v12-proof-pipeline-summary.json`

These artifacts are joined by `receipt_hash`.
Artifacts that only expose `receipt_id` are resolved through the canonical receipt list first, then linked back to `receipt_hash`.

## Status Separation

Inventory records preserve independent status fields instead of collapsing them:

- `verification_status` comes from the canonical v1.2 receipt.
- `hash_valid`, `recomputed_hash`, `verifier_passed`, `verifier_schema_valid`, and `verifier_consistency_valid` come from verifier/debug artifacts.
- `valuation_status` remains the raw v1.2 value, typically `raw_quote`.
- `image_status`, `upload_status`, `mint_ready`, and `mint_status` remain separate proof lifecycle fields.

## Optional Canonical Economics

Archive-enabled inventory may add `canonical_economics` to a receipt when, and only when, a matching
`receipt_economics_v1` sidecar passes the validated receipt-economics store read API. The join key is the
exact `receipt_hash`; `receipt_id`, token mint, wallet, and transaction hashes are never fallback join keys.

The validated store read reconstructs the canonical receipt from the unchanged `receipt_archive_v1`
record and sidecar, runs the existing receipt verifier, requires the recomputed hash to equal the joined
`receipt_hash`, checks stored verification/projection evidence, and checks archive overlap fields. Inventory
does not read or project sidecar JSON directly.

The additive namespace is:

```json
{
  "canonical_economics": {
    "status": "verified",
    "source": "receipt_economics_v1",
    "recovery_method": "hash_matched_regeneration",
    "fields": {
      "segment_index": 0,
      "entry_tx_hashes": [],
      "exit_tx_hashes": [],
      "total_bought_qty": 0,
      "total_bought_quote": 0,
      "avg_buy_quote_price": 0,
      "total_sold_qty": 0,
      "total_sold_quote": 0,
      "avg_sell_quote_price": 0,
      "allocated_cost_basis_quote": 0,
      "remaining_qty": 0,
      "remaining_cost_basis_quote": 0,
      "realized_pnl_quote": 0,
      "realized_pnl_pct": 0,
      "accounting_method": "weighted_average_position_accounting_v1",
      "hold_time_seconds": 0,
      "num_buys": 0,
      "num_sells": 0
    }
  }
}
```

The numbers above illustrate types only; inventory never substitutes zero, `null`, `N/A`, or another
placeholder for missing economics. A receipt with no sidecar omits `canonical_economics` entirely and
retains its prior record shape. A corrupt, orphaned, hash-conflicting, overlap-conflicting, or otherwise
invalid sidecar also exposes no economics. Archive diagnostics receive one deterministic, path-free record:

```json
{
  "code": "canonical_economics_excluded",
  "receipt_hash": "<64 lowercase hex characters>",
  "source": "receipt_economics_v1",
  "reason": "<receipt-economics store error code>"
}
```

Diagnostics never contain raw history, machine paths, recovery evidence paths, or provider data. Default
current-snapshot inventory (`includeArchive: false`) does not scan economics and remains unchanged.

Existing proof and receipt-board eligibility intentionally continue without canonical economics. A failed
or absent sidecar therefore does not change proof resolution, board inclusion, or ranking. Slice 1 Share
Card eligibility will be stricter and require
`inventoryReceipt.canonical_economics?.status === "verified"`.

### Slice 1 Share Card view-model interface

The exact planned boundary is a pure view-model function; Slice 0H does not implement rendering:

```js
buildShareCardViewModel(inventoryReceipt, {
  walletDisplayMode = 'truncated',
} = {})
```

Precondition: `inventoryReceipt.canonical_economics.status === "verified"`; otherwise the function fails
closed with `ShareCardEligibilityError` code `canonical_economics_not_verified`.

Return contract:

```js
{
  share_card_version: 'share_card_v1',
  receipt: {
    receipt_hash,
    receipt_id,
    receipt_type,
    token_mint,
    quote_mint,
    quote_symbol,
    verification_status,
    display_status,
    first_event_at,
    last_event_at,
    wallet_display
  },
  canonical_economics: inventoryReceipt.canonical_economics,
  disclosures: [...],
  links: {
    proof_api_path,
    verifier_api_path
  }
}
```

The view model must consume only the validated inventory namespace, must not reopen a sidecar, and must not
add raw transactions, wallet-profile/portfolio data, machine paths, provider data, normalized/USD economics,
or recovery evidence.

## Legacy Discovery Rules

Legacy JSONL compatibility scans `data/**/receipts.jsonl` only when explicitly enabled.

Default production inventory excludes legacy files located inside:

- `_test`
- `_e2e_test`
- backup directories

Those paths may be included only when explicitly requested.

Legacy inventory is not shown by default in the v1.3 UI or default proof routes.

## Read-only API

Slice 1 adds read-only inventory routes:

- `GET /inventory`
- `GET /inventory/:receiptHash`
- `GET /inventory/legacy`
- `GET /inventory/legacy/:verificationHash`
- `GET /api/inventory`
- `GET /api/inventory/summary`

These routes read local artifacts only and do not mutate pipeline state.

## Release Boundaries

Inventory is local-only and read-only.
It does not add hosting, upload, minting, signing, account login, wallet linking, price fetching, or USD normalization.
