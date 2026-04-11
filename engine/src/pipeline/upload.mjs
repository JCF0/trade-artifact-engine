/**
 * Pipeline — Arweave Upload
 * Extracted from mint-one.mjs v1 (Phase 0.5).
 *
 * Uploads receipt PNG, receipt JSON, and NFT metadata to Arweave via Irys.
 */
import { writeFileSync, appendFileSync, unlinkSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import { SYMS, CHAIN, GATEWAY_BASE } from './constants.mjs';

/**
 * Upload receipt assets to Arweave.
 * @param {object} receipt - Receipt object
 * @param {string} pngPath - Path to rendered PNG
 * @param {Uint8Array} keypairBytes - Raw keypair bytes
 * @param {object} opts - { network, dataDir, endpoints }
 * @returns {{ metadataUri: string, metadataHash: Buffer }}
 */
export async function uploadToArweave(receipt, pngPath, keypairBytes, opts) {
  const { network, dataDir, endpoints } = opts;
  mkdirSync(resolve(dataDir, 'arweave'), { recursive: true });

  const { default: Uploader } = await import('@irys/upload');
  const { default: Solana } = await import('@irys/upload-solana');
  const { Buffer } = await import('buffer');

  const irys = await Uploader(Solana)
    .withWallet(Buffer.from(keypairBytes))
    .withRpc(endpoints[network])
    .devnet();

  // Upload PNG
  const pngResult = await irys.uploadFile(pngPath, { tags: [
    { name: 'Content-Type', value: 'image/png' },
    { name: 'App-Name', value: 'trade-artifact-engine' },
    { name: 'File-Type', value: 'receipt-render' },
    { name: 'Verification-Hash', value: receipt.verification_hash },
  ]});
  const pngUri = `${GATEWAY_BASE}/${pngResult.id}`;
  console.log(`  PNG: ${pngUri}`);

  // Upload receipt JSON
  const receiptJsonStr = JSON.stringify(receipt, null, 2);
  const tmpReceiptPath = resolve(dataDir, 'arweave/_tmp_receipt.json');
  writeFileSync(tmpReceiptPath, receiptJsonStr);
  const receiptJsonResult = await irys.uploadFile(tmpReceiptPath, { tags: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'App-Name', value: 'trade-artifact-engine' },
    { name: 'File-Type', value: 'receipt-data' },
    { name: 'Verification-Hash', value: receipt.verification_hash },
  ]});
  const receiptJsonUri = `${GATEWAY_BASE}/${receiptJsonResult.id}`;
  console.log(`  Receipt JSON: ${receiptJsonUri}`);

  // Build + upload NFT metadata
  const tokenShort = receipt.token_mint.slice(0, 8);
  const qSym = SYMS[receipt.quote_currency] || (receipt.quote_currency === 'MIXED' ? 'MIXED' : receipt.quote_currency?.slice(0, 8));
  const nftMetadata = {
    name: `Trade Receipt ${receipt.receipt_id.replace('receipt_', '#').replace(/_/g, ' ')}`,
    symbol: 'TREC',
    description: `Verified trade receipt: ${tokenShort} / ${qSym} on Solana. PnL: ${receipt.realized_pnl_pct >= 0 ? '+' : ''}${receipt.realized_pnl_pct}%`,
    image: pngUri,
    external_url: receiptJsonUri,
    attributes: [
      { trait_type: 'wallet', value: receipt.wallet },
      { trait_type: 'token_mint', value: receipt.token_mint },
      { trait_type: 'chain', value: CHAIN },
      { trait_type: 'realized_pnl_pct', value: receipt.realized_pnl_pct, display_type: 'number' },
      { trait_type: 'status', value: receipt.status },
      { trait_type: 'quote_currency', value: qSym },
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
  const metadataStr = JSON.stringify(nftMetadata, null, 2);
  const metadataHash = createHash('sha256').update(metadataStr).digest();

  const tmpMetaPath = resolve(dataDir, 'arweave/_tmp_meta.json');
  writeFileSync(tmpMetaPath, metadataStr);
  const metaResult = await irys.uploadFile(tmpMetaPath, { tags: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'App-Name', value: 'trade-artifact-engine' },
    { name: 'File-Type', value: 'nft-metadata' },
    { name: 'Verification-Hash', value: receipt.verification_hash },
    { name: 'Metadata-Hash', value: metadataHash.toString('hex') },
  ]});
  const metadataUri = `${GATEWAY_BASE}/${metaResult.id}`;
  console.log(`  Metadata: ${metadataUri}`);

  // Clean temps
  try { unlinkSync(tmpReceiptPath); } catch {}
  try { unlinkSync(tmpMetaPath); } catch {}

  // Record upload
  const uploadRecord = {
    receipt_id: receipt.receipt_id,
    verification_hash: receipt.verification_hash,
    metadata_uri: metadataUri,
    metadata_hash: metadataHash.toString('hex'),
    uploaded_at: Math.floor(Date.now() / 1000),
    network,
  };
  appendFileSync(resolve(dataDir, 'arweave/uploads.jsonl'), JSON.stringify(uploadRecord) + '\n');
  console.log(`  ✅ All 3 files uploaded`);

  return { metadataUri, metadataHash };
}
