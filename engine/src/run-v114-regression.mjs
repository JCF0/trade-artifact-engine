#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const WALLET_ACQUISITION_ROOT = resolve(REPOSITORY_ROOT, 'engine/src/wallet-acquisition');
const BASELINE_RUNNER = resolve(REPOSITORY_ROOT, 'engine/src/run-v113-regression.mjs');
const SAFETY_SELF_CHECK = resolve(REPOSITORY_ROOT, 'engine/src/run-v114-regression.test.mjs');
const REQUIRED_WALLET_TESTS = Object.freeze([
  'candidate-set-integration.test.mjs',
  'retained-provider-acceptance.test.mjs',
  'run-controlled-live-validation.test.mjs',
]);
const FORBIDDEN_TRACKED_LIVE_REPORT_PATHS = new Set([
  'engine/docs/validation_report.md',
  'engine/docs/validation_report_batch2.md',
]);
const SANCTIONED_LIVE_REPORT_BASENAMES = new Set(['artifact-v114-live-validation-report.json']);
const CHILD_ENV = Object.freeze({
  TRADE_ARTIFACT_TEST: '1', HOME: '/nonexistent/trade-artifact-v114-regression-home',
  USERPROFILE: '/nonexistent/trade-artifact-v114-regression-home', TZ: 'UTC', LANG: 'C', LC_ALL: 'C',
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

export function discoverWalletAcquisitionTestsV1(root = WALLET_ACQUISITION_ROOT) {
  let canonicalRoot;
  try { canonicalRoot = realpathSync(root); } catch { throw new Error('wallet-acquisition discovery root is not allowed'); }
  if (canonicalRoot !== realpathSync(WALLET_ACQUISITION_ROOT)) throw new Error('wallet-acquisition discovery root is not allowed');
  const names = readdirSync(canonicalRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => entry.name).sort();
  if (new Set(names).size !== names.length) throw new Error('wallet-acquisition discovery contains duplicates');
  for (const required of REQUIRED_WALLET_TESTS) {
    if (!names.includes(required)) throw new Error(`wallet-acquisition discovery omitted ${required}`);
  }
  return Object.freeze(names.map(name => realpathSync(resolve(canonicalRoot, name))));
}

export function validateWalletTestExecutionSetV1(discovered, executed) {
  if (!Array.isArray(discovered) || !Array.isArray(executed)) throw new Error('wallet-acquisition execution set is malformed');
  const canonicalRoot = realpathSync(WALLET_ACQUISITION_ROOT);
  const canonicalize = file => {
    if (typeof file !== 'string' || !file.endsWith('.test.mjs')) throw new Error('wallet-acquisition execution set contains an unexpected file');
    let canonical;
    try { canonical = realpathSync(file); } catch { throw new Error('wallet-acquisition execution set contains an unexpected file'); }
    const suffix = relative(canonicalRoot, canonical);
    if (suffix === '' || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('wallet-acquisition execution set contains an unexpected file');
    return canonical;
  };
  const canonicalDiscovered = discovered.map(canonicalize).sort();
  const canonicalExecuted = executed.map(canonicalize).sort();
  if (new Set(canonicalDiscovered).size !== canonicalDiscovered.length || new Set(canonicalExecuted).size !== canonicalExecuted.length) throw new Error('wallet-acquisition file executed twice');
  if (canonicalDiscovered.length !== canonicalExecuted.length || canonicalDiscovered.some((file, index) => file !== canonicalExecuted[index])) throw new Error('wallet-acquisition execution set mismatch');
  return true;
}

export function validateTrackedLiveReportPathsV1(trackedPaths) {
  if (!Array.isArray(trackedPaths)) throw new Error('tracked path set is malformed');
  for (const path of trackedPaths) {
    if (typeof path !== 'string' || FORBIDDEN_TRACKED_LIVE_REPORT_PATHS.has(path)
        || SANCTIONED_LIVE_REPORT_BASENAMES.has(basename(path))) {
      throw new Error('tracked live-derived report path is forbidden');
    }
  }
  return true;
}

function runNode(args, timeout = 300000) {
  return spawnSync(process.execPath, args, {
    cwd: REPOSITORY_ROOT, encoding: 'utf8', env: CHILD_ENV,
    maxBuffer: 64 * 1024 * 1024, timeout,
  });
}
function outputOf(result) { return `${result.stdout || ''}${result.stderr || ''}`.replace(/\r/g, ''); }
function childSucceeded(result) { return result.status === 0 && result.signal === null && result.error === undefined; }
function failureDetails(result) {
  const details = [];
  if (result.error) details.push(result.error.stack || result.error.message || String(result.error));
  if (result.signal) details.push(`terminated by signal ${result.signal}`);
  if (result.status !== null) details.push(`child exit status ${result.status}`);
  const output = outputOf(result).trim();
  if (output) details.push(output);
  return details.join('\n');
}

export function parseTopLevelTapV1(output, label = 'TAP stream') {
  if (typeof output !== 'string' || !output.endsWith('\n')) throw new Error(`${label}: truncated TAP`);
  const lines = output.replace(/\r/g, '').split('\n');
  const plans = [];
  const records = [];
  const summaries = new Map();
  let planLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const plan = /^1\.\.(\d+)$/.exec(line);
    if (plan) { plans.push(Number(plan[1])); planLine = index; continue; }
    const record = /^(ok|not ok)\s+(\d+)(?:\s+-\s+.*)?$/.exec(line);
    if (record) {
      if (planLine !== -1) throw new Error(`${label}: result after TAP plan`);
      const directive = /\s+#\s*(SKIP|TODO|CANCELLED)\b/i.exec(line)?.[1]?.toLowerCase() ?? null;
      records.push({ ok: record[1] === 'ok', ordinal: Number(record[2]), directive });
      continue;
    }
    const summary = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (summary) {
      if (summaries.has(summary[1])) throw new Error(`${label}: duplicate TAP ${summary[1]} summary`);
      summaries.set(summary[1], Number(summary[2]));
      continue;
    }
    if (line === '' || line === 'TAP version 13' || /^\s/.test(line) || line.startsWith('#')) continue;
    throw new Error(`${label}: malformed top-level TAP record`);
  }
  if (plans.length !== 1) throw new Error(`${label}: expected exactly one TAP plan`);
  for (const name of ['tests','pass','fail','cancelled','skipped','todo']) {
    if (!summaries.has(name)) throw new Error(`${label}: missing TAP ${name} summary`);
  }
  const planned = plans[0];
  if (records.length !== planned) throw new Error(`${label}: TAP plan/result count mismatch`);
  const ordinals = records.map(record => record.ordinal);
  if (new Set(ordinals).size !== ordinals.length) throw new Error(`${label}: duplicate TAP result ordinal`);
  if (!ordinals.every((ordinal, index) => ordinal === index + 1)) throw new Error(`${label}: TAP result ordinals are not dense and sequential`);
  const actual = {
    tests: records.length,
    pass: records.filter(record => record.ok && record.directive === null).length,
    fail: records.filter(record => !record.ok && record.directive === null).length,
    skipped: records.filter(record => record.directive === 'skip').length,
    todo: records.filter(record => record.directive === 'todo').length,
    cancelled: records.filter(record => record.directive === 'cancelled').length,
  };
  for (const [name, value] of Object.entries(actual)) {
    if (summaries.get(name) !== value) throw new Error(`${label}: inconsistent TAP ${name} summary`);
  }
  if (actual.tests !== actual.pass + actual.fail + actual.skipped + actual.todo + actual.cancelled) {
    throw new Error(`${label}: inconsistent TAP counts`);
  }
  if (actual.fail !== 0 || actual.skipped !== 0 || actual.todo !== 0 || actual.cancelled !== 0) {
    throw new Error(`${label}: TAP contains a prohibited non-passing result`);
  }
  return Object.freeze(actual);
}

function strictTapChild(file, label, timeout = 600000) {
  const result = runNode(['--test', file], timeout);
  let tap = null;
  let parseError = null;
  try { tap = parseTopLevelTapV1(outputOf(result), label); } catch (error) { parseError = error; }
  const cleanTap = parseError === null && tap.fail === 0 && tap.cancelled === 0
    && tap.skipped === 0 && tap.todo === 0 && tap.pass === tap.tests;
  const ok = childSucceeded(result) && cleanTap;
  return { ok, tap, details: ok ? '' : [parseError?.stack || parseError?.message, failureDetails(result)].filter(Boolean).join('\n') };
}

function runBaselineGate() {
  const result = runNode([BASELINE_RUNNER], 600000);
  const output = outputOf(result);
  const suites = [...output.matchAll(/^Suites run: (\d+)$/gm)].at(-1);
  const failures = [...output.matchAll(/^Suites failed: (\d+)$/gm)].at(-1);
  const final = [...output.matchAll(/^Result: (PASS|FAIL)$/gm)].at(-1);
  const parsed = suites !== undefined && failures !== undefined && final !== undefined;
  const ok = childSucceeded(result) && parsed && Number(failures[1]) === 0 && final[1] === 'PASS';
  return { name: 'safety-adapted v1.13 baseline gate', ok,
    suites: parsed ? Number(suites[1]) : 0,
    summary: parsed ? `${suites[1]} suites, ${failures[1]} failed` : 'malformed baseline summary',
    details: ok ? '' : failureDetails(result) };
}

function runWalletAcquisitionGate() {
  const files = discoverWalletAcquisitionTestsV1();
  const seen = new Set();
  const children = [];
  for (const file of files) {
    if (seen.has(file)) throw new Error(`wallet-acquisition file executed twice: ${file}`);
    seen.add(file);
    children.push({ file, ...strictTapChild(file, `wallet-acquisition ${file}`) });
  }
  validateWalletTestExecutionSetV1(files, children.map(child => child.file));
  const totals = children.reduce((sum, child) => {
    for (const name of ['tests','pass','fail','cancelled','skipped','todo']) sum[name] += child.tap?.[name] ?? 0;
    return sum;
  }, { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  const ok = children.every(child => child.ok);
  return { name: 'exact per-file wallet-acquisition gate', ok, files: files.length, tap: totals,
    summary: `${files.length} files; ${totals.tests} internal tests, ${totals.pass} passed, ${totals.fail} failed`,
    details: children.filter(child => !child.ok).map(child => `${child.file}\n${child.details}`).join('\n') };
}

function runSyntaxGate() {
  const files = collectModules(WALLET_ACQUISITION_ROOT);
  const failures = [];
  for (const file of files) {
    const result = runNode(['--check', file], 30000);
    if (!childSucceeded(result)) failures.push({ file, details: failureDetails(result) });
  }
  return { name: 'wallet-acquisition production, test, and fixture-helper syntax', ok: failures.length === 0,
    passed: files.length - failures.length, failed: failures.length,
    summary: `${files.length - failures.length} files passed, ${failures.length} failed`,
    details: failures.map(item => `${item.file}\n${item.details}`).join('\n') };
}

function runSafetySelfCheckGate() {
  const child = strictTapChild(SAFETY_SELF_CHECK, 'runner safety self-check', 30000);
  return { name: 'runner and documentation consistency self-check', ...child,
    summary: child.tap === null ? 'malformed self-check TAP' : `${child.tap.tests} self-check records, ${child.tap.pass} passed` };
}

export function runV114RegressionV1() {
  console.log('Trade Artifact v1.14 Wallet-Wide Bounded Acquisition v1 Regression Runner');
  console.log('Direct deterministic Node execution with a minimal child environment.');
  console.log('No live operator command or production/package-store/publication write is executed.');
  console.log('Offline controlled-live operator tests use injected ports and may create isolated temporary sanitized report fixtures.');
  console.log('');
  const results = [];
  for (const gate of [runBaselineGate, runWalletAcquisitionGate, runSyntaxGate, runSafetySelfCheckGate]) {
    try { results.push(gate()); }
    catch (error) { results.push({ name: gate.name, ok: false, summary: 'gate threw', details: error.stack || error.message || String(error) }); }
  }
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  ${result.summary}`);
    if (!result.ok && result.details) console.log(result.details);
  }
  const baseline = results[0]; const wallet = results[1]; const syntax = results[2]; const selfCheck = results[3];
  const failedGates = results.filter(result => !result.ok).length;
  console.log('');
  console.log(`safety-adapted v1.13 baseline suites: ${baseline.suites ?? 0}`);
  console.log(`wallet-acquisition test files: ${wallet.files ?? 0}`);
  console.log(`wallet-acquisition internal test records: ${wallet.tap?.tests ?? 0}`);
  console.log(`wallet-acquisition internal tests passed: ${wallet.tap?.pass ?? 0}`);
  console.log(`wallet-acquisition internal tests failed: ${wallet.tap?.fail ?? 0}`);
  console.log(`syntax files passed: ${syntax.passed ?? 0}`);
  console.log(`syntax files failed: ${syntax.failed ?? 0}`);
  console.log(`self-check records: ${selfCheck.tap?.tests ?? 0}`);
  console.log(`self-check gate: ${selfCheck.ok ? 'PASS' : 'FAIL'}`);
  console.log(`total gates passed: ${results.length - failedGates}`);
  console.log(`total gates failed: ${failedGates}`);
  console.log(`Final result: ${failedGates === 0 ? 'PASS' : 'FAIL'}`);
  return failedGates === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(runV114RegressionV1());
