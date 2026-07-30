#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';

import { buildPackageNativeProofSourceV1 } from '../proof-source/package-native-proof-source.mjs';
import { buildReceiptPackageV1 } from './builder.mjs';
import { createReceiptPackageFsStore } from './fs-package-store.mjs';
import { canonicalJson } from './serialize.mjs';
import {
  ORCHESTRATION_VERSION,
  TargetedReceiptOrchestrationError,
  orchestrateTargetedReceiptPackageV1,
  selectTargetedReceiptCandidateV1,
} from './targeted-orchestrator.mjs';

const PROFILES = Object.freeze({
  fetch_profile: 'receipt_scoped_transaction_selection_v1',
  normalization_profile: 'artifact_solana_spot_normalization_v1',
  reconstruction_engine_version: 'artifact_position_ledger_receipt_v1',
  accounting_method_version: 'weighted_average_position_accounting_v1',
});
const INPUT_STATUS = Object.freeze({ acquisition_complete: true, normalization_complete: true });
const JUP = Object.freeze({
  wallet: '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni',
  tokenMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  expectedReceiptHash: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
  expectedPackageDigest: '5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278',
  expectedMemberHashes: {
    'archive-record.json': 'd28c5a58b920f526c5ed9e08e4e5b034d99285cd7182a1374f1eb9c10697c6ac',
    'canonical-receipt.json': 'c636cfda958eb87341d3225d33b53b7dc9dcf157def5cc3a054eb56cd4e9eb61',
    'economics.json': 'd8d716459707f3b8c7f95b2f6e64a3c1f1faf91e62629e0477213e4b4ed9ffbd',
    'manifest.json': '2ce234ccedcb52ac555f49129de7a3b6660506b04ed452c02503ec626646f1f6',
    'verification.json': '851c283e7e321bee61a939f1b39dbfb1f09ec038cdd078ceca50c8f7167c6ad0',
  },
  firstEventAt: 1781904268,
  lastEventAt: 1782068814,
  buyTx: '2ArLuJC2JEuWiavk1jYxLQ2E4xhq63BbeDV2kCWPcZ9zZNc4XyugUEFEryKrYfqcWnxkUvyacRmj2YNTfZGq17yV',
  sellTx: '5YCdUYkJVx3kkZUpvz4ygs6QT8GZtYtru4kGkur3LJ8yrMmW2XJ8qXtgjspMpJqqyQA6WPDQxd4BcTpNNSr3Dctk',
  boughtQty: 265951.319268,
  boughtQuote: 49728.694003,
  soldQty: 265951.319268,
  soldQuote: 58016.53285,
});
const RAY = Object.freeze({
  wallet: '5fK3484fbh8gnmhvTsPYxTC6un7Co5LVUSoubZPVL3YA',
  tokenMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  quoteMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  expectedReceiptHash: '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
  expectedPackageDigest: '25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2',
  expectedMemberHashes: {
    'archive-record.json': '777987cf14a3e41034923a6acc0e87ce15ec7affef68b0e3fb32890ad24bd695',
    'canonical-receipt.json': '94717ca77018826e88bf39313c7b4b810ade1d42ed9f507809c649f1f6f3f2cb',
    'economics.json': '4664d29a151bba54051c4a8ef6044990a2ca474a4b45a421536106e9fa5d0ea8',
    'manifest.json': '9fffd0746b49b5e3b89dbf113675c76290c7ae10f99542a23b1c385e3c75b41e',
    'verification.json': '808c2d03cd54bb13ed418ea034075dc8b523cb01e6a9ce3359d2959498141e6d',
  },
  firstEventAt: 1769382291,
  lastEventAt: 1769632666,
  buyTx: '2SUoNBBTkQBBGVCinvLQbVZq5LDZS5M8ikx5PLH7QiCuLdf6GWCPSM7wLd6gJsNUbLSousAhbkSX9eXgt1dAeBKm',
  sellTx: '4TmWRpMxWRTpQqNM7iFCRyP1m9VEyRK54VZwKeQV4cYisYRjQRjuvocF8j7mNAomoQf6H2h4vfd5Qp6Y2LQxeEsB',
  boughtQty: 26644.791399,
  boughtQuote: 25000,
  soldQty: 26644.791399,
  soldQuote: 27347.717902,
});
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function event({ wallet, timestamp, txHash, inputMint, inputAmount, outputMint, outputAmount, rawIndex }) {
  return {
    wallet,
    timestamp,
    tx_hash: txHash,
    source: 'deterministic_fixture',
    token_in_mint: inputMint,
    token_in_amount: inputAmount,
    token_in_decimals: 6,
    token_out_mint: outputMint,
    token_out_amount: outputAmount,
    token_out_decimals: 6,
    extraction_method: 'events_swap',
    raw_index: rawIndex,
  };
}

