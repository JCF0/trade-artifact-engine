#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BoundedAcquisitionError } from './acquisition-contract.mjs';
import { createHeliusEnhancedTransactionsAcquisitionAdapter } from './helius-enhanced-transactions-adapter.mjs';
import {
  orchestrateTargetedReceiptPackageV1,
  TARGETED_RECEIPT_PACKAGE_PROFILES_V1,
} from '../receipt-package/targeted-orchestrator.mjs';

const fixtureUrl = new URL('./fixtures/retained-helius-real-shapes.json', import.meta.url);
const { transactions: REAL } = JSON.parse(readFileSync(fixtureUrl, 'utf8'));

const CASES = Object.freeze([
  Object.freeze({
    name: 'RAY',
    wallet: '5fK3484fbh8gnmhvTsPYxTC6un7Co5LVUSoubZPVL3YA',
    token: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    buy: 'ray_buy',
    sell: 'ray_sell',
    expectedDigest: '25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2',
  }),
  Object.freeze({
    name: 'JUP',
    wallet: '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni',
    token: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    buy: 'jup_buy',
    sell: 'jup_sell',
    expectedDigest: '5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278',
  }),
]);

function request({ wallet, token, oldest, newest, maxPages = 4, maxTransactions = 400 }) {
  return {
    wallet,
    target: { token_mint: token, receipt_type: 'closed_position', segment_index: 0 },
    bounds: {
      before_signature: null,
      oldest_allowed_timestamp: oldest,
      newest_allowed_timestamp: newest,
      max_pages: maxPages,
      max_transactions: maxTransactions,
      request_timeout_ms: 1000,
      overall_timeout_ms: 10000,
      max_attempts_per_page: 2,
    },
    fetch_profile: TARGETED_RECEIPT_PACKAGE_PROFILES_V1.fetch_profile,
    normalization_profile: TARGETED_RECEIPT_PACKAGE_PROFILES_V1.normalization_profile,
  };
}

function adapterFor(pages) {
  let index = 0;
  return createHeliusEnhancedTransactionsAcquisitionAdapter({
    httpClient: {
      async request() {
        const page = pages[Math.min(index, pages.length - 1)];
        index += 1;
        return { status: 200, data: structuredClone(page) };
      },
    },
    apiKeyProvider: () => 'offline-fixture-key',
    sleep: async () => {},
    clock: () => 0,
    random: () => 0,
  });
}

function caseRequest(value) {
  const buy = REAL[value.buy];
  const sell = REAL[value.sell];
  return request({
    wallet: value.wallet,
    token: value.token,
    oldest: buy.timestamp - 1,
    newest: sell.timestamp + 1,
  });
}

async function acquireCase(value, pages = [[REAL[value.sell], REAL[value.buy]]]) {
  return adapterFor(pages).acquireNormalizedSolanaSpotEventsV1(caseRequest(value));
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BoundedAcquisitionError);
    assert.equal(error.code, code);
    return true;
  });
}

for (const value of CASES) {
  test(`retained ${value.name} Helius shapes normalize into the exact Slice 7 package identity`, async () => {
    const acquired = await acquireCase(value);
    const result = await orchestrateTargetedReceiptPackageV1({
      normalizedEvents: acquired.normalizedEvents,
      inputStatus: acquired.inputStatus,
      target: {
        wallet: value.wallet,
        token_mint: value.token,
        receipt_type: 'closed_position',
        segment_index: 0,
      },
      profiles: { ...TARGETED_RECEIPT_PACKAGE_PROFILES_V1 },
      mode: 'dry_run',
    }, {});
    assert.equal(result.package_digest, value.expectedDigest);
    assert.equal(result.status, 'dry_run');
  });
}

test('retained RAY buy aggregates its two wallet-owned USDT inputs exactly once', async () => {
  const ray = CASES[0];
  const acquired = await adapterFor([[REAL.ray_buy]]).acquireNormalizedSolanaSpotEventsV1(caseRequest(ray));
  assert.equal(acquired.normalizedEvents.length, 1);
  assert.deepEqual(acquired.normalizedEvents[0], {
    wallet: ray.wallet,
    timestamp: 1769382291,
    tx_hash: REAL.ray_buy.signature,
    source: 'JUPITER',
    token_in_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    token_in_amount: 25000,
    token_in_decimals: 6,
    token_out_mint: ray.token,
    token_out_amount: 26644.791399,
    token_out_decimals: 6,
    extraction_method: 'helius_enhanced_transaction_swap_v1',
    raw_index: 0,
  });
});

test('same-mint input aggregation is invariant to input-leg order', async () => {
  const ray = CASES[0];
  const reversed = structuredClone(REAL.ray_buy);
  reversed.events.swap.tokenInputs.reverse();
  const [original, permuted] = await Promise.all([
    adapterFor([[REAL.ray_buy]]).acquireNormalizedSolanaSpotEventsV1(caseRequest(ray)),
    adapterFor([[reversed]]).acquireNormalizedSolanaSpotEventsV1(caseRequest(ray)),
  ]);
  assert.deepEqual(permuted.normalizedEvents, original.normalizedEvents);
});

