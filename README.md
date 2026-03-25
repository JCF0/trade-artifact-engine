# Trade Artifact

Cryptographically verifiable, soul-bound trade receipt NFTs on Solana.

Turn your wallet's trade history into permanent, tamper-proof PnL receipts that anyone can independently verify — without trusting you, the issuer, or any third party.

## Quick Start

```
node src/run-pipeline.mjs <wallet> 3000
node src/mint/mint-submitter.mjs <keypair> data/claims/claims.jsonl --network devnet
node src/mint/verify-mints.mjs data/mints/mint_results.jsonl --network devnet
```

## What It Does

1. Pulls your trade history from Solana (via Helius)
2. Reconstructs trade cycles (buy → sell loops)
3. Computes PnL with weighted average cost basis
4. Generates a deterministic **verification hash** (SHA-256 fingerprint of the trade data)
5. Signs a **claim** with your wallet key (Ed25519 proof of authorization)
6. Uploads receipts + visual cards to **Arweave** (permanent storage via Irys)
7. Mints a **soul-bound NFT** on Solana (Token-2022, non-transferable)

The on-chain PDA stores the verification hash, metadata hash, claim signature, and wallet binding. Anyone can verify the receipt at 5 levels of assurance — from instant offline hash checks to full re-derivation from on-chain transactions.

## Architecture

```
trade-artifact/
├── programs/trade_artifact/   ← Anchor on-chain program (Solana)
│   └── src/
│       ├── lib.rs
│       ├── state.rs           ← ReceiptAnchor PDA struct
│       ├── errors.rs
│       └── instructions/
│           └── mint_receipt.rs ← Mint instruction (Ed25519 + Token-2022)
│
└── engine/                    ← Off-chain pipeline (Node.js ESM)
    ├── src/
    │   ├── run-pipeline.mjs   ← Main pipeline (Phases 1–8)
    │   ├── ingest/            ← Helius transaction fetcher
    │   ├── normalize/         ← Swap event extraction
    │   ├── reconstruct/       ← Trade cycle builder
    │   ├── pnl/               ← PnL engine (WACB)
    │   ├── receipts/          ← Receipt + hash generator
    │   ├── render/            ← PNG receipt card renderer
    │   ├── claims/            ← Ed25519 claim signer + verifier
    │   ├── arweave/           ← Irys/Arweave uploader
    │   ├── mint/              ← On-chain mint submitter + post-mint verifier
    │   └── verify/            ← Third-party verifier CLI
    ├── docs/                  ← Specifications
    └── data/                  ← Pipeline output (gitignored)
```

## Prerequisites

