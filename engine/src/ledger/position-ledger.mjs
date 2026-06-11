/**
 * Position Ledger — Slice 1A
 *
 * Pure accounting layer: normalized wallet events → token-level position state.
 *
 * Sits between the normalizer and receipt generators.
 * Does NOT mint NFTs, upload metadata, render images, or touch proof wallets.
 *
 * Accounting method: weighted_average_position_accounting_v1 (WACB)
 *
 * All monetary fields use raw quote amounts (SOL/USDC/USDT) — not USD.
 * Field suffix: _quote. USD normalization is deferred to a later slice.
 * valuation_status: 'raw_quote'
 */

import { QUOTE_MINTS, SYMS, DUST_ABS, DUST_PCT } from '../pipeline/constants.mjs';
import { roundPrice, roundQty, roundPct } from './precision.mjs';

const ACCOUNTING_VERSION = 'weighted_average_position_accounting_v1';

// ═══════════════════════════════════════════════════════════════
// classifyEvent
// ═══════════════════════════════════════════════════════════════

/**
 * Classify a normalized event as buy, sell, or skip.
 * Same logic as pipeline/reconstruct.mjs — extracted for reuse.
 *
 * @param {object} event - Normalized event from the pipeline
 * @returns {{ action: 'buy'|'sell'|null, baseMint?: string, quoteMint?: string, baseAmt?: number, quoteAmt?: number }}
 */
export function classifyEvent(event) {
  const inIsQuote = QUOTE_MINTS.has(event.token_in_mint);
  const outIsQuote = QUOTE_MINTS.has(event.token_out_mint);

  if (inIsQuote && !outIsQuote) {
    return {
      action: 'buy',
      baseMint: event.token_out_mint,
      quoteMint: event.token_in_mint,
      baseAmt: event.token_out_amount,
      quoteAmt: event.token_in_amount,
    };
  }
  if (!inIsQuote && outIsQuote) {
    return {
      action: 'sell',
      baseMint: event.token_in_mint,
      quoteMint: event.token_out_mint,
      baseAmt: event.token_in_amount,
      quoteAmt: event.token_out_amount,
    };
  }
  return { action: null };
}

// ═══════════════════════════════════════════════════════════════
// initPositionState
// ═══════════════════════════════════════════════════════════════

/**
 * Create a fresh position state for a token mint.
 *
 * @param {string} tokenMint
 * @param {object} [opts]
 * @param {number} [opts.segmentIndex=0]
 * @returns {object} Mutable internal PositionState
 */
export function initPositionState(tokenMint, opts = {}) {
  return {
    token_mint: tokenMint,
    segment_index: opts.segmentIndex ?? 0,

    // Buy side
    total_bought_qty: 0,
    total_bought_quote: 0,
    avg_buy_quote_price: 0,

    // Sell side (accounted only)
    total_sold_qty: 0,
    total_sold_quote: 0,
    avg_sell_quote_price: 0,

    // Cost basis accounting
    allocated_cost_basis_quote: 0,
    remaining_qty: 0,
    remaining_cost_basis_quote: 0,

    // PnL
    realized_pnl_quote: 0,

    // Status
    status: 'open',
    _flags: new Set(),

    // Diagnostic (negative inventory)
    unaccounted_sold_qty: 0,
    unaccounted_sold_quote: 0,

    // Event log
    events: [],
    first_event_at: null,
    last_event_at: null,

    // Internal tracking (stripped during finalize)
    _peak_qty: 0,
    _quote_mints_seen: new Set(),

    accounting_method_version: ACCOUNTING_VERSION,
  };
}

// ═══════════════════════════════════════════════════════════════
// processLedgerEvent
// ═══════════════════════════════════════════════════════════════

