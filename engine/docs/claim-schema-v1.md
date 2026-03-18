# TradeClaim Schema V1 — Owner Verification + Mint Authorization

**Status:** FROZEN  
**Version:** 1.0  
**Date:** 2026-03-16  

---

## Overview

A TradeClaim is a signed attestation that links a TradeReceipt to the wallet that executed the trade AND authorizes where the resulting on-chain artifact should be minted. It proves that the person presenting the receipt controls (or controlled) the trading wallet, and explicitly designates a recipient for the minted artifact.

The claim is a lightweight wrapper around the receipt's verification hash, signed by the trading wallet.

---

## Claim Flow

```
1. Engine generates TradeReceipt with verification_hash
2. Wallet owner decides where to mint (could be same wallet or a different one)
3. Wallet owner signs a canonical claim message containing:
   - The verification_hash (binds to exact trade data)
   - The claim_recipient (authorizes mint destination)
4. Claim object is created with the signature
5. Mint program verifies claim before minting artifact to claim_recipient
```

---

## Canonical Claim Message

The message to be signed is a deterministic UTF-8 string:

```
TRADE_RECEIPT_CLAIM_V1
receipt:{verification_hash}
wallet:{trader_wallet}
chain:{chain}
claim_recipient:{recipient_wallet}
```

Example:

```
TRADE_RECEIPT_CLAIM_V1
receipt:0b2d78c36cf4c2c3fb215e7b319168979fd902f72366f739550496e212231ef4
wallet:CsZLf8nuA2GL7sLX31DjFdMtF1W9hcwKakpYPxxaa4pX
chain:solana
claim_recipient:8PkeQ8GcuhJKdZveFEuyenv2KF2qvr6uvVWLoEHGiSM1
```

### Message Rules

1. Lines are separated by `\n` (LF, 0x0A). No trailing newline.
2. No spaces around `:` delimiters.
3. All values are lowercase except wallet addresses (base58 preserves case).
4. The `TRADE_RECEIPT_CLAIM_V1` prefix prevents cross-protocol replay.
5. The message is human-readable by design — wallet UIs will display it for user approval.
6. `claim_recipient` may equal `wallet` (trader mints to self) or differ (trader authorizes mint to another wallet, e.g. a cold wallet, a delegate, or a portfolio aggregator).

---

## Claim Object

```json
{
  "claim_version": "1.0",
  "receipt_id": "receipt_0004_DitHyRMQ",
  "verification_hash": "0b2d78c36cf4c2c3fb215e7b319168979fd902f72366f739550496e212231ef4",
  "wallet": "CsZLf8nuA2GL7sLX31DjFdMtF1W9hcwKakpYPxxaa4pX",
  "chain": "solana",
  "claim_recipient": "8PkeQ8GcuhJKdZveFEuyenv2KF2qvr6uvVWLoEHGiSM1",
  "signature": "<base58-encoded Ed25519 signature>",
  "signed_message": "TRADE_RECEIPT_CLAIM_V1\nreceipt:0b2d78c3...\nwallet:CsZLf8nu...\nchain:solana\nclaim_recipient:8PkeQ8Gc...",
  "claimed_at": 1773868500
}
```

### Required Fields

| Field | Type | Description |
|---|---|---|
| `claim_version` | string | `"1.0"` |
| `receipt_id` | string | References the TradeReceipt being claimed |
| `verification_hash` | string | Must match the receipt's `verification_hash` |
| `wallet` | string | Solana public key of the **trading wallet** that signed the claim. Must match the receipt's `wallet`. |
| `chain` | string | `"solana"` |
| `claim_recipient` | string | Solana public key where the minted artifact should be sent. Authorized by the trading wallet's signature. |
| `signature` | string | Base58-encoded Ed25519 signature of the canonical claim message |
| `signed_message` | string | The exact canonical message that was signed (for transparency / re-verification) |
| `claimed_at` | number | Unix timestamp (seconds) when the claim was created |

### Optional Fields

| Field | Type | Description |
|---|---|---|
| `delegate_wallet` | string | If a different wallet signed on behalf of the trading wallet (requires on-chain delegation proof — future V2) |
| `proof_url` | string | URL to an on-chain or off-chain proof artifact |
| `expires_at` | number | Unix timestamp after which the claim is considered stale (not invalid, just stale) |

---

## Verification Flow

### Step 1: Message Reconstruction

Verifier constructs the canonical message from the claim fields:

```
TRADE_RECEIPT_CLAIM_V1
receipt:{claim.verification_hash}
wallet:{claim.wallet}
chain:{claim.chain}
claim_recipient:{claim.claim_recipient}
```

### Step 2: Signature Verification

```javascript
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';

const message = new TextEncoder().encode(canonicalMessage);
const signature = bs58.decode(claim.signature);
const publicKey = new PublicKey(claim.wallet).toBytes();

const isValid = nacl.sign.detached.verify(message, signature, publicKey);
```

