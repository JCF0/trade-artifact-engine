# Third-Party Verifier Flow

**Version:** 1.0

---

## Overview

Any third party can independently verify a Trade Artifact receipt given the receipt JSON, the on-chain mint, and access to Solana RPC + Arweave/Irys gateway. No proprietary tools, API keys, or trust relationships required.

---

## What You Need

| Input | Source |
|---|---|
| Receipt JSON | Arweave (via `properties.receipt_json` in NFT metadata) or direct share |
| Verification hash | From receipt JSON field `verification_hash` |
| On-chain program ID | `HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ` |
| Solana RPC | Any public or private RPC endpoint |
| Arweave/Irys gateway | `https://gateway.irys.xyz/{id}` |

---

## Verification Levels

### Level 1: Receipt Integrity (Offline)

**Question:** Is this receipt internally consistent?

**Steps:**

1. **Parse receipt JSON.** Confirm `receipt_version` is `"1.0"`.

2. **Re-derive verification hash:**
   ```javascript
   const entryHashes = receipt.entry_txs.map(t => t.tx_hash).sort();
   const exitHashes = receipt.exit_txs.map(t => t.tx_hash).sort();
   const payload = JSON.stringify([
     receipt.wallet,
     receipt.chain,
     receipt.token_mint,
     entryHashes,
     exitHashes,
     receipt._hash_inputs.raw_entry_price_avg,
     receipt._hash_inputs.raw_exit_price_avg,
     receipt.accounting_method,
     receipt.receipt_version,
     receipt.status,
   ]);
   const hash = sha256(payload);
   assert(hash === receipt.verification_hash);
   ```

3. **Verify PnL accounting:**
   ```
   Σ(entry_tx.quote_amount) ≈ receipt.total_cost_basis
   Σ(exit_tx.quote_amount) ≈ receipt.total_exit_proceeds
   total_exit_proceeds - total_cost_basis ≈ receipt.realized_pnl
   ```
   (Allow display rounding tolerance of ~1e-6)

4. **Verify dust threshold closure:**
   ```
   |total_bought - total_sold| < max(0.001, 0.001 × peak_position)
   ```

**Result:** Confirms the receipt hasn't been tampered with. Does NOT confirm the trades actually occurred.

---

### Level 2: On-Chain Anchor Verification

**Question:** Was this receipt minted on-chain? Does the on-chain data match?

**Steps:**

1. **Derive the receipt PDA:**
   ```javascript
   const [pda] = PublicKey.findProgramAddressSync(
     [Buffer.from("receipt"), Buffer.from(verificationHash, "hex")],
     programId
   );
   ```

2. **Fetch the PDA account from Solana RPC:**
   ```javascript
   const account = await connection.getAccountInfo(pda);
   ```
   If `account === null`, the receipt has NOT been minted.

3. **Decode the PDA data** (after 8-byte Anchor discriminator):
   | Offset | Size | Field |
   |---|---|---|
   | 0 | 32 | verification_hash |
   | 32 | 32 | metadata_hash |
   | 64 | 32 | trader_wallet |
   | 96 | 32 | claim_recipient |
   | 128 | 64 | claim_signature |
   | 192 | 1 | status (0=verified, 1=verified_mixed_quote) |
   | 193 | 1 | program_version |
   | 194 | 32 | mint (NFT mint address) |
   | 226 | 8 | minted_at (i64 LE, Unix seconds) |
   | 234 | 1 | bump |

4. **Verify fields match:**
   - `pda.verification_hash` == `receipt.verification_hash`
   - `pda.trader_wallet` == `receipt.wallet`
   - `pda.status` matches receipt status (0 ↔ "verified", 1 ↔ "verified_mixed_quote")
   - `pda.program_version` == 1

5. **Verify the NFT exists:**
   ```javascript
   const [mintPda] = PublicKey.findProgramAddressSync(
     [Buffer.from("mint"), Buffer.from(verificationHash, "hex")],
     programId
   );
   const mintAccount = await connection.getAccountInfo(mintPda);
   // Verify: owner = Token-2022, supply = 1, decimals = 0
   ```

6. **Verify the ATA balance:**
   ```javascript
   const [ata] = PublicKey.findProgramAddressSync(
     [claimRecipient.toBuffer(), TOKEN_2022_ID.toBuffer(), mintPda.toBuffer()],
     ASSOCIATED_TOKEN_PROGRAM_ID
   );
   // Verify: balance = 1
   ```