/**
 * Process a single classified event against a position state.
 *
 * Mutates `state` in place (owned by buildPositionLedger).
 * The public API (buildPositionLedger) is pure — it creates the state objects.
 *
 * @param {object} state - Internal PositionState (from initPositionState)
 * @param {object} classified - From classifyEvent: { action, baseMint, quoteMint, baseAmt, quoteAmt }
 * @param {object} rawEvent - Original normalized event (for tx_hash, timestamp, raw_index)
 * @returns {{ state: object, closed: boolean }}
 */
export function processLedgerEvent(state, classified, rawEvent) {
  const { action, quoteMint, baseAmt, quoteAmt } = classified;

  // Track quote mints seen
  state._quote_mints_seen.add(quoteMint);

  // Update timestamps
  if (state.first_event_at === null) state.first_event_at = rawEvent.timestamp;
  state.last_event_at = rawEvent.timestamp;

  let ledgerEvent;

  if (action === 'buy') {
    ledgerEvent = _processBuy(state, baseAmt, quoteAmt, quoteMint, rawEvent);
  } else {
    ledgerEvent = _processSell(state, baseAmt, quoteAmt, quoteMint, rawEvent);
  }

  state.events.push(ledgerEvent);

  // ── Dust close check ──
  // Only close if we observed at least one buy (total_bought_qty > 0).
  // partial_history positions CAN close — status stays partial_history.
  let closed = false;
  if (action === 'sell' && state.remaining_qty >= 0 && state.total_bought_qty > 0) {
    const threshold = Math.max(DUST_ABS, DUST_PCT * state._peak_qty);
    if (state.remaining_qty < threshold) {
      if (state.status === 'open') {
        state.status = 'closed';
      }
      // partial_history stays partial_history
      state._flags.add('dust_closed');
      closed = true;
    }
  }

  return { state, closed };
}

// ── Buy handler ──

function _processBuy(state, baseAmt, quoteAmt, quoteMint, rawEvent) {
  state.total_bought_qty += baseAmt;
  state.total_bought_quote += quoteAmt;
  state.remaining_qty += baseAmt;
  state.remaining_cost_basis_quote += quoteAmt;

  // Recompute avg buy price (WACB: total remaining cost / total remaining qty)
  state.avg_buy_quote_price = state.remaining_qty > 0
    ? state.remaining_cost_basis_quote / state.remaining_qty
    : 0;

  // Track peak for dust threshold
  if (state.remaining_qty > state._peak_qty) {
    state._peak_qty = state.remaining_qty;
  }

  return {
    tx_hash: rawEvent.tx_hash,
    timestamp: rawEvent.timestamp,
    raw_index: rawEvent.raw_index,
    action: 'buy',
    base_qty: baseAmt,
    quote_amount: quoteAmt,
    quote_mint: quoteMint,
    avg_buy_quote_price_after: state.avg_buy_quote_price,
    remaining_qty_after: state.remaining_qty,
    remaining_cost_basis_quote_after: state.remaining_cost_basis_quote,
    cost_basis_allocated: null,
    realized_pnl_event: null,
    accounted_qty: null,
    unaccounted_qty: null,
  };
}

// ── Sell handler ──

function _processSell(state, baseAmt, quoteAmt, quoteMint, rawEvent) {
  // Case 1: No observed inventory at all
  if (state.remaining_qty <= 0) {
    return _processSellNoInventory(state, baseAmt, quoteAmt, quoteMint, rawEvent);
  }

  // Case 2: Sell exceeds observed remaining
  if (baseAmt > state.remaining_qty) {
    return _processSellExceedsRemaining(state, baseAmt, quoteAmt, quoteMint, rawEvent);
  }

  // Case 3: Normal sell — fully accounted
  return _processSellNormal(state, baseAmt, quoteAmt, quoteMint, rawEvent);
}

