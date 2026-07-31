#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  TARGETED_ORCHESTRATOR_TEST_NAMES_V113,
  TARGETED_ORCHESTRATOR_TEST_PATTERN_V113,
  parseExactTargetedTapV113,
} from './v113-targeted-filter.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TARGETED_DRY_RUN_PATTERN = TARGETED_ORCHESTRATOR_TEST_PATTERN_V113;

// Slice 1F safety adaptation: the old v1.12 wrapper is not invoked because it
// includes package-store commit tests. These maintained v1.12 suites are run
// directly; commit-bearing filesystem-store, migration, golden-package,
// package-native-proof-source, and unfiltered orchestrator executions are
// deliberately excluded. JUP/RAY package identity remains covered by the pure
// package suites and the separately filtered dry-run/candidate golden gates.
const SAFE_V112_COMPATIBILITY_SUITES = Object.freeze([
  { name: 'v1.9 scanner', files: ['engine/src/inventory/scanner.test.mjs'] },
  { name: 'v1.9 inventory API', files: ['engine/src/api/inventory-api.test.mjs'] },
  { name: 'v1.9 proof detail API', files: ['engine/src/api/proof-detail-api.test.mjs'] },
  { name: 'v1.9 wallet policy', files: ['engine/src/proof-publish/wallet-policy.test.mjs'] },
  { name: 'v1.9 publish slug', files: ['engine/src/proof-publish/slug.test.mjs'] },
  { name: 'v1.9 publish bundle', files: ['engine/src/proof-publish/publish-bundle.test.mjs'] },
  { name: 'v1.9 filesystem adapter', files: ['engine/src/proof-publish/fs-adapter.test.mjs'] },
  { name: 'v1.9 publish CLI', files: ['engine/src/proof-publish/cli.test.mjs'] },
  { name: 'v1.9 hosted preview API', files: ['engine/src/api/proof-hosted-preview-api.test.mjs'] },
  { name: 'v1.9 static proof export', files: ['engine/src/proof-export/render-static-page.test.mjs'] },
  { name: 'v1.9 proof export API', files: ['engine/src/api/proof-export-api.test.mjs'] },
  { name: 'v1.9 disclosures', files: ['engine/src/proof-trust/disclosures.test.mjs'] },
  { name: 'v1.9 trust model', files: ['engine/src/proof-trust/trust-model.test.mjs'] },
  { name: 'v1.9 verifier API', files: ['engine/src/api/proof-verifier-api.test.mjs'] },
  { name: 'v1.9 proof card view model', files: ['engine/src/proof-card/view-model.test.mjs'] },
  { name: 'v1.9 proof card HTML', files: ['engine/src/proof-card/render-html.test.mjs'] },
  { name: 'v1.9 proof card API', files: ['engine/src/api/proof-card-api.test.mjs'] },
  { name: 'v1.9 proof gallery view model', files: ['engine/src/proof-gallery/view-model.test.mjs'] },
  { name: 'v1.9 proof gallery HTML', files: ['engine/src/proof-gallery/render-html.test.mjs'] },
  { name: 'v1.9 proof gallery API', files: ['engine/src/api/proof-gallery-api.test.mjs'] },
  { name: 'v1.9 receipt board HTML', files: ['engine/src/receipt-board/render-html.test.mjs'] },
  { name: 'v1.9 receipt board API', files: ['engine/src/api/receipt-board-api.test.mjs'] },
  { name: 'v1.9 coverage statement view model', files: ['engine/src/coverage-statement/view-model.test.mjs'] },
  { name: 'v1.9 classifier', files: ['engine/src/pipeline/test-classifier.mjs'] },
  { name: 'v1.9 receipt archive store', files: ['engine/src/inventory/archive-store.test.mjs'] },
  { name: 'v1.9 current-run archive import', files: ['engine/src/inventory/archive-current-run.test.mjs'] },
  { name: 'v1.9 archive-backed inventory', files: ['engine/src/inventory/archive-inventory.test.mjs'] },
  { name: 'v1.9 archive resolution API', files: ['engine/src/api/archive-resolution-api.test.mjs'] },

  { name: 'v1.12 package schema', files: ['engine/src/receipt-package/schema.test.mjs'] },
  { name: 'v1.12 package builder', files: ['engine/src/receipt-package/builder.test.mjs'] },
  { name: 'v1.12 package validator', files: ['engine/src/receipt-package/validator.test.mjs'] },
  { name: 'v1.12 canonical serialization', files: ['engine/src/receipt-package/serialize.test.mjs'] },

  { name: 'v1.12 package inventory', files: ['engine/src/inventory/package-inventory.test.mjs'] },
  { name: 'v1.12 package-first inventory', files: ['engine/src/inventory/package-first-inventory.test.mjs'] },
  { name: 'v1.12 package-derived compatibility projection', files: ['engine/src/inventory/receipt-compatibility-projection.test.mjs'] },
  { name: 'v1.12 production package-first acceptance', files: ['engine/src/inventory/check-production-package-first.test.mjs'] },

  { name: 'v1.12 package-native APIs', files: ['engine/src/api/package-native-api.test.mjs'] },
  { name: 'v1.12 API import safety', files: ['engine/src/api/server-import-safety.test.mjs'] },
  { name: 'v1.12 package-native proof detail', files: ['engine/src/proof-detail/view-model.test.mjs'] },
  { name: 'v1.12 package-native verifier', files: ['engine/src/proof-verifier/view-model.test.mjs'] },
  { name: 'v1.12 package-native receipt board', files: ['engine/src/receipt-board/view-model.test.mjs'] },

  { name: 'v1.12 ledger position reconstruction', files: ['engine/src/ledger/position-ledger.test.mjs'] },
  { name: 'v1.12 ledger receipt candidates', files: ['engine/src/ledger/receipt-candidates.test.mjs'] },
  { name: 'v1.12 ledger receipt promotion', files: ['engine/src/ledger/receipt-promotion.test.mjs'] },
  { name: 'v1.12 ledger canonical receipt verifier', files: ['engine/src/ledger/receipt-verifier.test.mjs'] },

  { name: 'v1.12 bounded acquisition contract and adapter', files: ['engine/src/acquisition/acquisition.test.mjs'] },
  { name: 'v1.12 acquisition-to-orchestrator integration', files: ['engine/src/acquisition/acquisition-orchestrator.integration.test.mjs'] },
  { name: 'v1.12 retained real-provider-shape acceptance', files: ['engine/src/acquisition/real-shape-acceptance.test.mjs'] },

  { name: 'v1.12 Share Card view model', files: ['engine/src/share-card/share-card-view-model.test.mjs'] },
  { name: 'v1.12 Share Card formatting', files: ['engine/src/share-card/share-card-format.test.mjs'] },
  { name: 'v1.12 Share Card HTML', files: ['engine/src/share-card/share-card-html.test.mjs'] },
  { name: 'v1.12 Share Card production acceptance', files: ['engine/src/share-card/check-production-share-cards.test.mjs'] },

  { name: 'v1.12 public-demo Share Card integration', files: ['engine/src/public-demo/share-card-integration.test.mjs'] },
  { name: 'v1.12 public-demo site bundle', files: ['engine/src/public-demo/site-bundle.test.mjs'] },
  { name: 'v1.12 public-demo leak check', files: ['engine/src/public-demo/leak-check.test.mjs'] },
  { name: 'v1.12 public-demo predeploy check', files: ['engine/src/public-demo/predeploy-check.test.mjs'] },
].map(suite => Object.freeze({ ...suite, gate: 'v1.12 safe compatibility', v112Compatible: true })));

