# Metadata Specification V1

**Version:** 1.0
**Status:** Implemented

This specification reflects the current devnet implementation and may evolve before mainnet deployment.

---

## Overview

Each minted trade receipt has three files stored on Arweave (via Irys) plus on-chain data. This spec defines the structure and relationships between them.

---

## 1. File Inventory (Per Receipt)

| File | Content-Type | Purpose |
|---|---|---|
| Receipt Card PNG | `image/png` | Rendered visual receipt (800×520px) |
| Receipt JSON | `application/json` | Full TradeReceipt object with all fields |
| NFT Metadata JSON | `application/json` | Metaplex-compatible metadata for wallet display |

Upload order matters: **PNG first** (its URI goes into metadata), **receipt JSON second** (its URI goes into metadata), **NFT metadata last**.

---

## 2. NFT Metadata JSON Schema

Follows the Metaplex Token Metadata standard for compatibility with Solana wallets and explorers.

```json
{
  "name": "Trade Receipt #0004 DitHyRMQ",
  "symbol": "TREC",
  "description": "Verified trade receipt: DitHyRMQ / USDC on Solana. PnL: +42.903%",
  "image": "https://gateway.irys.xyz/{png_irys_id}",
  "external_url": "https://gateway.irys.xyz/{receipt_json_irys_id}",
  "attributes": [
    { "trait_type": "wallet", "value": "<base58 wallet>" },
    { "trait_type": "token_mint", "value": "<base58 mint>" },
    { "trait_type": "chain", "value": "solana" },
    { "trait_type": "realized_pnl_pct", "value": 42.903, "display_type": "number" },
    { "trait_type": "status", "value": "verified" },
    { "trait_type": "quote_currency", "value": "USDC" },
    { "trait_type": "hold_time_seconds", "value": 400162, "display_type": "number" },
    { "trait_type": "num_buys", "value": 4, "display_type": "number" },
    { "trait_type": "num_sells", "value": 1, "display_type": "number" },
    { "trait_type": "opened_at", "value": 1747460769, "display_type": "date" },
    { "trait_type": "closed_at", "value": 1747860931, "display_type": "date" }
  ],
  "properties": {
    "receipt_version": "1.0",
    "verification_hash": "<64-char hex>",
    "accounting_method": "weighted_average_cost_basis",
    "receipt_json": "https://gateway.irys.xyz/{receipt_json_irys_id}"
  }
}
```

### Field Derivation

| Metadata Field | Source |
|---|---|
| `name` | `receipt_id` with `receipt_` → `#`, underscores → spaces |
| `symbol` | Always `"TREC"` |
| `description` | Template: `"Verified trade receipt: {token8} / {quoteSymbol} on Solana. PnL: {±pnl_pct}%"` |
| `image` | Irys gateway URL of the uploaded PNG |
| `external_url` | Irys gateway URL of the full receipt JSON |
| `attributes[].value` | Directly from receipt fields |
| `properties.verification_hash` | From `receipt.verification_hash` |
| `properties.receipt_json` | Same as `external_url` |

### Quote Currency Display

| Receipt `quote_currency` | Metadata display |
|---|---|
| `So11111111111111111111111111111111111111112` | `"SOL"` |
| `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `"USDC"` |
| `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `"USDT"` |
| `"MIXED"` | `"MIXED"` |
| Other | First 8 characters of the mint address |

---

## 3. `metadata_hash` Computation

The `metadata_hash` stored in the on-chain PDA is the SHA-256 of the **exact bytes** of the NFT Metadata JSON file as uploaded to Arweave.

```javascript
const metadataJsonString = JSON.stringify(nftMetadataObject, null, 2);
const metadataHash = createHash('sha256').update(metadataJsonString).digest('hex');
```

### Purpose

- Binds the on-chain anchor to the exact off-chain metadata content
- Survives hosting changes (if Irys URIs change, the hash still validates)
- A verifier can download metadata from any source and confirm it matches

### Important

- The hash is computed **before upload** — over the serialized JSON string
- The JSON is pretty-printed (`null, 2` indent) — this is part of the canonical form
- Changing any field, whitespace, or ordering invalidates the hash

---

## 4. On-Chain NFT Configuration

The NFT is minted using **Token-2022** with the following extensions:

| Extension | Purpose |
|---|---|
| `NonTransferable` | Soul-bound — cannot be transferred after minting |
| `MetadataPointer` | Points to the mint account itself (self-referential) |
| `TokenMetadata` | Stores name, symbol, URI directly on the mint account |

### Token Metadata Fields

| Field | Value |
|---|---|
| `name` | Same as `nftMetadata.name` (e.g. `"Trade Receipt #0004 DitHyRMQ"`) |
| `symbol` | `"TREC"` |
| `uri` | Irys gateway URL of the NFT metadata JSON |

### Mint Properties

| Property | Value |
|---|---|
| Supply | 1 (exactly one token minted) |
| Decimals | 0 |
| Mint authority | Removed after minting (set to None) |
| Freeze authority | None |

---

## 5. Irys Upload Configuration

### Devnet

```javascript
const irys = await Uploader(Solana)
  .withWallet(Buffer.from(keypairBytes))
  .withRpc('https://api.devnet.solana.com')
  .devnet();
```

- Endpoint: `https://devnet.irys.xyz/`
- Gateway: `https://gateway.irys.xyz/{id}` (redirects to devnet)
- Funding: Not required (free on devnet). Irys devnet may allow subsidized or free uploads for testing purposes.

### Mainnet

```javascript
const irys = await Uploader(Solana)
  .withWallet(Buffer.from(keypairBytes))
  .withRpc('https://api.mainnet-beta.solana.com');
```

- Endpoint: `https://uploader.irys.xyz/`
- Gateway: `https://gateway.irys.xyz/{id}`
- Funding: Requires SOL balance on Irys. On mainnet, uploads require funding via SOL and incur a one-time permanent storage cost.

### Upload Tags

Each file is tagged for discoverability:

| Tag | Value |
|---|---|
| `Content-Type` | `image/png` or `application/json` |
| `App-Name` | `trade-artifact-engine` |
| `Receipt-Id` | `receipt_0004_DitHyRMQ` |
| `Verification-Hash` | `138e1931...` |
| `File-Type` | `receipt-render`, `receipt-data`, or `nft-metadata` |
| `Metadata-Hash` | (on nft-metadata only) SHA-256 of the file content |

---

## 6. Upload Record Schema

Persisted in `uploads.jsonl`, one JSON object per line:

```json
{
  "receipt_id": "receipt_0004_DitHyRMQ",
  "verification_hash": "138e1931...",
  "png_irys_id": "2QvoDf7UGN...",
  "png_uri": "https://gateway.irys.xyz/2QvoDf7UGN...",
  "receipt_json_irys_id": "3bjKMSr7M2...",
  "receipt_json_uri": "https://gateway.irys.xyz/3bjKMSr7M2...",
  "metadata_json_irys_id": "428USTCkd8...",
  "metadata_uri": "https://gateway.irys.xyz/428USTCkd8...",
  "metadata_hash": "6ce66bc669...",
  "uploaded_at": 1774345300,
  "network": "devnet"
}
```

---

## 7. Content Verification

Given a `metadata_uri` and a `metadata_hash` from the on-chain PDA:

1. Fetch the metadata JSON from `metadata_uri`
2. Compute SHA-256 of the raw response body
3. Compare to `metadata_hash`
4. If match → the metadata is authentic and untampered
5. Parse the metadata JSON to extract `image` and `properties.receipt_json` URIs
6. Fetch and verify those files independently
