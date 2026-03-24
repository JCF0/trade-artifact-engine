/**
 * Mint Submitter (Task 9a)
 *
 * Reads claims.jsonl, builds mint_receipt transactions (Ed25519 + ComputeBudget + mint_receipt),
 * simulates, submits to devnet, and records results.
 *
 * Usage:
 *   node src/mint/mint-submitter.mjs <payerKeypairPath> <claimsPath> [--network devnet|mainnet] [--dry-run]
 *
 * Requires: claims.jsonl (from claim-signer), optionally uploads.jsonl (for real metadata_uri).
 * If no uploads.jsonl, uses a dummy metadata URI and zeroed metadata_hash.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  Ed25519Program, ComputeBudgetProgram, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROGRAM_ID = new PublicKey('HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const RECEIPT_SEED = Buffer.from('receipt');
const MINT_SEED = Buffer.from('mint');

const DUMMY_METADATA_URI = 'https://arweave.net/placeholder_pending_upload';
const DUMMY_METADATA_HASH = new Uint8Array(32); // all zeros

const ENDPOINTS = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const networkFlag = args.find((a, i) => args[i - 1] === '--network') || 'devnet';
const positional = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--network');

const PAYER_PATH = positional[0];
const CLAIMS_PATH = positional[1];

if (!PAYER_PATH || !CLAIMS_PATH) {
  console.error('Usage: node src/mint/mint-submitter.mjs <payerKeypairPath> <claimsPath> [--network devnet|mainnet] [--dry-run]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
const payerKeypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(resolve(PAYER_PATH), 'utf-8')))
);
console.log(`Payer: ${payerKeypair.publicKey.toBase58()}`);
console.log(`Network: ${networkFlag}`);
console.log(`Dry run: ${dryRun}`);

const connection = new Connection(ENDPOINTS[networkFlag] || ENDPOINTS.devnet, 'confirmed');

const claims = readFileSync(resolve(CLAIMS_PATH), 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l));
console.log(`Loaded ${claims.length} claims\n`);

// Check for uploads (look in sibling arweave/ dir)
const uploadsPath = resolve(dirname(resolve(CLAIMS_PATH)), '..', 'arweave', 'uploads.jsonl');
let uploadsMap = new Map();
if (existsSync(uploadsPath)) {
  const uploads = readFileSync(uploadsPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const u of uploads) uploadsMap.set(u.verification_hash, u);
  console.log(`Loaded ${uploads.length} upload records from ${uploadsPath}`);
} else {
  console.log(`No uploads.jsonl found — using dummy metadata URI`);
}

// Load receipts for status cross-reference
const receiptsPath = resolve(dirname(resolve(CLAIMS_PATH)), '..', 'receipts', 'receipts.jsonl');
const receiptsMap = new Map();
if (existsSync(receiptsPath)) {
  const rLines = readFileSync(receiptsPath, 'utf-8').trim().split('\n').filter(Boolean);
  for (const l of rLines) {
    const r = JSON.parse(l);
    receiptsMap.set(r.verification_hash, r);
  }
  console.log(`Loaded ${receiptsMap.size} receipts for status cross-reference`);
}

// Load existing mint results for idempotency
const resultsDir = resolve(dirname(resolve(CLAIMS_PATH)), '..', 'mints');
mkdirSync(resultsDir, { recursive: true });
const resultsPath = resolve(resultsDir, 'mint_results.jsonl');
const existingResults = new Map();
if (existsSync(resultsPath)) {
  const lines = readFileSync(resultsPath, 'utf-8').trim().split('\n').filter(Boolean);
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.status === 'confirmed' || r.status === 'already_minted') {
      existingResults.set(r.verification_hash, r);
    }
  }
  console.log(`Loaded ${existingResults.size} existing confirmed/already_minted results`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function deriveReceiptPDA(verificationHashHex) {
  const hashBytes = Buffer.from(verificationHashHex, 'hex');
  return PublicKey.findProgramAddressSync([RECEIPT_SEED, hashBytes], PROGRAM_ID);
}

function deriveMintPDA(verificationHashHex) {
  const hashBytes = Buffer.from(verificationHashHex, 'hex');
  return PublicKey.findProgramAddressSync([MINT_SEED, hashBytes], PROGRAM_ID);
}

function deriveATA(owner, mint, tokenProgramId) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

function statusToByte(status) {
  if (status === 'verified' || status === undefined) return 0;
  if (status === 'verified_mixed_quote') return 1;
  throw new Error(`Unknown status: ${status}`);
}

/**
 * Build the Anchor instruction data for mint_receipt.
 * Anchor uses an 8-byte discriminator + borsh-serialized args.
 */
