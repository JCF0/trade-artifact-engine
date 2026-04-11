/**
 * Phase 1 — Position Builder
 *
 * Aggregates reconstructed cycles into position objects.
 * Positions are a DERIVED view — cycles remain canonical truth.
 *
 * This module does NOT modify reconstruct logic, WACB accounting,
 * or the verified receipt hash formula.
 */
import { createHash } from 'crypto';

// ═══════════════════════════════════════════════════════════════
// Position ID (deterministic)
// ═══════════════════════════════════════════════════════════════

/**
 * Compute a deterministic position ID.
 * sha256(wallet + token + from_ts + to_ts)
 *
 * @param {string} wallet
 * @param {string} token - Token mint address
 * @param {number} from_ts - Start timestamp (epoch seconds)
 * @param {number} to_ts - End timestamp (epoch seconds)
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function computePositionId(wallet, token, from_ts, to_ts) {
  const payload = `${wallet}${token}${from_ts}${to_ts}`;
  return createHash('sha256').update(payload).digest('hex');
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Deep-clone a cycle to prevent mutation of the original.
 * Uses JSON round-trip — sufficient for our data (no functions, dates, etc.)
 */
function cloneCycle(cycle) {
  return JSON.parse(JSON.stringify(cycle));
}

/**
 * Flatten all entry legs from a set of cycles into a single sorted array.
 * Each leg is annotated with its source cycle_id.
 */
