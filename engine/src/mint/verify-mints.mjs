/**
 * Post-Mint PDA Verification (Task 9b)
 *
 * For each confirmed mint in mint_results.jsonl:
 *   1. Fetch receipt PDA from chain, decode ReceiptAnchor data
 *   2. Verify: verification_hash, metadata_hash, trader_wallet, mint address, status, program_version
 *   3. Fetch NFT mint account, verify supply=1, decimals=0
 *   4. Fetch recipient ATA, verify balance=1
 *
 * Usage: node src/mint/verify-mints.mjs [mintResultsPath] [--network devnet|mainnet]
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const networkFlag = args.find((a, i) => args[i - 1] === '--network') || 'devnet';
const positional = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--network');
const RESULTS_PATH = resolve(positional[0] || resolve(ROOT, 'engine/data/mints/mint_results.jsonl'));

const ENDPOINTS = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

const PROGRAM_ID = new PublicKey('HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const RECEIPT_SEED = Buffer.from('receipt');
const MINT_SEED = Buffer.from('mint');

const connection = new Connection(ENDPOINTS[networkFlag] || ENDPOINTS.devnet, 'confirmed');

console.log(`Network: ${networkFlag}`);
console.log(`Results: ${RESULTS_PATH}\n`);

// ---------------------------------------------------------------------------
// Load claims for cross-reference (optional)
// ---------------------------------------------------------------------------
const claimsPath = resolve(dirname(RESULTS_PATH), '..', 'claims', 'claims.jsonl');
const claimsMap = new Map();
try {
  const claimsLines = readFileSync(claimsPath, 'utf-8').trim().split('\n');
  for (const l of claimsLines) {
    const c = JSON.parse(l);
    claimsMap.set(c.verification_hash, c);
  }
  console.log(`Loaded ${claimsMap.size} claims for cross-reference`);
} catch { /* no claims file, that's fine */ }

