# Trade Artifact

Deterministic, non-transferable trade receipt NFTs on Solana.

Artifact deterministically reconstructs supported trades from provider-attested on-chain evidence and exposes the evidence boundaries and limitations required to reproduce its result. Canonical receipt/package bytes remain deterministic, but wallet-history completeness is provider-attested rather than trustless.

## Demo

- Product demo: https://youtu.be/FV5FzwhXVco
- Pitch video: https://youtu.be/Jh0lhiqJYlU

Current status: local/devnet prototype. The UI/API and CLI mint flows are demonstrated in the videos.

## Quick Start

```bash
cd engine
npm install

# See available closed trades
node src/mint-one.mjs <wallet> --keypair <your-keypair.json> --list-only

# Mint one selected receipt to Solana devnet
node src/mint-one.mjs <wallet> --keypair <your-keypair.json> --pick <N> --network devnet
```

## Local UI / API

```bash
cd engine
node src/api/server.mjs --port 3000
```

Open:
http://localhost:3000/ui/

The UI supports wallet scanning, position browsing, closed/open position status, receipt generation, and verified/custom receipt views.

V1.3 also adds local read-only proof surfaces around committed v1.2 artifacts:
- `GET /api/inventory`
- `GET /api/inventory/summary`
- `GET /api/proof/:receiptHash`
- `GET /api/proof/:receiptHash/export`
- `node engine/src/proof-export/cli.mjs --receipt-hash <hash> --stdout|--output <path>`

These v1.3 proof surfaces are local-only and read-only. They do not add hosting, account login, wallet linking, upload, minting, signing, price fetching, USD normalization, or Helius balance-at integration.

V1.4 extends this into a local hosted-proof scaffold:
- `GET /api/proof/:receiptHash/hosted-preview`
- `node engine/src/proof-publish/cli.mjs --receipt-hash <hash>`
- `node engine/src/proof-publish/cli.mjs --receipt-hash <hash> --write`

These v1.4 surfaces remain local-only and preview-only. They do not add remote deployment, hosted delivery, account login, wallet linking, upload, minting, signing, price fetching, USD normalization, or Helius balance-at integration. See:
- `engine/docs/v1.4-release-notes.md`
- `engine/docs/v1.4-limitations.md`
- `engine/docs/v1.4-regression-checklist.md`


V1.5 adds local verifier/card/gallery proof browsing surfaces:
- `GET /api/verifier/:receiptHash`
- `GET /api/proof/:receiptHash/card`
- `GET /api/proof/:receiptHash/card/preview`
- `GET /api/gallery`
- `GET /api/gallery/preview`

These v1.5 surfaces remain local-only and read-only. They do not add hosted platform delivery, leaderboards, profiles, accounts, upload, minting, signing, price fetching, or USD normalization. See:
- `engine/docs/v1.5-release-notes.md`
- `engine/docs/v1.5-limitations.md`
- `engine/docs/v1.5-regression-checklist.md`
- `engine/docs/v1.5-demo-flow.md`

V1.6 adds a local Historical Verified Receipt Board for selected receipt entries:
- `GET /api/receipt-board`
- `GET /api/receipt-board/preview`
- `node engine/src/run-v16-regression.mjs`
- `node engine/src/check-v16-receipt-board-demo.mjs`

These v1.6 surfaces remain local-only and read-only. They do not add public hosting, live trading, prize competition behavior, profiles, accounts, upload, minting, signing, price fetching, USD normalization, PnL ranking, or trader/wallet skill claims.
V1.7 adds receipt-scoped Coverage Statements across local proof and receipt-board surfaces:
- `GET /api/proof/:receiptHash`
- `GET /api/verifier/:receiptHash`
- `GET /api/proof/:receiptHash/card`
- `GET /api/proof/:receiptHash/card/preview`
- `GET /api/proof/:receiptHash/export`
- `GET /api/proof/:receiptHash/hosted-preview`
- `GET /api/receipt-board`
- `GET /api/receipt-board/preview`
- `node engine/src/run-v17-regression.mjs`
- `node engine/src/check-v17-coverage-demo.mjs`

These v1.7 surfaces remain local-only and read-only. Coverage is receipt-scoped only, raw-quote only, and does not add public hosting, live trading, prize competition behavior, profiles, accounts, upload, minting, signing, USD normalization, PnL ranking, wallet coverage, portfolio coverage, track-record claims, or trader skill claims.

