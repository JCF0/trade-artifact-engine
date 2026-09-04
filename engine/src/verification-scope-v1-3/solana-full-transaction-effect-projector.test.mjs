#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import {
  canonicalTransactionEffectRecordIdV13,
  validateTransactionEffectStructureV13,
} from './transaction-effect.mjs';
import { providerPublicKey, providerSignature } from '../wallet-acquisition/fixtures/test-identities.mjs';
import {
  CONTROLLED_MAINNET_CALIBRATION_WALLET_V1,
  controlledMainnetCalibrationTransactionsV1,
} from './fixtures/controlled-mainnet-calibration-round-trip-v1.mjs';

const WALLET = providerPublicKey('v13-projector-wallet');
const SPONSOR = providerPublicKey('v13-projector-sponsor');
const ROUTE = providerPublicKey('v13-projector-route');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const TARGET = providerPublicKey('v13-projector-target-mint');

function transaction(name, {
  executionState = 'succeeded',
  feePayer = WALLET,
  fee = 5,
  walletDelta = feePayer === WALLET ? -fee : 0,
  tokenRows = [
    { label: 'input', mint: USDC, owner: WALLET, pre: '25', post: '0', decimals: 6 },
    { label: 'output', mint: TARGET, owner: WALLET, pre: '0', post: '100', decimals: 6 },
  ],
  instructionLocation = 'top',
  instructionAccounts = [WALLET],
  includeWallet = true,
} = {}) {
  const staticAddresses = [feePayer];
  for (const address of [WALLET, ROUTE, TOKEN_PROGRAM]) {
    if ((address !== WALLET || includeWallet) && !staticAddresses.includes(address)) staticAddresses.push(address);
  }
  const tokenAccounts = tokenRows.map((row, index) => providerPublicKey(`${name}-${row.label}-${index}`));
  const accounts = [
    ...staticAddresses.map((address, index) => ({
      address,
      is_signer: index === 0 || address === WALLET,
      is_writable: index === 0 || address === WALLET,
      source: 'static',
    })),
    ...tokenAccounts.map(address => ({ address, is_signer: false, is_writable: true, source: 'lookup_writable' })),
  ];
  const pre = accounts.map(() => 0);
  const post = accounts.map(() => 0);
  const feeIndex = staticAddresses.indexOf(feePayer);
  pre[feeIndex] = 1_000_000_000;
  post[feeIndex] = pre[feeIndex] - fee;
  const walletIndex = staticAddresses.indexOf(WALLET);
  if (walletIndex >= 0) {
    if (walletIndex !== feeIndex) {
      pre[walletIndex] = 500_000_000;
      post[walletIndex] = pre[walletIndex] + walletDelta;
    } else post[walletIndex] = pre[walletIndex] + walletDelta;
  }
  const balancingIndex = staticAddresses.indexOf(ROUTE);
  const unexplainedWalletDelta = BigInt(walletDelta) + BigInt(feePayer === WALLET ? fee : 0);
  if (balancingIndex >= 0 && unexplainedWalletDelta !== 0n) {
    pre[balancingIndex] = 1_000_000_000;
    post[balancingIndex] = Number(BigInt(pre[balancingIndex]) - unexplainedWalletDelta);
  }
  tokenAccounts.forEach((account, index) => {
    const accountIndex = accounts.findIndex(value => value.address === account);
    pre[accountIndex] = 2_039_280;
    post[accountIndex] = 2_039_280;
  });
  const rows = side => tokenRows.flatMap((row, index) => {
    if (row[side] === undefined) return [];
    const account = tokenAccounts[index];
    const accountIndex = accounts.findIndex(value => value.address === account);
    return [{
      account_index: accountIndex, account, mint: row.mint, owner: row.owner,
      raw_amount: row[side], decimals: row.decimals, token_program: row.tokenProgram ?? TOKEN_PROGRAM,
    }];
  });
  const instruction = { instruction_index: 0, program_id: ROUTE, accounts: instructionAccounts, data: '' };
  return {
    full_transaction_version: 'solana_full_transaction_v1',
    signature: providerSignature(name),
    slot: 1234,
    block_time: 1_780_000_000,
    execution_state: executionState,
    transaction_version: 0,
    fee_payer: feePayer,
    fee_lamports: fee,
    accounts,
    pre_lamport_balances: pre,
    post_lamport_balances: post,
    pre_token_balances: rows('pre'),
    post_token_balances: rows('post'),
    instructions: [{ ...instruction, program_id: instructionLocation === 'top' ? ROUTE : TOKEN_PROGRAM }],
    inner_instruction_groups: instructionLocation === 'inner'
      ? [{ outer_instruction_index: 0, instructions: [instruction] }]
      : [],
  };
}

function project(value) {
  return projectSolanaFullTransactionEffectV13({ wallet: WALLET, transaction: value });
}

function projectCalibration(value) {
  return projectSolanaFullTransactionEffectV13({
    wallet: CONTROLLED_MAINNET_CALIBRATION_WALLET_V1,
    transaction: value,
  });
}

const TEST_BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function testDecodeBase58(value) {
  const bytes = [0];
  for (const character of value) {
    let carry = TEST_BASE58.indexOf(character);
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let index = 0; index < value.length - 1 && value[index] === '1'; index += 1) bytes.push(0);
  return bytes.reverse();
}
function testEncodeBase58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let prefix = '';
  for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) prefix += '1';
  return prefix + digits.reverse().map(digit => TEST_BASE58[digit]).join('');
}

