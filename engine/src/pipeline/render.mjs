/**
 * Pipeline — Receipt Renderer
 * Extracted from mint-one.mjs v1 (Phase 0.5).
 *
 * Renders a receipt as a PNG image.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { createCanvas } from 'canvas';
import { SYMS } from './constants.mjs';

/**
 * Render a receipt to PNG.
 * @param {object} receipt - Receipt object
 * @param {string} outputPath - Full path for the PNG file
 * @returns {string} The outputPath
 */
export function renderReceipt(receipt, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });

  const r = receipt;
  const W = 800, H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const isProfit = r.realized_pnl >= 0;
  const accent = isProfit ? '#00c853' : '#ff1744';

  // Background
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1a1a2e'); grad.addColorStop(1, '#16213e');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

  // Accent bar
  ctx.fillStyle = accent; ctx.fillRect(0, 0, W, 4);

  // Title
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 22px monospace';
  const tokenShort = r.token_mint.slice(0, 8);
  const qSym = SYMS[r.quote_currency] || (r.quote_currency === 'MIXED' ? 'MIXED' : r.quote_currency?.slice(0, 8));
  ctx.fillText(`${tokenShort} / ${qSym}`, 30, 45);

  // PnL
  ctx.fillStyle = accent; ctx.font = 'bold 48px monospace';
  ctx.fillText(`${isProfit ? '+' : ''}${r.realized_pnl_pct.toFixed(2)}%`, 30, 110);

  // Details
  ctx.fillStyle = '#aaaaaa'; ctx.font = '16px monospace';
  const lines = [
    `PnL: ${r.realized_pnl >= 0 ? '+' : ''}${r.realized_pnl.toPrecision(6)} ${qSym}`,
    `Entry: ${r.avg_entry_price.toPrecision(6)} | Exit: ${r.avg_exit_price.toPrecision(6)}`,
    `Cost: ${r.total_cost_basis.toPrecision(6)} | Proceeds: ${r.total_exit_proceeds.toPrecision(6)}`,
    `Trades: ${r.num_buys}B / ${r.num_sells}S | Hold: ${(r.hold_time_seconds / 3600).toFixed(1)}h`,
    `Status: ${r.status}`,
    ``,
    `Receipt: ${r.receipt_id}`,
    `Hash: ${r.verification_hash.slice(0, 32)}...`,
    `Wallet: ${r.wallet.slice(0, 20)}...`,
    `Opened: ${new Date(r.opened_at * 1000).toISOString().slice(0, 19)}Z`,
    `Closed: ${new Date(r.closed_at * 1000).toISOString().slice(0, 19)}Z`,
  ];
  let y = 160;
  for (const line of lines) { ctx.fillText(line, 30, y); y += 28; }

  // Footer
  ctx.fillStyle = '#555555'; ctx.font = '12px monospace';
  ctx.fillText('Trade Artifact Engine v1.0 — verified on-chain receipt', 30, H - 20);

  writeFileSync(outputPath, canvas.toBuffer('image/png'));
  return outputPath;
}
