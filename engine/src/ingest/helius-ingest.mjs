/**
 * Phase 1 — Helius Transaction Ingest
 *
 * Fetches wallet transaction history from the Helius Enhanced Transactions API
 * with pagination and writes:
 *   - data/raw/helius_raw_response.jsonl  (one line per API response batch)
 *   - data/raw/helius_transactions.jsonl  (one line per transaction)
 *
 * Usage:
 *   node src/ingest/helius-ingest.mjs [wallet] [maxTxns]
 *
 * Defaults:
 *   wallet  = CreQJ2t94QK5dsxUZGXfPJ8Nx7wA9LHr5chxjSMkbNft
 *   maxTxns = 1000
 */

import { readFileSync, appendFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_WALLET = 'CreQJ2t94QK5dsxUZGXfPJ8Nx7wA9LHr5chxjSMkbNft';
const DEFAULT_MAX    = 1000;
const PAGE_SIZE      = 100;          // Helius max per request
const BASE_URL       = 'https://api-mainnet.helius-rpc.com';
const RATE_DELAY_MS  = 350;          // stay well under 2 req/s free-tier limit

const wallet  = process.argv[2] || DEFAULT_WALLET;
const maxTxns = parseInt(process.argv[3] || DEFAULT_MAX, 10);

// ---------------------------------------------------------------------------
// Load API key
// ---------------------------------------------------------------------------
const envPath = resolve(process.env.USERPROFILE, '.openclaw', '.env');
const envContent = readFileSync(envPath, 'utf-8');
const keyMatch = envContent.match(/^HELIUS_API_KEY=(.+)$/m);
if (!keyMatch) {
  console.error('ERROR: HELIUS_API_KEY not found in', envPath);
  process.exit(1);
}
const API_KEY = keyMatch[1].trim().replace(/^["']|["']$/g, '');

// ---------------------------------------------------------------------------
// Output files
// ---------------------------------------------------------------------------
const rawResponsePath = resolve(PROJECT_ROOT, 'data', 'raw', 'helius_raw_response.jsonl');
const txnOutputPath   = resolve(PROJECT_ROOT, 'data', 'raw', 'helius_transactions.jsonl');

// Clear previous runs
writeFileSync(rawResponsePath, '');
writeFileSync(txnOutputPath, '');

// ---------------------------------------------------------------------------
// Pagination loop
// ---------------------------------------------------------------------------
console.log(`\n=== Helius Ingest ===`);
console.log(`Wallet : ${wallet}`);
console.log(`Max txn: ${maxTxns}`);
console.log(`Output : ${txnOutputPath}`);
console.log(`Raw    : ${rawResponsePath}\n`);

let beforeSig = null;
let totalFetched = 0;
let pageNum = 0;

while (totalFetched < maxTxns) {
  pageNum++;
  const limit = Math.min(PAGE_SIZE, maxTxns - totalFetched);

  let url = `${BASE_URL}/v0/addresses/${wallet}/transactions?api-key=${API_KEY}&limit=${limit}`;
  if (beforeSig) url += `&before-signature=${beforeSig}`;

  console.log(`Page ${pageNum}: fetching ${limit} txns${beforeSig ? ` (before ${beforeSig.slice(0,12)}...)` : ''}`);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`ERROR: HTTP ${res.status} — ${body.slice(0, 300)}`);
    process.exit(1);
  }

  const batch = await res.json();

  if (!Array.isArray(batch) || batch.length === 0) {
    console.log('No more transactions. Pagination complete.');
    break;
  }

  // Persist raw API response (one batch per line)
  appendFileSync(rawResponsePath, JSON.stringify({
    page: pageNum,
    wallet,
    count: batch.length,
    firstSig: batch[0]?.signature,
    lastSig: batch[batch.length - 1]?.signature,
    fetchedAt: new Date().toISOString(),
    transactions: batch,
  }) + '\n');

  // Persist individual transactions
  for (const tx of batch) {
    appendFileSync(txnOutputPath, JSON.stringify(tx) + '\n');
  }

  totalFetched += batch.length;
  beforeSig = batch[batch.length - 1].signature;

  console.log(`  → Got ${batch.length} txns (total: ${totalFetched})`);

  if (batch.length < limit) {
    console.log('Last page reached (batch smaller than limit).');
    break;
  }

  // Rate limiting
  if (totalFetched < maxTxns) {
    await new Promise(r => setTimeout(r, RATE_DELAY_MS));
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Done ===`);
console.log(`Total transactions: ${totalFetched}`);
console.log(`Pages fetched     : ${pageNum}`);
console.log(`Transactions file : ${txnOutputPath}`);
console.log(`Raw responses file: ${rawResponsePath}`);
