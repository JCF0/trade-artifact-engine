import { computeReceiptHash } from '../ledger/receipt-promotion.mjs';
import { verifyReceipt } from '../ledger/receipt-verifier.mjs';

const ECONOMICS = [
  'segment_index', 'accounting_method', 'entry_tx_hashes', 'exit_tx_hashes',
  'total_bought_qty', 'total_bought_quote', 'avg_buy_quote_price',
  'total_sold_qty', 'total_sold_quote', 'avg_sell_quote_price',
  'allocated_cost_basis_quote', 'remaining_qty', 'remaining_cost_basis_quote',
  'realized_pnl_quote', 'realized_pnl_pct', 'hold_time_seconds', 'num_buys', 'num_sells',
];

export function makeFixture(symbol = 'JUP', overrides = {}) {
  const tokenMint = symbol === 'RAY'
    ? '4k3Dyjzvzp8eXw3bFJ3hHnQ5XVkY6C4FfZbbQXfH7Y'
    : 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
  const receipt = {
    receipt_id: `art_v12_cp_${tokenMint.slice(0, 8)}_0`, receipt_version: '1.2.0', receipt_type: 'closed_position',
    token_mint: tokenMint, wallet: '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni', chain: 'solana', segment_index: 0,
    verification_status: 'verified', display_status: 'Verified Closed Position',
    accounting_method: 'weighted_average_position_accounting_v1',
    quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', quote_symbol: 'USDC', valuation_status: 'raw_quote',
    total_bought_qty: symbol === 'RAY' ? 2500 : 1000, total_bought_quote: 100, avg_buy_quote_price: symbol === 'RAY' ? 0.04 : 0.1,
    total_sold_qty: symbol === 'RAY' ? 2500 : 1000, total_sold_quote: 150, avg_sell_quote_price: symbol === 'RAY' ? 0.06 : 0.15,
    allocated_cost_basis_quote: 100, remaining_qty: 0, remaining_cost_basis_quote: 0,
    realized_pnl_quote: 50, realized_pnl_pct: 50, unrealized_pnl_quote: null, unrealized_pnl_pct: null,
    position_status: 'closed', first_event_at: 1700000000, last_event_at: 1700000300, snapshot_at: null, hold_time_seconds: 300,
    entry_tx_hashes: [`${symbol}-entry-1`, `${symbol}-entry-2`], exit_tx_hashes: [`${symbol}-exit-1`], num_buys: 2, num_sells: 1,
    limitations: { receipt_scope: 'closed_position', pnl_type: 'realized_closed', price_source: 'on_chain_swaps', valuation_currency: 'raw_quote', disclosures: ['no_usd_normalization'] },
    flags: [], candidate_hash: 'c'.repeat(64), source: 'position_ledger_v1', promoted_at: 1700000300,
    promoted_from: `candidate-${symbol}`, ledger_accounting_version: 'weighted_average_position_accounting_v1',
    ...overrides,
  };
  receipt.receipt_hash = computeReceiptHash(receipt);
  const archiveRecord = { archive_record_version: 'receipt_package_archive_record_v1' };
  const economicsRecord = { economics_version: 'receipt_package_economics_v1' };
  for (const [key, value] of Object.entries(receipt)) {
    (ECONOMICS.includes(key) ? economicsRecord : archiveRecord)[key] = structuredClone(value);
  }
  economicsRecord.receipt_hash = receipt.receipt_hash;
  economicsRecord.receipt_version = receipt.receipt_version;
  economicsRecord.receipt_type = receipt.receipt_type;
  const verificationResult = verifyReceipt(receipt);
  const inputCommitment = {
    fetch_profile: 'receipt_scoped_transaction_selection_v1',
    normalization_profile: 'artifact_normalization_v1', reconstruction_engine_version: 'position_ledger_v1',
    accounting_method_version: 'weighted_average_position_accounting_v1',
  };
  return { canonicalReceipt: receipt, verificationResult, archiveRecord, economicsRecord, inputCommitment };
}

export function clone(value) { return structuredClone(value); }
