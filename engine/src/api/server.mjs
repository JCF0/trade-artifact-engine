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
import { normalizePositions, detectMixedQuotes } from '../pipeline/quote-normalizer.mjs';
import { classifyAll, formatCoverageReport } from '../pipeline/classifier.mjs';
import { TokenMetadataCache, collectMintsFromPositions, enrichPositions } from '../pipeline/token-metadata.mjs';
import { TransactionCache } from '../pipeline/tx-cache.mjs';
import { DEX_PROGRAMS } from '../pipeline/constants.mjs';
import {
  buildInventorySnapshot,
  getInventoryReceipt,
  getLegacyInventoryReceipt,
  listLegacyInventory,
  parseInventoryQuery,
} from '../inventory/inventory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const RENDERS_DIR = resolve(ROOT, 'data', 'renders');
mkdirSync(RENDERS_DIR, { recursive: true });

// ── Load Helius key lazily ──
const envPath = resolve(process.env.USERPROFILE || process.env.HOME, '.openclaw', '.env');
let API_KEY;
let tokenMetadataCache;

function loadApiKey() {
  if (API_KEY !== undefined) return API_KEY;
  API_KEY = '';
  try {
    const envContent = readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^HELIUS_API_KEY=(.+)$/m);
    if (match) API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  return API_KEY;
}

function getTokenMetadataCache() {
  if (!tokenMetadataCache) {
    tokenMetadataCache = new TokenMetadataCache({
      heliusApiKey: loadApiKey(),
      cacheDir: resolve(ROOT, 'data', 'cache'),
    });
  }
  return tokenMetadataCache;
}

