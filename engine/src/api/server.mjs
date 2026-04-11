#!/usr/bin/env node
/**
 * Phase 5 — Local API Server
 *
 * Thin orchestration layer over the existing engine modules.
 * No business logic here — routes call pipeline helpers only.
 *
 * Usage:
 *   node src/api/server.mjs [--port 3000]
 *
 * Endpoints:
 *   GET  /positions           — list positions for a wallet
 *   GET  /positions/:id       — position detail with legs
 *   POST /positions/:id/receipt — generate verified or custom receipt
 *   GET  /rebuild             — deterministic verified rebuild
 *   GET  /receipt/:hash/image — rendered receipt PNG
 */
import express from 'express';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { fetchTransactions, normalizeTransactions } from '../pipeline/ingest.mjs';
import { reconstructCycles } from '../pipeline/reconstruct.mjs';
import { buildPositionReceipt, buildCustomReceipt } from '../pipeline/receipt.mjs';
import { renderReceipt } from '../pipeline/render.mjs';
import { buildPositions, buildCustomPosition } from '../position/position-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const RENDERS_DIR = resolve(ROOT, 'data', 'renders');
mkdirSync(RENDERS_DIR, { recursive: true });

// ── Load Helius key ──
const envPath = resolve(process.env.USERPROFILE || process.env.HOME, '.openclaw', '.env');
let API_KEY = '';
try {
  const envContent = readFileSync(envPath, 'utf-8');
  const match = envContent.match(/^HELIUS_API_KEY=(.+)$/m);
  if (match) API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
} catch {}

// ═══════════════════════════════════════════════════════════════════════════
// Shared pipeline helper (cached per wallet per session)
// ═══════════════════════════════════════════════════════════════════════════

const pipelineCache = new Map();

async function runPipeline(wallet, { token, from, to, maxTxns = 5000 } = {}) {
  // Cache key includes wallet + maxTxns (token/from/to are post-filters)
  const cacheKey = `${wallet}:${maxTxns}`;

  let cached = pipelineCache.get(cacheKey);
  if (!cached) {
    if (!API_KEY) throw { status: 500, message: 'HELIUS_API_KEY not configured' };

    const rawTxns = await fetchTransactions(wallet, API_KEY, { maxTxns, silent: true });
    if (rawTxns.length === 0) throw { status: 404, message: 'No transactions found for this wallet' };

    const { events } = normalizeTransactions(rawTxns, wallet, { silent: true });
    if (events.length === 0) throw { status: 404, message: 'No swap events found for this wallet' };

    const { cycles } = reconstructCycles(events);
    const closed = cycles.filter(c => c.status === 'closed');
    if (closed.length === 0) throw { status: 404, message: 'No closed trade cycles found' };

    cached = { cycles, events, fetchedAt: Date.now() };
    pipelineCache.set(cacheKey, cached);
  }

  // Build positions with optional filters
  const positions = buildPositions(cached.cycles, {
    wallet,
    token: token || undefined,
    from_ts: from ? parseInt(from) : undefined,
    to_ts: to ? parseInt(to) : undefined,
  });

  return { positions, cycles: cached.cycles };
}

// ═══════════════════════════════════════════════════════════════════════════
// Express app
// ═══════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Error wrapper
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      const status = err.status || 500;
      const message = err.message || 'Internal server error';
      res.status(status).json({ error: message });
    });
  };
}

// ── GET /positions ──
app.get('/positions', asyncHandler(async (req, res) => {
  const { wallet, token, from, to, maxTxns } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet query parameter is required' });

  const { positions } = await runPipeline(wallet, { token, from, to, maxTxns });

  if (positions.length === 0) {
    return res.status(404).json({ error: 'No positions match the given filters' });
  }

  // Return list-view fields only (no legs)
  const result = positions.map(p => ({
    position_id: p.position_id,
    token: p.token,
    status: p.status,
    avg_entry: p.avg_entry,
    avg_exit: p.avg_exit,
    realized_pnl: p.realized_pnl,
    realized_pnl_pct: p.realized_pnl_pct,
    total_bought: p.total_bought,
    total_sold: p.total_sold,
    opened_at: p.start_time,
    closed_at: p.end_time,
    duration_sec: p.duration_sec,
    num_buys: p.num_buys,
    num_sells: p.num_sells,
    num_cycles: p.num_cycles,
  }));

  res.json({ count: result.length, positions: result });
}));