function buildMintReceiptData(verificationHash, metadataHash, status, metadataUri, receiptName) {
  // Discriminator: first 8 bytes of sha256("global:mint_receipt")
  const disc = createHash('sha256').update('global:mint_receipt').digest().subarray(0, 8);

  // Borsh encode: [u8;32] + [u8;32] + u8 + String + String
  const uriBuf = Buffer.from(metadataUri, 'utf-8');
  const nameBuf = Buffer.from(receiptName, 'utf-8');

  const buf = Buffer.alloc(8 + 32 + 32 + 1 + 4 + uriBuf.length + 4 + nameBuf.length);
  let offset = 0;

  disc.copy(buf, offset); offset += 8;
  Buffer.from(verificationHash, 'hex').copy(buf, offset); offset += 32;
  Buffer.from(metadataHash).copy(buf, offset); offset += 32;
  buf.writeUInt8(status, offset); offset += 1;
  buf.writeUInt32LE(uriBuf.length, offset); offset += 4;
  uriBuf.copy(buf, offset); offset += uriBuf.length;
  buf.writeUInt32LE(nameBuf.length, offset); offset += 4;
  nameBuf.copy(buf, offset);

  return buf;
}

// ---------------------------------------------------------------------------
// Process each claim
// ---------------------------------------------------------------------------
const results = [];

