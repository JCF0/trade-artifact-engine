#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { canonicalJson } from '../verification-scope-v1-3/contract.mjs';
import {
  CLASSIC_TOKEN_PROGRAM_V0,
  TOKEN_2022_PROGRAM_V0,
  runHeliusOwnerEnumerationCompatibilityProbeV0,
} from './helius-owner-enumeration-compatibility-probe-v0.mjs';

const RPC_ORIGIN = 'https://mainnet.helius-rpc.com/';
const REPOSITORY_ROOT = realpathSync(new URL('../../../', import.meta.url));
const REQUIRED_ENVIRONMENT_FIELDS = Object.freeze([
  'HELIUS_API_KEY',
  'HELIUS_PLAN_PROFILE',
  'HELIUS_EMPTY_CONTROL_WALLET',
  'HELIUS_KNOWN_CONTROL_WALLET',
  'HELIUS_EXPECTED_CLASSIC_ACCOUNTS_JSON',
  'HELIUS_EXPECTED_TOKEN_2022_ACCOUNTS_JSON',
]);

class RunnerError extends Error {
  constructor(code) {
    super(code.replaceAll('_', ' '));
    this.name = 'HeliusOwnerEnumerationProbeRunnerError';
    this.code = code;
    delete this.stack;
  }
}
function fail(code) { throw new RunnerError(code); }
function isInside(path, root) {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}
function validateReportPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('report_path_forbidden');
  const target = resolve(path);
  let parent;
  try { parent = realpathSync(dirname(target)); } catch { fail('report_path_forbidden'); }
  const resolvedTarget = resolve(parent, target.slice(dirname(target).length + 1));
  const temporaryRoot = realpathSync(tmpdir());
  if (!isInside(resolvedTarget, temporaryRoot) || isInside(resolvedTarget, REPOSITORY_ROOT)) fail('report_path_forbidden');
  if (existsSync(resolvedTarget)) fail('report_path_unavailable');
  return resolvedTarget;
}
function writeReport(path, report) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, canonicalJson(report), { encoding: 'utf8' });
    fsyncSync(descriptor);
  } catch {
    fail('report_path_unavailable');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
function exactOptions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join('\0') !== 'execute_authorized_live_probe\0report_path'
      || value.execute_authorized_live_probe !== true || typeof value.report_path !== 'string') {
    fail('invalid_probe_request');
  }
  return value;
}
export function parseHeliusOwnerEnumerationProbeArgsV0(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== '--execute-authorized-live-probe'
      || argv[1] !== '--report-path' || typeof argv[2] !== 'string' || argv[2].length === 0) {
    fail('invalid_probe_request');
  }
  return { execute_authorized_live_probe: true, report_path: argv[2] };
}
function ownEnvironmentValue(environment, name) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
      fail('required_environment_unavailable');
    }
    return descriptor.value;
  } catch (error) {
    if (error?.code === 'required_environment_unavailable') throw error;
    fail('required_environment_unavailable');
  }
}
function parseAccountSet(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { fail('required_environment_invalid'); }
  if (!Array.isArray(value)) fail('required_environment_invalid');
  return value;
}
function readConfiguration(environment) {
  if (environment === null || typeof environment !== 'object') fail('required_environment_unavailable');
  const values = Object.fromEntries(REQUIRED_ENVIRONMENT_FIELDS.map(name => [name, ownEnvironmentValue(environment, name)]));
  return {
    apiKey: values.HELIUS_API_KEY,
    input: {
      empty_control_wallet: values.HELIUS_EMPTY_CONTROL_WALLET,
      known_control_wallet: values.HELIUS_KNOWN_CONTROL_WALLET,
      expected_accounts: {
        [CLASSIC_TOKEN_PROGRAM_V0]: parseAccountSet(values.HELIUS_EXPECTED_CLASSIC_ACCOUNTS_JSON),
        [TOKEN_2022_PROGRAM_V0]: parseAccountSet(values.HELIUS_EXPECTED_TOKEN_2022_ACCOUNTS_JSON),
      },
      known_control_repetitions: 10,
      helius_plan_profile: values.HELIUS_PLAN_PROFILE,
    },
  };
}
function productionSleep(milliseconds) { return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)); }
function createHttpRequest(fetchCapability, apiKey) {
  return async function request(input) {
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    try {
      const fetchPromise = Promise.resolve().then(() => fetchCapability(`${RPC_ORIGIN}?api-key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.body),
        signal: controller.signal,
      }));
      const timeoutPromise = new Promise((resolveTimeout, rejectTimeout) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          rejectTimeout(Object.freeze({ code: 'request_timeout' }));
        }, input.timeout_ms);
      });
      const response = await Promise.race([fetchPromise, timeoutPromise]);
      if (timedOut || controller.signal.aborted) throw Object.freeze({ code: 'request_timeout' });
      const text = await Promise.race([response.text(), timeoutPromise]);
      if (timedOut || controller.signal.aborted) throw Object.freeze({ code: 'request_timeout' });
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      return {
        status: response.status,
        data,
        raw_body_sha256: createHash('sha256').update(text).digest('hex'),
      };
    } catch (error) {
      if (error?.code === 'request_timeout' || timedOut || error?.name === 'AbortError') {
        throw Object.freeze({ code: 'request_timeout' });
      }
      throw Object.freeze({ code: 'transport_failed' });
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function runHeliusOwnerEnumerationProbeFromEnvironmentV0(optionInput, dependencyInput = {}) {
  const options = exactOptions(optionInput);
  const reportPath = validateReportPath(options.report_path);
  const dependencies = dependencyInput !== null && typeof dependencyInput === 'object' ? dependencyInput : {};
  const environment = dependencies.environment ?? process.env;
  const configuration = readConfiguration(environment);
  const fetchCapability = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchCapability !== 'function') fail('transport_unavailable');
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(configuration.input, {
    request: createHttpRequest(fetchCapability, configuration.apiKey),
    clock: dependencies.clock ?? (() => performance.now()),
    sleep: dependencies.sleep ?? productionSleep,
  });
  writeReport(reportPath, report);
  return Object.freeze({ status: report.verdict, report });
}

async function main() {
  try {
    const options = parseHeliusOwnerEnumerationProbeArgsV0(process.argv.slice(2));
    const result = await runHeliusOwnerEnumerationProbeFromEnvironmentV0(options);
    process.stdout.write(`VERDICT ${result.report.verdict}\n`);
    process.stdout.write(`OBSERVED_COMPATIBILITY ${result.report.observed_compatibility.verdict}\n`);
    process.stdout.write(`REPORT ${options.report_path}\n`);
    return result.report.verdict === 'FAIL' ? 1 : 2;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'probe_runner_failed';
    process.stderr.write(`PROBE_NOT_RUN ${code}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
