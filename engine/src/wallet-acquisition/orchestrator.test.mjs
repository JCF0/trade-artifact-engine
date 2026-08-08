#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { acquireWalletHistoryV1 } from './orchestrator.mjs';
import {
  createWalletHistoryPortV1,
  failWalletAcquisitionOperationV1,
  getWalletAcquisitionFailureDiagnosticV1,
} from './provider-port.mjs';
import { canonical, enhanced, fakePort, request, ANCHOR_SLOT, ANCHOR_TIME, BLOCKHASH, JUP, PROGRAMS, RAY, USDC, WALLET } from './fixtures/slice4-fixtures.mjs';

async function expectCode(promise, expected) {
  await assert.rejects(promise, error => error?.code === expected && error.stack === undefined && error.cause === undefined);
}
function run(port, req = request()) {
  return acquireWalletHistoryV1(req, { walletHistoryPort: createWalletHistoryPortV1(port, { beginAcquisitionV1() {} }) });
}
function bodyFor(source, options = {}) { return enhanced(source.signature, { slot: source.slot, timestamp: source.block_time, failed: source.execution_state === 'failed', ...options }); }

const stableSource = canonical('stable', ANCHOR_SLOT, ANCHOR_TIME);

test('forwards request-specific budgets through hidden acquisition controls without changing the five-method port', async () => {
  let received = null;
  const port = createWalletHistoryPortV1(fakePort({ pages: [[]] }), { beginAcquisitionV1(budgets) { received = budgets; } });
  const req = request({ budgets: { ...request().budgets, max_attempts_per_operation: 2, request_timeout_ms: 500, overall_timeout_ms: 1000 } });
  await acquireWalletHistoryV1(req, { walletHistoryPort: port });
  assert.deepEqual(received, req.budgets);
  assert.deepEqual(Object.keys(port), ['getNetworkIdentityV1','getFinalizedSlotV1','getFinalizedBlockV1','getFinalizedWalletSignaturePageV1','getEnhancedTransactionsBySignatureV1']);
});

test('rejects an unregistered five-method port before invoking any provider method', async () => {
  let calls = 0;
  const raw = fakePort({ pages: [[]] });
  for (const name of Object.keys(raw)) {
    const original = raw[name];
    raw[name] = async (...args) => { calls += 1; return original(...args); };
  }
  await expectCode(acquireWalletHistoryV1(request(), { walletHistoryPort: raw }), 'acquisition_capability_denied');
  assert.equal(calls, 0);
});

test('proves mainnet finalized anchor and handles skipped-slot backward search within the locked budget', async () => {
  const blocks = { [ANCHOR_SLOT]: null, [ANCHOR_SLOT - 1]: null, [ANCHOR_SLOT - 2]: { slot: ANCHOR_SLOT - 2, block_time: ANCHOR_TIME, blockhash: BLOCKHASH, commitment: 'finalized' } };
  const result = await run(fakePort({ pages: [[]], blocks }));
  assert.equal(result.boundary.anchor_slot, ANCHOR_SLOT - 2);
  assert.equal(result.boundary.anchor_block_time, ANCHOR_TIME);
  assert.equal(result.scope.window.lower_bound.oldest_allowed_timestamp, ANCHOR_TIME - 604800);
  assert.equal(result.boundary.history_complete_through_anchor, true);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.scope.window));
});

test('rejects wrong genesis, exhausted 32-slot search, genesis-limited exhaustion, and malformed anchors', async () => {
  await expectCode(run(fakePort({ pages: [[]], genesisHash: 'wrong' })), 'chain_identity_mismatch');
  const unavailable = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [ANCHOR_SLOT - i, null]));
  await expectCode(run(fakePort({ pages: [[]], blocks: unavailable })), 'finalized_boundary_unavailable');
  await expectCode(run(fakePort({ pages: [[]], slot: 1, blocks: { 1: null, 0: null } })), 'finalized_boundary_unavailable');
  for (const block of [
    { slot: ANCHOR_SLOT, block_time: null, blockhash: BLOCKHASH, commitment: 'finalized' },
    { slot: ANCHOR_SLOT, block_time: ANCHOR_TIME, blockhash: null, commitment: 'finalized' },
    { slot: ANCHOR_SLOT - 1, block_time: ANCHOR_TIME, blockhash: BLOCKHASH, commitment: 'finalized' },
  ]) await expectCode(run(fakePort({ pages: [[]], blocks: { [ANCHOR_SLOT]: block } })), 'finalized_boundary_incoherent');
});

