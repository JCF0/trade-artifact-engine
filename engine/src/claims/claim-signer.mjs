/**
 * Claim Signer Module (Task 7a)
 *
 * Reads receipts.jsonl, constructs canonical claim messages per frozen spec,
 * signs with a Solana keypair, self-verifies, and outputs claims.jsonl.
 *
 * Usage:
 *   node src/claims/claim-signer.mjs <keypairPath> [recipientPubkey] [receiptsPath] [outputPath]
 *
 * If recipientPubkey is omitted, claims are self-addressed (trader = recipient).
 * keypairPath is a Solana JSON keypair file (array of 64 bytes).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const KEYPAIR_PATH = process.argv[2];
if (!KEYPAIR_PATH) {
  console.error('Usage: node src/claims/claim-signer.mjs <keypairPath> [recipientPubkey] [receiptsPath] [outputPath]');
  process.exit(1);
}

const RECIPIENT_OVERRIDE = process.argv[3] || null;
const RECEIPTS_PATH = resolve(process.argv[4] || resolve(ROOT, 'engine/data/receipts/receipts.jsonl'));
const OUTPUT_DIR = resolve(process.argv[5] || resolve(ROOT, 'engine/data/claims'));
const OUTPUT_PATH = resolve(OUTPUT_DIR, 'claims.jsonl');

// ---------------------------------------------------------------------------
// Load keypair
// ---------------------------------------------------------------------------
const keypairBytes = new Uint8Array(JSON.parse(readFileSync(resolve(KEYPAIR_PATH), 'utf-8')));
const keypair = Keypair.fromSecretKey(keypairBytes);
const traderWallet = keypair.publicKey.toBase58();
console.log(`Trader wallet: ${traderWallet}`);

// Determine recipient
let recipientPubkey;
if (RECIPIENT_OVERRIDE) {
  // Validate it's a real pubkey
  try {
    new PublicKey(RECIPIENT_OVERRIDE);
    recipientPubkey = RECIPIENT_OVERRIDE;
  } catch {
    console.error(`Invalid recipient pubkey: ${RECIPIENT_OVERRIDE}`);
    process.exit(1);
  }
} else {
  recipientPubkey = traderWallet; // self-addressed
}
console.log(`Claim recipient: ${recipientPubkey}`);

// ---------------------------------------------------------------------------
// Load receipts
// ---------------------------------------------------------------------------
const receipts = readFileSync(RECEIPTS_PATH, 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l));
console.log(`Loaded ${receipts.length} receipts from ${RECEIPTS_PATH}`);

// ---------------------------------------------------------------------------
// Build canonical claim message (frozen spec)
// ---------------------------------------------------------------------------
function buildClaimMessage(verificationHash, wallet, chain, claimRecipient) {
  return `TRADE_RECEIPT_CLAIM_V1\nreceipt:${verificationHash}\nwallet:${wallet}\nchain:${chain}\nclaim_recipient:${claimRecipient}`;
}

// ---------------------------------------------------------------------------
// Sign claims
// ---------------------------------------------------------------------------
mkdirSync(OUTPUT_DIR, { recursive: true });

const claims = [];
let signedCount = 0;
let skippedCount = 0;

for (const receipt of receipts) {
  // Only sign receipts where the wallet matches our keypair
  if (receipt.wallet !== traderWallet) {
    console.log(`  SKIP ${receipt.receipt_id}: wallet mismatch (receipt=${receipt.wallet}, signer=${traderWallet})`);
    skippedCount++;
    continue;
  }

  const claimMessage = buildClaimMessage(
    receipt.verification_hash,
    receipt.wallet,
    receipt.chain,
    recipientPubkey
  );

  const messageBytes = new TextEncoder().encode(claimMessage);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);

  // Self-verify before writing
  const verified = nacl.sign.detached.verify(
    messageBytes,
    signature,
    keypair.publicKey.toBytes()
  );
  if (!verified) {
    console.error(`  FATAL: Self-verification failed for ${receipt.receipt_id}`);
    process.exit(1);
  }

  const signatureBs58 = bs58.encode(signature);
  const signatureHex = Buffer.from(signature).toString('hex');

  const claim = {
    claim_version: '1.0',
    receipt_id: receipt.receipt_id,
    verification_hash: receipt.verification_hash,
    wallet: receipt.wallet,
    chain: receipt.chain,
    claim_recipient: recipientPubkey,
    signature_bs58: signatureBs58,
    signature_hex: signatureHex,
    signed_message: claimMessage,
    claimed_at: Math.floor(Date.now() / 1000),
  };

  claims.push(claim);
  signedCount++;
  console.log(`  ✅ ${receipt.receipt_id} → signed (hash: ${receipt.verification_hash.slice(0, 12)}...)`);
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------
writeFileSync(OUTPUT_PATH, claims.map(c => JSON.stringify(c)).join('\n') + '\n');
console.log(`\nClaims written: ${signedCount} (skipped: ${skippedCount})`);
console.log(`Output: ${OUTPUT_PATH}`);
