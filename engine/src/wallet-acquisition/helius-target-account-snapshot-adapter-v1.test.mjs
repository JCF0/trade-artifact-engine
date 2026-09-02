import assert from 'node:assert/strict';
import test from 'node:test';

import { PublicKey } from '@solana/web3.js';
import { sha256CanonicalJson } from '../verification-scope-v1-3/contract.mjs';

import {
  captureTargetAccountEnumerationV1,
  createFrozenControlledHeliusTargetAccountEnumerationPortV2,
  createFrozenHeliusTargetAccountEnumerationPortV1,
  createFrozenHeliusTargetAccountEnumerationPortV2,
  createTargetAccountEnumerationPortV1,
  validateTargetAccountEnumerationStructureV1,
} from './target-account-enumeration-port-v1.mjs';
import {
  captureFrozenControlledHeliusTargetAccountEnumerationCapabilityV2,
  HELIUS_FINALIZED_ENUMERATION_TRUST_STATEMENT_V2,
  HeliusTargetAccountSnapshotError,
} from './helius-target-account-snapshot-adapter-v1.mjs';

const CLASSIC = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WALLET = '4EYja5iaLCgX2yKi8dVghnD12A2EMBwWaqQfuySBLUF1';
const MINT = 'So11111111111111111111111111111111111111112';
const CLASSIC_ACCOUNT = 'GtXWTjMWWaDtxd2u6rChSzfCfgdzPFmTjVNfbLjp6h2e';
const TOKEN_2022_ACCOUNT = '9cJFtVh7HCYMtsdVxMaB4qeGwdicaQKhoFefgoxzAfoC';

function u32(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; }
function u64(value) { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; }
function accountData({ token2022 = false } = {}) {
  const out = Buffer.alloc(165);
  new PublicKey(MINT).toBuffer().copy(out, 0);
  new PublicKey(WALLET).toBuffer().copy(out, 32);
  u64(12).copy(out, 64);
  u32(0).copy(out, 72);
  out[108] = 1;
  u32(0).copy(out, 109);
  u64(0).copy(out, 121);
  u32(0).copy(out, 129);
  return token2022 ? Buffer.concat([out, Buffer.from([2]), Buffer.from([7, 0, 0, 0])]) : out;
}
function mintData() {
  const out = Buffer.alloc(82);
  u32(0).copy(out, 0);
  u64(1_000_000).copy(out, 36);
  out[44] = 9;
  out[45] = 1;
  u32(0).copy(out, 46);
  return out;
}
function row(pubkey, program, data = accountData({ token2022: program === TOKEN_2022 })) {
  return {
    pubkey,
    account: {
      data: [data.toString('base64'), 'base64'],
      executable: false,
      lamports: 2_039_280,
      owner: program,
      rentEpoch: 0,
      space: data.length,
    },
  };
}
function rpc(id, slot, rows) {
  return { jsonrpc: '2.0', id, result: { context: { slot }, value: rows } };
}
function mintRpc(id, slot) {
  const data = mintData();
  return { jsonrpc: '2.0', id, result: { context: { slot }, value: {
    data: [data.toString('base64'), 'base64'], executable: false, lamports: 1, owner: TOKEN_2022,
    rentEpoch: 0, space: data.length,
  } } };
}
function harness(handler) {
  const calls = [];
  return {
    calls,
    dependencies: {
      clock: () => 0,
      sleep: async () => {},
      async request(input) {
        calls.push(structuredClone(input));
        return { status: 200, data: await handler(input.body, calls.length), raw_body_sha256: 'a'.repeat(64) };
      },
    },
  };
}
function input(overrides = {}) {
  return {
    wallet: WALLET,
    target_mint: MINT,
    boundary_kind: 'OPENING',
    minimum_context_slot: 400,
    ...overrides,
  };
}
async function capture(port, boundary = 'OPENING') {
  return captureTargetAccountEnumerationV1({ port, wallet: WALLET, target_mint: MINT, boundary_kind: boundary });
}

