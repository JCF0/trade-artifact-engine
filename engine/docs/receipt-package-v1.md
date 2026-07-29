# `receipt_package_v1`

## Scope

`receipt_package_v1` is the immutable, pure, in-memory publication contract for one complete stable proof record for a verified Artifact v1.2 closed-position receipt. “Complete canonical receipt” in this contract means the complete stable package-native proof record defined below. It does not mean the complete object emitted by an operational promotion run.

The package has exactly five authoritative JSON members:

- `manifest.json`
- `canonical-receipt.json`
- `verification.json`
- `archive-record.json`
- `economics.json`

HTML, card models, board rows, public proof view-models, E2E display entries, acquisition records, raw/provider responses, operational job records, and upload/mint/signing state are not package members. Slice 1 performs no I/O, acquisition, inventory integration, migration, rendering, upload, minting, or signing.

The package returned by `buildReceiptPackageV1()` is deeply cloned and frozen. Inputs are never mutated or retained by reference.

## Builder API and promotion-input projection

```js
buildReceiptPackageV1({
  canonicalReceipt,
  verificationResult,
  archiveRecord,
  economicsRecord,
  inputCommitment
})
```

All arguments are plain in-memory values. The builder accepts either the package-native stable canonical/archive records or the legacy promotion-shaped canonical/archive inputs. For promotion-shaped inputs it validates, then discards exactly these operational trace fields before member hashing:

```text
candidate_hash
source
promoted_at
promoted_from
```

They never occur in an authoritative package member. Any other extra field is rejected. Objects with accessors, symbol keys, custom prototypes, non-enumerable fields, cycles, sparse arrays, named array properties, `undefined`, functions, symbols, bigints, non-finite numbers, or negative zero are rejected.

## Audit of receipt-hash-excluded fields

`computeReceiptHash()` excludes the following fields. Their package treatment is explicit:

| Field | Classification | Package treatment |
|---|---|---|
| `receipt_id` | deterministic derived field | retained; must equal `art_v12_cp_${token_mint.slice(0, 8)}_${segment_index}` |
| `display_status` | deterministic derived field | retained; closed verified v1 requires `Verified Closed Position` |
| `position_status` | stable receipt semantic | retained; must be `closed` |
| `snapshot_at` | deterministic derived field | retained; must be `null` for the initial closed-position contract |
| `hold_time_seconds` | deterministic derived field | retained; must equal `last_event_at - first_event_at` |
| `num_buys` | deterministic derived field | retained; must equal `entry_tx_hashes.length` |
| `num_sells` | deterministic derived field | retained; must equal `exit_tx_hashes.length` |
| `limitations` | deterministic semantic disclosure | retained as a closed object; values and disclosures must agree with receipt type, flags, and verifier rules |
| `candidate_hash` | operational traceability provenance | removed; belongs in the operational job record if needed |
| `unrealized_pnl_quote` | deterministic derived field | retained; must be `null` for a closed receipt |
| `unrealized_pnl_pct` | deterministic derived field | retained; must be `null` for a closed receipt |
| `source` | operational reconstruction-run label | removed; the stable reconstruction version is committed separately |
| `promoted_at` | operational/run timestamp | removed everywhere from the package |
| `promoted_from` | operational candidate/run trace | removed; belongs in the operational job record |
| `ledger_accounting_version` | stable accounting version identifier | retained; must equal `accounting_method` and `input_commitment.accounting_method_version` |

All fields included by `computeReceiptHash()` remain authoritative and are preserved exactly.

## Exact member schemas

Every member object is closed: all listed fields are required and every unlisted field is rejected.

### `canonical-receipt.json`

This is the complete stable package-native proof record:

```text
receipt_hash
receipt_id
receipt_version
receipt_type
token_mint
wallet
chain
segment_index
verification_status
display_status
accounting_method
quote_mint
quote_symbol
valuation_status
total_bought_qty
total_bought_quote
avg_buy_quote_price
total_sold_qty
total_sold_quote
avg_sell_quote_price
allocated_cost_basis_quote
remaining_qty
remaining_cost_basis_quote
realized_pnl_quote
realized_pnl_pct
unrealized_pnl_quote
unrealized_pnl_pct
position_status
first_event_at
last_event_at
snapshot_at
hold_time_seconds
entry_tx_hashes
exit_tx_hashes
num_buys
num_sells
limitations
flags
ledger_accounting_version
```

The initial v1 package requires:

- `receipt_version === "1.2.0"`
- `receipt_type === "closed_position"`
- `verification_status === "verified"`
- `position_status === "closed"`
- complete economics and transaction-hash arrays
- deterministic receipt ID, display status, hold time, transaction counts, limitations, and closed-position null fields
- the existing deterministic `verifyReceipt()` result to pass every gate with zero violations

