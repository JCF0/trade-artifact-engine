#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildWalletCandidateSetV1 } from '../candidate-set/builder.mjs';
import { buildCandidateEvidenceBundleV1 } from '../candidate-set/evidence-bundle.mjs';
import { JUP_GOLDEN, RAY_GOLDEN } from '../candidate-set/fixtures/deterministic-fixtures.mjs';
import { resolveCandidateSelectionV1 } from '../candidate-set/selection-resolver.mjs';
import { canonicalJson } from '../candidate-set/serialize.mjs';
import { orchestrateTargetedReceiptPackageV1 } from '../receipt-package/targeted-orchestrator.mjs';
import { acquireWalletHistoryV1, acquireWalletHistoryV2 } from './orchestrator.mjs';
import { createWalletHistoryPortV1, getWalletAcquisitionFailureDiagnosticV1 } from './provider-port.mjs';
import { createWalletHistoryPortV2 } from './provider-port-v2.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from './request-contract.mjs';
import { providerPublicKey, providerSignature } from './fixtures/test-identities.mjs';
import {
  EXACT_RETAINED_HELIUS_BODIES_V1,
  JUP_MINT_V1,
  JUP_WALLET_V1,
  JUPITER_PROGRAM_V1,
  offlineWalletHistoryFixtureV1,
  RAY_MINT_V1,
  RAY_WALLET_V1,
  USDC_MINT_V1,
  USDT_MINT_V1,
} from './fixtures/retained-provider-fixtures.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BLOCKHASH = '8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh';

function fullTransaction({ wallet, signature, slot, blockTime, program, inputs, outputs, failed = false }) {
  const rows = [...inputs.map((row, index) => ({ ...row, label: `input-${index}`, pre: row.raw, post: '0' })),
    ...outputs.map((row, index) => ({ ...row, label: `output-${index}`, pre: '0', post: row.raw }))];
  const accounts = [
    { address: wallet, is_signer: true, is_writable: true, source: 'static' },
    { address: program, is_signer: false, is_writable: false, source: 'static' },
    ...rows.map(row => ({ address: providerPublicKey(`${row.label}-${signature}`), is_signer: false, is_writable: true, source: 'lookup_writable' })),
  ];
  const balances = accounts.map((_, index) => index === 0 ? 1_000_000_000 : (index > 1 ? 2_039_280 : 0));
  const tokenRows = side => rows.map((row, index) => ({
    account_index: index + 2,
    account: accounts[index + 2].address,
    mint: row.mint,
    owner: Object.hasOwn(row, 'owner') ? row.owner : wallet,
    raw_amount: row[side],
    decimals: 6,
    token_program: TOKEN_PROGRAM,
  }));
  return {
    full_transaction_version: 'solana_full_transaction_v1',
    signature,
    slot,
    block_time: blockTime,
    execution_state: failed ? 'failed' : 'succeeded',
    transaction_version: 0,
    fee_payer: wallet,
    fee_lamports: 0,
    accounts,
    pre_lamport_balances: balances,
    post_lamport_balances: [...balances],
    pre_token_balances: tokenRows('pre'),
    post_token_balances: tokenRows('post'),
    instructions: [{ instruction_index: 0, program_id: program, accounts: [wallet], data: '' }],
    inner_instruction_groups: [],
  };
}

