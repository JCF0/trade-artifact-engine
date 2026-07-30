# Bounded Solana acquisition v1

## Scope and capability boundary

Slice 8A adds a provider-neutral acquisition contract and a Helius Enhanced Transactions adapter. It produces the exact normalized event vocabulary consumed by `targeted_receipt_orchestration_v1`; it does not construct, store, publish, render, upload, mint, sign, deploy, or modify a receipt package. Raw provider values remain inside the adapter.

The provider-neutral entry point is:

```js
await acquireNormalizedSolanaSpotEventsV1(request, {
  acquisitionPort
})
```

An adapter created by `createHeliusEnhancedTransactionsAcquisitionAdapter()` is also an `acquisitionPort` and directly exposes:

```js
await acquisitionPort.acquireNormalizedSolanaSpotEventsV1(request)
```

The neutral contract imports no provider, network, filesystem, package-store, archive/economics, upload, mint, signing, or deployment capability. The Helius adapter has exactly five injected capabilities: `httpClient`, `apiKeyProvider`, `sleep`, `clock`, and `random`. It never uses global `fetch`.

## Closed request

The request has exactly these fields:

```js
{
  wallet,
  target: {
    token_mint,
    receipt_type: 'closed_position',
    segment_index
  },
  bounds: {
    before_signature: null | string,
    oldest_allowed_timestamp,
    newest_allowed_timestamp,
    max_pages,
    max_transactions,
    request_timeout_ms,
    overall_timeout_ms,
    max_attempts_per_page
  },
  fetch_profile: 'receipt_scoped_transaction_selection_v1',
  normalization_profile: 'artifact_solana_spot_normalization_v1'
}
```

Wallet and target mint must be base58 Solana addresses decoding to 32 bytes. Segment and timestamps are non-negative safe integers, and the oldest timestamp cannot exceed the newest. Every bound is a positive safe integer except `before_signature`; per-request timeout is strictly less than the overall timeout.

`before_signature` is an exclusive upper history cursor and therefore part of the requested acquisition scope: when non-null, transactions at or newer than that cursor are intentionally outside this call. A first scan for a new receipt must use `null` so it discovers all relevant history inside the timestamp bounds. Resumed calls may use a previously approved cursor; a provider page that echoes the supplied cursor fails as `pagination_cursor_repeated`. Completeness for a non-null cursor proves only the requested suffix strictly before that cursor, never the skipped newer prefix.

The conservative v1 ceilings are 100 pages, 10,000 transactions, 60,000 ms per request, 300,000 ms overall, and 8 attempts per logical page. The profiles are exact frozen identifiers. Unknown fields, symbols, accessors, non-enumerable fields, custom/null prototypes, and malformed nested request objects are rejected before a capability is called. The API key is not part of this request.

## Closed success result

Only a proven complete acquisition returns:

```js
{
  normalizedEvents,
  inputStatus: {
    acquisition_complete: true,
    normalization_complete: true,
    pagination_complete: true,
    truncated: false,
    capped: false,
    partial: false,
    provider_uncertain: false
  },
  acquisitionSummary: {
    pages_read,
    transactions_read,
    normalized_event_count,
    oldest_observed_timestamp,
    newest_observed_timestamp,
    pagination_terminal_reason,
    retry_count,
    timeout_count
  }
}
```

`oldest_observed_timestamp` and `newest_observed_timestamp` are null only when no transaction was returned. `pagination_terminal_reason` is exactly `provider_exhaustion` or `historical_bound_reached`. The result is detached from inputs and deeply frozen. No raw page, provider response, URL, API key, retry error, cause, path, or package/public-proof value is retained.

The neutral result boundary also rejects contradictory provenance: at least one page must have been read; page, transaction, and retry counts must remain inside the request budgets; timeout count cannot exceed retry count; observed timestamps must be jointly null or ordered; historical-bound completion requires an observed timestamp strictly older than the bound; and every normalized event must fall inside both the request window and observed range, affect the target mint, use its dense array index as `raw_index`, and be included in the summary counts.

`acquisitionSummary` is operational provenance only. Slice 7 receives `normalizedEvents` and `inputStatus`; summary, pagination, and retry history do not enter receipt or package identity.

## HTTP and API-key capabilities

The injected client has one method:

```js
await httpClient.request({
  method: 'GET',
  url: `https://api.helius.xyz/v0/addresses/${wallet}/transactions`,
  query: {
    'api-key': apiKey,
    before: null | signature,
    limit: 100
  },
  timeout_ms
})
```

It returns the narrow typed envelope `{ status, data }`; `data` is already parsed JSON. The adapter does not accept a browser `Response`. A client-side JSON parse failure must throw a data-property code `invalid_json`. Diagnostics never copy the request URL, query, key, provider body, or raw error. The key provider is a synchronous presence capability returning a non-empty string; promises and malformed values fail as `api_key_unavailable`. The overall acquisition clock starts before this capability is invoked and is checked again before any HTTP request. Query-string credentials exist only in the injected request capability and are absent from all returned values and errors.

## Page validation and completeness proof

Helius history is requested in fixed pages of 100, newest first. Each page is completely validated before its transactions are appended:

- the body is an ordinary dense array of at most 100 entries;
- every recursively retained value is plain data with ordinary prototypes, data properties, and no symbols, sparse/decorated arrays, cycles, or invalid numbers;
- every transaction has a non-empty signature and non-negative safe-integer timestamp;
- timestamps never increase within or across pages;
- signatures are unique within and across pages;
- duplicate identities with unequal bodies fail;
- a continuation cursor exists only for a full page and is derived from its validated final transaction;
- repeating a cursor fails; and
- a wrapper object, HTML/string body, invalid JSON, malformed transaction, or empty intermediate page is never interpreted as exhaustion.

Completeness is proven by exactly one condition:

1. `provider_exhaustion`: the first or later valid terminal page contains fewer than 100 transactions. A zero-length first page is valid exhaustion; a zero-length page after a full page is ambiguous and fails.
2. `historical_bound_reached`: monotonic validated history includes at least one transaction older than `oldest_allowed_timestamp`. Because the page is descending and every earlier page was fully validated, every transaction in the requested time window has then been fetched and considered.

A full page implies more history and requires another request unless the historical bound was reached. Reaching `max_pages` or `max_transactions` before either proof throws `acquisition_capped`; caps are never successful completion. Timeout, exhausted retries, ordering faults, malformed pages, cursor loops, and uncertain provider outcomes also throw rather than returning partial events or favorable status flags.

## Retry and timeout policy

A retry is allowed only for a request-timeout classification (`request_timeout` or `ETIMEDOUT`), HTTP 429, HTTP 500–599, or the explicit transport classification `transient_transport`. HTTP 400 maps to `provider_request_invalid`; 401/403 map to `provider_auth_failed`. Invalid JSON, malformed HTTP/page envelopes, normalization failures, cursor/order faults, and all other deterministic failures are not retried.

Attempts for one logical page always use the same wallet, cursor, limit, and bounds. The maximum is `max_attempts_per_page`. Backoff is exponential from 100 ms, capped at 5 seconds, plus injected jitter in `[0, 100)` ms. Every attempt has `request_timeout_ms`; the adapter checks the injected monotonic clock before and after requests and before backoff. A request timeout increments `timeout_count`, and each scheduled retry increments `retry_count`. A timeout never proves exhaustion. No response from a failed or uncertain attempt is concatenated with a later attempt.

## Receipt-scoped normalization

The adapter scans complete bounded wallet history; it does not fetch only known entry/exit hashes. Selection is deterministic:

1. Consider every validated transaction with timestamp inside the inclusive requested window.
2. A supported structured target event is a Helius `SWAP` whose `events.swap` has one or more token inputs of one mint and exactly one token output. Every leg must be owned by the exact requested wallet, all input decimals must agree, and exactly one economic side must equal the target mint. Same-mint input raw quantities are summed as integers before decimal normalization, so leg order cannot affect the event.
3. A `SWAP` without usable structured evidence may use validated wallet token-transfer evidence. A non-`SWAP` classification, including `CLOSE_ACCOUNT`, may use that fallback only when a recognized Jupiter/Raydium/Orca program occurs in the transaction instructions. The fallback requires one input mint after same-mint input aggregation and exactly one output leg; direction comes only from `fromUserAccount`/`toUserAccount` equality with the requested wallet. A sufficiently large net native transfer may supply a missing SOL side, matching the existing Artifact quote-path behavior.
4. Require a non-empty source, different input/output mints, positive exactly representable raw quantities, and safe decimals from 0 through 255. Structured swaps additionally require the exact wallet as fee payer.
5. Emit at most one event per qualifying source transaction.
6. Sort selected events ascending by timestamp and then code-unit transaction-signature order; assign dense `raw_index` values from zero after sorting. This makes event order independent of provider page chunking and unrelated transactions.

The emitted object has exactly Slice 7's fields:

```text
wallet, timestamp, tx_hash, source,
token_in_mint, token_in_amount, token_in_decimals,
token_out_mint, token_out_amount, token_out_decimals,
extraction_method, raw_index
```

`extraction_method` is `helius_enhanced_transaction_swap_v1`.

An activity is ignored only when its fully validated evidence does not mention the target mint. A target-relevant non-swap without recognized DEX evidence, an account closure without two-sided trade evidence, a target mention outside supported economic evidence, or other unsupported target activity throws `unsupported_target_activity`. Mixed input mints/decimals, multiple outputs, malformed amounts, uncertain direction, self-transfers, or uncertain wallet ownership throw `normalization_ambiguous`. Account closure alone is never a trade. Thus potentially position-affecting target evidence is never silently discarded. Provider fixtures are cloned and remain unmodified.

Unrelated events do not enter the selected receipt package. Provider source labels, page boundaries, retries, and summaries remain outside package identity. The package still binds only Slice 7's frozen profiles and selected receipt facts.

## Stable acquisition errors

All public failures are `BoundedAcquisitionError` values with a stable code and sanitized message/details, no `cause`, and no retained raw provider response, credential-bearing URL, API key, filesystem path, or hostile provider error:

- `invalid_acquisition_request`
- `acquisition_capability_denied`
- `api_key_unavailable`
- `provider_auth_failed`
- `provider_request_invalid`
- `provider_transient_failure`
- `provider_retry_exhausted`
- `provider_timeout`
- `acquisition_deadline_exceeded`
- `malformed_provider_page`
- `pagination_cursor_repeated`
- `pagination_order_invalid`
- `pagination_terminal_ambiguous`
- `acquisition_capped`
- `acquisition_truncated`
- `acquisition_incomplete`
- `normalization_failed`
- `normalization_ambiguous`
- `unsupported_target_activity`

The timeout/truncation codes are reserved stable v1 vocabulary for capability implementations that can prove those specific adverse outcomes; this adapter currently reports exhausted retry budgets as `provider_retry_exhausted`, deadline failure as `acquisition_deadline_exceeded`, and never converts truncation into a result.

## Proposed Slice 8B controlled live Helius probe

Slice 8B should remain an operator-approved diagnostic, not a production package writer:

1. Add a separate CLI that imports this adapter and no package store, archive/economics writer, uploader, signer, minter, renderer, or deploy module.
2. Require explicit wallet, target mint, inclusive timestamps, cursor, and all caps on the command line. Default to deny; do not infer a wallet, key, or production root.
3. Read the API key through a process-local provider, check presence only, and install a logger that structurally redacts `api-key` query values. Never print request objects, raw pages, response bodies, or raw errors.
4. Use a narrow real HTTP client that parses exactly one response per attempt, enforces abort-based per-attempt timeout, classifies only the retry cases documented above, and returns `{ status, data }`.
5. Start with `max_pages=1`, a small `max_transactions`, `max_attempts_per_page=1`, and a short approved historical interval. A full page must intentionally fail capped; it must not be called success.
6. On operator approval, increase bounds in a second run only enough to reach provider exhaustion or the historical bound. Record sanitized counts, terminal reason, retry/timeout counts, and a digest of the normalized result—not raw provider bodies.
7. Run Slice 7 only in `dry_run`, without `expected_receipt_hash` for a newly discovered receipt and with no package-store port. Compare repeated dry runs for identical normalized events, receipt hash, and package digest.
8. Keep raw probe evidence, if separately approved, in an isolated non-repository temporary location with restrictive permissions and a declared deletion policy. Slice 8B itself should not write production package/public-proof roots.
9. Require a global-fetch/network guard in all unit and integration tests; only the explicitly invoked live-probe CLI may instantiate the real HTTP client.
10. Stop on every cap, timeout, uncertain commit/transport classification, malformed page, unsupported target activity, or normalization ambiguity. Do not retry the whole acquisition as a substitute for page-level deterministic retry rules.