### `verification.json`

The complete exact deterministic `verifyReceipt()` result over the stable receipt:

```text
receipt_id
receipt_hash
recomputed_hash
hash_valid
rule_violations
schema_valid
consistency_valid
pass
```

It must equal a fresh verifier call exactly. Every gate is `true` and `rule_violations` is empty.

### `archive-record.json`

Package-native archive projection:

```text
archive_record_version = "receipt_package_archive_record_v1"
```

plus every stable canonical field except:

```text
segment_index
accounting_method
entry_tx_hashes
exit_tx_hashes
total_bought_qty
total_bought_quote
avg_buy_quote_price
total_sold_qty
total_sold_quote
avg_sell_quote_price
allocated_cost_basis_quote
remaining_qty
remaining_cost_basis_quote
realized_pnl_quote
realized_pnl_pct
hold_time_seconds
num_buys
num_sells
```

Every archive field equals the corresponding stable canonical field exactly. Legacy filesystem provenance, candidate provenance, promotion provenance, mutable inventory state, render state, and upload/mint fields are excluded.

### `economics.json`

```text
economics_version = "receipt_package_economics_v1"
receipt_hash
receipt_version
receipt_type
segment_index
accounting_method
entry_tx_hashes
exit_tx_hashes
total_bought_qty
total_bought_quote
avg_buy_quote_price
total_sold_qty
total_sold_quote
avg_sell_quote_price
allocated_cost_basis_quote
remaining_qty
remaining_cost_basis_quote
realized_pnl_quote
realized_pnl_pct
hold_time_seconds
num_buys
num_sells
```

Every field equals the corresponding stable canonical field. Overlaying economics on archive, after removing the projection-version discriminators, reconstructs `canonical-receipt.json` exactly.

### `manifest.json`

```js
{
  package_version: "receipt_package_v1",
  receipt_hash,
  receipt_version,
  receipt_type,
  package_status: "verified",
  members: {
    "canonical-receipt.json": { media_type: "application/json", sha256 },
    "verification.json":      { media_type: "application/json", sha256 },
    "archive-record.json":    { media_type: "application/json", sha256 },
    "economics.json":         { media_type: "application/json", sha256 }
  },
  verification_gate: {
    recomputed_hash,
    hash_valid: true,
    schema_valid: true,
    consistency_valid: true,
    pass: true,
    rule_violation_count: 0
  },
  input_commitment: {
    fetch_profile: "receipt_scoped_transaction_selection_v1",
    normalization_profile,
    reconstruction_engine_version,
    accounting_method_version
  },
  package_digest
}
```

`fetch_profile` identifies the deterministic receipt-scoped selection rule, not a provider or request configuration. It means only normalized events selected by the canonical `entry_tx_hashes` and `exit_tx_hashes`, in those arrays’ semantic order, participate in receipt reconstruction. Provider identity and wallet lookback are operational data.

`reconstruction_engine_version` is the stable package-native reconstruction implementation/profile version and is intentionally distinct from the removed operational `source` label. `accounting_method_version` must equal both `canonical-receipt.json.accounting_method` and `canonical-receipt.json.ledger_accounting_version`.

The normalization, reconstruction, and accounting identifiers must use the closed versioned-identifier grammar `[a-z][a-z0-9]*(?:_[a-z0-9]+)*_v[1-9][0-9]*`. Free-form run labels and timestamps are not valid profile/version identifiers.

## Evidence commitment decision

Slice 1 deliberately has no evidence digest.

The prior `transactions_sha256` was wallet-wide and could vary when unrelated transactions, pagination, provider output, or lookback changed. It is removed rather than renamed. `receipt_evidence_sha256` is also deferred: Slice 1 receives the resulting receipt, archive projection, economics projection, and verifier result, but not a closed normalized-evidence record whose digest it could independently validate. Accepting an unverifiable caller-supplied digest would recreate the identity hazard.

A future slice may add `receipt_evidence_sha256` only together with a closed normalized evidence schema and orchestrator validation. Its required preimage contract must be:

1. include only normalized evidence records selected for transaction hashes in canonical `entry_tx_hashes`, followed by canonical `exit_tx_hashes`;
2. preserve that receipt-defined order;
3. include no unrelated wallet transactions, raw provider bytes, request/page metadata, pagination, lookback bounds, provider identity, or fetch time;
4. canonicalize the closed normalized records using the package canonical JSON rules; and
5. hash the exact UTF-8 canonical bytes with SHA-256.

Until that normalized evidence schema exists, no evidence digest affects package identity.

## Operational job-record boundary

A later operational job record may contain:

- job ID and idempotency key;
- start and end timestamps;
- Git/source commit;
- `candidate_hash`, promotion source label, `promoted_at`, and `promoted_from`;
- raw-response and complete-wallet transaction digests;
- fetch bounds, lookback, and provider profile;
- request and page counts;
- retry history;
- result receipt hash and package digest.