function closedEvents(fixture = JUP) {
  return [
    event({ wallet: fixture.wallet, timestamp: fixture.firstEventAt, txHash: fixture.buyTx,
      inputMint: fixture.quoteMint, inputAmount: fixture.boughtQuote,
      outputMint: fixture.tokenMint, outputAmount: fixture.boughtQty, rawIndex: 0 }),
    event({ wallet: fixture.wallet, timestamp: fixture.lastEventAt, txHash: fixture.sellTx,
      inputMint: fixture.tokenMint, inputAmount: fixture.soldQty,
      outputMint: fixture.quoteMint, outputAmount: fixture.soldQuote, rawIndex: 1 }),
  ];
}

function request(fixture = JUP, overrides = {}) {
  return {
    normalizedEvents: closedEvents(fixture),
    inputStatus: { ...INPUT_STATUS },
    target: {
      wallet: fixture.wallet,
      token_mint: fixture.tokenMint,
      receipt_type: 'closed_position',
      segment_index: 0,
      expected_receipt_hash: fixture.expectedReceiptHash,
    },
    profiles: { ...PROFILES },
    mode: 'dry_run',
    ...overrides,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof TargetedReceiptOrchestrationError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}

function withoutExpectedHash(target) {
  const result = { ...target };
  delete result.expected_receipt_hash;
  return result;
}

test('JUP-like closed position builds the pinned deterministic package without mutating input', async () => {
  const input = request();
  const before = structuredClone(input);
  const first = await orchestrateTargetedReceiptPackageV1(input, {});
  const second = await orchestrateTargetedReceiptPackageV1(structuredClone(input), {});
  assert.equal(first.orchestration_version, ORCHESTRATION_VERSION);
  assert.equal(first.status, 'dry_run');
  assert.deepEqual(first.target, withoutExpectedHash(input.target));
  assert.equal(first.receipt_hash, JUP.expectedReceiptHash);
  assert.equal(first.receipt_id, 'art_v12_cp_JUPyiwrY_0');
  assert.equal(first.package_digest, JUP.expectedPackageDigest);
  assert.deepEqual(first.member_hashes, JUP.expectedMemberHashes);
  assert.deepEqual(first.verification, {
    hash_valid: true, schema_valid: true, consistency_valid: true, pass: true, rule_violation_count: 0,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(input, before);
});

test('RAY-like evidence reproduces pinned receipt and package bytes', async () => {
  const result = await orchestrateTargetedReceiptPackageV1(request(RAY), {});
  assert.equal(result.receipt_hash, RAY.expectedReceiptHash);
  assert.equal(result.package_digest, RAY.expectedPackageDigest);
  assert.deepEqual(result.member_hashes, RAY.expectedMemberHashes);
});

test('zero matches and wrong segment index return target_not_found', async () => {
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, {
    target: { ...request().target, token_mint: 'MissingMint11111111111111111111111111111111111' },
  }), {}), 'target_not_found');
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, {
    target: { ...request().target, segment_index: 1 },
  }), {}), 'target_not_found');
});

test('selection rejects ambiguous, open, partial, and ineligible targets', () => {
  const closed = {
    wallet: JUP.wallet, token_mint: JUP.tokenMint, candidate_type: 'closed_position', segment_index: 0,
    status: 'closed', eligible_for_verified_receipt: true, eligible_for_closed_position_receipt: true,
  };
  const target = withoutExpectedHash(request().target);
  assert.throws(() => selectTargetedReceiptCandidateV1([closed, { ...closed }], target), error => error.code === 'target_ambiguous');
  for (const receiptType of ['open_snapshot', 'realized_partial']) {
    assert.throws(() => selectTargetedReceiptCandidateV1([], { ...target, receipt_type: receiptType }), error => error.code === 'target_not_eligible');
  }
  assert.throws(() => selectTargetedReceiptCandidateV1([
    { ...closed, eligible_for_closed_position_receipt: false },
  ], target), error => error.code === 'target_not_eligible');
});

test('open snapshot and realized partial orchestration requests are rejected', async () => {
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, {
    normalizedEvents: [closedEvents()[0]],
    target: { ...withoutExpectedHash(request().target), receipt_type: 'open_snapshot' },
  }), {}), 'target_not_eligible');
  const partialEvents = [closedEvents()[0], {
    ...closedEvents()[1], token_in_amount: JUP.soldQty / 2, token_out_amount: JUP.soldQuote / 2,
  }];
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, {
    normalizedEvents: partialEvents,
    target: { ...withoutExpectedHash(request().target), receipt_type: 'realized_partial' },
  }), {}), 'target_not_eligible');
});