test('canonical pagination covers empty, short, two-page, exact-100 exhaustion, bound, sentinel, and post-anchor prefix', async () => {
  assert.equal((await run(fakePort({ pages: [[]] }))).coverage.transactions_examined, 0);
  const short = [canonical('s2', 999, ANCHOR_TIME - 2), canonical('s1', 998, ANCHOR_TIME - 3)];
  assert.equal((await run(fakePort({ pages: [short], enhancedBodies: short.map(bodyFor) }))).coverage.transactions_examined, 2);
  const first = Array.from({ length: 100 }, (_, i) => canonical(`p1-${i}`, 2000 - i, ANCHOR_TIME + 1000 - i));
  const second = [canonical('in-window', 900, ANCHOR_TIME - 10)];
  const two = await run(fakePort({ pages: [first, second], enhancedBodies: [bodyFor(second[0])] }));
  assert.deepEqual(two.transaction_dispositions.map(x => x.tx_hash), [second[0].signature]);
  const exact = Array.from({ length: 100 }, (_, i) => canonical(`exact-${i}`, ANCHOR_SLOT - i, ANCHOR_TIME - i));
  assert.equal((await run(fakePort({ pages: [exact, []], enhancedBodies: exact.map(bodyFor) }))).coverage.transactions_examined, 100);
  const lower = ANCHOR_TIME - 604800;
  const crossed = [canonical('at-bound', 2, lower), canonical('sentinel', 1, lower - 1)];
  const bounded = await run(fakePort({ pages: [crossed], enhancedBodies: [bodyFor(crossed[0])] }));
  assert.deepEqual(bounded.transaction_dispositions.map(x => x.tx_hash), [crossed[0].signature]);
  assert.equal(bounded.coverage.pagination_terminal_reason, 'historical_bound_reached');
  const prefix = [canonical('post', ANCHOR_SLOT + 1, ANCHOR_TIME + 1), stableSource];
  assert.deepEqual((await run(fakePort({ pages: [prefix], enhancedBodies: [bodyFor(stableSource)] }))).transaction_dispositions.map(x => x.tx_hash), [stableSource.signature]);
});

test('rejects incoherent post-anchor axes and every pagination protocol/cap violation', async () => {
  for (const source of [canonical('bad-time', ANCHOR_SLOT, ANCHOR_TIME + 1), canonical('bad-slot', ANCHOR_SLOT + 1, ANCHOR_TIME)]) {
    await expectCode(run(fakePort({ pages: [[source]] })), 'finalized_boundary_incoherent');
  }
  const full = Array.from({ length: 100 }, (_, i) => canonical(`full-${i}`, 1000 - i, ANCHOR_TIME - i));
  for (const [page, code] of [
    [[full.at(-1)], 'pagination_cursor_repeated'], [[full[50]], 'pagination_cursor_repeated'],
    [[{ ...full[50], slot: 1 }], 'pagination_duplicate_conflict'],
    [[canonical('newer-again', 999, ANCHOR_TIME - 50)], 'pagination_order_invalid'],
  ]) await expectCode(run(fakePort({ pages: [full, page] })), code);
  await expectCode(run(fakePort({ pages: [full] }), request({ budgets: { ...request().budgets, max_pages: 1 } })), 'acquisition_capped');
  await expectCode(run(fakePort({ pages: [full] }), request({ budgets: { ...request().budgets, max_transactions: 99 } })), 'acquisition_capped');
});

