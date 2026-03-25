/**
 * Trade Artifact Verifier CLI
 *
 * Third-party tool to independently verify a trade receipt's integrity,
 * claim signature, on-chain PDA/NFT state, and metadata hash consistency.
 *
 * Usage:
 *   node src/verify/verify-receipt.mjs <receipt.json> [options]
 *
 * Options:
 *   --network devnet|mainnet     (default: devnet)
 *   --metadata-uri <url>         Override metadata URI (otherwise from on-chain)
 *   --skip-onchain               Skip on-chain checks (offline mode)
 *
 * Receipt input: path to a single receipt JSON file or a receipts.jsonl file.
 * If JSONL, verifies all receipts in the file.
 *
 * Exit codes: 0 = all pass, 1 = any failure
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROGRAM_ID = new PublicKey('HBWHeRGeXUBfsNnHSgnUzqHQBxpsMUNacEJXMStz9ysQ');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const RECEIPT_SEED = Buffer.from('receipt');
const MINT_SEED = Buffer.from('mint');

const ENDPOINTS = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

// ---------------------------------------------------------------------------
// CLI Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
Trade Artifact Verifier CLI

Independently verify a trade receipt's integrity, signature, on-chain state,
and metadata consistency. No trust in the receipt issuer required.

USAGE:
  node src/verify/verify-receipt.mjs <receipt.json|receipts.jsonl> [options]

OPTIONS:
  --network <devnet|mainnet>   Solana network (default: devnet)
  --metadata-uri <url>         Override metadata URI to verify
  --skip-onchain               Skip on-chain checks (offline hash verification only)

VERIFICATION LEVELS:
  L1  Receipt hash integrity      (offline — always runs)
  L2  On-chain PDA + NFT state    (requires RPC)
  L3  Claim signature (Ed25519)   (requires on-chain PDA data)
  L4  Metadata content hash       (requires metadata URI)

EXAMPLES:
  # Verify a single receipt (offline only)
  node src/verify/verify-receipt.mjs receipt.json --skip-onchain

  # Full verification on devnet
  node src/verify/verify-receipt.mjs receipts.jsonl --network devnet

  # Verify with specific metadata URI
  node src/verify/verify-receipt.mjs receipt.json --metadata-uri https://gateway.irys.xyz/abc123
`);
  process.exit(0);
}

const receiptPath = resolve(args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--network' && args[args.indexOf(a) - 1] !== '--metadata-uri') || '');
const network = args.find((_, i) => args[i - 1] === '--network') || 'devnet';
const metadataUriOverride = args.find((_, i) => args[i - 1] === '--metadata-uri') || null;
const skipOnchain = args.includes('--skip-onchain');

// ---------------------------------------------------------------------------
// Load receipts
// ---------------------------------------------------------------------------
const raw = readFileSync(receiptPath, 'utf-8').trim();
let receipts;
if (raw.startsWith('[')) {
  receipts = JSON.parse(raw);
} else if (raw.startsWith('{') && !raw.includes('\n')) {
  receipts = [JSON.parse(raw)];
} else {
  // JSONL
  receipts = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

console.log(`╔════════════════════════════════════════════════════════════╗`);
console.log(`║  TRADE ARTIFACT VERIFIER                                  ║`);
console.log(`╚════════════════════════════════════════════════════════════╝`);
console.log(`Receipts: ${receipts.length}`);
console.log(`Network:  ${skipOnchain ? 'OFFLINE (--skip-onchain)' : network}`);
console.log(`Source:   ${receiptPath}\n`);

let connection;
if (!skipOnchain) {
  connection = new Connection(ENDPOINTS[network] || ENDPOINTS.devnet, 'confirmed');
}

// ---------------------------------------------------------------------------
// PDA deserialization (same as verify-mints.mjs)
// ---------------------------------------------------------------------------
function decodeReceiptAnchor(data) {
  if (data.length < 243) throw new Error(`PDA data too short: ${data.length} bytes`);
  const d = Buffer.from(data);
  const o = 8;
  return {
    verification_hash: d.subarray(o, o + 32).toString('hex'),
    metadata_hash: d.subarray(o + 32, o + 64).toString('hex'),
    trader_wallet: new PublicKey(d.subarray(o + 64, o + 96)).toBase58(),
    claim_recipient: new PublicKey(d.subarray(o + 96, o + 128)).toBase58(),
    claim_signature: d.subarray(o + 128, o + 192),
    status: d.readUInt8(o + 192),
    program_version: d.readUInt8(o + 193),
    mint: new PublicKey(d.subarray(o + 194, o + 226)).toBase58(),
    minted_at: Number(d.readBigInt64LE(o + 226)),
    bump: d.readUInt8(o + 234),
  };
}

// ---------------------------------------------------------------------------
// Level 1: Receipt Hash Integrity (offline)
// ---------------------------------------------------------------------------
function verifyHashIntegrity(receipt) {
  const checks = [];

  // Required fields
  const required = ['wallet', 'chain', 'token_mint', 'entry_txs', 'exit_txs',
    'accounting_method', 'receipt_version', 'status', 'verification_hash', '_hash_inputs'];
  for (const f of required) {
    if (receipt[f] === undefined || receipt[f] === null) {
      checks.push({ name: `field:${f}`, pass: false, detail: 'Missing required field' });
      return checks;
    }
  }
  checks.push({ name: 'required_fields', pass: true, detail: `All ${required.length} present` });

  // Hash inputs exist
  if (!receipt._hash_inputs?.raw_entry_price_avg === undefined || receipt._hash_inputs?.raw_exit_price_avg === undefined) {
    checks.push({ name: '_hash_inputs', pass: false, detail: 'Missing raw price averages' });
    return checks;
  }

  // Re-derive verification hash
  const entryHashes = receipt.entry_txs.map(t => t.tx_hash).sort();
  const exitHashes = receipt.exit_txs.map(t => t.tx_hash).sort();
  const payload = JSON.stringify([
    receipt.wallet,
    receipt.chain,
    receipt.token_mint,
    entryHashes,
    exitHashes,
    receipt._hash_inputs.raw_entry_price_avg,
    receipt._hash_inputs.raw_exit_price_avg,
    receipt.accounting_method,
    receipt.receipt_version,
    receipt.status,
  ]);
  const computed = createHash('sha256').update(payload).digest('hex');
  const hashMatch = computed === receipt.verification_hash;
  checks.push({
    name: 'verification_hash',
    pass: hashMatch,
    detail: hashMatch
      ? `${computed.slice(0, 16)}... ✓`
      : `MISMATCH: computed=${computed.slice(0, 16)}, stored=${receipt.verification_hash.slice(0, 16)}`
  });

  // PnL arithmetic consistency
  const costBasis = receipt.entry_txs.reduce((s, t) => s + t.quote_amount, 0);
  const exitProceeds = receipt.exit_txs.reduce((s, t) => s + t.quote_amount, 0);
  const pnl = exitProceeds - costBasis;
  const tolerance = Math.max(1e-4, Math.abs(costBasis) * 1e-6);
  const pnlMatch = Math.abs(pnl - receipt.realized_pnl) < tolerance;
  checks.push({
    name: 'pnl_arithmetic',
    pass: pnlMatch,
    detail: pnlMatch
      ? `PnL: ${receipt.realized_pnl >= 0 ? '+' : ''}${receipt.realized_pnl.toPrecision(6)}`
      : `MISMATCH: computed=${pnl.toPrecision(6)}, stored=${receipt.realized_pnl.toPrecision(6)}`
  });

  // Dust threshold check
  const totalBought = receipt.entry_txs.reduce((s, t) => s + t.amount, 0);
  const totalSold = receipt.exit_txs.reduce((s, t) => s + t.amount, 0);
  const residual = Math.abs(totalBought - totalSold);
  const threshold = Math.max(0.001, 0.001 * receipt.peak_position);
  const dustOk = residual < threshold;
  checks.push({
    name: 'dust_threshold',
    pass: dustOk,
    detail: dustOk
      ? `Residual: ${residual.toFixed(10)} < threshold ${threshold.toFixed(10)}`
      : `NOT CLOSED: residual=${residual}, threshold=${threshold}`
  });

  // Status value
  const validStatus = ['verified', 'verified_mixed_quote'].includes(receipt.status);
  checks.push({
    name: 'status_value',
    pass: validStatus,
    detail: receipt.status
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Level 2: On-Chain PDA + NFT (requires RPC)
// ---------------------------------------------------------------------------
async function verifyOnChain(receipt) {
  const checks = [];
  const hashBytes = Buffer.from(receipt.verification_hash, 'hex');
  const [receiptPDA] = PublicKey.findProgramAddressSync([RECEIPT_SEED, hashBytes], PROGRAM_ID);
  const [mintPDA] = PublicKey.findProgramAddressSync([MINT_SEED, hashBytes], PROGRAM_ID);

  // Fetch receipt PDA
  let anchor;
  try {
    const pdaAccount = await connection.getAccountInfo(receiptPDA);
    if (!pdaAccount) {
      checks.push({ name: 'pda_exists', pass: false, detail: `PDA ${receiptPDA.toBase58()} not found — receipt NOT minted` });
      return { checks, anchor: null, receiptPDA, mintPDA };
    }
    checks.push({ name: 'pda_exists', pass: true, detail: receiptPDA.toBase58() });

    if (pdaAccount.owner.toBase58() !== PROGRAM_ID.toBase58()) {
      checks.push({ name: 'pda_owner', pass: false, detail: `Owner: ${pdaAccount.owner.toBase58()}` });
    } else {
      checks.push({ name: 'pda_owner', pass: true, detail: 'Owned by trade_artifact program' });
    }

    anchor = decodeReceiptAnchor(pdaAccount.data);

    // Verify hash match
    const hashOk = anchor.verification_hash === receipt.verification_hash;
    checks.push({ name: 'onchain_hash', pass: hashOk, detail: hashOk ? 'Matches receipt' : 'MISMATCH' });

    // Verify wallet match
    const walletOk = anchor.trader_wallet === receipt.wallet;
    checks.push({ name: 'onchain_wallet', pass: walletOk, detail: walletOk ? anchor.trader_wallet : `MISMATCH: ${anchor.trader_wallet}` });

    // Status match
    const statusByte = receipt.status === 'verified' ? 0 : 1;
    const statusOk = anchor.status === statusByte;
    checks.push({ name: 'onchain_status', pass: statusOk, detail: statusOk ? `${anchor.status}` : `MISMATCH: on-chain=${anchor.status}, expected=${statusByte}` });

    // Version
    checks.push({ name: 'program_version', pass: anchor.program_version === 1, detail: `v${anchor.program_version}` });

    // Mint timestamp
    checks.push({
      name: 'minted_at',
      pass: anchor.minted_at > 0,
      detail: new Date(anchor.minted_at * 1000).toISOString()
    });

  } catch (e) {
    checks.push({ name: 'pda_fetch', pass: false, detail: e.message });
    return { checks, anchor: null, receiptPDA, mintPDA };
  }

  // Fetch NFT mint
  try {
    const mintAccount = await connection.getAccountInfo(mintPDA);
    if (!mintAccount) {
      checks.push({ name: 'nft_exists', pass: false, detail: 'NFT mint not found' });
    } else {
      const isToken2022 = mintAccount.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58();
      checks.push({ name: 'nft_token2022', pass: isToken2022, detail: isToken2022 ? 'Token-2022 ✓' : `Owner: ${mintAccount.owner.toBase58()}` });

      const d = Buffer.from(mintAccount.data);
      if (d.length >= 45) {
        const supply = Number(d.readBigUInt64LE(36));
        const decimals = d.readUInt8(44);
        checks.push({ name: 'nft_supply', pass: supply === 1, detail: `supply=${supply}` });
        checks.push({ name: 'nft_decimals', pass: decimals === 0, detail: `decimals=${decimals}` });
      }
    }
  } catch (e) {
    checks.push({ name: 'nft_fetch', pass: false, detail: e.message });
  }

  // Check ATA balance
  if (anchor) {
    try {
      const recipientKey = new PublicKey(anchor.claim_recipient);
      const [ata] = PublicKey.findProgramAddressSync(
        [recipientKey.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPDA.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const ataAccount = await connection.getAccountInfo(ata);
      if (!ataAccount) {
        checks.push({ name: 'ata_balance', pass: false, detail: 'ATA not found' });
      } else {
        const d = Buffer.from(ataAccount.data);
        if (d.length >= 72) {
          const balance = Number(d.readBigUInt64LE(64));
          checks.push({ name: 'ata_balance', pass: balance === 1, detail: `balance=${balance}, recipient=${anchor.claim_recipient.slice(0, 12)}...` });
        }
      }
    } catch (e) {
      checks.push({ name: 'ata_fetch', pass: false, detail: e.message });
    }
  }

  return { checks, anchor, receiptPDA, mintPDA };
}

// ---------------------------------------------------------------------------
// Level 3: Claim Signature Verification
// ---------------------------------------------------------------------------
function verifyClaimSignature(receipt, anchor) {
  const checks = [];

  if (!anchor) {
    checks.push({ name: 'claim_sig', pass: false, detail: 'No on-chain data available' });
    return checks;
  }

  // Reconstruct canonical claim message
  const canonicalMessage =
    `TRADE_RECEIPT_CLAIM_V1\n` +
    `receipt:${anchor.verification_hash}\n` +
    `wallet:${anchor.trader_wallet}\n` +
    `chain:solana\n` +
    `claim_recipient:${anchor.claim_recipient}`;

  const messageBytes = new TextEncoder().encode(canonicalMessage);
  const sigBytes = new Uint8Array(anchor.claim_signature);
  const pubkeyBytes = new PublicKey(anchor.trader_wallet).toBytes();

  try {
    const valid = nacl.sign.detached.verify(messageBytes, sigBytes, pubkeyBytes);
    checks.push({
      name: 'claim_signature',
      pass: valid,
      detail: valid
        ? `Ed25519 signature valid — signed by ${anchor.trader_wallet.slice(0, 12)}...`
        : 'INVALID Ed25519 signature'
    });
  } catch (e) {
    checks.push({ name: 'claim_signature', pass: false, detail: `Verification error: ${e.message}` });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Level 4: Metadata Content Hash
// ---------------------------------------------------------------------------
async function verifyMetadataContent(anchor, metadataUri) {
  const checks = [];

  if (!anchor) {
    checks.push({ name: 'metadata_hash', pass: false, detail: 'No on-chain data available' });
    return checks;
  }

  const uri = metadataUri || null;
  if (!uri) {
    checks.push({ name: 'metadata_hash', pass: false, detail: 'No metadata URI provided (use --metadata-uri)' });
    return checks;
  }

  try {
    const resp = await fetch(uri);
    if (!resp.ok) {
      checks.push({ name: 'metadata_fetch', pass: false, detail: `HTTP ${resp.status}` });
      return checks;
    }

    const bodyText = await resp.text();
    const contentHash = createHash('sha256').update(bodyText).digest('hex');
    const hashMatch = contentHash === anchor.metadata_hash;
    checks.push({
      name: 'metadata_hash',
      pass: hashMatch,
      detail: hashMatch
        ? `SHA-256 matches on-chain: ${contentHash.slice(0, 16)}...`
        : `MISMATCH: fetched=${contentHash.slice(0, 16)}, on-chain=${anchor.metadata_hash.slice(0, 16)}`
    });

    // Parse metadata and check internal consistency
    try {
      const meta = JSON.parse(bodyText);
      if (meta.properties?.verification_hash) {
        const vhMatch = meta.properties.verification_hash === anchor.verification_hash;
        checks.push({
          name: 'metadata_vhash',
          pass: vhMatch,
          detail: vhMatch ? 'verification_hash in metadata matches on-chain' : 'MISMATCH'
        });
      }

      if (meta.image) {
        try {
          const imgResp = await fetch(meta.image, { method: 'HEAD' });
          checks.push({
            name: 'metadata_image',
            pass: imgResp.ok,
            detail: imgResp.ok ? `Image reachable (${meta.image.slice(0, 40)}...)` : `HTTP ${imgResp.status}`
          });
        } catch (e) {
          checks.push({ name: 'metadata_image', pass: false, detail: `Unreachable: ${e.message}` });
        }
      }
    } catch {
      checks.push({ name: 'metadata_parse', pass: false, detail: 'Invalid JSON in metadata' });
    }
  } catch (e) {
    checks.push({ name: 'metadata_fetch', pass: false, detail: e.message });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let totalPassed = 0;
let totalFailed = 0;

for (let i = 0; i < receipts.length; i++) {
  const receipt = receipts[i];
  const tag = receipt.receipt_id || `receipt_${i + 1}`;
  const allChecks = [];

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`📄 ${tag}`);
  console.log(`   wallet:    ${receipt.wallet}`);
  console.log(`   token:     ${receipt.token_mint?.slice(0, 12)}...`);
  console.log(`   hash:      ${receipt.verification_hash?.slice(0, 24)}...`);
  console.log(`   status:    ${receipt.status}`);
  console.log(`   pnl:       ${receipt.realized_pnl >= 0 ? '+' : ''}${receipt.realized_pnl_pct?.toFixed(2)}%`);

  // L1: Hash integrity
  console.log(`\n   L1 — Receipt Integrity (offline)`);
  const l1 = verifyHashIntegrity(receipt);
  allChecks.push(...l1);
  for (const c of l1) {
    console.log(`   ${c.pass ? '✅' : '❌'} ${c.name}: ${c.detail}`);
  }

  // L2 + L3 + L4: On-chain
  let anchor = null;
  if (!skipOnchain) {
    console.log(`\n   L2 — On-Chain State`);
    const { checks: l2, anchor: a } = await verifyOnChain(receipt);
    anchor = a;
    allChecks.push(...l2);
    for (const c of l2) {
      console.log(`   ${c.pass ? '✅' : '❌'} ${c.name}: ${c.detail}`);
    }

    if (anchor) {
      console.log(`\n   L3 — Claim Signature`);
      const l3 = verifyClaimSignature(receipt, anchor);
      allChecks.push(...l3);
      for (const c of l3) {
        console.log(`   ${c.pass ? '✅' : '❌'} ${c.name}: ${c.detail}`);
      }

      console.log(`\n   L4 — Metadata Content`);
      const l4 = await verifyMetadataContent(anchor, metadataUriOverride);
      allChecks.push(...l4);
      for (const c of l4) {
        console.log(`   ${c.pass ? '✅' : '❌'} ${c.name}: ${c.detail}`);
      }
    }
  }

  // Summary for this receipt
  const passed = allChecks.filter(c => c.pass).length;
  const failed = allChecks.filter(c => !c.pass).length;
  totalPassed += passed;
  totalFailed += failed;

  console.log(`\n   ── ${failed === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failed} FAILED`} (${passed}/${allChecks.length}) ──`);
}

// Final summary
console.log(`\n${'═'.repeat(64)}`);
console.log(`VERIFICATION COMPLETE`);
console.log(`  Receipts:    ${receipts.length}`);
console.log(`  Checks:      ${totalPassed + totalFailed} total`);
console.log(`  Passed:      ${totalPassed}`);
console.log(`  Failed:      ${totalFailed}`);
console.log(`${'═'.repeat(64)}`);

if (totalFailed > 0) {
  console.log(`\n⚠️  ${totalFailed} check(s) failed. See details above.`);
}

process.exit(totalFailed > 0 ? 1 : 0);
