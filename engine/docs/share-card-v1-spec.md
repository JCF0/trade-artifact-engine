# Artifact Share Card v1 — Slice 1A View-Model Specification

Status: implemented by `engine/src/share-card/share-card-view-model.mjs`.

This document is normative for Share Card v1 and supersedes the preliminary Slice 1 boundary in `engine/docs/inventory_spec.md`. Slice 1A builds data only. It does not render HTML, SVG, or PNG and does not generate or publish public-demo artifacts.

## Scope

A Share Card v1 is a deterministic, receipt-scoped summary of one verified closed position with verified canonical raw-quote economics. It is not a wallet, profile, portfolio, ranking, or track-record view.

The builder consumes only values already supplied by its caller:

1. one validated inventory receipt;
2. token display metadata resolved separately by full mint; and
3. explicit proof and verifier destinations.

It does not reopen archive or economics files. It performs no provider lookup, recovery, wallet-history access, currency conversion, upload, minting, signing, or network request.

Production acceptance is a separate, read-only boundary. Run it with explicit store roots:

```bash
node engine/src/share-card/check-production-share-cards.mjs \
  --engine-root engine \
  --archive-root engine/data/inventory/receipt-archive-v1 \
  --economics-root engine/data/inventory/receipt-economics-v1
```

The checker loads archive-backed inventory through the inventory API, resolves the static token registry, and fails unless the published JUP and RAY hashes match their complete expected Share Card economics and remain eligible. It performs no writes or network calls and emits no wallet identity or transaction signatures.

## API

```js
buildShareCardViewModel(inventoryReceipt, {
  tokenDisplayMetadata,
  links: {
    proof_href,
    verifier_href,
  },
})
```

No other option is accepted. In particular, `walletDisplayMode` is not part of this API, and the result never contains `wallet_display`.

The function returns a deeply frozen object and does not mutate any input.

## Eligibility and stable errors

All failures use `ShareCardEligibilityError` with a stable `code`.

Validation is fail-closed:

| Code | Condition |
| --- | --- |
| `invalid_options` | Options or link fields are missing or unexpected. |
| `receipt_type_not_eligible` | `receipt_type` is not exactly `closed_position`. |
| `receipt_not_verified` | `verification_status` is not exactly `verified`, or `display_status` is not exactly `Verified Closed Position`. |
| `canonical_economics_not_verified` | Economics are missing, status is not `verified`, or source is not `receipt_economics_v1`. |
| `invalid_receipt_identity` | Receipt hash, receipt ID, or token mint is missing or malformed. |
| `invalid_quote_asset` | Canonical quote mint or quote symbol is missing. |
| `invalid_event_bounds` | Opened or closed receipt event time is not a finite canonical number. |
| `token_metadata_mismatch` | Token metadata is absent or its full mint differs from `inventoryReceipt.token_mint`. |
| `invalid_token_metadata` | Display metadata has no typed display, or symbol metadata is internally inconsistent. |
| `invalid_proof_link` | `proof_href` is missing, malformed, unsafe, or a machine path. |
| `invalid_verifier_link` | `verifier_href` is missing, malformed, unsafe, or a machine path. |
| `invalid_canonical_economics` | A required canonical numeric/accounting field is missing or invalid. |

Token metadata affects receipt eligibility only through exact full-mint matching. Symbol metadata and a valid `mint_prefix` fallback are equally eligible.

## Link policy

Each destination must be a non-empty explicit relative reference, root-relative reference, or credential-free HTTPS URL.

Rejected forms include:

- `javascript:`, `data:`, `file:`, HTTP, and other non-HTTPS schemes;
- protocol-relative URLs;
- username/password URL credentials;
- fragment-only or query-only references;
- Windows drive paths, UNC paths, backslashes, control characters, and common absolute machine roots;
- embedded relative traversal after a destination path has begun; and
- percent-encoded dot, slash, or backslash path segments that could conceal traversal.

Leading relative traversal such as `../verifier/receipt.json` is permitted for deterministic static-site layouts. Links are copied exactly; the view-model neither discovers nor rewrites them.

## Return contract

