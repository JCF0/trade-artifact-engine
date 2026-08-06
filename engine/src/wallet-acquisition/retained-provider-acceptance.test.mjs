#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from '../candidate-set/serialize.mjs';
import { acquireWalletHistoryV1 } from './orchestrator.mjs';
import { createWalletHistoryPortV1 } from './provider-port.mjs';
import { projectHeliusEnhancedTransactionV1 } from './helius-enhanced-projector.mjs';
import { normalizeWalletWideSolanaSpotEvidenceV1 } from './wallet-wide-normalizer.mjs';
import {
  EXACT_RETAINED_HELIUS_BODIES_V1,
  JUP_MINT_V1,
  JUP_WALLET_V1,
  RAY_MINT_V1,
  RAY_WALLET_V1,
  USDT_MINT_V1,
  offlineWalletHistoryFixtureV1,
} from './fixtures/retained-provider-fixtures.mjs';

async function acquire(fixture) {
  return acquireWalletHistoryV1(fixture.request, { walletHistoryPort: createWalletHistoryPortV1(fixture.port, { beginAcquisitionV1() {} }) });
}

function eventValues(result) {
  return result.normalized_event_records.map(record => record.slice7_event);
}

for (const value of [
  { name: 'JUP', wallet: JUP_WALLET_V1, bodyNames: ['jup_buy', 'jup_sell'], tokenMint: JUP_MINT_V1 },
  { name: 'RAY', wallet: RAY_WALLET_V1, bodyNames: ['ray_buy', 'ray_sell'], tokenMint: RAY_MINT_V1 },
]) {
  test(`exact retained ${value.name} Helius Enhanced bodies replay through projection, reconciliation, normalization, classification, dense indexing, and acquisition-result construction`, async () => {
    const fixture = offlineWalletHistoryFixtureV1({ wallet: value.wallet, retainedBodyNames: value.bodyNames });
    const result = await acquire(fixture);
    assert.equal(fixture.exactRetainedBodies[0], EXACT_RETAINED_HELIUS_BODIES_V1[value.bodyNames[0]]);
    assert.equal(fixture.exactRetainedBodies[1], EXACT_RETAINED_HELIUS_BODIES_V1[value.bodyNames[1]]);
    assert.ok(Object.isFrozen(fixture.exactRetainedBodies[0]) && Object.isFrozen(fixture.exactRetainedBodies[0].events));
    assert.deepEqual(fixture.evidenceFidelity, {
      enhancedBodies: 'exact_retained_helius_enhanced_bodies',
      finalizedRpcEnvelopes: 'synthetic_finalized_rpc_envelopes',
      canonicalSignaturePages: 'synthetic_canonical_signature_pages',
      paginationFillers: 'none',
    });
    assert.deepEqual(fixture.exactRetainedBodies.map(body => body.source), ['JUPITER', 'JUPITER']);
    assert.equal(result.acquisition_result_version, 'wallet_wide_acquisition_result_v1');
    assert.deepEqual(result.transaction_dispositions.map(item => item.disposition_type), [
      'supported_normalized_event',
      'supported_normalized_event',
    ]);
    assert.deepEqual(eventValues(result).map(event => event.raw_index), [0, 1]);
    assert.deepEqual(new Set(result.transaction_dispositions.flatMap(item => item.affected_token_mints)), new Set([value.tokenMint]));
    assert.equal(result.coverage.transactions_examined, 2);
    assert.equal(result.coverage.supported_transaction_count, 2);
    assert.equal(result.coverage.normalized_event_count, 2);
    assert.equal(result.coverage.finding_count, 0);
    assert.deepEqual(fixture.observed.requested_signatures.sort(), value.bodyNames.map(name => EXACT_RETAINED_HELIUS_BODIES_V1[name].signature).sort());
    const serialized = JSON.stringify(result);
    for (const forbidden of ['description','tokenTransfers','nativeTransfers','accountData','instructions','transactionError']) assert.equal(serialized.includes(forbidden), false);
  });
}

