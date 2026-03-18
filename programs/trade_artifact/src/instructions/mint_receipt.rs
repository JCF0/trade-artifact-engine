use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::invoke_signed,
    program::invoke,
    instruction::{AccountMeta, Instruction},
    sysvar::instructions as ix_sysvar,
    system_instruction,
};
use anchor_spl::associated_token::AssociatedToken;

use anchor_spl::token_2022::spl_token_2022;
use spl_token_2022::{
    extension::ExtensionType,
    instruction as token_instruction,
    state::Mint as MintState,
};

use crate::errors::TradeArtifactError;
use crate::state::*;

// ── Constants ───────────────────────────────────────────────────────

/// Ed25519 native program ID: Ed25519SigVerify111111111111111111111111111
const ED25519_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x03, 0x7d, 0x46, 0xd6, 0x7c, 0x93, 0xfb, 0xbe,
    0x12, 0xf9, 0x42, 0x8f, 0x83, 0x8d, 0x40, 0xff,
    0x05, 0x70, 0x74, 0x49, 0x27, 0xf4, 0x8a, 0x64,
    0xfc, 0xca, 0x70, 0x44, 0x80, 0x00, 0x00, 0x00,
]);

/// SPL discriminator for token-metadata-interface Initialize instruction.
/// = sha256("spl_token_metadata_interface:initialize_account")[..8]
const TOKEN_METADATA_INIT_DISCRIMINATOR: [u8; 8] = [210, 225, 30, 162, 88, 184, 77, 141];

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_encode(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize]);
        out.push(HEX[(b & 0x0f) as usize]);
    }
    out
}

/// Data extracted from the Ed25519 program instruction.
struct Ed25519ClaimData {
    pub signature: [u8; 64],
    pub message: Vec<u8>,
}

// ── Accounts ────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(
    verification_hash: [u8; 32],
    metadata_hash: [u8; 32],
    status: u8,
    metadata_uri: String,
    receipt_name: String,
)]
pub struct MintReceipt<'info> {
    /// Pays rent + tx fees
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Trading wallet — verified via Ed25519 signature in the claim.
    /// CHECK: Authenticity proven by the Ed25519 program instruction.
    pub trader_wallet: UncheckedAccount<'info>,

    /// Where the NFT will be minted. Validated against claim_message.
    /// CHECK: Matched to claim_recipient extracted from the signed claim.
    #[account(mut)]
    pub claim_recipient: UncheckedAccount<'info>,

    /// Receipt anchor PDA — stores on-chain proof data.
    /// Uniqueness enforced by PDA derivation: one per verification_hash.
    #[account(
        init,
        payer = payer,
        space = 8 + ReceiptAnchor::INIT_SPACE,
        seeds = [RECEIPT_SEED, verification_hash.as_ref()],
        bump,
    )]
    pub receipt_anchor: Account<'info, ReceiptAnchor>,

    /// NFT mint (Token-2022). Created manually for extension support.
    /// CHECK: Derived as PDA, created via CPI in handler.
    #[account(
        mut,
        seeds = [MINT_SEED, verification_hash.as_ref()],
        bump,
    )]
    pub nft_mint: UncheckedAccount<'info>,

    /// Recipient's associated token account for the NFT.
    /// CHECK: Created via ATA program CPI in handler.
    #[account(mut)]
    pub recipient_token_account: UncheckedAccount<'info>,

    /// Token-2022 program
    /// CHECK: Constrained to the canonical Token-2022 program id.
    #[account(address = spl_token_2022::id())]
    pub token_program: UncheckedAccount<'info>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// Instructions sysvar — used to read the Ed25519 instruction.
    /// CHECK: Constrained to the instructions sysvar address.
    #[account(address = ix_sysvar::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

// ── Handler ─────────────────────────────────────────────────────────