test('captures one non-atomic equal-watermark pair with independent lane completeness evidence', async () => {
  const h = harness(body => rpc(body.id, 500, body.params[1].programId === CLASSIC
    ? [row(CLASSIC_ACCOUNT, CLASSIC)] : []));
  const port = await createFrozenHeliusTargetAccountEnumerationPortV2(input(), h.dependencies);
  const first = await capture(port);
  const second = await capture(port);
  assert.equal(first.enumeration_context.slot, 500);
  assert.equal(first.enumeration_profile, 'HELIUS_STANDARD_FINALIZED_OWNER_ENUMERATION_WATERMARK_V2');
  assert.equal(first.program_results[0].source_evidence.source_profile,
    'HELIUS_STANDARD_FINALIZED_OWNER_ENUMERATION_WATERMARK_V2');
  assert.equal(first.program_results[0].source_evidence.context_semantics,
    HELIUS_FINALIZED_ENUMERATION_TRUST_STATEMENT_V2);
  assert.equal(first.program_results[0].source_evidence.lane_completeness_semantics,
    'HELIUS_PROVIDER_ATTESTED_INDIVIDUAL_LANE_ALL_OR_ERROR_V1');
  assert.equal(first.program_results[1].source_evidence.lane_completeness_semantics,
    'HELIUS_PROVIDER_ATTESTED_INDIVIDUAL_LANE_ALL_OR_ERROR_V1');
  assert.deepEqual(first.program_results[0].source_evidence.observed_context_slots, {
    classic: 500, token_2022: 500,
  });
  assert.equal(first.program_results[0].source_evidence.watermark_consistency, 'EQUAL_CONTEXT_SLOT');
  assert.equal(first.program_results[0].source_evidence.minimum_context_slot_semantics,
    'FRESHNESS_LOWER_BOUND_ONLY');
  assert.equal(first.program_results[0].source_evidence.atomic_snapshot, false);
  assert.equal(first.program_results[0].source_evidence.combined_boundary_authority,
    'NOT_ADMITTED_FROM_STANDARD_RPC');
  assert.equal(first.program_results[0].source_evidence.attempt_identity,
    first.program_results[1].source_evidence.attempt_identity);
  assert.equal(first.program_results[0].source_evidence.full_account_count, 1);
  assert.equal(first.program_results[0].source_evidence.full_decoded_bytes, 165);
  assert.match(first.program_results[0].source_evidence.full_population_digest, /^[0-9a-f]{64}$/);
  assert.equal(first.program_results[1].source_evidence.full_account_count, 0);
  assert.equal(first.program_results[0].source_evidence.bounds_profile,
    'HELIUS_OWNER_ENUMERATION_BOUNDS_V1');
  assert.equal(first.program_results[0].accounts[0].token_state.raw_amount, '12');
  assert.equal(first.program_results[0].accounts[0].token_state.decimals, null);
  assert.equal(first.program_results[0].accounts[0].normalized_state_profile,
    'LOCALLY_DECODED_SOLANA_TOKEN_ACCOUNT_STATE_V1');
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.body.method === 'getTokenAccountsByOwner'));
  assert.deepEqual(first, second);
  for (const field of ['full_account_count', 'full_decoded_bytes']) {
    const forged = structuredClone(first);
    forged.program_results.forEach(result => { result.source_evidence[field] += 999; });
    const { enumeration_digest: ignored, ...preimage } = forged;
    forged.enumeration_digest = sha256CanonicalJson(preimage);
    assert.throws(() => validateTargetAccountEnumerationStructureV1(forged),
      error => error.code === 'enumeration_context_mismatch');
  }
  const boundaryForgery = structuredClone(first);
  boundaryForgery.program_results[1].source_evidence.boundary_kind = 'ENDING_AS_OF';
  const { enumeration_digest: ignoredBoundaryDigest, ...boundaryPreimage } = boundaryForgery;
  boundaryForgery.enumeration_digest = sha256CanonicalJson(boundaryPreimage);
  assert.throws(() => validateTargetAccountEnumerationStructureV1(boundaryForgery),
    error => error.code === 'enumeration_context_mismatch');
  assert.equal(HELIUS_FINALIZED_ENUMERATION_TRUST_STATEMENT_V2,
    "Both owner enumerations independently completed under Helius's provider-attested completeness semantics and reported the same finalized commitment watermark through equal context.slot values. Equal slots are a cross-call consistency check and do not establish atomic execution or one indexed snapshot.");
  assert.doesNotMatch(JSON.stringify(first), /same finalized Helius account-indexed state/i);

  const retired = structuredClone(first);
  retired.enumeration_profile = 'HELIUS_STANDARD_FINALIZED_OWNER_ENUMERATION_V1';
  const { enumeration_digest: ignoredRetiredDigest, ...retiredPreimage } = retired;
  retired.enumeration_digest = sha256CanonicalJson(retiredPreimage);
  assert.throws(() => validateTargetAccountEnumerationStructureV1(retired),
    error => error.code === 'retired_production_enumeration_profile');
});

