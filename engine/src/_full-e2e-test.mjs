/**
 * Full end-to-end test: receipt → render → upload → claim → mint → verify
 * Uses devnet-vault key for everything.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { createCanvas } from 'canvas';
import { Keypair } from '@solana/web3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const keypairPath = resolve(ROOT, '..', '..', 'devnet-vault.json');
const k = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf-8'))));
const wallet = k.publicKey.toBase58();

// Unique verification hash per run (timestamp-based)
const runTs = Date.now();
const testDir = resolve(ROOT, 'data/_e2e_test');
mkdirSync(resolve(testDir, 'receipts'), { recursive: true });
mkdirSync(resolve(testDir, 'renders'), { recursive: true });

// 1. Create test receipt
const receipt = {
  receipt_id: `receipt_e2e_${runTs}`,
  receipt_version: '1.0',
  cycle_id: `cycle_e2e_${runTs}`,
  wallet,
  chain: 'solana',
  token_mint: `E2Etest${runTs}aaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 44),
  status: 'verified',
  accounting_method: 'weighted_average_cost_basis',
  avg_entry_price: 0.005,
  avg_exit_price: 0.015,
  quote_currency: 'So11111111111111111111111111111111111111112',
  total_cost_basis: 5,
  total_exit_proceeds: 15,
  realized_pnl: 10,
  realized_pnl_pct: 200,
  total_bought: 1000,
  total_sold: 1000,
  peak_position: 1000,
  remaining_balance: 0,
  num_buys: 2,
  num_sells: 1,
  opened_at: Math.floor(runTs / 1000) - 86400,
  closed_at: Math.floor(runTs / 1000),
  hold_time_seconds: 86400,
  entry_txs: [
    { tx_hash: `entry1_${runTs}`, timestamp: Math.floor(runTs / 1000) - 86400, amount: 500, quote_amount: 2.5 },
    { tx_hash: `entry2_${runTs}`, timestamp: Math.floor(runTs / 1000) - 43200, amount: 500, quote_amount: 2.5 },
  ],
  exit_txs: [
    { tx_hash: `exit1_${runTs}`, timestamp: Math.floor(runTs / 1000), amount: 1000, quote_amount: 15 },
  ],
  _hash_inputs: { raw_entry_price_avg: 0.005, raw_exit_price_avg: 0.015 },
  generated_at: Math.floor(runTs / 1000),
  verification_hash: null,
};

const entryH = receipt.entry_txs.map(t => t.tx_hash).sort();
const exitH = receipt.exit_txs.map(t => t.tx_hash).sort();
receipt.verification_hash = createHash('sha256').update(JSON.stringify([
  receipt.wallet, receipt.chain, receipt.token_mint, entryH, exitH,
  receipt._hash_inputs.raw_entry_price_avg, receipt._hash_inputs.raw_exit_price_avg,
  receipt.accounting_method, receipt.receipt_version, receipt.status,
])).digest('hex');

writeFileSync(resolve(testDir, 'receipts/receipts.jsonl'), JSON.stringify(receipt) + '\n');

// 2. Render a simple PNG
const W = 800, H = 520, canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
ctx.fillStyle = '#0f1419'; ctx.fillRect(0, 0, W, H);
ctx.fillStyle = '#00c076'; ctx.font = '700 48px Arial'; ctx.fillText('+200.000%', 32, 200);
ctx.fillStyle = '#ffffff'; ctx.font = '600 24px Arial'; ctx.fillText(`E2E Test Receipt`, 32, 80);
ctx.fillStyle = '#8899a6'; ctx.font = '400 14px Arial'; ctx.fillText(receipt.receipt_id, 32, 480);
ctx.fillText(`hash: ${receipt.verification_hash.slice(0, 24)}...`, 32, 500);
writeFileSync(resolve(testDir, 'renders', `${receipt.receipt_id}.png`), canvas.toBuffer('image/png'));

console.log('Test data created:');
console.log(`  Receipt: ${receipt.receipt_id}`);
console.log(`  Hash: ${receipt.verification_hash}`);
console.log(`  Wallet: ${wallet}`);
console.log(`  Dir: ${testDir}`);
console.log(`\nRun these commands in sequence:`);
console.log(`  1. node src/arweave/arweave-upload.mjs ${keypairPath} --network devnet --receipts ${resolve(testDir, 'receipts/receipts.jsonl')} --renders ${resolve(testDir, 'renders')} --output ${resolve(testDir, 'arweave')}`);
console.log(`  2. node src/claims/claim-signer.mjs ${keypairPath} ${wallet} ${resolve(testDir, 'receipts/receipts.jsonl')} ${resolve(testDir, 'claims')}`);
console.log(`  3. node src/mint/mint-submitter.mjs ${keypairPath} ${resolve(testDir, 'claims/claims.jsonl')} --network devnet`);
console.log(`  4. node src/mint/verify-mints.mjs ${resolve(testDir, 'mints/mint_results.jsonl')} --network devnet`);
