#!/usr/bin/env node
/**
 * Phase 2 — Receipt Generator v1.1 Tests
 *
 * Verifies:
 *   1. Verified receipts remain byte-identical to v1
 *   2. Position-based verified receipts work
 *   3. Custom receipts hash differently from verified
 *   4. Custom receipts include integrity warnings
 *   5. Status byte mapping
 *   6. Mixed-quote mapping
 *   7. Example outputs
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { normalizeTransactions } from './ingest.mjs';
import { reconstructCycles } from './reconstruct.mjs';
import {
  buildReceipts, buildPositionReceipt, buildCustomReceipt,
  computeVerificationHash, computeCustomHash,
  STATUS_BYTE, statusToByte,
} from './receipt.mjs';
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

// ── Load test data ──
const txns = readFileSync(resolve(ROOT, 'data/raw/helius_transactions.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const WALLET = 'FDh2oFVBYzmVrqVrNQNR8vRwVZhfRhW5w964HG8eypxP';

const { events } = normalizeTransactions(txns, WALLET, { silent: true });
const { cycles } = reconstructCycles(events);
const closed = cycles.filter(c => c.status === 'closed');

const EXPECTED_HASHES = [
  '582cc281a9edadf08b9519f5f8373359bd24c9a4047e50be0bd78927df6bac0e',
  'c6d45f7eb7a6b429e59480a280c513c52c3f9413844bee2d393e670934ec1f49',
];

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Phase 2 — Receipt Generator v1.1 Tests                 ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ═══════════════════════════════════════════════════════════════
// Test 1: Verified cycle-based receipts (v1 regression)
// ═══════════════════════════════════════════════════════════════
section('Test 1: Verified path regression (cycle-based)');

const verifiedReceipts = buildReceipts(closed, WALLET);
check('Receipt count', verifiedReceipts.length, 2);
check('Receipt 1 hash', verifiedReceipts[0].verification_hash, EXPECTED_HASHES[0]);
check('Receipt 2 hash', verifiedReceipts[1].verification_hash, EXPECTED_HASHES[1]);
check('Receipt 1 receipt_type', verifiedReceipts[0].receipt_type, 'verified');
check('Receipt 1 status', verifiedReceipts[0].status, 'verified');
check('Receipt 1 status_byte', verifiedReceipts[0].status_byte, 0);
check('Receipt 1 avg_entry_price', verifiedReceipts[0].avg_entry_price, 0.00171731781061);
check('Receipt 1 realized_pnl', verifiedReceipts[0].realized_pnl, -0.000009474);

// ═══════════════════════════════════════════════════════════════
// Test 2: Position-based verified receipt
// ═══════════════════════════════════════════════════════════════
section('Test 2: Position-based verified receipt');

const positions = buildPositions(cycles, { wallet: WALLET });
const posReceipt = buildPositionReceipt(positions[0]);

check('Position receipt receipt_type', posReceipt.receipt_type, 'verified');
check('Position receipt is_custom', posReceipt.is_custom, false);
check('Position receipt has position_id', !!posReceipt.position_id, true);
check('Position receipt status', posReceipt.status, 'verified');
check('Position receipt status_byte', posReceipt.status_byte, 0);
check('Position receipt num_cycles', posReceipt.num_cycles, 2);
check('Position receipt num_buys', posReceipt.num_buys, 2);
check('Position receipt num_sells', posReceipt.num_sells, 2);

// Position receipt aggregates both cycles so hash will differ from per-cycle receipts
check('Position hash differs from cycle receipt 1', posReceipt.verification_hash !== EXPECTED_HASHES[0], true);
check('Position hash differs from cycle receipt 2', posReceipt.verification_hash !== EXPECTED_HASHES[1], true);

// But it's deterministic
const posReceipt2 = buildPositionReceipt(positions[0]);
check('Position receipt hash deterministic', posReceipt2.verification_hash, posReceipt.verification_hash);

// ═══════════════════════════════════════════════════════════════
// Test 3: Custom receipt from custom position
// ═══════════════════════════════════════════════════════════════
section('Test 3: Custom receipt');

const firstEntryHash = positions[0].entries[0].tx_hash;
const customPos = buildCustomPosition(positions[0], { removed_legs: [firstEntryHash] });
const customReceipt = buildCustomReceipt(customPos, posReceipt.verification_hash);

check('Custom receipt_type', customReceipt.receipt_type, 'custom');
check('Custom is_custom', customReceipt.is_custom, true);
check('Custom status', customReceipt.status, 'custom');
check('Custom status_byte', customReceipt.status_byte, 2);
check('Custom has base_position_id', !!customReceipt.base_position_id, true);
check('Custom has base_position_hash', customReceipt.base_position_hash, posReceipt.verification_hash);
check('Custom has removed_legs', customReceipt.removed_legs.length, 1);
check('Custom removed_legs[0]', customReceipt.removed_legs[0], firstEntryHash);
check('Custom receipt_id has _custom suffix', customReceipt.receipt_id.endsWith('_custom'), true);

// CRITICAL: custom hash must differ from verified
check('Custom hash differs from verified', customReceipt.verification_hash !== posReceipt.verification_hash, true);

// Deterministic
const customReceipt2 = buildCustomReceipt(customPos, posReceipt.verification_hash);
check('Custom hash deterministic', customReceipt2.verification_hash, customReceipt.verification_hash);

// ═══════════════════════════════════════════════════════════════
// Test 4: Integrity warnings
// ═══════════════════════════════════════════════════════════════
section('Test 4: Integrity warnings');

// Custom position removed an entry → sold > bought
check('Custom has integrity_warnings', !!customReceipt.integrity_warnings, true);
check('Warnings is array', Array.isArray(customReceipt.integrity_warnings), true);

const hasSoldExceedsBought = customReceipt.integrity_warnings.some(w => w.startsWith('sold_exceeds_bought'));
check('sold_exceeds_bought warning present', hasSoldExceedsBought, true);

const hasExtremePnl = customReceipt.integrity_warnings.some(w => w.startsWith('extreme_pnl'));
check('extreme_pnl warning present', hasExtremePnl, true);

// Verified receipt should NOT have warnings
check('Verified receipt has no integrity_warnings', verifiedReceipts[0].integrity_warnings, undefined);

// ═══════════════════════════════════════════════════════════════
// Test 5: Status byte mapping
// ═══════════════════════════════════════════════════════════════
section('Test 5: Status byte mapping');

check('STATUS_BYTE.verified', STATUS_BYTE.verified, 0);
check('STATUS_BYTE.verified_mixed_quote', STATUS_BYTE.verified_mixed_quote, 1);
check('STATUS_BYTE.custom', STATUS_BYTE.custom, 2);
check('STATUS_BYTE.custom_mixed_quote', STATUS_BYTE.custom_mixed_quote, 3);
check('statusToByte("verified")', statusToByte('verified'), 0);
check('statusToByte("custom")', statusToByte('custom'), 2);
check('statusToByte("custom_mixed_quote")', statusToByte('custom_mixed_quote'), 3);

// ═══════════════════════════════════════════════════════════════
// Test 6: Hash formula isolation
// ═══════════════════════════════════════════════════════════════
section('Test 6: Hash formula isolation');

// computeVerificationHash should match buildReceipts output
const manualHash = computeVerificationHash({
  wallet: WALLET, chain: 'solana',
  token_mint: verifiedReceipts[0].token_mint,
  entry_txs: verifiedReceipts[0].entry_txs,
  exit_txs: verifiedReceipts[0].exit_txs,
  entry_price_avg: verifiedReceipts[0]._hash_inputs.raw_entry_price_avg,
  exit_price_avg: verifiedReceipts[0]._hash_inputs.raw_exit_price_avg,
  accounting_method: 'weighted_average_cost_basis',
  receipt_version: '1.0',
  status: 'verified',
});
check('computeVerificationHash matches buildReceipts', manualHash, EXPECTED_HASHES[0]);

// computeCustomHash with same data but extra fields should differ
const customManualHash = computeCustomHash({
  wallet: WALLET, chain: 'solana',
  token_mint: verifiedReceipts[0].token_mint,
  entry_txs: verifiedReceipts[0].entry_txs,
  exit_txs: verifiedReceipts[0].exit_txs,
  entry_price_avg: verifiedReceipts[0]._hash_inputs.raw_entry_price_avg,
  exit_price_avg: verifiedReceipts[0]._hash_inputs.raw_exit_price_avg,
  accounting_method: 'weighted_average_cost_basis',
  receipt_version: '1.0',
  status: 'custom',
  receipt_type: 'custom',
  base_position_hash: 'some_base_hash',
  removed_legs: ['some_tx_hash'],
});
check('computeCustomHash differs from verified', customManualHash !== EXPECTED_HASHES[0], true);

// ═══════════════════════════════════════════════════════════════
// Example Outputs
// ═══════════════════════════════════════════════════════════════
section('Example Outputs');

console.log('\n  === Verified Receipt (cycle-based, v1 compatible) ===');
const vDisplay = { ...verifiedReceipts[0] };
vDisplay.entry_txs = `[${vDisplay.entry_txs.length} txs]`;
vDisplay.exit_txs = `[${vDisplay.exit_txs.length} txs]`;
console.log(JSON.stringify(vDisplay, null, 2));

console.log('\n  === Custom Receipt (1 entry leg removed) ===');
const cDisplay = { ...customReceipt };
cDisplay.entry_txs = `[${cDisplay.entry_txs.length} txs]`;
cDisplay.exit_txs = `[${cDisplay.exit_txs.length} txs]`;
console.log(JSON.stringify(cDisplay, null, 2));

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(58)}`);
if (fail === 0) {
  console.log(`✅ ALL ${pass} CHECKS PASSED — receipt v1.1 is solid`);
} else {
  console.log(`❌ ${fail} FAILED, ${pass} passed`);
}
console.log(`${'═'.repeat(58)}`);

process.exit(fail > 0 ? 1 : 0);