test('controlled capture is a distinct profile that discloses quiescence as an experiment assumption', async () => {
  const h = harness(body => rpc(body.id, 500, body.params[1].programId === CLASSIC
    ? [row(CLASSIC_ACCOUNT, CLASSIC)] : []));
  const result = await capture(await createFrozenControlledHeliusTargetAccountEnumerationPortV2(
    input(), h.dependencies,
  ));
  assert.equal(result.enumeration_profile, 'ARTIFACT_CONTROLLED_HELIUS_OWNER_CAPTURE_V2');
  const evidence = result.program_results[0].source_evidence;
  assert.equal(evidence.atomic_snapshot, false);
  assert.equal(evidence.combined_boundary_authority, 'CONTROLLED_CAPTURE_ASSUMPTION_ADMITTED');
  assert.equal(evidence.controlled_capture_assumption_profile,
    'ARTIFACT_CONTROLLED_CROSS_CALL_QUIESCENCE_ASSUMPTION_V1');
  assert.equal(evidence.controlled_signing_status, 'DISABLED_DURING_CAPTURE');
  assert.equal(evidence.controlled_transaction_status, 'NO_CONTROLLED_SUBMISSION_DURING_OPENING_CAPTURE');
  assert.equal(evidence.third_party_non_interference,
    'NOT_CRYPTOGRAPHICALLY_EXCLUDED_BY_STANDARD_RPC');
  assert.equal(evidence.dispatch_profile, 'CONCURRENT_WHOLE_PAIR_V1');
  await assert.rejects(createFrozenControlledHeliusTargetAccountEnumerationPortV2(
    { ...input(), quiescent: true }, h.dependencies,
  ), error => error.code === 'helius_snapshot_input_invalid');
});

test('direct controlled adapter replay cannot self-promote through the generic registry', async () => {
  const h = harness(body => rpc(body.id, 500, []));
  const direct = await captureFrozenControlledHeliusTargetAccountEnumerationCapabilityV2(
    input(), h.dependencies,
  );
  const generic = createTargetAccountEnumerationPortV1(direct);
  await assert.rejects(capture(generic),
    error => error.code === 'account_enumeration_response_invalid');
});

test('the V1 production factory is retired rather than silently reinterpreted as V2', async () => {
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV1(input(), harness(() => {}).dependencies),
    error => error.code === 'retired_production_enumeration_profile');
});

