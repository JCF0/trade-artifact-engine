# Wallet Candidate Set v1: Limitations

Artifact v1.13 Slice 1 is intentionally narrow.

- It provides pure local contracts, canonical builders, validators, deterministic fixtures and a pure selection resolver only.
- Artifact v1.14 adds an upstream read-only wallet-wide adapter for finalized Solana RPC enumeration plus exact Helius Enhanced enrichment; the candidate-set layer remains provider-neutral and pure.
- It does not provide hosted storage, background jobs, authentication, an API or a UI.
- The evidence contract supports Solana mainnet-beta only and pins the mainnet-beta genesis hash.
- The product contract supports fixed permitted latest-state lookbacks only. The v1.14 acquisition request allowlists 7d, 30d, 90d, and 180d; a future hosted policy may expose a narrower subset.
- The v1.14 acquisition boundary derives `oldest_allowed_timestamp = anchor_block_time - requested_lookback_seconds`; the downstream pure evidence schema validates the completed window rather than independently re-running request-policy checks.
- It does not support an arbitrary historical end date or a non-null initial history cursor.
- Position and PnL accounting remain raw-quote only.
- It does not perform cross-quote valuation or USD normalization.
- Marks use only the identity-bound `direct_quote_mark_v1` profile with `mark_max_age_seconds: 300`. A usable mark must match token and quote, have a positive finite price, be at or before the finalized slot/time boundary, and be no more than 300 seconds old; stale, future, unavailable and mismatched marks have null unrealized values.
- An acquisition result may declare a null mark profile and later be enriched during authoritative evidence construction; when marks are present, the completed evidence identity commits to `direct_quote_mark_v1` and 300 seconds.
- Open and realized-partial candidates remain visible for disclosure but are not publication eligible.
- Limited partial-history candidates remain visible only and are not publication eligible. They use `economics_status: unavailable_partial_history`, null economics/snapshot values and unavailable valuation; supplied marks never produce PnL when cost basis is unknown.
- Only clean, verified, closed candidates can hand off to Slice 7.
- Disposition-backed findings are limited to token-local or wallet-wide `unsupported_activity` and `ambiguous_activity`. Affected token and quote arrays are unique, deterministic and disjoint; quote context does not block unrelated positions. Only token-local affected position tokens produce blocked summaries, while unresolved wallet-wide impact prevents evidence-bundle issuance and candidate-set construction through every supported production path.
- Partial history and unobserved inventory are candidate evidence limitations, not activity findings. External-transfer uncertainty is a candidate limitation/reason code. Mark limitations are valuation states. Balance-boundary mismatch is future historical-balance work and is not implemented in v1.13.
- No candidate-set provenance, evidence provenance, resolver provenance or network field is added to `receipt_package_v1` identity.
- Slice 1 performs no package publication, package-store commit, upload, signing or minting.
- Slice 1 performs no deployment and creates no hosted proof page.
- `buildCandidateEvidenceBundleV1()` is the sole exported production evidence-envelope constructor. `validateCandidateSetV1()` is structural/self-consistency validation; authoritative economics validation requires `validateWalletCandidateSetV1AgainstEvidenceBundle()`.
- Acquisition-result collections may be noncanonical on input and are canonicalized during authoritative evidence construction.
- Candidate sets are not complete-wallet performance claims, portfolio statements, track records, receipts, proofs or authorization tokens.
- Content digests do not confer access rights.
- Plain-data validation currently bounds depth and total node count. Additional string-byte limits, extreme object-width limits, and lexical sensitive-value checks for generic wallet/transaction/blockhash/mint identity strings remain future hardening; the trusted acquisition boundary must enforce the privacy prohibition in the meantime.
- The v1.14 adapter proves latest-state acquisition from a null initial cursor, a finalized coherent upper boundary, and lower-bound sentinel or provider exhaustion. Caps, truncation, stale-head evidence, timeout, protocol mismatch, or provider uncertainty produce no acquisition result. One separately authorized bounded provider-attested controlled live run passed under the then-current implementation for one mainnet-beta wallet with `lookback_7d_v1`: two pages, 76 canonical signatures, five in-window/Enhanced-reconciled transactions, one supported, one ambiguous, three unrelated, and zero candidates/selectable candidates. Zero candidates was valid; no live candidate resolution or Slice 7 invocation occurred, and no cap, timeout, truncation, partial state, provider uncertainty, package write, publication, signing, upload, mint, or deployment occurred. It predates final exhaustive `accountData` reconciliation hardening, so a fresh controlled validation is required after this patch before tagging. v1.14 has not been tagged.
- Hosted retention, deletion, authentication, random job handles and private storage policy remain undecided.
- Public transaction anchors and any later published proof can remain correlatable with public wallet activity.
- The regression runner's targeted Slice 7 gate uses anchored, code-unit-escaped full-name selection for exactly three tests and fails unless all three selected tests pass without a selected skip and TAP counts reconcile.
- The current transitive production closure has no active provider, network, filesystem, storage, timer, randomness, publication, signing, minting or deployment capability. It does contain inert Helius/Irys endpoint strings through a shared constants dependency. The static audit verifies the present closure and common direct capability forms, not every conceivable future JavaScript indirection.

These limitations are fail-closed product boundaries, not implied future authorization. Any expansion requires a separately scoped slice.
