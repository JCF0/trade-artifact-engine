/**
 * Run All v1.2 Test Suites — G
 *
 * Executes all 18 ledger test suites sequentially and prints a final summary.
 * No network calls, no uploads, no mints, no secrets.
 */

import { execSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  { name: 'Position Ledger (1A)', file: 'position-ledger.test.mjs' },
  { name: 'Receipt Candidates (B1)', file: 'receipt-candidates.test.mjs' },
  { name: 'Receipt Promotion (B2)', file: 'receipt-promotion.test.mjs' },
  { name: 'Receipt Verifier (B3+C2)', file: 'receipt-verifier.test.mjs' },
  { name: 'Proof Pipeline Summary (B4+C3)', file: 'proof-pipeline-summary.test.mjs' },
  { name: 'Valuation Schema (C1)', file: 'valuation.test.mjs' },
  { name: 'Receipt Preview (D1)', file: 'receipt-preview.test.mjs' },
  { name: 'Receipt Preview HTML (D2)', file: 'receipt-preview-html.test.mjs' },
  { name: 'Receipt Metadata (E1)', file: 'receipt-metadata.test.mjs' },
  { name: 'Mint Plan (E2)', file: 'mint-plan.test.mjs' },
  { name: 'Receipt Image SVG (E3)', file: 'receipt-image-svg.test.mjs' },
  { name: 'Upload Package (E4)', file: 'upload-package.test.mjs' },
  { name: 'Upload Dry Run (E5)', file: 'upload-dry-run.test.mjs' },
  { name: 'Live Upload (E6)', file: 'live-upload.test.mjs' },
  { name: 'Irys Uploader (E7)', file: 'irys-uploader.test.mjs' },
  { name: 'Mint-Ready Resolver (E8)', file: 'mint-ready-resolver.test.mjs' },
  { name: 'Devnet Mint Adapter (E9)', file: 'devnet-mint-adapter.test.mjs' },
  { name: 'E2E Proof Manifest (F)', file: 'e2e-proof-manifest.test.mjs' },
];

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Trade Artifact Engine — v1.2 Full Test Suite`);
console.log(`  ${SUITES.length} suites`);
console.log(`${'═'.repeat(60)}\n`);

let totalPassed = 0;
let totalFailed = 0;
let suitesRun = 0;
let suitesFailed = 0;
const results = [];

for (const suite of SUITES) {
  const filePath = resolve(__dirname, suite.file);
  try {
    const output = execSync(`node "${filePath}"`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse test counts from output
    const match = output.match(/(\d+)\/(\d+) passed, (\d+) failed/);
    if (match) {
      const passed = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      const failed = parseInt(match[3], 10);
      totalPassed += passed;
      totalFailed += failed;
      results.push({ name: suite.name, passed, total, failed, status: failed === 0 ? 'PASS' : 'FAIL' });
    } else {
      // Fallback: check for "ALL X CHECKS PASSED"
      const altMatch = output.match(/ALL (\d+) CHECKS PASSED/);
      if (altMatch) {
        const count = parseInt(altMatch[1], 10);
        totalPassed += count;
        results.push({ name: suite.name, passed: count, total: count, failed: 0, status: 'PASS' });
      } else {
        results.push({ name: suite.name, passed: '?', total: '?', failed: '?', status: 'UNKNOWN' });
      }
    }
    suitesRun++;
  } catch (e) {
    suitesRun++;
    suitesFailed++;
    // Try to parse even from failed output
    const output = (e.stdout || '') + (e.stderr || '');
    const match = output.match(/(\d+)\/(\d+) passed, (\d+) failed/);
    if (match) {
      const passed = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      const failed = parseInt(match[3], 10);
      totalPassed += passed;
      totalFailed += failed;
      results.push({ name: suite.name, passed, total, failed, status: 'FAIL' });
    } else {
      totalFailed++;
      results.push({ name: suite.name, passed: 0, total: 1, failed: 1, status: 'ERROR', error: e.message?.slice(0, 100) });
    }
  }
}

// Print results table
console.log(`\n${'─'.repeat(60)}`);
for (const r of results) {
  const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '❓';
  console.log(`  ${icon} ${r.name}: ${r.passed}/${r.total} passed`);
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
console.log(`  SUITES: ${suitesRun}/${SUITES.length} run, ${suitesFailed} failed`);
console.log(`  RESULT: ${totalFailed === 0 ? '✅ ALL PASS' : '❌ FAILURES DETECTED'}`);
console.log(`${'═'.repeat(60)}\n`);

process.exit(totalFailed > 0 ? 1 : 0);
