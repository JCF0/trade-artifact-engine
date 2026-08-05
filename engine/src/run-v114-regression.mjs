#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WALLET_ACQUISITION_ROOT = resolve(REPOSITORY_ROOT, 'engine/src/wallet-acquisition');
const BASELINE_RUNNER = resolve(REPOSITORY_ROOT, 'engine/src/run-v113-regression.mjs');
const SAFETY_SELF_CHECK = resolve(REPOSITORY_ROOT, 'engine/src/run-v114-regression.test.mjs');
const REQUIRED_WALLET_TESTS = Object.freeze([
  'retained-provider-acceptance.test.mjs',
  'candidate-set-integration.test.mjs',
]);
const CHILD_ENV = Object.freeze({
  TRADE_ARTIFACT_TEST: '1',
  HOME: '/nonexistent/trade-artifact-v114-regression-home',
  USERPROFILE: '/nonexistent/trade-artifact-v114-regression-home',
  TZ: 'UTC',
  LANG: 'C',
  LC_ALL: 'C',
});

function collectModules(root) {
  const modules = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) modules.push(...collectModules(path));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) modules.push(path);
  }
  return modules.sort();
}

function runNode(args, timeout = 300000) {
  return spawnSync(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: CHILD_ENV,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
}

function outputOf(result) {
  return `${result.stdout || ''}${result.stderr || ''}`.replace(/\r/g, '');
}

function parseTapSummary(output, label) {
  const value = name => {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`${label}: malformed TAP ${name} summary`);
    return Number(matches[0][1]);
  };
  const plans = [...output.matchAll(/^1\.\.(\d+)$/gm)];
  if (plans.length !== 1) throw new Error(`${label}: malformed TAP plan`);
  const summary = {
    tests: value('tests'),
    pass: value('pass'),
    fail: value('fail'),
    cancelled: value('cancelled'),
    skipped: value('skipped'),
    todo: value('todo'),
  };
  if (summary.tests !== Number(plans[0][1])
      || summary.tests !== summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo) {
    throw new Error(`${label}: inconsistent TAP counts`);
  }
  return summary;
}

function childSucceeded(result) {
  return result.status === 0 && result.signal === null && result.error === undefined;
}

function failureDetails(result) {
  const details = [];
  if (result.error) details.push(result.error.stack || result.error.message || String(result.error));
  if (result.signal) details.push(`terminated by signal ${result.signal}`);
  if (result.status !== null) details.push(`child exit status ${result.status}`);
  const output = outputOf(result).trim();
  if (output) details.push(output);
  return details.join('\n');
}

function runBaselineGate() {
  const result = runNode([BASELINE_RUNNER], 600000);
  const output = outputOf(result);
  const suites = [...output.matchAll(/^Suites run: (\d+)$/gm)].at(-1);
  const failures = [...output.matchAll(/^Suites failed: (\d+)$/gm)].at(-1);
  const final = [...output.matchAll(/^Result: (PASS|FAIL)$/gm)].at(-1);
  const parsed = suites !== undefined && failures !== undefined && final !== undefined;
  const ok = childSucceeded(result) && parsed && Number(failures[1]) === 0 && final[1] === 'PASS';
  return {
    name: 'safety-adapted v1.13 baseline gate',
    ok,
    summary: parsed ? `${suites[1]} suites, ${failures[1]} failed` : 'malformed baseline summary',
    details: ok ? '' : failureDetails(result),
  };
}