The job record is not a package member, is stored separately, and never participates in member SHA-256 values or `package_digest`.

## Canonical serialization

`canonicalJson(value)`:

1. validates lossless plain JSON;
2. recursively sorts object keys by JavaScript code-unit ordering;
3. preserves array order;
4. serializes with two-space indentation;
5. emits LF line endings and exactly one trailing LF.

Own `__proto__` keys are handled as data properties without prototype mutation. No locale, timezone, current time, directory, or operating-system path behavior participates.

Member digests are:

```text
SHA-256(UTF-8(canonicalJson(member)))
```

## Package-digest algorithm

To avoid circular self-inclusion:

1. copy the five-member package;
2. omit only `manifest.json.package_digest`;
3. retain every other manifest field and all four content members;
4. canonicalize the complete preimage object; and
5. compute lowercase SHA-256 over its UTF-8 bytes.

```text
package_digest = SHA-256(
  UTF-8(canonicalJson(package with manifest.package_digest omitted))
)
```

Therefore differing promotion times, promotion/candidate source labels, wallet-wide transaction sets, provider responses, or operational job metadata cannot change package bytes. Changed stable version identifiers, selected transaction hashes, receipt economics, stable disclosures, or verifier results do change or invalidate the package.

## Validation invariants

`validateReceiptPackageV1()`:

1. requires exactly the five authoritative members;
2. validates each member against its closed schema;
3. requires one receipt hash/version/type and closed verified status;
4. validates commitment versions against the canonical receipt;
5. checks archive and economics overlap field by field;
6. reconstructs the stable receipt exactly from archive and economics;
7. reruns `verifyReceipt()` and reproduces the receipt hash;
8. requires `verification.json` to equal the fresh result;
9. recomputes every member SHA-256; and
10. recomputes `package_digest`.

## Forbidden package data

Closed schemas and recursive checks reject job/runtime metadata, paths, provider/API/RPC URLs, API-key identity, retries, Git revision, raw transactions/provider responses, credentials, signing, upload, and mint state. Absolute POSIX/Windows paths and URL strings are rejected. `promoted_at`, `source`, `promoted_from`, `candidate_hash`, `transactions_sha256`, and `receipt_evidence_sha256` are not package fields.

## Error codes

All contract failures throw `ReceiptPackageError` with a stable `code` and optional details.

Shape/losslessness:

- `accessor_not_allowed`
- `custom_prototype_not_allowed`
- `cyclic_value_not_allowed`
- `invalid_json_number`
- `non_enumerable_field_not_allowed`
- `sparse_array_not_allowed`
- `symbol_key_not_allowed`
- `unsupported_json_value`
- `invalid_object`
- `unknown_field`
- `missing_field`

Policy/schema:

- `forbidden_field`
- `forbidden_value`
- `invalid_field`
- `derived_field_mismatch`
- `malformed_receipt_hash`
- `unsupported_receipt_version`
- `unsupported_receipt_type`
- `receipt_status_invalid`
- `unsupported_archive_record_version`
- `unsupported_economics_version`
- `invalid_verification_result`
- `unsupported_package_version`
- `package_status_invalid`
- `invalid_media_type`
- `package_member_set_invalid`
- `input_commitment_mismatch`

Cross-member/integrity:

- `receipt_hash_disagreement`
- `manifest_identity_mismatch`
- `archive_overlap_mismatch`
- `economics_overlap_mismatch`
- `canonical_reconstruction_mismatch`
- `receipt_hash_mismatch`
- `verification_gate_failed`
- `verification_result_mismatch`
- `manifest_verification_gate_mismatch`
- `member_hash_mismatch`
- `package_digest_mismatch`

## Slice 2 package-store boundary (proposal only)

A filesystem package store should consume only already-built, already-validated serialized members:

```js
inspectReceiptPackageV1(receiptHash)
stageReceiptPackageV1({ receiptHash, packageDigest, members })
validateStagedReceiptPackageV1(stagingHandle)
commitReceiptPackageV1(stagingHandle, { expectedPackageDigest })
abortReceiptPackageV1(stagingHandle)
```

The store should stage all five files on the destination filesystem, fsync, read back and validate, then publish with one non-replacing directory rename. Same hash plus same digest is `unchanged`; same hash plus different digest is a conflict. Readers expose only complete valid committed directories.

Fault injection belongs before and after staging creation, each write/fsync, staged validation, commit rename, parent fsync, concurrent destination appearance, abort cleanup, and stale-stage cleanup. At every fault, readers observe either no package or one complete valid package. Archive/economics/inventory indexes remain rebuildable projections outside the package transaction.
