#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeliusEnhancedTransactionsAcquisitionAdapter } from './helius-enhanced-transactions-adapter.mjs';
import { orchestrateTargetedReceiptPackageV1, TARGETED_RECEIPT_PACKAGE_PROFILES_V1 } from '../receipt-package/targeted-orchestrator.mjs';

const FIXTURES = [
  {
    name: 'JUP', wallet: '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni', token: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', quote: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    buyTx: '2ArLuJC2JEuWiavk1jYxLQ2E4xhq63BbeDV2kCWPcZ9zZNc4XyugUEFEryKrYfqcWnxkUvyacRmj2YNTfZGq17yV', sellTx: '5YCdUYkJVx3kkZUpvz4ygs6QT8GZtYtru4kGkur3LJ8yrMmW2XJ8qXtgjspMpJqqyQA6WPDQxd4BcTpNNSr3Dctk',
    buyAt: 1781904268, sellAt: 1782068814, buyToken: '265951319268', buyQuote: '49728694003', sellToken: '265951319268', sellQuote: '58016532850', source: 'JUPITER', expected: '5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278',
  },
  {
    name: 'RAY', wallet: '5fK3484fbh8gnmhvTsPYxTC6un7Co5LVUSoubZPVL3YA', token: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', quote: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    buyTx: '2SUoNBBTkQBBGVCinvLQbVZq5LDZS5M8ikx5PLH7QiCuLdf6GWCPSM7wLd6gJsNUbLSousAhbkSX9eXgt1dAeBKm', sellTx: '4TmWRpMxWRTpQqNM7iFCRyP1m9VEyRK54VZwKeQV4cYisYRjQRjuvocF8j7mNAomoQf6H2h4vfd5Qp6Y2LQxeEsB',
    buyAt: 1769382291, sellAt: 1769632666, buyToken: '26644791399', buyQuote: '25000000000', sellToken: '26644791399', sellQuote: '27347717902', source: 'RAYDIUM', expected: '25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2',
  },
];

function leg(wallet, mint, tokenAmount) {
  return { userAccount: wallet, mint, rawTokenAmount: { tokenAmount, decimals: 6 } };
}

function transaction(fixture, direction) {
  const buy = direction === 'buy';
  return {
    signature: buy ? fixture.buyTx : fixture.sellTx,
    timestamp: buy ? fixture.buyAt : fixture.sellAt,
    type: 'SWAP', source: fixture.source, feePayer: fixture.wallet, tokenTransfers: [],
    events: { swap: {
      tokenInputs: [leg(fixture.wallet, buy ? fixture.quote : fixture.token, buy ? fixture.buyQuote : fixture.sellToken)],
      tokenOutputs: [leg(fixture.wallet, buy ? fixture.token : fixture.quote, buy ? fixture.buyToken : fixture.sellQuote)],
    } },
  };
}

function unrelated(fixture) {
  return {
    signature: `${fixture.name}-unrelated`,
    timestamp: fixture.buyAt + 1,
    type: 'TRANSFER', source: 'SYSTEM_PROGRAM', feePayer: fixture.wallet,
    events: {}, tokenTransfers: [],
  };
}

function acquisitionRequest(fixture) {
  return {
    wallet: fixture.wallet,
    target: { token_mint: fixture.token, receipt_type: 'closed_position', segment_index: 0 },
    bounds: { before_signature: null, oldest_allowed_timestamp: fixture.buyAt - 1, newest_allowed_timestamp: fixture.sellAt + 1, max_pages: 2, max_transactions: 100, request_timeout_ms: 1000, overall_timeout_ms: 10000, max_attempts_per_page: 2 },
    fetch_profile: TARGETED_RECEIPT_PACKAGE_PROFILES_V1.fetch_profile,
    normalization_profile: TARGETED_RECEIPT_PACKAGE_PROFILES_V1.normalization_profile,
  };
}

for (const fixture of FIXTURES) {
  test(`mocked ${fixture.name} acquisition reproduces the pinned Slice 7 package digest without a store`, async () => {
    let storeTouched = false;
    const pages = [[transaction(fixture, 'sell'), unrelated(fixture), transaction(fixture, 'buy')]];
    const adapter = createHeliusEnhancedTransactionsAcquisitionAdapter({
      httpClient: { request: async () => ({ status: 200, data: structuredClone(pages.shift()) }) },
      apiKeyProvider: () => 'mock-only-key', sleep: async () => {}, clock: () => 0, random: () => 0,
    });
    const acquired = await adapter.acquireNormalizedSolanaSpotEventsV1(acquisitionRequest(fixture));
    const result = await orchestrateTargetedReceiptPackageV1({
      normalizedEvents: acquired.normalizedEvents,
      inputStatus: acquired.inputStatus,
      target: { wallet: fixture.wallet, token_mint: fixture.token, receipt_type: 'closed_position', segment_index: 0 },
      profiles: { ...TARGETED_RECEIPT_PACKAGE_PROFILES_V1 },
      mode: 'dry_run',
    }, { packageStore: new Proxy({}, { get() { storeTouched = true; throw new Error('store touched'); } }) });
    assert.equal(result.package_digest, fixture.expected);
    assert.equal(result.status, 'dry_run');
    assert.equal(storeTouched, false);
  });
}

test('Slice 7 rejects an incomplete acquisition status', async () => {
  const fixture = FIXTURES[0];
  await assert.rejects(orchestrateTargetedReceiptPackageV1({
    normalizedEvents: [],
    inputStatus: { acquisition_complete: false, normalization_complete: true, pagination_complete: false, truncated: false, capped: true, partial: true, provider_uncertain: false },
    target: { wallet: fixture.wallet, token_mint: fixture.token, receipt_type: 'closed_position', segment_index: 0 },
    profiles: { ...TARGETED_RECEIPT_PACKAGE_PROFILES_V1 }, mode: 'dry_run',
  }, {}), error => error.code === 'incomplete_acquisition_input');
});