pub fn mint_receipt_handler(
    ctx: Context<MintReceipt>,
    verification_hash: [u8; 32],
    metadata_hash: [u8; 32],
    status: u8,
    metadata_uri: String,
    receipt_name: String,
) -> Result<()> {
    // ── 0. Validate status ──────────────────────────────────────
    require!(status <= 1, TradeArtifactError::InvalidStatus);

    let trader_wallet_key = ctx.accounts.trader_wallet.key();
    let claim_recipient_key = ctx.accounts.claim_recipient.key();
    let receipt_anchor_key = ctx.accounts.receipt_anchor.key();
    let nft_mint_key = *ctx.accounts.nft_mint.key;
    let payer_key = *ctx.accounts.payer.key;

    // ── 1. Extract + verify Ed25519 claim data ──────────────────
    //    Signature and message are sourced directly from the
    //    Ed25519 instruction — no duplication in our args.
    let claim_data = extract_and_verify_ed25519(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &trader_wallet_key,
    )?;

    // ── 2. Verify claim message content ─────────────────────────
    verify_claim_message(
        &claim_data.message,
        &verification_hash,
        &trader_wallet_key,
        &claim_recipient_key,
    )?;

    // ── 3. Compute seeds ────────────────────────────────────────
    let receipt_bump = ctx.bumps.receipt_anchor;
    let mint_bump = ctx.bumps.nft_mint;
    let receipt_bump_arr = [receipt_bump];
    let mint_bump_arr = [mint_bump];
    let receipt_seeds: &[&[u8]] = &[RECEIPT_SEED, verification_hash.as_ref(), &receipt_bump_arr];
    let mint_seeds: &[&[u8]] = &[MINT_SEED, verification_hash.as_ref(), &mint_bump_arr];

    // ── 4. Create Token-2022 mint with extensions ───────────────
    create_nft_mint(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.nft_mint.to_account_info(),
        &ctx.accounts.receipt_anchor.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &payer_key,
        &nft_mint_key,
        &receipt_anchor_key,
        mint_seeds,
        receipt_seeds,
        &receipt_name,
        &metadata_uri,
    )?;

    // ── 5. Create ATA for recipient ─────────────────────────────
    create_recipient_ata(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.recipient_token_account.to_account_info(),
        &ctx.accounts.claim_recipient.to_account_info(),
        &ctx.accounts.nft_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
        &payer_key,
        &claim_recipient_key,
        &nft_mint_key,
    )?;

    // ── 6. Mint 1 token ─────────────────────────────────────────
    invoke_signed(
        &token_instruction::mint_to(
            &spl_token_2022::id(),
            &nft_mint_key,
            ctx.accounts.recipient_token_account.key,
            &receipt_anchor_key,
            &[],
            1,
        )?,
        &[
            ctx.accounts.nft_mint.to_account_info(),
            ctx.accounts.recipient_token_account.to_account_info(),
            ctx.accounts.receipt_anchor.to_account_info(),
        ],
        &[receipt_seeds],
    )?;

    // ── 7. Remove mint authority (supply permanently = 1) ───────
    invoke_signed(
        &token_instruction::set_authority(
            &spl_token_2022::id(),
            &nft_mint_key,
            None,
            spl_token_2022::instruction::AuthorityType::MintTokens,
            &receipt_anchor_key,
            &[],
        )?,
        &[
            ctx.accounts.nft_mint.to_account_info(),
            ctx.accounts.receipt_anchor.to_account_info(),
        ],
        &[receipt_seeds],
    )?;

    // ── 8. Write receipt anchor data ────────────────────────────
    let anchor = &mut ctx.accounts.receipt_anchor;
    anchor.verification_hash = verification_hash;
    anchor.metadata_hash = metadata_hash;
    anchor.trader_wallet = trader_wallet_key;
    anchor.claim_recipient = claim_recipient_key;
    anchor.claim_signature = claim_data.signature;
    anchor.status = status;
    anchor.program_version = PROGRAM_VERSION_V1;
    anchor.mint = nft_mint_key;
    anchor.minted_at = Clock::get()?.unix_timestamp;
    anchor.bump = receipt_bump;

    msg!(
        "Trade receipt minted: mint={}, pda={}",
        nft_mint_key,
        ctx.accounts.receipt_anchor.key()
    );

    Ok(())
}