- **Node.js** ≥ 18 (ESM support required)
- **Solana CLI** (`solana-keygen`, `solana` for keypair management)
- **Helius API key** — free tier at [helius.dev](https://helius.dev)
- **Solana keypair** — JSON file (e.g. from `solana-keygen new`)
- **Anchor** + **Rust** — only needed if modifying the on-chain program

## Setup

```bash
# Clone
git clone https://github.com/YourRepo/trade-artifact.git
cd trade-artifact/engine

# Install dependencies
npm install

# Set Helius API key
# Create/edit %USERPROFILE%\.openclaw\.env (or export directly)
echo HELIUS_API_KEY=your_key_here >> %USERPROFILE%\.openclaw\.env

# Or export directly (Linux/macOS)
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

`mint-one` runs the full pipeline (ingest → normalize → reconstruct → PnL → receipt → render → claim → upload → mint) for a single selected receipt. The keypair must belong to the wallet that executed the trades.

**Options:**
- `--pick <N>` — select receipt #N from the list (1-indexed). Omit to auto-select (prefers `verified` status, then highest |PnL%|).
- `--max-txns <N>` — transaction fetch cap (default: 5000)
- `--network <devnet|mainnet>` — Solana network (default: devnet)
- `--recipient <pubkey>` — mint to a different wallet (default: signer)
- `--dry-run` — simulate the mint transaction only
- `--list-only` — list available receipts and exit (no signing/upload/mint)
- `--skip-upload` — use dummy metadata URI (skip Arweave)

### Example Output

A real end-to-end run from mainnet trades to a devnet NFT:

**Command:**
```bash
node src/mint-one.mjs <wallet> --keypair <keypair.json> --pick 1

**Detected trade:**
- Pair: JUP / SOL
- PnL: −0.05%
- Cycle: 1 closed trade (buy → sell)

**Arweave uploads:**
- Image: https://gateway.irys.xyz/AnUrEt5eSpqeFjgADxHsfXJzUpB1Ddybpv1tkcjAgaou
- Receipt JSON: https://gateway.irys.xyz/4e5SfsipWPFVHG5BMvnMdjG7onWkRMCD3Dmx84uyDSSK
- Metadata: https://gateway.irys.xyz/EM6cMrU5cstEVG7vb1HSSm825ZrABaNLoKj9uTxgArvg

**Mint (devnet):**
- TX: https://explorer.solana.com/tx/2m4dUV7MYuLb6YqTWAurjgMYtvAEYWX21ZZ2Wn2erPQta2XKrBhv2x8cCnM6ZNceShuPn8NTMwbbBAdFR7TJdR6Q?cluster=devnet
- NFT Mint: Abpyva23vfmpRVvLtY3QontNqhHWKCigi1srbPrgsskT

This NFT represents a fully verifiable trade. Anyone can independently:
- recompute the verification hash
- validate the claim signature
- confirm on-chain state
- re-derive the trade from raw transactions

### Full Pipeline (Phases 1–8, Batch)

```bash
# Basic: ingest + normalize + reconstruct + PnL + receipts + render
node src/run-pipeline.mjs <wallet_address> [maxTxns]

# With claim signing + Arweave upload (all receipts)
node src/run-pipeline.mjs <wallet_address> [maxTxns] --keypair <path_to_keypair.json> [--recipient <pubkey>]
```

### End-to-End Example

```bash
# 1. Run pipeline for a wallet (up to 5000 transactions)
node src/run-pipeline.mjs CsZLf8nuA2GL7sLX31DjFdMtF1W9hcwKakpYPxxaa4pX 5000

# Expected output:
#   Phase 1: Ingest     → 1740 transactions
#   Phase 2: Normalize  → 165 swap events
#   Phase 3: Reconstruct → 49 cycles (10 closed, 19 open, 20 partial)
#   Phase 4: PnL        → 10 closed cycles with PnL
#   Phase 5: Receipts   → 10 receipts generated
#   Phase 6: Render     → 10 PNG cards

# 2. Inspect receipts and verify hashes
node src/inspect-receipts.mjs

# 3. Sign claims (requires the wallet's keypair)
node src/claims/claim-signer.mjs ./my-keypair.json

# 4. Upload to Arweave (devnet = free)
node src/arweave/arweave-upload.mjs ./my-keypair.json --network devnet

# 5. Mint on-chain NFTs
node src/mint/mint-submitter.mjs ./my-keypair.json data/claims/claims.jsonl --network devnet

# 6. Verify mints on-chain
node src/mint/verify-mints.mjs data/mints/mint_results.jsonl --network devnet
```

### Third-Party Verification

```bash
# Verify a receipt file (offline — hash + PnL + dust checks only)
node src/verify/verify-receipt.mjs data/receipts/receipts.jsonl --skip-onchain

# Full verification (hash + on-chain PDA + claim signature + metadata)
node src/verify/verify-receipt.mjs receipt.json --network devnet --metadata-uri https://gateway.irys.xyz/abc123
```

## Expected Output Files

After a full pipeline run, `engine/data/` contains:

```
data/
├── raw/
│   ├── helius_raw_response.jsonl    ← Full API responses (never modified)
│   └── helius_transactions.jsonl    ← Individual transactions
├── normalized/
│   └── events.jsonl                 ← Structured swap events
├── cycles/
│   └── trade_cycles.jsonl           ← Trade cycles (open/closed/partial)
├── pnl/
│   └── pnl_cycles.jsonl            ← Cycles enriched with PnL
├── receipts/
│   └── receipts.jsonl               ← Final receipts with verification hashes
├── renders/
│   └── receipt_0001_TOKEN.png       ← Visual receipt cards
├── claims/
│   └── claims.jsonl                 ← Ed25519 signed claims
├── arweave/
│   └── uploads.jsonl                ← Irys upload records (append-only)
└── mints/
    └── mint_results.jsonl           ← Mint transaction results (append-only)
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
- **Soul-bound:** Cannot be transferred after minting
- **Supply:** 1, Decimals: 0
- **Mint authority:** Removed after minting
- **Cost:** ~0.0065 SOL per mint

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `HELIUS_API_KEY` | Yes | Helius API key for transaction fetching |

The engine loads `.env` from `%USERPROFILE%\.openclaw\.env` automatically. You can also export it directly.

## Verification Levels

Anyone can verify a trade receipt independently:

| Level | What | Requires |
|---|---|---|
| **L1** | Receipt hash integrity + PnL arithmetic | Receipt JSON only (offline) |
| **L2** | On-chain PDA exists, fields match, NFT supply=1 | Solana RPC |
| **L3** | Ed25519 claim signature valid | On-chain PDA data |
| **L4** | Metadata content matches on-chain hash | Arweave gateway |
| **L5** | Full re-derivation from raw transactions | Helius API (re-run pipeline) |

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

- **Mixed-quote trades:** When a cycle's buys and sells use different quote currencies (e.g. buy with SOL, sell for USDC), PnL sums raw amounts across currencies. Flagged as `verified_mixed_quote`. V2 will add USD normalization via historical price oracles.
- **Transaction fees:** SOL base fees and priority fees are not deducted from cost basis. Negligible for typical trades (~0.000005 SOL).
- **Ambiguous swaps:** Multi-hop Jupiter routes with >1 sent or received token transfer are skipped during normalization (~1–2% of swap transactions).
- **Partial history:** Sells without matching buys in the observation window (pre-existing positions) are excluded from receipts.
- **Transaction cap:** Helius API pagination may miss older history for very active wallets (>10K transactions).
- **Windows compatibility:** Anchor builds require WSL due to Device Guard restrictions on `cargo-build-sbf.exe`.

## License

ISC