test('head recheck accepts stable/new post-anchor activity and rejects new or changed at/below-anchor identities', async () => {
  assert.equal((await run(fakePort({ pages: [[stableSource]], enhancedBodies: [bodyFor(stableSource)] }))).coverage.transactions_examined, 1);
  const post = canonical('new-post', ANCHOR_SLOT + 1, ANCHOR_TIME + 1);
  assert.equal((await run(fakePort({ pages: [[stableSource]], recheckPages: [[post, stableSource]], enhancedBodies: [bodyFor(stableSource)] }))).coverage.transactions_examined, 1);
  for (const appeared of [canonical('new-at', ANCHOR_SLOT, ANCHOR_TIME), canonical('new-below', ANCHOR_SLOT - 1, ANCHOR_TIME - 1)]) {
    await expectCode(run(fakePort({ pages: [[stableSource]], recheckPages: [[appeared, stableSource]] })), 'latest_state_unproven');
  }
  for (const changed of [{ ...stableSource, slot: stableSource.slot - 1 }, { ...stableSource, block_time: stableSource.block_time - 1 }, { ...stableSource, execution_state: 'failed' }]) {
    await expectCode(run(fakePort({ pages: [[stableSource]], recheckPages: [[changed]] })), 'latest_state_unproven');
  }
  const neverReachesFloor = Array.from({ length: 100 }, (_, i) => canonical(`new-${i}`, ANCHOR_SLOT + 100 + i, ANCHOR_TIME + 100 + i)).reverse();
  await expectCode(run(fakePort({ pages: [[stableSource]], recheckPages: [neverReachesFloor] }), request({ budgets: { ...request().budgets, max_pages: 1 } })), 'latest_state_unproven');
  const timedOut = fakePort({ pages: [[stableSource]], enhancedBodies: [bodyFor(stableSource)] });
  const readPage = timedOut.getFinalizedWalletSignaturePageV1.bind(timedOut); let calls = 0;
  timedOut.getFinalizedWalletSignaturePageV1 = async input => {
    calls += 1;
    if (calls === 2) throw { code: 'provider_retry_exhausted' };
    return readPage(input);
  };
  await expectCode(run(timedOut), 'latest_state_unproven');
});

test('reconciles exact Enhanced signature set independent of response order and rejects every contradiction', async () => {
  const sources = [canonical('a', 999, ANCHOR_TIME - 1), canonical('b', 998, ANCHOR_TIME - 2)];
  const bodies = sources.map(bodyFor);
  assert.equal((await run(fakePort({ pages: [sources], enhancedBodies: [...bodies].reverse() }))).coverage.transactions_examined, 2);
  const cases = [
    [[bodies[0]], 'source_transaction_mismatch'],
    [[...bodies, enhanced('extra')], 'source_transaction_mismatch'],
    [[bodies[0], bodies[0], bodies[1]], 'source_transaction_mismatch'],
    [[{ ...bodies[0], slot: 1 }, bodies[1]], 'source_transaction_mismatch'],
    [[{ ...bodies[0], timestamp: 1 }, bodies[1]], 'source_transaction_mismatch'],
    [[{ ...bodies[0], transactionError: { failed: true } }, bodies[1]], 'source_transaction_mismatch'],
    [[{ ...bodies[0], signature: '' }, bodies[1]], 'source_transaction_mismatch'],
  ];
  for (const [enhancedBodies, code] of cases) await expectCode(run(fakePort({ pages: [sources], enhancedBodies })), code);

  const wrongWalletSource = canonical('wrong-wallet', 997, ANCHOR_TIME - 3, 'failed');
  const wrongWalletPort = fakePort({ pages: [[wrongWalletSource]], enhancedBodies: [bodyFor(wrongWalletSource)] });
  const originalEnhanced = wrongWalletPort.getEnhancedTransactionsBySignatureV1;
  wrongWalletPort.getEnhancedTransactionsBySignatureV1 = async input => {
    const [evidence] = await originalEnhanced(input);
    const changed = structuredClone(evidence);
    const other = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    changed.wallet = other;
    changed.fee_payer = other;
    for (const group of changed.structured_swap_groups) {
      for (const leg of [...group.token_inputs, ...group.token_outputs, ...group.native_inputs, ...group.native_outputs]) leg.owner = other;
    }
    for (const leg of [...changed.token_transfer_legs, ...changed.native_sol_transfer_legs]) leg.owner = other;
    for (const closure of changed.account_closures) closure.owner = other;
    return [changed];
  };
  await expectCode(run(wrongWalletPort), 'source_transaction_mismatch');
});

