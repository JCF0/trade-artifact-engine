# Wallet Candidate Set v1: Evidence Contract

## Scope

Slice 1 defines and validates the pure result contract for complete wallet-wide acquisition. It does **not** implement the live wallet-wide acquisition adapter and does not call Helius or any other provider. A later adapter must produce this exact provider-neutral result before candidate construction can begin.

## `wallet_wide_acquisition_result_v1`

The acquisition result contains exactly:

- `scope`;
- frozen acquisition, normalization, reconstruction, accounting and mark profiles, including `mark_max_age_seconds`;
- a finalized chain boundary;
- fail-closed input status;
- recomputable coverage;
- canonical transaction dispositions;
- canonical normalized event records; and
- canonical activity findings.

The contract requires detached plain data without provider response bodies, credentials, URLs, local paths, storage handles or publication state. Exact object shapes and identifier-code fields enforce part of this boundary, but several identity strings (including wallet, transaction hash, blockhash and mint fields) are currently validated only as nonempty strings. A trusted acquisition boundary must therefore prevent sensitive-looking values from entering those fields until lexical validation is hardened.

## Latest-state fixed lookback

The only window version is `fixed_lookback_latest_state_v1`. Its identity includes Solana, mainnet-beta, the frozen genesis hash, wallet, lookback profile, requested lookback seconds, and a proven lower bound.

`initial_before_signature` **must be null**. This is an identity and validation rule: acquisition begins at the latest wallet state and paginates backward. A non-null initial cursor could silently turn a latest-state result into an arbitrary historical slice and is rejected.

The lower bound includes `oldest_allowed_timestamp` and `completion_status: proven`. The Slice 1 product contract permits only fixed lookbacks and no arbitrary historical end date. The current pure schema validates a nonempty lookback-profile identifier and nonnegative duration but does not itself contain the permitted-profile allowlist; the future acquisition/hosted boundary must enforce that allowlist before constructing the pure result.

## Finalized slot-aware upper boundary

The boundary is `solana_finalized_acquisition_boundary_v1` and binds:

- Solana mainnet-beta plus its genesis hash;
- `commitment: finalized`;
- anchor slot, block time and blockhash;
- `history_complete_through_anchor: true`;
- `lower_bound_completion_proven: true`; and
- `boundary_status: proven`.

Every source transaction and normalized event must be at or before the anchor slot. Open-position snapshots use the same authoritative slot, block time and blockhash, and `snapshot_at` equals the boundary block time. A boundary before the requested lower bound is invalid.

## Exact transaction disposition classes

Every examined wallet transaction receives exactly one `wallet_transaction_disposition_v1`:

1. `supported_normalized_event` — references exactly one normalized event, no findings, and the exact affected mints;
2. `unsupported_activity` — references one or more matching unsupported-activity findings and affected mints;
3. `ambiguous_activity` — references one or more matching ambiguous-activity findings; affected mints may be absent only when the ambiguity cannot be localized safely;
4. `unrelated_activity` — references no event, finding or affected mint; or
5. `failed_transaction` — references no event, finding or affected mint.

Disposition identity binds transaction hash, slot, nullable block time, class, affected mints and referenced digests. One source transaction hash may have only one disposition.

## Complete disposition accounting

The disposition collection is an exhaustive partition, not a sample. Coverage requires:

`transactions_examined = supported + unsupported + ambiguous + unrelated + failed`

and:

`normalized_event_count = supported_transaction_count`.

Every normalized event is referenced by exactly one supported disposition. Every disposition-backed finding is referenced and its source backlinks, affected mints and time/slot range must exactly reconcile. Duplicate transaction, disposition, event or finding identities fail closed.

Supported activity is normalized into the frozen Slice 7 event shape. The canonical disposition-backed finding taxonomy is closed to exactly `unsupported_activity` and `ambiguous_activity`; those classes become structured, code-only findings rather than provider prose. Unrelated and failed activity remains accounted for but contributes no event or finding. `partial_history_boundary`, `external_transfer_gap`, `unobserved_inventory`, `mark_source_limitation` and `balance_boundary_mismatch` are rejected as v1.13 activity finding types.

## Token-local versus wallet-wide impact

A finding has `impact_scope: token_specific` or `wallet_wide` and independently states whether it blocks candidate projection and receipt publication.

