# Pipeline Specification V1

**Version:** 1.0
**Status:** Implemented

This specification reflects the current devnet implementation and may evolve before mainnet deployment.

---

## Overview

The Trade Artifact Engine processes a Solana wallet's transaction history into verifiable trade receipts, uploads them to permanent storage, and mints soul-bound NFTs on-chain.

---

## Pipeline Stages

```
Stage 1: Ingest     → raw transaction data from Helius
Stage 2: Normalize  → structured swap events
Stage 3: Reconstruct → trade cycles (open/closed/partial)
Stage 4: PnL        → accounting for closed cycles
Stage 5: Receipt    → deterministic receipt + verification hash
Stage 6: Render     → PNG receipt card
Stage 7: Claim      → Ed25519 signed claim (optional, requires --keypair)
Stage 8: Upload     → Arweave/Irys storage (optional, requires --keypair)
Stage 9: Mint       → on-chain NFT (separate command)
```

Stages 1–6 always run. Stages 7–8 require `--keypair`. Stage 9 is a separate command (`mint-submitter.mjs`).

---

## Stage 1: Ingest

### Purpose
Fetch wallet transaction history from Helius Enhanced Transactions API.

### Input
- Wallet address (base58 public key)
- Max transaction count (default 10,000)
- `HELIUS_API_KEY` environment variable

### Process
- `GET https://api-mainnet.helius-rpc.com/v0/addresses/{wallet}/transactions?api-key={key}&limit=100`
- Paginate with `before` cursor (last signature of each page)
- 350ms delay between requests (rate limiting)
- Stop when: no more results OR max transaction count reached

### Output
| File | Format | Content |
|---|---|---|
| `data/raw/helius_raw_response.jsonl` | JSONL | Full API response batches (one array per line) |
| `data/raw/helius_transactions.jsonl` | JSONL | Individual transactions (one per line) |

### Persistence Rule
**Raw responses are NEVER deleted or modified.** They are the source of truth for reproducibility.

---

## Stage 2: Normalize

### Purpose
Extract structured swap events from Helius enhanced transaction format.

### Input
`data/raw/helius_transactions.jsonl`

### Process

**Filters applied:**
- Skip non-SWAP type transactions
- Skip errored transactions (`transactionError` is truthy)
- Skip ambiguous multi-route swaps (see below)

**Primary extraction path (`events.swap`):**
- Uses Helius structured swap decoding
- Extracts: in_mint, in_amount, in_decimals, out_mint, out_amount, out_decimals
- Amounts decimal-normalized from `rawTokenAmount`

**Fallback extraction path (`tokenTransfers`):**
- Used when `events.swap` is absent
- Matches: exactly 1 sent transfer + exactly 1 received transfer with different mints
- Amounts use Helius pre-normalized `tokenAmount`

**Ambiguous skips:**
- Multiple sent OR multiple received transfers (split routes, aggregator hops)
- These are logged in the skip count but do not produce events

**SOL normalization:** Native SOL is represented as `So11111111111111111111111111111111111111112` with 9 decimals.

### Output
| File | Format | Content |
|---|---|---|
| `data/normalized/events.jsonl` | JSONL | One swap event per line, sorted by timestamp then raw_index |

### Event Schema
```json
{
  "wallet": "<base58>",
  "timestamp": 1747460769,
  "tx_hash": "<base58 tx signature>",
  "source": "Raydium",
  "token_in_mint": "<base58>",
  "token_in_amount": 500.25,
  "token_in_decimals": 9,
  "token_out_mint": "<base58>",
  "token_out_amount": 12500.5,
  "token_out_decimals": 6,
  "extraction_method": "events_swap",
  "raw_index": 42
}
```

---

## Stage 3: Reconstruct

### Purpose
Group swap events into trade cycles per base token.

### Input
`data/normalized/events.jsonl`

### Process

