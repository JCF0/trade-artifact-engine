#!/usr/bin/env node
/**
 * Phase 1 — Position Builder Tests
 *
 * Tests against existing cached cycle data.
 * Verifies:
 *   1. Deterministic position IDs
 *   2. Correct aggregation math
 *   3. No mutation of input cycles
 *   4. Filtering (token, timeframe)
 *   5. Custom position scaffold
 *   6. Edge cases
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

import { normalizeTransactions } from '../pipeline/ingest.mjs';
import { reconstructCycles } from '../pipeline/reconstruct.mjs';
import { buildPositions, buildCustomPosition, computePositionId } from './position-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

let pass = 0, fail = 0;

function check(label, actual, expected) {
  const eq = typeof expected === 'number'
    ? Math.abs(actual - expected) < 1e-10
    : actual === expected;
  if (eq) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

function section(title) { console.log(`\n── ${title} ──`); }

// ── Load test data ──
const txns = readFileSync(resolve(ROOT, 'data/raw/helius_transactions.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const WALLET = 'FDh2oFVBYzmVrqVrNQNR8vRwVZhfRhW5w964HG8eypxP';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

const { events } = normalizeTransactions(txns, WALLET, { silent: true });
const { cycles } = reconstructCycles(events);

// Deep copy for mutation check
const cyclesSnapshot = JSON.stringify(cycles);

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Phase 1 — Position Builder Tests                       ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`\nTest data: ${cycles.length} cycles, wallet ${WALLET.slice(0, 12)}...`);

// ═══════════════════════════════════════════════════════════════
// Test 1: Basic buildPositions (no filters)
// ═══════════════════════════════════════════════════════════════
section('Test 1: Basic buildPositions (all cycles, no filters)');

const positions = buildPositions(cycles, { wallet: WALLET });

check('Position count', positions.length, 1); // both cycles are same token
const pos = positions[0];

check('Token', pos.token, JUP_MINT);
check('Wallet', pos.wallet, WALLET);
check('Num cycles', pos.num_cycles, 2);
check('Num buys', pos.num_buys, 2);
check('Num sells', pos.num_sells, 2);
check('Status', pos.status, 'closed');
check('Total bought', pos.total_bought, 14.29279);  // 11.646068 + 2.646722
check('Total sold', pos.total_sold, 14.29279);

// PnL: cost = 0.02 + 0.005 = 0.025, proceeds = 0.019990526 + 0.004996897 = 0.024987423
const expectedCost = 0.025;
const expectedProceeds = 0.024987423;
const expectedPnl = expectedProceeds - expectedCost;
check('Realized PnL close', Math.abs(pos.realized_pnl - expectedPnl) < 1e-10, true);

// Avg entry = 0.025 / 14.29279
const expectedAvgEntry = expectedCost / 14.29279;
check('Avg entry close', Math.abs(pos.avg_entry - expectedAvgEntry) < 1e-10, true);

check('Legs count', pos.legs.length, 4);  // 2 buys + 2 sells
check('Entries count', pos.entries.length, 2);
check('Exits count', pos.exits.length, 2);

// Timing
check('Start time', pos.start_time, 1774400456);
check('End time', pos.end_time, 1774953919);
check('Duration', pos.duration_sec, 1774953919 - 1774400456);

// ═══════════════════════════════════════════════════════════════
// Test 2: Deterministic position ID
// ═══════════════════════════════════════════════════════════════
section('Test 2: Deterministic position ID');

const expectedId = computePositionId(WALLET, JUP_MINT, pos.from_ts, pos.to_ts);
check('position_id matches compute', pos.position_id, expectedId);

// Run twice — should produce identical ID
const positions2 = buildPositions(cycles, { wallet: WALLET });
check('Deterministic (run twice)', positions2[0].position_id, pos.position_id);

// Manual hash check
const manualHash = createHash('sha256')
  .update(`${WALLET}${JUP_MINT}${pos.from_ts}${pos.to_ts}`)
  .digest('hex');
check('Manual hash matches', pos.position_id, manualHash);

// ═══════════════════════════════════════════════════════════════
// Test 3: No mutation of input cycles
// ═══════════════════════════════════════════════════════════════
section('Test 3: No mutation of input cycles');

check('Cycles unchanged after buildPositions', JSON.stringify(cycles), cyclesSnapshot);

// ═══════════════════════════════════════════════════════════════
// Test 4: Token filter
// ═══════════════════════════════════════════════════════════════
section('Test 4: Token filter');

const jupPositions = buildPositions(cycles, { wallet: WALLET, token: JUP_MINT });
check('JUP filter returns 1 position', jupPositions.length, 1);

const fakePositions = buildPositions(cycles, { wallet: WALLET, token: 'FakeTokenMintAddress111111111111111111111111' });
check('Fake token filter returns 0', fakePositions.length, 0);

// ═══════════════════════════════════════════════════════════════
// Test 5: Timeframe filter
// ═══════════════════════════════════════════════════════════════
section('Test 5: Timeframe filter');

// Only the first cycle (timestamp ~1774400456–1774400490)
const earlyPositions = buildPositions(cycles, {
  wallet: WALLET,
  from_ts: 1774400000,
  to_ts: 1774400500,
});
check('Early window returns 1 position', earlyPositions.length, 1);
check('Early window has 1 cycle', earlyPositions[0].num_cycles, 1);
check('Early window from_ts uses filter', earlyPositions[0].from_ts, 1774400000);

// Only the second cycle (timestamp ~1774953880–1774953919)
const latePositions = buildPositions(cycles, {
  wallet: WALLET,
  from_ts: 1774953800,
  to_ts: 1774954000,
});
check('Late window returns 1 position', latePositions.length, 1);
check('Late window has 1 cycle', latePositions[0].num_cycles, 1);

// Window that captures neither
const emptyPositions = buildPositions(cycles, {
  wallet: WALLET,
  from_ts: 1774500000,
  to_ts: 1774900000,
});
check('Gap window returns 0', emptyPositions.length, 0);

// ═══════════════════════════════════════════════════════════════
// Test 6: Custom position scaffold
// ═══════════════════════════════════════════════════════════════
section('Test 6: buildCustomPosition');

// Remove the first entry leg
const firstEntryHash = pos.entries[0].tx_hash;
const custom = buildCustomPosition(pos, { removed_legs: [firstEntryHash] });

check('Custom status', custom.status, 'custom');
check('Custom is_custom', custom.is_custom, true);
check('Custom has base_position_id', custom.base_position_id, pos.position_id);
check('Custom position_id differs', custom.position_id !== pos.position_id, true);
check('Custom removed_legs', custom.removed_legs.length, 1);
check('Custom removed_legs[0]', custom.removed_legs[0], firstEntryHash);
check('Custom entries count', custom.entries.length, 1);  // removed 1 of 2
check('Custom exits count', custom.exits.length, 2);      // unchanged
check('Custom legs count', custom.legs.length, 3);         // 1 entry + 2 exits

// Custom PnL should be different
check('Custom PnL differs', custom.realized_pnl !== pos.realized_pnl, true);

// Custom position ID is deterministic
const custom2 = buildCustomPosition(pos, { removed_legs: [firstEntryHash] });
check('Custom ID deterministic', custom2.position_id, custom.position_id);

// ═══════════════════════════════════════════════════════════════
// Test 7: Edge cases
// ═══════════════════════════════════════════════════════════════
section('Test 7: Edge cases');

// Missing wallet should throw
let threw = false;
try { buildPositions(cycles, {}); } catch (e) { threw = true; }
check('Missing wallet throws', threw, true);

// Empty cycles
const emptyPos = buildPositions([], { wallet: WALLET });
check('Empty cycles returns []', emptyPos.length, 0);

// buildCustomPosition with no removed_legs should throw
threw = false;
try { buildCustomPosition(pos, { removed_legs: [] }); } catch (e) { threw = true; }
check('Empty removed_legs throws', threw, true);

// Removing ALL legs should throw
const allHashes = pos.legs.map(l => l.tx_hash);
threw = false;
try { buildCustomPosition(pos, { removed_legs: allHashes }); } catch (e) { threw = true; }
check('Removing all legs throws', threw, true);

// ═══════════════════════════════════════════════════════════════
// Output: Example positions
// ═══════════════════════════════════════════════════════════════
section('Example Position Objects');

console.log('\n  === Full Position (2 cycles aggregated) ===');
const display = { ...pos };
// Truncate legs/entries/exits for readability
display.legs = `[${pos.legs.length} legs]`;
display.entries = `[${pos.entries.length} entries]`;
display.exits = `[${pos.exits.length} exits]`;
console.log(JSON.stringify(display, null, 2));

console.log('\n  === Single-Cycle Position (early window) ===');
const earlyDisplay = { ...earlyPositions[0] };
earlyDisplay.legs = `[${earlyPositions[0].legs.length} legs]`;
earlyDisplay.entries = `[${earlyPositions[0].entries.length} entries]`;
earlyDisplay.exits = `[${earlyPositions[0].exits.length} exits]`;
console.log(JSON.stringify(earlyDisplay, null, 2));

console.log('\n  === Custom Position (1 entry removed) ===');
const customDisplay = { ...custom };
customDisplay.legs = `[${custom.legs.length} legs]`;
customDisplay.entries = `[${custom.entries.length} entries]`;
customDisplay.exits = `[${custom.exits.length} exits]`;
console.log(JSON.stringify(customDisplay, null, 2));

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(58)}`);
if (fail === 0) {
  console.log(`✅ ALL ${pass} CHECKS PASSED — position-builder is solid`);
} else {
  console.log(`❌ ${fail} FAILED, ${pass} passed`);
}
console.log(`${'═'.repeat(58)}`);

process.exit(fail > 0 ? 1 : 0);
