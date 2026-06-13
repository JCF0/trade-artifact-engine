/**
 * Proof Pipeline Summary — B4
 *
 * Pure function: all debug stage data → consolidated summary manifest.
 *
 * Answers: "Did the full v1.2 debug proof pipeline run cleanly,
 * and what did it produce?"
 *
 * This module does NOT:
 *   - Change receipt/candidate/verifier schemas
 *   - Change hash formulas
 *   - Create, promote, or verify receipts
 *   - Touch v1.1 receipts
 *   - Render PNGs, mint NFTs, or upload metadata
 *   - Fetch live prices or normalize to USD
 *   - Perform I/O or use Date.now()
 */

const SCHEMA_NAME = 'v12_proof_pipeline_summary';
const SCHEMA_VERSION = '1.0.0';

const ARTIFACT_PATHS = [
  'data/debug/ledger-output.json',
  'data/debug/ledger-comparison.json',
  'data/debug/ledger-candidates.json',
  'data/debug/ledger-receipts-v12.json',
  'data/debug/ledger-verify-v12.json',
  'data/debug/v12-proof-pipeline-summary.json',
];

// ═══════════════════════════════════════════════════════════════
// Consistency checks
// ═══════════════════════════════════════════════════════════════

/**
 * Run all consistency checks across pipeline stages.
 *
 * @param {object} inputs - Same shape as buildProofPipelineSummary inputs
 * @returns {{ checks: object[], all_pass: boolean, warnings: string[] }}
 */
function runConsistencyChecks(inputs) {
  const { comparison, candidates, receipts, verifyReport } = inputs;
  const checks = [];
  const warnings = [];

  // ── 1. candidate_receipt_count: 1:1 promotion ──
  {
    const expected = candidates.length;
    const actual = receipts.length;
    checks.push({
      check: 'candidate_receipt_count',
      expected,
      actual,
      pass: expected === actual,
    });
  }

  // ── 2. receipt_verify_count: all receipts verified ──
  {
    const expected = receipts.length;
    const actual = verifyReport.total;
    checks.push({
      check: 'receipt_verify_count',
      expected,
      actual,
      pass: expected === actual,
    });
  }

  // ── 3. all_verify_passed: no verify failures ──
  {
    const expected = 0;
    const actual = verifyReport.failed;
    checks.push({
      check: 'all_verify_passed',
      expected,
      actual,
      pass: actual === 0,
    });
  }

  // ── 4. type_distribution_match: types preserved through promotion ──
  {
    const candidateByType = { closed_position: 0, realized_partial: 0, open_snapshot: 0 };
    for (const c of candidates) {
      if (candidateByType[c.candidate_type] !== undefined) candidateByType[c.candidate_type]++;
    }
    const receiptByType = { closed_position: 0, realized_partial: 0, open_snapshot: 0 };
    for (const r of receipts) {
      if (receiptByType[r.receipt_type] !== undefined) receiptByType[r.receipt_type]++;
    }
    const pass = candidateByType.closed_position === receiptByType.closed_position
              && candidateByType.realized_partial === receiptByType.realized_partial
              && candidateByType.open_snapshot === receiptByType.open_snapshot;
    checks.push({
      check: 'type_distribution_match',
      pass,
    });
  }

  // ── 5. ledger_closed_eq_cp_candidates ──
  if (comparison) {
    const expected = comparison.ledger_closed;
    const actual = candidates.filter(c => c.candidate_type === 'closed_position').length;
    checks.push({
      check: 'ledger_closed_eq_cp_candidates',
      expected,
      actual,
      pass: expected === actual,
    });
  } else {
    warnings.push('comparison data missing — skipped ledger_closed_eq_cp_candidates');
  }

  // ── 6. comparison_no_mismatches (WARN severity) ──
  if (comparison) {
    const expected = 0;
    const actual = comparison.mismatches
      ? (Array.isArray(comparison.mismatches) ? comparison.mismatches.length : comparison.mismatches)
      : 0;
    const pass = actual === 0;
    checks.push({
      check: 'comparison_no_mismatches',
      expected,
      actual,
      pass,
      severity: 'warn',
    });
    if (!pass) {
      warnings.push(`comparison has ${actual} mismatch(es) between ledger and v1`);
    }
  } else {
    warnings.push('comparison data missing — skipped comparison_no_mismatches');
  }

  // ── 7. candidate_hash_traceability: B1→B2 chain ──
  {
    const candidateHashes = new Set(candidates.map(c => c.candidate_hash));
    let pass = true;
    for (const r of receipts) {
      if (!candidateHashes.has(r.candidate_hash)) {
        pass = false;
        break;
      }
    }
    checks.push({
      check: 'candidate_hash_traceability',
      pass,
    });
  }

  // ── 8. receipt_id_coverage: B2→B3 chain ──
  {
    const verifiedIds = new Set(verifyReport.results.map(r => r.receipt_id));
    let pass = true;
    for (const r of receipts) {
      if (!verifiedIds.has(r.receipt_id)) {
        pass = false;
        break;
      }
    }
    checks.push({
      check: 'receipt_id_coverage',
      pass,
    });
  }

  // ── Compute all_pass (ignoring warn-severity checks) ──
  const all_pass = checks.every(c => c.pass || c.severity === 'warn');

  return { checks, all_pass, warnings };
}