V1.8 adds deterministic same-mint multi-input swap normalization for local receipt generation:
- `node engine/src/run-v18-regression.mjs`
- `node engine/src/pipeline/same-mint-input-real-shape.test.mjs`

These v1.8 changes are normalization-only. They accept multiple wallet-side token inputs only when all inputs share the same mint and decimals and exactly one wallet-side output transfer exists. V1.8 does not add new swap shapes, mixed quotes, native+token support, USD normalization, board changes, accounts, profiles, upload, minting, signing, or public competition behavior.

V1.9 adds deterministic local receipt archive support for multi-run proof and receipt-board resolution:
- `node engine/src/inventory/archive-current-run.mjs`
- `node engine/src/run-v19-regression.mjs`
- `node engine/src/check-v19-archive-demo.mjs`

These v1.9 changes let verified receipts from separate local wallet runs coexist in a gitignored archive while default inventory remains current-snapshot-only. They do not add raw history retention, remote database storage, public hosting, accounts, profiles, upload, minting, signing, USD normalization, PnL ranking, or trader/wallet/portfolio/track-record claims.

V1.10 adds deterministic static public-demo bundle generation and deployment-readiness checks:
- `node engine/src/public-demo/cli.mjs --dry-run`
- `node engine/src/public-demo/cli.mjs --write --out engine/data/public-demo --visibility unlisted --wallet-display truncated`
- `node engine/src/public-demo/predeploy-check.mjs --root engine/data/public-demo`
- `node engine/src/run-v110-regression.mjs`

These v1.10 changes remain static and read-only. They do not deploy, connect GitHub, edit DNS, add a custom domain, add Cloudflare Functions, create accounts, run a database, connect wallets, upload, mint, sign, normalize to USD, or add mainnet behavior. See `engine/docs/v1.10-public-read-only-demo.md`.

V1.12 makes `receipt_package_v1` the authoritative immutable object for packaged receipts and carries that authority through package-first inventory, compatibility views, proof/verifier/board/Share Card/public-demo surfaces, targeted deterministic orchestration, and bounded Helius acquisition:
- `node engine/src/run-v112-regression.mjs`
- `engine/docs/v1.12-release-notes.md`
- `engine/docs/v1.12-limitations.md`
- `engine/docs/v1.12-operations.md`

The JUP and RAY golden packages pin exact package and member identities. One separately authorized controlled live RAY acquisition reproduced the retained normalized evidence, published receipt hash, and complete five-member package in Slice 7 dry-run. V1.12 does not add hosted reconstruction, wallet-wide target discovery, production package writes from a hosted worker, deployment, upload, mainnet minting, or signing. The devnet mint pipeline remains separate, and the deterministic v1.12 regression runner performs no live Helius call.

V1.13 Slice 1 adds pure, private-by-default wallet candidate evidence, candidate-set projection, and two-digest selection contracts without adding live wallet-wide acquisition or hosted/product capabilities:
- `engine/docs/wallet-candidate-set-v1.md`
- `engine/docs/wallet-candidate-set-v1-evidence.md`
- `engine/docs/wallet-candidate-set-v1-privacy.md`
- `engine/docs/wallet-candidate-set-v1-limitations.md`
- `engine/docs/wallet-candidate-set-v1-selection.md`
- `node engine/src/run-v113-regression.mjs`

The v1.13 evidence taxonomy has exactly two disposition-backed finding types: `unsupported_activity` and `ambiguous_activity`. `buildCandidateEvidenceBundleV1()` is the sole exported production constructor for `candidate_evidence_bundle_v1`, and wallet-wide uncertainty prevents issuance through every supported construction path. Token findings distinguish affected position tokens from disjoint contextual quote mints; common quotes such as USDC do not suppress unrelated candidates. Partial history, unobserved inventory and external-transfer uncertainty are candidate evidence limitations expressed through ledger status, flags, limitations, reason codes and disclosures; balance-boundary mismatch remains future work; mark limitations are valuation states. Limited partial-history candidates remain visible-only with `economics_status: unavailable_partial_history`, null economics/snapshot values and unavailable valuation rather than numeric-zero placeholders. The identity-bound `direct_quote_mark_v1` profile commits to `mark_max_age_seconds: 300`; ages 0 through 300 seconds are usable when all slot, timestamp, mint, quote and positive-price checks pass, while age 301 and all future/mismatched/unavailable states produce null unrealized valuation. Every validated v1.14 acquisition result requires canonical normalized-event order and exact dense wallet-wide `raw_index` values, while downstream evidence construction canonicalizes the collections it owns; an initially null acquisition mark profile may be enriched, after which completed evidence commits to the mark profile and 300-second policy. Structural candidate-set validation is distinct from authoritative evidence-bound reconstruction. The pure lookback schema proves its configured lower boundary but does not yet enforce exact duration subtraction.

