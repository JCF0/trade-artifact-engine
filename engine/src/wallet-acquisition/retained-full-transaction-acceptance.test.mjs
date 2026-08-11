#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWalletCandidateSetV1 } from '../candidate-set/builder.mjs';
import { buildCandidateEvidenceBundleV1 } from '../candidate-set/evidence-bundle.mjs';
import { JUP_GOLDEN, RAY_GOLDEN } from '../candidate-set/fixtures/deterministic-fixtures.mjs';
import { resolveCandidateSelectionV1 } from '../candidate-set/selection-resolver.mjs';
import { canonicalJson } from '../candidate-set/serialize.mjs';
import { orchestrateTargetedReceiptPackageV1 } from '../receipt-package/targeted-orchestrator.mjs';
import { acquireWalletHistoryV1, acquireWalletHistoryV2 } from './orchestrator.mjs';
import { createWalletHistoryPortV1 } from './provider-port.mjs';
import { createWalletHistoryPortV2 } from './provider-port-v2.mjs';
import {
  EXACT_RETAINED_HELIUS_BODIES_V1,
  JUP_MINT_V1,
  JUP_WALLET_V1,
  RAY_MINT_V1,
  RAY_WALLET_V1,
  USDT_MINT_V1,
  offlineWalletHistoryFixtureV1,
} from './fixtures/retained-provider-fixtures.mjs';
import * as retainedFullTransactionFixtures from './fixtures/retained-full-transaction-fixtures.mjs';

const {
  EXACT_RETAINED_FULL_TRANSACTION_BODIES_V1,
  RETAINED_FULL_TRANSACTION_MANIFEST_V1,
  offlineFullTransactionHistoryFixtureV2,
} = retainedFullTransactionFixtures;

const CASES = Object.freeze([
  Object.freeze({
    name: 'JUP', wallet: JUP_WALLET_V1, token: JUP_MINT_V1,
    full: ['jup_buy_full', 'jup_sell_full'], legacy: ['jup_buy', 'jup_sell'], golden: JUP_GOLDEN,
  }),
  Object.freeze({
    name: 'RAY', wallet: RAY_WALLET_V1, token: RAY_MINT_V1,
    full: ['ray_buy_full', 'ray_sell_full'], legacy: ['ray_buy', 'ray_sell'], golden: RAY_GOLDEN,
  }),
]);

async function acquireFull(value) {
  return acquireWalletHistoryV2(value.request, {
    walletHistoryPort: createWalletHistoryPortV2(value.port, { beginAcquisitionV2() {} }),
  });
}

async function acquireLegacy(value) {
  return acquireWalletHistoryV1(value.request, {
    walletHistoryPort: createWalletHistoryPortV1(value.port, { beginAcquisitionV1() {} }),
  });
}

async function downstream(acquisitionResult, tokenMint) {
  const evidenceBundle = buildCandidateEvidenceBundleV1({
    acquisitionResult,
    markObservations: [],
    profiles: acquisitionResult.profiles,
  });
  const candidateSet = buildWalletCandidateSetV1({ evidenceBundle });
  const candidate = candidateSet.payload.candidates.find(item => item.projection.token_mint === tokenMint);
  assert.equal(candidate?.projection.selection_status, 'selectable');
  const selection = {
    candidate_set_digest: candidateSet.candidate_set_digest,
    candidate_digest: candidate.candidate_digest,
  };
  const resolution = resolveCandidateSelectionV1({ candidateSet, evidenceBundle, selection });
  const packaged = await orchestrateTargetedReceiptPackageV1(resolution.slice7_request, {});
  return { evidenceBundle, candidateSet, candidate, selection, resolution, packaged };
}

function eventBytes(result) {
  return result.normalized_event_records.map(record => canonicalJson(record.slice7_event));
}

