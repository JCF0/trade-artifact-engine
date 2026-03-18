use anchor_lang::prelude::*;
use crate::state::*;

#[derive(Accounts)]
#[instruction(verification_hash: [u8; 32])]
pub struct VerifyReceipt<'info> {
    /// Receipt anchor PDA — deserialized by Anchor.
    /// If the account doesn't exist or has invalid data, this fails.
    #[account(
        seeds = [RECEIPT_SEED, verification_hash.as_ref()],
        bump = receipt_anchor.bump,
    )]
    pub receipt_anchor: Account<'info, ReceiptAnchor>,
}

/// Read-only verification. No state changes.
/// Returns Ok(()) if the receipt PDA exists and deserializes correctly.
/// The client reads the ReceiptAnchor data from the account.
pub fn verify_receipt_handler(
    ctx: Context<VerifyReceipt>,
    _verification_hash: [u8; 32],
) -> Result<()> {
    // Anchor has already deserialized and validated the PDA.
    // Emit a log for convenience.
    let anchor = &ctx.accounts.receipt_anchor;
    msg!(
        "Receipt verified: hash={}, mint={}, status={}, version={}",
        hex_short(&anchor.verification_hash),
        anchor.mint,
        anchor.status,
        anchor.program_version
    );
    Ok(())
}

fn hex_short(bytes: &[u8; 32]) -> String {
    let hex: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(16);
    for &b in &bytes[..8] {
        s.push(hex[(b >> 4) as usize] as char);
        s.push(hex[(b & 0x0f) as usize] as char);
    }
    s.push_str("...");
    s
}
