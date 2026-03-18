/**
 * Trade Artifact — Devnet Mint Test (v2 — lean flow)
 *
 * claim_signature + claim_message are sourced from the Ed25519
 * instruction by the program — no duplication in our args.
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
import nacl from "tweetnacl";

// ── Config ──────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey("HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ");
const RPC_URL = "https://api.devnet.solana.com";

function loadKeypair(filepath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function deriveReceiptPda(vh: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), Buffer.from(vh)],
    PROGRAM_ID
  );
}

function deriveMintPda(vh: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), Buffer.from(vh)],
    PROGRAM_ID
  );
}

function buildClaimMessage(
  vh: Uint8Array,
  trader: PublicKey,
  recipient: PublicKey
): Buffer {
  const msg =
    `TRADE_RECEIPT_CLAIM_V1\n` +
    `receipt:${Buffer.from(vh).toString("hex")}\n` +
    `wallet:${trader.toBase58()}\n` +
    `chain:solana\n` +
    `claim_recipient:${recipient.toBase58()}`;
  return Buffer.from(msg, "utf-8");
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Trade Artifact — Devnet Mint (v2 lean) ===\n");

  // Find wallet
  const candidates = [
    process.env.WALLET_PATH?.trim(),
    path.resolve(__dirname, "..", "..", "devnet-vault.json"),
    path.join(process.env.USERPROFILE || "", ".openclaw", "workspace_Rusty", "devnet-vault.json"),
  ].filter(Boolean) as string[];

  const walletPath = candidates.find(p => fs.existsSync(p));
  if (!walletPath) {
    console.error("Wallet not found. Tried:", candidates);
    process.exit(1);
  }

  const payer = loadKeypair(walletPath);
  const connection = new Connection(RPC_URL, "confirmed");

  console.log("Wallet:", payer.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(payer.publicKey)) / 1e9, "SOL\n");

  // ── 1. Test receipt data ──────────────────────────────────────
  const verificationHash = createHash("sha256")
    .update(`mint-v2-${Date.now()}-${Math.random()}`)
    .digest();

  const metadataJson = JSON.stringify({
    name: "Trade Receipt #0004",
    symbol: "TREC",
    description: "DitHyRMQ/USDC +42.9% verified trade receipt",
    image: "https://arweave.net/placeholder-image-hash",
    attributes: [
      { trait_type: "Status", value: "verified" },
      { trait_type: "PnL", value: "+42.903%" },
    ],
  });
  const metadataHash = createHash("sha256").update(metadataJson).digest();

  const status = 0;
  const receiptName = "Trade Receipt #0004";
  const metadataUri = "https://arweave.net/abcdefghijklmnopqrstuvwxyz123456789ABCDEFGH";

  // ── 2. Derive PDAs ────────────────────────────────────────────
  const [receiptPda] = deriveReceiptPda(verificationHash);
  const [mintPda] = deriveMintPda(verificationHash);
  const recipientAta = getAssociatedTokenAddressSync(
    mintPda, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
  );

  console.log("Receipt PDA:", receiptPda.toBase58());
  console.log("Mint PDA:", mintPda.toBase58());

  // ── 3. Build claim + Ed25519 ix ───────────────────────────────
  const claimMessage = buildClaimMessage(
    verificationHash, payer.publicKey, payer.publicKey
  );

  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: payer.secretKey,
    message: claimMessage,
  });

  // ── 4. Load IDL + build mint ix ───────────────────────────────
  const idlPath = path.resolve(__dirname, "..", "target", "idl", "trade_artifact.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const provider = new anchor.AnchorProvider(
    connection, new anchor.Wallet(payer), { commitment: "confirmed" }
  );
  const program = new anchor.Program(idl, provider);

  // v2: no claim_signature or claim_message in args
  const mintIx = await program.methods
    .mintReceipt(
      Array.from(verificationHash),
      Array.from(metadataHash),
      status,
      metadataUri,
      receiptName,
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

  // ── 5. Send ───────────────────────────────────────────────────
  const tx = new Transaction()
    .add(ed25519Ix)
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(mintIx);

  console.log("\nSending transaction...");
  try {
    const txSig = await sendAndConfirmTransaction(
      connection, tx, [payer], { commitment: "confirmed" }
    );

    console.log("✅ TRANSACTION CONFIRMED:", txSig);
    console.log("   Explorer: https://explorer.solana.com/tx/" + txSig + "?cluster=devnet");

    // ── 6. Verify PDA ─────────────────────────────────────────
    const acct = await (program.account as any)["receiptAnchor"].fetch(receiptPda);

    console.log("\n   PDA data:");
    console.log("   verification_hash:", Buffer.from(acct.verificationHash).toString("hex").slice(0, 16) + "...");
    console.log("   trader_wallet:", acct.traderWallet.toBase58());
    console.log("   claim_recipient:", acct.claimRecipient.toBase58());
    console.log("   status:", acct.status);
    console.log("   program_version:", acct.programVersion);
    console.log("   mint:", acct.mint.toBase58());
    console.log("   minted_at:", new Date(acct.mintedAt.toNumber() * 1000).toISOString());
    console.log("   claim_signature:", Buffer.from(acct.claimSignature).toString("hex").slice(0, 16) + "...");

    // ── 7. Verify NFT ─────────────────────────────────────────
    const bal = await connection.getTokenAccountBalance(recipientAta);
    console.log("\n   NFT balance:", bal.value.uiAmount, "(decimals:", bal.value.decimals + ")");

    console.log("\n" + "=".repeat(50));
    console.log("🎉 DEVNET MINT SUCCESSFUL (v2 — lean flow)");
    console.log("=".repeat(50));
    console.log("TX:       ", txSig);
    console.log("PDA:      ", receiptPda.toBase58());
    console.log("Mint:     ", mintPda.toBase58());
    console.log("Recipient:", payer.publicKey.toBase58());
    console.log("Name:     ", receiptName);
    console.log("URI:      ", metadataUri);
    console.log("Explorer:  https://explorer.solana.com/tx/" + txSig + "?cluster=devnet");
    console.log("=".repeat(50));

  } catch (err: any) {
    console.error("❌ TRANSACTION FAILED\n");
    if (err.logs) {
      console.error("Program logs:");
      err.logs.forEach((l: string) => console.error("  ", l));
    } else {
      console.error(err.message || err);
    }
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
