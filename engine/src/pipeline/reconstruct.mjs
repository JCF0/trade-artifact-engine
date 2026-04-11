/**
 * Pipeline — Cycle Reconstruction
 * Extracted from mint-one.mjs v1 (Phase 0.5).
 *
 * Detects buy → accumulate → sell cycles from normalized swap events.
 * Logic is identical to the inline implementation in mint-one.mjs.
 *
 * @param {object[]} events - Normalized swap events (sorted chronologically)
 * @param {string} wallet - Wallet address (for context, not used in logic)
 * @returns {{ cycles: object[], stats: { total, closed, open, partial } }}
 */
import { QUOTE_MINTS, DUST_ABS, DUST_PCT } from './constants.mjs';

export function reconstructCycles(events) {
  const activeCycles = new Map();
  const allCycles = [];
  let cycleCounter = 0;

  for (const ev of events) {
    const inIsQuote = QUOTE_MINTS.has(ev.token_in_mint);
    const outIsQuote = QUOTE_MINTS.has(ev.token_out_mint);

    let action, baseMint, baseAmt, quoteMint, quoteAmt;
    if (inIsQuote && !outIsQuote) {
      action = 'buy'; baseMint = ev.token_out_mint; baseAmt = ev.token_out_amount;
      quoteMint = ev.token_in_mint; quoteAmt = ev.token_in_amount;
    } else if (!inIsQuote && outIsQuote) {
      action = 'sell'; baseMint = ev.token_in_mint; baseAmt = ev.token_in_amount;
      quoteMint = ev.token_out_mint; quoteAmt = ev.token_out_amount;
    } else {
      continue;
    }

    let cycle = activeCycles.get(baseMint);
    if (!cycle && action === 'sell') {
      cycleCounter++;
      cycle = {
        cycle_id: `cycle_${cycleCounter}_${baseMint.slice(0, 8)}`,
        base_mint: baseMint, status: 'partial_history',
        entry_txs: [], exit_txs: [],
        running_balance: 0, peak_position: 0, quote_mints: new Set(),
      };
      activeCycles.set(baseMint, cycle);
    }
    if (!cycle && action === 'buy') {
      cycleCounter++;
      cycle = {
        cycle_id: `cycle_${cycleCounter}_${baseMint.slice(0, 8)}`,
        base_mint: baseMint, status: 'open',
        entry_txs: [], exit_txs: [],
        running_balance: 0, peak_position: 0, quote_mints: new Set(),
      };
      activeCycles.set(baseMint, cycle);
    }
    if (!cycle) continue;

    const txEntry = {
      tx_hash: ev.tx_hash, timestamp: ev.timestamp,
      amount: baseAmt, quote_amount: quoteAmt, quote_mint: quoteMint,
    };
    cycle.quote_mints.add(quoteMint);

    if (action === 'buy') {
      cycle.entry_txs.push(txEntry);
      cycle.running_balance += baseAmt;
      if (cycle.running_balance > cycle.peak_position) cycle.peak_position = cycle.running_balance;
    } else {
      cycle.exit_txs.push(txEntry);
      cycle.running_balance -= baseAmt;
    }

    const threshold = Math.max(DUST_ABS, DUST_PCT * cycle.peak_position);
    if (action === 'sell' && cycle.status !== 'partial_history' && Math.abs(cycle.running_balance) < threshold && cycle.entry_txs.length > 0) {
      cycle.status = 'closed';
      allCycles.push({ ...cycle, quote_mints: [...cycle.quote_mints] });
      activeCycles.delete(baseMint);
    }
    if (cycle.running_balance < 0 && cycle.status !== 'partial_history') {
      cycle.status = 'partial_history';
    }
  }

  for (const [, cycle] of activeCycles) {
    allCycles.push({ ...cycle, quote_mints: [...cycle.quote_mints] });
  }

  const closed = allCycles.filter(c => c.status === 'closed');
  const open = allCycles.filter(c => c.status === 'open');
  const partial = allCycles.filter(c => c.status === 'partial_history');

  return {
    cycles: allCycles,
    stats: { total: allCycles.length, closed: closed.length, open: open.length, partial: partial.length },
  };
}