function _processSellNoInventory(state, baseAmt, quoteAmt, quoteMint, rawEvent) {
  // Entire sell is unaccounted — no cost basis to allocate against
  state.unaccounted_sold_qty += baseAmt;
  state.unaccounted_sold_quote += quoteAmt;
  state.status = 'partial_history';
  state._flags.add('partial_history');
  state._flags.add('external_transfer_possible');
  state._flags.add('negative_inventory');
  state._flags.add('unsupported_inventory');

  return {
    tx_hash: rawEvent.tx_hash,
    timestamp: rawEvent.timestamp,
    raw_index: rawEvent.raw_index,
    action: 'sell',
    base_qty: baseAmt,
    quote_amount: quoteAmt,
    quote_mint: quoteMint,
    avg_buy_quote_price_after: state.avg_buy_quote_price,
    remaining_qty_after: 0,
    remaining_cost_basis_quote_after: 0,
    cost_basis_allocated: 0,
    realized_pnl_event: 0,
    accounted_qty: 0,
    unaccounted_qty: baseAmt,
  };
}

function _processSellExceedsRemaining(state, baseAmt, quoteAmt, quoteMint, rawEvent) {
  const accountedQty = state.remaining_qty;
  const excessQty = baseAmt - accountedQty;
  const accountedFraction = accountedQty / baseAmt;
  const excessFraction = excessQty / baseAmt;

  const costAllocated = state.avg_buy_quote_price * accountedQty;
  const proceedsAccounted = quoteAmt * accountedFraction;
  const proceedsExcess = quoteAmt * excessFraction;
  const realizedPnlEvent = proceedsAccounted - costAllocated;

  state.allocated_cost_basis_quote += costAllocated;
  state.realized_pnl_quote += realizedPnlEvent;
  state.total_sold_qty += accountedQty;
  state.total_sold_quote += proceedsAccounted;
  state.unaccounted_sold_qty += excessQty;
  state.unaccounted_sold_quote += proceedsExcess;
  state.remaining_qty = 0;
  state.remaining_cost_basis_quote = 0;

  state.avg_sell_quote_price = state.total_sold_qty > 0
    ? state.total_sold_quote / state.total_sold_qty
    : 0;

  state.status = 'partial_history';
  state._flags.add('partial_history');
  state._flags.add('external_transfer_possible');
  state._flags.add('negative_inventory');
  state._flags.add('unsupported_inventory');

  return {
    tx_hash: rawEvent.tx_hash,
    timestamp: rawEvent.timestamp,
    raw_index: rawEvent.raw_index,
    action: 'sell',
    base_qty: baseAmt,
    quote_amount: quoteAmt,
    quote_mint: quoteMint,
    avg_buy_quote_price_after: 0,
    remaining_qty_after: 0,
    remaining_cost_basis_quote_after: 0,
    cost_basis_allocated: costAllocated,
    realized_pnl_event: realizedPnlEvent,
    accounted_qty: accountedQty,
    unaccounted_qty: excessQty,
  };
}

