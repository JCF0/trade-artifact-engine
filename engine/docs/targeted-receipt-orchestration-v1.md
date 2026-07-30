# Targeted receipt-package orchestration v1

## Scope

`targeted_receipt_orchestration_v1` is the deterministic Slice 7 boundary for one explicitly targeted Artifact v1.2 closed-position receipt. It accepts already-complete normalized Solana spot events. It performs no provider acquisition, legacy cycle reconstruction, ledger comparison, wallet-wide receipt verification, open-snapshot verification, fixed-file access, compatibility-store update, rendering, network access, upload, mint, signing, or deployment.

The implementation is `engine/src/receipt-package/targeted-orchestrator.mjs`. It does not modify or deprecate `run-pipeline.mjs`.

## Public API

```js
await orchestrateTargetedReceiptPackageV1({
  normalizedEvents,
  inputStatus,
  target,
  profiles,
  mode = 'dry_run'
}, {
  packageStore,
  logger
})
```

The function is always asynchronous because commit mode uses the injected asynchronous package-store port. `packageStore` is ignored in dry-run mode and required in commit mode. `logger` is optional and, when present, must expose an `info` data-property function. Dry-run never invokes it. Commit-mode logging is best-effort after the durable result is known, so a logger failure cannot hide a successful commit or create misleading retry semantics. Log events contain only orchestration version, result status, receipt hash, and package digest.

All request objects, arrays, and normalized events must be ordinary plain data values. Accessors, symbol keys, custom prototypes, sparse arrays, unknown fields, malformed numbers, and duplicate normalized transaction/raw-index identities are rejected before reconstruction. The normalized event array is cloned before it enters the ledger.

### Input status

The minimum exact status is:

```js
{
  acquisition_complete: true,
  normalization_complete: true
}
```

Additional boolean completeness flags are accepted only when their names explicitly describe completeness or an adverse state. Any status marked incomplete, truncated, capped, partial, provider-uncertain, not exhausted, or with more pages remaining is rejected. Normalization-specific incompleteness returns `incomplete_normalization_input`; other acquisition/pagination uncertainty returns `incomplete_acquisition_input`.

### Target

```js
{
  wallet,
  token_mint,
  receipt_type: 'closed_position',
  segment_index,
  expected_receipt_hash? // lowercase 64-hex SHA-256
}
```

`wallet`, `token_mint`, `receipt_type`, and `segment_index` are the complete candidate-selection key. `expected_receipt_hash` is a regression/migration assertion, not a required identity input. When present it must exactly equal the newly promoted canonical receipt hash. It is omitted from the returned target.

The request validator recognizes the existing candidate-type vocabulary so an attempted `open_snapshot` or `realized_partial` target receives the stable eligibility error `target_not_eligible`. The initial package contract publishes only a `closed_position` whose position status is `closed` and verification status is `verified`.

### Frozen profiles

```js
{
  fetch_profile: 'receipt_scoped_transaction_selection_v1',
  normalization_profile: 'artifact_solana_spot_normalization_v1',
  reconstruction_engine_version: 'artifact_position_ledger_receipt_v1',
  accounting_method_version: 'weighted_average_position_accounting_v1'
}
```

Every field is required and exact. Free-form, unversioned, altered, or future labels are rejected until a separately reviewed contract version admits them. These values enter package identity only through `manifest.json.input_commitment`; operational request/job metadata does not.

### Normalized event schema

Every `normalizedEvents` element has exactly these fields:

```text
wallet
 timestamp
 tx_hash
 source
 token_in_mint
 token_in_amount
 token_in_decimals
 token_out_mint
 token_out_amount
 token_out_decimals
 extraction_method
 raw_index
```

`wallet` must equal the target wallet. String fields are non-empty; mints differ; amounts are finite and positive; timestamps, raw indexes, decimals, and the target segment index are non-negative safe integers; decimals are at most 255. Transaction hashes and raw indexes are unique. Events are ordered ascending by `(timestamp, raw_index)`. Provider bodies and pagination envelopes are not accepted.

`source`, extraction method, decimal metadata, raw index, and unrelated normalized events do not enter package identity. Selected receipt transaction identities, timestamps, token/quote direction, and quantities affect reconstruction and therefore can change or invalidate the receipt/package.

## Deterministic sequence

The boundary performs this exact sequence:

1. Validate the request, completeness claims, frozen profiles, target, and normalized event envelope.
2. Clone normalized events.
3. Call the pure `buildPositionLedger()` with `weighted_average_position_accounting_v1`.
4. Call the pure `generateReceiptCandidates()` once.
5. Filter candidates only by target wallet, token mint, candidate/receipt type, and segment index.
6. Require exactly one match.
7. Require that match to be an eligible closed position.
8. Call `promoteReceiptCandidates([selected])`; no other candidate is promoted.
9. Call `verifyReceipt(selectedReceipt)`; `verifyReceiptBatch()` is neither imported nor called.
10. Require hash, schema, consistency, and verifier pass gates plus zero rule violations.
11. Enforce optional expected receipt-hash equality.
12. Build package-native archive/economics projections in memory from the stable canonical receipt fields.
13. Construct only through `buildReceiptPackageV1()`.
14. Call `validateReceiptPackageV1()` again on the completed package.
15. Compute all five serialized member SHA-256 values.
16. Return a dry-run result, or publish through the injected Slice 2 store.

