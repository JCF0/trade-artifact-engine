# Artifact Share Card v1 — Slice 1A/1B/1C Model, Formatting, and HTML Specification

Status: implemented by `engine/src/share-card/share-card-view-model.mjs`, `engine/src/share-card/share-card-format.mjs`, and `engine/src/share-card/share-card-html.mjs`.

This document is normative for Share Card v1 and supersedes the preliminary Slice 1 boundary in `engine/docs/inventory_spec.md`. Slice 1A builds canonical data, Slice 1B adds deterministic display strings without replacing or changing that data, and Slice 1C renders those strings as deterministic standalone HTML. No slice renders SVG or PNG or generates or publishes public-demo artifacts.

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

The checker loads archive-backed inventory through the inventory API, resolves the static token registry, formats the resulting models, renders both HTML documents in memory with `/assets/artifact-logo-header.png`, and fails unless the published JUP and RAY hashes match their complete expected Share Card economics, exact display strings, and pinned HTML SHA-256 values. The logo filename is the existing deterministic public-demo header asset derived from `engine/assets/brand/artifact-logo-final-whitebg.png`; Slice 1C references but does not derive or read it. The checker performs no writes or network calls and emits no wallet identity or transaction signatures.

## Slice 1A builder API

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

## Slice 1B formatter API

```js
formatShareCardViewModel(shareCardViewModel, {
  number_format_version = "artifact_number_v1",
  date_format_version = "artifact_utc_date_v1",
} = {})
```

The formatter accepts only an unformatted model whose `share_card_version` is exactly `share_card_v1` and whose fixed Slice 1A shape, receipt-scoped identity/proof invariants, and safe-link policy remain intact. Unexpected fields fail closed rather than crossing the formatting boundary. Only the two named format profiles are supported. It returns a deterministic deep clone of the complete Slice 1A model with `display` and `formatting` appended, deeply freezes the entire result, and leaves the input unmodified. Canonical numbers in the cloned model remain JavaScript numbers with their exact original values; display strings are additive.

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

Numeric values are copied exactly as JavaScript numbers. Slice 1A does not round, format, estimate, recompute accounting, or convert currency. Direction is derived only by comparing each realized PnL value with zero. Slice 1B does not change those values or recalculate accounting; it reads them only to create the versioned display strings described below.

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

## Slice 1B return additions

The formatter appends these fixed-order objects after the cloned Slice 1A fields:

```js
{
  ...deeplyClonedShareCardV1,

  display: {
    pair,
    realized_pnl_quote,
    realized_pnl_pct,
    avg_entry_quote_price,
    avg_exit_quote_price,
    quantity_closed,
    entry_cost_quote,
    exit_proceeds_quote,
    opened_at,
    closed_at,
    duration,
    receipt_hash_short,
  },

  formatting: {
    number_format_version: "artifact_number_v1",
    date_format_version: "artifact_utc_date_v1",
  },
}
```

Input object insertion order does not affect serialized output. Objects are cloned in stable key order, arrays retain their element order, and `display` and `formatting` use the order above.

## `artifact_number_v1`

This profile is implemented without `Intl`, `toLocaleString`, or any host-locale API. It uses comma thousands grouping, a period decimal separator, and plain decimal notation only. Decimal precision is rounded half up from the JavaScript number's deterministic shortest decimal representation. It removes trailing fractional zeroes except for fields that require two fixed decimals. Numeric negative zero has a zero display sign.

- Realized quote PnL has two decimals, a sign only when the canonical value is positive or negative, and the quote symbol: `+8,287.84 USDC`, `-125.40 USDC`, `0.00 USDC`.
- Realized PnL percentage has two decimals and the same sign policy: `+16.67%`, `-4.25%`, `0.00%`.
- Entry and exit prices use up to six decimals below 1, up to four decimals from 1 through 999, and up to two decimals at 1000 or above. Trailing zeroes are removed. If a nonzero value would display as zero, precision increases one place at a time through twelve decimals. A value still unrepresentable at twelve decimals is rejected rather than displayed as zero.
- Quantity closed uses up to six decimals, removes trailing zeroes, uses comma grouping, and appends `identity.base_asset.display`. A `mint_prefix` remains prefix display text and is never promoted to a symbol.
- Entry cost and exit proceeds use two decimals and append the quote symbol.
- No field uses scientific notation, USD conversion, `$`, `N/A`, approximation, or estimated-value markers.

