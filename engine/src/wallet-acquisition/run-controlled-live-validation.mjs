#!/usr/bin/env node
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildWalletCandidateSetV1 } from '../candidate-set/builder.mjs';
import { buildCandidateEvidenceBundleV1 } from '../candidate-set/evidence-bundle.mjs';
import { resolveCandidateSelectionV1 } from '../candidate-set/selection-resolver.mjs';
import { canonicalJson, sha256CanonicalJson } from '../candidate-set/serialize.mjs';
import { orchestrateTargetedReceiptPackageV1 } from '../receipt-package/targeted-orchestrator.mjs';
import { createHeliusWalletHistoryPortV1 } from './helius-wallet-history-adapter.mjs';
import { acquireWalletHistoryV1 } from './orchestrator.mjs';
import { beginWalletHistoryAcquisitionV1, createWalletHistoryPortV1 } from './provider-port.mjs';
import {
  LOOKBACK_SECONDS_BY_PROFILE_V1,
  MAX_ANCHOR_SEARCH_SLOTS_V1,
  PAGE_SIZE_V1,
  SOLANA_MAINNET_GENESIS_HASH,
  buildWalletAcquisitionRequestV1,
} from './request-contract.mjs';

export const CONTROLLED_LIVE_VALIDATION_VERSION_V1 = 'artifact_v1.14_controlled_live_validation_v1';
const REPOSITORY_ROOT = realpathSync(new URL('../../../', import.meta.url));
const FLAG_FIELDS = Object.freeze({
  '--wallet': 'wallet',
  '--lookback-profile': 'lookbackProfile',
  '--max-pages': 'maxPages',
  '--max-transactions': 'maxTransactions',
  '--max-attempts': 'maxAttempts',
  '--request-timeout-ms': 'requestTimeoutMs',
  '--overall-timeout-ms': 'overallTimeoutMs',
  '--report-path': 'reportPath',
});
const OPTION_FIELDS = Object.freeze(Object.values(FLAG_FIELDS));
const INTEGER_FIELDS = new Set(['maxPages','maxTransactions','maxAttempts','requestTimeoutMs','overallTimeoutMs']);
const SAFE_ERROR_CODES = new Set([
  'invalid_validation_request','report_path_forbidden','report_path_unavailable','api_key_unavailable',
  'acquisition_capped','acquisition_deadline_exceeded','provider_timeout','provider_retry_exhausted',
  'provider_auth_failed','provider_request_invalid','provider_transient_failure','provider_uncertain',
  'malformed_provider_response','chain_identity_mismatch','finalized_boundary_unavailable',
  'finalized_boundary_incoherent','latest_state_unproven','pagination_incomplete','pagination_cursor_invalid',
  'pagination_cursor_repeated','pagination_order_invalid','pagination_duplicate_conflict','source_transaction_mismatch',
  'normalization_failed','wallet_wide_impact_unresolved','event_finding_reconciliation_failed',
  'transaction_disposition_failed','unsupported_lookback_profile','lookback_boundary_mismatch','lower_bound_unproven',
  'acquisition_truncated','invalid_source_transaction','normalization_ambiguous','validation_failed',
]);

class ControlledLiveValidationError extends Error {
  constructor(code) {
    super(code.replaceAll('_', ' '));
    delete this.stack;
    this.name = 'ControlledLiveValidationError';
    this.code = SAFE_ERROR_CODES.has(code) ? code : 'validation_failed';
  }
}
function fail(code) { throw new ControlledLiveValidationError(code); }
function ownSafeCode(error) {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return 'provider_uncertain';
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') && SAFE_ERROR_CODES.has(descriptor.value)
      ? descriptor.value : 'provider_uncertain';
  } catch { return 'provider_uncertain'; }
}
function exactOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype || Object.getOwnPropertySymbols(options).length) fail('invalid_validation_request');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.keys(descriptors).length !== OPTION_FIELDS.length
      || OPTION_FIELDS.some(field => !descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value'))) fail('invalid_validation_request');
  const result = Object.fromEntries(OPTION_FIELDS.map(field => [field, descriptors[field].value]));
  for (const field of INTEGER_FIELDS) if (!Number.isSafeInteger(result[field]) || result[field] <= 0) fail('invalid_validation_request');
  if (typeof result.wallet !== 'string' || typeof result.lookbackProfile !== 'string'
      || typeof result.reportPath !== 'string' || result.reportPath.length === 0) fail('invalid_validation_request');
  return result;
}

