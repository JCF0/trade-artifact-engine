# Artifact v1.14.1 Controlled-Live Diagnostic Observability Implementation Plan

> **For Hermes:** Implement only after explicit approval. Use test-driven development, leave all changes uncommitted and unpushed, and do not run any live/provider command.

**Goal:** Add fixed-enum, non-secret localization metadata to `malformed_provider_response` controlled-live safe-failure reports without changing acquisition, candidate, receipt, package, retry, timeout, or capability semantics.

**Architecture:** Keep diagnostics out of every authoritative acquisition/candidate/receipt/package object. Mint a private, allowlisted diagnostic tuple on sanitized `WalletAcquisitionError` instances, add trusted stage/operation context at existing call sites, and project the tuple only into the temporary controlled-live safe-failure report. Never retain or derive diagnostics from provider-controlled strings, keys, values, bodies, URLs, errors, or stack traces.

**Tech stack:** Node.js ESM, `node:test`, existing canonical JSON serializer and direct-Node v1.14 regression runner.

---

## Scope and invariants

- Patch line: v1.14.x only; proposed release `v1.14.1`.
- No provider-shape acceptance changes.
- No acquisition/candidate/receipt/package schema or semantic changes.
- No retry, timeout, page, transaction, or attempt-budget changes.
- No new I/O or capability: no store, publication, upload, signing, minting, deployment, credential-file, or extra network imports.
- No raw response/body retention and no signatures, transaction details, URLs, headers, provider prose/errors, stacks, paths, credentials, or secret values in diagnostics.
- Report path validation, exclusive mode-0600 creation, canonical serialization, and temporary-root policy remain unchanged.
- Existing status and `error_code` decisions remain exact for every existing fixture.
- User controls Git: no commit, tag, push, reset, staging, or release publication.

## Exact report schema

Bump the operational report discriminator from:

```json
"artifact_v1.14_controlled_live_validation_v1"
```

to:

```json
"artifact_v1.14_controlled_live_validation_v2"
```

Reason: adding a retained object to a closed sanitized-report variant is a schema change. The product patch is v1.14.1; the report contract is v2. Acquisition/candidate/receipt/package versions do not change.

For `status: "safe_failure"` with `error_code: "malformed_provider_response"`, require exactly one additional top-level object:

```json
"failure_diagnostic": {
  "diagnostic_version": "controlled_live_failure_diagnostic_v1",
  "stage": "<FAILURE_STAGE_V1>",
  "operation": "<FAILURE_OPERATION_V1>",
  "reason": "<MALFORMED_REASON_V1>"
}
```

The object is absent from PASS reports and from non-malformed safe failures. This keeps the patch narrow and avoids inventing localization for unrelated errors. Tests must enforce exact keys, ordinary-object/dense-plain-data shape, and enum membership.

### `FAILURE_STAGE_V1`

```text
request_binding
finalized_anchor
canonical_pagination
latest_state_recheck
enhanced_history
enhanced_projection
internal_boundary
```

`internal_boundary` is defensive fallback only. A regression must prove that every currently reachable production malformed branch uses a more specific stage.

### `FAILURE_OPERATION_V1`

```text
acquisition_budget_binding
network_identity
finalized_slot
finalized_block
canonical_signature_page
enhanced_address_history
enhanced_transaction_projection
none
```

`none` is permitted only with the defensive `internal_boundary` fallback.

### `MALFORMED_REASON_V1`

```text
invalid_json
rpc_envelope_invalid
rpc_genesis_result_invalid
rpc_slot_result_invalid
rpc_block_result_invalid
rpc_signature_page_invalid
enhanced_page_invalid
enhanced_duplicate_signature
enhanced_order_invalid
enhanced_page_incomplete
enhanced_cursor_repeated
enhanced_transaction_shape_invalid
provider_value_not_plain
unlocalized_malformed_response
```

`unlocalized_malformed_response` is defensive fallback only and must not be emitted by any known deterministic malformed branch.

## Safe propagation design