const CANDIDATE_SET_TEST_FILES = Object.freeze([
  'engine/src/candidate-set/acquisition-result.test.mjs',
  'engine/src/candidate-set/activity-findings.test.mjs',
  'engine/src/candidate-set/authority-boundary.test.mjs',
  'engine/src/candidate-set/blocked-summary.test.mjs',
  'engine/src/candidate-set/builder.test.mjs',
  'engine/src/candidate-set/capabilities.test.mjs',
  'engine/src/candidate-set/coverage.test.mjs',
  'engine/src/candidate-set/dispositions.test.mjs',
  'engine/src/candidate-set/evidence-bundle.test.mjs',
  'engine/src/candidate-set/golden-selection.test.mjs',
  'engine/src/candidate-set/identity.test.mjs',
  'engine/src/candidate-set/immutability.test.mjs',
  'engine/src/candidate-set/mark-observations.test.mjs',
  'engine/src/candidate-set/open-snapshot.test.mjs',
  'engine/src/candidate-set/plain-data.test.mjs',
  'engine/src/candidate-set/privacy.test.mjs',
  'engine/src/candidate-set/project-candidate.test.mjs',
  'engine/src/candidate-set/receipt-scoped-evidence.test.mjs',
  'engine/src/candidate-set/schema.test.mjs',
  'engine/src/candidate-set/selection-projection.test.mjs',
  'engine/src/candidate-set/selection-resolver.test.mjs',
  'engine/src/candidate-set/serialize.test.mjs',
  'engine/src/candidate-set/token-isolation.test.mjs',
]);

