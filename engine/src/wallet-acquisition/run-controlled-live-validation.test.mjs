#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONTROLLED_LIVE_VALIDATION_VERSION_V1,
  CONTROLLED_LIVE_VALIDATION_VERSION_V2,
  CONTROLLED_LIVE_VALIDATION_VERSION_V3,
  parseControlledLiveValidationArgsV1,
  runControlledLiveValidationV1,
} from './run-controlled-live-validation.mjs';
import {
  contextualizeWalletAcquisitionErrorV1,
  failWalletAcquisitionOperationV1,
} from './provider-port.mjs';
import { createWalletHistoryPortV2 } from './provider-port-v2.mjs';
import {
  JUP_WALLET_V1,
} from './fixtures/retained-provider-fixtures.mjs';
import { offlineFullTransactionHistoryFixtureV2 } from './fixtures/retained-full-transaction-fixtures.mjs';

const KEY_CANARY = 'operator-secret-canary-never-retain';
const EXACT_ARGS = Object.freeze({
  wallet: JUP_WALLET_V1,
  lookbackProfile: 'lookback_7d_v1',
  maxPages: 5,
  maxTransactions: 500,
  maxAttempts: 2,
  requestTimeoutMs: 20000,
  overallTimeoutMs: 120000,
  maxExactFallbackTransactions: 0,
});

function outputPath(root, name = 'report.json') { return join(root, name); }
function dependencies(port, overrides = {}) {
  return {
    walletHistoryPort: createWalletHistoryPortV2(port, { beginAcquisitionV2() {} }),
    hasHeliusApiKey: () => true,
    apiKeyProvider: () => KEY_CANARY,
    ...overrides,
  };
}
function fullFixture(names = ['jup_buy_full','jup_sell_full']) {
  return offlineFullTransactionHistoryFixtureV2({ wallet: JUP_WALLET_V1, retainedBodyNames: names });
}
function emptyPort() {
  return {
    async getNetworkIdentityV1() { return { chain: 'solana', network: 'mainnet-beta', genesis_hash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }; },
    async getFinalizedSlotV1() { return 100; },
    async getFinalizedBlockV1({ slot }) { return { slot, block_time: 2000000000, blockhash: '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh', commitment: 'finalized' }; },
    async getFinalizedWalletSignaturePageV1() { return []; },
    async getFinalizedFullTransactionPageV1() { return { transactions: [], pagination_token: null }; },
    async getFinalizedTransactionV1() { return null; },
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
  assert.equal(CONTROLLED_LIVE_VALIDATION_VERSION_V1, 'artifact_v1.14_controlled_live_validation_v1');
  assert.equal(CONTROLLED_LIVE_VALIDATION_VERSION_V2, 'artifact_v1.14_controlled_live_validation_v2');
  assert.equal(CONTROLLED_LIVE_VALIDATION_VERSION_V3, 'artifact_v1.15_controlled_live_validation_v1');
  const argv = [
    '--wallet', JUP_WALLET_V1, '--lookback-profile', 'lookback_7d_v1', '--max-pages', '5',
    '--max-transactions', '500', '--max-attempts', '2', '--request-timeout-ms', '20000',
    '--overall-timeout-ms', '120000', '--max-exact-fallback-transactions', '0',
    '--report-path', '/tmp/artifact-v115-live-validation-report.json',
  ];
  assert.deepEqual(parseControlledLiveValidationArgsV1(argv), {
    ...EXACT_ARGS,
    reportPath: '/tmp/artifact-v115-live-validation-report.json',
  });
  assert.throws(() => parseControlledLiveValidationArgsV1([...argv, '--end-date', '2020-01-01']), error => error.code === 'invalid_validation_request');
  assert.throws(() => parseControlledLiveValidationArgsV1([...argv, '--unknown', 'x']), error => error.code === 'invalid_validation_request');
  assert.throws(() => parseControlledLiveValidationArgsV1(argv.slice(0, -2)), error => error.code === 'invalid_validation_request');
});

