/**
 * Pipeline — On-chain Mint
 * Extracted from mint-one.mjs v1 (Phase 0.5).
 *
 * Submits the mint_receipt transaction to the Solana program.
 */
import { createHash } from 'crypto';
import {
  Connection, PublicKey, Transaction, TransactionInstruction,
  Ed25519Program, ComputeBudgetProgram, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { appendFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const PROGRAM_ID = new PublicKey('HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const RECEIPT_SEED = Buffer.from('receipt');
const MINT_SEED = Buffer.from('mint');

/**
 * Submit mint transaction on-chain.
 * @param {object} params
 * @param {object} params.receipt - Receipt object
 * @param {Keypair} params.keypair - Solana Keypair (payer + signer)
 * @param {string} params.recipient - Recipient pubkey string
 * @param {Uint8Array} params.messageBytes - Claim message bytes
 * @param {Uint8Array} params.signature - Ed25519 claim signature
 * @param {string} params.metadataUri - Arweave metadata URI
 * @param {Buffer} params.metadataHash - SHA-256 of metadata JSON
 * @param {object} params.opts - { network, dryRun, dataDir, endpoints }
 * @returns {{ txSignature?: string, receiptPDA: string, mintPDA: string, simulated?: boolean }}
 */
export async function mintOnChain({ receipt, keypair, recipient, messageBytes, signature, metadataUri, metadataHash, opts }) {
  const { network, dryRun, dataDir, endpoints } = opts;

  const connection = new Connection(endpoints[network], 'confirmed');
  const hashBytes = Buffer.from(receipt.verification_hash, 'hex');
  const metadataHashBytes = Buffer.isBuffer(metadataHash) ? metadataHash : Buffer.from(metadataHash);

  // Derive PDAs
  const [receiptPDA] = PublicKey.findProgramAddressSync([RECEIPT_SEED, hashBytes], PROGRAM_ID);
  const [mintPDA] = PublicKey.findProgramAddressSync([MINT_SEED, hashBytes], PROGRAM_ID);

  // Check if already minted
  const existingPda = await connection.getAccountInfo(receiptPDA);
  if (existingPda) {
    console.log(`  ⚠️  Receipt PDA already exists: ${receiptPDA.toBase58()}`);
    console.log(`  This receipt has already been minted. Skipping.`);
    return { receiptPDA: receiptPDA.toBase58(), mintPDA: mintPDA.toBase58(), alreadyMinted: true };
  }

  // Derive ATA
  const recipientPubkey = new PublicKey(recipient);
  const [ata] = PublicKey.findProgramAddressSync(
    [recipientPubkey.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPDA.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Status byte
  const statusByte = receipt.status === 'verified' ? 0 : 1;

  // Receipt name
  const receiptName = `Trade Receipt ${receipt.receipt_id.replace('receipt_', '#').replace(/_/g, ' ')}`;

  // Build mint_receipt instruction data
  const discriminator = createHash('sha256').update('global:mint_receipt').digest().subarray(0, 8);
  const uriBytes = Buffer.from(metadataUri, 'utf-8');
  const nameBytes = Buffer.from(receiptName, 'utf-8');
  const ixDataLen = 8 + 32 + 32 + 1 + 4 + uriBytes.length + 4 + nameBytes.length;
  const ixData = Buffer.alloc(ixDataLen);
  let offset = 0;
  discriminator.copy(ixData, offset); offset += 8;
  hashBytes.copy(ixData, offset); offset += 32;
  metadataHashBytes.copy(ixData, offset); offset += 32;
  ixData.writeUInt8(statusByte, offset); offset += 1;
  ixData.writeUInt32LE(uriBytes.length, offset); offset += 4;
  uriBytes.copy(ixData, offset); offset += uriBytes.length;
  ixData.writeUInt32LE(nameBytes.length, offset); offset += 4;
  nameBytes.copy(ixData, offset);

  // Account keys
  const keys = [
    { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
    { pubkey: new PublicKey(receipt.wallet), isSigner: false, isWritable: false },
    { pubkey: recipientPubkey, isSigner: false, isWritable: true },
    { pubkey: receiptPDA, isSigner: false, isWritable: true },
    { pubkey: mintPDA, isSigner: false, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ];

  const mintIx = new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixData });
  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: keypair.publicKey.toBytes(),
    message: messageBytes,
    signature,
  });
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const tx = new Transaction().add(ed25519Ix).add(computeIx).add(mintIx);

  if (dryRun) {
    console.log(`  Simulating...`);
    try {
      const simResult = await connection.simulateTransaction(tx, [keypair]);
      if (simResult.value.err) {
        console.log(`  ❌ Simulation failed: ${JSON.stringify(simResult.value.err)}`);
        if (simResult.value.logs) {
          for (const log of simResult.value.logs.slice(-10)) console.log(`    ${log}`);
        }
      } else {
        console.log(`  ✅ Simulation passed (CU: ${simResult.value.unitsConsumed})`);
      }
    } catch (e) {
      console.log(`  ❌ Simulation error: ${e.message}`);
    }
    return { receiptPDA: receiptPDA.toBase58(), mintPDA: mintPDA.toBase58(), simulated: true };
  }

  // Live submit
  console.log(`  Submitting to ${network}...`);
  console.log(`    PDA:  ${receiptPDA.toBase58()}`);
  console.log(`    Mint: ${mintPDA.toBase58()}`);
  console.log(`    ATA:  ${ata.toBase58()}`);

  const txSig = await sendAndConfirmTransaction(connection, tx, [keypair], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });

  console.log(`\n  ✅ MINTED!`);
  console.log(`    TX: ${txSig}`);
  console.log(`    PDA: ${receiptPDA.toBase58()}`);
  console.log(`    Mint: ${mintPDA.toBase58()}`);
  console.log(`    Metadata: ${metadataUri}`);

  // Record result
  if (dataDir) {
    mkdirSync(resolve(dataDir, 'mints'), { recursive: true });
    const mintResult = {
      receipt_id: receipt.receipt_id,
      verification_hash: receipt.verification_hash,
      tx_signature: txSig,
      receipt_pda: receiptPDA.toBase58(),
      nft_mint: mintPDA.toBase58(),
      status: 'confirmed',
      network,
      minted_at: Math.floor(Date.now() / 1000),
    };
    appendFileSync(resolve(dataDir, 'mints/mint_results.jsonl'), JSON.stringify(mintResult) + '\n');
  }

  return { txSignature: txSig, receiptPDA: receiptPDA.toBase58(), mintPDA: mintPDA.toBase58() };
}
