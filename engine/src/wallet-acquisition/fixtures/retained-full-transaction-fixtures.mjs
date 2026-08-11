import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { canonicalJson } from '../../candidate-set/serialize.mjs';
import { validateHeliusFullTransactionV1 } from '../helius-full-transaction-validator.mjs';
import { detachProviderNeutralValueV1 } from '../provider-port.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from '../request-contract.mjs';
import { validateSolanaFullTransactionV1 } from '../solana-full-transaction.mjs';

const BLOCKHASH = '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh';
const EXPECTED_HEAD = '42e3e2fda9a116b466a00b2d60c8949c8b82f91b';
const EXPECTED_MANIFEST_SHA256 = 'a27cc4640614fcb4875a76848a928809dd202ec22592762c0376153393f1a45a';
const FIXTURES = Object.freeze({
  ray_buy_full: Object.freeze({
    signature: '2SUoNBBTkQBBGVCinvLQbVZq5LDZS5M8ikx5PLH7QiCuLdf6GWCPSM7wLd6gJsNUbLSousAhbkSX9eXgt1dAeBKm',
    slot: 395930271,
    block_time: 1769382291,
    execution_state: 'succeeded',
    size_bytes: 40204,
    sha256: 'bd40910e576bd4f3845d1c492446f10c6a43d3d7d4058b934fa2e300fb014cb4',
  }),
  ray_sell_full: Object.freeze({
    signature: '4TmWRpMxWRTpQqNM7iFCRyP1m9VEyRK54VZwKeQV4cYisYRjQRjuvocF8j7mNAomoQf6H2h4vfd5Qp6Y2LQxeEsB',
    slot: 396554229,
    block_time: 1769632666,
    execution_state: 'succeeded',
    size_bytes: 40888,
    sha256: '24c89812d42c7f30509077a24b8cb03755480a3cade5798842f3cc8321268253',
  }),
  jup_buy_full: Object.freeze({
    signature: '2ArLuJC2JEuWiavk1jYxLQ2E4xhq63BbeDV2kCWPcZ9zZNc4XyugUEFEryKrYfqcWnxkUvyacRmj2YNTfZGq17yV',
    slot: 427586968,
    block_time: 1781904268,
    execution_state: 'succeeded',
    size_bytes: 36290,
    sha256: '7a8d129a18d61d6547c4c4a69f2145005508079be88a1f2331262f2f152e437d',
  }),
  jup_sell_full: Object.freeze({
    signature: '5YCdUYkJVx3kkZUpvz4ygs6QT8GZtYtru4kGkur3LJ8yrMmW2XJ8qXtgjspMpJqqyQA6WPDQxd4BcTpNNSr3Dctk',
    slot: 428001210,
    block_time: 1782068814,
    execution_state: 'succeeded',
    size_bytes: 30958,
    sha256: '6a03aa49ca1f23f1b8230f53367211e7dcf66c6d5c92e027fd8d8acc8fe59e49',
  }),
  jupiter_close_account_full: Object.freeze({
    signature: '4oyFe9ML9SvbYprTtwsvKzJdQjrgLSbCq38aQT5HU1EE9dA6vA7mfcrrMHK5DgZKmuitCbxheXqAYVmmjyL1TxBT',
    slot: 337167092,
    block_time: 1746123169,
    execution_state: 'succeeded',
    size_bytes: 35964,
    sha256: '98703d1bfeac685818f95634cddbbdb570e59450e1788da44335ce2898143294',
  }),
});

function fail() {
  throw new TypeError('retained full-transaction fixture fidelity check failed');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hasExactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}