// ── Ed25519 extraction + verification ───────────────────────────────

/// Find the Ed25519 instruction in the transaction, extract its
/// signature, public key, and message. Verify the public key matches
/// trader_wallet. The Ed25519 program has already verified the crypto
/// — if the transaction didn't fail, the signature is valid.
fn extract_and_verify_ed25519(
    sysvar_info: &AccountInfo,
    trader_wallet: &Pubkey,
) -> Result<Ed25519ClaimData> {
    let num_ix = ix_sysvar::load_current_index_checked(sysvar_info)
        .map_err(|_| TradeArtifactError::MissingEd25519Instruction)?;

    // Scan ALL instructions — require exactly one Ed25519 instruction.
    // Reject transactions with zero or multiple to avoid ambiguity.
    let mut ed25519_ix = None;
    let mut ed25519_count: u32 = 0;
    for i in 0..num_ix {
        let ix = ix_sysvar::load_instruction_at_checked(i as usize, sysvar_info)
            .map_err(|_| TradeArtifactError::MissingEd25519Instruction)?;
        if ix.program_id == ED25519_PROGRAM_ID {
            ed25519_count += 1;
            if ed25519_ix.is_none() {
                ed25519_ix = Some(ix);
            }
        }
    }

    require!(ed25519_count > 0, TradeArtifactError::MissingEd25519Instruction);
    require!(ed25519_count == 1, TradeArtifactError::MultipleEd25519Instructions);
    let ix = ed25519_ix.unwrap();
    let data = &ix.data;
    require!(data.len() >= 16, TradeArtifactError::MalformedEd25519Data);
    require!(data[0] == 1, TradeArtifactError::MalformedEd25519Data);

    // Parse Ed25519SignatureOffsets (bytes 2..16)
    let sig_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let sig_ix_idx = u16::from_le_bytes([data[4], data[5]]);
    let pk_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let pk_ix_idx = u16::from_le_bytes([data[8], data[9]]);
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;
    let msg_ix_idx = u16::from_le_bytes([data[14], data[15]]);

    require!(
        sig_ix_idx == 0xFFFF && pk_ix_idx == 0xFFFF && msg_ix_idx == 0xFFFF,
        TradeArtifactError::MalformedEd25519Data
    );

    require!(
        sig_offset + 64 <= data.len()
            && pk_offset + 32 <= data.len()
            && msg_offset + msg_size <= data.len(),
        TradeArtifactError::MalformedEd25519Data
    );

    // Verify the public key matches trader_wallet
    require!(
        &data[pk_offset..pk_offset + 32] == trader_wallet.to_bytes(),
        TradeArtifactError::PublicKeyMismatch
    );

    // Extract signature
    let mut signature = [0u8; 64];
    signature.copy_from_slice(&data[sig_offset..sig_offset + 64]);

    // Extract message
    let message = data[msg_offset..msg_offset + msg_size].to_vec();

    Ok(Ed25519ClaimData { signature, message })
}

// ── Claim message verification ──────────────────────────────────────

fn verify_claim_message(
    claim_message: &[u8],
    verification_hash: &[u8; 32],
    trader_wallet: &Pubkey,
    claim_recipient: &Pubkey,
) -> Result<()> {
    let mut expected = Vec::with_capacity(256);
    expected.extend_from_slice(b"TRADE_RECEIPT_CLAIM_V1\nreceipt:");
    expected.extend_from_slice(&hex_encode(verification_hash));
    expected.extend_from_slice(b"\nwallet:");
    expected.extend_from_slice(trader_wallet.to_string().as_bytes());
    expected.extend_from_slice(b"\nchain:solana\nclaim_recipient:");
    expected.extend_from_slice(claim_recipient.to_string().as_bytes());

    require!(
        claim_message == expected.as_slice(),
        TradeArtifactError::InvalidClaimMessage
    );

    Ok(())
}

