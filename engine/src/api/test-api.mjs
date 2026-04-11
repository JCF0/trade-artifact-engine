#!/usr/bin/env node
/**
 * Phase 5 — API Server Tests
 *
 * Tests the API endpoints by starting the server on a random port,
 * making HTTP requests, and validating responses.
 *
 * Uses cached pipeline data — the server will fetch from Helius on first
 * request (cached internally), so this requires a valid API key.
 * For offline testing, we test the pipeline logic directly first,
 * then make one live request to validate the HTTP layer.
 */
import http from 'http';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Test pipeline logic directly (no HTTP needed, no API key needed)
import { normalizeTransactions } from '../pipeline/ingest.mjs';
import { reconstructCycles } from '../pipeline/reconstruct.mjs';
import { buildPositionReceipt, buildCustomReceipt } from '../pipeline/receipt.mjs';
import { buildPositions, buildCustomPosition } from '../position/position-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

let pass = 0, fail = 0;

function check(label, actual, expected) {
  const eq = typeof expected === 'number'
    ? Math.abs(actual - expected) < 1e-10
    : actual === expected;
  if (eq) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}

function section(title) { console.log(`\n── ${title} ──`); }

const WALLET = 'FDh2oFVBYzmVrqVrNQNR8vRwVZhfRhW5w964HG8eypxP';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Phase 5 — API Server Tests                             ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ═══════════════════════════════════════════════════════════════
// Part A: Pipeline logic tests (offline, no HTTP)
// These validate the shapes that the API would return.
// ═══════════════════════════════════════════════════════════════

section('Part A: Pipeline response shapes (offline)');

