# Receipt Specification V1

**Version:** 1.0
**Status:** Implemented

This specification reflects the current devnet implementation and may evolve before mainnet deployment.

---

## Overview

A TradeReceipt is a structured JSON object representing a single closed spot trade cycle on Solana. Every field included in the verification hash is derived deterministically from on-chain transaction data.

---

## 1. Receipt Schema

Persisted in `receipts.jsonl`, one JSON object per line.

### Identity Fields

| Field | Type | Description |
|---|---|---|
| `receipt_id` | string | `receipt_{NNNN}_{mint8}` — sequential + first 8 chars of token_mint |
| `receipt_version` | string | `"1.0"` |
| `cycle_id` | string | Internal cycle reference (e.g. `cycle_21_DitHyRMQ`) |

### Context Fields

| Field | Type | Description |
|---|---|---|
| `wallet` | string | Solana wallet public key (base58) |
| `chain` | string | `"solana"` |
| `token_mint` | string | SPL token mint address (base58) |
| `status` | string | `"verified"` or `"verified_mixed_quote"` |
| `accounting_method` | string | `"weighted_average_cost_basis"` |

### Pricing Fields (display-rounded)

| Field | Type | Formatting | Description |
|---|---|---|---|
| `avg_entry_price` | number | `toPrecision(12)` | Weighted average entry price |
| `avg_exit_price` | number | `toPrecision(12)` | Weighted average exit price |
| `quote_currency` | string | — | Quote mint address or `"MIXED"` |

### PnL Fields (display-rounded)

| Field | Type | Formatting | Description |
|---|---|---|---|
| `total_cost_basis` | number | `toPrecision(12)` | Σ(entry quote amounts) |
| `total_exit_proceeds` | number | `toPrecision(12)` | Σ(exit quote amounts) |
| `realized_pnl` | number | `toPrecision(12)` | proceeds − cost |
| `realized_pnl_pct` | number | `toPrecision(6)` | (pnl / cost) × 100 |

### Position Fields

| Field | Type | Formatting | Description |
|---|---|---|---|
| `total_bought` | number | `toFixed(10)` | Total tokens acquired |
| `total_sold` | number | `toFixed(10)` | Total tokens disposed |
| `peak_position` | number | `toFixed(10)` | Max cumulative holding |
| `remaining_balance` | number | `toFixed(10)` | bought − sold (near zero for closed) |
| `num_buys` | number | — | Count of buy transactions |
| `num_sells` | number | — | Count of sell transactions |

### Timing Fields

| Field | Type | Description |
|---|---|---|
| `opened_at` | number | Unix timestamp (seconds) of first buy |
| `closed_at` | number | Unix timestamp (seconds) of closing sell |
| `hold_time_seconds` | number | closed_at − opened_at |

### Transaction References

| Field | Type | Description |
|---|---|---|
| `entry_txs` | array | Entry transactions (see below) |
| `exit_txs` | array | Exit transactions (see below) |

Each transaction object:

```json
{
  "tx_hash": "<solana transaction signature, base58>",
  "timestamp": 1747460769,
  "amount": 12500.5,
  "quote_amount": 500.25
}
```

### Hash Inputs
The `_hash_inputs` field stores raw, unrounded double-precision values used for verification hash derivation. 
This prevents hash mismatches caused by display formatting (e.g. rounding via toFixed or toPrecision), ensuring deterministic and reproducible verification across independent implementations.

| Field | Type | Description |
|---|---|---|
| `_hash_inputs` | object | Raw double-precision values used in verification hash |

```json
{
  "_hash_inputs": {
    "raw_entry_price_avg": 0.039299374189350795,
    "raw_exit_price_avg": 0.05615999746118498
  }
}
```

These are the PnL engine's unrounded IEEE 754 doubles. They exist for hash re-derivation without re-running the pipeline. Display fields (`avg_entry_price`, `avg_exit_price`) are rounded from these values.

### Metadata Fields

| Field | Type | In Hash | Description |
|---|---|---|---|
| `generated_at` | number | ❌ | Unix timestamp when receipt was generated |
| `verification_hash` | string | — | SHA-256 hex digest (output, not input) |

---

## 2. Verification Hash

### Algorithm

SHA-256