export function parseControlledLiveValidationArgsV1(argv) {
  if (!Array.isArray(argv) || argv.length !== OPTION_FIELDS.length * 2) fail('invalid_validation_request');
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const field = FLAG_FIELDS[flag];
    const raw = argv[index + 1];
    if (field === undefined || Object.hasOwn(parsed, field) || typeof raw !== 'string' || raw.length === 0) fail('invalid_validation_request');
    if (INTEGER_FIELDS.has(field)) {
      if (!/^[1-9][0-9]*$/.test(raw)) fail('invalid_validation_request');
      parsed[field] = Number(raw);
    } else parsed[field] = raw;
  }
  return exactOptions(parsed);
}

function buildRequest(options) {
  const seconds = LOOKBACK_SECONDS_BY_PROFILE_V1[options.lookbackProfile];
  return buildWalletAcquisitionRequestV1({
    request_version: 'wallet_wide_acquisition_request_v1',
    chain: 'solana',
    network: 'mainnet-beta',
    genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    wallet: options.wallet,
    window: {
      window_version: 'fixed_lookback_latest_state_v1',
      lookback_profile: options.lookbackProfile,
      requested_lookback_seconds: seconds,
      initial_before_signature: null,
    },
    finality: {
      commitment: 'finalized',
      boundary_profile: 'solana_finalized_anchor_v1',
      max_anchor_search_slots: MAX_ANCHOR_SEARCH_SLOTS_V1,
    },
    budgets: {
      pagination_profile: 'helius_wallet_history_page_100_v1',
      page_size: PAGE_SIZE_V1,
      max_pages: options.maxPages,
      max_transactions: options.maxTransactions,
      retry_profile: 'bounded_exponential_retry_v1',
      max_attempts_per_operation: options.maxAttempts,
      timeout_profile: 'bounded_provider_timeout_v1',
      request_timeout_ms: options.requestTimeoutMs,
      overall_timeout_ms: options.overallTimeoutMs,
    },
    profiles: {
      wallet_acquisition_profile: 'wallet_wide_bounded_history_v1',
      wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1',
    },
  });
}