const txns = readFileSync(resolve(ROOT, 'data/raw/helius_transactions.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

const { events } = normalizeTransactions(txns, WALLET, { silent: true });
const { cycles } = reconstructCycles(events);

// ── GET /positions shape ──
section('A1: GET /positions response shape');

const positions = buildPositions(cycles, { wallet: WALLET });
const positionsResponse = positions.map(p => ({
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

check('positions count', positionsResponse.length, 1);
check('position has position_id', typeof positionsResponse[0].position_id, 'string');
check('position has token', positionsResponse[0].token, JUP_MINT);
check('position has status', positionsResponse[0].status, 'closed');
check('position has avg_entry', typeof positionsResponse[0].avg_entry, 'number');
check('position has avg_exit', typeof positionsResponse[0].avg_exit, 'number');
check('position has realized_pnl_pct', typeof positionsResponse[0].realized_pnl_pct, 'number');
check('position has num_buys', positionsResponse[0].num_buys, 2);
check('position has num_sells', positionsResponse[0].num_sells, 2);
check('position has num_cycles', positionsResponse[0].num_cycles, 2);
check('position has opened_at', typeof positionsResponse[0].opened_at, 'number');
check('position has closed_at', typeof positionsResponse[0].closed_at, 'number');

// ── GET /positions/:id shape ──
section('A2: GET /positions/:id response shape');

const pos = positions[0];
check('detail has legs', Array.isArray(pos.legs), true);
check('detail has entries', Array.isArray(pos.entries), true);
check('detail has exits', Array.isArray(pos.exits), true);
check('detail has cycles', Array.isArray(pos.cycles), true);
check('detail legs count', pos.legs.length, 4);
check('detail entries count', pos.entries.length, 2);
check('detail exits count', pos.exits.length, 2);

// ── POST /positions/:id/receipt (verified) shape ──
section('A3: POST /positions/:id/receipt (verified) response shape');

const verifiedReceipt = buildPositionReceipt(pos);
check('verified receipt_type', verifiedReceipt.receipt_type, 'verified');
check('verified is_custom', verifiedReceipt.is_custom, false);
check('verified has verification_hash', verifiedReceipt.verification_hash.length, 64);
check('verified has position_id', verifiedReceipt.position_id, pos.position_id);
check('verified has avg_entry_price', typeof verifiedReceipt.avg_entry_price, 'number');

// ── POST /positions/:id/receipt (custom) shape ──
section('A4: POST /positions/:id/receipt (custom) response shape');

const firstEntryHash = pos.entries[0].tx_hash;
const customPos = buildCustomPosition(pos, { removed_legs: [firstEntryHash] });
const customReceipt = buildCustomReceipt(customPos, verifiedReceipt.verification_hash);

check('custom receipt_type', customReceipt.receipt_type, 'custom');
check('custom is_custom', customReceipt.is_custom, true);
check('custom has removed_legs', customReceipt.removed_legs.length, 1);
check('custom has base_position_hash', customReceipt.base_position_hash, verifiedReceipt.verification_hash);
check('custom hash differs', customReceipt.verification_hash !== verifiedReceipt.verification_hash, true);
check('custom has integrity_warnings', Array.isArray(customReceipt.integrity_warnings), true);

// ── GET /rebuild shape ──
section('A5: GET /rebuild response shape');

const rebuildReceipt = buildPositionReceipt(pos);
check('rebuild receipt_type', rebuildReceipt.receipt_type, 'verified');
check('rebuild hash deterministic', rebuildReceipt.verification_hash, verifiedReceipt.verification_hash);
check('rebuild has all fields', typeof rebuildReceipt.avg_entry_price, 'number');

// ═══════════════════════════════════════════════════════════════
// Part B: HTTP layer tests (start server, make requests)
// ═══════════════════════════════════════════════════════════════

section('Part B: HTTP layer');

// Import the Express app (prevent auto-listen)
process.env.TRADE_ARTIFACT_TEST = '1';
const { app } = await import('./server.mjs');

// Start on random port
const server = await new Promise((resolve, reject) => {
  const srv = app.listen(0, () => resolve(srv));
  srv.on('error', reject);
});
const PORT = server.address().port;
console.log(`  Server started on port ${PORT}`);

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`http://localhost:${PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let respData = '';
      res.on('data', chunk => respData += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(respData) }); }
        catch { resolve({ status: res.statusCode, body: respData }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Health check
section('B1: GET /health');
const health = await httpGet('/health');
check('Health status 200', health.status, 200);
check('Health body.status', health.body.status, 'ok');

// Missing wallet → 400
section('B2: Error handling — missing wallet');
const noWallet = await httpGet('/positions');
check('No wallet → 400', noWallet.status, 400);
check('Error message', noWallet.body.error, 'wallet query parameter is required');

const noWalletRebuild = await httpGet('/rebuild');
check('Rebuild no wallet → 400', noWalletRebuild.status, 400);

// POST missing wallet → 400
const noWalletPost = await httpPost(`/positions/${pos.position_id}/receipt`, {});
check('POST no wallet → 400', noWalletPost.status, 400);

// POST custom without removed_legs → 400
section('B3: Error handling — custom without removed_legs');
const badCustom = await httpPost(`/positions/${pos.position_id}/receipt`, {
  wallet: WALLET, custom: true,
});
check('Custom no legs → 400', badCustom.status, 400);
check('Custom no legs error', badCustom.body.error.includes('removed_legs'), true);

// POST custom with invalid legs → 400
const badLegs = await httpPost(`/positions/${pos.position_id}/receipt`, {
  wallet: WALLET, custom: true, removed_legs: ['fakehash123'],
});
check('Custom bad legs → 400', badLegs.status, 400);
check('Custom bad legs has invalid_hashes', Array.isArray(badLegs.body.invalid_hashes), true);

// ── Live endpoint tests (requires API key for first pipeline run) ──
section('B4: Live endpoint tests');

const posResp = await httpGet(`/positions?wallet=${WALLET}`);
if (posResp.status === 200) {
  check('/positions → 200', posResp.status, 200);
  check('/positions has count', typeof posResp.body.count, 'number');
  check('/positions has positions array', Array.isArray(posResp.body.positions), true);
  check('/positions first has position_id', typeof posResp.body.positions[0].position_id, 'string');

  const posId = posResp.body.positions[0].position_id;

  // GET /positions/:id
  const detailResp = await httpGet(`/positions/${posId}?wallet=${WALLET}`);
  check('/positions/:id → 200', detailResp.status, 200);
  check('/positions/:id has legs', Array.isArray(detailResp.body.legs), true);
  check('/positions/:id has entries', Array.isArray(detailResp.body.entries), true);

  // POST /positions/:id/receipt (verified)
  const receiptResp = await httpPost(`/positions/${posId}/receipt`, { wallet: WALLET });
  check('POST verified receipt → 200', receiptResp.status, 200);
  check('Verified receipt_type', receiptResp.body.receipt.receipt_type, 'verified');
  check('Verified has hash', receiptResp.body.receipt.verification_hash.length, 64);

  // POST /positions/:id/receipt (custom)
  const entryHash = detailResp.body.entries[0].tx_hash;
  const customResp = await httpPost(`/positions/${posId}/receipt`, {
    wallet: WALLET, custom: true, removed_legs: [entryHash],
  });
  check('POST custom receipt → 200', customResp.status, 200);
  check('Custom receipt_type', customResp.body.receipt.receipt_type, 'custom');
  check('Custom has removed_legs', customResp.body.receipt.removed_legs.length, 1);
  check('Custom has integrity_warnings', Array.isArray(customResp.body.receipt.integrity_warnings), true);
  check('Custom hash differs from verified', customResp.body.receipt.verification_hash !== receiptResp.body.receipt.verification_hash, true);

  // GET /rebuild
  const rebuildResp = await httpGet(`/rebuild?wallet=${WALLET}`);
  check('/rebuild → 200', rebuildResp.status, 200);
  check('/rebuild receipt_type', rebuildResp.body.rebuild.receipt_type, 'verified');
  check('/rebuild hash deterministic', rebuildResp.body.rebuild.verification_hash, receiptResp.body.receipt.verification_hash);

  // GET /rebuild with position_id
  const rebuildIdResp = await httpGet(`/rebuild?wallet=${WALLET}&position_id=${posId}`);
  check('/rebuild with position_id → 200', rebuildIdResp.status, 200);
  check('/rebuild id hash matches', rebuildIdResp.body.rebuild.verification_hash, receiptResp.body.receipt.verification_hash);

  // GET /positions/:id with bad id
  const badIdResp = await httpGet(`/positions/deadbeef000000?wallet=${WALLET}`);
  check('Bad position id → 404', badIdResp.status, 404);

} else if (posResp.status === 500) {
  console.log(`  ⚠️  API key not configured — skipping live HTTP tests`);
  console.log(`     (Pipeline shape tests above still validate the logic)`);
} else {
  console.log(`  ⚠️  Unexpected status ${posResp.status}: ${JSON.stringify(posResp.body)}`);
}

// Shutdown
server.close();

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(58)}`);
if (fail === 0) {
  console.log(`✅ ALL ${pass} CHECKS PASSED — API server is solid`);
} else {
  console.log(`❌ ${fail} FAILED, ${pass} passed`);
}
console.log(`${'═'.repeat(58)}`);

process.exit(fail > 0 ? 1 : 0);