The v1.13 runner uses direct deterministic Node commands and a safe v1.12 compatibility gate; it does not invoke npm, the old commit-bearing v1.12 wrapper, live providers, package-store commits, production publication, upload, signing, minting, or deployment. Its targeted Slice 7 gate uses an anchored, code-unit-escaped alternation of exactly three complete test names, parses TAP fail-closed, and requires all three selected tests to pass with none selected as skipped. Some maintained compatibility tests exercise local APIs and temporary non-package fixture/write roots only.

V1.14 adds **Wallet-Wide Bounded Acquisition v1**, a read-only deterministic boundary from one wallet and a permitted fixed lookback through the existing candidate and package pipeline:
- finalized Solana `getSignaturesForAddress` history is the completeness index;
- exact Helius Enhanced Transactions enrich the canonical signature set but are not the completeness authority;
- every in-window source receives exactly one of `supported_normalized_event`, `unsupported_activity`, `ambiguous_activity`, `unrelated_activity`, or `failed_transaction`;
- exact retained Helius bodies replay through acquisition, evidence, candidate construction, digest-only selection, and the existing Slice 7 package dry run; and
- `node engine/src/run-v114-regression.mjs` runs the safety-adapted v1.13 baseline, every wallet-acquisition test, syntax checks, and runner/documentation safety checks with direct Node execution only.

The retained-provider and acquisition-to-candidate integration gates preserve the pinned JUP and RAY receipt, package, and five-member identities. The tracked tree intentionally contains the five exact retained Helius fixture bodies used for deterministic replay. Controlled-live raw responses are not retained, and no exact retained finalized RPC transcript exists; finalized RPC pages are synthetic, and other provider-shaped negative/coverage fixtures are labeled synthetic. This is provider-attested completeness, not a trustless proof against malicious or jointly inconsistent providers. V1.14 remains mainnet-beta, fixed-lookback, raw-quote, one-supported-event-per-transaction, and fail-closed on safe-budget exhaustion. It adds no hosted beta, API, UI, jobs, persistence, publication, package-store commit, upload, signing, minting, deployment, live marks, or fund custody/control.

Three controlled validations are distinct: the first pre-hardening run, the distinct later post-hardening run, and the final post-remediation controlled live validation. The final post-remediation controlled live validation **PASS**ed for one approved public Solana mainnet-beta wallet using `lookback_7d_v1`. It examined two pages, terminated with `historical_bound_reached`, observed 76 canonical signatures, reconciled five in-window and five Enhanced transactions, and retained the 1 supported, 0 unsupported, 1 ambiguous, 3 unrelated, and 0 failed partition. The final hardening changed no aggregate classifications relative to the previous run. Zero candidates was a valid result, not a validation failure; live candidate resolution and Slice 7 were not exercised. The live release gate is complete, no further live rerun is required before tagging v1.14.0, and v1.14.0 is not yet tagged. See `engine/docs/v1.14-release-notes.md`, `engine/docs/v1.14-wallet-wide-acquisition.md`, `engine/docs/v1.14-operations.md`, and `engine/docs/v1.14-limitations.md`.

## Legacy/full-pipeline capabilities

The following describes the repository's pre-existing full pipeline, not the v1.14 read-only wallet-acquisition boundary or the pure v1.13 candidate-set layer. V1.14's deterministic runner does not call a live provider, sign, upload, mint, deploy, or expose those capabilities. The separately documented future hosted beta has not been implemented or validated live.

