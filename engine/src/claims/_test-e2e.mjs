/**
 * End-to-end test: generate a fake receipt matching the devnet-vault key,
 * sign it with claim-signer, verify with verify-claims.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { Keypair } from '@solana/web3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// Load devnet key
const keypairPath = resolve(ROOT, '..', '..', 'devnet-vault.json');
const k = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf-8'))));
const wallet = k.publicKey.toBase58();

// Create test receipt
const testReceipt = {
  receipt_id: 'receipt_test_0001_DEADBEEF',
  receipt_version: '1.0',
  cycle_id: 'cycle_test_1_DEADBEEF',
  wallet,
  chain: 'solana',
  token_mint: 'DEADBEEFaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  status: 'verified',
  accounting_method: 'weighted_average_cost_basis',
  avg_entry_price: 0.01,
  avg_exit_price: 0.02,
  quote_currency: 'So11111111111111111111111111111111111111112',
  total_cost_basis: 10,
  total_exit_proceeds: 20,
  realized_pnl: 10,
  realized_pnl_pct: 100,
  total_bought: 1000,
  total_sold: 1000,
  peak_position: 1000,
  remaining_balance: 0,
  num_buys: 1,
  num_sells: 1,
  opened_at: 1700000000,
  closed_at: 1700100000,
  hold_time_seconds: 100000,
  entry_txs: [{ tx_hash: 'aaaa1111', timestamp: 1700000000, amount: 1000, quote_amount: 10 }],
  exit_txs: [{ tx_hash: 'bbbb2222', timestamp: 1700100000, amount: 1000, quote_amount: 20 }],
  _hash_inputs: { raw_entry_price_avg: 0.01, raw_exit_price_avg: 0.02 },
  generated_at: Math.floor(Date.now() / 1000),
  verification_hash: null,
};

// Compute verification hash (raw doubles + status, per frozen spec)
const entryH = testReceipt.entry_txs.map(t => t.tx_hash).sort();
const exitH = testReceipt.exit_txs.map(t => t.tx_hash).sort();
testReceipt.verification_hash = createHash('sha256').update(JSON.stringify([
  testReceipt.wallet, testReceipt.chain, testReceipt.token_mint, entryH, exitH,
  testReceipt._hash_inputs.raw_entry_price_avg, testReceipt._hash_inputs.raw_exit_price_avg,
  testReceipt.accounting_method, testReceipt.receipt_version,
  testReceipt.status,
])).digest('hex');

// Write test receipt
const testDir = resolve(ROOT, 'data/_test');
mkdirSync(testDir, { recursive: true });
const receiptsPath = resolve(testDir, 'receipts.jsonl');
writeFileSync(receiptsPath, JSON.stringify(testReceipt) + '\n');
console.log(`Test receipt written: ${receiptsPath}`);
console.log(`  wallet: ${wallet}`);
console.log(`  verification_hash: ${testReceipt.verification_hash}`);
console.log(`  keypair: ${keypairPath}`);
console.log(`\nNow run:`);
console.log(`  node src/claims/claim-signer.mjs ${keypairPath} ${wallet} ${receiptsPath} ${testDir}`);
console.log(`  node src/claims/verify-claims.mjs ${resolve(testDir, 'claims.jsonl')}`);
