# Wallet Candidate Set v1: Deterministic Selection

## Browser request

The browser submits exactly two fields:

```json
{
  "candidate_set_digest": "<64 lowercase hex characters>",
  "candidate_digest": "<64 lowercase hex characters>"
}
```

No wallet, token, segment, economics, status, package mode, profile, expected receipt hash or evidence handle is accepted from the browser selection object.

Loading the candidate set and evidence bundle, resolving an authenticated random job handle, and authorizing the requesting user are outside the pure resolver. A hosted caller must complete those steps before calling it.

## Exact set and evidence checks

The resolver:

1. recomputes the candidate-set digest and requires equality with the submitted set digest;
2. enforces Solana mainnet-beta and the frozen genesis hash;
3. recomputes and validates the private evidence-bundle digest;
4. requires exactly one candidate-set member with the submitted candidate digest;
5. recomputes that member's candidate-local identity;
6. requires a clean, selectable, package-eligible closed position;
7. verifies every candidate-set commitment against the supplied evidence bundle; and
8. reconstructs the entire candidate set from evidence before returning.

Missing, duplicated, forged, replayed into another set, visible-only or publication-ineligible candidates fail closed.

Limited partial-history candidates are authentic visible members but are never selectable. They carry `economics_status: unavailable_partial_history`, null authoritative economics and snapshot values, `valuation_status: unavailable`, and explicit history/inventory reason and disclosure codes; a supplied current mark does not make unknown basis or PnL available.

## Receipt-scoped event projection

Selection projects every normalized event that affects the target token and excludes unrelated wallet events. The source event record and its unique supported transaction disposition are independently recomputed and mapped.

Target-local order is exact:

`timestamp`

`→ transaction signature by JavaScript code-unit comparison`

`→ source slot`

`→ event digest`

The projected Slice 7 events receive dense target-local `raw_index` values `0..n-1`. Source wallet-wide indexes are not trusted or forwarded as target-local indexes.

## Private evidence mapping

For each projected event the resolver retains a private mapping of:

- projected raw index;
- source event digest; and
- source disposition digest.

The mapping is returned only under private resolver audit provenance. It is not included in the Slice 7 request, canonical receipt or package identity.

## Reconstruction and legacy compatibility

Before handoff, the resolver rebuilds receipt-scoped evidence, regenerates the existing position ledger, and regenerates receipt candidates with the frozen weighted-average accounting profile. It locates exactly one candidate by wallet, token mint, receipt type and segment index.

The regenerated legacy `candidate_hash` must equal the candidate's committed `ledger_candidate_hash`. The structural `validateCandidateSetV1()` check proves schema and self-consistency only. The resolver additionally invokes `validateWalletCandidateSetV1AgainstEvidenceBundle()`, which reconstructs every candidate, blocked summary, count, finding, scope and evidence commitment from the evidence bundle. Self-consistent but forged projections are therefore rejected at the authoritative evidence-bound boundary.

## Exact Slice 7 dry-run request

A successful resolution derives exactly:

```text
normalizedEvents: receipt-scoped, ordered, densely reindexed events
inputStatus:
  acquisition_complete: true
  normalization_complete: true
  pagination_complete: true
  truncated: false
  capped: false
  partial: false
  provider_uncertain: false
target:
  wallet: selected wallet
  token_mint: selected token mint
  receipt_type: closed_position
  segment_index: selected segment
profiles: frozen receipt-package profiles plus the bound accounting profile
mode: dry_run
```

`expected_receipt_hash` is deliberately absent on first creation. Selection commits to the candidate and evidence that derive the receipt; it does not ask the browser to predict or override the new receipt hash.

## No side effects or lifecycle promotion

The resolver does not promote a ledger candidate, mark it verified, invoke package commit mode, touch a package store, publish a package, upload content, sign a claim, mint an asset, or deploy a page. It only returns a deeply immutable dry-run request and separate private audit data.

Slice 7 performs its existing canonical regeneration and package validation in memory. Any later durable commit or publication is a distinct authorized capability.

## JUP/RAY invariance

The deterministic JUP and RAY fixtures pass through candidate evidence, candidate-set construction, two-digest selection and Slice 7 dry-run without changing their established v1.12 identities. The exact canonical receipt hashes, package digests and all five package member hashes remain pinned.

This invariance demonstrates that candidate discovery and private selection are an upstream projection and resolver layer. They do not add candidate-set or network provenance to `receipt_package_v1`, and they do not alter existing package bytes.

## Exact targeted regression gate

The v1.13 runner derives one anchored regular expression from these three complete test names:

- `JUP-like closed position builds the pinned deterministic package without mutating input`;
- `RAY-like evidence reproduces pinned receipt and package bytes`; and
- `dry-run never touches an injected package store`.

Every UTF-16 code unit is escaped literally before alternation. TAP output is parsed and reconciled fail-closed; exactly three selected tests must be present and pass, no selected test may skip, no similarly named test may match, and malformed or inconsistent TAP fails the gate. The complete targeted-orchestrator file is never run unfiltered by this runner.
