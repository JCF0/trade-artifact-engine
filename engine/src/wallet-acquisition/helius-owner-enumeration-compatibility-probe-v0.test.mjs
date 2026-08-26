#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLASSIC_TOKEN_PROGRAM_V0,
  TOKEN_2022_PROGRAM_V0,
  runHeliusOwnerEnumerationCompatibilityProbeV0,
} from './helius-owner-enumeration-compatibility-probe-v0.mjs';
import { providerPublicKey } from './fixtures/test-identities.mjs';

const EMPTY_WALLET = providerPublicKey('slice-3b2-empty-wallet');
const KNOWN_WALLET = providerPublicKey('slice-3b2-known-wallet');
const CLASSIC_ACCOUNT = providerPublicKey('slice-3b2-classic-account');
const TOKEN_2022_ACCOUNT = providerPublicKey('slice-3b2-token-2022-account');
const CLASSIC_ACCOUNT_2 = providerPublicKey('slice-3b2-classic-account-2');

function row(pubkey, owner) {
  return {
    pubkey,
    account: {
      data: [Buffer.from(`raw:${pubkey}`).toString('base64'), 'base64'],
      executable: false,
      lamports: 2_039_280,
      owner,
      rentEpoch: 0,
      space: 165,
    },
  };
}
function standard(id, slot, rows) {
  return { jsonrpc: '2.0', id, result: { context: { apiVersion: '3.1.8', slot }, value: rows } };
}
function v2(id, slot, rows, paginationKey = null) {
  return {
    jsonrpc: '2.0', id,
    result: { context: { apiVersion: '3.1.8', slot }, value: { accounts: rows, paginationKey } },
  };
}
function harness(handler) {
  const seen = [];
  let now = 0;
  return {
    seen,
    dependencies: {
      clock: () => now,
      sleep: async milliseconds => { now += milliseconds; },
      async request(input) {
        seen.push(structuredClone({ body: input.body, timeout_ms: input.timeout_ms }));
        const data = await handler(input, seen.length, milliseconds => { now += milliseconds; });
        return {
          status: 200,
          data,
          raw_body_sha256: 'a'.repeat(64),
        };
      },
    },
  };
}
function input(overrides = {}) {
  return {
    empty_control_wallet: EMPTY_WALLET,
    known_control_wallet: KNOWN_WALLET,
    expected_accounts: {
      [CLASSIC_TOKEN_PROGRAM_V0]: [CLASSIC_ACCOUNT],
      [TOKEN_2022_PROGRAM_V0]: [TOKEN_2022_ACCOUNT],
    },
    known_control_repetitions: 1,
    helius_plan_profile: 'FREE',
    ...overrides,
  };
}

function successfulHandler(request) {
  const body = request.body;
  const [wallet, filter] = body.params;
  const program = filter.programId;
  const rows = wallet === EMPTY_WALLET ? [] : [row(
    program === CLASSIC_TOKEN_PROGRAM_V0 ? CLASSIC_ACCOUNT : TOKEN_2022_ACCOUNT,
    program,
  )];
  if (body.method === 'getTokenAccountsByOwner' && body.params[2].minContextSlot !== undefined) {
    return { jsonrpc: '2.0', id: body.id, error: { code: -32016, message: 'Minimum context slot has not been reached' } };
  }
  if (body.method === 'getTokenAccountsByOwner') return standard(body.id, 500, rows);
  return v2(body.id, 500, rows);
}

test('uses the exact finalized base64 standard profile and reports observed compatibility separately from Helius confirmation', async () => {
  const h = harness(successfulHandler);
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);

  assert.equal(report.observed_compatibility.verdict, 'PASS');
  assert.equal(report.verdict, 'UNRESOLVED');
  assert.equal(report.helius_confirmation.status, 'REQUIRED_NOT_PROVIDED');
  assert.equal(report.observations.known_control.standard_runs[0].shared_context_slot, 500);
  assert.deepEqual(report.observations.known_control.lanes.map(lane => lane.account_keys), [
    [CLASSIC_ACCOUNT], [TOKEN_2022_ACCOUNT],
  ]);

  const firstPair = h.seen.slice(0, 2).map(item => item.body);
  assert.equal(firstPair.every(body => !Array.isArray(body)), true);
  assert.deepEqual(firstPair.map(body => body.method), ['getTokenAccountsByOwner', 'getTokenAccountsByOwner']);
  assert.deepEqual(firstPair.map(body => body.params), [
    [EMPTY_WALLET, { programId: CLASSIC_TOKEN_PROGRAM_V0 }, { commitment: 'finalized', encoding: 'base64' }],
    [EMPTY_WALLET, { programId: TOKEN_2022_PROGRAM_V0 }, { commitment: 'finalized', encoding: 'base64' }],
  ]);
  assert.equal(JSON.stringify(report).includes(Buffer.from(`raw:${CLASSIC_ACCOUNT}`).toString('base64')), false);
});