test('retries the whole pair after unequal slots and never cross-mixes attempts', async () => {
  const h = harness((body, call) => {
    const firstAttempt = call <= 2;
    const classic = body.params[1].programId === CLASSIC;
    const slot = firstAttempt ? (classic ? 500 : 501) : 502;
    return rpc(body.id, slot, classic ? [row(CLASSIC_ACCOUNT, CLASSIC)] : []);
  });
  const result = await capture(await createFrozenHeliusTargetAccountEnumerationPortV2(input(), h.dependencies));
  assert.equal(result.enumeration_context.slot, 502);
  assert.equal(h.calls.length, 4);
});

test('validates unrelated rows before target-mint filtering', async () => {
  const unrelated = Buffer.from(accountData());
  new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111').toBuffer().copy(unrelated, 0);
  unrelated[108] = 9;
  const h = harness(body => rpc(body.id, 500, body.params[1].programId === CLASSIC
    ? [row(CLASSIC_ACCOUNT, CLASSIC, unrelated)] : []));
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), h.dependencies),
    error => error.code === 'helius_owner_population_invalid');
});

test('nonempty Token-2022 discovers and exercises offline mint convergence but remains production-disabled', async () => {
  const h = harness(body => {
    if (body.method === 'getAccountInfo') return mintRpc(body.id, 501);
    const token2022 = body.params[1].programId === TOKEN_2022;
    const slot = body.id.includes('-a1-') ? 500 : 501;
    return rpc(body.id, slot, token2022 ? [row(TOKEN_2022_ACCOUNT, TOKEN_2022)] : []);
  });
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), h.dependencies), error => {
    assert.equal(error.code, 'token_2022_cross_method_context_unconfirmed');
    return true;
  });
  assert.equal(h.calls.length, 5);
  assert.equal(h.calls.filter(call => call.body.method === 'getAccountInfo').length, 1);
});

test('mint-context mismatch discards the complete owner-plus-mint attempt before converging again', async () => {
  const h = harness(body => {
    const attempt = Number(body.id.match(/-a(\d+)-/)[1]);
    if (body.method === 'getAccountInfo') return mintRpc(body.id, attempt === 2 ? 700 : 503);
    const token2022 = body.params[1].programId === TOKEN_2022;
    const slot = attempt === 1 ? 500 : attempt === 2 ? 502 : 503;
    return rpc(body.id, slot, token2022 ? [row(TOKEN_2022_ACCOUNT, TOKEN_2022)] : []);
  });
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), h.dependencies),
    error => error.code === 'token_2022_cross_method_context_unconfirmed');
  assert.equal(h.calls.length, 8);
});

test('fails closed when an accepted response is below the required freshness floor', async () => {
  const h = harness(body => rpc(body.id, 499, []));
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(
    input({ boundary_kind: 'ENDING_AS_OF', minimum_context_slot: 500 }), h.dependencies,
  ), error => error.code === 'helius_context_floor_not_satisfied');
});

test('emits only fixed finalized/base64 owner requests with the required freshness floor', async () => {
  const h = harness(body => rpc(body.id, 500, []));
  await createFrozenHeliusTargetAccountEnumerationPortV2(input(), h.dependencies);
  assert.deepEqual(h.calls.map(call => call.body), [CLASSIC, TOKEN_2022].map((program, index) => ({
    jsonrpc: '2.0',
    id: `owner-snapshot-opening-a1-${index === 0 ? 'classic' : 'token2022'}`,
    method: 'getTokenAccountsByOwner',
    params: [WALLET, { programId: program }, {
      commitment: 'finalized', encoding: 'base64', minContextSlot: 400,
    }],
  })));
  assert.ok(h.calls.every(call => call.timeout_ms === 5_000));
});

