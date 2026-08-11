#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as operator from './run-controlled-live-validation.mjs';
import { createWalletHistoryPortV2 } from './provider-port-v2.mjs';
import { failWalletAcquisitionOperationV1 } from './provider-port.mjs';
import {
  JUP_WALLET_V1,
} from './fixtures/retained-provider-fixtures.mjs';
import {
  offlineFullTransactionHistoryFixtureV2,
} from './fixtures/retained-full-transaction-fixtures.mjs';

const KEY_CANARY = 'v115-operator-secret-canary-never-retain';
const EXACT_OPTIONS = Object.freeze({
  wallet: JUP_WALLET_V1,
  lookbackProfile: 'lookback_90d_v1',
  maxPages: 20,
  maxTransactions: 2000,
  maxAttempts: 2,
  requestTimeoutMs: 20000,
  overallTimeoutMs: 300000,
  maxExactFallbackTransactions: 0,
});

function withTemp(t, fn) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-v115-operator-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return fn(root);
}

function dependencies(rawPort, overrides = {}) {
  return {
    walletHistoryPort: createWalletHistoryPortV2(rawPort, { beginAcquisitionV2() {} }),
    hasHeliusApiKey: () => true,
    apiKeyProvider: () => KEY_CANARY,
    ...overrides,
  };
}

test('v1.15 CLI and report discriminator bind request-v2 and explicit fallback allowance zero', () => {
  assert.equal(operator.CONTROLLED_LIVE_VALIDATION_VERSION_V3, 'artifact_v1.15_controlled_live_validation_v1');
  const reportPath = '/tmp/artifact-v115-live-validation-report.json';
  const parsed = operator.parseControlledLiveValidationArgsV1([
    '--wallet', JUP_WALLET_V1,
    '--lookback-profile', 'lookback_90d_v1',
    '--max-pages', '20',
    '--max-transactions', '2000',
    '--max-attempts', '2',
    '--request-timeout-ms', '20000',
    '--overall-timeout-ms', '300000',
    '--max-exact-fallback-transactions', '0',
    '--report-path', reportPath,
  ]);
  assert.deepEqual(parsed, { ...EXACT_OPTIONS, reportPath });
});

test('v1.15 operator uses retained full transactions and emits closed bulk/fallback telemetry', t => withTemp(t, async root => {
  const fixture = offlineFullTransactionHistoryFixtureV2({
    wallet: JUP_WALLET_V1,
    retainedBodyNames: ['jup_buy_full', 'jup_sell_full'],
  });
  const reportPath = join(root, 'report.json');
  const result = await operator.runControlledLiveValidationV1(
    { ...EXACT_OPTIONS, reportPath },
    dependencies(fixture.port),
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.report.validation_version, 'artifact_v1.15_controlled_live_validation_v1');
  assert.equal(result.report.configured_budgets.max_exact_fallback_transactions, 0);
  assert.equal(result.report.full_transaction_pages_examined, 1);
  assert.equal(result.report.full_transaction_entries_examined, 2);
  assert.equal(result.report.full_transactions_reconciled, 2);
  assert.equal(result.report.exact_fallback_transactions_requested, 0);
  assert.equal(result.report.exact_fallback_transactions_reconciled, 0);
  assert.equal(Object.hasOwn(result.report, 'enhanced_transactions_reconciled'), false);
  assert.deepEqual(fixture.observed.counts(), { signatureCalls: 2, bulkCalls: 1, fallbackCalls: 0 });
  const bytes = readFileSync(reportPath, 'utf8');
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  for (const forbidden of [KEY_CANARY, 'paginationToken', 'https://', 'api-key']) {
    assert.equal(bytes.includes(forbidden), false);
  }
}));

test('v1.15 report exposes only fixed full-transaction diagnostic vocabulary', t => withTemp(t, async root => {
  const fixture = offlineFullTransactionHistoryFixtureV2({
    wallet: JUP_WALLET_V1,
    retainedBodyNames: ['jup_buy_full'],
  });
  fixture.port.getFinalizedFullTransactionPageV1 = async () => {
    failWalletAcquisitionOperationV1('malformed_provider_response', 'full_transaction_page_invalid');
  };
  const result = await operator.runControlledLiveValidationV1(
    { ...EXACT_OPTIONS, reportPath: join(root, 'failure.json') },
    dependencies(fixture.port),
  );
  assert.deepEqual(result.report.failure_diagnostic, {
    diagnostic_version: 'controlled_live_failure_diagnostic_v1',
    stage: 'full_transaction_history',
    operation: 'full_transaction_address_history',
    reason: 'full_transaction_page_invalid',
  });
}));

test('complete v1.15 production operator dependency closure excludes legacy Enhanced adapter and projector', () => {
  const pending = [new URL('./run-controlled-live-validation.mjs', import.meta.url)];
  const visited = new Set();
  const forbidden = new Set(['helius-wallet-history-adapter.mjs', 'helius-enhanced-projector.mjs']);
  while (pending.length !== 0) {
    const url = pending.pop();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    const source = readFileSync(url, 'utf8');
    assert.doesNotMatch(source, /\bimport\s*\(\s*(?!['"])/, `nonliteral dynamic import in ${url.pathname}`);
    const imports = source.matchAll(/(?:\bimport\s+(?:[^'";]*?\s+from\s+)?|\bexport\s+[^'";]*?\s+from\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/g);
    for (const match of imports) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const dependency = new URL(specifier, url);
      assert.equal(forbidden.has(dependency.pathname.split('/').at(-1)), false, `${url.pathname} imports ${dependency.pathname}`);
      pending.push(dependency);
    }
  }
  assert.ok(visited.size > 10);
});

test('v1.15 provider checklist and operations drafts pin every release-blocking compatibility assumption', () => {
  const documents = [
    new URL('../../docs/v1.15-provider-compatibility.md', import.meta.url),
    new URL('../../docs/v1.15-operations.md', import.meta.url),
    new URL('../../docs/v1.15-limitations.md', import.meta.url),
    new URL('../../docs/v1.15-release-notes.md', import.meta.url),
  ].map(url => readFileSync(url, 'utf8')).join('\n');
  for (const required of [
    'https://mainnet.helius-rpc.com/', 'getTransactionsForAddress', 'transactionDetails: "full"',
    'commitment: "finalized"', 'encoding: "json"', 'maxSupportedTransactionVersion: 0',
    'tokenAccounts: "none"', 'status: "any"', 'sortOrder: "desc"', 'page size: 100',
    'opaque pagination', 'getTransaction', 'missing-signature-only', 'getSignaturesForAddress',
    'maintenance mode', '2026-08-11', 'aee2e8250ae2ae5ab42a8a75038b9b3f321dc7e9',
    'signatures-only responses cost **10 credits flat**',
    '10 credits per 100 returned transactions, rounded up, with a 10-credit minimum',
    'standard `getTransaction` costs **1 credit**',
    'nominal all-success ceiling is therefore **254 credits**', 'reserve **308 credits**',
    'max_pages <= 100', 'max_transactions <= 10000', 'max_attempts_per_operation <= 8',
    'request_timeout_ms <= 60000', 'overall_timeout_ms <= 300000',
    'request timeout strictly below overall timeout', 'exact fallback `0..8`',
    'STOP', 'artifact_v1.15_controlled_live_validation_v1',
  ]) assert.match(documents, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});
