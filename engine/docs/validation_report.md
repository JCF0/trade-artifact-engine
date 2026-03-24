# Validation Batch Report

**Date:** 2026-03-24
**Engine Version:** 1.0
**Pipeline Version:** run-pipeline.mjs (Phases 1–8)

---

## Wallets Tested

### Wallet 1: CsZLf8nuA2GL7sLX31DjFdMtF1W9hcwKakpYPxxaa4pX

| Metric | Value |
|---|---|
| Transactions fetched | 1,740 |
| Swap events extracted | 165 |
| Skipped (non-swap) | 1,523 |
| Skipped (errored) | 0 |
| Skipped (ambiguous) | 52 |
| Trade cycles | 49 total |
| Closed cycles | 10 |
| Open cycles | 19 |
| Partial history | 20 |
| **Receipts generated** | **10** |
| Hash verification | 10/10 ✅ |

**Notable receipts:**

| Receipt | Token | PnL | Status | Notes |
|---|---|---|---|---|
| receipt_0001_3B5wuUrM | 3B5wuUrM... | +17,122% | verified_mixed_quote | 🟡 Bought in SOL, sold for USDC |
| receipt_0003_DitHyRMQ | DitHyRMQ... | −99.4% | verified_mixed_quote | 🟡 Near-total loss, mixed quote |
| receipt_0006_8YiB8B43 | 8YiB8B43... | +22,470% | verified_mixed_quote | 🟡 Massive gain, SOL→USDC route |
| receipt_0007_nosXBVoa | nosXBVoa... | −4.6% | verified | Standard USDC cycle |

**Anomalies:**
- 4 of 10 receipts are `verified_mixed_quote` — common for pump.fun tokens where users buy with SOL but sell for USDC (or vice versa)
- 52 ambiguous swaps skipped — likely Jupiter multi-hop routes where token_transfers show >1 sent or received
- 20 partial_history cycles — position held before observation window (expected for active wallets)

---

### Wallet 2: 8PkeQ8GcuhJKdZveFEuyenv2KF2qvr6uvVWLoEHGiSM1

| Metric | Value |
|---|---|
| Transactions fetched | 355 |
| Swap events extracted | 69 |
| Skipped (non-swap) | 286 |
| Skipped (errored) | 0 |
| Skipped (ambiguous) | 0 |
| Trade cycles | 18 total |
| Closed cycles | 3 |
| Open cycles | 12 |
| Partial history | 3 |
| **Receipts generated** | **3** |
| Hash verification | 3/3 ✅ |

**Notable receipts:**

| Receipt | Token | PnL | Status | Notes |
|---|---|---|---|---|
| receipt_0001_WENWENvq | WENWENvq... | −38.2% | verified | 2 buys, 1 sell. Standard SOL cycle. |
| receipt_0002_9CfNSbyb | 9CfNSbyb... | −99.9% | verified_mixed_quote | 🟡 Near-total loss, mixed quote |
| receipt_0003_7EYnhQoR | 7EYnhQoR... | −68.0% | verified | Standard SOL cycle. |

**Anomalies:**
- Smaller wallet, fewer trades. 12 open cycles (still holding positions).
- 0 ambiguous skips — cleaner swap routing than wallet 1.
- 1 mixed-quote receipt.

---

### Wallet 3: CreQJ2t94QK5dsxUZGXfPJ8Nx7wA9LHr5chxjSMkbNft

| Metric | Value |
|---|---|
| Transactions fetched | 10,000 (max cap hit) |
| Swap events extracted | 7,379 |
| Skipped (non-swap) | 2,574 |
| Skipped (errored) | 0 |
| Skipped (ambiguous) | 47 |
| Trade cycles | 49 total |
| Closed cycles | 15 |
| Open cycles | 11 |
| Partial history | 23 |
| **Receipts generated** | **15** |
| Hash verification | 15/15 ✅ |

**Notable receipts:**

| Receipt | Token | PnL | Status | Trades | Hold | Notes |
|---|---|---|---|---|---|---|
| receipt_0005_MEW1gQWJ | MEW1gQWJ... | +0.26% | verified | 11b/11s | 272 min | 🔵 High-frequency: 22 trades in ~4.5 hrs |
| receipt_0006_cbbtcf3a | cbbtcf3a... | +8,957% | verified_mixed_quote | 2b/1s | 5 min | 🟡 Massive quick flip, mixed quote |
| receipt_0008_cbbtcf3a | cbbtcf3a... | −3.8% | verified_mixed_quote | 77b/80s | 267 min | 🔵🟡 Very high frequency: 157 trades, mixed quote |
| receipt_0001_G7vQWurM | G7vQWurM... | −0.04% | verified | 1b/1s | 0.1 min | ⚡ Sub-minute cycle (6 seconds) |

**Anomalies:**
- Hit 10,000 tx cap — this wallet has more history than we fetched. 23 partial_history cycles are likely from pre-window positions.
- receipt_0008 has **157 trades** (77 buys, 80 sells) in a single cycle — stress test for cycle reconstruction. PnL accounting handled correctly.
- receipt_0001 has a **6-second hold time** — rapid bot-like trading. Pipeline handles it correctly.
- 2 of 15 are mixed-quote.
- Multiple G7vQWurM cycles — wallet traded the same token across 8 separate cycles.

---

## Summary Across All Wallets

| Metric | Wallet 1 | Wallet 2 | Wallet 3 | Total |
|---|---|---|---|---|
| Transactions | 1,740 | 355 | 10,000 | 12,095 |
| Swap events | 165 | 69 | 7,379 | 7,613 |
| Closed cycles | 10 | 3 | 15 | 28 |
| Receipts | 10 | 3 | 15 | **28** |
| Mixed quote | 4 | 1 | 2 | **7** (25%) |
| Hash ✅ | 10/10 | 3/3 | 15/15 | **28/28** |

### Edge Cases Encountered

| Case | Count | Handled |
|---|---|---|
| Mixed-quote cycles (SOL buy → USDC sell) | 7 | ✅ Flagged as `verified_mixed_quote` |
| Partial history (sells without prior buys) | 46 | ✅ Excluded from receipts |
| High-frequency trading (>20 trades/cycle) | 2 | ✅ WACB accumulates correctly |
| Sub-minute hold times | 4 | ✅ Pipeline handles correctly |
| Ambiguous multi-hop swaps | 99 | ✅ Skipped at normalization |
| Tx cap hit (>10K transactions) | 1 | ⚠️ Older history truncated |
| Re-entry (multiple cycles on same token) | 8+ | ✅ Each cycle gets unique ID |
| Near-total loss (>99%) | 2 | ✅ Dust threshold closes correctly |
| Very large gains (>10,000%) | 3 | ✅ Arithmetic handles correctly |

### Known Limitations Observed

1. **Tx cap on wallet 3** — fetched 10K transactions but wallet has more. Receipts are correct for the fetched window, but older closed cycles are missed or appear as partial_history.
2. **Mixed-quote prevalence** — 25% of receipts have mixed quotes. V2 USD normalization will improve this.
3. **Ambiguous swaps** — ~1.3% of swap-type transactions are skipped as ambiguous. These are multi-route Jupiter swaps where the token_transfers don't map to a clean 1:1 swap.
