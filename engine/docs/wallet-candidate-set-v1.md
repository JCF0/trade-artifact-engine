# Wallet Candidate Set v1

## Normal-user problem

A normal wallet owner should be able to see which reconstructed positions are plausible receipt candidates before choosing one, without submitting a raw transaction history, understanding ledger internals, or accidentally treating an incomplete position as publishable proof. Slice 1 turns a complete, bounded wallet-wide acquisition result into a deterministic private candidate view and provides a pure two-digest handoff for one eligible candidate.

## Pure Slice 1 boundary

Slice 1 is a local, deterministic contract and transformation layer. It accepts already-acquired, normalized, completely classified Solana mainnet-beta evidence; validates and content-addresses that evidence; reconstructs the existing position ledger; projects candidates; and resolves an authorized selection into an in-memory Slice 7 dry-run request.

It does not acquire live wallet history, call Helius, persist evidence or results, create hosted jobs, expose an API or UI, publish a page, upload content, sign a claim, mint an asset, or deploy anything.

The production candidate-set module graph enforces this pure capability boundary: it has no environment-variable access, timers, randomness, dynamic loading, child processes, filesystem or network imports, or import-time side effects.

## The two immutable objects

### `candidate_evidence_bundle_v1`

The evidence bundle is the private authoritative replay object for one wallet and one fixed latest-state lookback window. Its digest hashes the payload only. The payload binds:

- wallet/window scope and frozen profiles;
- a finalized slot-aware upper boundary;
- complete acquisition and coverage status;
- one disposition for every examined transaction;
- canonical normalized event records;
- token-local activity findings;
- optional direct-quote mark observations under the identity-bound `direct_quote_mark_v1` policy with `mark_max_age_seconds: 300`; and
- recomputable integrity indexes and counts.

### `wallet_candidate_set_v1`

The candidate set is the smaller browser-facing projection. Its digest also hashes the payload only. It binds the wallet/window scope, profile and evidence commitments, recomputed coverage, counts, candidate projections, blocked summaries, and the complete structured activity findings, including their source transaction and event digest anchors. It intentionally omits normalized event, disposition and mark-observation arrays and the private event-to-disposition replay mapping.

Both builders detach caller-owned data, accept only bounded plain JSON data, reject accessors, proxies, custom prototypes, symbols, sparse arrays and cycles, and deeply freeze every returned object and nested array.

## Acyclic identity graph

Identity flows in one direction and never includes a backlink to the digest being computed:

1. source transaction references, normalized event records, findings and mark observations receive local content digests;
2. canonical digest indexes bind each ordered evidence collection;
3. coverage is recomputed and receives a coverage digest;
4. the evidence payload commits to those values and produces `evidence_bundle_digest`;
5. window identity binds chain, network, genesis, wallet and the fixed window;
6. scope identity binds the window digest, coverage digest and frozen profiles;
7. receipt-scoped evidence binds all target-local normalized events;
8. each candidate-local identity binds its receipt-scoped evidence digest, legacy ledger candidate hash and full projection;
9. the candidate-set payload binds scope, evidence commitments, candidates, blocked summaries and findings, then produces `candidate_set_digest`.

Payloads containing their own envelope digest are rejected. Candidate identity does not include the candidate-set digest, so unrelated wallet evidence can change the set identity without changing an unaffected candidate-local identity.

## Wallet, window and coverage identity

Wallet identity is explicit in the Solana mainnet-beta scope and every candidate selection key. Network identity includes the frozen Solana mainnet-beta genesis hash.

Window identity uses `fixed_lookback_latest_state_v1`: a fixed-lookback identifier and duration ending at a proven finalized acquisition boundary. The initial cursor is always null, proving acquisition began from latest state rather than an arbitrary historical cursor. The lower bound must be proven complete. Product-level permitted-profile allowlisting remains a responsibility of the future acquisition/hosted boundary; the pure schema currently validates only a nonempty profile identifier and nonnegative duration.

Coverage identity commits to the complete disposition partition, normalized event and finding counts, observed time/slot bounds, and the terminal reason (`historical_bound_reached` or `provider_exhaustion`). Coverage is recomputed from evidence rather than trusted as caller prose.

## Candidate-local identity and status axes

A candidate has a semantic selection key `(wallet, token_mint, receipt_type, segment_index)` and a full digest-derived ID. Its status is intentionally multi-axis:

- `candidate_type`: closed position, realized partial, or open snapshot;
- `position_status`: closed or open;
- `ledger_evidence_status`: clean or limited partial history;
- `boundary_status`: not applicable for closed candidates or proven for open/partial candidates (`unavailable` is reserved for blocked summaries, not authoritative candidate projections);
- `valuation_status`: raw quote or a precise mark state;
- `selection_status`: selectable or visible only;
- `package_eligibility`: eligible closed position or not publication eligible; and
- `economics_status`: available or unavailable because history begins mid-position; and
- the existing ledger eligibility booleans.

These axes are not collapsed into one optimistic label.

## Closed, partial, open, limited and blocked behavior

- A clean closed candidate has closed ledger status, raw-quote economics, zero remaining quantity/cost basis, and verified-receipt ledger eligibility. Only this combination is selectable and package eligible.
- A realized-partial candidate records realized economics while the position remains open. It has a finalized snapshot boundary and is visible only.
- An open snapshot records remaining inventory, cost basis, realized PnL to date, and an available or explicitly unavailable direct-quote mark. It is visible only.
- A limited candidate keeps identity, token, segment, timestamps, observed event counts, flags, limitations, reason codes and disclosures, but uses `economics_status: unavailable_partial_history`, `economics: null`, `snapshot: null` and `valuation_status: unavailable`. Unknown basis, realized/unrealized PnL and valuation are never represented by zero. It is visible only and never publication eligible, even when a current mark was supplied.
- Disposition-backed activity findings are exactly `unsupported_activity` and `ambiguous_activity`. Token-specific findings of those types block that token from authoritative ledger reconstruction and produce a blocked summary instead of a candidate.
- Partial history and unobserved inventory are candidate evidence limitations, not transaction activity findings. External-transfer uncertainty is represented by candidate flags, limitations and reason codes. Mark limitations are valuation states and mark/unrealized reason codes. `balance_boundary_mismatch` is future historical-balance-boundary work and is not an implemented v1.13 finding.
- Unresolved wallet-wide impact blocks evidence-bundle and candidate-set construction entirely.

“Clean” describes evidence quality under this bounded contract; it is not a receipt or proof claim.

## Deterministic ordering

Transaction dispositions, event records, findings, marks, candidate projections, blocked summaries and digest indexes have explicit canonical comparators. Candidate and blocked-summary arrays are digest ordered. Activity findings are ordered by observed slot range, type, impact scope and digest. Target-local events use timestamp, signature code-unit order, source slot and event digest, then receive dense local `raw_index` values.

Canonical JSON and SHA-256 make repeated builds, source permutations and detached caller mutation byte-stable.

`direct_quote_mark_v1` is usable only when token and quote mints match, price is positive and finite, source slot and observation time are not after the finalized snapshot boundary, and age is at most 300 seconds. Ages 0, 299 and 300 are fresh; age 301 is stale. Stale, future, unavailable and quote-mismatched marks produce null unrealized values and are never described as fresh.

## Relationship to the position ledger and receipt candidates

Slice 1 reuses the existing `buildPositionLedger()` and `generateReceiptCandidates()` implementation. It does not introduce a second accounting engine. Candidate projection reconstructs each legacy receipt candidate from complete receipt-scoped evidence and preserves exact equality of the existing `candidate_hash` as `ledger_candidate_hash`. Weighted-average raw-quote accounting remains frozen.

## Relationship to Slice 7 and `receipt_package_v1`

Selection resolves one clean verified closed candidate to the existing Slice 7 targeted orchestrator request. The request is dry-run only and contains target-local normalized events, complete input status, the exact target key and frozen package profiles. Slice 7 then regenerates the ledger candidate and can build the authoritative five-member `receipt_package_v1` in memory.

Slice 1 does not alter `receipt_package_v1` identity. The current resolver's private audit provenance contains candidate-set, evidence-bundle, candidate, receipt-scoped-evidence and legacy ledger-candidate digests plus the source projection mapping; it contains no job or network provenance. Any later operational job/network provenance and candidate-set-to-package linkage must remain separate private audit metadata and must not be inserted into package members.

The v1.13 regression runner selects exactly the three current JUP-like, RAY-like and dry-run store-isolation tests by anchored full test name. The literals are code-unit escaped, TAP is parsed fail-closed, and the gate requires exactly three selected and passed tests with no selected skip or failure.

## Anti-overclaim boundary

A candidate set is a private deterministic discovery and selection object:

**candidate set**

**≠ receipt**

**≠ proof**

**≠ portfolio statement**

**≠ track record**

**≠ authorization token**

It is also not a complete-wallet performance claim. Only a later, separately authorized package/publication flow can create or publish a receipt artifact.