// ── GET /positions/:id ──
app.get('/positions/:id', asyncHandler(async (req, res) => {
  const { wallet, token, from, to, maxTxns } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet query parameter is required' });

  const posId = req.params.id;
  const { positions } = await runPipeline(wallet, { token, from, to, maxTxns });

  const match = positions.find(p => p.position_id === posId || p.position_id.startsWith(posId));
  if (!match) {
    return res.status(404).json({
      error: `No position found matching id: ${posId}`,
      available: positions.map(p => ({ position_id: p.position_id, token: p.token.slice(0, 8) })),
    });
  }

  res.json({
    position_id: match.position_id,
    wallet: match.wallet,
    token: match.token,
    from_ts: match.from_ts,
    to_ts: match.to_ts,
    status: match.status,
    avg_entry: match.avg_entry,
    avg_exit: match.avg_exit,
    realized_pnl: match.realized_pnl,
    realized_pnl_pct: match.realized_pnl_pct,
    total_bought: match.total_bought,
    total_sold: match.total_sold,
    duration_sec: match.duration_sec,
    num_cycles: match.num_cycles,
    num_buys: match.num_buys,
    num_sells: match.num_sells,
    cycles: match.cycles,
    legs: match.legs,
    entries: match.entries,
    exits: match.exits,
  });
}));

// ── POST /positions/:id/receipt ──
app.post('/positions/:id/receipt', asyncHandler(async (req, res) => {
  const { wallet, token, from, to, maxTxns } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet is required in request body' });

  const posId = req.params.id;
  const { positions } = await runPipeline(wallet, { token, from, to, maxTxns });

  const match = positions.find(p => p.position_id === posId || p.position_id.startsWith(posId));
  if (!match) {
    return res.status(404).json({
      error: `No position found matching id: ${posId}`,
      available: positions.map(p => ({ position_id: p.position_id, token: p.token.slice(0, 8) })),
    });
  }

  const isCustom = req.body.custom === true;
  const removedLegs = req.body.removed_legs;

  if (isCustom) {
    // Custom receipt
    if (!removedLegs || !Array.isArray(removedLegs) || removedLegs.length === 0) {
      return res.status(400).json({ error: 'custom=true requires removed_legs (non-empty array of tx hashes)' });
    }

    // Validate all hashes exist
    const legHashes = new Set(match.legs.map(l => l.tx_hash));
    const invalid = removedLegs.filter(h => !legHashes.has(h));
    if (invalid.length > 0) {
      return res.status(400).json({
        error: 'Invalid leg hashes (not found in position)',
        invalid_hashes: invalid,
        available_legs: match.legs.map(l => ({ tx_hash: l.tx_hash, action: l.action, amount: l.amount })),
      });
    }

    // Check we're not removing all legs
    const remainingEntries = match.entries.filter(e => !removedLegs.includes(e.tx_hash));
    const remainingExits = match.exits.filter(e => !removedLegs.includes(e.tx_hash));
    if (remainingEntries.length === 0 && remainingExits.length === 0) {
      return res.status(400).json({ error: 'Cannot remove all legs from a position' });
    }

    const verifiedReceipt = buildPositionReceipt(match);
    const customPosition = buildCustomPosition(match, { removed_legs: removedLegs });
    const customReceipt = buildCustomReceipt(customPosition, verifiedReceipt.verification_hash);

    // Render PNG
    const pngPath = resolve(RENDERS_DIR, `${customReceipt.receipt_id}.png`);
    renderReceipt(customReceipt, pngPath);

    return res.json({ receipt: customReceipt });
  }

  // Verified receipt
  const receipt = buildPositionReceipt(match);

  // Render PNG
  const pngPath = resolve(RENDERS_DIR, `${receipt.receipt_id}.png`);
  renderReceipt(receipt, pngPath);

  res.json({ receipt });
}));