test('duplicate same-mint input legs are deterministically included in the raw sum', async () => {
  const ray = CASES[0];
  const duplicated = structuredClone(REAL.ray_buy);
  duplicated.events.swap.tokenInputs.push(structuredClone(duplicated.events.swap.tokenInputs[1]));
  const acquired = await adapterFor([[duplicated]]).acquireNormalizedSolanaSpotEventsV1(caseRequest(ray));
  assert.equal(acquired.normalizedEvents[0].token_in_amount, 25025);
});

test('mixed input mints and economically distinct multiple outputs are rejected', async () => {
  const ray = CASES[0];
  const mixed = structuredClone(REAL.ray_buy);
  mixed.events.swap.tokenInputs[1].mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  await expectCode(adapterFor([[mixed]]).acquireNormalizedSolanaSpotEventsV1(caseRequest(ray)), 'normalization_ambiguous');

  const outputs = structuredClone(REAL.ray_buy);
  const extra = structuredClone(outputs.events.swap.tokenOutputs[0]);
  extra.mint = 'So11111111111111111111111111111111111111112';
  outputs.events.swap.tokenOutputs.push(extra);
  await expectCode(adapterFor([[outputs]]).acquireNormalizedSolanaSpotEventsV1(caseRequest(ray)), 'normalization_ambiguous');
});

test('retained Jupiter CLOSE_ACCOUNT swap is accepted only through DEX and wallet-transfer evidence', async () => {
  const tx = REAL.jupiter_close_account_swap;
  const token = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
  const acquired = await adapterFor([[tx]]).acquireNormalizedSolanaSpotEventsV1(request({
    wallet: CASES[1].wallet,
    token,
    oldest: tx.timestamp,
    newest: tx.timestamp,
  }));
  assert.equal(acquired.normalizedEvents.length, 1);
  assert.deepEqual({
    token_in_mint: acquired.normalizedEvents[0].token_in_mint,
    token_in_amount: acquired.normalizedEvents[0].token_in_amount,
    token_in_decimals: acquired.normalizedEvents[0].token_in_decimals,
    token_out_mint: acquired.normalizedEvents[0].token_out_mint,
    token_out_amount: acquired.normalizedEvents[0].token_out_amount,
    token_out_decimals: acquired.normalizedEvents[0].token_out_decimals,
  }, {
    token_in_mint: token,
    token_in_amount: 191373.113492767,
    token_in_decimals: 9,
    token_out_mint: 'So11111111111111111111111111111111111111112',
    token_out_amount: 475.549617784,
    token_out_decimals: 9,
  });
});

test('unrelated CLOSE_ACCOUNT activity is ignored and closure alone is never a trade', async () => {
  const tx = REAL.jupiter_close_account_swap;
  const unrelated = await adapterFor([[tx]]).acquireNormalizedSolanaSpotEventsV1(request({
    wallet: CASES[1].wallet,
    token: CASES[1].token,
    oldest: tx.timestamp,
    newest: tx.timestamp,
  }));
  assert.deepEqual(unrelated.normalizedEvents, []);

  const closureOnly = {
    signature: 'closure-only',
    timestamp: tx.timestamp,
    type: 'CLOSE_ACCOUNT',
    source: 'SOLANA_PROGRAM_LIBRARY',
    feePayer: CASES[1].wallet,
    transactionError: null,
    events: {},
    tokenTransfers: [],
    nativeTransfers: [],
    accountData: [{ tokenBalanceChanges: [{ mint: CASES[1].token }] }],
    instructions: [{ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', innerInstructions: [] }],
  };
  await expectCode(adapterFor([[closureOnly]]).acquireNormalizedSolanaSpotEventsV1(request({
    wallet: CASES[1].wallet,
    token: CASES[1].token,
    oldest: tx.timestamp,
    newest: tx.timestamp,
  })), 'unsupported_target_activity');
});

test('target-relevant CLOSE_ACCOUNT without recognized DEX evidence is rejected', async () => {
  const tx = structuredClone(REAL.jupiter_close_account_swap);
  tx.instructions = [];
  await expectCode(adapterFor([[tx]]).acquireNormalizedSolanaSpotEventsV1(request({
    wallet: CASES[1].wallet,
    token: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    oldest: tx.timestamp,
    newest: tx.timestamp,
  })), 'unsupported_target_activity');
});

test('retained RAY normalization is invariant to provider page chunking', async () => {
  const ray = CASES[0];
  const direct = await acquireCase(ray);
  const fillers = Array.from({ length: 99 }, (_, index) => ({
    signature: `retained-shape-filler-${index}`,
    timestamp: REAL.ray_sell.timestamp - index - 1,
    type: 'TRANSFER',
    source: 'SYSTEM_PROGRAM',
    feePayer: ray.wallet,
    transactionError: null,
    events: {},
    tokenTransfers: [],
    nativeTransfers: [],
    accountData: [],
    instructions: [],
  }));
  const firstPage = [REAL.ray_sell, ...fillers];
  const secondPage = [REAL.ray_buy];
  const chunked = await acquireCase(ray, [firstPage, secondPage]);
  assert.deepEqual(chunked.normalizedEvents, direct.normalizedEvents);
});