1. Pulls your trade history from Solana (via Helius)
2. Reconstructs trade cycles (buy -> sell loops)
3. Computes PnL with weighted average cost basis
4. Generates a deterministic **verification hash** (SHA-256 fingerprint of the trade data)
5. Signs a **claim** with your wallet key (Ed25519 proof of authorization)
6. Uploads receipts + visual cards to **Arweave** (permanent storage via Irys)
7. Mints a **soul-bound NFT** on Solana (Token-2022, non-transferable)

The on-chain PDA stores the verification hash, metadata hash, claim signature, and wallet binding. Verification levels range from offline hash checks to provider-attested reconstruction from on-chain transaction evidence; the latter depends on provider completeness.

## Architecture

```
trade-artifact/
|-- programs/trade_artifact/   <- Anchor on-chain program (Solana)
|   `-- src/
|       |-- lib.rs
|       |-- state.rs           <- ReceiptAnchor PDA struct
|       |-- errors.rs
|       `-- instructions/
|           `-- mint_receipt.rs <- Mint instruction (Ed25519 + Token-2022)
|
`-- engine/                    <- Off-chain pipeline (Node.js ESM)
    |-- src/
    |   |-- run-pipeline.mjs   <- Main pipeline (Phases 1-8)
    |   |-- ingest/            <- Helius transaction fetcher
    |   |-- normalize/         <- Swap event extraction
    |   |-- reconstruct/       <- Trade cycle builder
    |   |-- pnl/               <- PnL engine (WACB)
    |   |-- receipts/          <- Receipt + hash generator
    |   |-- render/            <- PNG receipt card renderer
    |   |-- claims/            <- Ed25519 claim signer + verifier
    |   |-- arweave/           <- Irys/Arweave uploader
    |   |-- mint/              <- On-chain mint submitter + post-mint verifier
    |   `-- verify/            <- Third-party verifier CLI
    |-- docs/                  <- Specifications
    `-- data/                  <- Pipeline output (gitignored)
```

## Prerequisites

