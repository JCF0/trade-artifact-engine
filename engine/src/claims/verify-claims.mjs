/**
 * Claim Verification Self-Test (Task 7b)
 *
 * Reads claims.jsonl, reconstructs canonical message from fields,
 * verifies Ed25519 signature, checks format compliance.
 *
 * Usage: node src/claims/verify-claims.mjs [claimsPath]
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const CLAIMS_PATH = resolve(process.argv[2] || resolve(ROOT, 'engine/data/claims/claims.jsonl'));

const claims = readFileSync(CLAIMS_PATH, 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l));

console.log(`Verifying ${claims.length} claims from ${CLAIMS_PATH}\n`);

let passed = 0;
let failed = 0;

for (const claim of claims) {
  const errors = [];

  // 1. Version check
  if (claim.claim_version !== '1.0') {
    errors.push(`claim_version: expected "1.0", got "${claim.claim_version}"`);
  }

  // 2. Required fields present
  for (const field of ['receipt_id', 'verification_hash', 'wallet', 'chain', 'claim_recipient', 'signature_bs58', 'signature_hex', 'signed_message', 'claimed_at']) {
    if (!claim[field]) errors.push(`missing field: ${field}`);
  }

  // 3. Reconstruct canonical message from fields
  const reconstructed = `TRADE_RECEIPT_CLAIM_V1\nreceipt:${claim.verification_hash}\nwallet:${claim.wallet}\nchain:${claim.chain}\nclaim_recipient:${claim.claim_recipient}`;

  if (claim.signed_message !== reconstructed) {
    errors.push(`signed_message mismatch:\n  stored:        ${JSON.stringify(claim.signed_message)}\n  reconstructed: ${JSON.stringify(reconstructed)}`);
  }

  // 4. Verify wallet is valid pubkey
  try {
    new PublicKey(claim.wallet);
  } catch {
    errors.push(`wallet is not valid pubkey: ${claim.wallet}`);
  }

  // 5. Verify claim_recipient is valid pubkey
  try {
    new PublicKey(claim.claim_recipient);
  } catch {
    errors.push(`claim_recipient is not valid pubkey: ${claim.claim_recipient}`);
  }

  // 6. Signature format checks
  let signatureBytes;
  try {
    signatureBytes = bs58.decode(claim.signature_bs58);
    if (signatureBytes.length !== 64) {
      errors.push(`signature_bs58 decodes to ${signatureBytes.length} bytes, expected 64`);
    }
  } catch (e) {
    errors.push(`signature_bs58 decode failed: ${e.message}`);
  }

  // Cross-check hex encoding
  if (signatureBytes && claim.signature_hex) {
    const fromHex = Buffer.from(claim.signature_hex, 'hex');
    if (!Buffer.from(signatureBytes).equals(fromHex)) {
      errors.push('signature_bs58 and signature_hex do not match');
    }
  }

  // 7. Ed25519 signature verification
  if (signatureBytes && signatureBytes.length === 64) {
    const messageBytes = new TextEncoder().encode(reconstructed);
    const pubkeyBytes = new PublicKey(claim.wallet).toBytes();
    const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
    if (!valid) {
      errors.push('Ed25519 signature INVALID');
    }
  }

  // 8. Chain must be "solana"
  if (claim.chain !== 'solana') {
    errors.push(`chain: expected "solana", got "${claim.chain}"`);
  }

  // Report
  if (errors.length === 0) {
    console.log(`✅ ${claim.receipt_id} — signature valid, message canonical, fields complete`);
    passed++;
  } else {
    console.log(`❌ ${claim.receipt_id}:`);
    for (const e of errors) console.log(`   ${e}`);
    failed++;
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`VERIFICATION COMPLETE: ${passed} passed, ${failed} failed out of ${claims.length}`);
console.log(`${'='.repeat(60)}`);

process.exit(failed > 0 ? 1 : 0);
