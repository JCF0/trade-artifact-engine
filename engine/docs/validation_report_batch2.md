# Validation Report — Batches 1 & 2

**Date:** 2026-03-24
**Engine version:** 1.0
**Pipeline version:** run-pipeline.mjs (Phases 1–8)

---

## Summary

Two validation batches were run to test the pipeline under both positive and negative conditions. The engine produced correct results in both cases — generating receipts only when full trade cycles were verifiable, and refusing to generate them otherwise.

---

## Batch 1 — Positive Case (28 Receipts)

Three wallets with moderate transaction history where complete buy→sell cycles fell within the observation window.

| Wallet | Txns | Swaps | Ambig Skip | Cycles | Closed | Open | Partial | Receipts | Mixed Quote |
|---|---|---|---|---|---|---|---|---|---|
| `CsZLf8...` | 1,740 | 165 | 52 | 49 | 10 | 19 | 20 | **10** | 4 |
| `8PkeQ8...` | 355 | 69 | 0 | 18 | 3 | 12 | 3 | **3** | 1 |
| `CreQJ2...` | 10,000 | 7,379 | 47 | 49 | 15 | 11 | 23 | **15** | 2 |
| **Total** | **12,095** | **7,613** | **99** | **116** | **28** | **42** | **46** | **28** | **7** |

**Hash verification: 28/28 ✅** — every receipt's SHA-256 verification hash re-derives correctly from its `_hash_inputs` and sorted transaction hashes.

### Notable edge cases handled correctly

- **157-trade cycle** (77 buys / 80 sells) — WACB accumulation correct
- **6-second hold time** — sub-minute cycles process without error
- **+22,470% gain** and **−99.9% loss** — arithmetic handles extremes
- **8 re-entry cycles** on the same token — each gets a unique cycle ID and independent receipt
- **25% mixed-quote rate** — pump.fun tokens bought with SOL, sold for USDC; correctly flagged as `verified_mixed_quote`

---

## Batch 2 — Negative Case (0 Receipts)

Thirteen wallets provided by the user, all high-activity DEX traders. Transaction caps of 2,000–3,000 per wallet.

| Wallet | Txns | Swaps | Ambig Skip | Cycles | Closed | Open | Partial | Receipts |
|---|---|---|---|---|---|---|---|---|
| `BxezKiMM...` | 3,000 | 2,905 | 0 | 1 | 0 | 1 | 0 | 0 |
| `Cgj5KsSu...` | 3,000 | 2,987 | 0 | 1 | 0 | 1 | 0 | 0 |
| `CDsYRLCJ...` | 3,000 | 2,101 | 0 | 4 | 0 | 1 | 3 | 0 |
| `Ee7qK1Pm...` | 900 | 549 | 288 | 3 | 0 | 0 | 3 | 0 |
| `3xbmFr5X...` | 2,000 | 293 | 0 | 5 | 0 | 0 | 5 | 0 |
| `FRdpCuDs...` | 2,000 | 1,523 | 0 | 1 | 0 | 0 | 1 | 0 |
| `5sSfFTNN...` | 2,000 | 1,154 | 0 | 1 | 0 | 0 | 1 | 0 |
| `3VsrgEfH...` | 2,000 | 201 | 60 | 18 | 0 | 3 | 15 | 0 |
| `D4oKZSfX...` | 3,000 | 2,339 | 339 | 6 | 0 | 0 | 6 | 0 |
| `32tkxcq5...` | 3,000 | 1,783 | 0 | 1 | 0 | 0 | 1 | 0 |
| `4ZyNHuLS...` | 3,000 | 1,345 | 1 | 5 | 0 | 3 | 2 | 0 |
| `7abU5SFQ...` | 3,000 | 470 | 1,053 | 9 | 0 | 1 | 8 | 0 |
| `2Spt6eEf...` | 3,000 | 397 | 116 | 0 | 0 | 0 | 0 | 0 |
| **Total** | **32,900** | **18,047** | **1,857** | **55** | **0** | **10** | **45** | **0** |

### Why zero receipts is the correct result

These wallets have deep trading histories (likely 50K+ lifetime transactions). A 2–3K transaction window captures only days of recent activity. The pipeline sees:

- **Partial history (45 cycles):** Sells without matching buys in the window. The wallet acquired these tokens before the observation period. Without the buy side, there is no cost basis and no verifiable PnL — so no receipt is generated.
- **Open positions (10 cycles):** Buys with no corresponding sells yet. The position is still held.
- **Zero closed cycles across all 13 wallets.**

The engine does not fabricate cost basis, estimate missing data, or generate receipts from incomplete information. If it cannot fully verify a trade cycle from ingested transactions, it refuses to produce a receipt. This is by design.

---

## What Both Batches Validate

| Property | Batch 1 (positive) | Batch 2 (negative) |
|---|---|---|
| Hash integrity | 28/28 re-derive ✅ | N/A (no receipts to hash) |
| Cycle detection | Correctly identifies closed cycles | Correctly identifies partial/open cycles |
| Partial history exclusion | 46 partial cycles excluded | 45 partial cycles excluded |
| Mixed-quote flagging | 7 flagged as `verified_mixed_quote` | N/A |
| Ambiguous swap skip | 99 multi-hop swaps safely skipped | 1,857 safely skipped |
| Empty-result handling | N/A | 0-receipt runs complete cleanly |
| PnL arithmetic | Verified across −99.9% to +22,470% | N/A |

**The engine is conservative by design.** It will not produce a receipt unless it can fully reconstruct and verify the trade cycle from on-chain data. Both positive-case receipt generation and negative-case refusal validate this property.

---

## Known Limitations Observed

1. **Transaction cap vs. wallet depth:** For wallets with very deep histories, a 2–3K cap captures only recent activity. Increasing the cap (or paginating to full history) would recover more closed cycles, at the cost of longer ingest times and higher API usage.
2. **Ambiguous swap rate:** Ranges from 0% to 35% depending on wallet. Multi-hop Jupiter routes with multiple token transfers in a single transaction cannot be cleanly mapped to a single swap event. These are safely skipped.
3. **Helius free-tier coverage:** Some wallet addresses return 0 transactions from the Enhanced Transactions API on the free tier. Paid plans provide broader indexing.