test('unrelated open and partial positions do not affect selected package identity', async () => {
  const unrelatedMint = 'OtherMint111111111111111111111111111111111111';
  const unrelated = [
    event({ wallet: JUP.wallet, timestamp: JUP.firstEventAt - 20, txHash: 'unrelated-buy',
      inputMint: SOL_MINT, inputAmount: 2, outputMint: unrelatedMint, outputAmount: 100, rawIndex: 10 }),
    event({ wallet: JUP.wallet, timestamp: JUP.firstEventAt - 10, txHash: 'unrelated-partial-sell',
      inputMint: unrelatedMint, inputAmount: 25, outputMint: SOL_MINT, outputAmount: 0.7, rawIndex: 11 }),
  ];
  const base = await orchestrateTargetedReceiptPackageV1(request(), {});
  const changed = await orchestrateTargetedReceiptPackageV1(request(JUP, {
    normalizedEvents: [...unrelated, ...closedEvents()],
  }), {});
  assert.equal(changed.receipt_hash, base.receipt_hash);
  assert.equal(changed.package_digest, base.package_digest);
  assert.deepEqual(changed.member_hashes, base.member_hashes);
});

test('completeness flags and malformed normalized events fail with stable codes', async () => {
  for (const inputStatus of [
    { acquisition_complete: false, normalization_complete: true },
    { ...INPUT_STATUS, pagination_truncated: true },
    { ...INPUT_STATUS, result_capped: true },
    { ...INPUT_STATUS, cap_reached: true },
    { ...INPUT_STATUS, provider_uncertain: true },
    { ...INPUT_STATUS, pagination_complete: false },
    { ...INPUT_STATUS, pagination_not_exhausted: true },
  ]) {
    await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, { inputStatus }), {}), 'incomplete_acquisition_input');
  }
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, {
    inputStatus: { acquisition_complete: true, normalization_complete: false },
  }), {}), 'incomplete_normalization_input');
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, {
    inputStatus: { ...INPUT_STATUS, normalization_partial: true },
  }), {}), 'incomplete_normalization_input');
  for (const normalizedEvents of [
    [{ ...closedEvents()[0], token_in_amount: 0 }, closedEvents()[1]],
    [{ ...closedEvents()[0], wallet: 'wrong-wallet' }, closedEvents()[1]],
    [{ ...closedEvents()[0], extra: true }, closedEvents()[1]],
    [...closedEvents()].reverse(),
  ]) {
    await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, { normalizedEvents }), {}), 'invalid_normalized_event');
  }
  const symbolEvents = closedEvents();
  symbolEvents[Symbol('metadata')] = true;
  await expectCode(
    orchestrateTargetedReceiptPackageV1(request(JUP, { normalizedEvents: symbolEvents }), {}),
    'invalid_normalized_event',
  );
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, {
    target: { ...request().target, segment_index: Number.MAX_SAFE_INTEGER + 1 },
  }), {}), 'invalid_orchestration_request');
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, {
    normalizedEvents: [{ ...closedEvents()[0], timestamp: Number.MAX_SAFE_INTEGER + 1 }, closedEvents()[1]],
  }), {}), 'invalid_normalized_event');
});

test('changed selected evidence changes identity; expected hash mismatch fails', async () => {
  const changedEvents = closedEvents().map(item => ({ ...item }));
  changedEvents[1].token_out_amount += 1;
  const result = await orchestrateTargetedReceiptPackageV1(request(JUP, {
    normalizedEvents: changedEvents,
    target: withoutExpectedHash(request().target),
  }), {});
  assert.notEqual(result.receipt_hash, JUP.expectedReceiptHash);
  assert.notEqual(result.package_digest, JUP.expectedPackageDigest);
  assert.equal(result.verification.pass, true);
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, { normalizedEvents: changedEvents }), {}), 'expected_receipt_hash_mismatch');
});

test('frozen profile identifiers are mandatory', async () => {
  for (const field of Object.keys(PROFILES)) {
    await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, {
      profiles: { ...PROFILES, [field]: `${PROFILES[field]}_changed` },
    }), {}), 'invalid_orchestration_request');
  }
});

test('dry-run never touches an injected package store', async () => {
  const packageStore = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('filesystem touched'); } });
  const logger = new Proxy({}, {
    getPrototypeOf() { throw new Error('logger performed I/O'); },
    ownKeys() { throw new Error('logger performed I/O'); },
  });
  assert.equal((await orchestrateTargetedReceiptPackageV1(request(), { packageStore, logger })).status, 'dry_run');
});