function writeTestU64(bytes, offset, value) {
  const numeric = BigInt(value);
  for (let index = 0; index < 8; index += 1) {
    bytes[offset + index] = Number((numeric >> BigInt(index * 8)) & 0xffn);
  }
}

test('projects both frozen direct classic Whirlpool swap directions without residuals', () => {
  const [acquisition, disposal] = controlledMainnetCalibrationTransactionsV1().map(projectCalibration);
  assert.deepEqual(acquisition.residual_unresolved_effects, []);
  assert.deepEqual(disposal.residual_unresolved_effects, []);
  assert.deepEqual(
    acquisition.established_effects.filter(effect => effect.effect_kind === 'token_transfer')
      .map(effect => [effect.mint, effect.signed_raw_quantity]),
    [[USDC, '-5000000'], ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', '21437310']],
  );
  assert.deepEqual(
    disposal.established_effects.filter(effect => effect.effect_kind === 'token_transfer')
      .map(effect => [effect.mint, effect.signed_raw_quantity]),
    [['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', '-21437310'], [USDC, '4748794']],
  );
  for (const projection of [acquisition, disposal]) {
    const observations = new Set(projection.established_effects
      .filter(effect => effect.effect_kind === 'token_balance_observation')
      .map(effect => effect.effect_id));
    for (const transfer of projection.established_effects.filter(effect => effect.effect_kind === 'token_transfer')) {
      assert.equal(transfer.source_coordinate.coordinate_kind, 'instruction');
      assert.equal(transfer.source_coordinate.outer_instruction_index, 0);
      assert.notEqual(transfer.source_coordinate.inner_instruction_index, null);
      assert.equal(transfer.corroborating_effect_ids.length, 1);
      assert.ok(observations.has(transfer.corroborating_effect_ids[0]));
    }
  }
});

test('classic Whirlpool recognition is independent of signature, slot, wallet, vault identities, and observed amounts', () => {
  const [value] = controlledMainnetCalibrationTransactionsV1();
  const alternate = {
    wallet: providerPublicKey('orca-profile-alternate-wallet'),
    targetAccount: providerPublicKey('orca-profile-alternate-target-account'),
    quoteAccount: providerPublicKey('orca-profile-alternate-quote-account'),
    pool: providerPublicKey('orca-profile-alternate-pool'),
    targetVault: providerPublicKey('orca-profile-alternate-target-vault'),
    quoteVault: providerPublicKey('orca-profile-alternate-quote-vault'),
  };
  const replacements = new Map([
    [CONTROLLED_MAINNET_CALIBRATION_WALLET_V1, alternate.wallet],
    [value.instructions[0].accounts[3], alternate.targetAccount],
    [value.instructions[0].accounts[5], alternate.quoteAccount],
    [value.instructions[0].accounts[2], alternate.pool],
    [value.instructions[0].accounts[4], alternate.targetVault],
    [value.instructions[0].accounts[6], alternate.quoteVault],
  ]);
  value.signature = providerSignature('orca-profile-alternate-signature');
  value.slot = 123456;
  value.block_time = 1700000000;
  value.fee_payer = alternate.wallet;
  for (const account of value.accounts) account.address = replacements.get(account.address) ?? account.address;
  value.instructions[0].accounts = value.instructions[0].accounts.map(address => replacements.get(address) ?? address);
  for (const instruction of value.inner_instruction_groups[0].instructions) {
    instruction.accounts = instruction.accounts.map(address => replacements.get(address) ?? address);
  }
  for (const rows of [value.pre_token_balances, value.post_token_balances]) {
    for (const row of rows) {
      row.account = replacements.get(row.account) ?? row.account;
      row.owner = replacements.get(row.owner) ?? row.owner;
    }
  }
  const outerBytes = testDecodeBase58(value.instructions[0].data);
  writeTestU64(outerBytes, 8, 100n);
  writeTestU64(outerBytes, 16, 190n);
  value.instructions[0].data = testEncodeBase58(outerBytes);
  value.inner_instruction_groups[0].instructions.forEach((instruction, index) => {
    const bytes = testDecodeBase58(instruction.data);
    writeTestU64(bytes, 1, index === 0 ? 100n : 200n);
    instruction.data = testEncodeBase58(bytes);
  });
  const amounts = new Map([
    [alternate.quoteAccount, ['1000', '900']], [alternate.quoteVault, ['5000', '5100']],
    [alternate.targetVault, ['10000', '9800']], [alternate.targetAccount, ['0', '200']],
  ]);
  for (const before of value.pre_token_balances) before.raw_amount = amounts.get(before.account)[0];
  for (const after of value.post_token_balances) after.raw_amount = amounts.get(after.account)[1];

  const projection = projectSolanaFullTransactionEffectV13({ wallet: alternate.wallet, transaction: value });
  assert.deepEqual(projection.residual_unresolved_effects, []);
  assert.deepEqual(projection.established_effects
    .filter(effect => effect.effect_kind === 'token_transfer')
    .map(effect => effect.signed_raw_quantity).sort(), ['-100', '200']);
});

test('partial classic Whirlpool profiles remain residual-bearing and grant no transfer authority', () => {
  const mutations = [
    value => { value.instructions[0].program_id = TOKEN_PROGRAM; },
    value => { value.accounts.find(account => account.address === value.instructions[0].accounts[2]).is_writable = false; },
    value => {
      for (const rows of [value.pre_token_balances, value.post_token_balances]) {
        rows.find(row => row.account === value.instructions[0].accounts[4]).mint = TARGET;
      }
    },
    value => { value.inner_instruction_groups[0].instructions[0].data = '3aYxJmutJ6wy'; },
    value => { value.post_token_balances.find(row => row.account === value.instructions[0].accounts[6]).raw_amount = '7080089857'; },
    value => {
      const bytes = testDecodeBase58(value.instructions[0].data);
      const output = 21_437_311n;
      for (let index = 0; index < 8; index += 1) bytes[16 + index] = Number((output >> BigInt(index * 8)) & 0xffn);
      value.instructions[0].data = testEncodeBase58(bytes);
    },
    value => {
      const bytes = testDecodeBase58(value.inner_instruction_groups[0].instructions[0].data);
      bytes[0] = 4;
      value.inner_instruction_groups[0].instructions[0].data = testEncodeBase58(bytes);
    },
    value => { value.inner_instruction_groups[0].instructions[1].accounts.reverse(); },
    value => { value.instructions.push({ ...structuredClone(value.instructions[0]), instruction_index: 1 }); },
    value => {
      value.inner_instruction_groups[0].instructions.push({
        ...structuredClone(value.inner_instruction_groups[0].instructions[1]), instruction_index: 2,
      });
    },
    value => {
      const outer = value.instructions[0];
      outer.accounts[1] = outer.accounts[2];
      outer.accounts[3] = outer.accounts[7];
      outer.accounts[5] = outer.accounts[8];
      value.inner_instruction_groups[0].instructions[0].accounts = [outer.accounts[7], outer.accounts[4], outer.accounts[2]];
      value.inner_instruction_groups[0].instructions[1].accounts = [outer.accounts[6], outer.accounts[8], outer.accounts[2]];
    },
  ];
  for (const mutate of mutations) {
    const [value] = controlledMainnetCalibrationTransactionsV1();
    mutate(value);
    const projection = projectCalibration(value);
    assert.equal(projection.established_effects.some(effect => effect.effect_kind === 'token_transfer'), false);
    assert.ok(projection.residual_unresolved_effects.some(residual =>
      residual.reason_code === 'UNMATCHED_WALLET_INSTRUCTION'));
  }
});

test('projects exact balance observations without assigning transfer, trade, or economic order semantics', () => {
  const built = project(transaction('v13-observations', {
    fee: 5000,
    walletDelta: -10_005_000,
    tokenRows: [
      { label: 'usdc', mint: USDC, owner: WALLET, pre: '18446744073709551615', post: '0', decimals: 6 },
      { label: 'wsol', mint: WSOL, owner: WALLET, pre: '0', post: '7', decimals: 9 },
      { label: 'target', mint: TARGET, owner: WALLET, pre: '0', post: '100', decimals: 6 },
    ],
  }));

  assert.equal(built.economic_order_status, 'UNESTABLISHED');
  assert.deepEqual(built.established_effects.map(effect => effect.effect_kind), [
    'network_fee', 'native_balance_observation', 'token_balance_observation',
    'token_balance_observation', 'token_balance_observation',
  ]);
  assert.deepEqual(
    built.established_effects.filter(effect => effect.effect_kind === 'token_balance_observation')
      .map(effect => [effect.mint, effect.signed_raw_quantity, effect.economic_order]),
    [[USDC, '-18446744073709551615', null], [WSOL, '7', null], [TARGET, '100', null]],
  );
  assert.equal(built.established_effects.find(
    effect => effect.effect_kind === 'native_balance_observation' && effect.account === WALLET,
  ).signed_lamports, '-10005000');
  assert.ok(built.established_effects.every(effect => !['transfer', 'trade', 'deposit', 'withdrawal'].includes(effect.effect_kind)));
  assert.deepEqual(built.residual_unresolved_effects.map(value => [
    value.reason_code,
    value.source_coordinate.outer_instruction_index,
    value.source_coordinate.inner_instruction_index,
  ]), [['UNMATCHED_WALLET_INSTRUCTION', 0, null]]);
  assert.equal(built.residual_unresolved_effects[0].owner, null);
});

test('keeps established observations and identity-bound residual observations in one transaction', () => {
  const value = transaction('v13-mixed-residual', { tokenRows: [
    { label: 'known', mint: TARGET, owner: WALLET, pre: '0', post: '10', decimals: 6 },
    { label: 'unknown', mint: USDC, owner: null, pre: '1', post: '3', decimals: 6 },
  ] });
  const built = project(value);
  assert.ok(built.established_effects.some(effect => effect.mint === TARGET));
  const unknown = built.residual_unresolved_effects.find(item => item.reason_code === 'UNKNOWN_TOKEN_OWNER');
  assert.equal(unknown.mint, USDC);
  assert.equal(unknown.observed_signed_raw_quantity, '2');
  assert.equal(unknown.source_coordinate.coordinate_kind, 'account_balance');
});

test('failed transactions retain only committed fee/native observations and residual token reconciliation evidence', () => {
  const value = transaction('v13-failed', {
    executionState: 'failed',
    fee: 5000,
    walletDelta: -5000,
    tokenRows: [
      { label: 'input', mint: USDC, owner: WALLET, pre: '25', post: '0', decimals: 6 },
      { label: 'output', mint: TARGET, owner: WALLET, pre: '0', post: '100', decimals: 6 },
    ],
  });
  const built = project(value);
  assert.deepEqual(built.established_effects.map(effect => effect.effect_kind), [
    'network_fee', 'native_balance_observation',
  ]);
  assert.equal(built.established_effects[0].signed_lamports, '-5000');
  assert.equal(built.established_effects[1].signed_lamports, '-5000');
  assert.ok(built.residual_unresolved_effects.some(item => item.reason_code === 'FAILED_TOKEN_BALANCE_OBSERVATION'));
  assert.ok(!built.established_effects.some(effect => ['token_balance_observation', 'account_closure'].includes(effect.effect_kind)));
});

test('preserves explicit zero fee and sponsored fee-payer identity exactly', () => {
  const zero = project(transaction('v13-zero-fee', { fee: 0, tokenRows: [], instructionAccounts: [] }));
  assert.equal(zero.established_effects.length, 1);
  assert.equal(zero.established_effects[0].effect_kind, 'network_fee');
  assert.equal(zero.established_effects[0].account, WALLET);
  assert.equal(zero.established_effects[0].direction, 'none');
  assert.equal(zero.established_effects[0].signed_lamports, '0');
  assert.equal(zero.established_effects[0].evidence_role, 'attributed_component');
  assert.match(zero.established_effects[0].effect_id, /^effect-[0-9a-f]{64}$/);

  const sponsored = project(transaction('v13-sponsored', {
    feePayer: SPONSOR, fee: 7, walletDelta: -10, tokenRows: [], instructionAccounts: [],
  }));
  assert.equal(sponsored.fee_payer, SPONSOR);
  assert.equal(sponsored.established_effects[0].account, SPONSOR);
  assert.equal(sponsored.established_effects[0].signed_lamports, '-7');
  assert.equal(sponsored.established_effects[1].account, WALLET);
  assert.equal(sponsored.established_effects[1].signed_lamports, '-10');
});

function closureTransaction(name, {
  location = 'top', tokenProgram = TOKEN_PROGRAM, destination = WALLET,
  owner = WALLET, authority = WALLET,
} = {}) {
  const closed = providerPublicKey(`${name}-closed`);
  const addresses = [...new Set([WALLET, tokenProgram, destination, authority, closed])];
  const accounts = addresses.map((address, index) => ({
    address, is_signer: index === 0 || address === authority,
    is_writable: address === WALLET || address === destination || address === closed,
    source: 'static',
  }));
  const index = address => addresses.indexOf(address);
  const rent = 2_039_280;
  const pre = addresses.map(() => 0);
  const post = addresses.map(() => 0);
  pre[index(WALLET)] = 1_000_000_000;
  post[index(WALLET)] = pre[index(WALLET)] - 5 + (destination === WALLET ? rent : 0);
  pre[index(closed)] = rent;
  if (destination !== WALLET) {
    pre[index(destination)] = 10;
    post[index(destination)] = 10 + rent;
  }
  const row = {
    account_index: index(closed), account: closed, mint: TARGET, owner,
    raw_amount: '0', decimals: 6, token_program: tokenProgram,
  };
  const close = { instruction_index: location === 'inner' ? 0 : 1, program_id: tokenProgram, accounts: [closed, destination, authority], data: 'A' };
  return {
    value: {
      full_transaction_version: 'solana_full_transaction_v1', signature: providerSignature(name), slot: 1234,
      block_time: 1_780_000_000, execution_state: 'succeeded', transaction_version: 0,
      fee_payer: WALLET, fee_lamports: 5, accounts,
      pre_lamport_balances: pre, post_lamport_balances: post,
      pre_token_balances: [row], post_token_balances: [],
      instructions: location === 'top'
        ? [{ instruction_index: 0, program_id: ROUTE, accounts: [], data: '' }, close]
        : [{ instruction_index: 0, program_id: ROUTE, accounts: [], data: '' }],
      inner_instruction_groups: location === 'inner'
        ? [{ outer_instruction_index: 0, instructions: [close] }]
        : [],
    },
    closed,
  };
}

test('projects only existing narrow CloseAccount evidence with exact top and inner coordinates', () => {
  for (const tokenProgram of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    for (const location of ['top', 'inner']) {
      const { value, closed } = closureTransaction(`v13-close-${tokenProgram.slice(0, 6)}-${location}`, { location, tokenProgram });
      const built = project(value);
      const closure = built.established_effects.find(effect => effect.effect_kind === 'account_closure');
      assert.equal(closure.account, closed);
      assert.equal(closure.owner, WALLET);
      assert.equal(closure.authority, WALLET);
      assert.equal(closure.destination, WALLET);
      assert.equal(closure.mint, TARGET);
      assert.equal(closure.token_program, tokenProgram);
      assert.equal(closure.signed_lamports, '-2039280');
      assert.deepEqual(closure.source_coordinate, location === 'top'
        ? { coordinate_kind: 'instruction', outer_instruction_index: 1, inner_instruction_index: null, account_index: null }
        : { coordinate_kind: 'instruction', outer_instruction_index: 0, inner_instruction_index: 0, account_index: null });
      assert.ok(!built.residual_unresolved_effects.some(item => item.source_coordinate.outer_instruction_index === closure.source_coordinate.outer_instruction_index
        && item.source_coordinate.inner_instruction_index === closure.source_coordinate.inner_instruction_index));
    }
  }
});

test('retains externally directed closure rent as a residual beside the established closure', () => {
  const destination = providerPublicKey('v13-external-close-destination');
  const { value } = closureTransaction('v13-external-close', { destination });
  const built = project(value);
  assert.ok(built.established_effects.some(effect => effect.effect_kind === 'account_closure'));
  const residual = built.residual_unresolved_effects.find(item => item.reason_code === 'EXTERNAL_CLOSURE_RENT');
  assert.equal(residual.account, destination);
  assert.equal(residual.observed_signed_lamports, '2039280');
});

test('does not attribute aggregate closure-account and destination deltas when another instruction can affect them', () => {
  const { value } = closureTransaction('v13-confounded-close');
  value.instructions[0].accounts = [value.accounts[0].address, value.accounts[2].address];
  const built = project(value);
  const closure = built.established_effects.find(effect => effect.effect_kind === 'account_closure');
  assert.equal(closure.signed_lamports, null);
  assert.ok(built.residual_unresolved_effects.some(item => item.reason_code === 'ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED'));
});

test('reconciles a clean closure when its external destination is also the fee payer', () => {
  const external = providerPublicKey('v13-sponsored-close-payer');
  const { value } = closureTransaction('v13-sponsored-close', { destination: external });
  const [walletAccount, tokenProgramAccount, externalAccount, closedAccount] = value.accounts;
  value.accounts = [
    { ...externalAccount, is_signer: true },
    walletAccount,
    tokenProgramAccount,
    closedAccount,
  ];
  value.fee_payer = external;
  value.pre_lamport_balances = [100000, 1000000, 0, 2039280];
  value.post_lamport_balances = [2139275, 1000000, 0, 0];
  value.pre_token_balances[0].account_index = 3;
  const built = project(value);
  const closure = built.established_effects.find(effect => effect.effect_kind === 'account_closure');
  const fee = built.established_effects.find(effect => effect.effect_kind === 'network_fee');
  const externalObservation = built.residual_unresolved_effects.find(
    residual => residual.reason_code === 'EXTERNAL_CLOSURE_RENT',
  );
  assert.equal(closure.signed_lamports, '-2039280');
  assert.deepEqual(externalObservation.related_effect_ids, [closure.effect_id, fee.effect_id].sort());
  assert.ok(!built.residual_unresolved_effects.some(item => item.reason_code === 'ACCOUNT_CLOSURE_UNRESOLVED'));
});

test('does not turn an exactly coherent wholly external closure into an analyzed-wallet residual', () => {
  const external = providerPublicKey('v13-wholly-external-close-owner');
  const { value } = closureTransaction('v13-wholly-external-close', { destination: external });
  value.pre_token_balances[0].owner = external;
  value.instructions[1].accounts[2] = external;
  value.accounts.find(account => account.address === external).is_signer = true;
  const built = project(value);
  assert.ok(!built.established_effects.some(effect => effect.effect_kind === 'account_closure'));
  assert.ok(!built.residual_unresolved_effects.some(item => item.source_coordinate.outer_instruction_index === 1));
});

test('does not decode closure effects or other instruction effects as committed after failure', () => {
  const { value } = closureTransaction('v13-failed-close');
  value.execution_state = 'failed';
  const built = project(value);
  assert.ok(!built.established_effects.some(effect => effect.effect_kind === 'account_closure'));
  assert.ok(built.residual_unresolved_effects.some(item => item.reason_code === 'UNMATCHED_WALLET_INSTRUCTION'));
});

test('preserves native reconciliation failures and missing wallet evidence as explicit residuals', () => {
  const impossible = transaction('v13-impossible-native', { tokenRows: [], instructionAccounts: [] });
  impossible.post_lamport_balances[1] += 1;
  const impossibleResidual = project(impossible).residual_unresolved_effects
    .find(item => item.reason_code === 'NATIVE_BALANCE_RECONCILIATION');
  assert.equal(impossibleResidual.source_coordinate.coordinate_kind, 'transaction');
  assert.equal(impossibleResidual.source_coordinate.account_index, null);

  const missing = transaction('v13-missing-wallet', {
    feePayer: SPONSOR, includeWallet: false, tokenRows: [], instructionAccounts: [],
  });
  const missingResidual = project(missing).residual_unresolved_effects
    .find(item => item.reason_code === 'WALLET_ACCOUNT_EVIDENCE_MISSING');
  assert.equal(missingResidual.source_coordinate.coordinate_kind, 'transaction');
  assert.equal(missingResidual.source_coordinate.account_index, null);
});

test('does not synthesize zero for a missing pre or post token-balance row', () => {
  for (const missingSide of ['pre', 'post']) {
    const row = {
      label: `missing-${missingSide}`, mint: TARGET, owner: WALLET,
      pre: missingSide === 'pre' ? undefined : '7',
      post: missingSide === 'post' ? undefined : '7',
      decimals: 6,
    };
    const built = project(transaction(`v13-${missingSide}-row`, {
      tokenRows: [row], instructionAccounts: [],
    }));
    assert.ok(!built.established_effects.some(effect => effect.effect_kind === 'token_balance_observation'));
    const residual = built.residual_unresolved_effects.find(
      item => item.reason_code === 'TOKEN_BALANCE_SIDE_MISSING',
    );
    assert.equal(residual.missing_balance_side, missingSide);
    assert.equal(residual.observed_signed_raw_quantity, null);
  }
});

test('keeps owner-null zero-token-delta native and instruction evidence materially visible', () => {
  const value = transaction('v13-owner-null-native', {
    tokenRows: [{ label: 'unknown', mint: TARGET, owner: null, pre: '7', post: '7', decimals: 6 }],
    instructionAccounts: [],
  });
  const tokenAccountIndex = value.pre_token_balances[0].account_index;
  const tokenAccount = value.pre_token_balances[0].account;
  const routeIndex = value.accounts.findIndex(account => account.address === ROUTE);
  value.post_lamport_balances[tokenAccountIndex] -= 1;
  value.post_lamport_balances[routeIndex] += 1;
  value.instructions[0].accounts = [tokenAccount];

  const built = project(value);
  const residuals = built.residual_unresolved_effects.filter(
    residual => residual.reason_code === 'UNKNOWN_TOKEN_OWNER' && residual.account === tokenAccount,
  );
  assert.ok(residuals.some(residual => residual.source_coordinate.coordinate_kind === 'account_balance'
    && residual.observed_signed_lamports === '-1'));
  assert.ok(residuals.some(residual => residual.source_coordinate.coordinate_kind === 'instruction'));
});

test('requires signer and writable account roles before establishing CloseAccount', () => {
  const variants = [
    value => { value.accounts.find(account => account.address === value.pre_token_balances[0].account).is_writable = false; },
    value => {
      const destination = providerPublicKey('v13-readonly-close-destination');
      value.accounts.push({ address: destination, is_signer: false, is_writable: false, source: 'static' });
      value.pre_lamport_balances.push(0);
      value.post_lamport_balances.push(2_039_280);
      value.post_lamport_balances[0] = value.pre_lamport_balances[0] - value.fee_lamports;
      value.instructions[1].accounts[1] = destination;
    },
  ];
  for (const [index, mutate] of variants.entries()) {
    const { value } = closureTransaction(`v13-close-role-${index}`);
    mutate(value);
    const built = project(value);
    assert.ok(!built.established_effects.some(effect => effect.effect_kind === 'account_closure'));
    assert.ok(built.residual_unresolved_effects.some(
      residual => residual.reason_code === 'ACCOUNT_CLOSURE_UNRESOLVED',
    ));
  }

  const sponsor = providerPublicKey('v13-close-role-sponsor');
  const { value } = closureTransaction('v13-close-role-authority');
  value.accounts.unshift({ address: sponsor, is_signer: true, is_writable: true, source: 'static' });
  value.accounts.find(account => account.address === WALLET).is_signer = false;
  value.pre_lamport_balances.unshift(100_000);
  value.post_lamport_balances.unshift(99_995);
  value.post_lamport_balances[1] = value.pre_lamport_balances[1] + 2_039_280;
  value.pre_token_balances[0].account_index += 1;
  value.fee_payer = sponsor;
  const built = project(value);
  assert.ok(!built.established_effects.some(effect => effect.effect_kind === 'account_closure'));
  assert.ok(built.residual_unresolved_effects.some(
    residual => residual.reason_code === 'ACCOUNT_CLOSURE_UNRESOLVED',
  ));
});

test('links fee and closure attribution to corroborating native observations without additive ambiguity', () => {
  const { value, closed } = closureTransaction('v13-close-provenance');
  const built = project(value);
  const fee = built.established_effects.find(effect => effect.effect_kind === 'network_fee');
  const closure = built.established_effects.find(effect => effect.effect_kind === 'account_closure');
  const walletNative = built.established_effects.find(
    effect => effect.effect_kind === 'native_balance_observation' && effect.account === WALLET,
  );
  const closedNative = built.established_effects.find(
    effect => effect.effect_kind === 'native_balance_observation' && effect.account === closed,
  );

  assert.equal(fee.evidence_role, 'attributed_component');
  assert.deepEqual(fee.corroborating_effect_ids, [walletNative.effect_id]);
  assert.equal(closure.evidence_role, 'attributed_component');
  assert.deepEqual(new Set(closure.corroborating_effect_ids), new Set([
    walletNative.effect_id, closedNative.effect_id,
  ]));
  assert.equal(walletNative.evidence_role, 'observation');
  assert.equal(closedNative.evidence_role, 'observation');
});

test('applies the fee adjustment to a wholly external closure whose destination is the fee payer', () => {
  const external = providerPublicKey('v13-wholly-external-fee-payer');
  const { value } = closureTransaction('v13-wholly-external-sponsored', { destination: external });
  value.pre_token_balances[0].owner = external;
  value.instructions[1].accounts[2] = external;
  const [walletAccount, tokenProgramAccount, externalAccount, closedAccount] = value.accounts;
  value.accounts = [
    { ...externalAccount, is_signer: true },
    walletAccount,
    tokenProgramAccount,
    closedAccount,
  ];
  value.fee_payer = external;
  value.pre_lamport_balances = [100000, 1000000, 0, 2039280];
  value.post_lamport_balances = [2139275, 1000000, 0, 0];
  value.pre_token_balances[0].account_index = 3;

  const built = project(value);
  assert.ok(!built.established_effects.some(effect => effect.effect_kind === 'account_closure'));
  assert.ok(!built.residual_unresolved_effects.some(
    residual => residual.source_coordinate.coordinate_kind === 'instruction'
      && residual.source_coordinate.outer_instruction_index === 1,
  ));
});

test('external closure-rent residual does not claim wallet ownership of the external destination', () => {
  const destination = providerPublicKey('v13-external-owner-proof-destination');
  const { value } = closureTransaction('v13-external-owner-proof', { destination });
  const residual = project(value).residual_unresolved_effects.find(
    item => item.reason_code === 'EXTERNAL_CLOSURE_RENT',
  );
  assert.equal(residual.account, destination);
  assert.equal(residual.owner, null);
});

test('retains admitted malformed CloseAccount evidence with no account operands as unresolved', () => {
  const value = transaction('v13-empty-close-accounts', {
    tokenRows: [], instructionAccounts: [],
  });
  value.instructions[0].program_id = TOKEN_PROGRAM;
  value.instructions[0].data = 'A';

  const built = project(value);
  const residual = built.residual_unresolved_effects.find(
    item => item.reason_code === 'ACCOUNT_CLOSURE_UNRESOLVED',
  );
  assert.ok(residual);
  assert.deepEqual(residual.accounts, []);
});

test('retains external fee-payer closure evidence when the net destination delta is zero or negative', () => {
  const rent = 2_039_280;
  for (const [name, fee, expectedNet] of [['zero', rent, '0'], ['negative', rent + 5, '-5']]) {
    const external = providerPublicKey(`v13-external-close-${name}-payer`);
    const { value } = closureTransaction(`v13-external-close-${name}`, { destination: external });
    const [walletAccount, tokenProgramAccount, externalAccount, closedAccount] = value.accounts;
    value.accounts = [{ ...externalAccount, is_signer: true }, walletAccount, tokenProgramAccount, closedAccount];
    value.fee_payer = external;
    value.fee_lamports = fee;
    value.pre_lamport_balances = [3_000_000, 1_000_000, 0, rent];
    value.post_lamport_balances = [3_000_000 + Number(expectedNet), 1_000_000, 0, 0];
    value.pre_token_balances[0].account_index = 3;

    const built = project(value);
    const closure = built.established_effects.find(effect => effect.effect_kind === 'account_closure');
    const feeEffect = built.established_effects.find(effect => effect.effect_kind === 'network_fee');
    const residual = built.residual_unresolved_effects.find(item => item.reason_code === 'EXTERNAL_CLOSURE_RENT');
    assert.equal(closure.signed_lamports, `-${rent}`);
    assert.equal(residual.observed_signed_lamports, expectedNet);
    assert.deepEqual(residual.related_effect_ids, [closure.effect_id, feeEffect.effect_id].sort());
  }
});

test('does not consume an external closure whose destination account is evidenced as wallet-owned', () => {
  const destination = providerPublicKey('v13-wallet-owned-close-destination');
  const externalOwner = providerPublicKey('v13-external-close-owner');
  const { value } = closureTransaction('v13-wallet-owned-close-credit', { destination });
  value.pre_token_balances[0].owner = externalOwner;
  value.instructions[1].accounts[2] = externalOwner;
  value.accounts.push({ address: externalOwner, is_signer: true, is_writable: false, source: 'static' });
  value.pre_lamport_balances.push(0);
  value.post_lamport_balances.push(0);
  const destinationIndex = value.accounts.findIndex(account => account.address === destination);
  const destinationRow = {
    account_index: destinationIndex, account: destination, mint: USDC, owner: WALLET,
    raw_amount: '0', decimals: 6, token_program: TOKEN_PROGRAM,
  };
  value.pre_token_balances.push(destinationRow);
  value.post_token_balances.push({ ...destinationRow });
  value.pre_token_balances.sort((left, right) => left.account_index - right.account_index);
  value.post_token_balances.sort((left, right) => left.account_index - right.account_index);

  const built = project(value);
  assert.ok(built.residual_unresolved_effects.some(residual =>
    residual.reason_code === 'ACCOUNT_CLOSURE_UNRESOLVED'
    && residual.source_coordinate.outer_instruction_index === 1));
});

test('does not consume a closure whose destination ownership evidence is unknown', () => {
  const destination = providerPublicKey('v13-unknown-close-destination');
  const externalOwner = providerPublicKey('v13-unknown-close-owner');
  const destinationMint = providerPublicKey('v13-unknown-close-destination-mint');
  const { value, closed } = closureTransaction('v13-unknown-close-credit', {
    destination, owner: externalOwner, authority: externalOwner,
  });
  const destinationIndex = value.accounts.findIndex(account => account.address === destination);
  value.accounts[destinationIndex].is_signer = true;
  const destinationRow = {
    account_index: destinationIndex, account: destination, mint: destinationMint, owner: null,
    raw_amount: '0', decimals: 6, token_program: TOKEN_PROGRAM,
  };
  value.pre_token_balances.push(destinationRow);
  value.post_token_balances.push({ ...destinationRow });
  value.pre_token_balances.sort((left, right) => left.account_index - right.account_index);
  value.post_token_balances.sort((left, right) => left.account_index - right.account_index);

  const built = project(value);
  const closureResidual = built.residual_unresolved_effects.find(residual =>
    residual.reason_code === 'ACCOUNT_CLOSURE_UNRESOLVED'
    && residual.source_coordinate.outer_instruction_index === 1);
  assert.ok(closureResidual);
  assert.equal(closureResidual.account, closed);
  assert.equal(closureResidual.owner, externalOwner);
  assert.equal(closureResidual.authority, externalOwner);
  assert.equal(closureResidual.destination, destination);
  assert.equal(closureResidual.mint, TARGET);
  assert.equal(closureResidual.token_program, TOKEN_PROGRAM);
  assert.ok(built.residual_unresolved_effects.some(residual =>
    residual.reason_code === 'UNKNOWN_TOKEN_OWNER'
    && residual.account === destination));
});

test('establishes CloseAccount with a distinct valid signer close authority', () => {
  const authority = providerPublicKey('v13-distinct-close-authority');
  const { value, closed } = closureTransaction('v13-distinct-close-authority', { authority });

  const closure = project(value).established_effects.find(effect => effect.effect_kind === 'account_closure');
  assert.ok(closure);
  assert.equal(closure.account, closed);
  assert.equal(closure.owner, WALLET);
  assert.equal(closure.authority, authority);
});

test('rejects missing and non-signer CloseAccount authority roles', () => {
  const distinctAuthority = providerPublicKey('v13-invalid-close-authority');
  const nonSigner = closureTransaction('v13-nonsigner-close-authority', { authority: distinctAuthority }).value;
  nonSigner.accounts.find(account => account.address === distinctAuthority).is_signer = false;

  const missing = closureTransaction('v13-missing-close-authority').value;
  missing.instructions[1].accounts = missing.instructions[1].accounts.slice(0, 2);

  for (const value of [nonSigner, missing]) {
    const built = project(value);
    assert.ok(!built.established_effects.some(effect => effect.effect_kind === 'account_closure'));
    assert.ok(built.residual_unresolved_effects.some(residual =>
      residual.reason_code === 'ACCOUNT_CLOSURE_UNRESOLVED'));
  }
});

test('closure residual semantic identities must match their established closure', () => {
  const destination = providerPublicKey('v13-closure-binding-destination');
  const { value } = closureTransaction('v13-closure-binding', { destination });
  const alternateIdentity = providerPublicKey('v13-closure-binding-substitution');

  for (const mutate of [
    residual => { residual.mint = alternateIdentity; },
    residual => { residual.token_program = alternateIdentity; },
    residual => { residual.program_id = alternateIdentity; },
    residual => { residual.authority = alternateIdentity; },
    residual => { residual.destination = alternateIdentity; residual.account = alternateIdentity; },
    residual => { residual.accounts[0] = alternateIdentity; },
  ]) {
    const forged = structuredClone(project(value));
    const index = forged.residual_unresolved_effects.findIndex(
      residual => residual.reason_code === 'EXTERNAL_CLOSURE_RENT',
    );
    mutate(forged.residual_unresolved_effects[index]);
    forged.residual_unresolved_effects[index].residual_id = canonicalTransactionEffectRecordIdV13({
      transaction_identity: forged.transaction_identity,
      analyzed_wallet: forged.analyzed_wallet,
      record_kind: 'residual',
      record: forged.residual_unresolved_effects[index],
    });
    assert.throws(
      () => validateTransactionEffectStructureV13(forged),
      error => ['invalid_residual_shape', 'invalid_reconciliation_reference'].includes(error.code),
    );
  }
});

test('deduplicates repeated instruction references to one unknown-owner source account', () => {
  const value = transaction('v13-repeated-unknown-owner', {
    tokenRows: [{ label: 'unknown', mint: TARGET, owner: null, pre: '7', post: '7', decimals: 6 }],
    instructionAccounts: [],
  });
  const account = value.pre_token_balances[0].account;
  value.instructions[0].accounts = [account, account];

  const built = project(value);
  const residuals = built.residual_unresolved_effects.filter(residual =>
    residual.reason_code === 'UNKNOWN_TOKEN_OWNER'
    && residual.source_coordinate.coordinate_kind === 'instruction');
  assert.equal(residuals.length, 1);
  assert.deepEqual(residuals[0].accounts, [account, account]);
});

test('deduplicates repeated wallet-token references without losing source localization', () => {
  const value = transaction('v13-repeated-wallet-token', {
    tokenRows: [{ label: 'wallet-token', mint: TARGET, owner: WALLET, pre: '7', post: '7', decimals: 6 }],
    instructionAccounts: [],
  });
  const account = value.pre_token_balances[0].account;
  value.instructions[0].accounts = [account, account];

  const built = project(value);
  const residual = built.residual_unresolved_effects.find(item =>
    item.reason_code === 'UNMATCHED_WALLET_INSTRUCTION');
  assert.equal(residual.account, account);
  assert.equal(residual.owner, WALLET);
  assert.equal(residual.mint, TARGET);
  assert.equal(residual.token_program, TOKEN_PROGRAM);
});