1. Store diagnostic metadata in a module-private `WeakMap` keyed by freshly minted `WalletAcquisitionError` instances. Do not add provider-controlled `details`, messages, causes, or enumerable properties to errors.
2. Extend the internal failure helper so trusted production validators can supply only an allowlisted reason enum. Existing calls without a reason retain current behavior.
3. Add a helper that launders an error into a fresh `WalletAcquisitionError` and attaches only allowlisted stage/operation values. It must read the existing error code through the current guarded own-data-property path and read prior diagnostic reason only from the private `WeakMap`.
4. Provider/injected-capability errors cannot provide diagnostic strings. Unknown, malformed, accessor-bearing, proxy, or forged metadata is ignored.
5. Wrap each existing provider call in `orchestrator.mjs` with its fixed stage and operation:
   - identity, slot, block -> `finalized_anchor`;
   - initial signature pages -> `canonical_pagination`;
   - recheck signature pages -> `latest_state_recheck`;
   - Enhanced history -> `enhanced_history`.
6. If the Enhanced adapter reports `enhanced_transaction_shape_invalid`, override the stage/operation to `enhanced_projection` / `enhanced_transaction_projection`; all page/reconciliation reasons remain `enhanced_history` / `enhanced_address_history`.
7. Label the provider-neutral detachment reason as `provider_value_not_plain`; preserve the trusted call-site stage and operation. Label malformed acquisition-budget detachment as `request_binding` / `acquisition_budget_binding`.
8. In the controlled-live catch, emit `failure_diagnostic` only when the sanitized code is `malformed_provider_response`. If complete trusted metadata is unexpectedly absent, emit the fixed fallback tuple `internal_boundary` / `none` / `unlocalized_malformed_response`; never inspect the original thrown object for more detail.

## Tasks

### Task 1: Pin report-v2 and privacy behavior with RED tests

**Modify:**
- `engine/src/wallet-acquisition/run-controlled-live-validation.test.mjs`

Add failing tests that require:

- exact report discriminator v2;
- exact diagnostic object for a malformed injected acquisition error;
- diagnostic absence on PASS and every existing non-malformed safe-failure fixture;
- unknown/forged diagnostic data cannot enter the report;
- canaries in error messages, keys, details, causes, URLs, paths, headers, stacks, and credential-like values never enter bytes;
- no signatures or transaction-shaped values in the diagnostic object;
- unchanged mode `0600`, absolute temporary path restrictions, and exclusive non-overwrite behavior;
- unchanged status and `error_code` for every existing fixture.

Run:

```text
node --test engine/src/wallet-acquisition/run-controlled-live-validation.test.mjs
```

Expected RED: diagnostic/report-v2 assertions fail before production changes.

### Task 2: Add private fixed-enum diagnostic transport

**Modify:**
- `engine/src/wallet-acquisition/provider-port.mjs`
- `engine/src/wallet-acquisition/provider-port.test.mjs`

Tests first:

- all stage/operation/reason enum values round-trip through the private metadata accessor;
- unknown values are rejected or replaced by the fixed fallback, never copied;
- arbitrary thrown objects, proxies, getters, symbols, forged `WalletAcquisitionError` fields, messages, details, and causes cannot inject metadata;
- sanitization returns a fresh fixed error and preserves the existing code decision;
- provider return plain-data failures carry only `provider_value_not_plain`;
- acquisition-budget plain-data failures carry request-binding context;
- ordinary valid outputs remain deeply equal/frozen as before.

Run RED, implement the minimum private-`WeakMap` helpers, then rerun GREEN:

```text
node --test engine/src/wallet-acquisition/provider-port.test.mjs
```

### Task 3: Classify RPC and Enhanced-page malformed reasons

**Modify:**
- `engine/src/wallet-acquisition/helius-rpc-validator.mjs`
- `engine/src/wallet-acquisition/helius-rpc-validator.test.mjs`
- `engine/src/wallet-acquisition/helius-wallet-history-adapter.mjs`
- `engine/src/wallet-acquisition/helius-wallet-history-adapter.test.mjs`

Table-driven RED tests must cover every direct malformed branch/class:

- invalid JSON from transport;
- non-plain/wrong-key/wrong-id/wrong-version RPC envelope;
- genesis result type;
- slot result safety;
- block requested-slot mismatch, block-time failure, blockhash failure;
- signature page non-array, oversized/sparse/non-plain page, wrong/missing/extra entry fields, invalid signature/slot/time/finality;
- Enhanced page non-array/oversized/sparse/non-plain and invalid signature/slot/timestamp/missing `transactionError`;
- duplicate Enhanced signatures;
- forward-moving slot or timestamp order;
- requested signature absent at a short page;
- repeated Enhanced cursor.

Each test must assert exact existing `error.code`, exact fixed reason, and one HTTP call/no retry for malformed transport/shape outcomes. Existing retryable timeout/transient/429/5xx tests must remain unchanged.

Run:

```text
node --test engine/src/wallet-acquisition/helius-rpc-validator.test.mjs
node --test engine/src/wallet-acquisition/helius-wallet-history-adapter.test.mjs
```

### Task 4: Classify every Enhanced projector malformed branch class

**Modify:**
- `engine/src/wallet-acquisition/helius-enhanced-projector.mjs`
- `engine/src/wallet-acquisition/helius-enhanced-projector.test.mjs`

Keep one reason only: `enhanced_transaction_shape_invalid`. Do not add accepted shapes.

Expand table-driven tests to cover every existing malformed class:

- hostile/non-plain/proxy/cyclic/accessor/sparse/excessive graph;
- missing top-level required fields and invalid signature/slot/timestamp/type/fee payer;
- malformed swap object, token/native swap legs, wallet owner, mint, raw amount, decimals;
- malformed instruction and inner-instruction arrays;
- malformed token/native transfer entries and explicit raw amounts;
- malformed account/account token-balance rows, signed raw amounts, decimals, and conflicting token-account identity;
- malformed native balance, fee, and closure/rent numeric evidence;
- unexpected non-`WalletAcquisitionError` exceptions mapped to the same fixed reason.

For each existing accepted fixture, assert output deep equality and canonical bytes remain unchanged.

Run:

```text
node --test engine/src/wallet-acquisition/helius-enhanced-projector.test.mjs
```

### Task 5: Attach trusted acquisition stage and operation

**Modify:**
- `engine/src/wallet-acquisition/orchestrator.mjs`
- `engine/src/wallet-acquisition/orchestrator.test.mjs`

Add deterministic injected-port tests for exact tuples from:

- network identity;
- finalized slot;
- finalized block;
- initial canonical signature pagination;
- latest-state head recheck;
- Enhanced page/reconciliation;
- Enhanced projection;
- provider-neutral detachment at each representative method.

Assert the same underlying errors still produce the same PASS/SAFE_FAILURE/error-code decisions. Assert no acquisition result is emitted for malformed paths.

Run:

```text
node --test engine/src/wallet-acquisition/orchestrator.test.mjs
```

### Task 6: Project only sanitized diagnostics into report v2

**Modify:**
- `engine/src/wallet-acquisition/run-controlled-live-validation.mjs`
- `engine/src/wallet-acquisition/run-controlled-live-validation.test.mjs`

Implement the exact schema above. Keep report path validation and `openSync(path, 'wx', 0o600)` unchanged. Keep stdout to fixed PASS/SAFE_FAILURE lines; do not print diagnostic fields automatically.

Rerun the Task 1 file and require GREEN.

### Task 7: Prove artifact identity and decision invariance

**Modify tests only if existing pins do not already provide complete coverage:**
- `engine/src/wallet-acquisition/retained-provider-acceptance.test.mjs`
- `engine/src/wallet-acquisition/candidate-set-integration.test.mjs`

Required proof:

1. For accepted retained and synthetic inputs, compare canonical bytes/digests of:
   - acquisition result;
   - evidence bundle;
   - candidate set;
   - selection resolution;
   - Slice 7 dry-run receipt/package result.
2. Keep existing pinned expected constants, not values generated by the modified implementation during the same test.
3. Run the exact JUP/RAY golden package gate and require the existing identities:
   - RAY receipt: `4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341`
   - RAY package: `25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2`
   - JUP receipt: `5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca`
   - JUP package: `5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278`
   - every existing pinned member hash unchanged.