// ── Transaction cache (per-wallet, disk-persisted) ──
const txCache = new TransactionCache({
  cacheDir: resolve(ROOT, 'data', 'cache', 'transactions'),
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared pipeline helper (cached per wallet per session)
// ═══════════════════════════════════════════════════════════════════════════

const pipelineCache = new Map();

async function runPipeline(wallet, { token, from, to, maxTxns = 5000 } = {}) {
  const API_KEY = loadApiKey();
  if (!API_KEY) throw { status: 500, message: 'HELIUS_API_KEY not configured' };

  // Cache key includes wallet (maxTxns affects fetch depth, not cache key)
  const cacheKey = wallet;

  // Fetch transactions incrementally (cache-aware)
  const { transactions: rawTxns, fromCache, fetched, total } = await txCache.fetchIncremental(
    wallet, API_KEY, { maxTxns, silent: true }
  );

  if (rawTxns.length === 0) throw { status: 404, message: 'No transactions found for this wallet' };

  // If we have new transactions, invalidate the pipeline cache
  let cached = pipelineCache.get(cacheKey);
  if (cached && fetched > 0) {
    // New transactions arrived — need to re-process
    cached = null;
    pipelineCache.delete(cacheKey);
  }

  if (!cached) {
    const { events } = normalizeTransactions(rawTxns, wallet, { silent: true });
    if (events.length === 0) throw { status: 404, message: 'No swap events found for this wallet' };

    // Classify all transactions
    const { coverage } = classifyAll(rawTxns, wallet, DEX_PROGRAMS);

    const { cycles } = reconstructCycles(events);
    if (cycles.length === 0) throw { status: 404, message: 'No trade cycles found' };

    cached = {
      cycles, events, coverage, normalizedPositions: new Map(),
      fetchedAt: Date.now(), txCount: total, newTxCount: fetched,
    };
    pipelineCache.set(cacheKey, cached);
  }

  // Build filter key for position cache
  const filterKey = `${token || ''}:${from || ''}:${to || ''}`;

  // Return cached normalized positions for same filter set
  if (cached.normalizedPositions.has(filterKey)) {
    return { positions: cached.normalizedPositions.get(filterKey), cycles: cached.cycles };
  }

  // Build positions with optional filters
  const positions = buildPositions(cached.cycles, {
    wallet,
    token: token || undefined,
    from_ts: from ? parseInt(from) : undefined,
    to_ts: to ? parseInt(to) : undefined,
  });

  // Normalize mixed-quote positions (single API call, then cached)
  const normalized = await normalizePositions(positions);

  // Resolve token metadata for all mints
  const allMints = collectMintsFromPositions(normalized);
  const tokenMetadataCache = getTokenMetadataCache();
  await tokenMetadataCache.resolve(allMints);
  enrichPositions(normalized, tokenMetadataCache);

  cached.normalizedPositions.set(filterKey, normalized);

  return {
    positions: normalized,
    cycles: cached.cycles,
    coverage: cached.coverage,
    cacheInfo: {
      tx_total: cached.txCount || total,
      tx_new: cached.newTxCount ?? fetched,
      tx_from_cache: (cached.txCount || total) - (cached.newTxCount ?? fetched),
      pipeline_cached_at: cached.fetchedAt ? new Date(cached.fetchedAt).toISOString() : null,
      token_metadata_size: tokenMetadataCache.size,
    },
  };
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

function getInventoryRoot() {
  return process.env.TRADE_ARTIFACT_INVENTORY_ROOT
    ? resolve(process.env.TRADE_ARTIFACT_INVENTORY_ROOT)
    : ROOT;
}

// ── GET /positions ──
app.get('/positions', asyncHandler(async (req, res) => {
  const { wallet, token, from, to, maxTxns } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet query parameter is required' });

  const { positions, coverage, cacheInfo } = await runPipeline(wallet, { token, from, to, maxTxns });

  if (positions.length === 0) {
    return res.status(404).json({ error: 'No positions match the given filters' });
  }

  // Return list-view fields only (no legs)
  const result = positions.map(p => {
    const base = {
      position_id: p.position_id,
      token: p.token,
      token_meta: p.token_meta || null,
      status: p.status,
      pnl_display_type: p.pnl_display_type,
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
    };
    // Include normalization data if mixed-quote
    if (p.normalization?.mixed_quotes) {
      base.normalization = p.normalization;
      base.normalized_realized_pnl_pct = p.normalized_realized_pnl_pct;
      base.normalized_realized_pnl = p.normalized_realized_pnl;
    }
    return base;
  });

  res.json({
    count: result.length,
    positions: result,
    coverage: coverage || null,
    cache: cacheInfo || null,
  });
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

  const detail = {
    position_id: match.position_id,
    wallet: match.wallet,
    token: match.token,
    token_meta: match.token_meta || null,
    from_ts: match.from_ts,
    to_ts: match.to_ts,
    status: match.status,
    pnl_display_type: match.pnl_display_type,
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
  };
  // Include normalization data if present
  if (match.normalization) {
    detail.normalization = match.normalization;
    if (match.normalization.mixed_quotes) {
      detail.normalized_avg_entry = match.normalized_avg_entry;
      detail.normalized_avg_exit = match.normalized_avg_exit;
      detail.normalized_cost_basis = match.normalized_cost_basis;
      detail.normalized_proceeds = match.normalized_proceeds;
      detail.normalized_realized_pnl = match.normalized_realized_pnl;
      detail.normalized_realized_pnl_pct = match.normalized_realized_pnl_pct;
      detail.normalized_realized_pnl_usd = match.normalized_realized_pnl_usd;
    }
  }
  res.json(detail);
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

  // Reject receipt generation for open positions
  if (match.pnl_display_type === 'unrealized_unavailable') {
    return res.status(400).json({
      error: 'Cannot generate a realized-PnL receipt for an open position. The position has no exit legs.',
      position_status: match.status,
      pnl_display_type: match.pnl_display_type,
      hint: 'Close the position by selling the token, then retry.',
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

// ── GET /inventory/legacy ──
app.get('/inventory/legacy', asyncHandler(async (req, res) => {
  const { includeExcluded } = parseInventoryQuery(req.query);
  const legacyReceipts = listLegacyInventory({
    engineRoot: getInventoryRoot(),
    includeExcluded,
  });

  res.json({
    count: legacyReceipts.length,
    legacy_receipts: legacyReceipts,
  });
}));

// ── GET /inventory/legacy/:verificationHash ──
app.get('/inventory/legacy/:verificationHash', asyncHandler(async (req, res) => {
  const { includeExcluded } = parseInventoryQuery(req.query);
  const legacyReceipt = getLegacyInventoryReceipt(req.params.verificationHash, {
    engineRoot: getInventoryRoot(),
    includeExcluded,
  });

  if (!legacyReceipt) {
    return res.status(404).json({ error: `No legacy receipt found for verification_hash: ${req.params.verificationHash}` });
  }

  res.json({ legacy_receipt: legacyReceipt });
}));

// ── GET /inventory ──
app.get('/inventory', asyncHandler(async (req, res) => {
  const query = parseInventoryQuery(req.query);
  // Legacy inventory stays explicit and separate on /inventory/legacy routes,
  // so include_legacy/includeLegacy is intentionally ignored here.
  const snapshot = buildInventorySnapshot({
    engineRoot: getInventoryRoot(),
    includeLegacy: false,
    includeExcluded: query.includeExcluded,
    filters: query.filters,
    limit: query.limit,
    offset: query.offset,
  });
  res.json(snapshot);
}));

// ── GET /inventory/:receiptHash ──
app.get('/inventory/:receiptHash', asyncHandler(async (req, res) => {
  const query = parseInventoryQuery(req.query);
  const receipt = getInventoryReceipt(req.params.receiptHash, {
    engineRoot: getInventoryRoot(),
    includeExcluded: query.includeExcluded,
  });

  if (!receipt) {
    return res.status(404).json({ error: `No inventory receipt found for receipt_hash: ${req.params.receiptHash}` });
  }

  res.json({ receipt });
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

// ── GET /coverage — classification report for a wallet ──
app.get('/coverage', asyncHandler(async (req, res) => {
  const { wallet, maxTxns } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet query parameter is required' });

  // Run pipeline to populate cache (which now includes coverage)
  try {
    await runPipeline(wallet, { maxTxns });
  } catch (e) {
    const cached = pipelineCache.get(wallet);
    if (cached?.coverage) {
      return res.json({ coverage: cached.coverage });
    }
    throw e;
  }

  const cached = pipelineCache.get(wallet);
  if (!cached?.coverage) {
    return res.status(404).json({ error: 'No coverage data available' });
  }

  res.json({ coverage: cached.coverage, tx_cache: txCache.stats(wallet) });
}));

// ── GET /token/:mint — resolve token metadata ──
app.get('/token/:mint', asyncHandler(async (req, res) => {
  const tokenMetadataCache = getTokenMetadataCache();
  const meta = await tokenMetadataCache.getOrResolve(req.params.mint);
  res.json(meta);
}));

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    api_key_configured: API_KEY === undefined ? false : !!API_KEY,
    token_cache_size: tokenMetadataCache ? tokenMetadataCache.size : 0,
  });
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
  const startupApiKey = loadApiKey();
  const server = app.listen(PORT, () => {
    console.log(`\n╔════════════════════════════════════════════════════════════╗`);
    console.log(`║  Trade Artifact API Server                                ║`);
    console.log(`╚════════════════════════════════════════════════════════════╝`);
    console.log(`  Port:     ${PORT}`);
    console.log(`  API key:  ${startupApiKey ? 'configured' : '⚠️  NOT CONFIGURED'}`);
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
    console.log(`  [${new Date().toISOString()}] Server listening — pid ${process.pid}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ❌ Port ${PORT} is already in use. Try --port <other>`);
    } else {
      console.error(`\n  ❌ Server error:`, err.message);
    }
    process.exit(1);
  });

  // Keep process alive — log on shutdown
  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    server.close(() => process.exit(0));
  });
}
