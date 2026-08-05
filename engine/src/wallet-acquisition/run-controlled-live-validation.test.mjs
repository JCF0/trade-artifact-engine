#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseControlledLiveValidationArgsV1,
  runControlledLiveValidationV1,
} from './run-controlled-live-validation.mjs';
import { fakePort, providerPublicKey } from './fixtures/slice4-fixtures.mjs';
import {
  JUP_WALLET_V1,
  USDC_MINT_V1,
  offlineWalletHistoryFixtureV1,
  syntheticEnhancedBodyV1,
} from './fixtures/retained-provider-fixtures.mjs';

const KEY_CANARY = 'operator-secret-canary-never-retain';
const EXACT_ARGS = Object.freeze({
  wallet: JUP_WALLET_V1,
  lookbackProfile: 'lookback_7d_v1',
  maxPages: 5,
  maxTransactions: 500,
  maxAttempts: 2,
  requestTimeoutMs: 20000,
  overallTimeoutMs: 120000,
});

function outputPath(root, name = 'report.json') { return join(root, name); }
function dependencies(port, overrides = {}) {
  return {
    walletHistoryPort: port,
    hasHeliusApiKey: () => true,
    apiKeyProvider: () => KEY_CANARY,
    ...overrides,
  };
}
async function runFixture(root, fixture, overrides = {}, name) {
  return runControlledLiveValidationV1(
    { ...EXACT_ARGS, reportPath: outputPath(root, name) },
    dependencies(fixture.port, overrides),
  );
}
function readReport(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function withTemp(t, fn) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-v114-operator-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return fn(root);
}

test('CLI parser requires the closed flag set and rejects unknown flags and historical end dates', () => {
  const argv = [
    '--wallet', JUP_WALLET_V1, '--lookback-profile', 'lookback_7d_v1', '--max-pages', '5',
    '--max-transactions', '500', '--max-attempts', '2', '--request-timeout-ms', '20000',
    '--overall-timeout-ms', '120000', '--report-path', '/tmp/artifact-v114-live-validation-report.json',
  ];
  assert.deepEqual(parseControlledLiveValidationArgsV1(argv), {
    ...EXACT_ARGS,
    reportPath: '/tmp/artifact-v114-live-validation-report.json',
  });
  assert.throws(() => parseControlledLiveValidationArgsV1([...argv, '--end-date', '2020-01-01']), error => error.code === 'invalid_validation_request');
  assert.throws(() => parseControlledLiveValidationArgsV1([...argv, '--unknown', 'x']), error => error.code === 'invalid_validation_request');
  assert.throws(() => parseControlledLiveValidationArgsV1(argv.slice(0, -2)), error => error.code === 'invalid_validation_request');
});

test('successful complete acquisition builds only in memory and emits one private sanitized report', t => withTemp(t, async root => {
  const fixture = offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1, retainedBodyNames: ['jup_buy', 'jup_sell'] });
  const path = outputPath(root);
  const result = await runFixture(root, fixture);
  const report = readReport(path);
  assert.equal(result.status, 'pass');
  assert.equal(report.status, 'pass');
  assert.equal(report.in_window_transaction_count, 2);
  assert.equal(report.enhanced_transactions_reconciled, 2);
  assert.equal(report.normalized_event_count, 2);
  assert.match(report.acquisition_result_digest, /^[0-9a-f]{64}$/);
  assert.match(report.evidence_bundle_digest, /^[0-9a-f]{64}$/);
  assert.match(report.candidate_set_digest, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8').includes(KEY_CANARY), false);
}));

test('zero candidates is a passing validation without Slice 7', t => withTemp(t, async root => {
  let orchestrationCalls = 0;
  const result = await runControlledLiveValidationV1(
    { ...EXACT_ARGS, reportPath: outputPath(root) },
    dependencies(fakePort({ pages: [[]] }), { orchestrateTargeted: async () => { orchestrationCalls += 1; } }),
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.report.candidate_count, 0);
  assert.equal(result.report.selectable_candidate_count, 0);
  assert.equal(orchestrationCalls, 0);
}));

test('exactly one selectable clean closed candidate resolves and dry-runs with empty ports only', t => withTemp(t, async root => {
  const fixture = offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1, retainedBodyNames: ['jup_buy', 'jup_sell'] });
  let portsSeen = null;
  const result = await runFixture(root, fixture, {
    orchestrateTargeted: async (request, ports) => {
      portsSeen = ports;
      assert.equal(request.mode, 'dry_run');
      assert.equal(Object.hasOwn(request.target, 'expected_receipt_hash'), false);
      return { status: 'dry_run', receipt_hash: 'a'.repeat(64), package_digest: 'b'.repeat(64) };
    },
  });
  assert.deepEqual(portsSeen, {});
  assert.equal(result.report.dry_run_receipt_hash, 'a'.repeat(64));
  assert.equal(result.report.dry_run_package_digest, 'b'.repeat(64));
}));