export function validateRetainedFullTransactionManifestV1(input) {
  let manifest;
  try { manifest = detachProviderNeutralValueV1(input); } catch { fail(); }
  if (!hasExactFields(manifest, [
    'authoritative','endpoint_identifier','fixed_parameters_profile','fixture_protocol','fixtures',
    'manifest_version','methods','overall_status','plan_documented_schema_date','provider_call_budget',
    'repository_head','retained_object_policy','telemetry',
  ])
      || manifest.authoritative !== false
      || manifest.endpoint_identifier !== 'helius_mainnet_rpc_fixed_origin_v1'
      || manifest.fixed_parameters_profile !== 'artifact_v1_15_full_transaction_fixture_capture_v1'
      || manifest.fixture_protocol !== 'five_signature_bounded_full_transaction_capture_v1'
      || manifest.manifest_version !== 'artifact_v1_15_slice7_fixture_capture_manifest_v1'
      || !Array.isArray(manifest.methods)
      || manifest.methods.length !== 2
      || manifest.methods[0] !== 'getTransaction'
      || manifest.methods[1] !== 'getTransactionsForAddress'
      || manifest.overall_status !== 'PASS'
      || manifest.plan_documented_schema_date !== '2026-08-08'
      || manifest.repository_head !== EXPECTED_HEAD
      || manifest.retained_object_policy !== 'matching_getTransaction_result_only_after_bulk_canonical_equality'
      || !hasExactFields(manifest.provider_call_budget, ['actual','maximum','respected'])
      || manifest.provider_call_budget.actual !== 10
      || manifest.provider_call_budget.maximum !== 10
      || manifest.provider_call_budget.respected !== true
      || !hasExactFields(manifest.telemetry, ['retry_count','timeout_count'])
      || manifest.telemetry.retry_count !== 0
      || manifest.telemetry.timeout_count !== 0
      || !Array.isArray(manifest.fixtures)
      || manifest.fixtures.length !== Object.keys(FIXTURES).length) fail();
  for (const row of manifest.fixtures) {
    if (!hasExactFields(row, [
      'block_time','execution_state','fixture','individual_vs_bulk_canonical_equal','provider_requests',
      'retained_file','retry_occurred','signature','slot','status','timeout_occurred',
    ]) || !Object.hasOwn(FIXTURES, row.fixture)) fail();
    const expected = FIXTURES[row.fixture];
    if (!hasExactFields(row.retained_file, ['file_name','mode','sha256','size_bytes'])
        || row.block_time !== expected.block_time
        || row.execution_state !== expected.execution_state
        || row.individual_vs_bulk_canonical_equal !== true
        || row.provider_requests !== 2
        || row.retry_occurred !== false
        || row.signature !== expected.signature
        || row.slot !== expected.slot
        || row.status !== 'PASS'
        || row.timeout_occurred !== false
        || row.retained_file.file_name !== `${row.fixture}.json`
        || row.retained_file.mode !== '0600'
        || row.retained_file.sha256 !== expected.sha256
        || row.retained_file.size_bytes !== expected.size_bytes) fail();
  }
  if (new Set(manifest.fixtures.map(row => row.fixture)).size !== Object.keys(FIXTURES).length) fail();
  return manifest;
}

function readExact(name, expected) {
  const bytes = readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8');
  if (Buffer.byteLength(bytes) !== expected.size_bytes || sha256(bytes) !== expected.sha256) fail();
  let parsed;
  try { parsed = JSON.parse(bytes); } catch { fail(); }
  const raw = detachProviderNeutralValueV1(parsed);
  if (canonicalJson(raw) !== bytes) fail();
  const transaction = validateHeliusFullTransactionV1(raw, expected.signature);
  validateSolanaFullTransactionV1(transaction);
  if (transaction.signature !== expected.signature || transaction.slot !== expected.slot
      || transaction.block_time !== expected.block_time
      || transaction.execution_state !== expected.execution_state) fail();
  return Object.freeze({ raw, transaction });
}

const manifestBytes = readFileSync(new URL('./provenance-fidelity-manifest.json', import.meta.url), 'utf8');
if (sha256(manifestBytes) !== EXPECTED_MANIFEST_SHA256) fail();
let parsedManifest;
try { parsedManifest = JSON.parse(manifestBytes); } catch { fail(); }
export const RETAINED_FULL_TRANSACTION_MANIFEST_V1 = validateRetainedFullTransactionManifestV1(parsedManifest);
if (canonicalJson(RETAINED_FULL_TRANSACTION_MANIFEST_V1) !== manifestBytes
    || RETAINED_FULL_TRANSACTION_MANIFEST_V1.repository_head !== EXPECTED_HEAD) fail();
const manifestText = manifestBytes.toLowerCase();
if (['http://','https://','api-key','authorization','"headers"','paginationtoken','request object','retry internals']
  .some(forbidden => manifestText.includes(forbidden))) fail();

const loaded = Object.fromEntries(Object.entries(FIXTURES).map(([name, expected]) => [name, readExact(name, expected)]));
const manifestRows = RETAINED_FULL_TRANSACTION_MANIFEST_V1.fixtures;
if (!Array.isArray(manifestRows) || manifestRows.length !== Object.keys(FIXTURES).length) fail();
for (const [name, expected] of Object.entries(FIXTURES)) {
  const rows = manifestRows.filter(row => row.fixture === name);
  if (rows.length !== 1) fail();
  const row = rows[0];
  if (row.status !== 'PASS' || row.signature !== expected.signature || row.slot !== expected.slot
      || row.block_time !== expected.block_time || row.execution_state !== expected.execution_state
      || row.individual_vs_bulk_canonical_equal !== true || row.provider_requests !== 2
      || row.retry_occurred !== false || row.timeout_occurred !== false
      || row.retained_file?.file_name !== `${name}.json`
      || row.retained_file?.size_bytes !== expected.size_bytes
      || row.retained_file?.mode !== '0600' || row.retained_file?.sha256 !== expected.sha256) fail();
}

