import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getWhirlpoolDecoder, getTickArrayDecoder, decodeFixedWhirlpoolV1, decodeFixedTickArrayV1, swapQuoteByInputToken } from '../../../orca-readiness-sdk/index.mjs';
import { createFrozenControlledHeliusTargetAccountEnumerationPortV2, captureTargetAccountEnumerationV1 } from '../../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import { reviveSolanaRentEpochV1 } from '../../wallet-acquisition/solana-rent-epoch-v1.mjs';
const root = new URL('../../../orca-readiness-sdk/fixtures/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, root)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('retained calibration: real decoders and WASM reproduce recorded state and quote; strict minimum is independent', () => {
  const provenance = read('provenance.json');
  for (const member of provenance.members) {
    assert.equal(hash(readFileSync(new URL(member.member.split('/').at(-1), root))), member.sha256);
  }
  const recorded = read('build-and-quote.json');
  const first = read('raw-rpc-3106-getAccountInfo.json').result;
  const route = read('raw-rpc-3107-getMultipleAccounts.json').result;
  const bytes = account => Buffer.from(account.data[0], 'base64');
  assert.equal(hash(bytes(first.value)), recorded.first_pool.data_sha256);
  assert.equal(first.context.slot, recorded.first_pool.context_slot);
  assert.equal(route.context.slot, recorded.route_snapshot.context_slot);
  assert.equal(hash(bytes(route.value[0])), recorded.route_snapshot.pool_data_sha256);
  const pool = getWhirlpoolDecoder().decode(bytes(route.value[0]));
  assert.deepEqual(decodeFixedWhirlpoolV1(bytes(route.value[0])), pool);
  assert.deepEqual(decodeFixedWhirlpoolV1(bytes(first.value)), getWhirlpoolDecoder().decode(bytes(first.value)));
  assert.equal(pool.tickCurrentIndex, recorded.route_snapshot.tick_current_index);
  assert.equal(pool.tickSpacing, recorded.route_snapshot.tick_spacing);
  assert.equal(String(pool.sqrtPrice), recorded.route_snapshot.sqrt_price_raw);
  assert.equal(String(pool.liquidity), recorded.route_snapshot.liquidity_raw);
  assert.equal(pool.feeRate, recorded.route_snapshot.fee_rate_raw);
  const ticks = route.value.slice(1, 4).map(account => getTickArrayDecoder().decode(bytes(account)));
  assert.deepEqual(route.value.slice(1, 4).map(account => decodeFixedTickArrayV1(bytes(account))), ticks);
  assert.deepEqual(ticks.map(t => t.startTickIndex), recorded.route_snapshot.derivation.starts);
  for (const tick of ticks) assert.equal(String(tick.whirlpool), recorded.transaction.instruction_accounts[2].address);
  const q = swapQuoteByInputToken(BigInt(recorded.quote.exact_input_usdc_raw), false,
    recorded.quote.slippage_bps, pool, undefined, ticks, BigInt(recorded.quote.quote_timestamp_unix));
  assert.equal(String(q.tokenIn), recorded.quote.exact_input_usdc_raw);
  assert.equal(String(q.tokenEstOut), recorded.quote.expected_jup_raw);
  assert.equal(String(q.tokenMinOut), recorded.quote.minimum_jup_raw);
  assert.equal(String(q.tradeFee), recorded.quote.trade_fee_raw);
  const product = q.tokenEstOut * (10000n - BigInt(recorded.quote.slippage_bps));
  const strict = (product + 9999n) / 10000n;
  assert.equal(strict, 21347418n);
  assert.ok(strict * 10000n >= product);
  assert.ok(q.tokenMinOut * 10000n < product);
});
test('already-rounded retained owner response objects remain refused, not repaired from Number', async () => {
  const classicName = 'raw-opening-owner-enumeration-attempt-1-classic.json';
  const tokenName = 'raw-opening-owner-enumeration-attempt-1-token-2022.json';
  assert.equal(hash(readFileSync(new URL(classicName, root))), 'da371c12588beb6233a626b918ac891d7b184cd33aa164058a86686dfbd52a56');
  assert.equal(hash(readFileSync(new URL(tokenName, root))), 'b03f5c392d7aa5ce903e6f58f38c608f786125d98c66f717a9224dc0038d8813');
  const recorded = read('build-and-quote.json');
  const classic = read(classicName), token2022 = read(tokenName);
  assert.equal(Number.isSafeInteger(classic.result.value[0].account.rentEpoch), false);
  await assert.rejects(createFrozenControlledHeliusTargetAccountEnumerationPortV2({
    wallet: recorded.transaction.fee_payer, target_mint: recorded.route_snapshot.vaults.jup.mint,
    boundary_kind: 'OPENING', minimum_context_slot: Math.min(classic.result.context.slot, token2022.result.context.slot),
  }, { clock: () => 0, sleep: async () => { throw Error('unexpected retry'); },
    request: async ({ body }) => ({ status: 200, data: {
      ...structuredClone(body.params[1].programId.startsWith('Tokenkeg') ? classic : token2022), id: body.id,
    } }),
  }), { code: 'helius_owner_population_invalid' });
});
test('exact retained owner bytes replay through lossless parsing and the controlled owner authority', async () => {
  const classicRaw = readFileSync(new URL('raw-opening-owner-enumeration-attempt-1-classic.json', root), 'utf8');
  const tokenRaw = readFileSync(new URL('raw-opening-owner-enumeration-attempt-1-token-2022.json', root), 'utf8');
  assert.equal(hash(classicRaw), 'da371c12588beb6233a626b918ac891d7b184cd33aa164058a86686dfbd52a56');
  assert.equal(hash(tokenRaw), 'b03f5c392d7aa5ce903e6f58f38c608f786125d98c66f717a9224dc0038d8813');
  assert.match(classicRaw, /"rentEpoch":18446744073709551615/);
  const classic = JSON.parse(classicRaw, reviveSolanaRentEpochV1);
  const token2022 = JSON.parse(tokenRaw, reviveSolanaRentEpochV1);
  assert.ok(classic.result.value.every(row => row.account.rentEpoch === '18446744073709551615'));
  assert.equal(classic.result.context.slot, token2022.result.context.slot);
  assert.throws(() => JSON.parse(JSON.stringify(JSON.parse(classicRaw)), reviveSolanaRentEpochV1), /rentEpoch/);
  const recorded = read('build-and-quote.json');
  const scope = { wallet: recorded.transaction.fee_payer, target_mint: recorded.route_snapshot.vaults.jup.mint,
    boundary_kind: 'OPENING', minimum_context_slot: classic.result.context.slot };
  let calls = 0;
  const port = await createFrozenControlledHeliusTargetAccountEnumerationPortV2(scope, {
    clock: () => 0, sleep: async () => { throw Error('unexpected retry'); },
    request: async ({ body }) => {
      calls++;
      assert.equal(body.method, 'getTokenAccountsByOwner');
      assert.equal(body.params[0], scope.wallet);
      // Only replay correlation IDs are adapted, after byte hashes and exact parsing.
      return { status: 200, data: { ...(body.params[1].programId.startsWith('Tokenkeg') ? classic : token2022), id: body.id } };
    },
  });
  const result = await captureTargetAccountEnumerationV1({ port, wallet: scope.wallet,
    target_mint: scope.target_mint, boundary_kind: scope.boundary_kind });
  assert.equal(calls, 2);
  assert.equal(result.enumeration_context.slot, classic.result.context.slot);
  assert.equal(result.program_results[1].accounts.length, 0);
  const accounts = result.program_results[0].accounts;
  assert.ok(accounts.length > 0);
  for (const account of accounts) {
    const original = classic.result.value.find(row => row.pubkey === account.account).account;
    assert.equal(account.rent_epoch, '18446744073709551615');
    assert.equal(account.lamports, String(original.lamports));
    assert.equal(account.raw_account_data.bytes, original.data[0]);
    assert.equal(account.token_state.raw_amount, Buffer.from(original.data[0], 'base64').readBigUInt64LE(64).toString());
  }
});