function runWalletAcquisitionGate() {
  const names = readdirSync(WALLET_ACQUISITION_ROOT)
    .filter(name => name.endsWith('.test.mjs'))
    .sort();
  for (const required of REQUIRED_WALLET_TESTS) {
    if (!names.includes(required)) throw new Error(`wallet-acquisition discovery omitted ${required}`);
  }
  const files = names.map(name => resolve(WALLET_ACQUISITION_ROOT, name));
  const result = runNode(['--test', ...files], 600000);
  let tap = null;
  let parseError = null;
  try { tap = parseTapSummary(outputOf(result), 'wallet-acquisition'); }
  catch (error) { parseError = error; }
  const ok = childSucceeded(result) && parseError === null && tap.fail === 0
    && tap.cancelled === 0 && tap.skipped === 0 && tap.todo === 0 && tap.pass === tap.tests;
  return {
    name: `complete wallet-acquisition suite (${names.length} files; includes retained-provider-acceptance.test.mjs and candidate-set-integration.test.mjs)`,
    ok,
    tap: tap ?? { tests: 0, pass: 0, fail: parseError === null ? 0 : 1, skipped: 0 },
    summary: tap === null ? parseError.message : `${tap.tests} tests, ${tap.pass} passed, ${tap.fail} failed, ${tap.skipped} skipped`,
    details: ok ? '' : [parseError?.stack || parseError?.message, failureDetails(result)].filter(Boolean).join('\n'),
  };
}

function runSyntaxGate() {
  const files = collectModules(WALLET_ACQUISITION_ROOT);
  const failures = [];
  for (const file of files) {
    const result = runNode(['--check', file], 30000);
    if (!childSucceeded(result)) failures.push({ file, details: failureDetails(result) });
  }
  return {
    name: 'wallet-acquisition production, test, and fixture-helper syntax',
    ok: failures.length === 0,
    passed: files.length - failures.length,
    failed: failures.length,
    summary: `${files.length - failures.length} files passed, ${failures.length} failed`,
    details: failures.map(item => `${item.file}\n${item.details}`).join('\n'),
  };
}

function runSafetySelfCheckGate() {
  const result = runNode(['--test', SAFETY_SELF_CHECK], 30000);
  let tap = null;
  let parseError = null;
  try { tap = parseTapSummary(outputOf(result), 'runner safety self-check'); }
  catch (error) { parseError = error; }
  const ok = childSucceeded(result) && parseError === null && tap.fail === 0
    && tap.cancelled === 0 && tap.skipped === 0 && tap.todo === 0 && tap.pass === tap.tests;
  return {
    name: 'runner and documentation consistency self-check',
    ok,
    summary: tap === null ? parseError.message : `${tap.tests} tests, ${tap.pass} passed, ${tap.fail} failed, ${tap.skipped} skipped`,
    details: ok ? '' : [parseError?.stack || parseError?.message, failureDetails(result)].filter(Boolean).join('\n'),
  };
}

console.log('Trade Artifact v1.14 Wallet-Wide Bounded Acquisition v1 Regression Runner');
console.log('Direct deterministic Node execution with a minimal child environment.');
console.log('No network, credentials, operator workflow, or external write capabilities are supplied.');
console.log('');

const results = [];
for (const gate of [runBaselineGate, runWalletAcquisitionGate, runSyntaxGate, runSafetySelfCheckGate]) {
  try { results.push(gate()); }
  catch (error) {
    results.push({ name: gate.name, ok: false, summary: 'gate threw', details: error.stack || error.message || String(error) });
  }
}

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  ${result.summary}`);
  if (!result.ok && result.details) console.log(result.details);
}

const baseline = results[0];
const wallet = results[1];
const syntax = results[2];
const failedGates = results.filter(result => !result.ok).length;
console.log('');
console.log(`v1.13 baseline gate: ${baseline.ok ? 'PASS' : 'FAIL'}`);
console.log(`wallet-acquisition tests run: ${wallet.tap?.tests ?? 0}`);
console.log(`wallet-acquisition tests passed: ${wallet.tap?.pass ?? 0}`);
console.log(`wallet-acquisition tests failed: ${wallet.tap?.fail ?? 0}`);
console.log(`wallet-acquisition tests skipped: ${wallet.tap?.skipped ?? 0}`);
console.log(`syntax files passed: ${syntax.passed ?? 0}`);
console.log(`syntax files failed: ${syntax.failed ?? 0}`);
console.log(`total gates passed: ${results.length - failedGates}`);
console.log(`total gates failed: ${failedGates}`);
console.log(`Final result: ${failedGates === 0 ? 'PASS' : 'FAIL'}`);

process.exit(failedGates === 0 ? 0 : 1);
