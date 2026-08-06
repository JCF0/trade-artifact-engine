# Wallet Candidate Set v1: Privacy Boundary

## Private by default

Wallet candidate discovery is private by default. Future candidate jobs and their results must require authenticated access and must not become public merely because their content is deterministic or content-addressed.

Slice 1 is a pure local contract; it does not yet implement hosted jobs, authentication, storage, an API or a browser UI.

## Evidence stays server-side

`candidate_evidence_bundle_v1` is the replay authority and remains server-side in a later hosted architecture. It contains transaction anchors, normalized event records, findings, marks and integrity indexes needed to reconstruct and audit candidate projections.

`buildCandidateEvidenceBundleV1()` is the only exported production constructor that can issue this envelope. It rejects wallet-wide uncertainty before issuance. Token-local findings keep affected position tokens separate and disjoint from contextual quote mints, so a common quote does not expose or suppress unrelated position candidates merely by being shared.

The browser-facing `wallet_candidate_set_v1` is a smaller projection, but it is not finding-free: it copies the complete structured `activity_findings` array, including source transaction and source event digest anchors, together with candidate projections and blocked summaries. It omits the normalized event-record arrays themselves, transaction-disposition arrays, mark-observation arrays, and the private source-event-to-disposition projection mapping. Visible economics and status fields are candidate projections, not authorization to retrieve the underlying evidence.

## Digests are not access rights

`evidence_bundle_digest`, `candidate_set_digest`, `candidate_digest` and related content digests prove or select exact content. They are not bearer credentials, capability URLs, authenticated job handles, ownership proofs, wallet signatures or access-control decisions.

A later hosted slice will require authenticated random job handles and server-side authorization before loading a private candidate set or evidence bundle. The two browser-submitted content digests cannot replace that control plane.

## Identity-bearing data exclusions

The Slice 1 contract prohibits raw provider bodies, provider URLs, API credentials, authorization headers, keypairs, filesystem paths, process identifiers, hosted job IDs, random job handles, database keys, storage roots or handles, staging names, upload state, signing state and mint state from entering identity-bearing objects.

The current authoritative acquisition-result, evidence-bundle, and candidate-set schemas enforce exact object shapes and native Solana identity grammar: transaction signatures and `tx_hash` values are Base58 values decoding to exactly 64 bytes, while wallets, mints, token accounts, ordinary accounts, program IDs, fee payers, and blockhashes are Base58 values decoding to exactly 32 bytes. These construction-boundary checks validate grammar and byte width; they do not prove provider provenance, account ownership, semantic correctness, or trustless historical completeness. Content addressing does not convert provider-attested evidence into trustless evidence.

Findings use bounded reason and disclosure codes rather than provider error prose. Errors expose stable sanitized codes and do not preserve raw causes. Subject to the provider-attested evidence boundary above, content identity remains portable across machines, providers and future storage implementations.

The disposition-backed finding taxonomy contains only unsupported and ambiguous activity. Partial history, unobserved inventory and external-transfer uncertainty remain candidate-level status/flag/limitation/reason disclosures; mark limitations remain valuation states. Limited candidates expose no numeric placeholder economics or mark-derived valuation: their authoritative economics and snapshot values are null.

## Resolver audit provenance

The pure selection resolver returns two separate structures:

- the exact Slice 7 dry-run request; and
- private audit provenance containing candidate-set, evidence, candidate, receipt-scoped evidence and legacy ledger-candidate digests plus the source projection mapping.

Resolver audit provenance remains separate from the Slice 7 request. It does not enter normalized events, the targeted request, canonical receipt fields or `receipt_package_v1` members.

Candidate-set-to-package linkage is private audit provenance. A hosted service may retain an authorized mapping from a private candidate selection to the resulting package identity, but that mapping is not package authority and is not public by default.

## Correlation limits

Privacy does not imply unlinkability. Source transaction signatures, slots and wallet/token identity inside private evidence are naturally correlatable with the public Solana ledger. If a receipt is later published, its transaction anchors and proof page may remain correlatable with the wallet, candidate evidence and other public chain activity.

A digest can also confirm equality when a party already possesses the underlying object. The design prevents operational metadata from contaminating identity; it does not promise anonymity against public-chain analysis.

## Retention and deletion

Slice 1 defines no hosted retention period, deletion workflow, backup policy, legal hold, export policy or erasure guarantee. Those are later hosted-product decisions and must be specified before evidence bundles or candidate jobs are persisted.

Until then, the safe architecture is private-by-default, server-side evidence, minimal browser projection, separate authorization, and no publication side effect in candidate construction or selection.