test('commit mode requires a store and returns committed then unchanged in a temporary root', async () => {
  await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, { mode: 'commit' }), {}), 'package_store_required');
  const root = await mkdtemp(join(tmpdir(), 'artifact-targeted-orchestration-'));
  try {
    const packageStore = createReceiptPackageFsStore({ root });
    const first = await orchestrateTargetedReceiptPackageV1(request(JUP, { mode: 'commit' }), { packageStore });
    const second = await orchestrateTargetedReceiptPackageV1(request(JUP, { mode: 'commit' }), { packageStore });
    assert.equal(first.status, 'committed');
    assert.equal(second.status, 'unchanged');
    const committed = await packageStore.readCommitted(JUP.expectedReceiptHash);
    assert.equal(committed['manifest.json'].package_digest, JUP.expectedPackageDigest);
    assert.equal(canonicalJson(committed).includes('recovery_method'), false);
    assert.equal(committed['economics.json'].source, undefined);
    assert.doesNotThrow(() => buildPackageNativeProofSourceV1(committed));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('different package for the same receipt hash returns package_store_conflict', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'artifact-targeted-source-'));
  const conflictRoot = await mkdtemp(join(tmpdir(), 'artifact-targeted-conflict-'));
  try {
    const sourceStore = createReceiptPackageFsStore({ root: sourceRoot });
    await orchestrateTargetedReceiptPackageV1(request(JUP, { mode: 'commit' }), { packageStore: sourceStore });
    const base = await sourceStore.readCommitted(JUP.expectedReceiptHash);
    const conflicting = buildReceiptPackageV1({
      canonicalReceipt: base['canonical-receipt.json'], verificationResult: base['verification.json'],
      archiveRecord: base['archive-record.json'], economicsRecord: base['economics.json'],
      inputCommitment: { ...base['manifest.json'].input_commitment, reconstruction_engine_version: 'artifact_position_ledger_receipt_v2' },
    });
    const conflictStore = createReceiptPackageFsStore({ root: conflictRoot });
    const staged = await conflictStore.stage(conflicting);
    await conflictStore.validateStage(staged.stagingHandle);
    await conflictStore.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest });
    await expectCode(orchestrateTargetedReceiptPackageV1(request(JUP, { mode: 'commit' }), { packageStore: conflictStore }), 'package_store_conflict');
  } finally {
    await Promise.all([sourceRoot, conflictRoot].map(root => rm(root, { recursive: true, force: true })));
  }
});

test('commit_unknown reconciles through inspect without blind retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-targeted-unknown-'));
  let injected = false;
  try {
    const actualStore = createReceiptPackageFsStore({
      root,
      faultInjector(point) {
        if (point === 'after_rename' && !injected) { injected = true; throw new Error('injected unknown result'); }
      },
    });
    let stageCount = 0;
    let inspectCount = 0;
    const packageStore = {
      inspect: async (...args) => { inspectCount += 1; return actualStore.inspect(...args); },
      stage: async (...args) => { stageCount += 1; return actualStore.stage(...args); },
      validateStage: (...args) => actualStore.validateStage(...args),
      commit: (...args) => actualStore.commit(...args),
    };
    const result = await orchestrateTargetedReceiptPackageV1(request(JUP, { mode: 'commit' }), { packageStore });
    assert.equal(result.status, 'committed');
    assert.equal(stageCount, 1);
    assert.equal(inspectCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a logger failure cannot obscure a successful durable commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-targeted-logger-'));
  let loggerCalls = 0;
  try {
    const packageStore = createReceiptPackageFsStore({ root });
    const logger = {
      info() {
        loggerCalls += 1;
        if (loggerCalls === 1) throw new Error('logger failed after commit');
        return Promise.reject(new Error('async logger failed after commit'));
      },
    };
    const first = await orchestrateTargetedReceiptPackageV1(
      request(JUP, { mode: 'commit' }),
      { packageStore, logger },
    );
    const second = await orchestrateTargetedReceiptPackageV1(
      request(JUP, { mode: 'commit' }),
      { packageStore, logger },
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(first.status, 'committed');
    assert.equal(second.status, 'unchanged');
    assert.equal(loggerCalls, 2);
    assert.equal((await packageStore.inspect(JUP.expectedReceiptHash)).status, 'committed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('store failures do not retain raw path diagnostics or causes', async () => {
  const privateMarker = '/private/provider-or-filesystem/path';
  const packageStore = {
    inspect: async () => ({ status: 'absent' }),
    stage: async () => {
      const raw = Object.assign(new Error(privateMarker), { code: privateMarker });
      raw.cause = new Error(privateMarker);
      throw raw;
    },
    validateStage: async () => undefined,
    commit: async () => ({ status: 'committed' }),
  };
  await assert.rejects(
    orchestrateTargetedReceiptPackageV1(request(JUP, { mode: 'commit' }), { packageStore }),
    error => {
      assert.equal(error.code, 'capability_denied');
      assert.equal(error.cause, undefined);
      assert.equal(inspect(error).includes(privateMarker), false);
      return true;
    },
  );
});