### Input Construction

The hash is computed over a `JSON.stringify`'d array of canonical fields in this exact order:

```javascript
const payload = JSON.stringify([
  receipt.wallet,                          // string: base58 pubkey
  receipt.chain,                           // string: "solana"
  receipt.token_mint,                      // string: base58 mint address
  entryTxHashes,                           // string[]: SORTED ascending
  exitTxHashes,                            // string[]: SORTED ascending
  receipt._hash_inputs.raw_entry_price_avg,// number: RAW IEEE 754 double
  receipt._hash_inputs.raw_exit_price_avg, // number: RAW IEEE 754 double
  receipt.accounting_method,               // string: "weighted_average_cost_basis"
  receipt.receipt_version,                 // string: "1.0"
  receipt.status,                          // string: "verified" or "verified_mixed_quote"
]);

const hash = createHash('sha256').update(payload).digest('hex');
```

### Critical Rules

1. **Transaction hashes are sorted lexicographically ascending** before inclusion. Order-independent.
2. **Raw double-precision values** are used, not display-rounded values. `JSON.stringify` serializes IEEE 754 doubles deterministically (shortest unique representation).
3. **`status` is included** because `verified` vs `verified_mixed_quote` is a material classification difference.
4. **`generated_at` is excluded** — metadata about when the receipt was created, not about the trade.
5. **`_hash_inputs` values are the source of truth** for hash derivation. Display fields may differ due to rounding.

### Verification Flows

**Quick verification (from receipt JSON only):**

1. Read `_hash_inputs.raw_entry_price_avg` and `_hash_inputs.raw_exit_price_avg`
2. Extract and sort `entry_txs[].tx_hash` and `exit_txs[].tx_hash`
3. Construct the JSON array per the spec above
4. Compute SHA-256
5. Compare to `verification_hash`

**Full verification (from on-chain data):**

1. Fetch all referenced transactions from Solana (via Helius or RPC)
2. Re-run normalization, cycle detection, and PnL calculation
3. Compare computed raw values against `_hash_inputs`
4. Re-derive hash and compare to `verification_hash`

---

## 3. Status Values

| Status | Meaning | Hash Impact |
|---|---|---|
| `verified` | Single quote currency, all swaps matched, balance closed cleanly | Included in hash |
| `verified_mixed_quote` | Multiple quote currencies in one cycle. PnL sums raw amounts across currencies. Directionally correct but not unit-precise. | Included in hash |

Status is **included in the verification hash** because the two statuses represent materially different interpretations. If classification logic changes in a future version, the receipt must be re-generated with a new hash.

---

## 4. Cycle Close Threshold (Dust Rule)

A trade cycle is considered closed when:

```
|total_bought - total_sold| < max(0.001, 0.001 × peak_position)
```

- `0.001` = absolute dust threshold (tokens)
- `0.001 × peak_position` = 0.1% of peak holding (relative threshold)
- The larger of the two is used, ensuring both micro-cap and large-cap tokens close correctly
- `peak_position` and `remaining_balance` in the receipt make this independently verifiable

---

## 5. Accounting Method: WACB

Weighted Average Cost Basis:

```
entry_price_avg = Σ(entry_tx.quote_amount) / Σ(entry_tx.amount)
exit_price_avg  = Σ(exit_tx.quote_amount) / Σ(exit_tx.amount)
total_cost_basis    = Σ(entry_tx.quote_amount)
total_exit_proceeds = Σ(exit_tx.quote_amount)
realized_pnl        = total_exit_proceeds - total_cost_basis
realized_pnl_pct    = (realized_pnl / total_cost_basis) × 100
```

All arithmetic uses IEEE 754 double-precision floating point. The raw results are stored in `_hash_inputs` before any display formatting.

---

## 6. Known V1 Limitations

- **Mixed-quote PnL** mixes currency units (e.g. SOL + USDC amounts summed). Flagged via status.
- **Transaction fees** (SOL base fee + priority fee) are not deducted from cost basis. Negligible for typical trades.
- **Token decimals** from the fallback extraction path (`tokenTransfers`) may be null — amounts are still correct (Helius pre-normalizes).
- **Partial history** cycles (sells without matching buys in the observation window) do not produce receipts.