Token-specific unsupported or ambiguous activity blocks authoritative candidate reconstruction only for affected token mints. Other unaffected tokens may still be reconstructed. The blocked token receives a deterministic summary rather than a misleading candidate. These two activity classes are the only source of v1.13 blocked summaries.

Partial history and unobserved inventory are represented on visible candidates through `ledger_evidence_status`, flags, limitations, reason codes and disclosures. External-transfer uncertainty is a candidate limitation/reason code. Mark limitations are valuation states and mark/unrealized reason codes. Balance-boundary mismatch is reserved for a future historical-balance boundary slice and is not claimed as implemented in v1.13.

Wallet-wide uncertainty cannot be isolated safely. Any unresolved wallet-wide finding prevents acquisition-result acceptance for candidate evidence; no evidence bundle or candidate set is emitted.

## Source-transaction reference identity

A source transaction reference is exactly `(tx_hash, slot, block_time)` under `source_transaction_reference_v1`. Its digest is canonical SHA-256 over that versioned reference. Findings use these digests, not raw provider objects, as source anchors.

Slot and block time are distinct. Slot is authoritative for the finalized upper-bound check; nullable block time is retained for source identity and accounting. Disposition-backed findings require non-null source block times so their observed time range can be proven.

## Normalized-event integrity

Each `wallet_normalized_event_record_v1` binds `source_slot` and the exact existing Slice 7 event fields. The record digest is recomputed from its versioned content. The event wallet must equal the acquisition wallet; transaction hash and source slot must equal the referencing disposition; when disposition block time is present it must equal event timestamp.

Canonical event order is:

`timestamp → transaction signature (code-unit comparison) → source slot → event digest`.

Wallet-wide event `raw_index` values are dense in canonical order. At selection time the target-local projection is independently rebuilt and assigned new dense target-local indexes.

## Mark-observation identity

Marks are separate `wallet_mark_observation_v1` content-addressed observations using only `direct_quote_mark_v1`. The canonical evidence profile explicitly commits `mark_profile: direct_quote_mark_v1` together with `mark_max_age_seconds: 300`; both fields participate in evidence and scope identity. A null mark profile requires a null maximum age.

Mark observations are unique per `(token_mint, quote_mint)` pair. An empty observation collection requires `mark_profile: null` and `mark_max_age_seconds: null`; every nonempty collection requires the frozen profile and 300-second policy.

An available observation binds token mint, quote mint, positive finite raw-quote price, observation time and source slot, and has a null reason code. Snapshot valuation uses it only when token and quote match, `source_slot <= anchor_slot`, `observed_at <= snapshot_at`, and `snapshot_at - observed_at <= 300`. Ages 0, 299 and 300 are fresh; age 301 and older are stale. Future observations may remain committed evidence but are projected as after-boundary/unavailable valuation and never used for unrealized PnL.

An unavailable mark carries null price/time/slot and one exact reason code: source unavailable, stale, quote mismatch, after snapshot boundary, or snapshot boundary unavailable. Missing or unusable marks remain null; they never become zero.

## Coverage and integrity recomputation

Coverage is rebuilt from dispositions, events, findings, boundary, input status and terminal pagination reason. It binds class counts, finding scope counts, observed timestamp/slot bounds and the terminal reason. Caller-supplied coverage must be canonically identical to recomputation.

The evidence bundle also recomputes four ordered digest indexes and counts:

- transaction dispositions;
- normalized events;
- activity findings; and
- mark observations.

The bundle digest hashes the complete payload only. Candidate-set commitments copy the evidence-bundle, coverage and index digests, and candidate-set validation reconstructs the full projection from the bound evidence.

## Fail-closed acquisition behavior

Candidate evidence requires every status gate to be complete: acquisition, normalization, classification, pagination, historical lower bound and chain boundary. The result is rejected if it is truncated, capped, partial, provider-uncertain, not fully classified, not fully normalized, not terminally paginated, or unable to prove either boundary.

A terminal reason must be exactly `historical_bound_reached` or `provider_exhaustion`. Caps, incomplete pages, uncertain cursors, missing latest-state proof, unproven lower-bound completion, or any other ambiguous terminal condition produce no candidate evidence.

The future live adapter must prove both latest-state acquisition from a null initial cursor and complete backward acquisition through the permitted lower bound. Slice 1 currently supplies only the pure contract, validators, canonicalizers and deterministic fixtures for that future capability.