test('admitted Slice 7 capture is exact, immutable, hash-bound, and explicitly fidelity-labeled', () => {
  assert.deepEqual(Object.keys(EXACT_RETAINED_FULL_TRANSACTION_BODIES_V1).sort(), [
    'jup_buy_full','jup_sell_full','jupiter_close_account_full','ray_buy_full','ray_sell_full',
  ]);
  assert.equal(RETAINED_FULL_TRANSACTION_MANIFEST_V1.authoritative, false);
  assert.equal(RETAINED_FULL_TRANSACTION_MANIFEST_V1.overall_status, 'PASS');
  assert.deepEqual(RETAINED_FULL_TRANSACTION_MANIFEST_V1.provider_call_budget, {
    actual: 10, maximum: 10, respected: true,
  });
  assert.deepEqual(RETAINED_FULL_TRANSACTION_MANIFEST_V1.telemetry, { retry_count: 0, timeout_count: 0 });
  assert.equal(Object.isFrozen(EXACT_RETAINED_FULL_TRANSACTION_BODIES_V1), true);
  for (const body of Object.values(EXACT_RETAINED_FULL_TRANSACTION_BODIES_V1)) {
    assert.equal(Object.isFrozen(body), true);
    assert.equal(Object.isFrozen(body.transaction), true);
    assert.equal(Object.isFrozen(body.meta), true);
  }
  const manifestBytes = canonicalJson(RETAINED_FULL_TRANSACTION_MANIFEST_V1);
  for (const forbidden of ['api-key','authorization','headers','paginationToken','request object','retry internals']) {
    assert.equal(manifestBytes.toLowerCase().includes(forbidden.toLowerCase()), false);
  }

  assert.doesNotThrow(() => retainedFullTransactionFixtures.validateRetainedFullTransactionManifestV1(
    RETAINED_FULL_TRANSACTION_MANIFEST_V1,
  ));
  for (const mutate of [
    manifest => { manifest.unexpected = true; },
    manifest => { manifest.provider_call_budget.unexpected = true; },
    manifest => { manifest.telemetry.unexpected = true; },
    manifest => { manifest.fixtures[0].unexpected = true; },
    manifest => { manifest.fixtures[0].retained_file.unexpected = true; },
  ]) {
    const manifest = structuredClone(RETAINED_FULL_TRANSACTION_MANIFEST_V1);
    mutate(manifest);
    assert.throws(
      () => retainedFullTransactionFixtures.validateRetainedFullTransactionManifestV1(manifest),
      { name: 'TypeError', message: 'retained full-transaction fixture fidelity check failed' },
    );
  }
});

for (const value of CASES) {
  test(`retained real full transactions preserve exact ${value.name} bytes through every frozen identity boundary`, async () => {
    const fullFixture = offlineFullTransactionHistoryFixtureV2({ wallet: value.wallet, retainedBodyNames: value.full });
    const legacyFixture = offlineWalletHistoryFixtureV1({ wallet: value.wallet, retainedBodyNames: value.legacy });
    assert.deepEqual(fullFixture.evidenceFidelity, {
      fullTransactionBodies: 'exact_retained_finalized_get_transaction_results',
      crossMethodEquality: 'slice7_individual_vs_bulk_canonical_equality_passed',
      finalizedRpcEnvelopes: 'synthetic_finalized_rpc_envelopes',
      canonicalSignaturePages: 'synthetic_canonical_signature_pages',
      fullTransactionPages: 'synthetic_pages_around_exact_retained_transactions',
      paginationFillers: 'none',
    });

    const fullResult = await acquireFull(fullFixture);
    const legacyResult = await acquireLegacy(legacyFixture);
    assert.deepEqual(eventBytes(fullResult), eventBytes(legacyResult), `${value.name} normalized events`);
    assert.equal(canonicalJson(fullResult), canonicalJson(legacyResult), `${value.name} acquisition result`);

    const full = await downstream(fullResult, value.token);
    const oracle = await downstream(legacyResult, value.token);
    assert.equal(canonicalJson(full.evidenceBundle), canonicalJson(oracle.evidenceBundle), `${value.name} evidence bundle`);
    assert.equal(canonicalJson(full.candidateSet), canonicalJson(oracle.candidateSet), `${value.name} candidate set`);
    assert.deepEqual(full.selection, oracle.selection, `${value.name} digest-only selection`);
    assert.equal(canonicalJson(full.resolution), canonicalJson(oracle.resolution), `${value.name} resolution`);
    assert.equal(canonicalJson(full.resolution.slice7_request), canonicalJson(oracle.resolution.slice7_request), `${value.name} Slice 7 request`);
    assert.equal(full.resolution.slice7_request.mode, 'dry_run');
    assert.equal(canonicalJson(full.packaged), canonicalJson(oracle.packaged), `${value.name} Slice 7 dry-run result`);
    assert.equal(full.packaged.status, 'dry_run');
    assert.equal(full.packaged.receipt_hash, value.golden.receiptHash);
    assert.equal(full.packaged.package_digest, value.golden.packageDigest);
    assert.deepEqual(full.packaged.member_hashes, value.golden.memberHashes);
    assert.deepEqual(fullFixture.observed.counts(), { signatureCalls: 2, bulkCalls: 1, fallbackCalls: 0 });
  });
}