test('exact retained RAY buy preserves two wallet-owned USDT inputs, exact 25,000 aggregate, retained Helius source label, and deterministic leg order', async () => {
  const exact = EXACT_RETAINED_HELIUS_BODIES_V1.ray_buy;
  assert.equal(exact.source, 'JUPITER');
  assert.deepEqual(exact.events.swap.tokenInputs.map(leg => leg.rawTokenAmount.tokenAmount), ['24975000000', '25000000']);
  assert.deepEqual(exact.tokenTransfers.filter(leg => leg.fromUserAccount === RAY_WALLET_V1 && leg.mint === USDT_MINT_V1).map(leg => leg.tokenAmount), [24975, 25]);
  const projected = projectHeliusEnhancedTransactionV1({ wallet: RAY_WALLET_V1, transaction: exact });
  assert.equal(Object.hasOwn(projected, 'source'), false);
  assert.deepEqual(projected.structured_swap_groups[0].token_inputs.map(leg => leg.raw_amount), ['24975000000', '25000000']);
  const normalized = normalizeWalletWideSolanaSpotEvidenceV1({ evidence: projected, provisional_raw_index: 0 });
  assert.equal(normalized.outcome, 'supported_event');
  assert.equal(normalized.event.token_in_mint, USDT_MINT_V1);
  assert.equal(normalized.event.token_in_amount, 25000);
  assert.equal(normalized.event.token_out_mint, RAY_MINT_V1);
  assert.equal(normalized.event.source, 'wallet_source_transaction_v1');

  const permutedBody = structuredClone(exact);
  permutedBody.events.swap.tokenInputs.reverse();
  const permutedProjected = projectHeliusEnhancedTransactionV1({ wallet: RAY_WALLET_V1, transaction: permutedBody });
  const permutedNormalized = normalizeWalletWideSolanaSpotEvidenceV1({ evidence: permutedProjected, provisional_raw_index: 0 });
  assert.deepEqual(permutedNormalized, normalized);
});

test('exact retained Jupiter CLOSE_ACCOUNT body is localized ambiguous under conservative closure handling and never inferred as a trade from closure metadata', async () => {
  const fixture = offlineWalletHistoryFixtureV1({
    wallet: JUP_WALLET_V1,
    retainedBodyNames: ['jupiter_close_account_swap'],
  });
  const exact = fixture.exactRetainedBodies[0];
  assert.equal(exact.type, 'CLOSE_ACCOUNT');
  assert.equal(exact.source, 'SOLANA_PROGRAM_LIBRARY');
  const result = await acquire(fixture);
  assert.equal(result.normalized_event_records.length, 0);
  assert.equal(result.transaction_dispositions.length, 1);
  assert.equal(result.transaction_dispositions[0].disposition_type, 'ambiguous_activity');
  assert.deepEqual(result.transaction_dispositions[0].affected_token_mints, ['7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr']);
  assert.equal(result.activity_findings.length, 1);
  assert.deepEqual(result.activity_findings[0].reason_codes, ['ambiguous_swap_direction']);
  assert.equal(result.coverage.ambiguous_transaction_count, 1);
});

test('Enhanced response permutation and synthetic canonical full-page prefix leave retained authoritative acquisition bytes unchanged', async () => {
  const directFixture = offlineWalletHistoryFixtureV1({
    wallet: RAY_WALLET_V1,
    retainedBodyNames: ['ray_buy', 'ray_sell'],
  });
  const permutedFixture = offlineWalletHistoryFixtureV1({
    wallet: RAY_WALLET_V1,
    retainedBodyNames: ['ray_buy', 'ray_sell'],
    enhancedOrder: 'reversed',
    pageLayout: 'synthetic_full_prefix',
  });
  const direct = await acquire(directFixture);
  const permuted = await acquire(permutedFixture);
  assert.equal(permutedFixture.syntheticPageFillersUsed, 99);
  assert.equal(permutedFixture.evidenceFidelity.paginationFillers, 'synthetic_post_anchor_unrelated_fillers');
  assert.equal(permutedFixture.evidenceFidelity.finalizedRpcEnvelopes, 'synthetic_finalized_rpc_envelopes');
  assert.equal(canonicalJson(permuted), canonicalJson(direct));
  assert.deepEqual(permuted.transaction_dispositions.map(item => item.tx_hash).sort(), direct.transaction_dispositions.map(item => item.tx_hash).sort());
  assert.deepEqual(new Set(permuted.transaction_dispositions.map(item => item.disposition_type)), new Set(['supported_normalized_event']));
});
