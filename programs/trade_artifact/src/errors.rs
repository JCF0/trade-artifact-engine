use anchor_lang::prelude::*;

#[error_code]
pub enum TradeArtifactError {
    #[msg("No Ed25519 signature verification instruction found")]
    MissingEd25519Instruction,

    #[msg("Ed25519 instruction has invalid program id")]
    InvalidEd25519Program,

    #[msg("Ed25519 instruction data is malformed")]
    MalformedEd25519Data,

    #[msg("Signature in Ed25519 instruction does not match claim_signature")]
    SignatureMismatch,

    #[msg("Public key in Ed25519 instruction does not match trader_wallet")]
    PublicKeyMismatch,

    #[msg("Message in Ed25519 instruction does not match claim_message")]
    MessageMismatch,

    #[msg("Claim message does not match expected format")]
    InvalidClaimMessage,

    #[msg("Invalid receipt status (must be 0 or 1)")]
    InvalidStatus,

    #[msg("Arithmetic overflow in space calculation")]
    ArithmeticOverflow,

    #[msg("Multiple Ed25519 instructions found — exactly one required")]
    MultipleEd25519Instructions,
}
