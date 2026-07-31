# Wallet Candidate Set v1: Limitations

Artifact v1.13 Slice 1 is intentionally narrow.

- It provides pure local contracts, canonical builders, validators, deterministic fixtures and a pure selection resolver only.
- It does not implement a live wallet-wide Helius adapter.
- It does not provide hosted storage, background jobs, authentication, an API or a UI.
- The evidence contract supports Solana mainnet-beta only and pins the mainnet-beta genesis hash.
- The product contract supports fixed permitted latest-state lookbacks only; the current pure schema does not embed the permitted-profile allowlist, so a future acquisition/hosted boundary must enforce it.
- It does not support an arbitrary historical end date or a non-null initial history cursor.
- Position and PnL accounting remain raw-quote only.
- It does not perform cross-quote valuation or USD normalization.
- Marks use only the frozen `direct_quote_mark_v1` profile and must be at or before the finalized snapshot boundary.
- Open and realized-partial candidates remain visible for disclosure but are not publication eligible.
- Limited partial-history candidates remain visible only and are not publication eligible.
- Only clean, verified, closed candidates can hand off to Slice 7.
- Token-local unsupported or ambiguous evidence, plus blocking `partial_history_boundary`, `external_transfer_gap`, `unobserved_inventory`, and `balance_boundary_mismatch` findings, can produce blocked summaries; unresolved wallet-wide impact produces no candidate set.
- No candidate-set provenance, evidence provenance, resolver provenance or network field is added to `receipt_package_v1` identity.
- Slice 1 performs no package publication, package-store commit, upload, signing or minting.
- Slice 1 performs no deployment and creates no hosted proof page.
- Candidate sets are not complete-wallet performance claims, portfolio statements, track records, receipts, proofs or authorization tokens.
- Content digests do not confer access rights.
- Plain-data validation currently bounds depth and total node count. Additional string-byte limits, extreme object-width limits, and lexical sensitive-value checks for generic wallet/transaction/blockhash/mint identity strings remain future hardening; the trusted acquisition boundary must enforce the privacy prohibition in the meantime.
- A later live acquisition adapter must still prove that acquisition began at latest state, used a null initial cursor, respected the finalized upper boundary, and reached or exhausted the permitted lower bound without caps, truncation or provider uncertainty.
- Hosted retention, deletion, authentication, random job handles and private storage policy remain undecided.
- Public transaction anchors and any later published proof can remain correlatable with public wallet activity.

These limitations are fail-closed product boundaries, not implied future authorization. Any expansion requires a separately scoped slice.
