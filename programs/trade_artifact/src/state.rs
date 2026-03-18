use anchor_lang::prelude::*;

/// On-chain anchor for a minted trade receipt.
/// Seeds: ["receipt", verification_hash]
#[account]
#[derive(InitSpace)]
pub struct ReceiptAnchor {
    /// SHA-256 of receipt canonical fields
    pub verification_hash: [u8; 32],
    /// SHA-256 of the Arweave metadata JSON content
    pub metadata_hash: [u8; 32],
    /// Original trading wallet
    pub trader_wallet: Pubkey,
    /// Authorized mint destination
    pub claim_recipient: Pubkey,
    /// Ed25519 signature of claim message
    pub claim_signature: [u8; 64],
    /// 0=verified, 1=verified_mixed_quote
    pub status: u8,
    /// Protocol version that minted this receipt (V1 = 1)
    pub program_version: u8,
    /// NFT mint address (Token-2022)
    pub mint: Pubkey,
    /// Unix timestamp of mint tx
    pub minted_at: i64,
    /// PDA bump seed
    pub bump: u8,
}

// 32 + 32 + 32 + 32 + 64 + 1 + 1 + 32 + 8 + 1 = 235 bytes
// + 8 byte discriminator = 243 bytes total

pub const RECEIPT_SEED: &[u8] = b"receipt";
pub const MINT_SEED: &[u8] = b"mint";
pub const PROGRAM_VERSION_V1: u8 = 1;