function flattenEntries(cycles) {
  const entries = [];
  for (const c of cycles) {
    for (const tx of c.entry_txs) {
      entries.push({ ...tx, cycle_id: c.cycle_id, action: 'buy' });
    }
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Flatten all exit legs from a set of cycles into a single sorted array.
 */
function flattenExits(cycles) {
  const exits = [];
  for (const c of cycles) {
    for (const tx of c.exit_txs) {
      exits.push({ ...tx, cycle_id: c.cycle_id, action: 'sell' });
    }
  }
  return exits.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Merge entries and exits into a unified legs array, sorted chronologically.
 */
function mergeLegs(entries, exits) {
  return [...entries, ...exits].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Determine position status from constituent cycles.
 * - All closed → "closed"
 * - Any open → "open"
 * - Mix of closed + partial_history → "partial"
 */
function deriveStatus(cycles) {
  const statuses = new Set(cycles.map(c => c.status));
  if (statuses.size === 1 && statuses.has('closed')) return 'closed';
  if (statuses.has('open')) return 'open';
  return 'partial';
}

// ═══════════════════════════════════════════════════════════════
// buildPositions
// ═══════════════════════════════════════════════════════════════

/**
 * Build position objects from reconstructed cycles.
 *
 * Grouping: cycles are grouped by base_mint (token).
 * Filtering: optional token mint and/or timeframe.
 *
 * @param {object[]} cycles - Reconstructed cycles (from reconstructCycles)
 * @param {object} opts
 * @param {string} opts.wallet - Wallet address (REQUIRED)
 * @param {string} [opts.token] - Filter to a specific token mint
 * @param {number} [opts.from_ts] - Include cycles that overlap with this start time
 * @param {number} [opts.to_ts] - Include cycles that overlap with this end time
 * @returns {object[]} Position objects
 */
export function buildPositions(cycles, { wallet, token, from_ts, to_ts } = {}) {
  if (!wallet) throw new Error('position-builder: wallet is required');

  // ── Step 1: Filter (internal to position-builder) ──
  let filtered = cycles;

  if (token) {
    filtered = filtered.filter(c => c.base_mint === token);
  }

  if (from_ts != null) {
    // Include cycles whose last event is >= from_ts
    filtered = filtered.filter(c => {
      const lastTs = Math.max(
        ...[...c.entry_txs, ...c.exit_txs].map(t => t.timestamp)
      );
      return lastTs >= from_ts;
    });
  }

  if (to_ts != null) {
    // Include cycles whose first event is <= to_ts
    filtered = filtered.filter(c => {
      const firstTs = Math.min(
        ...[...c.entry_txs, ...c.exit_txs].map(t => t.timestamp)
      );
      return firstTs <= to_ts;
    });
  }

  // ── Step 2: Group by token (base_mint) ──
  const groups = new Map();
  for (const c of filtered) {
    const mint = c.base_mint;
    if (!groups.has(mint)) groups.set(mint, []);
    groups.get(mint).push(c);
  }

  // ── Step 3: Build position for each token group ──
  const positions = [];

  for (const [mint, groupCycles] of groups) {
    // Clone to prevent mutation of input cycles
    const cloned = groupCycles.map(cloneCycle);

    // Sort cycles by their earliest event
    cloned.sort((a, b) => {
      const aFirst = Math.min(...[...a.entry_txs, ...a.exit_txs].map(t => t.timestamp));
      const bFirst = Math.min(...[...b.entry_txs, ...b.exit_txs].map(t => t.timestamp));
      return aFirst - bFirst;
    });

    // Flatten legs
    const entries = flattenEntries(cloned);
    const exits = flattenExits(cloned);
    const legs = mergeLegs(entries, exits);

    // Aggregate metrics
    const totalBought = entries.reduce((s, t) => s + t.amount, 0);
    const totalSold = exits.reduce((s, t) => s + t.amount, 0);
    const costBasis = entries.reduce((s, t) => s + t.quote_amount, 0);
    const exitProceeds = exits.reduce((s, t) => s + t.quote_amount, 0);
    const avgEntry = totalBought > 0 ? costBasis / totalBought : 0;
    const avgExit = totalSold > 0 ? exitProceeds / totalSold : 0;
    const realizedPnl = exitProceeds - costBasis;
    const realizedPnlPct = costBasis > 0 ? (realizedPnl / costBasis) * 100 : 0;

    // Timing
    const allTimestamps = legs.map(l => l.timestamp);
    const startTime = Math.min(...allTimestamps);
    const endTime = Math.max(...allTimestamps);

    // Position boundaries — use filter params if provided, else derive from data
    const effectiveFrom = from_ts ?? startTime;
    const effectiveTo = to_ts ?? endTime;

    // Position ID
    const positionId = computePositionId(wallet, mint, effectiveFrom, effectiveTo);

    // Status
    const status = deriveStatus(cloned);

    positions.push({
      position_id: positionId,
      wallet,
      token: mint,
      from_ts: effectiveFrom,
      to_ts: effectiveTo,

      cycles: cloned.map(c => c.cycle_id),
      legs,
      entries,
      exits,

      avg_entry: parseFloat(avgEntry.toPrecision(12)),
      avg_exit: parseFloat(avgExit.toPrecision(12)),

      realized_pnl: parseFloat(realizedPnl.toPrecision(12)),
      realized_pnl_pct: parseFloat(realizedPnlPct.toPrecision(6)),

      total_bought: parseFloat(totalBought.toFixed(10)),
      total_sold: parseFloat(totalSold.toFixed(10)),

      start_time: startTime,
      end_time: endTime,
      duration_sec: endTime - startTime,

      num_cycles: cloned.length,
      num_buys: entries.length,
      num_sells: exits.length,

      status,
    });
  }

  // Sort positions by start_time
  positions.sort((a, b) => a.start_time - b.start_time);

  return positions;
}

// ═══════════════════════════════════════════════════════════════
// buildCustomPosition (scaffold)
// ═══════════════════════════════════════════════════════════════

/**
 * Create a custom position by removing specific legs.
 *
 * The returned position has:
 * - different metrics (recalculated without removed legs)
 * - a `removed_legs` field listing the tx hashes removed
 * - a `custom_position_id` derived from the base position + removed legs
 *
 * @param {object} position - A position object from buildPositions
 * @param {object} opts
 * @param {string[]} opts.removed_legs - Array of tx_hash values to remove
 * @returns {object} Custom position object
 */
export function buildCustomPosition(position, { removed_legs = [] } = {}) {
  if (!removed_legs || removed_legs.length === 0) {
    throw new Error('buildCustomPosition: removed_legs is required and must not be empty');
  }

  const removedSet = new Set(removed_legs);

  // Filter out removed legs
  const customEntries = position.entries.filter(e => !removedSet.has(e.tx_hash));
  const customExits = position.exits.filter(e => !removedSet.has(e.tx_hash));
  const customLegs = mergeLegs(customEntries, customExits);

  if (customEntries.length === 0 && customExits.length === 0) {
    throw new Error('buildCustomPosition: removing all legs is not allowed');
  }

  // Recompute metrics
  const totalBought = customEntries.reduce((s, t) => s + t.amount, 0);
  const totalSold = customExits.reduce((s, t) => s + t.amount, 0);
  const costBasis = customEntries.reduce((s, t) => s + t.quote_amount, 0);
  const exitProceeds = customExits.reduce((s, t) => s + t.quote_amount, 0);
  const avgEntry = totalBought > 0 ? costBasis / totalBought : 0;
  const avgExit = totalSold > 0 ? exitProceeds / totalSold : 0;
  const realizedPnl = exitProceeds - costBasis;
  const realizedPnlPct = costBasis > 0 ? (realizedPnl / costBasis) * 100 : 0;

  const allTimestamps = customLegs.map(l => l.timestamp);
  const startTime = allTimestamps.length > 0 ? Math.min(...allTimestamps) : position.start_time;
  const endTime = allTimestamps.length > 0 ? Math.max(...allTimestamps) : position.end_time;

  // Custom position ID = sha256(base_position_id + sorted removed_legs)
  const sortedRemoved = [...removed_legs].sort();
  const customIdPayload = `${position.position_id}${JSON.stringify(sortedRemoved)}`;
  const customPositionId = createHash('sha256').update(customIdPayload).digest('hex');

  return {
    position_id: customPositionId,
    base_position_id: position.position_id,
    wallet: position.wallet,
    token: position.token,
    from_ts: position.from_ts,
    to_ts: position.to_ts,

    cycles: position.cycles, // same source cycles
    legs: customLegs,
    entries: customEntries,
    exits: customExits,
    removed_legs: sortedRemoved,

    avg_entry: parseFloat(avgEntry.toPrecision(12)),
    avg_exit: parseFloat(avgExit.toPrecision(12)),

    realized_pnl: parseFloat(realizedPnl.toPrecision(12)),
    realized_pnl_pct: parseFloat(realizedPnlPct.toPrecision(6)),

    total_bought: parseFloat(totalBought.toFixed(10)),
    total_sold: parseFloat(totalSold.toFixed(10)),

    start_time: startTime,
    end_time: endTime,
    duration_sec: endTime - startTime,

    num_cycles: position.num_cycles,
    num_buys: customEntries.length,
    num_sells: customExits.length,

    status: 'custom',
    is_custom: true,
  };
}