- **Node.js** >= 18 (ESM support required)
- **Solana CLI** (`solana-keygen`, `solana` for keypair management)
- **Helius API key** - free tier at [helius.dev](https://helius.dev)
- **Solana keypair** - JSON file (e.g. from `solana-keygen new`)
- **Anchor** + **Rust** - only needed if modifying the on-chain program

## Setup

```bash
# Clone
git clone https://github.com/JCF0/trade-artifact-engine.git
cd trade-artifact-engine/engine

# Install dependencies
npm install

# Set Helius API key

# Windows: create/edit %USERPROFILE%\.openclaw\.env
echo HELIUS_API_KEY=your_key_here >> %USERPROFILE%\.openclaw\.env

# Linux/macOS: export directly
export HELIUS_API_KEY=your_key_here
```

### Dependencies

| Package | Purpose |
|---|---|
| `@solana/web3.js` | Solana RPC, transaction building, keypair handling |
| `tweetnacl` | Ed25519 signing/verification |
| `bs58` | Base58 encoding (Solana addresses, signatures) |
| `canvas` | Server-side PNG rendering |
| `@irys/upload` | Arweave/Irys upload client |
| `@irys/upload-solana` | Solana wallet adapter for Irys |

## Usage

### Single Receipt Flow (Recommended)

The simplest way to mint a verified trade receipt:

```bash
# Step 1: See what closed trades are available
node src/mint-one.mjs <wallet> --keypair <your-keypair.json> --list-only

# Step 2: Pick one and mint (auto-selects best if you omit --pick)
node src/mint-one.mjs <wallet> --keypair <your-keypair.json> --pick 4

# Dry-run first (simulate, no on-chain submission)
node src/mint-one.mjs <wallet> --keypair <your-keypair.json> --pick 4 --dry-run

# Skip Arweave upload (use dummy metadata, useful for testing)
node src/mint-one.mjs <wallet> --keypair <your-keypair.json> --pick 4 --skip-upload
```

`mint-one` runs the full pipeline (ingest -> normalize -> reconstruct -> PnL -> receipt -> render -> claim -> upload -> mint) for a single selected receipt. The keypair must belong to the wallet that executed the trades.

**Options:**
- `--pick <N>` - select receipt #N from the list (1-indexed). Omit to auto-select (prefers `verified` status, then highest |PnL%|).
- `--max-txns <N>` - transaction fetch cap (default: 5000)
- `--network <devnet|mainnet>` - Solana network (default: devnet)
- `--recipient <pubkey>` - mint to a different wallet (default: signer)
- `--dry-run` - simulate the mint transaction only
- `--list-only` - list available receipts and exit (no signing/upload/mint)
- `--skip-upload` - use dummy metadata URI (skip Arweave)

### Example Output

A real end-to-end run from mainnet trades to a devnet NFT:

**Command:**
```bash
node src/mint-one.mjs <wallet> --keypair <keypair.json> --pick 1
```

**Detected trade:**
- Pair: JUP / SOL
- PnL: -0.05%
- Cycle: 1 closed trade (buy -> sell)

**Arweave uploads:**
- Image: https://gateway.irys.xyz/AnUrEt5eSpqeFjgADxHsfXJzUpB1Ddybpv1tkcjAgaou
- Receipt JSON: https://gateway.irys.xyz/4e5SfsipWPFVHG5BMvnMdjG7onWkRMCD3Dmx84uyDSSK
- Metadata: https://gateway.irys.xyz/EM6cMrU5cstEVG7vb1HSSm825ZrABaNLoKj9uTxgArvg

**Mint (devnet):**
- TX: https://explorer.solana.com/tx/2m4dUV7MYuLb6YqTWAurjgMYtvAEYWX21ZZ2Wn2erPQta2XKrBhv2x8cCnM6ZNceShuPn8NTMwbbBAdFR7TJdR6Q?cluster=devnet
- NFT Mint: Abpyva23vfmpRVvLtY3QontNqhHWKCigi1srbPrgsskT

This NFT represents a deterministic receipt over provider-attested trade evidence. A verifier can:
- recompute the verification hash
- validate the claim signature
- confirm on-chain state
- reproduce the supported trade result from the same provider-attested raw transactions

### Full Pipeline (Phases 1-8, Batch)

```bash
# Basic: ingest + normalize + reconstruct + PnL + receipts + render
node src/run-pipeline.mjs <wallet_address> [maxTxns]

# With claim signing + Arweave upload (all receipts)
node src/run-pipeline.mjs <wallet_address> [maxTxns] --keypair <path_to_keypair.json> [--recipient <pubkey>]
```

### Manual Batch Flow

For most users, `mint-one` is recommended. The lower-level batch flow is useful for debugging or minting multiple receipts.

```bash
# 1. Run pipeline for a wallet, capped at 5000 transactions
node src/run-pipeline.mjs <wallet> 5000

# Expected output:
#   Phase 1: Ingest     -> transactions fetched
#   Phase 2: Normalize  -> swap events extracted
#   Phase 3: Reconstruct -> open/closed/partial cycles
#   Phase 4: PnL        -> closed cycles with PnL
#   Phase 5: Receipts   -> receipts generated
#   Phase 6: Render     -> PNG cards rendered

# 2. Inspect receipts and verify hashes
node src/inspect-receipts.mjs

# 3. Sign claims (requires the wallet's keypair)
# The keypair must match the wallet whose trades are being receipted.
node src/claims/claim-signer.mjs ./my-keypair.json

# 4. Upload to Arweave/Irys (devnet = free)
node src/arweave/arweave-upload.mjs ./my-keypair.json --network devnet

# 5. Mint on-chain NFTs
node src/mint/mint-submitter.mjs ./my-keypair.json data/claims/claims.jsonl --network devnet

# 6. Verify mints on-chain
node src/mint/verify-mints.mjs data/mints/mint_results.jsonl --network devnet
```

### Third-Party Verification

```bash
# Verify a receipt file (offline - hash + PnL + dust checks only)
node src/verify/verify-receipt.mjs data/receipts/receipts.jsonl --skip-onchain

# Full verification (hash + on-chain PDA + claim signature + metadata)
node src/verify/verify-receipt.mjs receipt.json --network devnet --metadata-uri https://gateway.irys.xyz/abc123
```

## Expected Output Files

After a full pipeline run, `engine/data/` contains:

```
data/
|-- raw/
|   |-- helius_raw_response.jsonl    <- Full API responses (never modified)
|   `-- helius_transactions.jsonl    <- Individual transactions
|-- normalized/
|   `-- events.jsonl                 <- Structured swap events
|-- cycles/
|   `-- trade_cycles.jsonl           <- Trade cycles (open/closed/partial)
|-- pnl/
|   `-- pnl_cycles.jsonl             <- Cycles enriched with PnL
|-- receipts/
|   `-- receipts.jsonl               <- Final receipts with verification hashes
|-- renders/
|   `-- receipt_0001_TOKEN.png       <- Visual receipt cards
|-- claims/
|   `-- claims.jsonl                 <- Ed25519 signed claims
|-- arweave/
|   `-- uploads.jsonl                <- Irys upload records (append-only)
`-- mints/
    `-- mint_results.jsonl           <- Mint transaction results (append-only)
```

## On-Chain Program

**Program ID:** `HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ` (devnet)

### PDA Layout (ReceiptAnchor, 243 bytes)

| Field | Size | Description |
|---|---|---|
| Discriminator | 8 | Anchor account discriminator |
| verification_hash | 32 | SHA-256 of canonical receipt fields |
| metadata_hash | 32 | SHA-256 of Arweave metadata JSON |
| trader_wallet | 32 | Wallet that executed the trades |
| claim_recipient | 32 | Authorized NFT recipient |
| claim_signature | 64 | Ed25519 claim signature |
| status | 1 | 0=verified, 1=verified_mixed_quote |
| program_version | 1 | Always 1 for V1 |
| mint | 32 | Token-2022 NFT mint address |
| minted_at | 8 | Unix timestamp (i64) |
| bump | 1 | PDA bump seed |

### PDA Seeds

- Receipt: `["receipt", verification_hash_bytes]`
- Mint: `["mint", verification_hash_bytes]`

### NFT Properties

- **Token-2022** with extensions: NonTransferable + MetadataPointer + TokenMetadata
- **Non-transferable / soul-bound:** Cannot be transferred after minting
- **Supply:** 1, Decimals: 0
- **Mint authority:** Removed after minting
- **Cost:** ~0.0065 SOL per mint

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `HELIUS_API_KEY` | Yes | Helius API key for transaction fetching |

The engine loads `.env` from `%USERPROFILE%\.openclaw\.env` automatically. You can also export it directly.

## Verification Levels

The following checks provide increasing assurance, with L5 remaining provider-attested rather than trustless:

| Level | What | Requires |
|---|---|---|
| **L1** | Receipt hash integrity + PnL arithmetic | Receipt JSON only (offline) |
| **L2** | On-chain PDA exists, fields match, NFT supply=1 | Solana RPC |
| **L3** | Ed25519 claim signature valid | On-chain PDA data |
| **L4** | Metadata content matches on-chain hash | Arweave gateway |
| **L5** | Reproduce from provider-attested raw transactions | Helius API (re-run pipeline) |

See [docs/verifier_flow.md](engine/docs/verifier_flow.md) for detailed steps.

## Specifications

| Document | Description |
|---|---|
| [claim_spec.md](engine/docs/claim_spec.md) | Claim message format, signing, verification |
| [receipt_spec.md](engine/docs/receipt_spec.md) | Receipt schema, verification hash derivation |
| [metadata_spec.md](engine/docs/metadata_spec.md) | NFT metadata, Arweave structure, metadata_hash |
| [pipeline_spec.md](engine/docs/pipeline_spec.md) | All 9 pipeline stages, inputs/outputs, persistence |
| [verifier_flow.md](engine/docs/verifier_flow.md) | Third-party verification guide (5 levels) |
| [mint-architecture-v1.md](engine/docs/mint-architecture-v1.md) | On-chain architecture (frozen) |

## Known Limitations

- **Mixed-quote trades:** When buys and sells use different quote currencies, the prototype normalizes quotes before displaying PnL. These receipts are marked with normalization metadata and should be treated as estimated when historical trade-time pricing is unavailable.
- **Transaction fees:** SOL base fees and priority fees are not deducted from cost basis. Negligible for typical trades (~0.000005 SOL).
- **Ambiguous swaps:** Multi-hop Jupiter routes with >1 sent or received token transfer are skipped during normalization (~1-2% of swap transactions).
- **Partial history:** Sells without matching buys in the observation window (pre-existing positions) are excluded from receipts.
- **Transaction cap:** Helius API pagination may miss older history for very active wallets (>10K transactions).
- **Windows compatibility:** Anchor builds require WSL due to Device Guard restrictions on `cargo-build-sbf.exe`.

## License

ISC