**Result:** Confirms the receipt was minted by the program, the trader wallet authorized it, and the NFT is in the correct wallet.

---

### Level 3: Claim Signature Verification

**Question:** Did the trader wallet actually authorize this mint?

**Steps:**

1. **Extract the claim signature** from the on-chain PDA (`claim_signature`, 64 bytes).

2. **Reconstruct the canonical claim message:**
   ```
   TRADE_RECEIPT_CLAIM_V1
   receipt:{verification_hash_hex}
   wallet:{trader_wallet_base58}
   chain:solana
   claim_recipient:{claim_recipient_base58}
   ```

3. **Verify the Ed25519 signature:**
   ```javascript
   const messageBytes = new TextEncoder().encode(canonicalMessage);
   const valid = nacl.sign.detached.verify(
     messageBytes,
     claimSignatureBytes,  // from PDA
     traderWalletBytes     // from PDA
   );
   assert(valid === true);
   ```

**Result:** Cryptographic proof that the trader wallet (which executed the trades) authorized the receipt minting.

---

### Level 4: Metadata Content Verification

**Question:** Does the off-chain metadata match what the on-chain anchor claims?

**Steps:**

1. **Read `metadata_hash`** from the on-chain PDA (32 bytes, hex).

2. **Fetch the NFT metadata URI** from the Token-2022 mint account's metadata extension.

3. **Download the metadata JSON** from that URI (Irys gateway).

4. **Compute SHA-256** of the raw response body.

5. **Compare** to the on-chain `metadata_hash`.

6. **Parse the metadata JSON** and verify:
   - `properties.verification_hash` matches the receipt
   - `image` URI is reachable and returns a PNG
   - `properties.receipt_json` URI returns a JSON matching the receipt

**Result:** Confirms the off-chain metadata hasn't been tampered with and matches the on-chain commitment.

---

### Level 5: Full Re-Derivation (Highest Assurance)

**Question:** Did these trades actually happen exactly as the receipt claims?

**Steps:**

1. **Fetch all referenced transactions** from Solana:
   ```
   For each tx_hash in receipt.entry_txs + receipt.exit_txs:
     Fetch enhanced transaction from Helius (or raw from RPC)
   ```

2. **Re-run normalization:**
   - Extract swap events from each transaction
   - Verify: token_in/out mints, amounts, timestamps match receipt data

3. **Re-run PnL calculation:**
   - Compute WACB from the fetched transactions
   - Compare raw entry/exit price averages to `_hash_inputs`

4. **Re-derive verification hash:**
   - Use the re-computed raw values (not the receipt's `_hash_inputs`)
   - If the hash matches → the receipt is faithfully derived from on-chain data

5. **Optional: Verify transaction signatures** on the raw RPC data to confirm the wallet actually signed these transactions.

**Result:** Proves the receipt is an accurate representation of real on-chain trades. This is the strongest possible verification — equivalent to re-running the engine.

---

## Trust Model Summary

| Level | Trusts | Verifies |
|---|---|---|
| 1 — Receipt Integrity | Nothing (offline) | Receipt hasn't been tampered with |
| 2 — On-Chain Anchor | Solana consensus | Receipt was minted by the program |
| 3 — Claim Signature | Ed25519 cryptography | Trader wallet authorized the mint |
| 4 — Metadata Content | Arweave immutability | Off-chain data matches on-chain commitment |
| 5 — Full Re-Derivation | Solana transaction history | Trades actually happened as claimed |

Levels 1–4 can be performed in seconds. Level 5 requires fetching transactions (may take 30–60 seconds depending on trade count and RPC speed).

---

## Failure Modes

| Failure | Meaning |
|---|---|
| Hash re-derivation fails (L1) | Receipt has been modified or corrupted |
| PDA doesn't exist (L2) | Receipt was never minted on-chain |
| PDA fields don't match (L2) | Receipt JSON doesn't correspond to what was minted |
| Signature invalid (L3) | Claim was not authorized by the trader wallet |
| Metadata hash mismatch (L4) | Off-chain metadata was modified after minting |
| Re-derived hash differs (L5) | Receipt does not match actual on-chain transactions |

---

## Tooling

The engine provides a verification command:
```bash
node src/mint/verify-mints.mjs <mintResultsPath> [--network devnet|mainnet]
```

This performs Levels 2–3 automatically. For Level 5, the full pipeline can be re-run on the same wallet and the output compared.
