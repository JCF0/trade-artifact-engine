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
