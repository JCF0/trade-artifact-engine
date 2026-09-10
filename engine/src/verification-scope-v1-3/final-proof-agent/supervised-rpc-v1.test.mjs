import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedSupervisedRpcV1 } from './supervised-rpc-v1.mjs';
const budget = { total_calls: 1, call_timeout_ms: 50, overall_timeout_ms: 100, max_response_bytes: 1024, methods: { getSlot: 1 } };
function setup(transport, overrides = {}) {
  const records = [], calls = []; let mono = 0;
  const rpc = createBoundedSupervisedRpcV1({ phase: 'economic_source', budget: { ...budget, ...overrides },
    clock: { monotonicMs: () => mono, unixSeconds: () => 1900000000 },
    retain: async r => { records.push(r); }, transport: async r => { calls.push(r); return transport(r); } });
  return { rpc, records, calls, advance: n => { mono = n; } };
}
test('bounded raw transport retains exact request and response before parsing and consumes one call', async () => {
  const bytes = '{ "jsonrpc":"2.0", "id":"one", "result":900 }\n';
  const f = setup(async () => bytes);
  assert.equal(await f.rpc({ body: { jsonrpc: '2.0', id: 'one', method: 'getSlot', params: [{ commitment: 'finalized' }] } }), bytes);
  assert.equal(f.records.at(-1).response_base64, Buffer.from(bytes).toString('base64'));
  await assert.rejects(f.rpc({ body: { jsonrpc: '2.0', id: 'two', method: 'getSlot', params: [] } }));
  assert.equal(f.calls.length, 1);
});
test('unexpected method rejects before transport; timed-out ignoring transport cannot publish late evidence', async () => {
  let complete;
  const f = setup(() => new Promise(resolve => { complete = resolve; }));
  await assert.rejects(f.rpc({ body: { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [] } }));
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.rpc({ body: { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] } }), /SUPERVISED_RPC_UNAVAILABLE/);
  const before = f.records.length;
  complete('{"jsonrpc":"2.0","id":1,"result":1}'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.records.length, before); assert.equal(f.calls.length, 1);
});
