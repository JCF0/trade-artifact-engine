import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1,
  captureTargetAccountEnumerationV1,
  createTargetAccountEnumerationPortV1,
  validateTargetAccountEnumerationStructureV1,
} from './target-account-enumeration-port-v1.mjs';
import { providerPublicKey } from './fixtures/test-identities.mjs';

const WALLET = providerPublicKey('enumeration-wallet');
const MINT = providerPublicKey('enumeration-mint');
const ACCOUNT = providerPublicKey('enumeration-account');
const DELEGATE = providerPublicKey('enumeration-delegate');
const [TOKEN_PROGRAM, TOKEN_2022_PROGRAM] = TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1;

function rawAccount(overrides = {}) {
  return {
    account: ACCOUNT,
    account_program: TOKEN_PROGRAM,
    lamports: '2039280',
    executable: false,
    rent_epoch: '0',
    raw_account_data: { encoding: 'base64', bytes: 'AQIDBA==' },
    normalized_state_profile: 'CAPABILITY_ATTESTED_TOKEN_ACCOUNT_STATE_V1',
    token_state: {
      mint: MINT,
      token_authority: WALLET,
      raw_amount: '0',
      decimals: 6,
      delegate_status: 'NONE',
      delegate: null,
      delegated_raw_amount: '0',
      close_authority_status: 'NONE',
      close_authority: null,
      lifecycle_state: 'EXISTS',
      account_state: 'INITIALIZED',
    },
    ...overrides,
  };
}

function capability(responses = {}) {
  const calls = [];
  return {
    calls,
    value: {
      async enumerateTargetAccountsByProgramV1(request) {
        calls.push(structuredClone(request));
        return structuredClone(responses[request.token_program] ?? {
          context: { slot: 500 },
          accounts: [],
        });
      },
    },
  };
}

async function capture(harness) {
  return captureTargetAccountEnumerationV1({
    port: createTargetAccountEnumerationPortV1(harness.value),
    wallet: WALLET,
    target_mint: MINT,
    boundary_kind: 'OPENING',
  });
}