**Quote mints (not tracked as base tokens):**
- SOL: `So11111111111111111111111111111111111111112`
- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- USDT: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`

**Action classification:**
- `token_in ∈ QUOTE_MINTS` AND `token_out ∉ QUOTE_MINTS` → **buy** (base = token_out)
- `token_in ∉ QUOTE_MINTS` AND `token_out ∈ QUOTE_MINTS` → **sell** (base = token_in)
- Both quote or both non-quote → **skip** (quote-to-quote swap)

**Cycle lifecycle:**
1. First buy of a token → new cycle opens (`status: "open"`)
2. Subsequent buys → same cycle (running_balance increases, peak_position tracks max)
3. Sells → running_balance decreases
4. When `|running_balance| < max(0.001, 0.001 × peak_position)` after a sell → **cycle closes**
5. Closed cycle removed from active map → next buy opens a new cycle

**Special cases:**
- First event is a sell (no prior buy) → `status: "partial_history"` (pre-existing position)
- Cycle ends with negative balance → reclassified to `partial_history`
- Re-entry after close → new cycle with new cycle_id

### Output
| File | Format | Content |
|---|---|---|
| `data/cycles/trade_cycles.jsonl` | JSONL | One cycle per line with entry_txs, exit_txs, balances |

### Cycle Statuses
| Status | Meaning | Receipt Eligible |
|---|---|---|
| `closed` | Fully entered and exited within observation window | ✅ |
| `open` | Position still held | ❌ |
| `partial_history` | Sells without matching buys (pre-existing position) | ❌ |

---

## Stage 4: PnL

### Purpose
Compute realized profit/loss for closed cycles.

### Input
`data/cycles/trade_cycles.jsonl`

### Process

Only processes cycles with `status: "closed"`. All others pass through with null PnL fields.

**Accounting (WACB):**
```
total_cost_basis    = Σ(entry_tx.quote_amount)
total_exit_proceeds = Σ(exit_tx.quote_amount)
entry_price_avg     = total_cost_basis / total_bought
exit_price_avg      = total_exit_proceeds / total_sold
realized_pnl        = total_exit_proceeds - total_cost_basis
realized_pnl_pct    = (realized_pnl / total_cost_basis) × 100
```

**Quote currency determination:**
- All entry + exit txs use the same quote mint → `quote_currency = that mint`
- Different quote mints used → `quote_currency = "MIXED"`, `receipt_status = "verified_mixed_quote"`

**Raw value preservation:**
- `_raw_entry_price_avg` and `_raw_exit_price_avg` (IEEE 754 doubles) stored on each cycle for hash computation

### Output
| File | Format | Content |
|---|---|---|
| `data/pnl/pnl_cycles.jsonl` | JSONL | Enriched cycles with PnL fields |

---

## Stage 5: Receipt

### Purpose
Generate deterministic trade receipts with verification hashes.

### Input
`data/pnl/pnl_cycles.jsonl` (filtered to `status: "closed"`)

### Process

1. Extract display-rounded fields from PnL cycle
2. Strip internal fields (`quote_mint`, `raw_index`) from transaction objects
3. Compute verification hash using raw doubles + status (see receipt_spec.md)
4. Store `_hash_inputs` with raw values

### Output
| File | Format | Content |
|---|---|---|
| `data/receipts/receipts.jsonl` | JSONL | One receipt per line (see receipt_spec.md for schema) |

---

## Stage 6: Render

### Purpose
Generate visual PNG receipt cards for display and Arweave upload.

### Input
`data/receipts/receipts.jsonl`

### Process
- 800×520px dark card with gradient background
- Green/red accent based on profit/loss
- Displays: token pair, PnL %, PnL absolute, entry/exit prices, cost basis/proceeds, hold time, trade count, receipt ID, verification hash (truncated), timestamps
- Uses `canvas` npm package (node-canvas) for server-side rendering

### Output
| File | Format | Content |
|---|---|---|
| `data/renders/{receipt_id}.png` | PNG | One card per receipt |

---

## Stage 7: Claim Signing (Optional)

### Prerequisite
`--keypair <path>` CLI flag

### Purpose
Sign canonical claim messages with the trader wallet key.

### Input
`data/receipts/receipts.jsonl` + keypair file

### Process
1. Load Ed25519 keypair from JSON file
2. For each receipt where `receipt.wallet == signer pubkey`:
   - Construct canonical claim message (see claim_spec.md)
   - Sign with `tweetnacl.sign.detached`
   - Self-verify before writing
3. Skip receipts where wallet doesn't match signer (logged as "wallet mismatch")

### Output
| File | Format | Content |
|---|---|---|
| `data/claims/claims.jsonl` | JSONL | One claim per line (see claim_spec.md for schema) |

---

## Stage 8: Arweave Upload (Optional)

### Prerequisite
`--keypair <path>` CLI flag (same keypair used for Irys)

### Note 
The --keypair used in this stage is also used to sign and fund Irys uploads. 
On devnet, uploads may be subsidized or free, but on mainnet this keypair must hold sufficient SOL to pay for permanent storage.

### Purpose
Upload receipt assets to permanent storage via Irys/Arweave.

### Input
`data/receipts/receipts.jsonl` + `data/renders/*.png`

### Process
Per receipt:
1. Upload PNG → get Irys ID + gateway URL
2. Upload receipt JSON (pretty-printed) → get URL
3. Build NFT metadata JSON with PNG + receipt JSON URLs (see metadata_spec.md)
4. Compute `metadata_hash` = SHA-256 of metadata JSON string
5. Upload NFT metadata JSON → get URL
6. Record all IDs, URIs, hash in uploads.jsonl

**Idempotent:** Skips receipts already in `uploads.jsonl` (keyed by verification_hash).

### Output
| File | Format | Content |
|---|---|---|
| `data/arweave/uploads.jsonl` | JSONL | One upload record per receipt (see metadata_spec.md) |

---

## Stage 9: Mint (Separate Command)

### Command
`node src/mint/mint-submitter.mjs <payerKeypair> <claimsPath> [--network devnet|mainnet] [--dry-run]`

### Prerequisite
`claims.jsonl` from Stage 7. Optionally `uploads.jsonl` from Stage 8 (falls back to dummy metadata URI).

### Input
`data/claims/claims.jsonl` + `data/arweave/uploads.jsonl` + `data/receipts/receipts.jsonl`

### Process
Per claim:
1. **Idempotency check:** Skip if `mint_results.jsonl` has `status: "confirmed"` for this hash
2. **PDA pre-check:** Skip if receipt PDA already exists on-chain
3. **Build transaction** (3 instructions):
   - `Ed25519Program.createInstructionWithPublicKey` — signature verification
   - `ComputeBudgetProgram.setComputeUnitLimit(400_000)` — CU headroom
   - `trade_artifact::mint_receipt` — Anchor instruction with verification_hash, metadata_hash, status, metadata_uri, receipt_name
4. **Dry-run mode:** Simulate only (no submission)
5. **Live mode:** Submit with `sendAndConfirmTransaction`, record result

### Output
| File | Format | Content |
|---|---|---|
| `data/mints/mint_results.jsonl` | JSONL | Appended results (never overwritten) |

### Mint Result Statuses
| Status | Meaning |
|---|---|
| `confirmed` | Transaction confirmed on-chain |
| `already_minted` | PDA already exists (skipped) |
| `failed` | Transaction failed (error recorded) |
| `sim_passed` | Simulation succeeded (dry-run) |
| `sim_failed` | Simulation failed (dry-run) |

---

## CLI Reference

### Full Pipeline (Stages 1–8)
```bash
node src/run-pipeline.mjs <wallet> [maxTxns] [--keypair <path>] [--recipient <pubkey>]
```

### Standalone Modules
```bash
# Claim signing
node src/claims/claim-signer.mjs <keypairPath> [recipientPubkey] [receiptsPath] [outputDir]

# Claim verification
node src/claims/verify-claims.mjs [claimsPath]

# Arweave upload
node src/arweave/arweave-upload.mjs <keypairPath> [--network devnet|mainnet] [--receipts <path>] [--renders <dir>] [--output <dir>]

# Mint submission
node src/mint/mint-submitter.mjs <payerKeypairPath> <claimsPath> [--network devnet|mainnet] [--dry-run]

# Post-mint verification
node src/mint/verify-mints.mjs [mintResultsPath] [--network devnet|mainnet]

# Receipt inspection
node src/inspect-receipts.mjs
```

---

## Persistence Rules

1. **Raw data** (`data/raw/`) — NEVER deleted or modified. Source of truth.
2. **Intermediate stages** (`normalized/`, `cycles/`, `pnl/`) — Overwritten on re-run. Deterministic from raw data.
3. **Receipts** (`data/receipts/`) — Overwritten on re-run. Deterministic from cycles + PnL.
4. **Claims** (`data/claims/`) — Overwritten on re-run. Deterministic from receipts + keypair.
5. **Uploads** (`data/arweave/`) — **Append-only.** Idempotent by verification_hash.
6. **Mint results** (`data/mints/`) — **Append-only.** Idempotent by verification_hash + on-chain PDA check.
7. **All JSONL files** — One JSON object per line, newline-terminated.

---

## Environment Variables

| Variable | Required | Source | Description |
|---|---|---|---|
| `HELIUS_API_KEY` | ✅ | `%USERPROFILE%\.openclaw\.env` | Helius API authentication |

---

## Data Flow Diagram

```
                  Helius API
                      │
                      ▼
              ┌───────────────┐
              │  Stage 1      │──▶ data/raw/*.jsonl
              │  Ingest       │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  Stage 2      │──▶ data/normalized/events.jsonl
              │  Normalize    │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  Stage 3      │──▶ data/cycles/trade_cycles.jsonl
              │  Reconstruct  │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  Stage 4      │──▶ data/pnl/pnl_cycles.jsonl
              │  PnL          │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  Stage 5      │──▶ data/receipts/receipts.jsonl
              │  Receipt      │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  Stage 6      │──▶ data/renders/*.png
              │  Render       │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  Stage 7      │──▶ data/claims/claims.jsonl
              │  Claim Sign   │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  Stage 8      │──▶ data/arweave/uploads.jsonl
              │  Upload       │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │  Stage 9      │──▶ data/mints/mint_results.jsonl
              │  Mint         │
              └───────────────┘
```
