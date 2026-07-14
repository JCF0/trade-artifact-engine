#!/usr/bin/env node

import assert from 'assert';
import { normalizeTransactions } from './ingest.mjs';
import { USDT_MINT } from './constants.mjs';

const WALLET = '5fK3484fbh8gnmhvTsPYxTC6un7Co5LVUSoubZPVL3YA';
const RAY_MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const BUY_TX = '2SUoNBBTkQBBGVCinvLQbVZq5LDZS5M8ikx5PLH7QiCuLdf6GWCPSM7wLd6gJsNUbLSousAhbkSX9eXgt1dAeBKm';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function makeRayBuyTransaction() {
  return {
    signature: BUY_TX,
    timestamp: 1769382291,
    type: 'SWAP',
    source: 'JUPITER',
    transactionError: null,
    events: {
      swap: {
        tokenInputs: [
          {
            mint: USDT_MINT,
            rawTokenAmount: { tokenAmount: '24975000000', decimals: 6 },
          },
          {
            mint: USDT_MINT,
            rawTokenAmount: { tokenAmount: '25000000', decimals: 6 },
          },
        ],
        tokenOutputs: [
          {
            mint: RAY_MINT,
            rawTokenAmount: { tokenAmount: '26644791399', decimals: 6 },
          },
        ],
      },
    },
    tokenTransfers: [],
    nativeTransfers: [],
    instructions: [],
  };
}

await test('validated RAY real-shape transaction normalizes once as same-mint aggregation', () => {
  const { events, stats } = normalizeTransactions([makeRayBuyTransaction()], WALLET, { silent: true });

  assert.equal(events.length, 1);
  assert.equal(stats.swaps, 1);
  assert.equal(stats.skipped.ambiguous, 0);

  const event = events[0];
  assert.equal(event.tx_hash, BUY_TX);
  assert.equal(event.extraction_method, 'events_swap_same_mint_aggregated');
  assert.equal(event.token_in_mint, USDT_MINT);
  assert.equal(event.token_in_amount, 25000);
  assert.equal(event.token_in_decimals, 6);
  assert.equal(event.token_out_mint, RAY_MINT);
  assert.equal(event.token_out_amount, 26644.791399);
  assert.equal(event.token_out_decimals, 6);
  assert.equal(event.raw_index, 0);
});

await test('canonical-facing normalized event excludes diagnostic aggregation metadata', () => {
  const { events } = normalizeTransactions([makeRayBuyTransaction()], WALLET, { silent: true });
  const event = events[0];

  assert.equal(Object.hasOwn(event, 'diagnostic_metadata'), false);
  assert.equal(Object.hasOwn(event, 'input_refs'), false);
  assert.equal(Object.hasOwn(event, 'aggregate_raw'), false);
  assert.equal(Object.hasOwn(event, 'raw_transfer_refs'), false);
});

await test('fixture is deterministic across repeated normalization', () => {
  const first = normalizeTransactions([makeRayBuyTransaction()], WALLET, { silent: true }).events;
  const second = normalizeTransactions([makeRayBuyTransaction()], WALLET, { silent: true }).events;

  assert.deepEqual(first, second);
});

console.log(`\nSame-mint real-shape tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
