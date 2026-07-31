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
- optional direct-quote mark observations; and
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
- the existing ledger eligibility booleans.

These axes are not collapsed into one optimistic label.

## Closed, partial, open, limited and blocked behavior

- A clean closed candidate has closed ledger status, raw-quote economics, zero remaining quantity/cost basis, and verified-receipt ledger eligibility. Only this combination is selectable and package eligible.
- A realized-partial candidate records realized economics while the position remains open. It has a finalized snapshot boundary and is visible only.
- An open snapshot records remaining inventory, cost basis, realized PnL to date, and an available or explicitly unavailable direct-quote mark. It is visible only.
- A limited candidate exposes reconstructable partial-history information with `limited_partial_history`; it is never publication eligible.
- Token-specific unsupported or ambiguous activity, or a blocking `partial_history_boundary`, `external_transfer_gap`, `unobserved_inventory`, or `balance_boundary_mismatch` finding, blocks that token from authoritative ledger reconstruction and produces a blocked summary instead of a candidate.
- Unresolved wallet-wide impact blocks evidence-bundle and candidate-set construction entirely.

“Clean” describes evidence quality under this bounded contract; it is not a receipt or proof claim.

## Deterministic ordering

Transaction dispositions, event records, findings, marks, candidate projections, blocked summaries and digest indexes have explicit canonical comparators. Candidate and blocked-summary arrays are digest ordered. Activity findings are ordered by observed slot range, type, impact scope and digest. Target-local events use timestamp, signature code-unit order, source slot and event digest, then receive dense local `raw_index` values.

Canonical JSON and SHA-256 make repeated builds, source permutations and detached caller mutation byte-stable.

## Relationship to the position ledger and receipt candidates

Slice 1 reuses the existing `buildPositionLedger()` and `generateReceiptCandidates()` implementation. It does not introduce a second accounting engine. Candidate projection reconstructs each legacy receipt candidate from complete receipt-scoped evidence and preserves exact equality of the existing `candidate_hash` as `ledger_candidate_hash`. Weighted-average raw-quote accounting remains frozen.

## Relationship to Slice 7 and `receipt_package_v1`

Selection resolves one clean verified closed candidate to the existing Slice 7 targeted orchestrator request. The request is dry-run only and contains target-local normalized events, complete input status, the exact target key and frozen package profiles. Slice 7 then regenerates the ledger candidate and can build the authoritative five-member `receipt_package_v1` in memory.

Slice 1 does not alter `receipt_package_v1` identity. The current resolver's private audit provenance contains candidate-set, evidence-bundle, candidate, receipt-scoped-evidence and legacy ledger-candidate digests plus the source projection mapping; it contains no job or network provenance. Any later operational job/network provenance and candidate-set-to-package linkage must remain separate private audit metadata and must not be inserted into package members.

## Anti-overclaim boundary

A candidate set is a private deterministic discovery and selection object:

**candidate set**

**≠ receipt**

**≠ proof**

**≠ portfolio statement**

**≠ track record**

**≠ authorization token**

It is also not a complete-wallet performance claim. Only a later, separately authorized package/publication flow can create or publish a receipt artifact.
