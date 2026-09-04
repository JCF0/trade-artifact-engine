import {
  assertExactFields, canonicalJson, cloneAndFreeze, fail,
} from './contract.mjs';
import {
  TRANSACTION_EFFECT_MODEL_PROFILE_V1_3,
  TRANSACTION_EFFECT_VERSION_V1_3,
  canonicalTransactionEffectRecordIdV13,
  compareTransactionEffectRecordsV13,
  validateTransactionEffectStructureV13,
} from './transaction-effect.mjs';
import { buildSolanaFullTransactionV1 } from '../wallet-acquisition/solana-full-transaction.mjs';
import { isSolanaPublicKeyV1 } from '../wallet-acquisition/solana-identities.mjs';

const INPUT_FIELDS = ['wallet', 'transaction'];
const VALIDATION_INPUT_FIELDS = ['wallet', 'transaction', 'effect'];
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const CLASSIC_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const CLASSIC_WHIRLPOOL_SWAP_DISCRIMINATOR = 'f8c69e91e17587c8';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function accountCoordinate(accountIndex) {
  return {
    coordinate_kind: 'account_balance', outer_instruction_index: null,
    inner_instruction_index: null, account_index: accountIndex,
  };
}
function instructionCoordinate(outerInstructionIndex, innerInstructionIndex) {
  return {
    coordinate_kind: 'instruction', outer_instruction_index: outerInstructionIndex,
    inner_instruction_index: innerInstructionIndex, account_index: null,
  };
}
const FEE_COORDINATE = Object.freeze({
  coordinate_kind: 'transaction_fee', outer_instruction_index: null,
  inner_instruction_index: null, account_index: null,
});
const TRANSACTION_COORDINATE = Object.freeze({
  coordinate_kind: 'transaction', outer_instruction_index: null,
  inner_instruction_index: null, account_index: null,
});
function direction(value) {
  if (value === 0n) return 'none';
  return value < 0n ? 'debit' : 'credit';
}
function signed(value) { return value.toString(); }

