use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ");

#[program]
pub mod trade_artifact {
    use super::*;

    /// Verify claim (sourced from Ed25519 ix), create receipt PDA, mint soul-bound NFT.
    pub fn mint_receipt(
        ctx: Context<MintReceipt>,
        verification_hash: [u8; 32],
        metadata_hash: [u8; 32],
        status: u8,
        metadata_uri: String,
        receipt_name: String,
    ) -> Result<()> {
        instructions::mint_receipt::mint_receipt_handler(
            ctx,
            verification_hash,
            metadata_hash,
            status,
            metadata_uri,
            receipt_name,
        )
    }

    /// Read-only verification — checks PDA exists and returns data.
    pub fn verify_receipt(
        ctx: Context<VerifyReceipt>,
        verification_hash: [u8; 32],
    ) -> Result<()> {
        instructions::verify_receipt::verify_receipt_handler(ctx, verification_hash)
    }
}