test('wrong-owner, duplicate, unsafe, and over-cap rows block the complete owner population', async () => {
  const wrongOwner = row(CLASSIC_ACCOUNT, CLASSIC);
  wrongOwner.account.owner = TOKEN_2022;
  const unsafe = row(CLASSIC_ACCOUNT, CLASSIC);
  unsafe.account.lamports = Number.MAX_SAFE_INTEGER + 1;
  const cases = [
    [wrongOwner],
    [row(CLASSIC_ACCOUNT, CLASSIC), row(CLASSIC_ACCOUNT, CLASSIC)],
    [unsafe],
  ];
  for (const rows of cases) {
    const h = harness(body => rpc(body.id, 500, body.params[1].programId === CLASSIC ? rows : []));
    await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), h.dependencies),
      error => error.code === 'helius_owner_population_invalid');
  }

  const overCapRows = Array.from({ length: 10_001 }, () => row(CLASSIC_ACCOUNT, CLASSIC));
  const h = harness(body => rpc(body.id, 500, body.params[1].programId === CLASSIC ? overCapRows : []));
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), h.dependencies),
    error => error.code === 'helius_population_cap_exceeded');
});

test('request timeout is terminal while transient HTTP failures exhaust exactly eight whole-pair attempts', async () => {
  let timeoutCalls = 0;
  const timeoutDependencies = {
    clock: () => 0,
    sleep: async () => {},
    async request() {
      timeoutCalls += 1;
      const error = new Error('provider secret');
      error.code = 'request_timeout';
      throw error;
    },
  };
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), timeoutDependencies),
    error => error.code === 'helius_request_timeout');
  assert.equal(timeoutCalls, 2);

  let transientCalls = 0;
  const transientDependencies = {
    clock: () => 0,
    sleep: async () => {},
    async request() { transientCalls += 1; return { status: 429, data: null }; },
  };
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), transientDependencies),
    error => error.code === 'helius_snapshot_attempts_exhausted');
  assert.equal(transientCalls, 16);
});

test('unsafe parsed transport values fail with a fixed adapter error instead of leaking native diagnostics', async () => {
  const dependencies = {
    clock: () => 0,
    sleep: async () => {},
    async request() { return { status: 200, data: { unsafe: 1n } }; },
  };
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), dependencies),
    error => error instanceof HeliusTargetAccountSnapshotError && error.code === 'helius_rpc_schema_invalid');

  let getterCalls = 0;
  const accessorDependencies = {
    clock: () => 0,
    sleep: async () => {},
    async request() {
      return {
        status: 200,
        get data() { getterCalls += 1; return rpc('forged', 500, []); },
      };
    },
  };
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), accessorDependencies),
    error => error instanceof HeliusTargetAccountSnapshotError
      && error.code === 'helius_transport_response_invalid');
  assert.equal(getterCalls, 0);
});

test('adapter enforces its own per-request timeout and ignores a late successful transport', async () => {
  let clockCalls = 0;
  let requestCalls = 0;
  const dependencies = {
    clock: () => clockCalls++ === 0 ? 0 : 29_999,
    sleep: async () => {},
    async request({ body }) {
      requestCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { status: 200, data: rpc(body.id, 500, []) };
    },
  };
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), dependencies),
    error => error.code === 'helius_request_timeout');
  assert.equal(requestCalls, 2);
});

test('adapter bounds a non-cooperative retry sleep by the absolute capture deadline', async () => {
  let clockReads = 0;
  const startedAt = performance.now();
  const dependencies = {
    clock: () => (clockReads++ === 0 ? 0 : 29_800),
    sleep: () => new Promise(resolve => setTimeout(resolve, 1_000)),
    async request() { return { status: 429, data: null }; },
  };
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), dependencies),
    error => error.code === 'helius_snapshot_deadline_exhausted');
  assert.ok(performance.now() - startedAt < 600);
});

test('closed adapter inputs reject accessors without executing them', async () => {
  let getterCalls = 0;
  const dependencies = {
    clock: () => 0,
    sleep: async () => {},
    get request() { getterCalls += 1; return async () => ({ status: 200, data: null }); },
  };
  await assert.rejects(createFrozenHeliusTargetAccountEnumerationPortV2(input(), dependencies),
    error => error.code === 'helius_snapshot_capability_invalid');
  assert.equal(getterCalls, 0);
});