function decodeBase58(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const bytes = [0];
  for (const character of value) {
    let carry = BASE58_ALPHABET.indexOf(character);
    if (carry < 0) return null;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let index = 0; index < value.length - 1 && value[index] === '1'; index += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

function unsignedLittleEndian(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) + BigInt(bytes[index]);
  return value;
}

function baseEffect({ kind, coordinate, account, directionValue, raw = null, decimals = null, lamports = null }) {
  return {
    effect_id: null,
    canonical_order: null,
    effect_kind: kind,
    commitment: 'committed',
    evidence_role: ['token_balance_observation', 'native_balance_observation'].includes(kind)
      ? 'observation' : 'attributed_component',
    corroborating_effect_ids: [],
    economic_order: null,
    source_coordinate: coordinate,
    account,
    owner: null,
    authority: null,
    destination: null,
    mint: null,
    token_program: null,
    direction: directionValue,
    signed_raw_quantity: raw,
    decimals,
    signed_lamports: lamports,
  };
}

function instructionEntries(transaction) {
  const entries = transaction.instructions.map((instruction, outerInstructionIndex) => ({
    instruction,
    coordinate: instructionCoordinate(outerInstructionIndex, null),
    key: `${outerInstructionIndex}:top`,
  }));
  for (const group of transaction.inner_instruction_groups) {
    group.instructions.forEach((instruction, innerInstructionIndex) => entries.push({
      instruction,
      coordinate: instructionCoordinate(group.outer_instruction_index, innerInstructionIndex),
      key: `${group.outer_instruction_index}:${innerInstructionIndex}`,
    }));
  }
  return entries;
}

function tokenMaps(transaction) {
  return {
    pre: new Map(transaction.pre_token_balances.map(row => [row.account_index, row])),
    post: new Map(transaction.post_token_balances.map(row => [row.account_index, row])),
  };
}

function classicWhirlpoolSwapProjection(transaction, wallet) {
  const empty = { effects: [], consumed: new Set() };
  if (transaction.execution_state !== 'succeeded' || transaction.transaction_version !== 'legacy'
      || transaction.instructions.length !== 1 || transaction.inner_instruction_groups.length !== 1) return empty;
  const outer = transaction.instructions[0];
  const group = transaction.inner_instruction_groups[0];
  if (outer.instruction_index !== 0 || outer.program_id !== CLASSIC_WHIRLPOOL_PROGRAM
      || outer.accounts.length !== 11 || group.outer_instruction_index !== 0
      || group.instructions.length !== 2 || outer.accounts[0] !== CLASSIC_TOKEN_PROGRAM
      || outer.accounts[1] !== wallet) return empty;
  const data = decodeBase58(outer.data);
  if (data === null || data.length !== 42
      || Buffer.from(data.subarray(0, 8)).toString('hex') !== CLASSIC_WHIRLPOOL_SWAP_DISCRIMINATOR
      || data[40] !== 1 || ![0, 1].includes(data[41])) return empty;
  const inputAmount = unsignedLittleEndian(data.subarray(8, 16));
  const minimumOutput = unsignedLittleEndian(data.subarray(16, 24));
  const sqrtPriceLimit = unsignedLittleEndian(data.subarray(24, 40));
  if (inputAmount === 0n || sqrtPriceLimit === 0n) return empty;

  const accountRoles = new Map(transaction.accounts.map(account => [account.address, account]));
  if (accountRoles.size !== transaction.accounts.length) return empty;
  const role = (address, signer, writable) => {
    const value = accountRoles.get(address);
    return value !== undefined && value.is_signer === signer && value.is_writable === writable
      && value.source === 'static';
  };
  if (!role(outer.program_id, false, false) || !role(outer.accounts[0], false, false)
      || !role(outer.accounts[1], true, true) || !role(outer.accounts[2], false, true)
      || !outer.accounts.slice(3, 10).every(address => role(address, false, true))
      || !role(outer.accounts[10], false, false)) return empty;

  const aToB = data[41] === 1;
  const pool = outer.accounts[2];
  const inputWalletAccount = outer.accounts[aToB ? 3 : 5];
  const inputVault = outer.accounts[aToB ? 4 : 6];
  const outputWalletAccount = outer.accounts[aToB ? 5 : 3];
  const outputVault = outer.accounts[aToB ? 6 : 4];
  if (new Set([inputWalletAccount, inputVault, outputWalletAccount, outputVault]).size !== 4) return empty;
  const [inputTransfer, outputTransfer] = group.instructions;
  const transferAmount = instruction => {
    const bytes = decodeBase58(instruction.data);
    if (instruction.program_id !== CLASSIC_TOKEN_PROGRAM || instruction.accounts.length !== 3
        || bytes === null || bytes.length !== 9 || bytes[0] !== 3) return null;
    return unsignedLittleEndian(bytes.subarray(1));
  };
  const decodedInputAmount = transferAmount(inputTransfer);
  const outputAmount = transferAmount(outputTransfer);
  if (inputTransfer.instruction_index !== 0 || outputTransfer.instruction_index !== 1
      || decodedInputAmount !== inputAmount || outputAmount === null || outputAmount < minimumOutput
      || canonicalJson(inputTransfer.accounts) !== canonicalJson([inputWalletAccount, inputVault, wallet])
      || canonicalJson(outputTransfer.accounts) !== canonicalJson([outputVault, outputWalletAccount, pool])) return empty;

  const indexes = new Map(transaction.accounts.map((account, index) => [account.address, index]));
  const { pre, post } = tokenMaps(transaction);
  if (new Set([...pre.keys(), ...post.keys()]).size !== 4 || pre.size !== 4 || post.size !== 4) return empty;
  const pair = address => {
    const index = indexes.get(address);
    return index === undefined ? null : { before: pre.get(index), after: post.get(index) };
  };
  const inputWallet = pair(inputWalletAccount);
  const inputPool = pair(inputVault);
  const outputWallet = pair(outputWalletAccount);
  const outputPool = pair(outputVault);
  if ([inputWallet, inputPool, outputWallet, outputPool]
    .some(value => value?.before === undefined || value.after === undefined)) return empty;
  const sameIdentity = (left, right) => left.account === right.account && left.mint === right.mint
    && left.owner === right.owner && left.decimals === right.decimals
    && left.token_program === right.token_program;
  if (![inputWallet, inputPool, outputWallet, outputPool].every(value => sameIdentity(value.before, value.after))
      || inputWallet.before.owner !== wallet || outputWallet.before.owner !== wallet
      || inputPool.before.owner !== pool || outputPool.before.owner !== pool
      || inputWallet.before.token_program !== CLASSIC_TOKEN_PROGRAM
      || inputPool.before.token_program !== CLASSIC_TOKEN_PROGRAM
      || outputWallet.before.token_program !== CLASSIC_TOKEN_PROGRAM
      || outputPool.before.token_program !== CLASSIC_TOKEN_PROGRAM
      || inputWallet.before.mint !== inputPool.before.mint
      || outputWallet.before.mint !== outputPool.before.mint
      || inputWallet.before.mint === outputWallet.before.mint
      || inputWallet.before.decimals !== inputPool.before.decimals
      || outputWallet.before.decimals !== outputPool.before.decimals) return empty;
  const delta = value => BigInt(value.after.raw_amount) - BigInt(value.before.raw_amount);
  if (delta(inputWallet) !== -inputAmount || delta(inputPool) !== inputAmount
      || delta(outputWallet) !== outputAmount || delta(outputPool) !== -outputAmount) return empty;

  const transferEffect = (instruction, walletPair, amount) => ({
    ...baseEffect({
      kind: 'token_transfer',
      coordinate: instructionCoordinate(0, instruction.instruction_index),
      account: walletPair.before.account,
      directionValue: direction(amount),
      raw: signed(amount),
      decimals: walletPair.before.decimals,
    }),
    owner: wallet,
    authority: instruction.accounts[2],
    destination: instruction.accounts[1],
    mint: walletPair.before.mint,
    token_program: CLASSIC_TOKEN_PROGRAM,
  });
  return {
    effects: [
      transferEffect(inputTransfer, inputWallet, -inputAmount),
      transferEffect(outputTransfer, outputWallet, outputAmount),
    ],
    consumed: new Set(['0:top', '0:0', '0:1']),
  };
}

function isClassicWhirlpoolEnvelope(transaction) {
  if (transaction.instructions.length !== 1) return false;
  const outer = transaction.instructions[0];
  if (outer.program_id !== CLASSIC_WHIRLPOOL_PROGRAM) return false;
  const data = decodeBase58(outer.data);
  return data !== null
    && data.length === 42
    && Buffer.from(data.subarray(0, 8)).toString('hex') === CLASSIC_WHIRLPOOL_SWAP_DISCRIMINATOR;
}

function closureProjection(transaction, wallet, entries, addResidual) {
  if (transaction.execution_state !== 'succeeded') {
    return { effects: [], consumed: new Set(), provenPostZero: new Set() };
  }
  const { pre, post } = tokenMaps(transaction);
  const accountIndexes = new Map(transaction.accounts.map((account, index) => [account.address, index]));
  const accountRoles = new Map(transaction.accounts.map(account => [account.address, account]));
  const candidatesByAccount = new Map();
  for (const entry of entries) {
    const instruction = entry.instruction;
    if (!TOKEN_PROGRAMS.has(instruction.program_id) || instruction.data !== 'A') continue;
    const account = instruction.accounts[0] ?? null;
    if (account === null) {
      addResidual('ACCOUNT_CLOSURE_UNRESOLVED', entry.coordinate, {
        program_id: instruction.program_id, accounts: instruction.accounts,
      });
      continue;
    }
    const candidates = candidatesByAccount.get(account) ?? [];
    candidates.push(entry);
    candidatesByAccount.set(account, candidates);
  }

  const effects = [];
  const consumed = new Set();
  const provenPostZero = new Set();
  for (const [account, candidates] of candidatesByAccount) {
    if (candidates.length !== 1) {
      for (const entry of candidates) {
        const [closedAccount, destination, authority] = entry.instruction.accounts;
        const accountIndex = accountIndexes.get(closedAccount);
        const before = pre.get(accountIndex);
        addResidual('ACCOUNT_CLOSURE_UNRESOLVED', entry.coordinate, {
          program_id: entry.instruction.program_id,
          accounts: entry.instruction.accounts,
          account: closedAccount ?? null,
          owner: before?.owner ?? null,
          authority: authority ?? null,
          destination: destination ?? null,
          mint: before?.mint ?? null,
          token_program: before?.token_program ?? null,
        });
      }
      continue;
    }
    const entry = candidates[0];
    const instruction = entry.instruction;
    const [closedAccount, destination, authority] = instruction.accounts;
    const accountIndex = accountIndexes.get(closedAccount);
    const destinationIndex = accountIndexes.get(destination);
    const before = pre.get(accountIndex);
    const after = post.get(accountIndex);
    const destinationIdentity = pre.get(destinationIndex) ?? post.get(destinationIndex);
    const destinationOwnedByWallet = destination === wallet || destinationIdentity?.owner === wallet;
    const destinationKnownExternal = destination !== wallet
      && (destinationIdentity === undefined
        ? accountRoles.get(destination)?.is_signer === true
        : destinationIdentity.owner !== null && destinationIdentity.owner !== wallet);
    const rolesEstablished = instruction.accounts.length === 3
      && accountRoles.has(instruction.program_id)
      && accountRoles.get(closedAccount)?.is_writable === true
      && accountRoles.get(destination)?.is_writable === true
      && accountRoles.get(authority)?.is_signer === true;
    const conclusivelyExternal = rolesEstablished
      && accountIndex !== undefined && destinationIndex !== undefined
      && before !== undefined && before.owner !== null && before.owner !== wallet
      && before.raw_amount === '0'
      && authority !== wallet && destinationKnownExternal && !destinationOwnedByWallet;
    if (conclusivelyExternal) {
      const externalDrain = BigInt(transaction.pre_lamport_balances[accountIndex])
        - BigInt(transaction.post_lamport_balances[accountIndex]);
      const externalIncrease = BigInt(transaction.post_lamport_balances[destinationIndex])
        - BigInt(transaction.pre_lamport_balances[destinationIndex]);
      const feeAdjustment = destination === transaction.fee_payer
        ? BigInt(transaction.fee_lamports) : 0n;
      const coherentExternal = before.token_program === instruction.program_id
        && (after === undefined || after.raw_amount === '0')
        && closedAccount !== destination
        && transaction.post_lamport_balances[accountIndex] === 0
        && externalDrain >= 0n
        && externalIncrease + feeAdjustment === externalDrain;
      if (coherentExternal) {
        consumed.add(entry.key);
        if (after === undefined) provenPostZero.add(accountIndex);
        continue;
      }
    }
    const identitiesPresent = rolesEstablished
      && accountIndex !== undefined && destinationIndex !== undefined
      && before !== undefined && before.owner === wallet
      && before.raw_amount === '0'
      && before.token_program === instruction.program_id
      && (after === undefined || after.raw_amount === '0')
      && closedAccount !== destination;
    let rent = null;
    let destinationIncrease = null;
    let closureEstablished = false;
    let amountEstablished = false;
    if (identitiesPresent) {
      rent = BigInt(transaction.pre_lamport_balances[accountIndex])
        - BigInt(transaction.post_lamport_balances[accountIndex]);
      destinationIncrease = BigInt(transaction.post_lamport_balances[destinationIndex])
        - BigInt(transaction.pre_lamport_balances[destinationIndex]);
      const feeAdjustment = destination === transaction.fee_payer
        ? BigInt(transaction.fee_lamports) : 0n;
      closureEstablished = transaction.post_lamport_balances[accountIndex] === 0;
      const amountExclusive = entries.every(other => other.key === entry.key
        || (!other.instruction.accounts.includes(closedAccount)
          && !other.instruction.accounts.includes(destination)));
      amountEstablished = closureEstablished && amountExclusive
        && rent >= 0n && destinationIncrease + feeAdjustment === rent;
    }
    if (!closureEstablished) {
      addResidual('ACCOUNT_CLOSURE_UNRESOLVED', entry.coordinate, {
        program_id: instruction.program_id,
        accounts: instruction.accounts,
        account: closedAccount ?? null,
        owner: before?.owner ?? null,
        authority: authority ?? null,
        destination: destination ?? null,
        mint: before?.mint ?? null,
        token_program: before?.token_program ?? null,
        observed_signed_lamports: rent === null ? null : signed(-rent),
      });
      continue;
    }
    effects.push({
      ...baseEffect({
        kind: 'account_closure', coordinate: entry.coordinate, account: closedAccount,
        directionValue: 'none', lamports: amountEstablished ? signed(-rent) : null,
      }),
      owner: wallet,
      authority,
      destination,
      mint: before.mint,
      token_program: before.token_program,
    });
    consumed.add(entry.key);
    if (after === undefined) provenPostZero.add(accountIndex);
    if (!amountEstablished) addResidual('ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED', entry.coordinate, {
      program_id: instruction.program_id,
      accounts: instruction.accounts,
      account: closedAccount,
      owner: wallet,
      authority,
      destination,
      mint: before.mint,
      token_program: before.token_program,
      observed_signed_lamports: rent === null ? null : signed(-rent),
    });
    if (amountEstablished && destination !== wallet && rent > 0n) addResidual('EXTERNAL_CLOSURE_RENT', entry.coordinate, {
      program_id: instruction.program_id,
      accounts: instruction.accounts,
      account: destination,
      owner: null,
      authority,
      destination,
      mint: before.mint,
      token_program: before.token_program,
      observed_signed_lamports: signed(destinationIncrease),
    });
  }
  return { effects, consumed, provenPostZero };
}

function finalizeProjection(projection) {
  const effects = projection.established_effects;
  const observations = effects.filter(effect => effect.evidence_role === 'observation');
  for (const observation of observations) {
    observation.effect_id = canonicalTransactionEffectRecordIdV13({
      transaction_identity: projection.transaction_identity,
      analyzed_wallet: projection.analyzed_wallet,
      record_kind: 'effect', record: observation,
    });
  }
  const nativeObservationByAccount = new Map(observations
    .filter(effect => effect.effect_kind === 'native_balance_observation')
    .map(effect => [effect.account, effect.effect_id]));
  const tokenObservationByAccount = new Map(observations
    .filter(effect => effect.effect_kind === 'token_balance_observation')
    .map(effect => [effect.account, effect.effect_id]));
  for (const effect of effects) {
    if (effect.evidence_role !== 'attributed_component') continue;
    const references = [];
    if (effect.effect_kind === 'network_fee') {
      if (nativeObservationByAccount.has(effect.account)) references.push(nativeObservationByAccount.get(effect.account));
    } else if (effect.effect_kind === 'token_transfer') {
      if (tokenObservationByAccount.has(effect.account)) references.push(tokenObservationByAccount.get(effect.account));
    } else if (['account_creation', 'account_closure'].includes(effect.effect_kind)) {
      if (nativeObservationByAccount.has(effect.account)) references.push(nativeObservationByAccount.get(effect.account));
      if (effect.destination !== null && nativeObservationByAccount.has(effect.destination)) references.push(nativeObservationByAccount.get(effect.destination));
    }
    effect.corroborating_effect_ids = [...new Set(references)].sort();
    effect.effect_id = canonicalTransactionEffectRecordIdV13({
      transaction_identity: projection.transaction_identity,
      analyzed_wallet: projection.analyzed_wallet,
      record_kind: 'effect', record: effect,
    });
  }
  effects.sort((left, right) => compareTransactionEffectRecordsV13(left, right, 'effect'));
  effects.forEach((effect, index) => { effect.canonical_order = index; });

  const closureByCoordinate = new Map(effects
    .filter(effect => effect.effect_kind === 'account_closure')
    .map(effect => [`${effect.source_coordinate.outer_instruction_index}:${effect.source_coordinate.inner_instruction_index}`, effect.effect_id]));
  const feeEffect = effects.find(effect => effect.effect_kind === 'network_fee');
  for (const residual of projection.residual_unresolved_effects) {
    if (['ACCOUNT_CLOSURE_AMOUNT_UNRESOLVED', 'EXTERNAL_CLOSURE_RENT'].includes(residual.reason_code)) {
      const key = `${residual.source_coordinate.outer_instruction_index}:${residual.source_coordinate.inner_instruction_index}`;
      const closureId = closureByCoordinate.get(key);
      if (closureId !== undefined) residual.related_effect_ids = [
        closureId,
        ...(residual.reason_code === 'EXTERNAL_CLOSURE_RENT'
          && residual.account === projection.fee_payer ? [feeEffect.effect_id] : []),
      ].sort();
    }
  }
  const residuals = projection.residual_unresolved_effects;
  residuals.sort((left, right) => compareTransactionEffectRecordsV13(left, right, 'residual'));
  residuals.forEach((residual, index) => {
    residual.canonical_order = index;
    residual.residual_id = canonicalTransactionEffectRecordIdV13({
      transaction_identity: projection.transaction_identity,
      analyzed_wallet: projection.analyzed_wallet,
      record_kind: 'residual', record: residual,
    });
  });
  validateTransactionEffectStructureV13(projection);
  return cloneAndFreeze(projection);
}

export function projectSolanaFullTransactionEffectV13(input) {
  assertExactFields(input, INPUT_FIELDS, 'transaction_effect_projector_input');
  if (!isSolanaPublicKeyV1(input.wallet)) throw new TypeError('transaction effect wallet is invalid');
  const transaction = buildSolanaFullTransactionV1(input.transaction);
  const wallet = input.wallet;
  const established = [];
  const residuals = [];
  const addResidual = (reason, coordinate, values = {}) => {
    residuals.push({
      residual_id: null,
      canonical_order: null,
      reason_code: reason,
      source_coordinate: coordinate,
      program_id: null,
      accounts: [],
      account: null,
      owner: null,
      authority: null,
      destination: null,
      mint: null,
      token_program: null,
      observed_signed_raw_quantity: null,
      observed_signed_lamports: null,
      missing_balance_side: null,
      related_effect_ids: [],
      ...values,
    });
  };

  const fee = BigInt(transaction.fee_lamports);
  established.push(baseEffect({
    kind: 'network_fee', coordinate: FEE_COORDINATE,
    account: transaction.fee_payer, directionValue: direction(-fee), lamports: signed(-fee),
  }));

  const entries = instructionEntries(transaction);
  const closure = closureProjection(transaction, wallet, entries, addResidual);
  established.push(...closure.effects);
  const classicWhirlpoolEnvelope = isClassicWhirlpoolEnvelope(transaction);
  const whirlpool = classicWhirlpoolSwapProjection(transaction, wallet);
  established.push(...whirlpool.effects);

  const { pre, post } = tokenMaps(transaction);
  const tokenIndexes = [...new Set([...pre.keys(), ...post.keys()])].sort((left, right) => left - right);
  const walletOwnedTokenIndexes = new Set();
  const unknownTokenIdentityByAccount = new Map();
  for (const accountIndex of tokenIndexes) {
    const before = pre.get(accountIndex);
    const after = post.get(accountIndex);
    const identity = before ?? after;
    const missingSide = before === undefined ? 'pre' : after === undefined ? 'post' : null;
    if (identity.owner === wallet) walletOwnedTokenIndexes.add(accountIndex);
    if (identity.owner === null) unknownTokenIdentityByAccount.set(identity.account, identity);
    const nativeDelta = BigInt(transaction.post_lamport_balances[accountIndex])
      - BigInt(transaction.pre_lamport_balances[accountIndex]);
    if (missingSide !== null && !(missingSide === 'post' && closure.provenPostZero.has(accountIndex))) {
      addResidual('TOKEN_BALANCE_SIDE_MISSING', accountCoordinate(accountIndex), {
        account: identity.account, owner: identity.owner, mint: identity.mint,
        token_program: identity.token_program, missing_balance_side: missingSide,
      });
      if (identity.owner === null && nativeDelta !== 0n) addResidual('UNKNOWN_TOKEN_OWNER', accountCoordinate(accountIndex), {
        account: identity.account, mint: identity.mint, token_program: identity.token_program,
        observed_signed_lamports: signed(nativeDelta),
      });
      continue;
    }
    const beforeAmount = before === undefined ? 0n : BigInt(before.raw_amount);
    const afterAmount = after === undefined ? 0n : BigInt(after.raw_amount);
    const delta = afterAmount - beforeAmount;
    if (transaction.execution_state === 'failed' && delta !== 0n) {
      addResidual('FAILED_TOKEN_BALANCE_OBSERVATION', accountCoordinate(accountIndex), {
        account: identity.account, owner: identity.owner, mint: identity.mint,
        token_program: identity.token_program, observed_signed_raw_quantity: signed(delta),
      });
    } else if (identity.owner === null && (delta !== 0n || nativeDelta !== 0n)) {
      addResidual('UNKNOWN_TOKEN_OWNER', accountCoordinate(accountIndex), {
        account: identity.account, mint: identity.mint, token_program: identity.token_program,
        observed_signed_raw_quantity: delta === 0n ? null : signed(delta),
        observed_signed_lamports: nativeDelta === 0n ? null : signed(nativeDelta),
      });
    } else if (transaction.execution_state === 'succeeded' && identity.owner === wallet && delta !== 0n) {
      established.push({
        ...baseEffect({
          kind: 'token_balance_observation', coordinate: accountCoordinate(accountIndex),
          account: identity.account, directionValue: direction(delta), raw: signed(delta), decimals: identity.decimals,
        }),
        owner: wallet,
        mint: identity.mint,
        token_program: identity.token_program,
      });
    }
  }

  const walletIndexes = transaction.accounts
    .map((account, index) => (account.address === wallet ? index : null))
    .filter(index => index !== null);
  if (walletIndexes.length !== 1) addResidual('WALLET_ACCOUNT_EVIDENCE_MISSING', TRANSACTION_COORDINATE);
  const nativeObservationIndexes = [...new Set([...walletIndexes, ...walletOwnedTokenIndexes])].sort((left, right) => left - right);
  for (const accountIndex of nativeObservationIndexes) {
    const delta = BigInt(transaction.post_lamport_balances[accountIndex])
      - BigInt(transaction.pre_lamport_balances[accountIndex]);
    if (delta === 0n) continue;
    established.push(baseEffect({
      kind: 'native_balance_observation', coordinate: accountCoordinate(accountIndex),
      account: transaction.accounts[accountIndex].address,
      directionValue: direction(delta), lamports: signed(delta),
    }));
  }

  const preLamports = transaction.pre_lamport_balances.reduce((sum, value) => sum + BigInt(value), 0n);
  const postLamports = transaction.post_lamport_balances.reduce((sum, value) => sum + BigInt(value), 0n);
  const lamportResidual = postLamports - preLamports + fee;
  if (lamportResidual !== 0n) addResidual('NATIVE_BALANCE_RECONCILIATION', TRANSACTION_COORDINATE, {
    observed_signed_lamports: signed(lamportResidual),
  });

  const tokenIdentityByAccount = new Map();
  for (const row of [...transaction.pre_token_balances, ...transaction.post_token_balances]) {
    if (row.owner === wallet) tokenIdentityByAccount.set(row.account, row);
  }
  for (const entry of entries) {
    if (closure.consumed.has(entry.key) || whirlpool.consumed.has(entry.key)) continue;
    const touchedUnknownRows = [...new Map(entry.instruction.accounts
      .map(account => unknownTokenIdentityByAccount.get(account)).filter(Boolean)
      .map(row => [row.account, row])).values()];
    for (const row of touchedUnknownRows) addResidual('UNKNOWN_TOKEN_OWNER', entry.coordinate, {
      program_id: entry.instruction.program_id,
      accounts: entry.instruction.accounts,
      account: row.account,
      owner: null,
      mint: row.mint,
      token_program: row.token_program,
    });
    const touchesWallet = entry.instruction.accounts.includes(wallet);
    const touchedTokenRows = [...new Map(entry.instruction.accounts
      .map(account => tokenIdentityByAccount.get(account)).filter(Boolean)
      .map(row => [row.account, row])).values()];
    if (!touchesWallet && touchedTokenRows.length === 0 && !classicWhirlpoolEnvelope) continue;
    const exactRow = touchedTokenRows.length === 1 ? touchedTokenRows[0] : null;
    addResidual('UNMATCHED_WALLET_INSTRUCTION', entry.coordinate, {
      program_id: entry.instruction.program_id,
      accounts: entry.instruction.accounts,
      account: exactRow?.account ?? (touchesWallet ? wallet : null),
      owner: exactRow?.owner ?? null,
      mint: exactRow?.mint ?? null,
      token_program: exactRow?.token_program ?? null,
    });
  }

  return finalizeProjection({
    transaction_effect_version: TRANSACTION_EFFECT_VERSION_V1_3,
    effect_model_profile: TRANSACTION_EFFECT_MODEL_PROFILE_V1_3,
    transaction_identity: {
      signature: transaction.signature,
      slot: transaction.slot,
      block_time: transaction.block_time,
      transaction_version: transaction.transaction_version,
    },
    finalized_execution_status: transaction.execution_state,
    analyzed_wallet: wallet,
    fee_payer: transaction.fee_payer,
    fee_lamports: String(transaction.fee_lamports),
    economic_order_status: 'UNESTABLISHED',
    established_effects: established,
    residual_unresolved_effects: residuals,
  });
}

export function validateSolanaFullTransactionEffectV13(input) {
  assertExactFields(input, VALIDATION_INPUT_FIELDS, 'transaction_effect_authority_input');
  validateTransactionEffectStructureV13(input.effect);
  const expected = projectSolanaFullTransactionEffectV13({ wallet: input.wallet, transaction: input.transaction });
  if (canonicalJson(input.effect) !== canonicalJson(expected)) {
    fail('transaction_effect_source_mismatch', 'transaction effect does not match its admitted source transaction and wallet');
  }
  return true;
}