/**
 * Pipeline — Claim Signer
 * Extracted from mint-one.mjs v1 (Phase 0.5).
 *
 * Signs a claim message for a receipt using Ed25519.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import { CHAIN } from './constants.mjs';

/**
 * Sign a claim for a receipt.
 * @param {object} receipt - Receipt object with verification_hash and wallet
 * @param {Keypair} keypair - Solana Keypair
 * @param {string} recipient - Claim recipient pubkey
 * @returns {{ claim: object, messageBytes: Uint8Array, signature: Uint8Array }}
 */
export function signClaim(receipt, keypair, recipient) {
  const canonicalMessage =
    `TRADE_RECEIPT_CLAIM_V1\n` +
    `receipt:${receipt.verification_hash}\n` +
    `wallet:${receipt.wallet}\n` +
    `chain:${CHAIN}\n` +
    `claim_recipient:${recipient}`;

  const messageBytes = new TextEncoder().encode(canonicalMessage);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);

  // Self-verify
  if (!nacl.sign.detached.verify(messageBytes, signature, keypair.publicKey.toBytes())) {
    throw new Error('Claim self-verification failed');
  }

  const claim = {
    claim_version: '1.0',
    receipt_id: receipt.receipt_id,
    verification_hash: receipt.verification_hash,
    wallet: receipt.wallet,
    chain: CHAIN,
    claim_recipient: recipient,
    signature_bs58: bs58.encode(signature),
    signature_hex: Buffer.from(signature).toString('hex'),
    signed_message: canonicalMessage,
    claimed_at: Math.floor(Date.now() / 1000),
  };

  return { claim, messageBytes, signature };
}
