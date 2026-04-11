#!/usr/bin/env node
/**
 * rebuild-position.mjs — Deterministic Position Rebuild (Phase 4)
 *
 * Rebuilds a verified position receipt from wallet + token + timeframe.
 * Same inputs always produce the same position_id and verification_hash.
 *
 * Verified path ONLY — no custom editing.
 *
 * Usage:
 *   node src/rebuild-position.mjs --wallet <addr> --token <mint> --from <epoch> --to <epoch> [options]
 *
 * Options:
 *   --wallet <addr>          Wallet address (required)
 *   --token <mint>           Token mint address (optional — required if multiple tokens)
 *   --from <epoch>           From timestamp (optional)
 *   --to <epoch>             To timestamp (optional)
 *   --position-id <hash>     Validate against this position ID
 *   --max-txns <N>           Transaction fetch cap (default: 5000)
 *   --json                   Output raw JSON instead of formatted
 *   --quiet                  Suppress progress output (only print result)
 */
import { readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { fetchTransactions, normalizeTransactions } from './pipeline/ingest.mjs';
import { reconstructCycles } from './pipeline/reconstruct.mjs';
import { buildPositionReceipt } from './pipeline/receipt.mjs';
import { buildPositions, computePositionId } from './position/position-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

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

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
rebuild-position — Deterministic Position Rebuild

Rebuilds a verified position receipt from the same inputs.
Same wallet + token + timeframe = identical hash. Always.

USAGE:
  node src/rebuild-position.mjs --wallet <addr> [options]

OPTIONS:
  --wallet <addr>          Wallet address (required)
  --token <mint>           Token mint (required if multiple tokens found)
  --from <epoch>           From timestamp
  --to <epoch>             To timestamp
  --position-id <hash>     Validate rebuilt position matches this ID
  --max-txns <N>           Transaction fetch cap (default: 5000)
  --json                   Output raw JSON
  --quiet                  Suppress progress (result only)

EXAMPLES:
  # Rebuild from wallet + token
  node src/rebuild-position.mjs --wallet FDh2...xP --token JUPy...vCN

  # Rebuild with exact timeframe
  node src/rebuild-position.mjs --wallet FDh2...xP --token JUPy...vCN --from 1774400000 --to 1774954000

  # Verify a known position ID
  node src/rebuild-position.mjs --wallet FDh2...xP --position-id 01ede6c4...
`);
  process.exit(0);
}

const WALLET = getFlag('--wallet');
const TOKEN_FILTER = getFlag('--token');
const FROM_TS = getFlag('--from') ? parseInt(getFlag('--from')) : undefined;
const TO_TS = getFlag('--to') ? parseInt(getFlag('--to')) : undefined;
const EXPECTED_POS_ID = getFlag('--position-id');
const MAX_TXNS = parseInt(getFlag('--max-txns') || '5000');
const JSON_OUTPUT = hasFlag('--json');
const QUIET = hasFlag('--quiet');

if (!WALLET) {
  console.error('Error: --wallet is required');
  process.exit(1);
}

function log(...args) { if (!QUIET) console.log(...args); }
function logErr(...args) { console.error(...args); }

function tsDisplay(epoch) {
  return new Date(epoch * 1000).toISOString().slice(0, 19) + 'Z';
}

// ═══════════════════════════════════════════════════════════════════════════
// Load Helius key
// ═══════════════════════════════════════════════════════════════════════════
const envPath = resolve(process.env.USERPROFILE || process.env.HOME, '.openclaw', '.env');
const envContent = readFileSync(envPath, 'utf-8');
const keyMatch = envContent.match(/^HELIUS_API_KEY=(.+)$/m);
if (!keyMatch) { logErr('HELIUS_API_KEY not found in ' + envPath); process.exit(1); }
const API_KEY = keyMatch[1].trim().replace(/^["']|["']$/g, '');

const dataDir = resolve(ROOT, 'data');
mkdirSync(resolve(dataDir, 'raw'), { recursive: true });
mkdirSync(resolve(dataDir, 'normalized'), { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE: INGEST → NORMALIZE → RECONSTRUCT → POSITIONS → RECEIPT
// ═══════════════════════════════════════════════════════════════════════════

log(`\n╔════════════════════════════════════════════════════════════╗`);
log(`║  REBUILD-POSITION — Deterministic Verified Rebuild        ║`);
log(`╚════════════════════════════════════════════════════════════╝`);
log(`Wallet:  ${WALLET}`);
if (TOKEN_FILTER) log(`Token:   ${TOKEN_FILTER}`);
if (FROM_TS != null) log(`From:    ${tsDisplay(FROM_TS)} (${FROM_TS})`);
if (TO_TS != null) log(`To:      ${tsDisplay(TO_TS)} (${TO_TS})`);
if (EXPECTED_POS_ID) log(`Expect:  ${EXPECTED_POS_ID}`);

// Phase 1: Ingest
log(`\n── Ingest ──`);
const rawTxns = await fetchTransactions(WALLET, API_KEY, {
  maxTxns: MAX_TXNS,
  dataDir,
  silent: QUIET,
});
if (rawTxns.length === 0) { logErr('\n❌ No transactions found.'); process.exit(1); }

// Phase 2: Normalize
log(`\n── Normalize ──`);
const { events } = normalizeTransactions(rawTxns, WALLET, { dataDir, silent: QUIET });
if (events.length === 0) { logErr('\n❌ No swap events found.'); process.exit(1); }

// Phase 3: Reconstruct
log(`\n── Reconstruct ──`);
const { cycles, stats } = reconstructCycles(events);
log(`  Cycles: ${stats.total} (${stats.closed} closed, ${stats.open} open, ${stats.partial} partial)`);

const closed = cycles.filter(c => c.status === 'closed');
if (closed.length === 0) { logErr('\n❌ No closed cycles found.'); process.exit(1); }

// Phase 4: Build positions
log(`\n── Build Positions ──`);
const positions = buildPositions(cycles, {
  wallet: WALLET,
  token: TOKEN_FILTER || undefined,
  from_ts: FROM_TS,
  to_ts: TO_TS,
});
log(`  Positions found: ${positions.length}`);

// ═══════════════════════════════════════════════════════════════════════════
// SELECTION + VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

if (positions.length === 0) {
  logErr('\n❌ No positions match the given filters.');
  logErr('   Try broadening --token, --from, --to, or check the wallet has closed cycles.');
  process.exit(1);
}

let selectedPosition;

if (EXPECTED_POS_ID) {
  // Validate against expected position ID
  selectedPosition = positions.find(p =>
    p.position_id === EXPECTED_POS_ID || p.position_id.startsWith(EXPECTED_POS_ID)
  );
  if (!selectedPosition) {
    logErr(`\n❌ No rebuilt position matches --position-id ${EXPECTED_POS_ID}`);
    logErr(`\n   Rebuilt position IDs:`);
    for (const p of positions) {
      logErr(`     ${p.position_id} (${p.token.slice(0, 8)}, ${p.num_cycles} cycles)`);
    }
    logErr(`\n   This means the inputs don't reproduce the expected position.`);
    logErr(`   Check --wallet, --token, --from, --to, and --max-txns.`);
    process.exit(1);
  }
  log(`\n  ✅ Position ID validated: ${selectedPosition.position_id.slice(0, 24)}...`);

} else if (positions.length === 1) {
  selectedPosition = positions[0];
  log(`\n  → Single position found: ${selectedPosition.position_id.slice(0, 24)}...`);

} else {
  // Multiple positions — ambiguous
  logErr(`\n❌ Multiple positions found (${positions.length}). Cannot auto-select.`);
  logErr(`\n   Use --position-id or --token to disambiguate:\n`);
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const pnlSign = p.realized_pnl_pct >= 0 ? '+' : '';
    logErr(`   [${i + 1}] ${p.position_id}`);
    logErr(`       ${p.token.slice(0, 8)} | ${p.num_cycles} cycles | PnL: ${pnlSign}${p.realized_pnl_pct.toFixed(2)}%`);
    logErr(`       ${tsDisplay(p.start_time)} → ${tsDisplay(p.end_time)}`);
  }
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE VERIFIED RECEIPT
// ═══════════════════════════════════════════════════════════════════════════