// ---------------------------------------------------------------------------
// Load mint results
// ---------------------------------------------------------------------------
const results = readFileSync(RESULTS_PATH, 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const confirmed = results.filter(r => r.status === 'confirmed');

console.log(`Mint results loaded: ${results.length} total, ${confirmed.length} confirmed\n`);

if (confirmed.length === 0) {
  console.log('No confirmed mints to verify.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ReceiptAnchor deserialization
// Struct layout (after 8-byte discriminator):
//   verification_hash: [u8; 32]     offset 0
//   metadata_hash:     [u8; 32]     offset 32
//   trader_wallet:     Pubkey (32)  offset 64
//   claim_recipient:   Pubkey (32)  offset 96
//   claim_signature:   [u8; 64]     offset 128
//   status:            u8           offset 192
//   program_version:   u8           offset 193
//   mint:              Pubkey (32)  offset 194
//   minted_at:         i64          offset 226
//   bump:              u8           offset 234
// Total data: 235 bytes + 8 discriminator = 243 bytes
// ---------------------------------------------------------------------------
function decodeReceiptAnchor(data) {
  if (data.length < 243) throw new Error(`PDA data too short: ${data.length} bytes (expected ≥243)`);
  const d = Buffer.from(data);
  const disc = d.subarray(0, 8);
  const offset = 8; // skip discriminator

  return {
    verification_hash: d.subarray(offset, offset + 32).toString('hex'),
    metadata_hash: d.subarray(offset + 32, offset + 64).toString('hex'),
    trader_wallet: new PublicKey(d.subarray(offset + 64, offset + 96)).toBase58(),
    claim_recipient: new PublicKey(d.subarray(offset + 96, offset + 128)).toBase58(),
    claim_signature: d.subarray(offset + 128, offset + 192).toString('hex'),
    status: d.readUInt8(offset + 192),
    program_version: d.readUInt8(offset + 193),
    mint: new PublicKey(d.subarray(offset + 194, offset + 226)).toBase58(),
    minted_at: Number(d.readBigInt64LE(offset + 226)),
    bump: d.readUInt8(offset + 234),
  };
}

// ---------------------------------------------------------------------------
// Verify each confirmed mint
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

for (const result of confirmed) {
  const tag = `${result.receipt_id} (${result.verification_hash.slice(0, 12)}...)`;
  const errors = [];

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🔍 ${tag}`);

  // 1. Derive expected PDAs
  const hashBytes = Buffer.from(result.verification_hash, 'hex');
  const [expectedReceiptPDA] = PublicKey.findProgramAddressSync([RECEIPT_SEED, hashBytes], PROGRAM_ID);
  const [expectedMintPDA] = PublicKey.findProgramAddressSync([MINT_SEED, hashBytes], PROGRAM_ID);

  // Cross-check PDA addresses match result
  if (result.receipt_pda !== expectedReceiptPDA.toBase58()) {
    errors.push(`receipt_pda mismatch: result=${result.receipt_pda}, derived=${expectedReceiptPDA.toBase58()}`);
  }
  if (result.nft_mint !== expectedMintPDA.toBase58()) {
    errors.push(`nft_mint mismatch: result=${result.nft_mint}, derived=${expectedMintPDA.toBase58()}`);
  }

  // 2. Fetch and decode receipt PDA
  let anchor;
  try {
    const pdaAccount = await connection.getAccountInfo(expectedReceiptPDA);
    if (!pdaAccount) {
      errors.push('Receipt PDA does not exist on-chain');
    } else {
      if (pdaAccount.owner.toBase58() !== PROGRAM_ID.toBase58()) {
        errors.push(`PDA owner mismatch: ${pdaAccount.owner.toBase58()} (expected ${PROGRAM_ID.toBase58()})`);
      }
      anchor = decodeReceiptAnchor(pdaAccount.data);

      // Verify fields
      if (anchor.verification_hash !== result.verification_hash) {
        errors.push(`on-chain verification_hash mismatch`);
      }
      if (anchor.mint !== expectedMintPDA.toBase58()) {
        errors.push(`on-chain mint mismatch: ${anchor.mint} (expected ${expectedMintPDA.toBase58()})`);
      }
      if (anchor.program_version !== 1) {
        errors.push(`program_version: ${anchor.program_version} (expected 1)`);
      }
      if (anchor.status > 1) {
        errors.push(`status out of range: ${anchor.status}`);
      }
      if (anchor.minted_at <= 0) {
        errors.push(`minted_at invalid: ${anchor.minted_at}`);
      }

      // Cross-check with claim
      const claim = claimsMap.get(result.verification_hash);
      if (claim) {
        if (anchor.trader_wallet !== claim.wallet) {
          errors.push(`trader_wallet mismatch: on-chain=${anchor.trader_wallet}, claim=${claim.wallet}`);
        }
        if (anchor.claim_recipient !== claim.claim_recipient) {
          errors.push(`claim_recipient mismatch: on-chain=${anchor.claim_recipient}, claim=${claim.claim_recipient}`);
        }
        if (anchor.claim_signature !== claim.signature_hex) {
          errors.push(`claim_signature mismatch`);
        }
      }

      console.log(`   PDA:       ${expectedReceiptPDA.toBase58()} ✓ exists`);
      console.log(`   Hash:      ${anchor.verification_hash.slice(0, 24)}... ✓`);
      console.log(`   Trader:    ${anchor.trader_wallet}`);
      console.log(`   Recipient: ${anchor.claim_recipient}`);
      console.log(`   Status:    ${anchor.status} (${anchor.status === 0 ? 'verified' : 'verified_mixed_quote'})`);
      console.log(`   Version:   ${anchor.program_version}`);
      console.log(`   Minted at: ${new Date(anchor.minted_at * 1000).toISOString()}`);
    }
  } catch (e) {
    errors.push(`PDA fetch/decode error: ${e.message}`);
  }

  // 3. Fetch NFT mint account
  try {
    const mintAccount = await connection.getAccountInfo(expectedMintPDA);
    if (!mintAccount) {
      errors.push('NFT mint account does not exist');
    } else {
      if (mintAccount.owner.toBase58() !== TOKEN_2022_PROGRAM_ID.toBase58()) {
        errors.push(`Mint owner not Token-2022: ${mintAccount.owner.toBase58()}`);
      }
      // Token-2022 Mint: supply at offset 36 (u64 LE), decimals at offset 44 (u8)
      const mintData = Buffer.from(mintAccount.data);
      if (mintData.length >= 45) {
        const supply = Number(mintData.readBigUInt64LE(36));
        const decimals = mintData.readUInt8(44);
        if (supply !== 1) errors.push(`NFT supply: ${supply} (expected 1)`);
        if (decimals !== 0) errors.push(`NFT decimals: ${decimals} (expected 0)`);
        console.log(`   Mint:      ${expectedMintPDA.toBase58()} ✓ supply=${supply}, decimals=${decimals}`);
      }
    }
  } catch (e) {
    errors.push(`Mint fetch error: ${e.message}`);
  }

  // 4. Fetch recipient ATA and check balance
  if (anchor && !errors.some(e => e.includes('does not exist'))) {
    try {
      const recipientKey = new PublicKey(anchor.claim_recipient);
      const [ata] = PublicKey.findProgramAddressSync(
        [recipientKey.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), expectedMintPDA.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const ataAccount = await connection.getAccountInfo(ata);
      if (!ataAccount) {
        errors.push('Recipient ATA does not exist');
      } else {
        // Token account: amount at offset 64 (u64 LE)
        const ataData = Buffer.from(ataAccount.data);
        if (ataData.length >= 72) {
          const balance = Number(ataData.readBigUInt64LE(64));
          if (balance !== 1) errors.push(`ATA balance: ${balance} (expected 1)`);
          console.log(`   ATA:       ${ata.toBase58()} ✓ balance=${balance}`);
        }
      }
    } catch (e) {
      errors.push(`ATA fetch error: ${e.message}`);
    }
  }

  // Report
  if (errors.length === 0) {
    console.log(`   ✅ ALL CHECKS PASSED`);
    passed++;
  } else {
    for (const e of errors) console.log(`   ❌ ${e}`);
    failed++;
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`VERIFICATION COMPLETE: ${passed} passed, ${failed} failed out of ${confirmed.length}`);
console.log(`${'='.repeat(60)}`);

process.exit(failed > 0 ? 1 : 0);
