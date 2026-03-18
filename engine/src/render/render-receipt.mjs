/**
 * Phase 6 — Receipt Renderer
 *
 * Reads verified receipt JSON from data/receipts/receipts.jsonl
 * and renders each as a shareable PNG card in data/renders/.
 *
 * This renderer ONLY displays data already in the receipt.
 * It does not compute or alter any accounting fields.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createCanvas } from 'canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Known mints → human-readable symbols
// ---------------------------------------------------------------------------
const SYMBOLS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5': 'MEW',
};

function sym(mint) {
  return SYMBOLS[mint] || mint.slice(0, 8) + '...';
}

function shortWallet(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function shortHash(hash) {
  return hash.slice(0, 12) + '...';
}

function formatHoldTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hrs`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

function formatPrice(price, quoteSym) {
  if (price < 0.0001) return `${price.toExponential(4)} ${quoteSym}`;
  if (price < 1) return `${price.toFixed(6)} ${quoteSym}`;
  return `${price.toFixed(4)} ${quoteSym}`;
}

function formatPnl(pnl, quoteSym) {
  const sign = pnl >= 0 ? '+' : '';
  if (Math.abs(pnl) < 0.0001) return `${sign}${pnl.toExponential(3)} ${quoteSym}`;
  return `${sign}${pnl.toFixed(6)} ${quoteSym}`;
}

function formatDate(ts) {
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderReceipt(receipt) {
  const W = 800;
  const H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const tokenSym = sym(receipt.token_mint);
  const quoteSym = sym(receipt.quote_currency);
  const isProfit = receipt.realized_pnl >= 0;

  // --- Background ---
  // Dark card with subtle gradient
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0f1419');
  grad.addColorStop(1, '#1a1f2e');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, W, H, 16);
  ctx.fill();

  // Border
  ctx.strokeStyle = isProfit ? '#00c07640' : '#ff4d4d40';
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, W - 2, H - 2, 16);
  ctx.stroke();

  // --- Header ---
  let y = 40;

  // "TRADE RECEIPT" label
  ctx.fillStyle = '#8899a6';
  ctx.font = '600 13px "Segoe UI", Arial, sans-serif';
  ctx.letterSpacing = '2px';
  ctx.fillText('TRADE RECEIPT', 32, y);

  // Verified badge
  const statusText = `● ${receipt.status.toUpperCase()}`;
  ctx.fillStyle = '#00c076';
  ctx.font = '600 13px "Segoe UI", Arial, sans-serif';
  const statusWidth = ctx.measureText(statusText).width;
  ctx.fillText(statusText, W - 32 - statusWidth, y);

  // Token symbol - big
  y += 44;
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 36px "Segoe UI", Arial, sans-serif';
  ctx.fillText(`${tokenSym} / ${quoteSym}`, 32, y);

  // Chain + wallet
  y += 28;
  ctx.fillStyle = '#8899a6';
  ctx.font = '400 14px "Segoe UI", Arial, sans-serif';
  ctx.fillText(`${receipt.chain.toUpperCase()}  •  ${shortWallet(receipt.wallet)}`, 32, y);

  // --- Divider ---
  y += 20;
  ctx.strokeStyle = '#2a3040';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(32, y);
  ctx.lineTo(W - 32, y);
  ctx.stroke();

  // --- PnL hero ---
  y += 48;
  const pnlColor = isProfit ? '#00c076' : '#ff4d4d';
  const pnlSign = isProfit ? '+' : '';

  // PnL percentage - large
  ctx.fillStyle = pnlColor;
  ctx.font = '700 48px "Segoe UI", Arial, sans-serif';
  ctx.fillText(`${pnlSign}${receipt.realized_pnl_pct.toFixed(3)}%`, 32, y);

  // PnL absolute
  y += 30;
  ctx.fillStyle = pnlColor;
  ctx.font = '400 18px "Segoe UI", Arial, sans-serif';
  ctx.fillText(formatPnl(receipt.realized_pnl, quoteSym), 32, y);

  // --- Stats grid ---
  y += 44;
  const col1 = 32;
  const col2 = W / 2 + 16;
  const rowH = 52;

  drawStat(ctx, col1, y, 'Avg Entry Price', formatPrice(receipt.avg_entry_price, quoteSym));
  drawStat(ctx, col2, y, 'Avg Exit Price', formatPrice(receipt.avg_exit_price, quoteSym));

  y += rowH;
  drawStat(ctx, col1, y, 'Cost Basis', `${receipt.total_cost_basis.toFixed(6)} ${quoteSym}`);
  drawStat(ctx, col2, y, 'Exit Proceeds', `${receipt.total_exit_proceeds.toFixed(6)} ${quoteSym}`);

  y += rowH;
  drawStat(ctx, col1, y, 'Hold Time', formatHoldTime(receipt.hold_time_seconds));
  const buyLabel = receipt.num_buys === 1 ? 'buy' : 'buys';
  const sellLabel = receipt.num_sells === 1 ? 'sell' : 'sells';
  drawStat(ctx, col2, y, 'Trades', `${receipt.num_buys} ${buyLabel} / ${receipt.num_sells} ${sellLabel}`);

  // --- Footer ---
  y += rowH + 10;
  ctx.strokeStyle = '#2a3040';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(32, y);
  ctx.lineTo(W - 32, y);
  ctx.stroke();

  y += 24;
  ctx.fillStyle = '#556677';
  ctx.font = '400 12px "Consolas", "Courier New", monospace';
  ctx.fillText(`${receipt.receipt_id}  •  hash: ${shortHash(receipt.verification_hash)}`, 32, y);

  y += 18;
  ctx.fillText(`${formatDate(receipt.opened_at)} → ${formatDate(receipt.closed_at)}`, 32, y);

  return canvas.toBuffer('image/png');
}

function drawStat(ctx, x, y, label, value) {
  ctx.fillStyle = '#8899a6';
  ctx.font = '400 12px "Segoe UI", Arial, sans-serif';
  ctx.fillText(label, x, y);

  ctx.fillStyle = '#e1e8ed';
  ctx.font = '600 16px "Segoe UI", Arial, sans-serif';
  ctx.fillText(value, x, y + 20);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const receiptsPath = resolve(ROOT, 'data', 'receipts', 'receipts.jsonl');
const renderDir = resolve(ROOT, 'data', 'renders');

const lines = readFileSync(receiptsPath, 'utf-8').trim().split('\n');
const receipts = lines.map(l => JSON.parse(l));

console.log(`Loaded ${receipts.length} receipts`);

let rendered = 0;
for (const receipt of receipts) {
  const png = renderReceipt(receipt);
  const filename = `${receipt.receipt_id}.png`;
  const outPath = resolve(renderDir, filename);
  writeFileSync(outPath, png);
  console.log(`Rendered: ${filename} (${(png.length / 1024).toFixed(1)} KB)`);
  rendered++;
}

console.log(`\n=== Phase 6 — Receipt Renderer Report ===`);
console.log(`PNGs generated: ${rendered}`);
console.log(`Output dir:     ${renderDir}`);
