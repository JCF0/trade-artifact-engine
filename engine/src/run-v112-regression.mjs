#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SUITES = Object.freeze([
  { name: 'v1.9 deterministic regression', file: 'engine/src/run-v19-regression.mjs', mode: 'script' },
  { name: 'v1.10 deterministic regression', file: 'engine/src/run-v110-regression.mjs', mode: 'script' },

  { name: 'Slice 1 package schema', file: 'engine/src/receipt-package/schema.test.mjs' },
  { name: 'Slice 1 package builder', file: 'engine/src/receipt-package/builder.test.mjs' },
  { name: 'Slice 1 package validator', file: 'engine/src/receipt-package/validator.test.mjs' },
  { name: 'Slice 1 canonical serialization', file: 'engine/src/receipt-package/serialize.test.mjs' },
  { name: 'Slice 2 atomic filesystem package store', file: 'engine/src/receipt-package/fs-package-store.test.mjs' },
  { name: 'Slice 3 recovered-package migration', file: 'engine/src/receipt-package/migrate-recovered-packages.test.mjs' },
  { name: 'Slice 3 JUP/RAY golden packages', file: 'engine/src/receipt-package/golden-packages.test.mjs' },

  { name: 'Slice 4 package inventory', file: 'engine/src/inventory/package-inventory.test.mjs' },
  { name: 'Slice 4 package-first inventory', file: 'engine/src/inventory/package-first-inventory.test.mjs' },
  { name: 'Slice 5 package-derived compatibility projection', file: 'engine/src/inventory/receipt-compatibility-projection.test.mjs' },
  { name: 'Slice 5 production package-first acceptance', file: 'engine/src/inventory/check-production-package-first.test.mjs' },

  { name: 'Slice 6 package-native proof source', file: 'engine/src/proof-source/package-native-proof-source.test.mjs' },
  { name: 'Slice 6 package-native APIs', file: 'engine/src/api/package-native-api.test.mjs' },
  { name: 'Slice 6 API import safety', file: 'engine/src/api/server-import-safety.test.mjs' },
  { name: 'Slice 6 package-native proof detail', file: 'engine/src/proof-detail/view-model.test.mjs' },
  { name: 'Slice 6 package-native verifier', file: 'engine/src/proof-verifier/view-model.test.mjs' },
  { name: 'Slice 6 package-native receipt board', file: 'engine/src/receipt-board/view-model.test.mjs' },

  { name: 'Ledger position reconstruction', file: 'engine/src/ledger/position-ledger.test.mjs' },
  { name: 'Ledger receipt candidates', file: 'engine/src/ledger/receipt-candidates.test.mjs' },
  { name: 'Ledger receipt promotion', file: 'engine/src/ledger/receipt-promotion.test.mjs' },
  { name: 'Ledger canonical receipt verifier', file: 'engine/src/ledger/receipt-verifier.test.mjs' },

  { name: 'Slice 7 targeted receipt orchestration', file: 'engine/src/receipt-package/targeted-orchestrator.test.mjs' },
  { name: 'Slice 8A bounded acquisition contract and adapter', file: 'engine/src/acquisition/acquisition.test.mjs' },
  { name: 'Slice 8A acquisition-to-orchestrator integration', file: 'engine/src/acquisition/acquisition-orchestrator.integration.test.mjs' },
  { name: 'Slice 8A retained real-provider-shape acceptance', file: 'engine/src/acquisition/real-shape-acceptance.test.mjs' },

  { name: 'Share Card view model', file: 'engine/src/share-card/share-card-view-model.test.mjs' },
  { name: 'Share Card formatting', file: 'engine/src/share-card/share-card-format.test.mjs' },
  { name: 'Share Card HTML', file: 'engine/src/share-card/share-card-html.test.mjs' },
  { name: 'Share Card production acceptance', file: 'engine/src/share-card/check-production-share-cards.test.mjs' },
  { name: 'Share Card public-demo integration', file: 'engine/src/public-demo/share-card-integration.test.mjs' },
  { name: 'Public-demo site bundle', file: 'engine/src/public-demo/site-bundle.test.mjs' },
  { name: 'Public-demo leak check', file: 'engine/src/public-demo/leak-check.test.mjs' },
  { name: 'Public-demo predeploy check', file: 'engine/src/public-demo/predeploy-check.test.mjs' },
]);

function summarize(output) {
  const normalized = output.replace(/\r/g, '');
  const tests = normalized.match(/^# tests (\d+)$/m);
  const failed = normalized.match(/^# fail (\d+)$/m);
  if (tests && failed) return `${tests[1]} tests, ${failed[1]} failed`;
  const suites = [...normalized.matchAll(/Suites run:\s*(\d+)\s*\nSuites failed:\s*(\d+)/gi)].at(-1);
  if (suites) return `${suites[1]} suites, ${suites[2]} failed`;
  const pass = normalized.match(/Result:\s*(PASS|FAIL)/i);
  return pass ? pass[1].toUpperCase() : 'completed';
}

function runSuite(suite) {
  const args = suite.mode === 'script'
    ? [resolve(suite.file)]
    : ['--test', resolve(suite.file)];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TRADE_ARTIFACT_TEST: '1' },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const ok = result.status === 0 && result.error === undefined;
  return {
    ...suite,
    ok,
    status: result.status,
    signal: result.signal,
    error: result.error,
    output,
    summary: summarize(output),
  };
}

console.log('Trade Artifact v1.12 Regression Runner');
console.log('Deterministic checked-in suites only. No live Helius, credential loading, wallet-wide pipeline, authoritative package/archive/economics writes, deployment, upload, mint, signing, Git, or network actions.');
console.log('Store publication tests use isolated operating-system temporary roots. The separately authorized Slice 8B live evidence is not executed or read.');
console.log('');

const results = SUITES.map(runSuite);
const failures = results.filter(result => !result.ok);

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  ${result.summary}`);
  if (!result.ok) {
    if (result.error) console.log(result.error.stack || result.error.message || String(result.error));
    if (result.signal) console.log(`terminated by signal ${result.signal}`);
    if (result.output.trim()) console.log(result.output.trim());
  }
}

console.log('');
console.log(`Suites run: ${results.length}`);
console.log(`Suites failed: ${failures.length}`);
console.log(`Result: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);

process.exit(failures.length === 0 ? 0 : 1);