test('captures separate successful canonical Token and Token-2022 coverages at one response-derived context', async () => {
  const harness = capability({
    [TOKEN_PROGRAM]: { context: { slot: 500 }, accounts: [rawAccount()] },
    [TOKEN_2022_PROGRAM]: { context: { slot: 500 }, accounts: [] },
  });
  const result = await capture(harness);

  assert.equal(validateTargetAccountEnumerationStructureV1(result), true);
  assert.deepEqual(result.required_token_programs, [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
  assert.equal(result.enumeration_context.slot, 500);
  assert.deepEqual(result.program_results.map(item => [item.token_program, item.response_status, item.accounts.length]), [
    [TOKEN_PROGRAM, 'SUCCESS', 1],
    [TOKEN_2022_PROGRAM, 'SUCCESS', 0],
  ]);
  assert.match(result.enumeration_digest, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(result.program_results[0].accounts[0].raw_account_data));
  assert.deepEqual(harness.calls, [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map(token_program => ({
    wallet: WALLET,
    target_mint: MINT,
    token_program,
    boundary_kind: 'OPENING',
    commitment: 'finalized',
    data_encoding: 'base64',
  })));
});

test('an authoritative empty population requires explicit successful empty responses for both programs', async () => {
  const result = await capture(capability());
  assert.equal(result.program_results.length, 2);
  assert.ok(result.program_results.every(item => item.response_status === 'SUCCESS' && item.accounts.length === 0));

  const omitted = structuredClone(result);
  omitted.program_results.pop();
  omitted.required_token_programs.pop();
  assert.throws(() => validateTargetAccountEnumerationStructureV1(omitted), error => error.code === 'required_program_coverage_missing');
});

test('rejects caller completeness and boundary assertions at the closed capture boundary', async () => {
  const port = createTargetAccountEnumerationPortV1(capability().value);
  await assert.rejects(captureTargetAccountEnumerationV1({
    port, wallet: WALLET, target_mint: MINT, boundary_kind: 'OPENING', complete: true,
  }), error => error.code === 'unknown_field');
  await assert.rejects(captureTargetAccountEnumerationV1({
    port, wallet: WALLET, target_mint: MINT, boundary_kind: 'OPENING', boundary_slot: 500,
  }), error => error.code === 'unknown_field');
});

test('generic registered callbacks cannot self-label fabricated empty or nonempty responses as production evidence', async () => {
  await assert.rejects(capture(capability({
    [TOKEN_PROGRAM]: {
      context: { slot: 500 }, accounts: [], source_evidence: {},
    },
  })), error => error.code === 'account_enumeration_response_invalid');
});

test('rejects mismatched response contexts rather than choosing a caller or later boundary', async () => {
  const harness = capability({
    [TOKEN_PROGRAM]: { context: { slot: 500 }, accounts: [] },
    [TOKEN_2022_PROGRAM]: { context: { slot: 501 }, accounts: [] },
  });
  await assert.rejects(capture(harness), error => error.code === 'enumeration_context_mismatch');
});

test('retains raw account evidence while validating normalized authority, delegate, and close-authority state', async () => {
  const delegated = rawAccount({
    token_state: {
      ...rawAccount().token_state,
      raw_amount: '7',
      delegate_status: 'PRESENT',
      delegate: DELEGATE,
      delegated_raw_amount: '3',
      close_authority_status: 'PRESENT',
      close_authority: DELEGATE,
      account_state: 'FROZEN',
    },
  });
  const result = await capture(capability({
    [TOKEN_PROGRAM]: { context: { slot: 500 }, accounts: [delegated] },
  }));
  assert.equal(result.program_results[0].accounts[0].raw_account_data.bytes, 'AQIDBA==');
  assert.equal(result.program_results[0].accounts[0].token_state.delegate, DELEGATE);
  assert.equal(result.program_results[0].accounts[0].token_state.close_authority, DELEGATE);
  assert.equal(
    result.program_results[0].accounts[0].normalized_state_profile,
    'CAPABILITY_ATTESTED_TOKEN_ACCOUNT_STATE_V1',
  );

  for (const mutate of [
    account => { account.token_state.token_authority = DELEGATE; },
    account => { account.token_state.mint = providerPublicKey('wrong-mint'); },
    account => { account.account_program = TOKEN_2022_PROGRAM; },
    account => { account.token_state.delegate_status = 'NONE'; },
  ]) {
    const forged = structuredClone(result);
    mutate(forged.program_results[0].accounts[0]);
    assert.throws(() => validateTargetAccountEnumerationStructureV1(forged));
  }
});

test('retains a separate nonempty Token-2022 program coverage without applying a legacy layout assumption', async () => {
  const token2022Account = rawAccount({
    account: providerPublicKey('enumeration-token-2022-account'),
    account_program: TOKEN_2022_PROGRAM,
    raw_account_data: { encoding: 'base64', bytes: 'BQYHCAkKCw==' },
  });
  const result = await capture(capability({
    [TOKEN_PROGRAM]: { context: { slot: 500 }, accounts: [] },
    [TOKEN_2022_PROGRAM]: { context: { slot: 500 }, accounts: [token2022Account] },
  }));
  assert.equal(result.program_results[0].accounts.length, 0);
  assert.equal(result.program_results[1].token_program, TOKEN_2022_PROGRAM);
  assert.equal(result.program_results[1].accounts[0].account_program, TOKEN_2022_PROGRAM);
  assert.equal(result.program_results[1].accounts[0].raw_account_data.bytes, 'BQYHCAkKCw==');
});

test('rejects duplicate accounts, unsafe raw evidence, malformed capabilities, and leaked capability errors', async () => {
  const duplicate = capability({
    [TOKEN_PROGRAM]: { context: { slot: 500 }, accounts: [rawAccount(), rawAccount()] },
  });
  await assert.rejects(capture(duplicate), error => error.code === 'duplicate_enumerated_account');

  const unsafe = rawAccount();
  Object.defineProperty(unsafe.raw_account_data, 'bytes', { enumerable: true, get() { throw new Error('secret'); } });
  const unsafeHarness = capability();
  unsafeHarness.value.enumerateTargetAccountsByProgramV1 = async ({ token_program }) => ({
    context: { slot: 500 }, accounts: token_program === TOKEN_PROGRAM ? [unsafe] : [],
  });
  await assert.rejects(capture(unsafeHarness), error => error.code === 'account_enumeration_response_invalid');

  assert.throws(() => createTargetAccountEnumerationPortV1({
    enumerateTargetAccountsByProgramV1() {}, extra() {},
  }), error => error.code === 'account_enumeration_capability_denied');

  const leaking = createTargetAccountEnumerationPortV1({
    async enumerateTargetAccountsByProgramV1() { throw new Error('/secret/provider/path'); },
  });
  await assert.rejects(captureTargetAccountEnumerationV1({
    port: leaking, wallet: WALLET, target_mint: MINT, boundary_kind: 'OPENING',
  }), error => {
    assert.equal(error.code, 'account_enumeration_capability_failed');
    assert.doesNotMatch(error.message, /secret|provider|path/i);
    return true;
  });

  const api = await import('./target-account-enumeration-port-v1.mjs');
  assert.equal(api.validateTargetAccountEnumerationV1, undefined);
  assert.equal(typeof api.validateTargetAccountEnumerationStructureV1, 'function');
});