function isInside(path, root) {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}
function validateReportPath(reportPath) {
  if (!isAbsolute(reportPath)) fail('report_path_forbidden');
  const target = resolve(reportPath);
  let parent;
  try { parent = realpathSync(dirname(target)); } catch { fail('report_path_forbidden'); }
  const resolvedTarget = resolve(parent, target.slice(dirname(target).length + 1));
  const temporaryRoot = realpathSync(tmpdir());
  if (!isInside(resolvedTarget, temporaryRoot) || isInside(resolvedTarget, REPOSITORY_ROOT)) fail('report_path_forbidden');
  if (existsSync(resolvedTarget)) {
    try { lstatSync(resolvedTarget); } catch {}
    fail('report_path_unavailable');
  }
  return resolvedTarget;
}
function writeReport(path, report) {
  const bytes = canonicalJson(report);
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, bytes, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } catch {
    fail('report_path_unavailable');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function productionApiKeyPresent() {
  return Object.hasOwn(process.env, 'HELIUS_API_KEY')
    && typeof process.env.HELIUS_API_KEY === 'string'
    && process.env.HELIUS_API_KEY.length > 0;
}
function productionApiKeyProvider() { return process.env.HELIUS_API_KEY; }
function createHttpClient(telemetry) {
  return Object.freeze({
    async request(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeout_ms);
      try {
        const url = new URL(request.url);
        for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, String(value));
        const response = await fetch(url, {
          method: request.method,
          headers: request.headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: controller.signal,
        });
        if (response.status === 429 || response.status >= 500) telemetry.retry_count += 1;
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { throw Object.freeze({ code: 'invalid_json' }); }
        return { status: response.status, data };
      } catch (error) {
        if (error?.name === 'AbortError') {
          telemetry.retry_count += 1;
          telemetry.timeout_count += 1;
          throw Object.freeze({ code: 'request_timeout' });
        }
        const code = ownSafeCode(error);
        if (code === 'provider_uncertain') throw Object.freeze({ code: 'transient_transport' });
        throw Object.freeze({ code });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

function instrumentPort(port, telemetry) {
  const capability = {
    async getNetworkIdentityV1() { return port.getNetworkIdentityV1(); },
    async getFinalizedSlotV1() { return port.getFinalizedSlotV1(); },
    async getFinalizedBlockV1(input) { return port.getFinalizedBlockV1(input); },
    async getFinalizedWalletSignaturePageV1(input) {
      const page = await port.getFinalizedWalletSignaturePageV1(input);
      telemetry.pages_examined += 1;
      for (const source of page) telemetry.canonical_sources.set(source.signature, { slot: source.slot, block_time: source.block_time });
      return page;
    },
    async getEnhancedTransactionsBySignatureV1(input) {
      const result = await port.getEnhancedTransactionsBySignatureV1(input);
      telemetry.enhanced_transactions_reconciled = result.length;
      return result;
    },
  };
  return createWalletHistoryPortV1(capability, {
    beginAcquisitionV1(budgets) { beginWalletHistoryAcquisitionV1(port, budgets); },
  });
}
function budgetsForReport(request) {
  return {
    max_pages: request.budgets.max_pages,
    max_transactions: request.budgets.max_transactions,
    max_attempts_per_operation: request.budgets.max_attempts_per_operation,
    request_timeout_ms: request.budgets.request_timeout_ms,
    overall_timeout_ms: request.budgets.overall_timeout_ms,
  };
}
function baseReport(request) {
  return {
    validation_version: CONTROLLED_LIVE_VALIDATION_VERSION_V1,
    status: 'safe_failure',
    wallet: request.wallet,
    chain: request.chain,
    network: request.network,
    genesis_hash: request.genesis_hash,
    lookback_profile: request.window.lookback_profile,
    requested_lookback_seconds: request.window.requested_lookback_seconds,
    configured_budgets: budgetsForReport(request),
  };
}
function successfulReport(request, acquisition, evidenceBundle, candidateSet, telemetry, dryRun) {
  const coverage = acquisition.coverage;
  const input = acquisition.input_status;
  const boundary = acquisition.boundary;
  const selectable = candidateSet.payload.candidates.filter(candidate => candidate.projection.selection_status === 'selectable');
  const cleanClosed = selectable.filter(candidate => candidate.projection.candidate_type === 'closed_position'
    && candidate.projection.ledger_evidence_status === 'clean'
    && candidate.projection.package_eligibility === 'eligible_closed_position_v1');
  if (selectable.length !== cleanClosed.length) fail('validation_failed');
  const postAnchor = [...telemetry.canonical_sources.values()].filter(source => source.slot > boundary.anchor_slot || source.block_time > boundary.anchor_block_time).length;
  const report = {
    ...baseReport(request),
    status: 'pass',
    oldest_allowed_timestamp: acquisition.scope.window.lower_bound.oldest_allowed_timestamp,
    anchor_slot: boundary.anchor_slot,
    anchor_block_time: boundary.anchor_block_time,
    anchor_blockhash: boundary.anchor_blockhash,
    pages_examined: telemetry.pages_examined,
    canonical_signatures_observed: telemetry.canonical_sources.size,
    post_anchor_signatures_excluded: postAnchor,
    in_window_transaction_count: coverage.transactions_examined,
    enhanced_transactions_reconciled: telemetry.enhanced_transactions_reconciled,
    supported_normalized_event_count: coverage.supported_transaction_count,
    unsupported_activity_count: coverage.unsupported_transaction_count,
    ambiguous_activity_count: coverage.ambiguous_transaction_count,
    unrelated_activity_count: coverage.unrelated_transaction_count,
    failed_transaction_count: coverage.failed_transaction_count,
    normalized_event_count: coverage.normalized_event_count,
    finding_count: coverage.finding_count,
    localized_finding_count: coverage.localized_finding_count,
    pagination_terminal_reason: coverage.pagination_terminal_reason,
    retry_count: telemetry.retry_count,
    timeout_count: telemetry.timeout_count,
    acquisition_complete: input.acquisition_complete,
    normalization_complete: input.normalization_complete,
    classification_complete: input.classification_complete,
    pagination_complete: input.pagination_complete,
    historical_bound_proven: input.historical_bound_proven,
    chain_boundary_proven: input.chain_boundary_proven,
    truncated: input.truncated,
    capped: input.capped,
    partial: input.partial,
    provider_uncertain: input.provider_uncertain,
    acquisition_result_digest: sha256CanonicalJson(acquisition),
    evidence_bundle_digest: evidenceBundle.evidence_bundle_digest,
    candidate_set_digest: candidateSet.candidate_set_digest,
    candidate_count: candidateSet.payload.counts.candidate_count,
    selectable_candidate_count: candidateSet.payload.counts.selectable_candidate_count,
    blocked_summary_count: candidateSet.payload.counts.blocked_summary_count,
    selectable_candidates: cleanClosed.map(candidate => ({
      candidate_digest: candidate.candidate_digest,
      candidate_type: candidate.projection.candidate_type,
      selection_status: candidate.projection.selection_status,
      ledger_evidence_status: candidate.projection.ledger_evidence_status,
      package_eligibility: candidate.projection.package_eligibility,
    })),
  };
  if (dryRun !== null) {
    report.dry_run_receipt_hash = dryRun.receipt_hash;
    report.dry_run_package_digest = dryRun.package_digest;
  }
  return report;
}

export async function runControlledLiveValidationV1(optionInput, dependencyInput = {}) {
  const options = exactOptions(optionInput);
  const request = buildRequest(options);
  const reportPath = validateReportPath(options.reportPath);
  const dependencies = dependencyInput === null || typeof dependencyInput !== 'object' ? {} : dependencyInput;
  const hasHeliusApiKey = dependencies.hasHeliusApiKey ?? productionApiKeyPresent;
  let present = false;
  try { present = hasHeliusApiKey() === true; } catch { present = false; }
  if (!present) {
    const report = { ...baseReport(request), error_code: 'api_key_unavailable' };
    writeReport(reportPath, report);
    return Object.freeze({ status: 'safe_failure', report: Object.freeze(report) });
  }

  const telemetry = { pages_examined: 0, canonical_sources: new Map(), enhanced_transactions_reconciled: 0, retry_count: 0, timeout_count: 0 };
  try {
    const apiKeyProvider = dependencies.apiKeyProvider ?? productionApiKeyProvider;
    const rawPort = dependencies.walletHistoryPort ?? createHeliusWalletHistoryPortV1({
      httpClient: dependencies.httpClient ?? createHttpClient(telemetry),
      apiKeyProvider,
      sleep: dependencies.sleep ?? (milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))),
      clock: dependencies.clock ?? (() => Date.now()),
      random: dependencies.random ?? Math.random,
    });
    const port = instrumentPort(rawPort, telemetry);
    const acquire = dependencies.acquireWalletHistory ?? acquireWalletHistoryV1;
    const acquisition = await acquire(request, { walletHistoryPort: port });
    const buildEvidence = dependencies.buildEvidenceBundle ?? buildCandidateEvidenceBundleV1;
    const evidenceBundle = buildEvidence({ acquisitionResult: acquisition, markObservations: [], profiles: acquisition.profiles });
    const buildCandidates = dependencies.buildCandidateSet ?? buildWalletCandidateSetV1;
    const candidateSet = buildCandidates({ evidenceBundle });
    const selectable = candidateSet.payload.candidates.filter(candidate => candidate.projection.selection_status === 'selectable');
    let dryRun = null;
    if (selectable.length === 1) {
      const resolveSelection = dependencies.resolveSelection ?? resolveCandidateSelectionV1;
      const resolution = resolveSelection({
        candidateSet,
        evidenceBundle,
        selection: { candidate_set_digest: candidateSet.candidate_set_digest, candidate_digest: selectable[0].candidate_digest },
      });
      const orchestrate = dependencies.orchestrateTargeted ?? orchestrateTargetedReceiptPackageV1;
      dryRun = await orchestrate(resolution.slice7_request, {});
      if (dryRun?.status !== 'dry_run' || typeof dryRun.receipt_hash !== 'string' || typeof dryRun.package_digest !== 'string') fail('validation_failed');
    }
    const report = successfulReport(request, acquisition, evidenceBundle, candidateSet, telemetry, dryRun);
    writeReport(reportPath, report);
    return Object.freeze({ status: 'pass', report: Object.freeze(report) });
  } catch (error) {
    const report = { ...baseReport(request), error_code: ownSafeCode(error) };
    writeReport(reportPath, report);
    return Object.freeze({ status: 'safe_failure', report: Object.freeze(report) });
  } finally {
    telemetry.canonical_sources.clear();
  }
}

async function main() {
  try {
    const options = parseControlledLiveValidationArgsV1(process.argv.slice(2));
    const result = await runControlledLiveValidationV1(options);
    if (result.status === 'pass') {
      process.stdout.write(`PASS transactions=${result.report.in_window_transaction_count} candidates=${result.report.candidate_count} selectable=${result.report.selectable_candidate_count}\n`);
      process.stdout.write(`report=${options.reportPath}\n`);
      return 0;
    }
    process.stdout.write(`SAFE_FAILURE code=${result.report.error_code}\n`);
    process.stdout.write(`report=${options.reportPath}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`SAFE_FAILURE code=${ownSafeCode(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
