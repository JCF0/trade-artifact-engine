// Offline retained-input regression. No later observations, transport or simulation.
// Run with the qualification /accepted mount (or the retained test-only loader).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PublicKey } from '/accepted/engine/node_modules/@solana/web3.js/lib/index.cjs.js';
import { getOracleAddress, getWhirlpoolEncoder, getFixedTickArrayEncoder } from '/accepted/engine/orca-readiness-sdk/node_modules/@orca-so/whirlpools-client/dist/index.js';
import { decodeFixedWhirlpoolV1, decodeFixedTickArrayV1, swapQuoteByInputToken } from '/accepted/engine/orca-readiness-sdk/index.mjs';
import { constructAndSimulate } from './construction.mjs';
import { admitQualificationInputV1 } from './qualification-contract-v1.mjs';
const root = '/root/artifact-private-helius-provider-qualification';
const full = `${root}/full-dedicated-v1`;
const hash = b => createHash('sha256').update(b).digest('hex');
const inventoryBytes = readFileSync(`${full}/final-evidence-sha256.json`);
assert.equal(hash(inventoryBytes), 'a221cd85fd58b7724d9d5398295d37bb7a770dc4fafc264f48c1d37b84a63748');
const inventory = JSON.parse(inventoryBytes);
function retained(n) {
  const path = `external-session/evidence/${n}`, bytes = readFileSync(`${full}/${path}`);
  assert.equal(hash(bytes), inventory[path]); return JSON.parse(bytes);
}
const requests = [18, 19].map(n => retained(`call-${n}-request.json`));
const responses = [18, 19].map(n => retained(`call-${n}-response.json`).result);
const envelope = JSON.parse(readFileSync(`${root}/qualification-construction-v1/candidate-input.json`));
const context = admitQualificationInputV1(envelope);
const copy = v => structuredClone(v);
const absent = new Error('OFFLINE_STOP_NO_BLOCKHASH_OBSERVATION');
async function replay(change = () => {}, ctx = context) {
  const values = copy(responses), calls = []; change(values);
  const session = { async call(method, params) {
    const index = calls.length; calls.push({ method, params });
    if (index === 2) {
      assert.equal(method, 'getLatestBlockhash');
      assert.deepEqual(params, [{ commitment: 'finalized', minContextSlot: responses[1].context.slot }]);
      throw absent; // No fabricated blockhash/fee/height/simulation response.
    }
    assert.ok(index < 2);
    assert.equal(method, requests[index].method); assert.deepEqual(params, requests[index].params);
    return values[index];
  } };
  let error;
  try { await constructAndSimulate(session, ctx, requests[0].params[1].minContextSlot, '/nonexistent/no-output'); }
  catch (e) { error = e; }
  return { error, calls };
}
function poolChange(values, change) {
  const account = values[1].value[0], pool = decodeFixedWhirlpoolV1(Buffer.from(account.data[0], 'base64'));
  change(pool); account.data[0] = Buffer.from(getWhirlpoolEncoder().encode(pool)).toString('base64');
}
function tickChange(values, change) {
  const account = values[1].value[1], tick = decodeFixedTickArrayV1(Buffer.from(account.data[0], 'base64'));
  change(tick); account.data[0] = Buffer.from(getFixedTickArrayEncoder().encode(tick)).toString('base64');
}
test('exact retained null oracle passes route and quote, then stops before unavailable blockhash', async () => {
  assert.equal(responses[1].value[6], null);
  const { error, calls } = await replay();
  assert.equal(error, absent);
  assert.deepEqual(calls.map(c => c.method), ['getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash']);
});
test('exact pool/program oracle PDA agrees with installed Orca derivation and request position', async () => {
  const r = context.scope.route_scope, pool = new PublicKey(r.pool), program = new PublicKey(r.whirlpool_program);
  const [key, bump] = PublicKey.findProgramAddressSync([Buffer.from('oracle'), pool.toBuffer()], program);
  assert.equal(key.toBase58(), r.oracle); assert.equal(bump, 255);
  assert.deepEqual(await getOracleAddress(r.pool, r.whirlpool_program), [r.oracle, bump]);
  assert.equal(requests[1].params[0][6], r.oracle);
});
const negatives = [
  ['missing oracle is not observed null', v => { delete v[1].value[6]; }],
  ['wrong-owner oracle', v => { v[1].value[6] = { owner: context.scope.wallet_scope.token_program, executable: false, lamports: 1, data: ['', 'base64'] }; }],
  ['executable oracle', v => { v[1].value[6] = { owner: context.scope.route_scope.whirlpool_program, executable: true, lamports: 1, data: ['', 'base64'] }; }],
  ['malformed non-null oracle base64', v => { v[1].value[6] = { owner: context.scope.route_scope.whirlpool_program, executable: false, lamports: 1, data: ['!', 'base64'] }; }],
  ['unsafe non-null oracle lamports', v => { v[1].value[6] = { owner: context.scope.route_scope.whirlpool_program, executable: false, lamports: 9007199254740992, data: ['', 'base64'] }; }],
  ['adaptive-fee pool with null oracle', v => poolChange(v, p => { p.feeTierIndexSeed = Uint8Array.of(5, 0); })],
  ['wrong pool mint', v => poolChange(v, p => { p.tokenMintA = context.scope.asset_scope.usdc_mint; })],
  ['wrong pool vault', v => poolChange(v, p => { p.tokenVaultA = context.scope.route_scope.usdc_vault; })],
  ['changed tick sequence', v => poolChange(v, p => { p.tickCurrentIndex += p.tickSpacing * 88; })],
  ['wrong tick relationship', v => tickChange(v, t => { t.whirlpool = context.scope.wallet_scope.wallet; })],
  ['wrong tick start', v => tickChange(v, t => { t.startTickIndex += 352; })],
  ['absent tick remains refused', v => { v[1].value[1] = null; }],
  ['vault wrong owner', v => { v[1].value[4].owner = context.scope.route_scope.whirlpool_program; }],
  ['absent mint remains refused', v => { v[1].value[7] = null; }],
  ['route below context floor', v => { v[1].context.slot = requests[1].params[1].minContextSlot - 1; }],
  ['short route response', v => { v[1].value.pop(); }],
];
for (const [name, change] of negatives) test(name, async () => {
  const { error, calls } = await replay(change);
  assert.equal(error?.message, 'QUALIFICATION_PUBLIC_INPUT_STOP');
  assert.equal(calls.length, 2);
});
test('a context with changed oracle cannot enter the constructor', async () => {
  const forged = copy(context); forged.scope.route_scope.oracle = context.scope.wallet_scope.wallet;
  const { error, calls } = await replay(() => {}, forged);
  assert.equal(error?.message, 'QUALIFICATION_CONTRACT_STOP'); assert.equal(calls.length, 0);
});
test('retained static quote preserves exact input and strict ceiling minimum; no observation is invented', () => {
  const p = decodeFixedWhirlpoolV1(Buffer.from(responses[1].value[0].data[0], 'base64'));
  const ticks = responses[1].value.slice(1, 4).map(a => decodeFixedTickArrayV1(Buffer.from(a.data[0], 'base64')));
  const e = context.scope.economic_authority;
  const time = BigInt(Math.floor(retained('ledger.json').ledger[18].started_unix_ms / 1000));
  const q = swapQuoteByInputToken(BigInt(e.acquisition_input_usdc_raw), false, e.maximum_slippage_bps, p, undefined, ticks, time);
  assert.equal(q.tokenIn, 5000000n); assert.ok(q.tokenEstOut > 0n);
  const ceiling = (q.tokenEstOut * (10000n - BigInt(e.maximum_slippage_bps)) + 9999n) / 10000n;
  assert.ok(ceiling * 10000n >= q.tokenEstOut * 9950n);
  assert.ok((ceiling - 1n) * 10000n < q.tokenEstOut * 9950n);
});
