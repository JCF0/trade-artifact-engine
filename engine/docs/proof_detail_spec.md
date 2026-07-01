# Proof Detail Spec

## Scope

Slice 2A adds a local, read-only proof detail API for one v1.2 receipt selected by `receipt_hash`.

This slice uses the committed v1.3 Slice 1 inventory module as its only data source.
It does not read legacy receipts by default, does not perform uploads or minting, and does not add any network calls.

## Route

- `GET /api/proof/:receiptHash`

Behavior:

- Returns `200` with proof detail for a known v1.2 `receipt_hash`
- Returns `404` for an unknown `receipt_hash`
- Does not perform legacy `verification_hash` lookup by default
- Ignores any legacy compatibility flags on this route

## Data Source

The route resolves a single inventory record through the committed inventory module.
No additional joins, file scanning, verifier execution, upload execution, or mint execution occur in Slice 2A.

## View Model Shape

The proof detail view model groups fields already present on the inventory record into these top-level sections:

- `receipt`
- `verification`
- `valuation`
- `proof_lifecycle`
- `artifacts`
- `legacy`
- `links`
- `flags_and_limitations`

## Mapping Rules

- `receipt_hash` remains the v1.2 primary identifier
- legacy `verification_hash` remains separate and is not used for default lookup
- `verification_status` remains separate from `hash_valid`, `verifier_passed`, and proof lifecycle fields
- `valuation_status` is preserved exactly as present on the inventory record, including `raw_quote`
- Optional artifact fields are returned as `null` when absent
- Optional list fields are returned as empty arrays when absent
- The legacy section does not expose raw legacy record blobs

## Raw Quote Disclosure

The API includes explicit disclosure text:

- `Raw quote only. No USD normalization.`

This is explanatory display text for the existing v1.2 valuation semantics.
It does not add new valuation logic or any USD normalization.

## Non-Goals

Slice 2A does not add:

- UI or browser pages
- hosting
- account login
- wallet linking
- price fetching
- USD normalization
- upload
- minting
- signing
- network actions