### Step 3: Cross-Reference

1. `claim.wallet` must equal `receipt.wallet`
2. `claim.verification_hash` must equal `receipt.verification_hash`
3. `claim.chain` must equal `receipt.chain`
4. `claim.claim_recipient` must be a valid Solana public key

### Step 4: Mint Authorization

The mint program uses `claim.claim_recipient` as the destination token account owner. The trading wallet's signature over a message containing `claim_recipient` serves as explicit authorization to mint to that address.

### Step 5 (Optional): Full Receipt Verification

Re-derive the receipt's verification hash from its fields (see Receipt Schema spec) to confirm the receipt itself is valid.

---

## Security Properties

### What a valid claim proves

- The holder of `wallet`'s private key approved the association with this specific receipt
- The receipt has not been tampered with (verification hash binds to exact trade data)
- The trading wallet explicitly authorized minting to `claim_recipient`

### What a valid claim does NOT prove

- That the wallet still holds the private key (keys can be rotated or compromised)
- That the trade was profitable in USD terms (mixed-quote receipts may mix units)
- That the wallet is the "real" identity of a person (wallets are pseudonymous)

### Replay Protection

- The claim message includes the specific `verification_hash`, so a signature cannot be reused for a different receipt
- The `wallet` is bound into the message, preventing cross-wallet replay
- The `chain` field prevents cross-chain replay
- The `claim_recipient` is bound into the message, preventing mint-redirection attacks (a valid claim for recipient A cannot be replayed to mint to recipient B)
- The `TRADE_RECEIPT_CLAIM_V1` prefix prevents cross-protocol replay

### Mint Redirection Attack Prevention

Without `claim_recipient` in the signed message, an attacker who obtains a valid claim signature could submit it with a different destination address, effectively stealing the mint. By binding the recipient into the signed payload, only the exact authorized destination can receive the artifact.

### Delegation (Future V2)

V1 requires the original trading wallet to sign. This is limiting because:
- Hardware wallets may be inconvenient for signing messages
- Users may have transferred assets to a new wallet
- Multi-sig wallets need special handling

V2 will support `delegate_wallet` with on-chain delegation proof (e.g. a CPI call or signed delegation record).

---

## Claim Lifecycle

```
1. UNCLAIMED   — Receipt exists but no claim has been made
2. CLAIMED     — Valid signature from trading wallet exists
3. MINTED      — Claim has been used to mint an on-chain artifact
4. STALE       — Claim exists but `expires_at` has passed (optional)
5. SUPERSEDED  — A newer receipt for the same cycle exists (receipt was re-generated)
```

Only `CLAIMED` claims should be accepted for minting. After successful mint, the claim transitions to `MINTED`.

---

## Integration with Mint

A valid claim is a prerequisite for minting an on-chain receipt artifact. The flow:

```
TradeReceipt → TradeClaim (wallet signature + recipient) → Mint (on-chain artifact)
```

The mint instruction will include:
- `verification_hash` — links to off-chain trade data
- `claim.signature` — proves trading wallet authorized this mint
- `claim.claim_recipient` — destination for the minted artifact

The on-chain program verifies the claim signature before minting, ensuring:
1. The trading wallet authorized this specific receipt
2. The trading wallet authorized minting to this specific recipient
3. The receipt has not been tampered with

---

## Example: Full Claim + Receipt Pairing

```json
{
  "receipt": {
    "receipt_id": "receipt_0004_DitHyRMQ",
    "verification_hash": "0b2d78c36cf4c2c3fb215e7b319168979fd902f72366f739550496e212231ef4",
    "wallet": "CsZLf8nuA2GL7sLX31DjFdMtF1W9hcwKakpYPxxaa4pX",
    "chain": "solana",
    "realized_pnl_pct": 42.903,
    "status": "verified"
  },
  "claim": {
    "claim_version": "1.0",
    "receipt_id": "receipt_0004_DitHyRMQ",
    "verification_hash": "0b2d78c36cf4c2c3fb215e7b319168979fd902f72366f739550496e212231ef4",
    "wallet": "CsZLf8nuA2GL7sLX31DjFdMtF1W9hcwKakpYPxxaa4pX",
    "chain": "solana",
    "claim_recipient": "8PkeQ8GcuhJKdZveFEuyenv2KF2qvr6uvVWLoEHGiSM1",
    "signature": "4vJ9ud4...<base58 Ed25519 sig>",
    "signed_message": "TRADE_RECEIPT_CLAIM_V1\nreceipt:0b2d78c3...\nwallet:CsZLf8nu...\nchain:solana\nclaim_recipient:8PkeQ8Gc...",
    "claimed_at": 1773868500
  }
}
```