test('classifies all five disposition classes, assigns dense canonical raw indexes, and fails wallet-wide ambiguity', async () => {
  const supportedOld = canonical('supported-old', 990, ANCHOR_TIME - 10);
  const supportedNew = canonical('supported-new', 995, ANCHOR_TIME - 5);
  const unsupported = canonical('unsupported', 993, ANCHOR_TIME - 7);
  const ambiguous = canonical('ambiguous', 992, ANCHOR_TIME - 8);
  const unrelated = canonical('unrelated', 991, ANCHOR_TIME - 9);
  const failed = canonical('failed', 989, ANCHOR_TIME - 11, 'failed');
  const bodies = [
    bodyFor(supportedOld), bodyFor(supportedNew, { inputMint: JUP, inputRaw: '100000000', outputMint: USDC, outputRaw: '30000000' }),
    bodyFor(unsupported, { type: 'TRANSFER', program: null, outputMint: RAY }),
    bodyFor(ambiguous, { type: 'TRANSFER', program: null, unresolved: true }),
    bodyFor(unrelated, { type: 'TRANSFER', program: null, inputMint: USDC, outputMint: USDC }),
    bodyFor(failed),
  ];
  const sources = [supportedNew, unsupported, ambiguous, unrelated, supportedOld, failed].sort((a, b) => b.slot - a.slot);
  const result = await run(fakePort({ pages: [sources], enhancedBodies: bodies }));
  assert.deepEqual(result.normalized_event_records.map(x => x.slice7_event.raw_index), [0, 1]);
  assert.deepEqual(result.normalized_event_records.map(x => x.slice7_event.tx_hash), [supportedOld.signature,supportedNew.signature]);
  assert.deepEqual(new Set(result.transaction_dispositions.map(x => x.disposition_type)), new Set(['supported_normalized_event','unsupported_activity','ambiguous_activity','unrelated_activity','failed_transaction']));
  assert.equal(result.transaction_dispositions.length, sources.length);
  assert.equal(result.coverage.transactions_examined, sources.length);

  const unknown = canonical('wallet-wide', 988, ANCHOR_TIME - 12);
  const unknownBody = bodyFor(unknown, { type: 'TRANSFER', program: null, unresolved: true });
  delete unknownBody.tokenTransfers[0].mint;
  await expectCode(run(fakePort({ pages: [[unknown]], enhancedBodies: [unknownBody] })), 'wallet_wide_impact_unresolved');
});

test('supports JUP sell and Raydium same-mint multi-input with dense wallet-wide indexes', async () => {
  const sources = [canonical('jup-sell', 902, ANCHOR_TIME - 98), canonical('ray-multi', 901, ANCHOR_TIME - 99)];
  const sell = bodyFor(sources[0], { inputMint: JUP, inputRaw: '100000000', outputMint: USDC, outputRaw: '30000000' });
  const ray = bodyFor(sources[1]);
  ray.instructions = [{ programId: PROGRAMS.raydium, innerInstructions: [] }];
  ray.events.swap.tokenInputs = [
    { userAccount: WALLET, mint: USDC, rawTokenAmount: { tokenAmount: '10000000', decimals: 6 } },
    { userAccount: WALLET, mint: USDC, rawTokenAmount: { tokenAmount: '15000000', decimals: 6 } },
  ];
  ray.tokenTransfers = [
    { fromUserAccount: WALLET, toUserAccount: 'Pool', mint: USDC, rawTokenAmount: { tokenAmount: '10000000', decimals: 6 } },
    { fromUserAccount: WALLET, toUserAccount: 'Pool', mint: USDC, rawTokenAmount: { tokenAmount: '15000000', decimals: 6 } },
    ray.tokenTransfers[1],
  ];
  const result = await run(fakePort({ pages: [sources], enhancedBodies: [sell, ray] }));
  assert.deepEqual(result.normalized_event_records.map(item => item.slice7_event.raw_index), [0, 1]);
  const multi = result.normalized_event_records.find(item => item.slice7_event.tx_hash === sources[1].signature).slice7_event;
  assert.equal(multi.token_in_amount, 25);
  assert.equal(result.normalized_event_records.find(item => item.slice7_event.tx_hash === sources[0].signature).slice7_event.token_out_mint, USDC);
});

