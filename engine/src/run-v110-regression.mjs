#!/usr/bin/env node
import { resolve } from 'path';
import { pathToFileURL } from 'url';

const SUITES = [
  { name: 'v1.9 deterministic regression', file: 'engine/src/run-v19-regression.mjs' },
  { name: 'v1.10 public-demo site bundle', file: 'engine/src/public-demo/site-bundle.test.mjs' },
  { name: 'v1.10 public-demo leak check', file: 'engine/src/public-demo/leak-check.test.mjs' },
  { name: 'v1.10 public-demo predeploy check', file: 'engine/src/public-demo/predeploy-check.test.mjs' },
];

async function runModuleSuite(file) {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const previousTestEnv = process.env.TRADE_ARTIFACT_TEST;
  let output = '';
  let exitCode = 0;

  console.log = (...args) => { output += `${args.join(' ')}\n`; };
  console.error = (...args) => { output += `${args.join(' ')}\n`; };
  process.exit = code => {
    exitCode = code ?? 0;
    throw { __suiteExit: true, code: exitCode };
  };
  process.env.TRADE_ARTIFACT_TEST = '1';

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
    if (previousTestEnv === undefined) delete process.env.TRADE_ARTIFACT_TEST;
    else process.env.TRADE_ARTIFACT_TEST = previousTestEnv;
  }

  return { ok: exitCode === 0, output };
}

function summarizeOutput(output) {
  const normalized = output.replace(/\r/g, '');
  const resultMatch = normalized.match(/Result:\s*(PASS|FAIL)/i);
  const suiteMatch = normalized.match(/Suites run:\s*(\d+)\s*\nSuites failed:\s*(\d+)/i);
  if (suiteMatch) return `${suiteMatch[1]} suites run, ${suiteMatch[2]} failed${resultMatch ? `, ${resultMatch[1].toUpperCase()}` : ''}`;
  const ratioMatches = [...normalized.matchAll(/(\d+)\/(\d+) passed, (\d+) failed/g)];
  const ratioMatch = ratioMatches[ratioMatches.length - 1];
  if (ratioMatch) return `${ratioMatch[1]}/${ratioMatch[2]} passed, ${ratioMatch[3]} failed`;
  return 'completed';
}

console.log('Trade Artifact v1.10 Regression Runner');
console.log('Deterministic local suites only. No Git, Cloudflare, browser, deployment, DNS, mainnet, upload, mint, signing, account, database, or live network actions.');
console.log('');

let failures = 0;
const results = [];
for (const suite of SUITES) {
  const result = await runModuleSuite(suite.file);
  if (!result.ok) failures += 1;
  results.push({ ...suite, ...result, summary: summarizeOutput(result.output) });
}

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  ${result.summary}`);
  if (!result.ok && result.output.trim()) console.log(result.output.trim());
}

console.log('');
console.log(`Suites run: ${SUITES.length}`);
console.log(`Suites failed: ${failures}`);
console.log(`Result: ${failures === 0 ? 'PASS' : 'FAIL'}`);

process.exit(failures > 0 ? 1 : 0);