log(`\n── Generate Verified Receipt ──`);
const receipt = buildPositionReceipt(selectedPosition);

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

if (JSON_OUTPUT) {
  // Raw JSON — for piping / programmatic use
  console.log(JSON.stringify({
    wallet: receipt.wallet,
    token: receipt.token_mint,
    from_ts: selectedPosition.from_ts,
    to_ts: selectedPosition.to_ts,
    position_id: selectedPosition.position_id,
    receipt_type: receipt.receipt_type,
    status: receipt.status,
    status_byte: receipt.status_byte,
    verification_hash: receipt.verification_hash,
    avg_entry_price: receipt.avg_entry_price,
    avg_exit_price: receipt.avg_exit_price,
    realized_pnl: receipt.realized_pnl,
    realized_pnl_pct: receipt.realized_pnl_pct,
    total_bought: receipt.total_bought,
    total_sold: receipt.total_sold,
    num_buys: receipt.num_buys,
    num_sells: receipt.num_sells,
    num_cycles: receipt.num_cycles,
    opened_at: receipt.opened_at,
    closed_at: receipt.closed_at,
    hold_time_seconds: receipt.hold_time_seconds,
  }, null, 2));
} else {
  const pnlSign = receipt.realized_pnl_pct >= 0 ? '+' : '';

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  REBUILD RESULT — Deterministic Verified Receipt          ║`);
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`║                                                            ║`);
  console.log(`║  Wallet:        ${receipt.wallet.padEnd(41)}║`);
  console.log(`║  Token:         ${receipt.token_mint.padEnd(41)}║`);
  console.log(`║  From:          ${(tsDisplay(selectedPosition.from_ts) + ` (${selectedPosition.from_ts})`).padEnd(41)}║`);
  console.log(`║  To:            ${(tsDisplay(selectedPosition.to_ts) + ` (${selectedPosition.to_ts})`).padEnd(41)}║`);
  console.log(`║                                                            ║`);
  console.log(`║  Position ID:   ${selectedPosition.position_id.padEnd(41)}║`);
  console.log(`║  Receipt type:  ${receipt.receipt_type.padEnd(41)}║`);
  console.log(`║  Status:        ${receipt.status.padEnd(41)}║`);
  console.log(`║                                                            ║`);
  console.log(`║  ┌──────────────────────────────────────────────────────┐  ║`);
  console.log(`║  │ Hash: ${receipt.verification_hash.padEnd(49)}│  ║`);
  console.log(`║  └──────────────────────────────────────────────────────┘  ║`);
  console.log(`║                                                            ║`);
  console.log(`║  Avg entry:     ${receipt.avg_entry_price.toPrecision(6).padEnd(41)}║`);
  console.log(`║  Avg exit:      ${receipt.avg_exit_price.toPrecision(6).padEnd(41)}║`);
  console.log(`║  PnL:           ${(pnlSign + receipt.realized_pnl_pct.toFixed(2) + '%').padEnd(41)}║`);
  console.log(`║  Trades:        ${(receipt.num_buys + 'B / ' + receipt.num_sells + 'S (' + receipt.num_cycles + ' cycles)').padEnd(41)}║`);
  console.log(`║  Opened:        ${tsDisplay(receipt.opened_at).padEnd(41)}║`);
  console.log(`║  Closed:        ${tsDisplay(receipt.closed_at).padEnd(41)}║`);
  console.log(`║                                                            ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  console.log(`\n  Same inputs → same hash. Always.`);
}