test('retained real RAY buy reconciles 24,975 plus 25 USDT exactly once into 25,000', async () => {
  const fixture = offlineFullTransactionHistoryFixtureV2({ wallet: RAY_WALLET_V1, retainedBodyNames: ['ray_buy_full'] });
  const transaction = fixture.detachedTransactions[0];
  const pre = new Map(transaction.pre_token_balances.map(row => [row.account_index, row]));
  const debits = transaction.post_token_balances
    .filter(row => row.owner === RAY_WALLET_V1 && row.mint === USDT_MINT_V1)
    .map(row => BigInt(pre.get(row.account_index).raw_amount) - BigInt(row.raw_amount))
    .filter(amount => amount > 0n)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  assert.deepEqual(debits, [25_000_000_000n]);
  assert.equal(debits.reduce((sum, amount) => sum + amount, 0n), 25_000_000_000n);
  const legacyInputs = EXACT_RETAINED_HELIUS_BODIES_V1.ray_buy.events.swap.tokenInputs
    .map(leg => BigInt(leg.rawTokenAmount.tokenAmount))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  assert.deepEqual(legacyInputs, [25_000_000n, 24_975_000_000n]);
  assert.equal(legacyInputs.reduce((sum, amount) => sum + amount, 0n), debits[0]);
  const result = await acquireFull(fixture);
  assert.equal(result.normalized_event_records.length, 1);
  assert.equal(result.normalized_event_records[0].slice7_event.token_in_mint, USDT_MINT_V1);
  assert.equal(result.normalized_event_records[0].slice7_event.token_in_amount, 25000);
});

test('retained real Jupiter close-account transaction replays conservatively and fails closed before result issuance', async () => {
  const fixture = offlineFullTransactionHistoryFixtureV2({
    wallet: JUP_WALLET_V1,
    retainedBodyNames: ['jupiter_close_account_full'],
  });
  await assert.rejects(acquireFull(fixture), error => error.code === 'wallet_wide_impact_unresolved');
  assert.deepEqual(fixture.observed.counts(), { signatureCalls: 2, bulkCalls: 1, fallbackCalls: 0 });
});

// Keep the legacy oracle test-only and prove the five retained identities remain distinct.
test('retained full-transaction and legacy oracle bodies bind the same five approved source identities', () => {
  const full = Object.values(EXACT_RETAINED_FULL_TRANSACTION_BODIES_V1)
    .map(body => body.transaction.signatures[0]);
  const legacy = Object.values(EXACT_RETAINED_HELIUS_BODIES_V1)
    .filter(body => full.includes(body.signature))
    .map(body => body.signature);
  assert.equal(new Set(full).size, 5);
  assert.deepEqual([...legacy].sort(), [...full].sort());
});