4. Compare the complete existing fixture decision vector before/after: PASS/SAFE_FAILURE status and exact error code must match; only malformed safe-failure report metadata and the report discriminator may differ.

Run:

```text
node --test engine/src/wallet-acquisition/retained-provider-acceptance.test.mjs
node --test engine/src/wallet-acquisition/candidate-set-integration.test.mjs
node engine/src/receipt-package/golden-packages.test.mjs
```

No package-store production root is used; the golden test writes only isolated temporary roots and cleans them.

### Task 8: Documentation and patch identifier

**Modify:**
- `engine/docs/v1.14-operations.md`
- `engine/docs/v1.14-limitations.md`
- Create only if the repository release-note convention requires it: `engine/docs/v1.14.1-release-notes.md`

Document:

- release identifier `v1.14.1`;
- report contract v2 and exact enums;
- diagnostics are operational sanitized evidence, never authoritative artifact input;
- no retry/provider-shape/semantic/capability change;
- old v1 reports remain historical evidence and are not rewritten;
- W1's existing v1 report cannot be retrospectively localized;
- a future W1 run requires separate authorization after release acceptance.

Do not alter historical W1/W2 reports.

### Task 9: Final offline regression and safety audit

Run only direct, offline commands:

```text
node engine/src/run-v114-regression.mjs
node engine/src/receipt-package/golden-packages.test.mjs
git diff --check
git status --short --untracked-files=all
```

Also perform read-only static checks over changed production files:

- no new `fetch`, filesystem read/write beyond the unchanged report writer, environment access, package store, upload, signer, mint, deploy, API, UI, worker, or hosted-job import;
- no dynamic/provider-controlled diagnostic strings;
- enum-only diagnostic values;
- diagnostic fields absent from acquisition/evidence/candidate/receipt/package builders and hash preimages;
- report forbidden-field/value canaries remain absent;
- report remains canonical mode-0600 exclusive temporary output.

Do not run the root `npm test` wrapper because it exercises the excluded devnet mint suite. Do not make a controlled-live call.

## Expected files changed

Production:

- `engine/src/wallet-acquisition/provider-port.mjs`
- `engine/src/wallet-acquisition/helius-rpc-validator.mjs`
- `engine/src/wallet-acquisition/helius-enhanced-projector.mjs`
- `engine/src/wallet-acquisition/helius-wallet-history-adapter.mjs`
- `engine/src/wallet-acquisition/orchestrator.mjs`
- `engine/src/wallet-acquisition/run-controlled-live-validation.mjs`

Tests:

- `engine/src/wallet-acquisition/provider-port.test.mjs`
- `engine/src/wallet-acquisition/helius-rpc-validator.test.mjs`
- `engine/src/wallet-acquisition/helius-enhanced-projector.test.mjs`
- `engine/src/wallet-acquisition/helius-wallet-history-adapter.test.mjs`
- `engine/src/wallet-acquisition/orchestrator.test.mjs`
- `engine/src/wallet-acquisition/run-controlled-live-validation.test.mjs`
- only if stronger identity pins are missing: `retained-provider-acceptance.test.mjs`, `candidate-set-integration.test.mjs`

Documentation:

- `engine/docs/v1.14-operations.md`
- `engine/docs/v1.14-limitations.md`
- optional repository-convention release note for v1.14.1

No package/candidate/receipt implementation file, lockfile, dependency manifest, Git metadata, configuration, or production data/store path should change.

## Acceptance criteria

- Every known `malformed_provider_response` production branch maps to one exact fixed tuple.
- No known branch uses the defensive unlocalized fallback.
- Existing fixture decisions and error codes are unchanged.
- Retry/timeout telemetry and call counts are unchanged.
- Accepted acquisition/evidence/candidate/receipt/package canonical bytes and digests are unchanged.
- Exact JUP/RAY receipt, package, and member identities remain pinned.
- Report schema is v2; malformed safe failures alone gain the diagnostic object.
- Privacy, path, mode, and capability gates pass.
- Full direct v1.14 regression and golden package gate pass offline.
- Changes remain uncommitted and unpushed for user review.
