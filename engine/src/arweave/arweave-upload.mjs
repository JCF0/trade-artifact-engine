/**
 * Arweave Upload Module (Task 8a)
 *
 * For each receipt in receipts.jsonl:
 *   1. Upload PNG render to Irys
 *   2. Upload receipt JSON to Irys
 *   3. Build NFT metadata JSON (with PNG + receipt URIs), compute metadata_hash
 *   4. Upload NFT metadata JSON to Irys
 *   5. Record all URIs + hashes in uploads.jsonl
 *
 * Usage:
 *   node src/arweave/arweave-upload.mjs <keypairPath> [--network devnet|mainnet] [--receipts <path>] [--renders <dir>] [--output <dir>]
 *
 * Idempotent: skips receipts already in uploads.jsonl.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { Uploader } from '@irys/upload';
import { Solana } from '@irys/upload-solana';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);

function getFlag(name) {
  const idx = rawArgs.indexOf(name);
  if (idx === -1 || idx + 1 >= rawArgs.length) return null;
  return rawArgs[idx + 1];
}

const networkFlag = getFlag('--network') || 'devnet';
const receiptsPathArg = getFlag('--receipts');
const rendersDirArg = getFlag('--renders');
const outputDirArg = getFlag('--output');

const flagNames = new Set(['--network', '--receipts', '--renders', '--output']);
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (flagNames.has(rawArgs[i])) { i++; continue; }
  positional.push(rawArgs[i]);
}

const KEYPAIR_PATH = positional[0];
if (!KEYPAIR_PATH) {
  console.error('Usage: node src/arweave/arweave-upload.mjs <keypairPath> [--network devnet|mainnet] [--receipts <path>] [--renders <dir>] [--output <dir>]');
  process.exit(1);
}

const RECEIPTS_PATH = resolve(receiptsPathArg || resolve(ROOT, 'data/receipts/receipts.jsonl'));
const RENDERS_DIR = resolve(rendersDirArg || resolve(ROOT, 'data/renders'));
const OUTPUT_DIR = resolve(outputDirArg || resolve(ROOT, 'data/arweave'));
const UPLOADS_PATH = resolve(OUTPUT_DIR, 'uploads.jsonl');

const ENDPOINTS = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

const GATEWAY_BASE = 'https://gateway.irys.xyz';

console.log(`Network:  ${networkFlag}`);
console.log(`Receipts: ${RECEIPTS_PATH}`);
console.log(`Renders:  ${RENDERS_DIR}`);
console.log(`Output:   ${OUTPUT_DIR}`);

// ---------------------------------------------------------------------------
// Initialize Irys
// ---------------------------------------------------------------------------
const keypairBytes = JSON.parse(readFileSync(resolve(KEYPAIR_PATH), 'utf-8'));
let irysBuilder = Uploader(Solana)
  .withWallet(Buffer.from(keypairBytes))
  .withRpc(ENDPOINTS[networkFlag] || ENDPOINTS.devnet);

if (networkFlag === 'devnet') {
  irysBuilder = irysBuilder.devnet();
}

const irys = await irysBuilder;
console.log(`Irys URL: ${irys.url}`);
console.log(`Irys address: ${irys._address}\n`);

// ---------------------------------------------------------------------------
// Load receipts + existing uploads
// ---------------------------------------------------------------------------
const receipts = readFileSync(RECEIPTS_PATH, 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l));
console.log(`Loaded ${receipts.length} receipts`);

mkdirSync(OUTPUT_DIR, { recursive: true });

const existingUploads = new Map();
if (existsSync(UPLOADS_PATH)) {
  const lines = readFileSync(UPLOADS_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  for (const l of lines) {
    const u = JSON.parse(l);
    existingUploads.set(u.verification_hash, u);
  }
  console.log(`Loaded ${existingUploads.size} existing uploads (idempotency check)`);
}

// ---------------------------------------------------------------------------
// Helper: upload file with tags
// ---------------------------------------------------------------------------
async function uploadFile(filePath, contentType, extraTags = []) {
  const tags = [
    { name: 'Content-Type', value: contentType },
    { name: 'App-Name', value: 'trade-artifact-engine' },
    { name: 'App-Version', value: '1.0' },
    ...extraTags,
  ];
  const receipt = await irys.uploadFile(filePath, { tags });
  return { id: receipt.id, url: `${GATEWAY_BASE}/${receipt.id}` };
}

// ---------------------------------------------------------------------------
// Helper: upload buffer as temp file with tags
// ---------------------------------------------------------------------------
async function uploadBuffer(data, filename, contentType, extraTags = []) {
  const tmpPath = resolve(OUTPUT_DIR, `_tmp_${filename}`);
  writeFileSync(tmpPath, data);
  const result = await uploadFile(tmpPath, contentType, extraTags);
  // Clean up temp file (best effort)
  try { (await import('fs')).unlinkSync(tmpPath); } catch {}
  return result;
}

// ---------------------------------------------------------------------------
// Helper: build NFT metadata JSON
// ---------------------------------------------------------------------------
function buildNftMetadata(receipt, pngUri, receiptJsonUri) {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const SYMS = { [SOL_MINT]: 'SOL', [USDC_MINT]: 'USDC', [USDT_MINT]: 'USDT' };

  const tokenShort = receipt.token_mint.slice(0, 8);
  const quoteSymbol = SYMS[receipt.quote_currency] || (receipt.quote_currency === 'MIXED' ? 'MIXED' : receipt.quote_currency?.slice(0, 8));

  return {
    name: `Trade Receipt ${receipt.receipt_id.replace('receipt_', '#').replace(/_/g, ' ')}`,
    symbol: 'TREC',
    description: `Verified trade receipt: ${tokenShort} / ${quoteSymbol} on Solana. PnL: ${receipt.realized_pnl_pct >= 0 ? '+' : ''}${receipt.realized_pnl_pct}%`,
    image: pngUri,
    external_url: receiptJsonUri,
    attributes: [
      { trait_type: 'wallet', value: receipt.wallet },
      { trait_type: 'token_mint', value: receipt.token_mint },
      { trait_type: 'chain', value: receipt.chain },
      { trait_type: 'realized_pnl_pct', value: receipt.realized_pnl_pct, display_type: 'number' },
      { trait_type: 'status', value: receipt.status },
      { trait_type: 'quote_currency', value: quoteSymbol },
      { trait_type: 'hold_time_seconds', value: receipt.hold_time_seconds, display_type: 'number' },
      { trait_type: 'num_buys', value: receipt.num_buys, display_type: 'number' },
      { trait_type: 'num_sells', value: receipt.num_sells, display_type: 'number' },
      { trait_type: 'opened_at', value: receipt.opened_at, display_type: 'date' },
      { trait_type: 'closed_at', value: receipt.closed_at, display_type: 'date' },
    ],
    properties: {
      receipt_version: receipt.receipt_version,
      verification_hash: receipt.verification_hash,
      accounting_method: receipt.accounting_method,
      receipt_json: receiptJsonUri,
    },
  };
}

// ---------------------------------------------------------------------------
// Process each receipt
// ---------------------------------------------------------------------------
const uploads = [];
let uploaded = 0;
let skipped = 0;

for (const receipt of receipts) {
  const tag = `${receipt.receipt_id} (${receipt.verification_hash.slice(0, 12)}...)`;

  // Idempotency check
  if (existingUploads.has(receipt.verification_hash)) {
    console.log(`⏭️  SKIP ${tag}: already uploaded`);
    skipped++;
    continue;
  }

  console.log(`\n📤 ${tag}`);

  // 1. Upload PNG
  const pngPath = resolve(RENDERS_DIR, `${receipt.receipt_id}.png`);
  if (!existsSync(pngPath)) {
    console.log(`   ⚠️  PNG not found: ${pngPath} — skipping`);
    continue;
  }

  console.log(`   Uploading PNG...`);
  const pngResult = await uploadFile(pngPath, 'image/png', [
    { name: 'Receipt-Id', value: receipt.receipt_id },
    { name: 'Verification-Hash', value: receipt.verification_hash },
    { name: 'File-Type', value: 'receipt-render' },
  ]);
  console.log(`   PNG: ${pngResult.url}`);

  // 2. Upload receipt JSON
  const receiptJsonStr = JSON.stringify(receipt, null, 2);
  console.log(`   Uploading receipt JSON...`);
  const receiptJsonResult = await uploadBuffer(
    receiptJsonStr,
    `${receipt.receipt_id}.json`,
    'application/json',
    [
      { name: 'Receipt-Id', value: receipt.receipt_id },
      { name: 'Verification-Hash', value: receipt.verification_hash },
      { name: 'File-Type', value: 'receipt-data' },
    ]
  );
  console.log(`   JSON: ${receiptJsonResult.url}`);

  // 3. Build + upload NFT metadata
  const nftMetadata = buildNftMetadata(receipt, pngResult.url, receiptJsonResult.url);
  const metadataStr = JSON.stringify(nftMetadata, null, 2);
  const metadataHash = createHash('sha256').update(metadataStr).digest('hex');

  console.log(`   Uploading NFT metadata...`);
  const metadataResult = await uploadBuffer(
    metadataStr,
    `${receipt.receipt_id}_metadata.json`,
    'application/json',
    [
      { name: 'Receipt-Id', value: receipt.receipt_id },
      { name: 'Verification-Hash', value: receipt.verification_hash },
      { name: 'File-Type', value: 'nft-metadata' },
      { name: 'Metadata-Hash', value: metadataHash },
    ]
  );
  console.log(`   Metadata: ${metadataResult.url}`);
  console.log(`   Metadata hash: ${metadataHash.slice(0, 24)}...`);

  // 4. Record
  const uploadRecord = {
    receipt_id: receipt.receipt_id,
    verification_hash: receipt.verification_hash,
    png_irys_id: pngResult.id,
    png_uri: pngResult.url,
    receipt_json_irys_id: receiptJsonResult.id,
    receipt_json_uri: receiptJsonResult.url,
    metadata_json_irys_id: metadataResult.id,
    metadata_uri: metadataResult.url,
    metadata_hash: metadataHash,
    uploaded_at: Math.floor(Date.now() / 1000),
    network: networkFlag,
  };

  uploads.push(uploadRecord);
  uploaded++;
  console.log(`   ✅ Complete (3 files uploaded)`);
}

// ---------------------------------------------------------------------------
// Write uploads
// ---------------------------------------------------------------------------
if (uploads.length > 0) {
  const existingContent = existsSync(UPLOADS_PATH) ? readFileSync(UPLOADS_PATH, 'utf-8') : '';
  writeFileSync(UPLOADS_PATH, existingContent + uploads.map(u => JSON.stringify(u)).join('\n') + '\n');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`UPLOAD COMPLETE: ${uploaded} uploaded, ${skipped} skipped`);
console.log(`Output: ${UPLOADS_PATH}`);
console.log(`${'='.repeat(60)}`);
