import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { buildBoundedAgentMandateV1 } from '/accepted/engine/src/verification-scope-v1-3/final-proof-agent/mandate-v1.mjs';
import { fixedTestMandateInputV1 } from './synthetic-public-input.mjs';
import { constructAndSimulate } from './construction.mjs';
import { createSession, loadExchange, put, MAXIMA, LIMITS } from './bounded-successor.mjs';
const results = [];
const route = JSON.parse(readFileSync('/fixtures/route.json')).result.value;
const m = buildBoundedAgentMandateV1(fixedTestMandateInputV1());
const at = value => ({ context: { slot: 900000000 }, value });
async function constructionCase(name, mutation, reject = false) {
  const root = `/evidence/${name}`; mkdirSync(root); const calls = [];
  const session = { async call(method, params) {
    calls.push({ method, params }); let result;
    if (method === 'getAccountInfo') result = at(structuredClone(route[0]));
    else if (method === 'getMultipleAccounts') result = at([...structuredClone(route),
      { owner: m.route_scope.whirlpool_program, executable: false, lamports: 1, data: ['', 'base64'] },
      ...[0, 1].map(() => ({ owner: m.wallet_scope.token_program, executable: false, lamports: 1, data: [Buffer.alloc(82).toString('base64'), 'base64'] }))]);
    else if (method === 'getLatestBlockhash') result = at({ blockhash: m.wallet_scope.wallet, lastValidBlockHeight: 900000100 });
    else if (method === 'getFeeForMessage') result = at(5000);
    else if (method === 'getBlockHeight') result = 900000000;
    else if (method === 'simulateTransaction') {
      const wire = Buffer.from(params[0], 'base64'); assert.equal(wire[0], 1); assert(wire.subarray(1, 65).every(b => b === 0));
      assert.deepEqual(params[1], { encoding: 'base64', commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot: 900000000 });
      result = at({ err: null, unitsConsumed: 1000, logs: [], replacementBlockhash: null });
    } else throw Error('LOCAL_UNEXPECTED_METHOD');
    mutation(method, result); return result;
  } };
  if (reject) await assert.rejects(() => constructAndSimulate(session, m, 900000000, root));
  else {
    assert.equal(await constructAndSimulate(session, m, 900000000, root), 'OBSERVED_UNSIGNED_EXECUTION_SUCCESS');
    const retained = JSON.parse(readFileSync(root + '/construction.json'));
    assert.equal(retained.input.minimum_output_raw, '21347418');
    assert.equal(calls.length, 6);
  }
  put(root, 'synthetic-calls.json', { classification: 'LOCAL_SYNTHETIC_NOT_PROVIDER', calls }); results.push(name);
}
try {
  await constructionCase('build-positive', () => {});
  await constructionCase('fee-contradiction', (m, r) => { if (m === 'getFeeForMessage') r.value++; }, true);
  await constructionCase('floor-contradiction', (m, r) => { if (m === 'getMultipleAccounts') r.context.slot--; }, true);
  await constructionCase('tick-contradiction', (m, r) => { if (m === 'getMultipleAccounts') r.value[1] = null; }, true);
  await constructionCase('simulation-refusal', (m, r) => { if (m === 'simulateTransaction') r.value.err = { InstructionError: [0, 'InvalidArgument'] }; }, true);
  await constructionCase('replacement-denied', (m, r) => { if (m === 'simulateTransaction') r.value.replacementBlockhash = {}; }, true);
  let dispatches = 0;
  mkdirSync('/evidence/deny');
  const denied = createSession({ request() { dispatches++; throw Error('UNREACHABLE'); }, close() {} }, '/evidence/deny');
  await assert.rejects(() => denied.call('sendTransaction', [])); assert.equal(dispatches, 0); results.push('submission-denied-before-dispatch');
  assert.equal(Object.values(MAXIMA).reduce((a, b) => a + b, 0), LIMITS.calls);
  assert.equal(MAXIMA.simulateTransaction, 1); results.push('closed-successor-allocation');
  mkdirSync('/evidence/tls');
  const liveShape = createSession(loadExchange(), '/evidence/tls');
  try { assert.equal(await liveShape.call('getGenesisHash', []), m.network.genesis_hash); results.push('fixed-endpoint-tls-through-private-network-relay'); }
  finally { liveShape.close(); put('/evidence/tls', 'ledger.json', liveShape.snapshot()); }
  put('/evidence', 'successor-local-results.json', { classification: 'SYNTHETIC_ONLY', passed: results, real_provider_requests: 0 });
} catch { put('/evidence', 'successor-local-failure.json', { classification: 'SYNTHETIC_ONLY', passed: results, status: 'LOCAL_CHECK_STOP' }); process.exitCode = 1; }