// ── Token-2022 mint creation ────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn create_nft_mint<'info>(
    payer: &AccountInfo<'info>,
    nft_mint: &AccountInfo<'info>,
    receipt_anchor: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    payer_key: &Pubkey,
    nft_mint_key: &Pubkey,
    receipt_anchor_key: &Pubkey,
    mint_seeds: &[&[u8]],
    receipt_seeds: &[&[u8]],
    receipt_name: &str,
    metadata_uri: &str,
) -> Result<()> {
    let symbol = "TREC";

    let base_space = ExtensionType::try_calculate_account_len::<MintState>(&[
        ExtensionType::NonTransferable,
        ExtensionType::MetadataPointer,
    ])
    .map_err(|_| TradeArtifactError::ArithmeticOverflow)?;

    let metadata_data_len: usize = 8 + 4 + 32 + 32
        + 4 + receipt_name.len()
        + 4 + symbol.len()
        + 4 + metadata_uri.len()
        + 4;

    let total_space = base_space
        .checked_add(metadata_data_len)
        .ok_or(TradeArtifactError::ArithmeticOverflow)?;

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(total_space);

    // Create mint account — base size only, pre-funded for final size
    invoke_signed(
        &system_instruction::create_account(
            payer_key,
            nft_mint_key,
            lamports,
            base_space as u64,
            &spl_token_2022::id(),
        ),
        &[payer.clone(), nft_mint.clone(), system_program.clone()],
        &[mint_seeds],
    )?;

    invoke_signed(
        &token_instruction::initialize_non_transferable_mint(
            &spl_token_2022::id(),
            nft_mint_key,
        )?,
        &[nft_mint.clone()],
        &[mint_seeds],
    )?;

    invoke_signed(
        &spl_token_2022::extension::metadata_pointer::instruction::initialize(
            &spl_token_2022::id(),
            nft_mint_key,
            Some(*receipt_anchor_key),
            Some(*nft_mint_key),
        )?,
        &[nft_mint.clone()],
        &[mint_seeds],
    )?;

    invoke_signed(
        &token_instruction::initialize_mint2(
            &spl_token_2022::id(),
            nft_mint_key,
            receipt_anchor_key,
            None,
            0,
        )?,
        &[nft_mint.clone()],
        &[mint_seeds],
    )?;

    invoke_signed(
        &build_init_metadata_ix(nft_mint_key, receipt_anchor_key, receipt_name, symbol, metadata_uri),
        &[nft_mint.clone(), receipt_anchor.clone()],
        &[receipt_seeds],
    )?;

    Ok(())
}

fn build_init_metadata_ix(
    mint: &Pubkey,
    authority: &Pubkey,
    name: &str,
    symbol: &str,
    uri: &str,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 4 + name.len() + 4 + symbol.len() + 4 + uri.len());
    data.extend_from_slice(&TOKEN_METADATA_INIT_DISCRIMINATOR);

    for s in [name, symbol, uri] {
        data.extend_from_slice(&(s.len() as u32).to_le_bytes());
        data.extend_from_slice(s.as_bytes());
    }

    Instruction {
        program_id: spl_token_2022::id(),
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(*authority, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

// ── Create recipient ATA ────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn create_recipient_ata<'info>(
    payer: &AccountInfo<'info>,
    recipient_ata: &AccountInfo<'info>,
    claim_recipient: &AccountInfo<'info>,
    nft_mint: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    ata_program: &AccountInfo<'info>,
    payer_key: &Pubkey,
    claim_recipient_key: &Pubkey,
    nft_mint_key: &Pubkey,
) -> Result<()> {
    let ix = anchor_spl::associated_token::spl_associated_token_account
        ::instruction::create_associated_token_account(
            payer_key,
            claim_recipient_key,
            nft_mint_key,
            &spl_token_2022::id(),
        );

    invoke(
        &ix,
        &[
            payer.clone(),
            recipient_ata.clone(),
            claim_recipient.clone(),
            nft_mint.clone(),
            system_program.clone(),
            token_program.clone(),
            ata_program.clone(),
        ],
    )?;

    Ok(())
}