for (const claim of claims) {
  const tag = `${claim.receipt_id} (${claim.verification_hash.slice(0, 12)}...)`;

  // Idempotency: skip if already minted
  if (existingResults.has(claim.verification_hash)) {
    console.log(`⏭️  SKIP ${tag}: already minted`);
    continue;
  }

  // Check PDA existence on-chain
  const [receiptPDA] = deriveReceiptPDA(claim.verification_hash);
  const [mintPDA] = deriveMintPDA(claim.verification_hash);

  const existing = await connection.getAccountInfo(receiptPDA);
  if (existing !== null) {
    console.log(`⏭️  SKIP ${tag}: PDA already exists on-chain (${receiptPDA.toBase58()})`);
    const result = {
      receipt_id: claim.receipt_id,
      verification_hash: claim.verification_hash,
      receipt_pda: receiptPDA.toBase58(),
      nft_mint: mintPDA.toBase58(),
      network: networkFlag,
      status: 'already_minted',
      skipped_at: Math.floor(Date.now() / 1000),
    };
    results.push(result);
    continue;
  }

  // Determine metadata
  const upload = uploadsMap.get(claim.verification_hash);
  const metadataUri = upload?.metadata_uri || DUMMY_METADATA_URI;
  const metadataHash = upload?.metadata_hash
    ? Buffer.from(upload.metadata_hash, 'hex')
    : DUMMY_METADATA_HASH;
  const receiptName = `Trade Receipt ${claim.receipt_id.replace('receipt_', '#').replace(/_/g, ' ')}`;

  // Determine status byte from receipts cross-reference
  const receiptData = receiptsMap.get(claim.verification_hash);
  const statusByte = receiptData ? statusToByte(receiptData.status) : 0;

  const traderWallet = new PublicKey(claim.wallet);
  const claimRecipient = new PublicKey(claim.claim_recipient);
  const [recipientATA] = deriveATA(claimRecipient, mintPDA, TOKEN_2022_PROGRAM_ID);

  // 1. Ed25519 instruction
  const signatureBytes = Buffer.from(claim.signature_hex, 'hex');
  const messageBytes = Buffer.from(claim.signed_message, 'utf-8');

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: traderWallet.toBytes(),
    message: messageBytes,
    signature: signatureBytes,
  });

  // 2. ComputeBudget
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  // 3. mint_receipt instruction
  const ixData = buildMintReceiptData(
    claim.verification_hash,
    metadataHash,
    statusByte,
    metadataUri,
    receiptName,
  );

  const mintReceiptIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },   // payer
      { pubkey: traderWallet, isSigner: false, isWritable: false },            // trader_wallet
      { pubkey: claimRecipient, isSigner: false, isWritable: true },           // claim_recipient
      { pubkey: receiptPDA, isSigner: false, isWritable: true },               // receipt_anchor
      { pubkey: mintPDA, isSigner: false, isWritable: true },                  // nft_mint
      { pubkey: recipientATA, isSigner: false, isWritable: true },             // recipient_token_account
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },   // token_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // associated_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, // instructions_sysvar
    ],
    data: ixData,
  });

  // Build transaction
  const tx = new Transaction().add(ed25519Ix, computeIx, mintReceiptIx);

  console.log(`\n🔨 ${tag}`);
  console.log(`   PDA:       ${receiptPDA.toBase58()}`);
  console.log(`   Mint:      ${mintPDA.toBase58()}`);
  console.log(`   ATA:       ${recipientATA.toBase58()}`);
  console.log(`   URI:       ${metadataUri.slice(0, 60)}...`);

  if (dryRun) {
    console.log(`   🔍 Simulating...`);
    try {
      const sim = await connection.simulateTransaction(tx, [payerKeypair]);
      if (sim.value.err) {
        console.log(`   ❌ Simulation FAILED: ${JSON.stringify(sim.value.err)}`);
        if (sim.value.logs) {
          for (const log of sim.value.logs.slice(-10)) console.log(`      ${log}`);
        }
        results.push({
          receipt_id: claim.receipt_id, verification_hash: claim.verification_hash,
          receipt_pda: receiptPDA.toBase58(), nft_mint: mintPDA.toBase58(),
          network: networkFlag, status: 'sim_failed',
          error: JSON.stringify(sim.value.err), attempted_at: Math.floor(Date.now() / 1000),
        });
      } else {
        console.log(`   ✅ Simulation PASSED (CU: ${sim.value.unitsConsumed})`);
        results.push({
          receipt_id: claim.receipt_id, verification_hash: claim.verification_hash,
          receipt_pda: receiptPDA.toBase58(), nft_mint: mintPDA.toBase58(),
          network: networkFlag, status: 'sim_passed',
          compute_units: sim.value.unitsConsumed, attempted_at: Math.floor(Date.now() / 1000),
        });
      }
    } catch (e) {
      console.log(`   ❌ Simulation ERROR: ${e.message}`);
      results.push({
        receipt_id: claim.receipt_id, verification_hash: claim.verification_hash,
        network: networkFlag, status: 'sim_error',
        error: e.message, attempted_at: Math.floor(Date.now() / 1000),
      });
    }
  } else {
    console.log(`   📤 Submitting to ${networkFlag}...`);
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [payerKeypair], {
        commitment: 'confirmed',
      });
      console.log(`   ✅ CONFIRMED: ${sig}`);

      // Fetch slot
      const txInfo = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      const slot = txInfo?.slot || null;

      results.push({
        receipt_id: claim.receipt_id, verification_hash: claim.verification_hash,
        mint_tx_signature: sig, receipt_pda: receiptPDA.toBase58(), nft_mint: mintPDA.toBase58(),
        recipient_ata: recipientATA.toBase58(), network: networkFlag,
        minted_at: Math.floor(Date.now() / 1000), status: 'confirmed', slot,
      });
    } catch (e) {
      console.log(`   ❌ FAILED: ${e.message}`);
      const logs = e.logs || [];
      for (const log of logs.slice(-5)) console.log(`      ${log}`);
      results.push({
        receipt_id: claim.receipt_id, verification_hash: claim.verification_hash,
        receipt_pda: receiptPDA.toBase58(), nft_mint: mintPDA.toBase58(),
        network: networkFlag, status: 'failed',
        error: e.message, attempted_at: Math.floor(Date.now() / 1000),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Write results
// ---------------------------------------------------------------------------
if (results.length > 0) {
  const existingContent = existsSync(resultsPath) ? readFileSync(resultsPath, 'utf-8') : '';
  writeFileSync(resultsPath, existingContent + results.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nResults appended to: ${resultsPath}`);
}

const confirmed = results.filter(r => r.status === 'confirmed').length;
const skipped = results.filter(r => r.status === 'already_minted').length;
const failed = results.filter(r => r.status === 'failed' || r.status === 'sim_failed' || r.status === 'sim_error').length;
const simPassed = results.filter(r => r.status === 'sim_passed').length;

console.log(`\n${'='.repeat(60)}`);
console.log(`MINT COMPLETE: ${confirmed} confirmed, ${simPassed} sim_passed, ${skipped} skipped, ${failed} failed`);
console.log(`${'='.repeat(60)}`);
