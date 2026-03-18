# Accounting Rules — V1

## Method

Weighted average cost basis (WACB) for both entry and exit.

---

## Weighted Average Entry Price

For each buy event `i` with quantity `q_i` and price `p_i`:

```
entry_price_avg = Σ(q_i × p_i) / Σ(q_i)
```

All buy events within a single trade cycle contribute to the weighted average.

---

## Weighted Average Exit Price

For each sell event `j` with quantity `q_j` and price `p_j`:

```
exit_price_avg = Σ(q_j × p_j) / Σ(q_j)
```

All sell events within a single trade cycle contribute to the weighted average.

---

## Realized PnL

```
realized_pnl = (exit_price_avg - entry_price_avg) × total_sold
```

Expressed in the quote currency (SOL or USDC).

Percentage:

```
realized_pnl_pct = realized_pnl / (entry_price_avg × total_sold) × 100
```

---

## Trade Cycle Close Threshold

A trade cycle is considered **closed** when the remaining token balance falls below the dust threshold:

```
remaining_balance < max(0.001 tokens, 0.1% of peak_position_size)
```

Where:

- `remaining_balance` = tokens bought minus tokens sold across the cycle
- `peak_position_size` = maximum cumulative token holding at any point during the cycle

Balances above this threshold mean the position is still open and no receipt is generated.

---

## Edge Cases

- If a wallet sells more than it bought within the observed window, the cycle is marked `ambiguous`.
- If price data is unavailable for any swap event, the cycle is marked `ambiguous`.
- Dust remainders below the close threshold are ignored and do not affect PnL calculation.