// ═══════════════════════════════════════════════════════════════
// Receipt summary entries
// ═══════════════════════════════════════════════════════════════

/**
 * Build compact receipt summary entries for the manifest.
 */
function buildReceiptEntries(receipts, verifyReport) {
  const verifyByReceiptId = new Map();
  for (const vr of verifyReport.results) {
    verifyByReceiptId.set(vr.receipt_id, vr);
  }

  return receipts.map(r => {
    const vr = verifyByReceiptId.get(r.receipt_id);
    return {
      receipt_id: r.receipt_id,
      receipt_type: r.receipt_type,
      token_mint: r.token_mint,
      verification_status: r.verification_status,
      receipt_hash: r.receipt_hash,
      candidate_hash: r.candidate_hash,
      hash_valid: vr ? vr.hash_valid : null,
      violations: vr ? vr.rule_violations.length : null,
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// Stage summaries
// ═══════════════════════════════════════════════════════════════

function buildStages(inputs) {
  const { ledger, comparison, candidates, receipts, verifyReport } = inputs;

  // Candidate counts
  const candidateByType = { closed_position: 0, realized_partial: 0, open_snapshot: 0 };
  let eligibleVerified = 0;
  let eligibleClosed = 0;
  for (const c of candidates) {
    if (candidateByType[c.candidate_type] !== undefined) candidateByType[c.candidate_type]++;
    if (c.eligible_for_verified_receipt) eligibleVerified++;
    if (c.eligible_for_closed_position_receipt) eligibleClosed++;
  }

  // Receipt counts
  const receiptByType = { closed_position: 0, realized_partial: 0, open_snapshot: 0 };
  const receiptByStatus = {};
  for (const r of receipts) {
    if (receiptByType[r.receipt_type] !== undefined) receiptByType[r.receipt_type]++;
    receiptByStatus[r.verification_status] = (receiptByStatus[r.verification_status] || 0) + 1;
  }

  const stages = {
    ledger: {
      events_processed: ledger.processedCount,
      events_skipped: ledger.skippedCount,
      closed_segments: ledger.closedSegments,
      open_positions: ledger.openPositions,
      artifact: ARTIFACT_PATHS[0],
    },
    comparison: comparison ? {
      ledger_closed: comparison.ledger_closed,
      v1_closed: comparison.v1_closed,
      matched: comparison.matched,
      mismatches: Array.isArray(comparison.mismatches) ? comparison.mismatches.length : comparison.mismatches,
      artifact: ARTIFACT_PATHS[1],
    } : null,
    candidates: {
      total: candidates.length,
      by_type: candidateByType,
      eligible_verified: eligibleVerified,
      eligible_closed: eligibleClosed,
      artifact: ARTIFACT_PATHS[2],
    },
    receipts: {
      total: receipts.length,
      by_type: receiptByType,
      by_status: receiptByStatus,
      artifact: ARTIFACT_PATHS[3],
    },
    verification: {
      total: verifyReport.total,
      passed: verifyReport.passed,
      failed: verifyReport.failed,
      artifact: ARTIFACT_PATHS[4],
    },
  };

  return stages;
}

// ═══════════════════════════════════════════════════════════════
// Determine overall result
// ═══════════════════════════════════════════════════════════════

function computeResult(consistency, verifyReport) {
  // FAIL if any non-warn check fails or any verification failure
  const hasHardFailure = consistency.checks.some(c => !c.pass && c.severity !== 'warn');
  if (hasHardFailure || verifyReport.failed > 0) return 'FAIL';

  // WARN if warnings exist (warn-severity check failures or warning messages)
  if (consistency.warnings.length > 0) return 'WARN';

  return 'PASS';
}

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

/**
 * Build the proof pipeline summary manifest.
 *
 * Pure function: no I/O, no Date.now(). All timestamps are explicit.
 *
 * @param {object} inputs
 * @param {string} inputs.wallet
 * @param {string} inputs.chain
 * @param {string} inputs.generatedAt - ISO-8601 timestamp
 * @param {object} inputs.ledger - { processedCount, skippedCount, closedSegments, openPositions }
 * @param {object|null} inputs.comparison - comparison object or null
 * @param {object[]} inputs.candidates - B1 candidate array
 * @param {object[]} inputs.receipts - v1.2 receipt array
 * @param {object} inputs.verifyReport - B3 verification report
 * @returns {object} Proof pipeline summary manifest
 */
export function buildProofPipelineSummary(inputs) {
  const { wallet, chain, generatedAt, receipts, verifyReport } = inputs;

  const stages = buildStages(inputs);
  const consistency = runConsistencyChecks(inputs);
  const receiptEntries = buildReceiptEntries(receipts, verifyReport);
  const result = computeResult(consistency, verifyReport);

  return {
    schema: SCHEMA_NAME,
    version: SCHEMA_VERSION,
    generated_at: generatedAt,
    wallet,
    chain,
    stages,
    receipts: receiptEntries,
    consistency,
    artifacts: [...ARTIFACT_PATHS],
    result,
  };
}