test('successful complete acquisition builds only in memory and emits one private sanitized report', t => withTemp(t, async root => {
  const fixture = fullFixture();
  const path = outputPath(root);
  const result = await runFixture(root, fixture);
  const report = readReport(path);
  assert.equal(result.status, 'pass');
  assert.equal(report.status, 'pass');
  assert.equal(report.in_window_transaction_count, 2);
  assert.equal(report.full_transactions_reconciled, 2);
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
    dependencies(emptyPort(), { orchestrateTargeted: async () => { orchestrationCalls += 1; } }),
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.report.candidate_count, 0);
  assert.equal(result.report.selectable_candidate_count, 0);
  assert.equal(orchestrationCalls, 0);
}));

test('exactly one selectable clean closed candidate resolves and dry-runs with empty ports only', t => withTemp(t, async root => {
  const fixture = fullFixture();
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


for (const [name, code, expected] of [
  ['capped acquisition', 'acquisition_capped', 'acquisition_capped'],
  ['timeout', 'acquisition_deadline_exceeded', 'acquisition_deadline_exceeded'],
  ['provider uncertainty', 'provider_uncertain', 'provider_uncertain'],
]) {
  test(`${name} fails safely without canonical downstream output`, t => withTemp(t, async root => {
    const fixture = fullFixture(['jup_buy_full']);
    fixture.port.getNetworkIdentityV1 = async () => { throw Object.assign(new Error('hostile provider prose'), { code }); };
    const result = await runFixture(root, fixture);
    assert.equal(result.status, 'safe_failure');
    assert.equal(result.report.error_code, expected);
    assert.equal(Object.hasOwn(result.report, 'failure_diagnostic'), false);
    for (const field of ['acquisition_result_digest','evidence_bundle_digest','candidate_set_digest']) assert.equal(Object.hasOwn(result.report, field), false);
  }));
}

test('wallet-wide ambiguity fails before evidence and candidate construction', t => withTemp(t, async root => {
  const fixture = fullFixture(['jupiter_close_account_full']);
  const result = await runFixture(root, fixture);
  assert.equal(result.status, 'safe_failure');
  assert.equal(result.report.error_code, 'wallet_wide_impact_unresolved');
  assert.deepEqual(result.report.failure_diagnostic, {
    diagnostic_version: 'controlled_live_failure_diagnostic_v1',
    stage: 'wallet_wide_classification',
    operation: 'transaction_classification',
    reason: 'multiple_unresolved_classes',
    underlying_reasons: ['unknown_token_scope', 'unmatched_wallet_instruction'],
  });
  assert.equal(Object.hasOwn(result.report, 'evidence_bundle_digest'), false);
}));

test('forged wallet-wide provenance cannot inject arbitrary report values', t => withTemp(t, async root => {
  const hostile = `${KEY_CANARY} https://provider.invalid /root/private unrestricted`;
  const result = await runControlledLiveValidationV1(
    { ...EXACT_ARGS, reportPath: outputPath(root) },
    dependencies(emptyPort(), {
      acquireWalletHistory: async () => {
        const error = Object.assign(new Error(hostile), {
          code: 'wallet_wide_impact_unresolved',
          failure_diagnostic: {
            diagnostic_version: hostile,
            stage: hostile,
            operation: hostile,
            reason: hostile,
            underlying_reasons: ['native_balance_unreconciled', hostile],
          },
          details: { reason: hostile },
        });
        throw error;
      },
    }),
  );
  const bytes = readFileSync(outputPath(root), 'utf8');
  assert.equal(result.report.error_code, 'wallet_wide_impact_unresolved');
  assert.equal(Object.hasOwn(result.report, 'failure_diagnostic'), false);
  for (const forbidden of [KEY_CANARY, 'https://', '/root/', 'unrestricted']) {
    assert.equal(bytes.includes(forbidden), false);
  }

  const invalidTrustedReason = await runControlledLiveValidationV1(
    { ...EXACT_ARGS, reportPath: outputPath(root, 'invalid-trusted-reason.json') },
    dependencies(emptyPort(), {
      acquireWalletHistory: async () => {
        failWalletAcquisitionOperationV1('wallet_wide_impact_unresolved', hostile);
      },
    }),
  );
  const invalidBytes = readFileSync(outputPath(root, 'invalid-trusted-reason.json'), 'utf8');
  assert.equal(invalidTrustedReason.report.error_code, 'wallet_wide_impact_unresolved');
  assert.equal(Object.hasOwn(invalidTrustedReason.report, 'failure_diagnostic'), false);
  for (const forbidden of [KEY_CANARY, 'https://', '/root/', 'unrestricted']) {
    assert.equal(invalidBytes.includes(forbidden), false);
  }
}));

test('trusted multiple wallet-wide provenance emits only the fixed sorted unique reason set', t => withTemp(t, async root => {
  const result = await runControlledLiveValidationV1(
    { ...EXACT_ARGS, reportPath: outputPath(root) },
    dependencies(emptyPort(), {
      acquireWalletHistory: async () => {
        failWalletAcquisitionOperationV1(
          'wallet_wide_impact_unresolved',
          'multiple_unresolved_classes',
          ['unmatched_wallet_instruction', 'native_balance_unreconciled', 'unmatched_wallet_instruction'],
        );
      },
    }),
  );
  assert.deepEqual(result.report.failure_diagnostic, {
    diagnostic_version: 'controlled_live_failure_diagnostic_v1',
    stage: 'wallet_wide_classification',
    operation: 'transaction_classification',
    reason: 'multiple_unresolved_classes',
    underlying_reasons: ['native_balance_unreconciled', 'unmatched_wallet_instruction'],
  });
  assert.deepEqual(Object.keys(result.report.failure_diagnostic).sort(), [
    'diagnostic_version', 'operation', 'reason', 'stage', 'underlying_reasons',
  ]);
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

test('report creation is unique and exclusive and never overwrites an existing report', t => withTemp(t, async root => {
  const reportPath = outputPath(root);
  const options = { ...EXACT_ARGS, reportPath };
  const first = await runControlledLiveValidationV1(options, { hasHeliusApiKey: () => false });
  assert.equal(first.status, 'safe_failure');
  const original = readFileSync(reportPath, 'utf8');
  let credentialChecks = 0;
  await assert.rejects(
    runControlledLiveValidationV1(options, {
      hasHeliusApiKey: () => { credentialChecks += 1; return false; },
    }),
    error => error.code === 'report_path_unavailable',
  );
  assert.equal(credentialChecks, 0);
  assert.equal(readFileSync(reportPath, 'utf8'), original);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
}));

test('hostile thrown errors, key values, provider prose, URLs, paths, and stacks never enter output', t => withTemp(t, async root => {
  const fixture = fullFixture(['jup_buy_full']);
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

test('malformed safe failure emits only the exact report-v2 fixed-enum diagnostic', t => withTemp(t, async root => {
  const fixture = fullFixture(['jup_buy_full']);
  fixture.port.getFinalizedSlotV1 = async () => {
    let malformed;
    try { failWalletAcquisitionOperationV1('malformed_provider_response', 'rpc_slot_result_invalid'); }
    catch (error) { malformed = error; }
    throw contextualizeWalletAcquisitionErrorV1(malformed, 'finalized_anchor', 'finalized_slot');
  };
  const result = await runFixture(root, fixture);
  const report = readReport(outputPath(root));
  assert.equal(result.status, 'safe_failure');
  assert.equal(report.validation_version, 'artifact_v1.15_controlled_live_validation_v1');
  assert.equal(report.error_code, 'malformed_provider_response');
  assert.deepEqual(report.failure_diagnostic, {
    diagnostic_version: 'controlled_live_failure_diagnostic_v1',
    stage: 'finalized_anchor', operation: 'finalized_slot', reason: 'rpc_slot_result_invalid',
  });
  assert.deepEqual(Object.keys(report.failure_diagnostic).sort(), ['diagnostic_version','operation','reason','stage']);

  const unsafeFixture = fullFixture(['jup_buy_full']);
  const cyclic = {}; cyclic.self = cyclic;
  unsafeFixture.port.getFinalizedSlotV1 = async () => cyclic;
  const unsafe = await runFixture(root, unsafeFixture, {}, 'unsafe.json');
  assert.deepEqual(unsafe.report.failure_diagnostic, {
    diagnostic_version: 'controlled_live_failure_diagnostic_v1',
    stage: 'finalized_anchor', operation: 'finalized_slot', reason: 'provider_value_unsafe',
  });
}));

test('all remaining known malformed reason classes reach report v2 without the fallback tuple', t => withTemp(t, async root => {
  function throwReason(reason) {
    try { failWalletAcquisitionOperationV1('malformed_provider_response', reason); }
    catch (error) { throw error; }
  }
  const cases = [
    ['invalid_json', 'getNetworkIdentityV1', 'finalized_anchor', 'network_identity'],
    ['rpc_genesis_result_invalid', 'getNetworkIdentityV1', 'finalized_anchor', 'network_identity'],
    ['full_transaction_page_invalid', 'getFinalizedFullTransactionPageV1', 'full_transaction_history', 'full_transaction_address_history'],
    ['full_transaction_order_invalid', 'getFinalizedFullTransactionPageV1', 'full_transaction_history', 'full_transaction_address_history'],
    ['full_transaction_page_incomplete', 'getFinalizedFullTransactionPageV1', 'full_transaction_history', 'full_transaction_address_history'],
    ['full_transaction_pagination_token_repeated', 'getFinalizedFullTransactionPageV1', 'full_transaction_history', 'full_transaction_address_history'],
  ];
  for (const [reason, method, stage, operation] of cases) {
    const fixture = fullFixture(['jup_buy_full']);
    fixture.port[method] = async () => throwReason(reason);
    const result = await runFixture(root, fixture, {}, `${reason}.json`);
    assert.deepEqual(result.report.failure_diagnostic, {
      diagnostic_version: 'controlled_live_failure_diagnostic_v1', stage, operation, reason,
    });
    assert.notEqual(result.report.failure_diagnostic.reason, 'unlocalized_malformed_response');
  }
}));

test('PASS and non-malformed failures use report v2 without failure diagnostics', t => withTemp(t, async root => {
  const passFixture = fullFixture();
  const passed = await runFixture(root, passFixture, {}, 'pass.json');
  assert.equal(passed.report.validation_version, 'artifact_v1.15_controlled_live_validation_v1');
  assert.equal(Object.hasOwn(passed.report, 'failure_diagnostic'), false);

  const failureFixture = fullFixture(['jup_buy_full']);
  failureFixture.port.getNetworkIdentityV1 = async () => { throw { code: 'provider_timeout' }; };
  const failed = await runFixture(root, failureFixture, {}, 'failure.json');
  assert.equal(failed.report.validation_version, 'artifact_v1.15_controlled_live_validation_v1');
  assert.equal(failed.report.error_code, 'provider_timeout');
  assert.equal(Object.hasOwn(failed.report, 'failure_diagnostic'), false);
}));

test('untrusted malformed metadata cannot enter the report and uses only the fixed fallback tuple', t => withTemp(t, async root => {
  const canary = 'secret-provider-body https://host.invalid /root/key';
  const result = await runFixture(root, fullFixture(['jup_buy_full']), {
    acquireWalletHistory: async () => { throw {
      code: 'malformed_provider_response',
      failure_diagnostic: { stage: canary, operation: canary, reason: canary },
      message: canary,
      stack: canary,
    }; },
  });
  assert.equal(result.status, 'safe_failure');
  assert.deepEqual(result.report.failure_diagnostic, {
    diagnostic_version: 'controlled_live_failure_diagnostic_v1',
    stage: 'internal_boundary', operation: 'none', reason: 'unlocalized_malformed_response',
  });
  const bytes = readFileSync(outputPath(root), 'utf8');
  assert.equal(bytes.includes(canary), false);
  assert.equal(bytes.includes('https://'), false);
  assert.equal(bytes.includes('/root/'), false);
}));

test('production operator imports no store, signer, uploader, minter, deployment, API, UI, or hosted-job module', () => {
  const source = readFileSync(new URL('./run-controlled-live-validation.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm)].map(match => match[1]);
  for (const specifier of imports) {
    assert.doesNotMatch(specifier, /\/(?:[^/]*(?:store|upload|signer|mint|deploy|api|ui|hosted|public-demo|archive|economics)[^/]*)\//i);
  }
  assert.doesNotMatch(source, /packageStore|expected_receipt_hash|mode\s*:\s*['"]commit['"]/);
});