## `artifact_utc_date_v1`

`trade_summary.opened_at` and `closed_at` are interpreted as Unix seconds and rendered exclusively with UTC `Date` getters in `YYYY-MM-DD HH:mm UTC` form. Fractional, unsafe, invalid, and dates outside four-digit UTC years are rejected. Host timezone and locale settings do not participate.

Duration is derived only from canonical `trade_summary.hold_time_seconds`; timestamps are not subtracted. It rejects negative, fractional, and unsafe values. Its compact grammar omits leading zero units and pads subordinate units to two digits after a higher unit appears:

- `26s`
- `12m 05s`
- `3h 04m 09s`
- `1d 21h 42m 26s`

## Slice 1B stable errors

All formatter failures use `ShareCardFormatError` with one of these stable codes:

| Code | Condition |
| --- | --- |
| `invalid_share_card_model` | Input is not an exact unformatted `share_card_v1` model, fixed identity/status/proof/link invariants are inconsistent, options contain unsupported keys, or cloning encounters unsupported values. |
| `unsupported_number_format_version` | `number_format_version` is not `artifact_number_v1`. |
| `unsupported_date_format_version` | `date_format_version` is not `artifact_utc_date_v1`. |
| `invalid_numeric_value` | A required display number is missing, non-finite, negative where prohibited, or a nonzero price cannot be represented within twelve decimal places. |
| `invalid_timestamp` | A timestamp is fractional, unsafe, invalid, or outside the supported UTC range. |
| `invalid_duration` | `hold_time_seconds` is negative, fractional, or unsafe. |
| `invalid_asset_display` | Base/quote display metadata, pair display, or quote symbol binding is missing or inconsistent. |

## Exact production formatting acceptance

The production checker pins these display summaries:

- JUP: `JUP/USDC`; `+8,287.84 USDC`; `+16.67%`; `0.186984 USDC`; `0.218147 USDC`; `265,951.319268 JUP`; `49,728.69 USDC`; `58,016.53 USDC`; `1d 21h 42m 26s`.
- RAY: `RAY/USDT`; `+2,347.72 USDT`; `+9.39%`; `0.93827 USDT`; `1.0264 USDT`; `26,644.791399 RAY`; `25,000.00 USDT`; `27,347.72 USDT`; `2d 21h 32m 55s`.

## Slice 1C renderer API

```js
renderShareCardHtml(formattedShareCardViewModel, {
  logo_href,
})
```

The options object is closed and requires exactly one `logo_href`. The logo destination must be a traversal-free local relative or root-relative path. Remote and protocol-relative URLs, URL schemes, credentials, Windows or UNC paths, common absolute machine roots, encoded traversal, query-only references, and fragment-only references fail closed. The renderer neither discovers nor reads the logo asset.

The input must have the exact validated Slice 1B shape, `share_card_version: "share_card_v1"`, `formatting.number_format_version: "artifact_number_v1"`, and `formatting.date_format_version: "artifact_utc_date_v1"`. Every fixed identity, proof, status, badge, scope, disclosure, pair, hash-shortening, and display binding is revalidated at this immediate boundary. Unexpected keys, symbols, accessors, custom prototypes, malformed arrays, unsupported values, and directions inconsistent with their retained canonical values are rejected. Quote and percentage directions remain independently valid; the renderer uses their supplied validated directions and never derives visible display strings from raw values.

Slice 1C returns one deterministic UTF-8 HTML string beginning with `<!doctype html>`, using LF line endings, and ending in a newline. It consumes only Slice 1B `display` strings for visible economics, dates, and duration. It does not reformat raw values, recompute direction or accounting, read the token registry, perform I/O, or mutate its input.

## Slice 1C HTML contract