test('multiple selectable candidates are reported without automatic selection', t => withTemp(t, async root => {
  const secondToken = providerPublicKey('operator-second-candidate');
  const bodies = [
    syntheticEnhancedBodyV1({ label: 'operator-second-buy', wallet: JUP_WALLET_V1, slot: 428001220, timestamp: 1782068824, outputMint: secondToken, outputRaw: '5000000' }),
    syntheticEnhancedBodyV1({ label: 'operator-second-sell', wallet: JUP_WALLET_V1, slot: 428001221, timestamp: 1782068825, inputMint: secondToken, inputRaw: '5000000', outputMint: USDC_MINT_V1, outputRaw: '12000000' }),
  ];
  const fixture = offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1, retainedBodyNames: ['jup_buy', 'jup_sell'], syntheticBodies: bodies });
  let orchestrationCalls = 0;
  const result = await runFixture(root, fixture, { orchestrateTargeted: async () => { orchestrationCalls += 1; } });
  assert.equal(result.report.selectable_candidate_count, 2);
  assert.equal(result.report.selectable_candidates.length, 2);
  assert.equal(orchestrationCalls, 0);
}));

for (const [name, code, expected] of [
  ['capped acquisition', 'acquisition_capped', 'acquisition_capped'],
  ['timeout', 'acquisition_deadline_exceeded', 'acquisition_deadline_exceeded'],
  ['provider uncertainty', 'provider_uncertain', 'provider_uncertain'],
]) {
  test(`${name} fails safely without canonical downstream output`, t => withTemp(t, async root => {
    const fixture = offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1 });
    fixture.port.getNetworkIdentityV1 = async () => { throw Object.assign(new Error('hostile provider prose'), { code }); };
    const result = await runFixture(root, fixture);
    assert.equal(result.status, 'safe_failure');
    assert.equal(result.report.error_code, expected);
    for (const field of ['acquisition_result_digest','evidence_bundle_digest','candidate_set_digest']) assert.equal(Object.hasOwn(result.report, field), false);
  }));
}

test('wallet-wide ambiguity fails before evidence and candidate construction', t => withTemp(t, async root => {
  const body = syntheticEnhancedBodyV1({ label: 'operator-wallet-wide', wallet: JUP_WALLET_V1, slot: 428001220, timestamp: 1782068824, type: 'TRANSFER', selfTransfer: true, omitSelfTransferMint: true, recognizedProgram: false });
  const fixture = offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1, syntheticBodies: [body] });
  const result = await runFixture(root, fixture);
  assert.equal(result.status, 'safe_failure');
  assert.equal(result.report.error_code, 'wallet_wide_impact_unresolved');
  assert.equal(Object.hasOwn(result.report, 'evidence_bundle_digest'), false);
}));

test('forbidden repository output path is rejected before credential presence is checked', async () => {
  let checked = false;
  await assert.rejects(runControlledLiveValidationV1(
    { ...EXACT_ARGS, reportPath: join(process.cwd(), 'forbidden-report.json') },
    { hasHeliusApiKey: () => { checked = true; return true; }, apiKeyProvider: () => KEY_CANARY },
  ), error => error.code === 'report_path_forbidden');
  assert.equal(checked, false);
});

test('key absence emits only a fixed sanitized failure and never invokes acquisition', t => withTemp(t, async root => {
  let portTouched = false;
  const result = await runControlledLiveValidationV1(
    { ...EXACT_ARGS, reportPath: outputPath(root) },
    {
      hasHeliusApiKey: () => false,
      apiKeyProvider: () => KEY_CANARY,
      walletHistoryPort: new Proxy({}, { get() { portTouched = true; throw new Error(KEY_CANARY); } }),
    },
  );
  const bytes = readFileSync(outputPath(root), 'utf8');
  assert.equal(result.report.error_code, 'api_key_unavailable');
  assert.equal(portTouched, false);
  assert.equal(bytes.includes(KEY_CANARY), false);
}));

test('hostile thrown errors, key values, provider prose, URLs, paths, and stacks never enter output', t => withTemp(t, async root => {
  const fixture = offlineWalletHistoryFixtureV1({ wallet: JUP_WALLET_V1 });
  fixture.port.getNetworkIdentityV1 = async () => {
    const error = new Error(`${KEY_CANARY} https://provider.invalid/?api-key=x /root/private stack prose`);
    error.details = { raw: KEY_CANARY };
    throw error;
  };
  const result = await runFixture(root, fixture);
  const bytes = readFileSync(outputPath(root), 'utf8');
  assert.equal(result.report.error_code, 'provider_uncertain');
  for (const forbidden of [KEY_CANARY, 'https://', '/root/', 'stack prose', 'api-key']) assert.equal(bytes.includes(forbidden), false);
}));

test('production operator imports no store, signer, uploader, minter, deployment, API, UI, or hosted-job module', () => {
  const source = readFileSync(new URL('./run-controlled-live-validation.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm)].map(match => match[1]);
  for (const specifier of imports) {
    assert.doesNotMatch(specifier, /\/(?:[^/]*(?:store|upload|signer|mint|deploy|api|ui|hosted|public-demo|archive|economics)[^/]*)\//i);
  }
  assert.doesNotMatch(source, /packageStore|expected_receipt_hash|mode\s*:\s*['"]commit['"]/);
});
