# TradeReceipt Spec — V1

## Concept

A TradeReceipt is a structured JSON object representing a single closed spot trade cycle. It captures the full lifecycle from entry to exit with deterministic, reproducible calculations derived from on-chain data.

## Required Fields

| Field                  | Type     | Description                                      |
|------------------------|----------|--------------------------------------------------|
| `version`              | string   | Receipt spec version (`"1.0"`)                   |
| `wallet`               | string   | Solana wallet public key                         |
| `token_mint`           | string   | SPL token mint address                           |
| `token_symbol`         | string   | Human-readable token symbol (best effort)        |
| `side`                 | string   | Always `"spot"` in V1                            |
| `entry_price_avg`      | number   | Weighted average entry price (in SOL or USDC)    |
| `exit_price_avg`       | number   | Weighted average exit price (in SOL or USDC)     |
| `quote_token`          | string   | Quote currency mint (SOL / USDC)                 |
| `total_bought`         | number   | Total tokens acquired across all buy events      |
| `total_sold`           | number   | Total tokens disposed across all sell events      |
| `realized_pnl`         | number   | Net realized profit or loss in quote currency     |
| `realized_pnl_pct`     | number   | Realized PnL as percentage of total cost basis    |
| `first_buy_ts`         | number   | Unix timestamp of first buy event                |
| `last_sell_ts`         | number   | Unix timestamp of last sell event                |
| `num_buys`             | number   | Count of buy swap events                         |
| `num_sells`            | number   | Count of sell swap events                        |
| `status`               | string   | `"verified"` / `"ambiguous"` / `"unsupported"`   |
| `status_reason`        | string   | Human-readable reason if not verified             |
| `buy_txns`             | array    | List of buy transaction signatures                |
| `sell_txns`            | array    | List of sell transaction signatures               |
| `generated_at`         | number   | Unix timestamp of receipt generation              |

## Status Values

- **`verified`** — Trade cycle fully reconstructed with high confidence. All swaps matched, balance closed cleanly.
- **`ambiguous`** — Trade cycle detected but some data is uncertain (e.g., missing price data, partial parse failures). Receipt is generated but flagged.
- **`unsupported`** — Trade type not handled in V1 (e.g., LP, perps). No receipt generated.

## Determinism

Receipts must be **deterministic and reproducible**. Given the same wallet address and the same transaction history, the engine must produce byte-identical receipt JSON. No randomness, no timestamps in calculations, no floating insertion order.