- At viewports 1200 CSS pixels wide or wider, the primary root is exactly 1200 × 630 CSS pixels, has `aspect-ratio: 1200 / 630`, and carries `data-share-card-version="share_card_v1"`.
- Intermediate viewports from 801 through 1199 CSS pixels may scale that fixed desktop composition. At 800 CSS pixels and below, the fixed dimensions, aspect ratio, clipping, and transform are removed: the document uses natural height, stacked header/body/footer regions, two-column statistics, wrapping status treatments, and large tap targets. At 430 CSS pixels and below, proof actions stack. Mobile typography is reflowed rather than proportionally scaled.
- The document uses inline CSS, the Artifact navy/electric-blue palette, system sans-serif fonts, and monospace only for receipt ID and shortened receipt hash.
- Positive PnL uses verified green, negative PnL uses negative red, and flat PnL uses neutral gray. The independent verification badge remains green for every direction.
- Header content is the supplied local Artifact logo, `Artifact`, the formatted pair, `Closed Position`, and `Verified by Artifact`.
- The hero renders the formatted realized quote PnL and percentage with the `Raw Quote` scope label.
- Labelled primary statistics are Average Entry, Average Exit, Opened, Closed, and Duration. Labelled secondary statistics are Quantity Closed, Entry Cost, and Exit Proceeds.
- The proof footer renders receipt ID, shortened receipt hash, `Receipt Scoped`, the exact disclosure, and descriptive `View Proof` and `Verify Receipt` links.
- HTTPS proof or verifier links retain their validated bytes and receive `rel="noopener noreferrer"`. Local links do not receive an external-link relation.
- All dynamic text and attribute values are escaped. Dynamic values never become markup.
- The logo has alt text, link accessible names identify the receipt, headings label the hero and statistic groups, and statistics use description-list semantics.
- The document includes UTF-8, viewport, and `<meta name="robots" content="noindex,nofollow">` metadata. It has no Open Graph metadata.
- There is no JavaScript, event-handler attribute, remote font/style/image/resource, analytics, wallet identity, transaction signature, provider data, recovery provenance, evidence path, source path, machine path, USD conversion, `$`, placeholder, QR code, or fabricated metadata.

The only external resource reference is the supplied local logo path. Proof and verifier anchors are navigation destinations, not fetched resources.

## Slice 1C stable errors

All renderer failures use `ShareCardHtmlError` with one of these stable codes:

| Code | Condition |
| --- | --- |
| `invalid_formatted_share_card` | Input/options are not exact plain data shapes, required fixed invariants fail, or raw retained values are malformed. |
| `unsupported_share_card_version` | `share_card_version` is not `share_card_v1`. |
| `unsupported_formatting_profile` | Either formatting profile is not the required Slice 1B v1 profile. |
| `invalid_logo_link` | `logo_href` is missing, malformed, remote, scheme-bearing, traversal-bearing, or machine-local. |
| `invalid_display_value` | A required Slice 1B display string is missing, empty, or not trimmed. |
| `invalid_link` | A proof or verifier destination no longer satisfies the validated Share Card link policy. |
| `unsafe_html_value` | A rendered value contains controls or malformed Unicode that cannot be represented safely. |

## Exact production HTML acceptance

With `logo_href: "/assets/artifact-logo-header.png"`, production rendering is pinned to:

- JUP HTML SHA-256: `36a7d18426aaeb67290932eb2d70439bb4812f0245cb5d038150b0d7f2455027`
- RAY HTML SHA-256: `ded1a0e200213e11aa761272535f23050ea40c7f0023b85cc34e226efdcf40c8`

The production checker retains both documents only in memory, confirms every exact expected display string, and audits wallet values, transaction signatures, scripts, event handlers, remote resources, provider/recovery terms, and machine paths. It does not write generated HTML to production or public-demo paths.

## Proposed Slice 1D static public-demo integration

Slice 1D should remain a separate filesystem boundary. It can map each approved receipt to a stable route such as `/share/<receipt-hash>/index.html`, keep proof navigation at `/receipts/<receipt-hash>/` and verifier navigation at `/verify/<receipt-hash>/`, and reuse the existing derived public-demo logo at `/assets/artifact-logo-header.png`. The bundle writer should render in memory first, write only into its explicit output root, include the new routes and existing logo in the static inventory/predeploy checks, and verify deterministic bytes plus leak policy before publishing. Page-level Open Graph metadata belongs in that integration layer, not in the Slice 1C card document. Browser capture and new image generation remain out of scope unless approved as a later isolated slice.