export const EXACT_RETAINED_FULL_TRANSACTION_BODIES_V1 = Object.freeze(Object.fromEntries(
  Object.entries(loaded).map(([name, value]) => [name, value.raw]),
));
export const DETACHED_RETAINED_FULL_TRANSACTIONS_V1 = Object.freeze(Object.fromEntries(
  Object.entries(loaded).map(([name, value]) => [name, value.transaction]),
));

function requestFor(wallet) {
  return {
    request_version: 'wallet_wide_acquisition_request_v2',
    chain: 'solana',
    network: 'mainnet-beta',
    genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    wallet,
    window: {
      window_version: 'fixed_lookback_latest_state_v1',
      lookback_profile: 'lookback_30d_v1',
      requested_lookback_seconds: 2592000,
      initial_before_signature: null,
    },
    finality: {
      commitment: 'finalized',
      boundary_profile: 'solana_finalized_anchor_v1',
      max_anchor_search_slots: 32,
    },
    budgets: {
      pagination_profile: 'solana_full_transaction_page_100_v1',
      page_size: 100,
      max_pages: 100,
      max_transactions: 10000,
      retry_profile: 'bounded_exponential_retry_v1',
      max_attempts_per_operation: 8,
      timeout_profile: 'bounded_provider_timeout_v1',
      request_timeout_ms: 60000,
      overall_timeout_ms: 300000,
      exact_fallback_profile: 'finalized_get_transaction_missing_only_v1',
      max_exact_fallback_transactions: 0,
    },
    profiles: {
      wallet_acquisition_profile: 'wallet_wide_bounded_history_v1',
      wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1',
    },
  };
}

export function offlineFullTransactionHistoryFixtureV2({ wallet, retainedBodyNames = [] } = {}) {
  const selected = retainedBodyNames.map(name => {
    if (!Object.hasOwn(loaded, name)) throw new TypeError('unknown retained full-transaction body');
    return loaded[name];
  });
  if (selected.length === 0) throw new TypeError('at least one retained full-transaction body is required');
  const transactions = selected.map(value => value.transaction)
    .sort((left, right) => right.slot - left.slot || right.block_time - left.block_time
      || (left.signature < right.signature ? -1 : left.signature > right.signature ? 1 : 0));
  const sources = transactions.map(({ signature, slot, block_time, execution_state }) => ({
    signature, slot, block_time, execution_state,
  }));
  const anchorSlot = Math.max(...sources.map(source => source.slot)) + 1;
  const anchorTime = Math.max(...sources.map(source => source.block_time)) + 1;
  let signatureCalls = 0;
  let bulkCalls = 0;
  let fallbackCalls = 0;
  const port = {
    async getNetworkIdentityV1() {
      return { chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH };
    },
    async getFinalizedSlotV1() { return anchorSlot; },
    async getFinalizedBlockV1({ slot }) {
      return { slot, block_time: anchorTime, blockhash: BLOCKHASH, commitment: 'finalized' };
    },
    async getFinalizedWalletSignaturePageV1() {
      signatureCalls += 1;
      return structuredClone(sources);
    },
    async getFinalizedFullTransactionPageV1() {
      bulkCalls += 1;
      return { transactions: structuredClone(transactions), pagination_token: null };
    },
    async getFinalizedTransactionV1() {
      fallbackCalls += 1;
      throw new TypeError('exact fallback is not available in retained bulk replay');
    },
  };
  return {
    request: requestFor(wallet),
    port,
    exactRetainedBodies: selected.map(value => value.raw),
    detachedTransactions: selected.map(value => value.transaction),
    observed: Object.freeze({ counts: () => ({ signatureCalls, bulkCalls, fallbackCalls }) }),
    evidenceFidelity: Object.freeze({
      fullTransactionBodies: 'exact_retained_finalized_get_transaction_results',
      crossMethodEquality: 'slice7_individual_vs_bulk_canonical_equality_passed',
      finalizedRpcEnvelopes: 'synthetic_finalized_rpc_envelopes',
      canonicalSignaturePages: 'synthetic_canonical_signature_pages',
      fullTransactionPages: 'synthetic_pages_around_exact_retained_transactions',
      paginationFillers: 'none',
    }),
  };
}