function request(wallet, anchorTime) {
  return {
    request_version: 'wallet_wide_acquisition_request_v2',
    chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH, wallet,
    window: { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1', requested_lookback_seconds: 2592000, initial_before_signature: null },
    finality: { commitment: 'finalized', boundary_profile: 'solana_finalized_anchor_v1', max_anchor_search_slots: 32 },
    budgets: {
      pagination_profile: 'solana_full_transaction_page_100_v1', page_size: 100, max_pages: 100, max_transactions: 10000,
      retry_profile: 'bounded_exponential_retry_v1', max_attempts_per_operation: 8,
      timeout_profile: 'bounded_provider_timeout_v1', request_timeout_ms: 60000, overall_timeout_ms: 300000,
      exact_fallback_profile: 'finalized_get_transaction_missing_only_v1', max_exact_fallback_transactions: 8,
    },
    profiles: { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1' },
    __anchorTime: anchorTime,
  };
}

function fixture({ wallet, transactions, bulkPages = null, exact = new Map(), budgetOverrides = {} }) {
  const ordered = [...transactions].sort((left, right) => right.slot - left.slot);
  const anchorSlot = Math.max(...ordered.map(item => item.slot)) + 1;
  const anchorTime = Math.max(...ordered.map(item => item.block_time)) + 1;
  const req = request(wallet, anchorTime);
  delete req.__anchorTime;
  Object.assign(req.budgets, budgetOverrides);
  let signatureCalls = 0;
  let bulkCalls = 0;
  let fallbackCalls = 0;
  let beginCalls = 0;
  const methodCalls = [];
  const rawPort = {
    async getNetworkIdentityV1() { methodCalls.push('network'); return { chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH }; },
    async getFinalizedSlotV1() { methodCalls.push('slot'); return anchorSlot; },
    async getFinalizedBlockV1({ slot }) { methodCalls.push('block'); return { slot, block_time: anchorTime, blockhash: BLOCKHASH, commitment: 'finalized' }; },
    async getFinalizedWalletSignaturePageV1() {
      methodCalls.push('signatures');
      signatureCalls += 1;
      return ordered.map(({ signature, slot, block_time, execution_state }) => ({ signature, slot, block_time, execution_state }));
    },
    async getFinalizedFullTransactionPageV1() {
      methodCalls.push('bulk');
      const page = (bulkPages ?? [{ transactions: ordered, pagination_token: null }])[bulkCalls] ?? { transactions: [], pagination_token: null };
      bulkCalls += 1;
      return structuredClone(page);
    },
    async getFinalizedTransactionV1({ signature }) {
      methodCalls.push('exact');
      fallbackCalls += 1;
      return structuredClone(exact.get(signature) ?? null);
    },
  };
  const port = createWalletHistoryPortV2(rawPort, { beginAcquisitionV2() { beginCalls += 1; } });
  return {
    req,
    port,
    counts: () => ({ signatureCalls, bulkCalls, fallbackCalls }),
    lifecycle: () => ({ beginCalls, methodCalls: [...methodCalls] }),
  };
}

async function acquire(value) {
  try { return await acquireWalletHistoryV2(value.req, { walletHistoryPort: value.port }); }
  catch (error) {
    const diagnostic = getWalletAcquisitionFailureDiagnosticV1(error);
    if (diagnostic !== null) error.message = JSON.stringify(diagnostic);
    throw error;
  }
}

function goldenTransactions(golden, wallet, tokenMint, quoteMint) {
  return golden.events.map((event, index) => fullTransaction({
    wallet,
    signature: event.signature,
    slot: Object.values(EXACT_RETAINED_HELIUS_BODIES_V1).find(body => body.signature === event.signature).slot,
    blockTime: event.timestamp,
    program: JUPITER_PROGRAM_V1,
    inputs: event.buy
      ? (golden === RAY_GOLDEN && index === 0
        ? [{ mint: quoteMint, raw: '24975000000' }, { mint: quoteMint, raw: '25000000' }]
        : [{ mint: quoteMint, raw: String(Math.round(event.quoteAmount * 1_000_000)) }])
      : [{ mint: tokenMint, raw: String(Math.round(event.tokenAmount * 1_000_000)) }],
    outputs: event.buy
      ? [{ mint: tokenMint, raw: String(Math.round(event.tokenAmount * 1_000_000)) }]
      : [{ mint: quoteMint, raw: String(Math.round(event.quoteAmount * 1_000_000)) }],
  }));
}

async function buildDownstreamArtifacts(acquisitionResult, tokenMint) {
  const evidenceBundle = buildCandidateEvidenceBundleV1({
    acquisitionResult,
    markObservations: [],
    profiles: acquisitionResult.profiles,
  });
  const candidateSet = buildWalletCandidateSetV1({ evidenceBundle });
  const candidate = candidateSet.payload.candidates.find(item => item.projection.token_mint === tokenMint);
  assert.equal(candidate.projection.selection_status, 'selectable');
  const resolution = resolveCandidateSelectionV1({
    candidateSet,
    evidenceBundle,
    selection: {
      candidate_set_digest: candidateSet.candidate_set_digest,
      candidate_digest: candidate.candidate_digest,
    },
  });
  const packaged = await orchestrateTargetedReceiptPackageV1(resolution.slice7_request, {});
  return { acquisitionResult, evidenceBundle, candidateSet, candidate, resolution, packaged };
}

for (const value of [
  { name: 'JUP', golden: JUP_GOLDEN, wallet: JUP_WALLET_V1, token: JUP_MINT_V1, quote: USDC_MINT_V1, retained: ['jup_buy','jup_sell'] },
  { name: 'RAY', golden: RAY_GOLDEN, wallet: RAY_WALLET_V1, token: RAY_MINT_V1, quote: USDT_MINT_V1, retained: ['ray_buy','ray_sell'] },
]) {
  test(`v2 full-transaction orchestration is byte-identical to the legacy ${value.name} oracle through package issuance`, async () => {
    const v2Result = await acquire(fixture({ wallet: value.wallet, transactions: goldenTransactions(value.golden, value.wallet, value.token, value.quote) }));
    const legacy = offlineWalletHistoryFixtureV1({ wallet: value.wallet, retainedBodyNames: value.retained });
    const legacyResult = await acquireWalletHistoryV1(legacy.request, {
      walletHistoryPort: createWalletHistoryPortV1(legacy.port, { beginAcquisitionV1() {} }),
    });
    const v2 = await buildDownstreamArtifacts(v2Result, value.token);
    const oracle = await buildDownstreamArtifacts(legacyResult, value.token);
    for (const field of ['acquisitionResult','evidenceBundle','candidateSet','resolution','packaged']) {
      assert.equal(canonicalJson(v2[field]), canonicalJson(oracle[field]), `${value.name} ${field} bytes`);
    }
    assert.equal(v2.evidenceBundle.evidence_bundle_digest, oracle.evidenceBundle.evidence_bundle_digest);
    assert.equal(v2.candidateSet.candidate_set_digest, oracle.candidateSet.candidate_set_digest);
    assert.equal(v2.candidate.candidate_digest, oracle.candidate.candidate_digest);
    assert.equal(canonicalJson(v2.resolution.slice7_request), canonicalJson(oracle.resolution.slice7_request));
    assert.equal(v2.packaged.receipt_hash, value.golden.receiptHash);
    assert.equal(v2.packaged.package_digest, value.golden.packageDigest);
    assert.deepEqual(v2.packaged.member_hashes, value.golden.memberHashes);
  });
}

test('v2 reconciles identical bulk duplicates once, excludes structurally valid noncanonical entries, and uses exact fallback only for absence', async () => {
  const [buy, sell] = goldenTransactions(JUP_GOLDEN, JUP_WALLET_V1, JUP_MINT_V1, USDC_MINT_V1);
  const filler = fullTransaction({ wallet: JUP_WALLET_V1, signature: providerSignature('post-anchor-filler'), slot: sell.slot + 2, blockTime: sell.block_time + 2, program: JUPITER_PROGRAM_V1, inputs: [], outputs: [] });
  const exact = new Map([[buy.signature, buy]]);
  const value = fixture({
    wallet: JUP_WALLET_V1,
    transactions: [buy, sell],
    bulkPages: [{ transactions: [filler, sell, structuredClone(sell)], pagination_token: null }],
    exact,
  });
  const result = await acquire(value);
  assert.deepEqual(result.transaction_dispositions.map(item => item.tx_hash).sort(), [buy.signature, sell.signature].sort());
  assert.equal(result.normalized_event_records.length, 2);
  assert.deepEqual(value.counts(), { signatureCalls: 2, bulkCalls: 1, fallbackCalls: 1 });
});

test('v2 counts structurally valid post-anchor noncanonical entries against the enrichment cap', async () => {
  const [buy, sell] = goldenTransactions(JUP_GOLDEN, JUP_WALLET_V1, JUP_MINT_V1, USDC_MINT_V1);
  const fillers = [4, 3, 2].map(offset => fullTransaction({
    wallet: JUP_WALLET_V1,
    signature: providerSignature(`post-anchor-cap-filler-${offset}`),
    slot: sell.slot + offset,
    blockTime: sell.block_time + offset,
    program: JUPITER_PROGRAM_V1,
    inputs: [],
    outputs: [],
  }));
  const value = fixture({
    wallet: JUP_WALLET_V1,
    transactions: [buy, sell],
    bulkPages: [{ transactions: [...fillers, sell, buy], pagination_token: null }],
    budgetOverrides: { max_transactions: 4 },
  });
  await assert.rejects(acquire(value), error => error.code === 'acquisition_capped');
  assert.deepEqual(value.counts(), { signatureCalls: 2, bulkCalls: 1, fallbackCalls: 0 });
});

test('v2 runs canonical acquisition, latest-state proof, and full enrichment under one acquisition start', async () => {
  const transactions = goldenTransactions(JUP_GOLDEN, JUP_WALLET_V1, JUP_MINT_V1, USDC_MINT_V1);
  const value = fixture({ wallet: JUP_WALLET_V1, transactions });
  await acquire(value);
  assert.deepEqual(value.lifecycle(), {
    beginCalls: 1,
    methodCalls: ['network','slot','block','signatures','signatures','bulk'],
  });
});

test('v2 preserves all five wallet-wide disposition classes and dense normalization semantics', async () => {
  const supported = fullTransaction({ wallet: JUP_WALLET_V1, signature: providerSignature('v2-supported'), slot: 50, blockTime: 3_000_000, program: JUPITER_PROGRAM_V1, inputs: [{ mint: USDC_MINT_V1, raw: '10' }], outputs: [{ mint: JUP_MINT_V1, raw: '20' }] });
  const unsupported = fullTransaction({ wallet: JUP_WALLET_V1, signature: providerSignature('v2-unsupported'), slot: 49, blockTime: 2_999_999, program: JUPITER_PROGRAM_V1, inputs: [{ mint: USDC_MINT_V1, raw: '10' }], outputs: [{ mint: JUP_MINT_V1, raw: '20' }, { mint: RAY_MINT_V1, raw: '1' }] });
  const ambiguous = fullTransaction({ wallet: JUP_WALLET_V1, signature: providerSignature('v2-ambiguous'), slot: 48, blockTime: 2_999_998, program: JUPITER_PROGRAM_V1, inputs: [{ mint: USDC_MINT_V1, raw: '10' }], outputs: [{ mint: JUP_MINT_V1, raw: '20' }, { mint: RAY_MINT_V1, raw: '1', owner: null }] });
  const unrelated = fullTransaction({ wallet: JUP_WALLET_V1, signature: providerSignature('v2-unrelated'), slot: 47, blockTime: 2_999_997, program: JUPITER_PROGRAM_V1, inputs: [], outputs: [] });
  const failed = fullTransaction({ wallet: JUP_WALLET_V1, signature: providerSignature('v2-failed'), slot: 46, blockTime: 2_999_996, program: JUPITER_PROGRAM_V1, inputs: [{ mint: USDC_MINT_V1, raw: '10' }], outputs: [{ mint: JUP_MINT_V1, raw: '20' }], failed: true });
  const result = await acquire(fixture({ wallet: JUP_WALLET_V1, transactions: [supported, unsupported, ambiguous, unrelated, failed] }));
  assert.deepEqual(new Set(result.transaction_dispositions.map(item => item.disposition_type)), new Set([
    'supported_normalized_event','unsupported_activity','ambiguous_activity','unrelated_activity','failed_transaction',
  ]));
  assert.deepEqual(result.normalized_event_records.map(item => item.slice7_event.raw_index), [0]);
  assert.equal(result.coverage.transactions_examined, 5);
});

test('v2 never repairs contradictory canonical bulk evidence through exact fallback', async () => {
  const [buy, sell] = goldenTransactions(JUP_GOLDEN, JUP_WALLET_V1, JUP_MINT_V1, USDC_MINT_V1);
  const contradictory = { ...buy, slot: buy.slot + 1 };
  const value = fixture({
    wallet: JUP_WALLET_V1,
    transactions: [buy, sell],
    bulkPages: [{ transactions: [sell, contradictory], pagination_token: null }],
    exact: new Map([[buy.signature, buy]]),
  });
  await assert.rejects(acquire(value), error => error.code === 'source_transaction_mismatch');
  assert.equal(value.counts().fallbackCalls, 0);
});

test('the complete static v2 production dependency closure excludes legacy Enhanced adapter and projector modules', () => {
  const pending = [
    new URL('./orchestrator.mjs', import.meta.url),
    new URL('./helius-full-transaction-adapter.mjs', import.meta.url),
  ];
  const visited = new Set();
  const forbidden = new Set(['helius-wallet-history-adapter.mjs','helius-enhanced-projector.mjs']);
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