test('retries whole unequal-context pairs without cross-attempt mixing', async () => {
  const h = harness(request => {
    const body = request.body;
    if (body.id.startsWith('known-r1-a1-')) return standard(
      body.id, body.id.endsWith('classic') ? 600 : 601, [row(
        body.id.endsWith('classic') ? CLASSIC_ACCOUNT : TOKEN_2022_ACCOUNT, body.params[1].programId,
      )],
    );
    if (body.id.startsWith('known-r1-a2-')) return standard(
      body.id, 700, [row(
        body.id.endsWith('classic') ? CLASSIC_ACCOUNT : TOKEN_2022_ACCOUNT, body.params[1].programId,
      )],
    );
    return successfulHandler(request);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
  const run = report.observations.known_control.standard_runs[0];
  assert.equal(run.status, 'PASS');
  assert.equal(run.attempts, 2);
  assert.equal(run.shared_context_slot, 700);
  assert.equal(run.rpc_request_count, 4);
  const knownBodies = h.seen.filter(item => item.body.id.startsWith('known-r1-')).map(item => item.body.id);
  assert.deepEqual(knownBodies, [
    'known-r1-a1-classic','known-r1-a1-token2022',
    'known-r1-a2-classic','known-r1-a2-token2022',
  ]);
});

test('eight unequal attempts exhaust to UNRESOLVED with no partial authority', async () => {
  const h = harness(request => {
    const body = request.body;
    if (body.id.startsWith('known-r1-a')) return standard(
      body.id, body.id.endsWith('classic') ? 800 : 801, [row(
        body.id.endsWith('classic') ? CLASSIC_ACCOUNT : TOKEN_2022_ACCOUNT, body.params[1].programId,
      )],
    );
    return successfulHandler(request);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
  const run = report.observations.known_control.standard_runs[0];
  assert.deepEqual({ status: run.status, reason: run.reason, attempts: run.attempts, requests: run.rpc_request_count }, {
    status: 'UNRESOLVED', reason: 'pair_attempts_exhausted', attempts: 8, requests: 16,
  });
  assert.deepEqual(report.observations.known_control.lanes, []);
  assert.equal(Object.hasOwn(run, 'shared_context_slot'), false);
  assert.equal(Object.hasOwn(run, 'lanes'), false);
});

test('one-lane RPC and schema failures stop immediately as UNRESOLVED', async () => {
  for (const kind of ['rpc', 'schema']) {
    const h = harness(request => {
      const body = request.body;
      if (body.id.startsWith('known-r1-a1-')) return body.id.endsWith('classic')
        ? standard(body.id, 900, [row(CLASSIC_ACCOUNT, CLASSIC_TOKEN_PROGRAM_V0)])
        : kind === 'rpc'
          ? { jsonrpc: '2.0', id: body.id, error: { code: -32010, message: 'Key excluded from account secondary indexes' } }
          : { jsonrpc: '2.0', id: body.id, result: { context: {}, value: [] } };
      return successfulHandler(request);
    });
    const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
    const run = report.observations.known_control.standard_runs[0];
    assert.equal(run.status, 'UNRESOLVED');
    assert.equal(run.attempts, 1);
    assert.equal(run.rpc_request_count, 2);
    assert.deepEqual(report.observations.known_control.lanes, []);
  }
});

test('known omissions, owner-program contradictions, empty contradictions, and future-floor success FAIL', async () => {
  const cases = [
    [(body, rows) => body.id.startsWith('known-r1') && body.id.endsWith('classic') ? [] : rows, 'known_account_set_mismatch'],
    [(body, rows) => body.id.startsWith('known-r1') && body.id.endsWith('classic')
      ? [row(CLASSIC_ACCOUNT, TOKEN_2022_PROGRAM_V0)] : rows, 'account_owner_program_mismatch'],
    [(body, rows) => body.id.startsWith('empty-r1') && body.id.endsWith('classic')
      ? [row(CLASSIC_ACCOUNT, CLASSIC_TOKEN_PROGRAM_V0)] : rows, 'empty_control_not_empty'],
  ];
  for (const [mutateRows, reason] of cases) {
    const h = harness(request => {
      const body = request.body;
      const [wallet, filter, config] = body.params;
      const account = filter.programId === CLASSIC_TOKEN_PROGRAM_V0 ? CLASSIC_ACCOUNT : TOKEN_2022_ACCOUNT;
      const rows = mutateRows(body, wallet === EMPTY_WALLET ? [] : [row(account, filter.programId)]);
      if (config.minContextSlot !== undefined) return { jsonrpc: '2.0', id: body.id, error: { code: -32016 } };
      return body.method === 'getTokenAccountsByOwner' ? standard(body.id, 500, rows) : v2(body.id, 500, rows);
    });
    const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
    assert.equal(report.verdict, 'FAIL');
    assert.ok(report.observed_compatibility.reasons.some(item => item.code === reason));
    if (reason === 'empty_control_not_empty') assert.deepEqual(report.observations.empty_control.lanes, []);
    if (reason === 'known_account_set_mismatch') assert.deepEqual(report.observations.known_control.lanes, []);
  }

  const futureSuccess = harness(request => {
    const body = request.body;
    const program = body.params[1].programId;
    const rows = body.params[0] === EMPTY_WALLET ? [] : [row(
      program === CLASSIC_TOKEN_PROGRAM_V0 ? CLASSIC_ACCOUNT : TOKEN_2022_ACCOUNT, program,
    )];
    return body.method === 'getTokenAccountsByOwner' ? standard(body.id, 500, rows) : v2(body.id, 500, rows);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), futureSuccess.dependencies);
  assert.equal(report.verdict, 'FAIL');
  assert.ok(report.observed_compatibility.reasons.some(item => item.code === 'future_min_context_slot_succeeded'));
});

test('unrelated future-floor errors are UNRESOLVED rather than accepted as explicit minContextSlot failure', async () => {
  const h = harness(request => {
    const body = request.body;
    if (body.params[2].minContextSlot !== undefined) {
      return { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid params' } };
    }
    return successfulHandler(request);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
  assert.equal(report.observations.future_min_context_slot.status, 'UNRESOLVED');
  assert.equal(report.observations.future_min_context_slot.reason, 'future_min_context_slot_failure_unconfirmed');
  assert.equal(report.verdict, 'UNRESOLVED');
});

test('fully exhausts V2 cursors and compares exact account sets', async () => {
  const expected = input({ expected_accounts: {
    [CLASSIC_TOKEN_PROGRAM_V0]: [CLASSIC_ACCOUNT, CLASSIC_ACCOUNT_2],
    [TOKEN_2022_PROGRAM_V0]: [TOKEN_2022_ACCOUNT],
  } });
  const h = harness(request => {
    const body = request.body;
    const [wallet, filter, config] = body.params;
    const program = filter.programId;
    const standardRows = wallet === EMPTY_WALLET ? [] : program === CLASSIC_TOKEN_PROGRAM_V0
      ? [row(CLASSIC_ACCOUNT, program), row(CLASSIC_ACCOUNT_2, program)] : [row(TOKEN_2022_ACCOUNT, program)];
    if (config.minContextSlot !== undefined) return { jsonrpc: '2.0', id: body.id, error: { code: -32016 } };
    if (body.method === 'getTokenAccountsByOwner') return standard(body.id, 1000, standardRows);
    if (wallet === KNOWN_WALLET && program === CLASSIC_TOKEN_PROGRAM_V0 && config.paginationKey === undefined) {
      return v2(body.id, 1000, [row(CLASSIC_ACCOUNT, program)], 'next-page');
    }
    if (wallet === KNOWN_WALLET && program === CLASSIC_TOKEN_PROGRAM_V0) {
      return v2(body.id, 1001, [row(CLASSIC_ACCOUNT_2, program)], null);
    }
    return v2(body.id, 1000, standardRows, null);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(expected, h.dependencies);
  assert.equal(report.observed_compatibility.verdict, 'PASS');
  const classic = report.observations.standard_vs_fully_exhausted_v2.find(item =>
    item.wallet_profile === 'known' && item.token_program === CLASSIC_TOKEN_PROGRAM_V0);
  assert.equal(classic.pages, 2);
  assert.deepEqual(classic.account_keys, [CLASSIC_ACCOUNT, CLASSIC_ACCOUNT_2].sort());
  assert.deepEqual(classic.context_slots, [1000, 1001]);
});

test('a later repeated-run timeout removes all known-lane authority', async () => {
  const h = harness(request => {
    if (request.body.id.startsWith('known-r2-a1-')) throw Object.freeze({ code: 'request_timeout' });
    return successfulHandler(request);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input({ known_control_repetitions: 2 }), h.dependencies);
  assert.equal(report.observations.known_control.standard_runs[0].status, 'PASS');
  assert.equal(report.observations.known_control.standard_runs[1].status, 'UNRESOLVED');
  assert.deepEqual(report.observations.known_control.lanes, []);
  assert.equal(report.verdict, 'UNRESOLVED');
});

test('request timeout stops the whole pair immediately without retry or partial authority', async () => {
  let timeoutThrown = false;
  const h = harness(request => {
    if (request.body.id.startsWith('known-r1-a1-') && !timeoutThrown) {
      timeoutThrown = true;
      throw Object.freeze({ code: 'request_timeout' });
    }
    return successfulHandler(request);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
  const run = report.observations.known_control.standard_runs[0];
  assert.deepEqual({ status: run.status, reason: run.reason, attempts: run.attempts, requests: run.rpc_request_count }, {
    status: 'UNRESOLVED', reason: 'request_timeout', attempts: 1, requests: 2,
  });
  assert.deepEqual(report.observations.known_control.lanes, []);
  assert.deepEqual(h.seen.filter(item => item.body.id.startsWith('known-r1-a1-')).map(item => item.body.id), [
    'known-r1-a1-classic', 'known-r1-a1-token2022',
  ]);
});

test('30-second pair deadline returns UNRESOLVED and starts no later attempt', async () => {
  const h = harness((request, call, advance) => {
    const body = request.body;
    if (body.id.startsWith('known-r1-a1-')) {
      advance(30_001);
      return standard(body.id, body.id.endsWith('classic') ? 1100 : 1101, [row(
        body.id.endsWith('classic') ? CLASSIC_ACCOUNT : TOKEN_2022_ACCOUNT, body.params[1].programId,
      )]);
    }
    return successfulHandler(request, call);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
  const run = report.observations.known_control.standard_runs[0];
  assert.equal(run.status, 'UNRESOLVED');
  assert.equal(run.reason, 'pair_deadline_exhausted');
  assert.equal(run.attempts, 1);
  assert.equal(run.rpc_request_count, 2);
});

test('requests every configured known-control repetition after a middle timeout without promoting authority', async () => {
  const h = harness(request => {
    if (request.body.id.startsWith('known-r2-a1-')) throw Object.freeze({ code: 'request_timeout' });
    return successfulHandler(request);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input({ known_control_repetitions: 3 }), h.dependencies);

  assert.deepEqual(report.observations.known_control.standard_runs.map(run => run.status), [
    'PASS', 'UNRESOLVED', 'PASS',
  ]);
  assert.deepEqual(h.seen.filter(item => item.body.id.startsWith('known-r3-')).map(item => item.body.id), [
    'known-r3-a1-classic', 'known-r3-a1-token2022',
  ]);
  assert.deepEqual(report.observations.known_control.lanes, []);
});

test('does not compare V2 against a superseded successful standard repetition', async () => {
  const h = harness(request => {
    const body = request.body;
    if (body.id.startsWith('known-r2-a1-')) throw Object.freeze({ code: 'request_timeout' });
    if (body.method === 'getTokenAccountsByOwnerV2' && body.params[0] === KNOWN_WALLET
        && body.params[1].programId === CLASSIC_TOKEN_PROGRAM_V0) {
      return v2(body.id, 500, [row(CLASSIC_ACCOUNT_2, CLASSIC_TOKEN_PROGRAM_V0)]);
    }
    return successfulHandler(request);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input({ known_control_repetitions: 2 }), h.dependencies);

  assert.deepEqual(report.observations.known_control.lanes, []);
  assert.equal(report.observed_compatibility.reasons.some(reason =>
    reason.code === 'standard_v2_population_mismatch'), false);
  assert.equal(report.observed_compatibility.verdict, 'UNRESOLVED');
});

test('omits provider-controlled apiVersion prose and API-key canaries from serialized evidence', async () => {
  const proseCanary = 'arbitrary provider prose must not persist';
  const apiKeyCanary = 'provider-api-key-canary-must-not-persist';
  const h = harness(request => {
    const response = successfulHandler(request);
    if (response.result?.context !== undefined) {
      response.result.context.apiVersion = `${proseCanary}; ${apiKeyCanary}`;
    }
    return response;
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
  const bytes = JSON.stringify(report);

  assert.equal(bytes.includes(proseCanary), false);
  assert.equal(bytes.includes(apiKeyCanary), false);
  assert.equal(bytes.includes('api_version'), false);
});

test('rejects one-element array responses for every singleton RPC request class', async t => {
  const cases = [
    ['standard Token', body => body.id === 'empty-r1-a1-classic', report => report.observations.empty_control.standard_runs[0]],
    ['standard Token-2022', body => body.id === 'empty-r1-a1-token2022', report => report.observations.empty_control.standard_runs[0]],
    ['future-floor', body => body.id === 'future-classic', report => report.observations.future_min_context_slot],
    ['V2', body => body.id === 'v2-empty-0-p1', report => report.observations.standard_vs_fully_exhausted_v2.find(item =>
      item.wallet_profile === 'empty' && item.token_program === CLASSIC_TOKEN_PROGRAM_V0)],
  ];
  for (const [name, select, observation] of cases) {
    await t.test(name, async () => {
      const h = harness(request => {
        const response = successfulHandler(request);
        return select(request.body) ? [response] : response;
      });
      const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
      const result = observation(report);
      assert.equal(result.status, 'UNRESOLVED');
      assert.equal(result.reason, 'rpc_envelope_invalid');
    });
  }
});

test('does not compare V2 against a non-promotable empty-control standard population', async () => {
  const h = harness(request => {
    const body = request.body;
    if (body.method === 'getTokenAccountsByOwner' && body.params[0] === EMPTY_WALLET
        && body.params[1].programId === CLASSIC_TOKEN_PROGRAM_V0) {
      return standard(body.id, 500, [row(CLASSIC_ACCOUNT, CLASSIC_TOKEN_PROGRAM_V0)]);
    }
    return successfulHandler(request);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);

  assert.deepEqual(report.observations.empty_control.lanes, []);
  assert.equal(report.observed_compatibility.reasons.some(reason =>
    reason.code === 'standard_v2_population_mismatch'), false);
});

test('maps arbitrary HTTP statuses to a closed local reason enum', async () => {
  const h = harness(successfulHandler);
  h.dependencies.request = async input => {
    h.seen.push(structuredClone({ body: input.body, timeout_ms: input.timeout_ms }));
    return { status: 777, data: { provider: 'arbitrary prose' }, raw_body_sha256: 'b'.repeat(64) };
  };
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input(), h.dependencies);
  const bytes = JSON.stringify(report);

  assert.equal(report.observed_compatibility.reasons.some(reason => reason.code === 'http_777'), false);
  assert.equal(report.observed_compatibility.reasons.some(reason => reason.code === 'http_non_success_status'), true);
  assert.equal(bytes.includes('arbitrary prose'), false);
});

test('preserves the 210-request hard maximum and requires terminal V2 cursors', async () => {
  const h = harness(request => {
    const body = request.body;
    const program = body.params[1].programId;
    if (body.params[2].minContextSlot !== undefined) {
      return { jsonrpc: '2.0', id: body.id, error: { code: -32016 } };
    }
    if (body.method === 'getTokenAccountsByOwner') {
      const account = program === CLASSIC_TOKEN_PROGRAM_V0 ? CLASSIC_ACCOUNT : TOKEN_2022_ACCOUNT;
      const rows = body.params[0] === EMPTY_WALLET ? [] : [row(account, program)];
      return standard(body.id, program === CLASSIC_TOKEN_PROGRAM_V0 ? 1200 : 1201, rows);
    }
    return v2(body.id, 1200, [], `still-open-${body.id}`);
  });
  const report = await runHeliusOwnerEnumerationCompatibilityProbeV0(input({ known_control_repetitions: 10 }), h.dependencies);

  assert.equal(report.request_accounting.rpc_requests_made, 210);
  assert.equal(report.request_accounting.http_requests_made, 210);
  assert.equal(h.seen.length, 210);
  assert.equal(report.observations.known_control.standard_runs.length, 10);
  assert.equal(report.observations.known_control.standard_runs.every(run =>
    run.reason === 'pair_attempts_exhausted' && run.rpc_request_count === 16), true);
  assert.equal(report.observations.standard_vs_fully_exhausted_v2.every(run =>
    run.status === 'UNRESOLVED' && run.reason === 'v2_page_cap_exhausted' && run.rpc_request_count === 8), true);
  assert.equal(report.verdict, 'UNRESOLVED');
});
