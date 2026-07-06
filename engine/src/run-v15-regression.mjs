#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { resolve } from 'path';

const SUITES = [
  { name: 'Slice 1 Scanner', file: 'engine/src/inventory/scanner.test.mjs' },
  { name: 'Slice 1 Inventory API', file: 'engine/src/api/inventory-api.test.mjs' },
  { name: 'Slice 2A View Model', file: 'engine/src/proof-detail/view-model.test.mjs' },
  { name: 'Slice 2A Proof Detail API', file: 'engine/src/api/proof-detail-api.test.mjs' },
  { name: 'Slice 4A Wallet Policy', file: 'engine/src/proof-publish/wallet-policy.test.mjs' },
  { name: 'Slice 4B Publish Slug', file: 'engine/src/proof-publish/slug.test.mjs' },
  { name: 'Slice 4C Publish Bundle', file: 'engine/src/proof-publish/publish-bundle.test.mjs' },
  { name: 'Slice 4D FS Adapter', file: 'engine/src/proof-publish/fs-adapter.test.mjs' },
  { name: 'Slice 4E Publish CLI', file: 'engine/src/proof-publish/cli.test.mjs' },
  { name: 'Slice 4F Hosted Preview API', file: 'engine/src/api/proof-hosted-preview-api.test.mjs' },
  { name: 'Slice 4 Static Proof Export', file: 'engine/src/proof-export/render-static-page.test.mjs' },
  { name: 'Slice 4 Proof Export API', file: 'engine/src/api/proof-export-api.test.mjs' },
  { name: 'Slice 5A Disclosures', file: 'engine/src/proof-trust/disclosures.test.mjs' },
  { name: 'Slice 5B Trust Model', file: 'engine/src/proof-trust/trust-model.test.mjs' },
  { name: 'Slice 5C Verifier View Model', file: 'engine/src/proof-verifier/view-model.test.mjs' },
  { name: 'Slice 5D Verifier API', file: 'engine/src/api/proof-verifier-api.test.mjs' },
  { name: 'Slice 5E Proof Card View Model', file: 'engine/src/proof-card/view-model.test.mjs' },
  { name: 'Slice 5F Proof Card HTML', file: 'engine/src/proof-card/render-html.test.mjs' },
  { name: 'Slice 5G Proof Card API', file: 'engine/src/api/proof-card-api.test.mjs' },
  { name: 'Slice 5H Proof Gallery View Model', file: 'engine/src/proof-gallery/view-model.test.mjs' },
  { name: 'Slice 5I Proof Gallery HTML', file: 'engine/src/proof-gallery/render-html.test.mjs' },
  { name: 'Slice 5J Proof Gallery API', file: 'engine/src/api/proof-gallery-api.test.mjs' },
];

function summarizeOutput(output) {
  const normalized = output.replace(/\r/g, '');
  const ratioMatch = normalized.match(/(\d+)\/(\d+) passed, (\d+) failed/);
  if (ratioMatch) {
    return `${ratioMatch[1]}/${ratioMatch[2]} passed, ${ratioMatch[3]} failed`;
  }

  const totalMatch = normalized.match(/TOTAL:\s*(\d+) passed,\s*(\d+) failed/i);
  if (totalMatch) {
    return `${totalMatch[1]} passed, ${totalMatch[2]} failed`;
  }

  const allPassMatch = normalized.match(/ALL (\d+) CHECKS PASSED/i);
  if (allPassMatch) {
    return `${allPassMatch[1]}/${allPassMatch[1]} passed, 0 failed`;
  }

  return 'completed';
}

async function runModuleSuite(file) {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  let output = '';
  let exitCode = 0;

  console.log = (...args) => {
    output += `${args.join(' ')}\n`;
  };
  console.error = (...args) => {
    output += `${args.join(' ')}\n`;
  };
  process.exit = code => {
    exitCode = code ?? 0;
    throw { __suiteExit: true, code: exitCode };
  };

  try {
    const url = `${pathToFileURL(resolve(file)).href}?run=${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await import(url);
  } catch (error) {
    if (!error || error.__suiteExit !== true) {
      output += `${error?.stack || error?.message || String(error)}\n`;
      exitCode = 1;
    }
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }

  return { ok: exitCode === 0, output };
}

console.log('Trade Artifact v1.5 Regression Runner');
console.log('Deterministic local suites only. No live Helius, upload, mint, signing, browser automation, or remote deploy.');
console.log('Existing v1.2 ledger runner is intentionally excluded here because it shells out to child processes.');
console.log('Run `node engine/src/ledger/run-all-tests.mjs` separately when that execution path is allowed.');
console.log('');

let failures = 0;
const results = [];

for (const suite of SUITES) {
  const result = await runModuleSuite(suite.file);
  const summary = summarizeOutput(result.output);
  results.push({ name: suite.name, ok: result.ok, summary });
  if (!result.ok) failures += 1;
}

for (const result of results) {
  const label = result.ok ? 'PASS' : 'FAIL';
  console.log(`${label}  ${result.name}  ${result.summary}`);
}

console.log('');
console.log(`Suites run: ${results.length}`);
console.log(`Suites failed: ${failures}`);
console.log('Ledger runner: excluded from automated wrapper; run separately if child-process execution is available.');
console.log(`Result: ${failures === 0 ? 'PASS' : 'FAIL'}`);

process.exit(failures > 0 ? 1 : 0);