const SLICE_1F_SUITES = Object.freeze([
  {
    gate: 'candidate set',
    name: 'v1.13 Slice 1A-1E candidate-set deterministic tests',
    files: CANDIDATE_SET_TEST_FILES,
  },
  {
    gate: 'runner safety',
    name: 'v1.13 exact targeted-filter fail-closed self-check',
    files: ['engine/src/v113-targeted-filter.test.mjs'],
  },
  {
    gate: 'targeted dry run',
    v112Compatible: true,
    name: `v1.13 targeted orchestrator dry-run invariance (${TARGETED_DRY_RUN_PATTERN})`,
    files: ['engine/src/receipt-package/targeted-orchestrator.test.mjs'],
    testNamePattern: TARGETED_DRY_RUN_PATTERN,
    exactTargetedTap: true,
  },
  {
    gate: 'same-mint invariance',
    v112Compatible: true,
    name: 'v1.13 same-mint input aggregation invariance',
    files: [
      'engine/src/pipeline/same-mint-input-aggregation.test.mjs',
      'engine/src/pipeline/same-mint-input-aggregation-parity.test.mjs',
      'engine/src/pipeline/same-mint-input-real-shape.test.mjs',
    ],
  },
].map(suite => Object.freeze(suite)));

const SUITES = Object.freeze([...SAFE_V112_COMPATIBILITY_SUITES, ...SLICE_1F_SUITES]);

function summarize(output) {
  const normalized = output.replace(/\r/g, '');
  const tests = normalized.match(/^# tests (\d+)$/m);
  const failed = normalized.match(/^# fail (\d+)$/m);
  if (tests && failed) return `${tests[1]} tests, ${failed[1]} failed`;
  const suites = [...normalized.matchAll(/Suites run:\s*(\d+)\s*\nSuites failed:\s*(\d+)/gi)].at(-1);
  if (suites) return `${suites[1]} suites, ${suites[2]} failed`;
  const pass = normalized.match(/Result:\s*(PASS|FAIL)|:\s*(PASS|FAIL)\s*$/im);
  return pass ? (pass[1] ?? pass[2]).toUpperCase() : 'completed';
}

function childArguments(suite) {
  const files = suite.files.map(file => resolve(REPOSITORY_ROOT, file));
  if (suite.mode === 'script') return files;
  const args = ['--test'];
  if (suite.testNamePattern) args.push('--test-name-pattern', suite.testNamePattern);
  return [...args, ...files];
}

function runSuite(suite) {
  const result = spawnSync(process.execPath, childArguments(suite), {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: {
      TRADE_ARTIFACT_TEST: '1',
      HOME: '/nonexistent/trade-artifact-regression-home',
      USERPROFILE: '/nonexistent/trade-artifact-regression-home',
      TZ: 'UTC',
      LANG: 'C',
      LC_ALL: 'C',
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  let targetedAudit = null;
  let auditError = null;
  if (suite.exactTargetedTap === true) {
    try {
      targetedAudit = parseExactTargetedTapV113(output);
    } catch (error) {
      auditError = error;
    }
  }
  const ok = result.status === 0 && result.error === undefined && auditError === null;
  return {
    ...suite,
    ok,
    status: result.status,
    signal: result.signal,
    error: result.error ?? auditError,
    output,
    summary: targetedAudit === null ? summarize(output) : `${targetedAudit.selected} exact tests selected and passed; ${targetedAudit.skipped} selected tests skipped`,
  };
}

console.log('Trade Artifact v1.13 Slice 1 Regression Runner');
console.log('Direct deterministic Node commands only. No npm wrapper, live network/provider call, credential loading, production package/archive/economics/public-demo write, upload, signing, minting, or deployment.');
console.log('Slice 1F safety adaptation: run-v112-regression.mjs and commit-bearing v1.12 package-store suites are not executed; maintained safe v1.12 suites run directly.');
console.log(`Targeted orchestrator filter: ${TARGETED_DRY_RUN_PATTERN}`);
console.log(`Exact targeted tests (${TARGETED_ORCHESTRATOR_TEST_NAMES_V113.length}): ${TARGETED_ORCHESTRATOR_TEST_NAMES_V113.join(' | ')}`);
console.log('');

const results = SUITES.map(runSuite);
const failures = results.filter(result => !result.ok);

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  [${result.gate}]  ${result.name}  ${result.summary}`);
  if (!result.ok) {
    if (result.error) console.log(result.error.stack || result.error.message || String(result.error));
    if (result.signal) console.log(`terminated by signal ${result.signal}`);
    if (result.status !== null) console.log(`child exit status ${result.status}`);
    if (result.output.trim()) console.log(result.output.trim());
  }
}

const compatibilityResults = results.filter(result => result.v112Compatible === true);
const compatibilityFailures = compatibilityResults.filter(result => !result.ok);
console.log('');
console.log(`safety-adapted v1.12 compatibility suites run: ${compatibilityResults.length}`);
console.log(`safety-adapted v1.12 compatibility suites failed: ${compatibilityFailures.length}`);
console.log(`Suites run: ${results.length}`);
console.log(`Suites passed: ${results.length - failures.length}`);
console.log(`Suites failed: ${failures.length}`);
console.log(`Result: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);

process.exit(failures.length === 0 ? 0 : 1);