// ── GET /rebuild ──
app.get('/rebuild', asyncHandler(async (req, res) => {
  const { wallet, token, from, to, maxTxns } = req.query;
  const positionId = req.query.position_id || req.query.positionId;
  if (!wallet) return res.status(400).json({ error: 'wallet query parameter is required' });

  const { positions } = await runPipeline(wallet, { token, from, to, maxTxns });

  if (positions.length === 0) {
    return res.status(404).json({ error: 'No positions match the given filters' });
  }

  let selected;
  if (positionId) {
    selected = positions.find(p => p.position_id === positionId || p.position_id.startsWith(positionId));
    if (!selected) {
      return res.status(404).json({
        error: `No rebuilt position matches position_id: ${positionId}`,
        rebuilt_positions: positions.map(p => ({ position_id: p.position_id, token: p.token.slice(0, 8), num_cycles: p.num_cycles })),
      });
    }
  } else if (positions.length === 1) {
    selected = positions[0];
  } else {
    return res.status(409).json({
      error: `Multiple positions found (${positions.length}). Provide position_id or token to disambiguate.`,
      positions: positions.map(p => ({
        position_id: p.position_id,
        token: p.token.slice(0, 8),
        num_cycles: p.num_cycles,
        realized_pnl_pct: p.realized_pnl_pct,
      })),
    });
  }

  const receipt = buildPositionReceipt(selected);

  res.json({
    rebuild: {
      wallet: receipt.wallet,
      token: receipt.token_mint,
      from_ts: selected.from_ts,
      to_ts: selected.to_ts,
      position_id: selected.position_id,
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
    },
  });
}));

// ── GET /receipt/:hash/image ──
app.get('/receipt/:hash/image', (req, res) => {
  const hash = req.params.hash;

  const receiptsPath = resolve(ROOT, 'data', 'receipts', 'receipts.jsonl');
  if (!existsSync(receiptsPath)) {
    return res.status(404).json({ error: 'No receipts generated in current session' });
  }

  try {
    const lines = readFileSync(receiptsPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const r = JSON.parse(line);
      if (r.verification_hash === hash) {
        const pngPath = resolve(RENDERS_DIR, `${r.receipt_id}.png`);
        if (existsSync(pngPath)) {
          return res.sendFile(pngPath);
        }
      }
    }
  } catch {}

  res.status(404).json({ error: `No rendered image found for hash: ${hash}` });
});

// ── Serve UI static files ──
const UI_DIR = resolve(ROOT, '..', 'ui');
app.use('/ui', express.static(UI_DIR));

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', api_key_configured: !!API_KEY });
});

// ═══════════════════════════════════════════════════════════════════════════
// Start server
// ═══════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1]) : 3000;

export { app, runPipeline };
export default app;

// Listen when run directly. Tests set TRADE_ARTIFACT_TEST=1 to skip.
if (!process.env.TRADE_ARTIFACT_TEST) {
  app.listen(PORT, () => {
    console.log(`\n╔════════════════════════════════════════════════════════════╗`);
    console.log(`║  Trade Artifact API Server                                ║`);
    console.log(`╚════════════════════════════════════════════════════════════╝`);
    console.log(`  Port:     ${PORT}`);
    console.log(`  API key:  ${API_KEY ? 'configured' : '⚠️  NOT CONFIGURED'}`);
    console.log(`  Renders:  ${RENDERS_DIR}`);
    console.log(`\n  Endpoints:`);
    console.log(`    GET  /health`);
    console.log(`    GET  /positions?wallet=...`);
    console.log(`    GET  /positions/:id?wallet=...`);
    console.log(`    POST /positions/:id/receipt`);
    console.log(`    GET  /rebuild?wallet=...`);
    console.log(`    GET  /receipt/:hash/image`);
    console.log(`\n  UI:  http://localhost:${PORT}/ui/`);
    console.log();
  });
}