test('source/disposition sets are exact, output is provider-permutation invariant, and no raw body survives', async () => {
  const sources = [canonical('x', 900, ANCHOR_TIME - 100), canonical('y', 899, ANCHOR_TIME - 101)];
  const bodies = sources.map(bodyFor);
  const left = await run(fakePort({ pages: [sources], enhancedBodies: bodies }));
  const right = await run(fakePort({ pages: [sources], enhancedBodies: [...bodies].reverse() }));
  assert.deepEqual(left, right);
  assert.deepEqual(left.transaction_dispositions.map(x => x.tx_hash).sort(), sources.map(x => x.signature).sort());
  const serialized = JSON.stringify(left);
  for (const forbidden of ['transactionError','tokenTransfers','nativeTransfers','instructions','description','api-key']) assert.equal(serialized.includes(forbidden), false);
});

function malformed(reason) {
  try { failWalletAcquisitionOperationV1('malformed_provider_response', reason); }
  catch (error) { return error; }
}
async function expectDiagnostic(promise, expected) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'malformed_provider_response');
    assert.deepEqual(getWalletAcquisitionFailureDiagnosticV1(error), {
      diagnostic_version: 'controlled_live_failure_diagnostic_v1', ...expected,
    });
    return true;
  });
}

test('trusted call sites attach exact stage and operation to every malformed acquisition class', async () => {
  const identity = fakePort({ pages: [[]] });
  identity.getNetworkIdentityV1 = async () => { throw malformed('rpc_envelope_invalid'); };
  await expectDiagnostic(run(identity), { stage: 'finalized_anchor', operation: 'network_identity', reason: 'rpc_envelope_invalid' });

  const slot = fakePort({ pages: [[]] });
  slot.getFinalizedSlotV1 = async () => { throw malformed('rpc_slot_result_invalid'); };
  await expectDiagnostic(run(slot), { stage: 'finalized_anchor', operation: 'finalized_slot', reason: 'rpc_slot_result_invalid' });

  const block = fakePort({ pages: [[]] });
  block.getFinalizedBlockV1 = async () => { throw malformed('rpc_block_result_invalid'); };
  await expectDiagnostic(run(block), { stage: 'finalized_anchor', operation: 'finalized_block', reason: 'rpc_block_result_invalid' });

  const pagination = fakePort({ pages: [[]] });
  pagination.getFinalizedWalletSignaturePageV1 = async () => { throw malformed('rpc_signature_page_invalid'); };
  await expectDiagnostic(run(pagination), { stage: 'canonical_pagination', operation: 'canonical_signature_page', reason: 'rpc_signature_page_invalid' });

  const recheck = fakePort({ pages: [[stableSource]], enhancedBodies: [bodyFor(stableSource)] });
  const readPage = recheck.getFinalizedWalletSignaturePageV1.bind(recheck); let pageCalls = 0;
  recheck.getFinalizedWalletSignaturePageV1 = async input => {
    pageCalls += 1;
    if (pageCalls === 2) throw malformed('rpc_signature_page_invalid');
    return readPage(input);
  };
  await expectDiagnostic(run(recheck), { stage: 'latest_state_recheck', operation: 'canonical_signature_page', reason: 'rpc_signature_page_invalid' });

  for (const [reason, stage, operation] of [
    ['enhanced_page_invalid', 'enhanced_history', 'enhanced_address_history'],
    ['enhanced_transaction_shape_invalid', 'enhanced_projection', 'enhanced_transaction_projection'],
    ['enhanced_projection_internal_rejection', 'enhanced_projection', 'enhanced_transaction_projection'],
  ]) {
    const enhancedPort = fakePort({ pages: [[stableSource]], enhancedBodies: [bodyFor(stableSource)] });
    enhancedPort.getEnhancedTransactionsBySignatureV1 = async () => { throw malformed(reason); };
    await expectDiagnostic(run(enhancedPort), { stage, operation, reason });
  }

  const unsafe = fakePort({ pages: [[]] });
  unsafe.getFinalizedSlotV1 = async () => { const cyclic = {}; cyclic.self = cyclic; return cyclic; };
  await expectDiagnostic(run(unsafe), { stage: 'finalized_anchor', operation: 'finalized_slot', reason: 'provider_value_unsafe' });
});
