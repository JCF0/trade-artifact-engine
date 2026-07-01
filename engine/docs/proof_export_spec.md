# Proof Export Spec

## Scope

v1.3 Slice 4 adds a local, read-only static proof page/export scaffold for one selected v1.2 `receipt_hash`.

Data sources are limited to:
- Slice 1 inventory lookup (`getInventoryReceipt`)
- Slice 2A proof detail view-model (`buildProofDetailView`)

This slice does not add hosting, uploads, minting, signing, PDF generation, wallet linking, login, price fetching, USD normalization, or any live network integration.

## Renderer

File:
- `engine/src/proof-export/render-static-page.mjs`

Input:
- one proof detail view-model object

Output:
- one standalone HTML document

Renderer requirements:
- inline CSS only
- no external assets
- no client-side scripts
- selected-receipt-only framing
- explicit disclosure: `Raw quote only. No USD normalization.`
- missing optional fields render as `Not available`
- legacy remains separate and is not exposed as raw blobs

Rendered sections:
- Receipt
- Verification
- Valuation
- Proof Lifecycle
- Artifacts
- Flags & Limitations
- Links

## CLI

File:
- `engine/src/proof-export/cli.mjs`

Usage:
- `node engine/src/proof-export/cli.mjs --receipt-hash <hash> --stdout`
- `node engine/src/proof-export/cli.mjs --receipt-hash <hash> --output <path>`

Rules:
- `--receipt-hash` is required
- choose exactly one of `--stdout` or `--output`
- non-zero exit for invalid args or missing receipt
- no legacy lookup by default
- writes only when `--output` is explicitly provided

## API

Route:
- `GET /api/proof/:receiptHash/export`

Behavior:
- `200 text/html` for known v1.2 `receipt_hash`
- `404` for unknown `receipt_hash`
- no legacy lookup by default
- read-only only

## Disclosures

Static proof pages must include all of the following:
- raw quote only, no USD normalization
- selected receipt only
- local export scaffold, not hosted proof delivery
- no upload, mint, or signing occurs through this export path

## Tests

Coverage for Slice 4 includes:
- renderer section rendering
- raw quote disclosure presence
- selected-receipt-only framing presence
- missing-field fallback rendering
- no raw legacy blob exposure
- no external asset references
- CLI stdout success
- CLI explicit output write success
- CLI unknown-hash non-zero failure
- API `200` and `404` behavior
