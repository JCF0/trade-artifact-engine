#!/usr/bin/env node
/**
 * mint-one.mjs — Single Receipt Mint Flow (v1.1)
 *
 * Supports two flows:
 *   1. Legacy cycle-based (--pick) — v1 compatible, unchanged
 *   2. Position-based (--token/--from/--to/--position-id) — v1.1
 *      Optional: --custom for custom receipt with leg removal
 *
 * Usage:
 *   node src/mint-one.mjs <wallet> --keypair <path> [options]
 *
 * V1 Options (preserved):
 *   --keypair <path>        Solana keypair JSON (required for sign/upload/mint)
 *   --recipient <pubkey>    Mint destination (default: signer wallet)
 *   --pick <N>              Select receipt N (1-indexed, cycle-based flow)
 *   --max-txns <N>          Transaction fetch cap (default: 5000)
 *   --network <devnet|mainnet>  (default: devnet)
 *   --dry-run               Simulate mint only
 *   --list-only             Stop after listing
 *   --skip-upload           Use dummy metadata URI
 *
 * V1.1 Options (new):
 *   --token <mint>          Filter positions by token mint
 *   --from <timestamp>      Filter positions from this epoch time
 *   --to <timestamp>        Filter positions up to this epoch time
 *   --position-id <hash>    Select position by ID directly
 *   --custom                Enable custom receipt mode (interactive leg removal)
 *   --remove-legs <hash,..> Non-interactive leg removal (comma-separated tx hashes)
 *   --positions             Use position flow (default when --token/--from/--to used)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Keypair } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { createInterface } from 'readline';

// Pipeline modules
import { SYMS } from './pipeline/constants.mjs';
import { fetchTransactions, normalizeTransactions } from './pipeline/ingest.mjs';
import { reconstructCycles } from './pipeline/reconstruct.mjs';
import { buildReceipts, buildPositionReceipt, buildCustomReceipt } from './pipeline/receipt.mjs';
import { renderReceipt } from './pipeline/render.mjs';
import { signClaim } from './pipeline/sign.mjs';
import { uploadToArweave } from './pipeline/upload.mjs';
import { mintOnChain } from './pipeline/mint.mjs';
import { buildPositions, buildCustomPosition } from './position/position-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ENDPOINTS = { devnet: 'https://api.devnet.solana.com', mainnet: 'https://api.mainnet-beta.solana.com' };

// ═══════════════════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════════════════
const rawArgs = process.argv.slice(2);

function getFlag(name) {
  const idx = rawArgs.indexOf(name);
  if (idx === -1 || idx + 1 >= rawArgs.length) return null;
  return rawArgs[idx + 1];
}
function hasFlag(name) { return rawArgs.includes(name); }

if (rawArgs.length === 0 || hasFlag('--help') || hasFlag('-h')) {
  console.log(`
mint-one — Single Receipt Mint Flow (v1.1)

USAGE:
  node src/mint-one.mjs <wallet> --keypair <path> [options]

CYCLE FLOW (v1 compatible):
  --pick <N>                 Select receipt #N (1-indexed)

POSITION FLOW (v1.1):
  --positions                Use position-based flow
  --token <mint>             Filter by token mint address
  --from <epoch>             Filter positions from this timestamp
  --to <epoch>               Filter positions up to this timestamp
  --position-id <hash>       Select position by ID directly

CUSTOM MODE:
  --custom                   Enable custom receipt (interactive leg removal)
  --remove-legs <h1,h2,...>  Remove specific legs by tx hash (non-interactive)

COMMON OPTIONS:
  --keypair <path>           Solana keypair JSON file
  --recipient <pubkey>       Mint destination wallet (default: signer)
  --max-txns <N>             Transaction fetch limit (default: 5000)
  --network <devnet|mainnet> Solana network (default: devnet)
  --dry-run                  Simulate mint transaction only
  --list-only                List available receipts/positions and exit
  --skip-upload              Skip Arweave upload (use dummy metadata URI)

EXAMPLES:
  # v1 cycle flow — list receipts
  node src/mint-one.mjs <wallet> --keypair key.json --list-only

  # v1 cycle flow — pick receipt #2
  node src/mint-one.mjs <wallet> --keypair key.json --pick 2

  # v1.1 position flow — list positions
  node src/mint-one.mjs <wallet> --keypair key.json --positions --list-only

  # v1.1 position flow — filter by token, verified receipt
  node src/mint-one.mjs <wallet> --keypair key.json --token JUPy...vCN

  # v1.1 custom receipt — interactive leg removal
  node src/mint-one.mjs <wallet> --keypair key.json --token JUPy...vCN --custom

  # v1.1 custom receipt — non-interactive
  node src/mint-one.mjs <wallet> --keypair key.json --token JUPy...vCN --remove-legs tx1,tx2
`);
  process.exit(0);
}

// Parse args
const valueFlagNames = new Set(['--keypair','--recipient','--pick','--max-txns','--network','--token','--from','--to','--position-id','--remove-legs']);
const boolFlagNames = new Set(['--dry-run','--list-only','--skip-upload','--custom','--positions']);
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (valueFlagNames.has(rawArgs[i])) { i++; continue; }
  if (boolFlagNames.has(rawArgs[i])) continue;
  positional.push(rawArgs[i]);
}

const WALLET = positional[0];
const KEYPAIR_PATH = getFlag('--keypair');
const RECIPIENT_OVERRIDE = getFlag('--recipient');
const PICK = getFlag('--pick') ? parseInt(getFlag('--pick')) : null;
const MAX_TXNS = parseInt(getFlag('--max-txns') || '5000');
const NETWORK = getFlag('--network') || 'devnet';
const DRY_RUN = hasFlag('--dry-run');
const LIST_ONLY = hasFlag('--list-only');
const SKIP_UPLOAD = hasFlag('--skip-upload');

// v1.1 flags
const TOKEN_FILTER = getFlag('--token');
const FROM_TS = getFlag('--from') ? parseInt(getFlag('--from')) : null;
const TO_TS = getFlag('--to') ? parseInt(getFlag('--to')) : null;
const POSITION_ID = getFlag('--position-id');
const CUSTOM_MODE = hasFlag('--custom');
const REMOVE_LEGS = getFlag('--remove-legs') ? getFlag('--remove-legs').split(',').map(s => s.trim()).filter(Boolean) : null;

// Detect which flow to use
const USE_POSITION_FLOW = hasFlag('--positions') || TOKEN_FILTER || FROM_TS !== null || TO_TS !== null || POSITION_ID || CUSTOM_MODE || REMOVE_LEGS;

if (!WALLET) { console.error('Error: wallet address required.'); process.exit(1); }
if (!KEYPAIR_PATH && !LIST_ONLY) { console.error('Error: --keypair required (or use --list-only).'); process.exit(1); }

// Load Helius key
const envPath = resolve(process.env.USERPROFILE || process.env.HOME, '.openclaw', '.env');
const envContent = readFileSync(envPath, 'utf-8');
const keyMatch = envContent.match(/^HELIUS_API_KEY=(.+)$/m);
if (!keyMatch) { console.error('HELIUS_API_KEY not found in ' + envPath); process.exit(1); }
const API_KEY = keyMatch[1].trim().replace(/^["']|["']$/g, '');

// Output dirs
const dataDir = resolve(ROOT, 'data');
for (const d of ['raw','normalized','cycles','pnl','receipts','renders','claims','arweave','mints']) {
  mkdirSync(resolve(dataDir, d), { recursive: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function qSym(quoteCurrency) {
  return SYMS[quoteCurrency] || (quoteCurrency === 'MIXED' ? 'MIXED' : quoteCurrency?.slice(0, 8) || '?');
}

function tsDisplay(epoch) {
  return new Date(epoch * 1000).toISOString().slice(0, 19) + 'Z';
}

function printReceiptPreview(r) {
  const isCustom = r.receipt_type === 'custom';
  const pnlSign = r.realized_pnl_pct >= 0 ? '+' : '';
  const bar = isCustom ? '⚠️  CUSTOM RECEIPT (not verified)' : '✅ VERIFIED RECEIPT';

  console.log(`\n  ┌─────────────────────────────────────────────────────┐`);
  console.log(`  │ ${bar.padEnd(52)}│`);
  console.log(`  ├─────────────────────────────────────────────────────┤`);
  console.log(`  │ Token:          ${r.token_mint.slice(0, 12)}...${' '.repeat(28)}│`);
  console.log(`  │ Receipt type:   ${r.receipt_type.padEnd(36)}│`);
  console.log(`  │ Status:         ${r.status.padEnd(36)}│`);
  if (r.position_id)
    console.log(`  │ Position ID:    ${r.position_id.slice(0, 24)}...${' '.repeat(9)}│`);
  if (isCustom && r.base_position_id)
    console.log(`  │ Base position:  ${r.base_position_id.slice(0, 24)}...${' '.repeat(9)}│`);
  console.log(`  │ Avg entry:      ${r.avg_entry_price.toPrecision(6).padEnd(36)}│`);
  console.log(`  │ Avg exit:       ${r.avg_exit_price.toPrecision(6).padEnd(36)}│`);
  console.log(`  │ PnL:            ${(pnlSign + r.realized_pnl_pct.toFixed(2) + '%').padEnd(36)}│`);
  console.log(`  │ Trades:         ${(r.num_buys + 'B / ' + r.num_sells + 'S').padEnd(36)}│`);
  console.log(`  │ Opened:         ${tsDisplay(r.opened_at).padEnd(36)}│`);
  console.log(`  │ Closed:         ${tsDisplay(r.closed_at).padEnd(36)}│`);
  console.log(`  │ Hash:           ${r.verification_hash.slice(0, 24)}...${' '.repeat(9)}│`);
  if (isCustom && r.removed_legs) {
    console.log(`  │ Removed legs:   ${String(r.removed_legs.length).padEnd(36)}│`);
    for (const leg of r.removed_legs) {
      console.log(`  │   ${leg.slice(0, 48)}...${' '.repeat(2)}│`);
    }
  }
  if (r.integrity_warnings && r.integrity_warnings.length > 0) {
    console.log(`  │${'─'.repeat(53)}│`);
    console.log(`  │ ⚠️  INTEGRITY WARNINGS:${' '.repeat(29)}│`);
    for (const w of r.integrity_warnings) {
      // Wrap long warnings
      const lines = [];
      let rem = w;
      while (rem.length > 49) { lines.push(rem.slice(0, 49)); rem = rem.slice(49); }
      lines.push(rem);
      for (const line of lines) {
        console.log(`  │   ${line.padEnd(50)}│`);
      }
    }
  }
  console.log(`  └─────────────────────────────────────────────────────┘`);
}

async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HEADER
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n╔════════════════════════════════════════════════════════════╗`);
console.log(`║  MINT-ONE — Single Receipt Flow ${USE_POSITION_FLOW ? '(v1.1 Position)' : '(v1 Cycle)   '}  ║`);
console.log(`╚════════════════════════════════════════════════════════════╝`);
console.log(`Wallet:   ${WALLET}`);
console.log(`Max txns: ${MAX_TXNS}`);
console.log(`Network:  ${NETWORK}`);
console.log(`Flow:     ${USE_POSITION_FLOW ? 'POSITION' : 'CYCLE (legacy)'}`);
if (TOKEN_FILTER) console.log(`Token:    ${TOKEN_FILTER}`);
if (FROM_TS) console.log(`From:     ${tsDisplay(FROM_TS)}`);
if (TO_TS) console.log(`To:       ${tsDisplay(TO_TS)}`);
if (CUSTOM_MODE) console.log(`Mode:     CUSTOM (leg removal)`);
if (DRY_RUN) console.log(`Mode:     DRY RUN (simulate only)`);
if (LIST_ONLY) console.log(`Mode:     LIST ONLY`);
if (SKIP_UPLOAD) console.log(`Upload:   SKIPPED (dummy metadata)`);

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1-3: INGEST → NORMALIZE → RECONSTRUCT (shared by both flows)
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── Phase 1: Ingest ──`);
const rawTxns = await fetchTransactions(WALLET, API_KEY, { maxTxns: MAX_TXNS, dataDir });
if (rawTxns.length === 0) { console.log('\nNo transactions found. Exiting.'); process.exit(0); }

console.log(`\n── Phase 2: Normalize ──`);
const { events } = normalizeTransactions(rawTxns, WALLET, { dataDir });
if (events.length === 0) { console.log('\nNo swap events. Exiting.'); process.exit(0); }

console.log(`\n── Phase 3: Reconstruct ──`);
const { cycles, stats: cycleStats } = reconstructCycles(events);
console.log(`  Cycles: ${cycleStats.total} total (${cycleStats.closed} closed, ${cycleStats.open} open, ${cycleStats.partial} partial)`);

const closed = cycles.filter(c => c.status === 'closed');
if (closed.length === 0) {
  console.log('\n⚠️  No closed trade cycles found in this transaction window.');
  console.log('   Try increasing --max-txns or using a different wallet.');
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW SPLIT: CYCLE vs POSITION
// ═══════════════════════════════════════════════════════════════════════════

let selected; // The receipt to sign/upload/mint

if (!USE_POSITION_FLOW) {
  // ═════════════════════════════════════════════════════════════════════════
  // CYCLE FLOW (v1 compatible — unchanged)
  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n── Phase 4-5: PnL + Receipts (cycle-based) ──`);
  const receipts = buildReceipts(closed, WALLET);
  writeFileSync(resolve(dataDir, 'receipts/receipts.jsonl'), receipts.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`  Generated ${receipts.length} receipts`);

  console.log(`\n── Phase 6: Render ──`);
  for (const r of receipts) {
    renderReceipt(r, resolve(dataDir, `renders/${r.receipt_id}.png`));
  }
  console.log(`  Rendered ${receipts.length} PNGs`);

  console.log(`\n── Available Receipts ──\n`);
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const token = r.token_mint.slice(0, 8);
    const qs = qSym(r.quote_currency);
    const pnlSign = r.realized_pnl_pct >= 0 ? '+' : '';
    const holdH = (r.hold_time_seconds / 3600).toFixed(1);
    console.log(`  [${i + 1}] ${r.receipt_id}`);
    console.log(`      ${token} / ${qs} | PnL: ${pnlSign}${r.realized_pnl_pct.toFixed(2)}% (${pnlSign}${r.realized_pnl.toPrecision(6)}) | ${r.num_buys}B/${r.num_sells}S | ${holdH}h | ${r.status}`);
  }

  if (LIST_ONLY) {
    console.log(`\n${receipts.length} receipt(s) available. Use --pick <N> to select one for minting.`);
    process.exit(0);
  }

  if (PICK !== null) {
    if (PICK < 1 || PICK > receipts.length) {
      console.error(`\nError: --pick ${PICK} out of range (1–${receipts.length})`);
      process.exit(1);
    }
    selected = receipts[PICK - 1];
    console.log(`\n→ Selected: [${PICK}] ${selected.receipt_id}`);
  } else {
    const sorted = [...receipts].sort((a, b) => {
      if (a.status === 'verified' && b.status !== 'verified') return -1;
      if (b.status === 'verified' && a.status !== 'verified') return 1;
      return Math.abs(b.realized_pnl_pct) - Math.abs(a.realized_pnl_pct);
    });
    selected = sorted[0];
    const idx = receipts.indexOf(selected) + 1;
    console.log(`\n→ Auto-selected: [${idx}] ${selected.receipt_id} (${selected.status}, ${selected.realized_pnl_pct >= 0 ? '+' : ''}${selected.realized_pnl_pct.toFixed(2)}%)`);
  }

  printReceiptPreview(selected);

} else {
  // ═════════════════════════════════════════════════════════════════════════
  // POSITION FLOW (v1.1)
  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n── Phase 4: Build Positions ──`);
  const positions = buildPositions(cycles, {
    wallet: WALLET,
    token: TOKEN_FILTER || undefined,
    from_ts: FROM_TS ?? undefined,
    to_ts: TO_TS ?? undefined,
  });
  console.log(`  Positions found: ${positions.length}`);

  if (positions.length === 0) {
    console.log('\n⚠️  No positions match the given filters.');
    console.log('   Try broadening --token, --from, --to, or omitting filters.');
    process.exit(0);
  }

  // List positions
  console.log(`\n── Available Positions ──\n`);
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const token = p.token.slice(0, 8);
    const pnlSign = p.realized_pnl_pct >= 0 ? '+' : '';
    const durH = (p.duration_sec / 3600).toFixed(1);
    console.log(`  [${i + 1}] ${p.position_id.slice(0, 16)}...`);
    console.log(`      ${token} | ${p.num_cycles} cycle(s) | ${p.num_buys}B/${p.num_sells}S | PnL: ${pnlSign}${p.realized_pnl_pct.toFixed(2)}% | ${durH}h | ${p.status}`);
    console.log(`      ${tsDisplay(p.start_time)} → ${tsDisplay(p.end_time)}`);
  }

  if (LIST_ONLY) {
    console.log(`\n${positions.length} position(s) available.`);
    console.log(`Use --position-id <hash> to select, or omit to auto-select.`);
    console.log(`Add --custom for custom receipt with leg removal.`);
    process.exit(0);
  }

  // Select position
  let selectedPosition;
  if (POSITION_ID) {
    selectedPosition = positions.find(p => p.position_id === POSITION_ID || p.position_id.startsWith(POSITION_ID));
    if (!selectedPosition) {
      console.error(`\nError: no position found matching --position-id ${POSITION_ID}`);
      process.exit(1);
    }
    console.log(`\n→ Selected by ID: ${selectedPosition.position_id.slice(0, 24)}...`);
  } else if (positions.length === 1) {
    selectedPosition = positions[0];
    console.log(`\n→ Auto-selected (only position): ${selectedPosition.position_id.slice(0, 24)}...`);
  } else {
    // Auto-select: prefer closed, then highest absolute PnL
    const sorted = [...positions].sort((a, b) => {
      if (a.status === 'closed' && b.status !== 'closed') return -1;
      if (b.status === 'closed' && a.status !== 'closed') return 1;
      return Math.abs(b.realized_pnl_pct) - Math.abs(a.realized_pnl_pct);
    });
    selectedPosition = sorted[0];
    const idx = positions.indexOf(selectedPosition) + 1;
    console.log(`\n→ Auto-selected: [${idx}] ${selectedPosition.position_id.slice(0, 24)}... (${selectedPosition.status})`);
  }

  // Show position legs
  console.log(`\n── Position Legs ──\n`);
  const allLegs = selectedPosition.legs;
  for (let i = 0; i < allLegs.length; i++) {
    const leg = allLegs[i];
    const action = leg.action === 'buy' ? '  BUY ' : '  SELL';
    const qs = leg.quote_mint ? qSym(leg.quote_mint) : '?';
    console.log(`  [${i + 1}] ${action} ${leg.amount.toFixed(6)} @ ${(leg.quote_amount / leg.amount).toPrecision(6)} ${qs}`);
    console.log(`      ${tsDisplay(leg.timestamp)} | ${leg.tx_hash.slice(0, 24)}...`);
  }

  // ── CUSTOM or VERIFIED? ──
  if (CUSTOM_MODE || REMOVE_LEGS) {
    // ═══════════════════════════════════════════════════════════════════════
    // CUSTOM RECEIPT PATH
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`\n── Custom Receipt Mode ──`);
    console.log(`  ⚠️  Custom receipts are NOT verified. They will be clearly`);
    console.log(`     marked as custom with a different hash and status.`);

    let legsToRemove;

    if (REMOVE_LEGS) {
      // Non-interactive: validate provided hashes
      legsToRemove = REMOVE_LEGS;
      const legHashes = new Set(allLegs.map(l => l.tx_hash));
      const invalid = legsToRemove.filter(h => !legHashes.has(h));
      if (invalid.length > 0) {
        console.error(`\n  ❌ Invalid leg hashes (not found in position):`);
        for (const h of invalid) console.error(`     ${h}`);
        process.exit(1);
      }
      console.log(`\n  Removing ${legsToRemove.length} leg(s) (non-interactive):`);
      for (const h of legsToRemove) {
        const leg = allLegs.find(l => l.tx_hash === h);
        console.log(`    ${leg.action.toUpperCase()} ${leg.amount.toFixed(6)} | ${h.slice(0, 24)}...`);
      }
    } else {
      // Interactive leg removal
      console.log(`\n  Enter leg numbers to remove (comma-separated), or 'q' to cancel:`);
      const answer = await promptLine('  Remove legs: ');
      if (answer.toLowerCase() === 'q' || answer === '') {
        console.log('  Cancelled.');
        process.exit(0);
      }
      const indices = answer.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      const invalid = indices.filter(n => n < 1 || n > allLegs.length);
      if (invalid.length > 0) {
        console.error(`  ❌ Invalid leg numbers: ${invalid.join(', ')} (valid: 1–${allLegs.length})`);
        process.exit(1);
      }
      legsToRemove = indices.map(i => allLegs[i - 1].tx_hash);
      console.log(`\n  Removing ${legsToRemove.length} leg(s):`);
      for (const idx of indices) {
        const leg = allLegs[idx - 1];
        console.log(`    [${idx}] ${leg.action.toUpperCase()} ${leg.amount.toFixed(6)} | ${leg.tx_hash.slice(0, 24)}...`);
      }
    }

    // Build verified receipt first (needed for base_position_hash)
    const verifiedReceipt = buildPositionReceipt(selectedPosition);

    // Build custom position
    const customPosition = buildCustomPosition(selectedPosition, { removed_legs: legsToRemove });

    // Build custom receipt
    console.log(`\n── Phase 5: Generate Custom Receipt ──`);
    selected = buildCustomReceipt(customPosition, verifiedReceipt.verification_hash);
    writeFileSync(resolve(dataDir, 'receipts/receipts.jsonl'), JSON.stringify(selected) + '\n');

    // Render
    console.log(`\n── Phase 6: Render ──`);
    renderReceipt(selected, resolve(dataDir, `renders/${selected.receipt_id}.png`));
    console.log(`  Rendered 1 PNG (custom)`);

    printReceiptPreview(selected);

  } else {
    // ═══════════════════════════════════════════════════════════════════════
    // VERIFIED POSITION RECEIPT PATH
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`\n── Phase 5: Generate Verified Position Receipt ──`);
    selected = buildPositionReceipt(selectedPosition);
    writeFileSync(resolve(dataDir, 'receipts/receipts.jsonl'), JSON.stringify(selected) + '\n');
    console.log(`  Generated 1 verified receipt`);

    console.log(`\n── Phase 6: Render ──`);
    renderReceipt(selected, resolve(dataDir, `renders/${selected.receipt_id}.png`));
    console.log(`  Rendered 1 PNG`);

    printReceiptPreview(selected);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7-9: SIGN → UPLOAD → MINT (shared by all flows)
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n── Phase 7: Claim Sign ──`);

const keypairBytes = new Uint8Array(JSON.parse(readFileSync(resolve(KEYPAIR_PATH), 'utf-8')));
const keypair = Keypair.fromSecretKey(keypairBytes);
const signerPubkey = keypair.publicKey.toBase58();
const recipient = RECIPIENT_OVERRIDE || signerPubkey;

if (selected.wallet !== signerPubkey) {
  console.error(`\n⚠️  Wallet mismatch: receipt wallet is ${selected.wallet}, but keypair is ${signerPubkey}`);
  console.error(`   The claim must be signed by the wallet that executed the trades.`);
  process.exit(1);
}

const { claim, messageBytes, signature } = signClaim(selected, keypair, recipient);
writeFileSync(resolve(dataDir, 'claims/claims.jsonl'), JSON.stringify(claim) + '\n');
console.log(`  ✅ Claim signed: ${claim.signature_bs58.slice(0, 20)}...`);
console.log(`     Recipient: ${recipient}`);

// ── Phase 8: Upload ──
let metadataUri, metadataHash;

if (SKIP_UPLOAD) {
  console.log(`\n── Phase 8: Upload ── SKIPPED (--skip-upload)`);
  metadataUri = 'https://arweave.net/placeholder_pending_upload';
  metadataHash = Buffer.alloc(32);
} else {
  console.log(`\n── Phase 8: Arweave Upload ──`);
  try {
    const pngPath = resolve(dataDir, `renders/${selected.receipt_id}.png`);
    const result = await uploadToArweave(selected, pngPath, keypairBytes, {
      network: NETWORK, dataDir, endpoints: ENDPOINTS,
    });
    metadataUri = result.metadataUri;
    metadataHash = result.metadataHash;
  } catch (e) {
    console.error(`  Upload failed: ${e.message}`);
    console.log(`  Falling back to dummy metadata URI.`);
    metadataUri = 'https://arweave.net/placeholder_pending_upload';
    metadataHash = Buffer.alloc(32);
  }
}

// ── Phase 9: Mint ──
console.log(`\n── Phase 9: Mint ──`);

try {
  const result = await mintOnChain({
    receipt: selected, keypair, recipient,
    messageBytes, signature,
    metadataUri, metadataHash,
    opts: { network: NETWORK, dryRun: DRY_RUN, dataDir, endpoints: ENDPOINTS },
  });

  if (result.alreadyMinted) {
    process.exit(0);
  }
} catch (e) {
  console.error(`\n  ❌ Mint failed: ${e.message}`);
  if (e.logs) {
    console.log(`  Logs:`);
    for (const log of e.logs.slice(-10)) console.log(`    ${log}`);
  }
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// DONE
// ═══════════════════════════════════════════════════════════════════════════
const isCustom = selected.receipt_type === 'custom';
console.log(`\n${'═'.repeat(60)}`);
console.log(`MINT-ONE COMPLETE${isCustom ? ' (CUSTOM)' : ''}`);
console.log(`  Receipt:  ${selected.receipt_id}`);
console.log(`  Type:     ${selected.receipt_type}`);
console.log(`  Token:    ${selected.token_mint.slice(0, 12)}...`);
console.log(`  PnL:      ${selected.realized_pnl_pct >= 0 ? '+' : ''}${selected.realized_pnl_pct.toFixed(2)}%`);
console.log(`  Hash:     ${selected.verification_hash.slice(0, 24)}...`);
console.log(`  Network:  ${NETWORK}`);
if (isCustom) {
  console.log(`  ⚠️  This is a CUSTOM receipt — not verified`);
}
console.log(`${'═'.repeat(60)}`);
