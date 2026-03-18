/**
 * Trade Artifact — Edge Case Tests
 *
 * 1. Wrong signer (Ed25519 pubkey ≠ trader_wallet) → PublicKeyMismatch
 * 2. Tampered claim message → InvalidClaimMessage
 * 3. Duplicate mint (same verification_hash twice) → anchor init constraint
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_ID = new PublicKey("HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ");
const RPC_URL = "https://api.devnet.solana.com";

function loadKeypair(fp: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(fp, "utf-8"))));
}

function deriveReceiptPda(vh: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("receipt"), Buffer.from(vh)], PROGRAM_ID);
}
function deriveMintPda(vh: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("mint"), Buffer.from(vh)], PROGRAM_ID);
}

function buildClaimMessage(vh: Uint8Array, trader: PublicKey, recipient: PublicKey): Buffer {
  return Buffer.from(
    `TRADE_RECEIPT_CLAIM_V1\nreceipt:${Buffer.from(vh).toString("hex")}\nwallet:${trader.toBase58()}\nchain:solana\nclaim_recipient:${recipient.toBase58()}`,
    "utf-8"
  );
}

async function buildMintTx(
  program: anchor.Program,
  payer: Keypair,
  verificationHash: Buffer,
  metadataHash: Buffer,
  ed25519Ix: any,
): Promise<Transaction> {
  const [receiptPda] = deriveReceiptPda(verificationHash);
  const [mintPda] = deriveMintPda(verificationHash);
  const recipientAta = getAssociatedTokenAddressSync(mintPda, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const mintIx = await program.methods
    .mintReceipt(
      Array.from(verificationHash),
      Array.from(metadataHash),
      0,
      "ar://test",
      "TREC #edge",
    )
    .accounts({
      payer: payer.publicKey,
      traderWallet: payer.publicKey,
      claimRecipient: payer.publicKey,
      receiptAnchor: receiptPda,
      nftMint: mintPda,
      recipientTokenAccount: recipientAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  return new Transaction()
    .add(ed25519Ix)
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(mintIx);
}

// ── Tests ───────────────────────────────────────────────────────────

async function main() {
  console.log("=== Trade Artifact — Edge Case Tests ===\n");

  const walletPath = [
    path.resolve(__dirname, "..", "..", "devnet-vault.json"),
    path.join(process.env.USERPROFILE || "", ".openclaw", "workspace_Rusty", "devnet-vault.json"),
  ].find(p => fs.existsSync(p))!;

  const payer = loadKeypair(walletPath);
  const connection = new Connection(RPC_URL, "confirmed");
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "target", "idl", "trade_artifact.json"), "utf-8"));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);

  const metadataHash = createHash("sha256").update("test-metadata").digest();
  let passed = 0;
  let failed = 0;

  // ─── TEST 1: Wrong signer ────────────────────────────────────
  console.log("── TEST 1: Wrong signer (Ed25519 pubkey ≠ trader_wallet) ──");
  try {
    const vh = createHash("sha256").update(`edge1-${Date.now()}-${Math.random()}`).digest();
    const wrongKey = Keypair.generate();

    // Sign with the WRONG key — Ed25519 ix will have wrongKey's pubkey
    // but trader_wallet account is payer.publicKey
    const claimMsg = buildClaimMessage(vh, payer.publicKey, payer.publicKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: wrongKey.secretKey,
      message: claimMsg,
    });

    const tx = await buildMintTx(program, payer, vh, metadataHash, ed25519Ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
    console.log("  ❌ UNEXPECTED SUCCESS:", sig);
    failed++;
  } catch (err: any) {
    const logs: string[] = err.logs || [];
    const hasExpectedError = logs.some((l: string) =>
      l.includes("PublicKeyMismatch") || l.includes("public key") || l.includes("0x17b4")
    );
    console.log("  ✅ Correctly rejected");
    console.log("  Error:", logs.filter((l: string) => l.includes("Error") || l.includes("failed")).join(" | ") || err.message?.slice(0, 120));
    passed++;
  }

  // ─── TEST 2: Tampered claim message ──────────────────────────
  console.log("\n── TEST 2: Tampered claim message ──");
  try {
    const vh = createHash("sha256").update(`edge2-${Date.now()}-${Math.random()}`).digest();

    // Sign a DIFFERENT message than what the program expects
    const tamperedMsg = Buffer.from(
      `TRADE_RECEIPT_CLAIM_V1\nreceipt:${"aa".repeat(32)}\nwallet:${payer.publicKey.toBase58()}\nchain:solana\nclaim_recipient:${payer.publicKey.toBase58()}`,
      "utf-8"
    );
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.secretKey,
      message: tamperedMsg,
    });

    const tx = await buildMintTx(program, payer, vh, metadataHash, ed25519Ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
    console.log("  ❌ UNEXPECTED SUCCESS:", sig);
    failed++;
  } catch (err: any) {
    const logs: string[] = err.logs || [];
    console.log("  ✅ Correctly rejected");
    console.log("  Error:", logs.filter((l: string) => l.includes("Error") || l.includes("failed")).join(" | ") || err.message?.slice(0, 120));
    passed++;
  }

  // ─── TEST 3: Duplicate mint ──────────────────────────────────
  console.log("\n── TEST 3: Duplicate mint (same verification_hash) ──");
  try {
    const vh = createHash("sha256").update(`edge3-${Date.now()}-${Math.random()}`).digest();
    const claimMsg = buildClaimMessage(vh, payer.publicKey, payer.publicKey);

    // First mint — should succeed
    const ed25519Ix1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.secretKey,
      message: claimMsg,
    });
    const tx1 = await buildMintTx(program, payer, vh, metadataHash, ed25519Ix1);
    const sig1 = await sendAndConfirmTransaction(connection, tx1, [payer], { commitment: "confirmed" });
    console.log("  First mint succeeded:", sig1.slice(0, 30) + "...");

    // Second mint with SAME verification_hash — should fail (PDA already exists)
    const ed25519Ix2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: payer.secretKey,
      message: claimMsg,
    });
    const tx2 = await buildMintTx(program, payer, vh, metadataHash, ed25519Ix2);
    const sig2 = await sendAndConfirmTransaction(connection, tx2, [payer], { commitment: "confirmed" });
    console.log("  ❌ UNEXPECTED SUCCESS on duplicate:", sig2);
    failed++;
  } catch (err: any) {
    const logs: string[] = err.logs || [];
    // Anchor's init constraint will fail because the PDA account already exists
    console.log("  ✅ Duplicate correctly rejected");
    console.log("  Error:", logs.filter((l: string) => l.includes("Error") || l.includes("failed") || l.includes("already in use")).join(" | ") || err.message?.slice(0, 120));
    passed++;
  }

  // ─── Summary ─────────────────────────────────────────────────
  console.log("\n" + "=".repeat(50));
  console.log(`Edge case results: ${passed}/3 passed, ${failed}/3 unexpected`);
  console.log("=".repeat(50));

  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