Legacy cycle reconstruction, ledger/v1 comparison, `verifyReceiptBatch()`, unrelated open-snapshot verification, archive/economics compatibility writers, public HTML, and operational timestamp generation are absent.

## Return contract

```js
{
  orchestration_version: 'targeted_receipt_orchestration_v1',
  status: 'dry_run' | 'committed' | 'unchanged',
  target: {
    wallet,
    token_mint,
    receipt_type: 'closed_position',
    segment_index
  },
  receipt_hash,
  receipt_id,
  package_digest,
  member_hashes: {
    'archive-record.json': sha256,
    'canonical-receipt.json': sha256,
    'economics.json': sha256,
    'manifest.json': sha256,
    'verification.json': sha256
  },
  verification: {
    hash_valid: true,
    schema_valid: true,
    consistency_valid: true,
    pass: true,
    rule_violation_count: 0
  }
}
```

The result contains no package root or filesystem location, provider response/history, secret, operational timestamp, source revision, Git identity, recovery method, upload state, mint state, or signing state.

## Commit protocol

Commit mode requires an injected object implementing the Slice 2 methods:

```js
{
  inspect(receiptHash),
  stage(receiptPackage),
  validateStage(stagingHandle),
  commit(stagingHandle, { expectedPackageDigest })
}
```

The orchestrator stages the already-validated package, validates the stage, and commits with the exact package digest. The store returns `committed` for first publication and `unchanged` for an identical existing package. A different package under the same receipt hash becomes `package_store_conflict`.

On `commit_unknown`, the orchestrator calls `inspect(receiptHash)` exactly once. A committed package with the expected digest is accepted as `committed`; a different digest is a conflict; absence, invalid state, or failed inspection remains `commit_unknown`. The old staging handle is never blindly retried.

## Stable errors

Failures throw `TargetedReceiptOrchestrationError` with a stable `code`, a path-free message, path-free structured details, and no retained raw cause:

- `invalid_orchestration_request`
- `incomplete_acquisition_input`
- `incomplete_normalization_input`
- `invalid_normalized_event`
- `target_not_found`
- `target_ambiguous`
- `target_not_eligible`
- `canonical_promotion_failed`
- `verification_failed`
- `expected_receipt_hash_mismatch`
- `package_build_failed`
- `package_validation_failed`
- `package_store_required`
- `package_store_conflict`
- `commit_unknown`
- `capability_denied`

Underlying filesystem/provider errors are never attached as `cause` or copied into messages/details.

## Operational job-record boundary

Slice 7 does not persist job records. A future operational system may separately store:

```js
{
  job_id,
  idempotency_key,
  request_digest,
  started_at,
  completed_at,
  source_revision,
  acquisition_summary,
  result_receipt_hash,
  result_package_digest,
  status,
  retry_history
}
```

The request digest may bind a complete orchestration request for operational idempotency, but the record and all of its fields remain outside every package member, member digest, receipt hash, and package digest.

## Proposed Slice 8 bounded Helius acquisition port

Slice 8 should add acquisition outside this module through a provider-specific adapter and a provider-neutral bounded port:

```js
await acquisitionPort.acquireNormalizedSolanaSpotEventsV1({
  wallet,
  target: {
    token_mint,
    receipt_type: 'closed_position',
    segment_index
  },
  bounds: {
    before_signature: null | string,
    oldest_allowed_timestamp: number,
    newest_allowed_timestamp: number,
    max_pages: number,
    max_transactions: number
  },
  fetch_profile: 'receipt_scoped_transaction_selection_v1',
  normalization_profile: 'artifact_solana_spot_normalization_v1'
})
```

Proposed result:

```js
{
  normalizedEvents,
  inputStatus: {
    acquisition_complete: boolean,
    normalization_complete: boolean,
    pagination_complete: boolean,
    truncated: boolean,
    capped: boolean,
    partial: boolean,
    provider_uncertain: boolean
  },
  acquisitionSummary: {
    pages_read,
    transactions_read,
    normalized_event_count,
    oldest_observed_timestamp,
    newest_observed_timestamp
  }
}
```

The adapter must own pagination and provider response validation, terminate only on a provider-confirmed exhausted boundary, and fail closed on cap exhaustion, timeout, malformed pages, retries whose final outcome is uncertain, or normalization ambiguity. It must not expose raw responses to this orchestrator. `acquisitionSummary` belongs only in the future job record. The port must provide no package store, archive/economics writer, renderer, uploader, signer, or minter capability. Slice 8 should call Slice 7 only after every completeness flag proves a complete deterministic input.