```js
{
  share_card_version: "share_card_v1",

  identity: {
    receipt_hash,
    receipt_hash_short,
    receipt_id,
    base_asset: {
      mint,
      display,
      display_kind,
      symbol?,
      name?,
    },
    quote_asset: {
      mint,
      symbol,
    },
    pair_display,
  },

  status: {
    position: "closed",
    verification: "verified",
    verification_label: "Verified by Artifact",
  },

  hero: {
    realized_pnl_quote: {
      value,
      quote_symbol,
      direction: "positive" | "negative" | "flat",
    },
    realized_pnl_pct: {
      value,
      direction: "positive" | "negative" | "flat",
    },
  },

  trade_summary: {
    avg_entry_quote_price,
    avg_exit_quote_price,
    opened_at,
    closed_at,
    hold_time_seconds,
  },

  accounting_summary: {
    quantity_closed,
    entry_cost_quote,
    exit_proceeds_quote,
    accounting_method,
    num_buys,
    num_sells,
  },

  proof: {
    receipt_id,
    receipt_hash,
    receipt_hash_short,
    quote_scope: "raw_quote",
    receipt_scope: "receipt_only",
  },

  badges: [
    "Closed Position",
    "Verified",
    "Raw Quote",
    "Receipt Scoped",
  ],

  disclosure:
    "Receipt-scoped only. Raw quote only. Not wallet or portfolio performance.",

  links: {
    proof_href,
    verifier_href,
  },
}
```

`receipt_hash_short` is the first 12 and final 12 hash characters separated by `...`. This preserves 24 of the 64 canonical hash characters and is deterministic on every platform.

For `display_kind: "symbol"`, `symbol` is present and `name` is copied when provided. For `display_kind: "mint_prefix"`, both properties are omitted even if an untrusted caller supplied them. A mint prefix is display text, never a symbol.

## Canonical field mapping

| Share Card field | Canonical input |
| --- | --- |
| `quantity_closed` | `canonical_economics.fields.total_sold_qty` |
| `entry_cost_quote` | `canonical_economics.fields.allocated_cost_basis_quote` |
| `exit_proceeds_quote` | `canonical_economics.fields.total_sold_quote` |
| `avg_entry_quote_price` | `canonical_economics.fields.avg_buy_quote_price` |
| `avg_exit_quote_price` | `canonical_economics.fields.avg_sell_quote_price` |
| `realized_pnl_quote.value` | `canonical_economics.fields.realized_pnl_quote` |
| `realized_pnl_pct.value` | `canonical_economics.fields.realized_pnl_pct` |
| `opened_at` | `inventoryReceipt.first_event_at` |
| `closed_at` | `inventoryReceipt.last_event_at` |
| `hold_time_seconds` | `canonical_economics.fields.hold_time_seconds` |
| `accounting_method` | `canonical_economics.fields.accounting_method` |
| `num_buys` | `canonical_economics.fields.num_buys` |
| `num_sells` | `canonical_economics.fields.num_sells` |

Numeric values are copied exactly as JavaScript numbers. Slice 1A does not round, format, estimate, recompute accounting, or convert currency. Direction is derived only by comparing each realized PnL value with zero.

`pair_display` is `${tokenDisplayMetadata.display}/${inventoryReceipt.quote_symbol}`. Neither component is inferred from board labels, receipt IDs, or mint prefixes.

## Excluded data

Share Card v1 does not expose:

- wallet identity or wallet display modes;
- profile, portfolio, ranking, or track-record fields;
- provider or recovery provenance;
- recovery methods or evidence paths;
- machine paths;
- raw transaction bodies;
- entry or exit transaction hashes;
- upload, mint, or signing fields;
- USD-normalized values;
- `null`, `N/A`, estimated, or fabricated placeholders.

## Determinism and immutability

The output property order is constructed explicitly and does not depend on input insertion order. No platform line endings, locale defaults, current time, random values, or machine paths participate. The complete returned object graph is deeply frozen, while all output containers are newly constructed from selected scalar input values.

## Proposed Slice 1B formatting boundary

Slice 1B should remain pure and preserve Slice 1A raw values:

```js
formatShareCardViewModel(shareCardViewModel, {
  number_format_version: "artifact_number_v1",
  date_format_version: "artifact_utc_date_v1",
})
```

Only those pinned versions should be accepted. The formatter should return a deeply immutable presentation model containing explicit display strings alongside, not instead of, the raw canonical values. It must not accept ambient locale or timezone defaults: decimal punctuation, precision rules, sign handling, and UTC date grammar belong to the named format versions.

## Proposed Slice 1C renderer boundary

Slice 1C should accept only the validated Slice 1B presentation model:

```js
renderShareCardHtml(formattedShareCardViewModel)
```

It should return one deterministic HTML string, perform contextual escaping, use only the supplied explicit links, and contain no network access, remote assets, scripts, archive reads, token lookup, accounting, eligibility decisions, or data formatting. Rendering must not mutate its input.
