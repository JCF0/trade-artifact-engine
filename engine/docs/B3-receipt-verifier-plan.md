# B3 Plan: v1.2 Receipt Verifier

**Approved:** 2026-06-13
**Adjustments:** test file `receipt-verifier.test.mjs`, static import in run-pipeline.mjs

## 1. Files to create/modify

| Action | Path | Purpose |
|---|---|---|
| CREATE | `engine/src/ledger/receipt-verifier.mjs` | Core verifier — pure functions, no I/O |
| CREATE | `engine/src/ledger/receipt-verifier.test.mjs` | Unit tests |
| MODIFY | `engine/src/run-pipeline.mjs` | Add `Ledger Debug: Verify` block after v1.2 receipt write |

## 2. Verifier function signatures

```js
export function verifyReceipt(receipt) → VerificationResult
export function verifyReceiptBatch(receipts) → VerificationReport
```

Both import `computeReceiptHash` from `./receipt-promotion.mjs`.

## 3. Verification result schema

```js
VerificationResult {
  receipt_id, receipt_hash, recomputed_hash,
  hash_valid, rule_violations: [{rule, message, severity}],
  schema_valid, consistency_valid, pass
}

VerificationReport {
  total, passed, failed,
  by_type: { closed_position, realized_partial, open_snapshot },
  by_status: { verified, ... },
  results: VerificationResult[],
  failures: VerificationResult[]
}
```

## 4. Receipt hash recomputation

Uses `computeReceiptHash()` from `receipt-promotion.mjs` with fields extracted as-is from the receipt (no transformation).

## 5. Validation rules

### closed_position (CP-1 to CP-10)
- CP-1: total_sold_qty not null and > 0
- CP-2: total_sold_quote not null and > 0
- CP-3: allocated_cost_basis_quote not null
- CP-4: realized_pnl_quote not null
- CP-5: realized_pnl_pct not null
- CP-6: remaining_qty ~0 (within dust)
- CP-7: exit_tx_hashes non-empty
- CP-8: entry_tx_hashes non-empty
- CP-9: hold_time_seconds not null and >= 0
- CP-10: snapshot_at null

### realized_partial (RP-1 to RP-6)
- RP-1: total_sold_qty not null and > 0
- RP-2: realized_pnl_quote not null
- RP-3: remaining_qty > 0
- RP-4: exit_tx_hashes non-empty
- RP-5: entry_tx_hashes non-empty
- RP-6: snapshot_at null

### open_snapshot (OS-1 to OS-10)
- OS-1: total_sold_qty null
- OS-2: total_sold_quote null
- OS-3: avg_sell_quote_price null
- OS-4: allocated_cost_basis_quote null
- OS-5: realized_pnl_quote null
- OS-6: realized_pnl_pct null
- OS-7: exit_tx_hashes empty
- OS-8: entry_tx_hashes non-empty
- OS-9: remaining_qty > 0
- OS-10: snapshot_at not null

### Shared (S-1 to S-16)
- S-1: receipt_version === '1.2.0'
- S-2: receipt_type valid
- S-3: receipt_hash 64-char hex
- S-4: wallet non-empty string
- S-5: chain non-empty string
- S-6: token_mint non-empty string
- S-7: segment_index non-negative integer
- S-8: first_event_at positive number
- S-9: last_event_at >= first_event_at
- S-10: total_bought_qty > 0
- S-11: total_bought_quote > 0
- S-12: avg_buy_quote_price > 0
- S-13: flags sorted array
- S-14: accounting_method non-empty string
- S-15: verification_status valid
- S-16: limitations object exists

## 6. Status/disclosure consistency (C-1 to C-20)

- C-1: closed_position + no disqualifiers → verified
- C-2: realized_partial + no disqualifiers → verified_partial
- C-3: open_snapshot + no disqualifiers → verified_snapshot
- C-4: disqualifying flag → unverified
- C-5: limitations.receipt_scope === receipt_type
- C-6: closed_position → pnl_type === 'realized_closed'
- C-7: realized_partial → pnl_type === 'realized_partial'
- C-8: open_snapshot → pnl_type === 'none'
- C-9: open_snapshot → price_source === 'none'
- C-10: NOT open_snapshot → price_source === 'on_chain_swaps'
- C-11: 'no_usd_normalization' always in disclosures
- C-12: realized_partial → 'position_open' in disclosures
- C-13a: open_snapshot → 'no_pnl_claim' in disclosures
- C-13b: open_snapshot → 'no_live_price' in disclosures
- C-14: mixed_quote flag → 'mixed_quote_currencies' in disclosures
- C-15: partial_history flag → 'partial_trade_history' in disclosures
- C-16: unsupported_inventory flag → 'unsupported_inventory' in disclosures
- C-17: external_transfer_possible flag → 'external_transfer_possible' in disclosures
- C-18: display_status matches verification_status lookup
- C-19: limitations.valuation_currency === 'raw_quote'
- C-20: no phantom disclosures

## 7. Reporting

Violations are structured: `{rule, message, severity}`. Severity: error or warn. `pass` is false if any error-severity violation.

## 8. Tests

~70 tests in `receipt-verifier.test.mjs`. Inline harness.

## 9. Pipeline integration

Static import. Verify block inside `--ledger-debug` guard after v1.2 receipt write. Output: `data/debug/ledger-verify-v12.json`.

## 10. Deferred

- v1.1 cross-reference
- candidate_hash traceability (B4)
- full re-derivation from raw events (B4/B5)
- live price / USD normalization
- PNG rendering
- on-chain PDA / mint verification
- verifier CLI (B4)
