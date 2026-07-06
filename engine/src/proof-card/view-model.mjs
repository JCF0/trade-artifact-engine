import { DISCLOSURE_TEXT } from '../proof-trust/disclosures.mjs';
import { applyWalletDisplayPolicy } from '../proof-publish/wallet-policy.mjs';

function shortenHash(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function shortenMint(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= 8) return value;
  return `${value.slice(0, 8)}...`;
}

function normalizeWalletDisplayMode(value) {
  if (value == null || value === '') return 'full';
  return value;
}

function buildDisclosures(trust) {
  const disclosures = [
    DISCLOSURE_TEXT.selectedReceiptOnly,
    DISCLOSURE_TEXT.rawQuoteOnly,
  ];

  if (trust?.correlatable_disclosure) {
    disclosures.push(trust.correlatable_disclosure);
  }

  return disclosures;
}

function buildPnlSummary(proofDetail) {
  const summary = proofDetail?.pnl_summary;
  if (!summary || typeof summary !== 'object') return null;
  return summary;
}

export function buildProofCardView(proofDetail, options = {}) {
  if (!proofDetail || typeof proofDetail !== 'object') {
    throw new TypeError('proofDetail is required');
  }

  const walletDisplayMode = normalizeWalletDisplayMode(options.walletDisplayMode);
  const renderedProofDetail = applyWalletDisplayPolicy(proofDetail, { mode: walletDisplayMode });
  const receipt = renderedProofDetail.receipt || {};
  const trust = renderedProofDetail.trust || {};
  const verification = renderedProofDetail.verification || {};
  const links = renderedProofDetail.links || {};
  const tokenDisplay = receipt.token_symbol || shortenMint(receipt.token_mint) || 'Not available';

  return {
    card_type: 'artifact_proof_card',
    title: 'Artifact Proof',
    subtitle: 'Selected receipt summary',
    receipt: {
      receipt_hash: receipt.receipt_hash || null,
      receipt_hash_short: shortenHash(receipt.receipt_hash),
      receipt_id: receipt.receipt_id || null,
      receipt_type: receipt.receipt_type || null,
      display_status: receipt.display_status || null,
      verification_status: receipt.verification_status || null,
      valuation_status: receipt.valuation_status || null,
      token_display: tokenDisplay,
      token_mint: receipt.token_mint || null,
      quote_symbol: receipt.quote_symbol || null,
      wallet: receipt.wallet || null,
      wallet_display_mode: walletDisplayMode,
    },
    trust: {
      current_level: trust.current_level ?? null,
      current_code: trust.current_code ?? null,
      current_label: trust.current_label ?? null,
    },
    verification: {
      hash_valid: verification.hash_valid ?? null,
      verifier_passed: verification.verifier_passed ?? null,
    },
    summary_fields: [
      { label: 'Receipt Type', value: receipt.receipt_type || null },
      { label: 'Display Status', value: receipt.display_status || null },
      { label: 'Verification Status', value: receipt.verification_status || null },
      { label: 'Trust Level', value: trust.current_label || null },
      { label: 'Valuation', value: receipt.valuation_status || null },
    ],
    pnl_summary: buildPnlSummary(renderedProofDetail),
    disclosures: buildDisclosures(trust),
    links: {
      proof_api_path: links.proof_api_path || null,
      verifier_api_path: receipt.receipt_hash ? `/api/verifier/${receipt.receipt_hash}` : null,
      inventory_api_path: links.inventory_api_path || null,
    },
  };
}