function _processSellNormal(state, baseAmt, quoteAmt, quoteMint, rawEvent) {
  const costAllocated = state.avg_buy_quote_price * baseAmt;
  const realizedPnlEvent = quoteAmt - costAllocated;

  state.allocated_cost_basis_quote += costAllocated;
  state.realized_pnl_quote += realizedPnlEvent;
  state.total_sold_qty += baseAmt;
  state.total_sold_quote += quoteAmt;
  state.remaining_qty -= baseAmt;
  state.remaining_cost_basis_quote -= costAllocated;

  // avg_buy_quote_price is unchanged after a sell (WACB property).
  // remaining_cost_basis / remaining_qty should still equal avg_buy,
  // but we don't recompute to avoid floating-point drift.
  // Rounding in finalizePositionState handles any micro-drift.

  state.avg_sell_quote_price = state.total_sold_qty > 0
    ? state.total_sold_quote / state.total_sold_qty
    : 0;

  return {
    tx_hash: rawEvent.tx_hash,
    timestamp: rawEvent.timestamp,
    raw_index: rawEvent.raw_index,
    action: 'sell',
    base_qty: baseAmt,
    quote_amount: quoteAmt,
    quote_mint: quoteMint,
    avg_buy_quote_price_after: state.avg_buy_quote_price,
    remaining_qty_after: state.remaining_qty,
    remaining_cost_basis_quote_after: state.remaining_cost_basis_quote,
    cost_basis_allocated: costAllocated,
    realized_pnl_event: realizedPnlEvent,
    accounted_qty: baseAmt,
    unaccounted_qty: 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// finalizePositionState
// ═══════════════════════════════════════════════════════════════

/**
 * Finalize a position state for output.
 * Rounds all numeric fields, converts internal Sets to sorted arrays,
 * computes derived fields, strips internal-only properties.
 *
 * @param {object} state - Internal PositionState
 * @returns {object} JSON-serializable finalized PositionState
 */
export function finalizePositionState(state) {
  // ── Quote context ──
  const quoteMints = [...state._quote_mints_seen];
  let quote_mint, quote_symbol;
  if (quoteMints.length === 1) {
    quote_mint = quoteMints[0];
    quote_symbol = SYMS[quote_mint] || quote_mint.slice(0, 8);
  } else if (quoteMints.length > 1) {
    quote_mint = 'MIXED';
    quote_symbol = 'MIXED';
    state._flags.add('mixed_quote');
  } else {
    // No events processed (shouldn't happen, but safe)
    quote_mint = null;
    quote_symbol = null;
  }

  // ── Derived PnL fields ──
  const realized_pnl_pct = state.allocated_cost_basis_quote > 0
    ? (state.realized_pnl_quote / state.allocated_cost_basis_quote) * 100
    : 0;

  const isClosed = state.status === 'closed';
  const total_pnl_quote = isClosed ? state.realized_pnl_quote : null;
  const total_pnl_pct = isClosed ? realized_pnl_pct : null;

  // ── Flags: sorted array for JSON determinism ──
  const flags = [...state._flags].sort();

  // ── Round LedgerEvents ──
  const events = state.events.map(e => ({
    tx_hash: e.tx_hash,
    timestamp: e.timestamp,
    raw_index: e.raw_index,
    action: e.action,
    base_qty: roundQty(e.base_qty),
    quote_amount: roundPrice(e.quote_amount),
    quote_mint: e.quote_mint,
    avg_buy_quote_price_after: roundPrice(e.avg_buy_quote_price_after),
    remaining_qty_after: roundQty(e.remaining_qty_after),
    remaining_cost_basis_quote_after: roundPrice(e.remaining_cost_basis_quote_after),
    cost_basis_allocated: e.cost_basis_allocated !== null ? roundPrice(e.cost_basis_allocated) : null,
    realized_pnl_event: e.realized_pnl_event !== null ? roundPrice(e.realized_pnl_event) : null,
    accounted_qty: e.accounted_qty !== null ? roundQty(e.accounted_qty) : null,
    unaccounted_qty: e.unaccounted_qty !== null ? roundQty(e.unaccounted_qty) : null,
  }));

  return {
    token_mint: state.token_mint,
    segment_index: state.segment_index,

    quote_mint,
    quote_symbol,
    valuation_status: 'raw_quote',

    total_bought_qty: roundQty(state.total_bought_qty),
    total_bought_quote: roundPrice(state.total_bought_quote),
    avg_buy_quote_price: roundPrice(state.avg_buy_quote_price),

    total_sold_qty: roundQty(state.total_sold_qty),
    total_sold_quote: roundPrice(state.total_sold_quote),
    avg_sell_quote_price: roundPrice(state.avg_sell_quote_price),

    allocated_cost_basis_quote: roundPrice(state.allocated_cost_basis_quote),
    remaining_qty: roundQty(state.remaining_qty),
    remaining_cost_basis_quote: roundPrice(state.remaining_cost_basis_quote),

    realized_pnl_quote: roundPrice(state.realized_pnl_quote),
    realized_pnl_pct: roundPct(realized_pnl_pct),
    unrealized_pnl_quote: null,
    unrealized_pnl_pct: null,
    total_pnl_quote: total_pnl_quote !== null ? roundPrice(total_pnl_quote) : null,
    total_pnl_pct: total_pnl_pct !== null ? roundPct(total_pnl_pct) : null,

    status: state.status,
    flags,

    unaccounted_sold_qty: roundQty(state.unaccounted_sold_qty),
    unaccounted_sold_quote: roundPrice(state.unaccounted_sold_quote),

    events,
    first_event_at: state.first_event_at,
    last_event_at: state.last_event_at,

    accounting_method_version: state.accounting_method_version,
  };
}

// ═══════════════════════════════════════════════════════════════
// buildPositionLedger
// ═══════════════════════════════════════════════════════════════

/**
 * Build the full position ledger from sorted normalized events.
 *
 * Pure function: does not mutate inputs, does not perform I/O.
 *
 * @param {object[]} events - Normalized events (from pipeline normalizeTransactions)
 * @param {object} [opts]
 * @param {string} [opts.accountingMethodVersion]
 * @returns {{
 *   positionsByMint: Map<string, object>,
 *   closedSegments: object[],
 *   accountingMethodVersion: string,
 *   eventCount: number,
 *   processedCount: number,
 *   skippedCount: number,
 * }}
 */
export function buildPositionLedger(events, opts = {}) {
  const accountingMethodVersion = opts.accountingMethodVersion || ACCOUNTING_VERSION;

  const activePositions = new Map();   // mint → internal state
  const closedSegments = [];
  const segmentCounters = new Map();   // mint → next segment index

  let processedCount = 0;
  let skippedCount = 0;

  for (const event of events) {
    const classified = classifyEvent(event);
    if (classified.action === null) {
      skippedCount++;
      continue;
    }

    processedCount++;
    const mint = classified.baseMint;

    // Get or create position state for this mint
    if (!activePositions.has(mint)) {
      const segIdx = segmentCounters.get(mint) || 0;
      const state = initPositionState(mint, { segmentIndex: segIdx });

      // If first event for this mint is a sell, mark partial_history upfront
      if (classified.action === 'sell') {
        state.status = 'partial_history';
        state._flags.add('partial_history');
        state._flags.add('external_transfer_possible');
      }

      activePositions.set(mint, state);
    }

    const state = activePositions.get(mint);
    const { closed } = processLedgerEvent(state, classified, event);

    if (closed) {
      closedSegments.push(finalizePositionState(state));
      activePositions.delete(mint);
      segmentCounters.set(mint, (segmentCounters.get(mint) || 0) + 1);
    }
  }

  // Finalize remaining active positions
  const positionsByMint = new Map();
  for (const [mint, state] of activePositions) {
    positionsByMint.set(mint, finalizePositionState(state));
  }

  return {
    positionsByMint,
    closedSegments,
    accountingMethodVersion,
    eventCount: events.length,
    processedCount,
    skippedCount,
  };
}

// ═══════════════════════════════════════════════════════════════
// serializeLedger
// ═══════════════════════════════════════════════════════════════

/**
 * Convert buildPositionLedger output to a plain JSON-serializable object.
 * Converts the positionsByMint Map to a plain object keyed by mint address.
 *
 * @param {object} ledgerResult - Return value of buildPositionLedger
 * @returns {object} JSON-serializable ledger
 */
export function serializeLedger(ledgerResult) {
  return {
    positions: Object.fromEntries(ledgerResult.positionsByMint),
    closedSegments: ledgerResult.closedSegments,
    accountingMethodVersion: ledgerResult.accountingMethodVersion,
    eventCount: ledgerResult.eventCount,
    processedCount: ledgerResult.processedCount,
    skippedCount: ledgerResult.skippedCount,
  };
}
