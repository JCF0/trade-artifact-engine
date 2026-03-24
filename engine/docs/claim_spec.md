# Claim Specification V1

**Version:** 1.0
**Status:** Implemented

This specification reflects the current devnet implementation and may evolve before mainnet deployment.

---

## Overview

A TradeClaim is a signed attestation that links a TradeReceipt to the wallet that executed the trade and authorizes where the resulting on-chain artifact should be minted.

---

## 1. Canonical Claim Message

The message is a deterministic UTF-8 string with `\n` (LF, 0x0A) line separators and no trailing newline:

```
TRADE_RECEIPT_CLAIM_V1
receipt:{verification_hash_hex}
wallet:{trader_wallet_base58}
chain:solana
claim_recipient:{recipient_wallet_base58}
```

### Rules

- Lines separated by `\n` (0x0A). No trailing newline.
- No spaces around `:` delimiters.
- `verification_hash_hex` is the 64-character lowercase hex string of the receipt's SHA-256 verification hash.
- Wallet addresses are base58-encoded Solana public keys (case-sensitive).
- The `TRADE_RECEIPT_CLAIM_V1` prefix prevents cross-protocol replay.
- `claim_recipient` may equal `wallet` (self-addressed) or differ (mint to another wallet).

### Example

```
TRADE_RECEIPT_CLAIM_V1
receipt:138e1931554260a5ed03405d37f532349b37b86ec70d086bf312dff773b6eeaf
wallet:CsZLf8nuA2GL7sLX31DjFdMtF1W9hcwKakpYPxxaa4pX
chain:solana
claim_recipient:8PkeQ8GcuhJKdZveFEuyenv2KF2qvr6uvVWLoEHGiSM1
```

---

## 2. Signing Rules

### Algorithm

Ed25519 detached signature (`tweetnacl.sign.detached` or equivalent).

### Input

The exact UTF-8 byte encoding of the canonical claim message.

```javascript
const messageBytes = new TextEncoder().encode(canonicalMessage);
const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
```

### Determinism

Ed25519 is deterministic: same key + same message → same 64-byte signature. No nonce involved (unlike ECDSA). Re-signing the same claim always produces an identical signature.

### Self-Verification

After signing, the signer MUST verify the signature before persisting:

```javascript
const valid = nacl.sign.detached.verify(messageBytes, signature, publicKey);
if (!valid) throw new Error('Self-verification failed');
```

---

## 3. Claim Object Schema

Persisted in `claims.jsonl`, one JSON object per line:

```json
{
  "claim_version": "1.0",
  "receipt_id": "receipt_0004_DitHyRMQ",
  "verification_hash": "138e1931554260a5ed03405d37f532349b37b86ec70d086bf312dff773b6eeaf",
  "wallet": "CsZLf8nuA2GL7sLX31DjFdMtF1W9hcwKakpYPxxaa4pX",
  "chain": "solana",
  "claim_recipient": "8PkeQ8GcuhJKdZveFEuyenv2KF2qvr6uvVWLoEHGiSM1",
  "signature_bs58": "<base58-encoded 64-byte Ed25519 signature>",
  "signature_hex": "<hex-encoded 64-byte Ed25519 signature>",
  "signed_message": "<the exact canonical message that was signed>",
  "claimed_at": 1774000000
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `claim_version` | string | ✅ | `"1.0"` |
| `receipt_id` | string | ✅ | References the TradeReceipt |
| `verification_hash` | string | ✅ | 64-char hex, must match receipt |
| `wallet` | string | ✅ | Trader wallet (signer's pubkey) |
| `chain` | string | ✅ | `"solana"` |
| `claim_recipient` | string | ✅ | Authorized mint destination |
| `signature_bs58` | string | ✅ | Base58-encoded signature |
| `signature_hex` | string | ✅ | Hex-encoded signature (128 chars) |
| `signed_message` | string | ✅ | Exact canonical message for transparency |
| `claimed_at` | number | ✅ | Unix timestamp (seconds) |

---

## 4. Verification Logic

### Step 1: Reconstruct Canonical Message

```javascript
const reconstructed =
  `TRADE_RECEIPT_CLAIM_V1\n` +
  `receipt:${claim.verification_hash}\n` +
  `wallet:${claim.wallet}\n` +
  `chain:${claim.chain}\n` +
  `claim_recipient:${claim.claim_recipient}`;
```

### Step 2: Verify Message Matches

Compare `claim.signed_message === reconstructed`. If mismatch, the claim is invalid.

### Step 3: Verify Signature

```javascript
const messageBytes = new TextEncoder().encode(reconstructed);
const signatureBytes = bs58.decode(claim.signature_bs58);  // must be 64 bytes
const publicKeyBytes = new PublicKey(claim.wallet).toBytes();
const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
```

### Step 4: Cross-Reference

- `claim.wallet` must equal `receipt.wallet`
- `claim.verification_hash` must equal `receipt.verification_hash`
- `claim.chain` must equal `receipt.chain`
- `claim.claim_recipient` must be a valid Solana public key
- `signatureBytes` must equal hex-decode of `claim.signature_hex` (encoding cross-check)

---

## 5. On-Chain Verification

The `trade_artifact` program verifies the claim during `mint_receipt`:

1. Scans the instructions sysvar for exactly one Ed25519 program instruction.
2. Parses the Ed25519 instruction to extract: pubkey (32 bytes), signature (64 bytes), message (variable).
3. Verifies the pubkey matches the `trader_wallet` account.
4. Reconstructs the expected canonical message from the accounts passed to `mint_receipt`.
5. Byte-compares the reconstructed message against the Ed25519 instruction's message.
6. If mismatch → reject. If match → the Ed25519 native program has already verified the cryptographic signature.

The signature is stored in the receipt PDA (`claim_signature` field) for future re-verification.

---

## 6. Security Properties

| Property | Mechanism |
|---|---|
| Receipt binding | `verification_hash` in message binds to exact trade data |
| Wallet binding | `wallet` in message prevents cross-wallet replay |
| Chain binding | `chain` in message prevents cross-chain replay |
| Recipient authorization | `claim_recipient` in message prevents mint-redirection |
| Protocol isolation | `TRADE_RECEIPT_CLAIM_V1` prefix prevents cross-protocol replay |
| Duplicate prevention | PDA `["receipt", verification_hash]` can only be initialized once |
