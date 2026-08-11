import { SOL_MINT, USDC_MINT, USDT_MINT } from '../pipeline/constants.mjs';
import { buildSolanaFullTransactionV1 } from './solana-full-transaction.mjs';
import { isSolanaPublicKeyV1 } from './solana-identities.mjs';
import { buildSolanaSpotEvidenceV1, isRecognizedSpotProgramV1 } from './solana-spot-evidence.mjs';
import { detachProviderNeutralValueV1, failWalletAcquisitionOperationV1 } from './provider-port.mjs';

const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function rejectProjection() {
  failWalletAcquisitionOperationV1('malformed_provider_response', 'full_transaction_projection_internal_rejection');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactProjectorInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) rejectProjection();
  const keys = Object.keys(input);
  if (keys.length !== 2 || !Object.hasOwn(input, 'wallet') || !Object.hasOwn(input, 'transaction')
      || keys.some(key => !['wallet','transaction'].includes(key)) || !isSolanaPublicKeyV1(input.wallet)) rejectProjection();
}

function tokenRowsByIndex(rows) {
  return new Map(rows.map(row => [row.account_index, row]));
}

function tokenRowsByAccount(rows) {
  return new Map(rows.map(row => [row.account, row]));
}

function instructionEntries(transaction) {
  const entries = transaction.instructions.map((instruction, index) => ({
    key: `top-${index}`,
    instruction,
    outerProgram: null,
  }));
  for (const group of transaction.inner_instruction_groups) {
    const outerProgram = transaction.instructions[group.outer_instruction_index].program_id;
    group.instructions.forEach((instruction, index) => entries.push({
      key: `inner-${group.outer_instruction_index}-${index}`,
      instruction,
      outerProgram,
    }));
  }
  return entries;
}

function closureMintScope(closedAccount, preByAccount, postByAccount, wallet) {
  const before = preByAccount.get(closedAccount);
  const after = postByAccount.get(closedAccount);
  const rows = [before, after].filter(Boolean);
  if (rows.length === 0 || rows.some(row => row.owner !== wallet)) return null;
  return new Set(rows.map(row => row.mint)).size === 1 ? rows[0].mint : null;
}

function unresolvedClosureMint(mint) {
  return mint !== null && QUOTE_MINTS.has(mint) ? null : mint;
}

function closureEvidence(transaction, wallet) {
  const preByAccount = tokenRowsByAccount(transaction.pre_token_balances);
  const postByAccount = tokenRowsByAccount(transaction.post_token_balances);
  const accountIndexes = new Map(transaction.accounts.map((account, index) => [account.address, index]));
  const candidates = new Map();
  const consumedInstructionKeys = new Set();
  const unresolved = [];
  const boundAccountIndexes = new Set();

  for (const { key, instruction } of instructionEntries(transaction)) {
    if (!TOKEN_PROGRAMS.has(instruction.program_id) || instruction.data !== 'A') continue;
    consumedInstructionKeys.add(key);
    const closedAccount = instruction.accounts[0] ?? null;
    const mint = closedAccount === null ? null : closureMintScope(closedAccount, preByAccount, postByAccount, wallet);
    if (closedAccount !== null && mint !== null) boundAccountIndexes.add(accountIndexes.get(closedAccount));
    if (instruction.accounts.length !== 3) {
      unresolved.push({ mint: instruction.accounts.length >= 2 ? unresolvedClosureMint(mint) : null });
      continue;
    }
    const [account, destination, authority] = instruction.accounts;
    const externalBefore = preByAccount.get(account);
    if (externalBefore !== undefined && externalBefore.owner !== null && externalBefore.owner !== wallet
        && authority === externalBefore.owner && destination !== wallet && authority !== wallet) {
      const externalAfter = postByAccount.get(account);
      const accountIndex = accountIndexes.get(account);
      const destinationIndex = accountIndexes.get(destination);
      const decrease = BigInt(transaction.pre_lamport_balances[accountIndex])
        - BigInt(transaction.post_lamport_balances[accountIndex]);
      const destinationIncrease = BigInt(transaction.post_lamport_balances[destinationIndex])
        - BigInt(transaction.pre_lamport_balances[destinationIndex]);
      const coherentExternalClosure = externalBefore.token_program === instruction.program_id
        && (externalAfter === undefined || externalAfter.raw_amount === '0')
        && account !== destination
        && transaction.post_lamport_balances[accountIndex] === 0
        && decrease >= 0n
        && destinationIncrease === decrease;
      if (!coherentExternalClosure) unresolved.push({ mint: null });
      continue;
    }
    const values = candidates.get(account) ?? [];
    values.push({ account, destination, authority, programId: instruction.program_id, mint });
    candidates.set(account, values);
  }

  const provisionallyValid = [];
  for (const account of [...candidates.keys()].sort(compareCodeUnits)) {
    const values = candidates.get(account);
    const mint = closureMintScope(account, preByAccount, postByAccount, wallet);
    if (values.length !== 1) {
      const destinations = new Set(values.map(value => value.destination));
      unresolved.push({ mint: destinations.size === 1 ? unresolvedClosureMint(mint) : null });
      continue;
    }
    const candidate = values[0];
    const before = preByAccount.get(account);
    const after = postByAccount.get(account);
    const accountIndex = accountIndexes.get(account);
    const destinationIndex = accountIndexes.get(candidate.destination);
    const identityBound = before !== undefined
      && before.owner === wallet
      && before.token_program === candidate.programId
      && (after === undefined || after.raw_amount === '0');
    const authorityBound = candidate.authority === wallet;
    const endpointsDistinct = candidate.destination !== account;
    const decrease = BigInt(transaction.pre_lamport_balances[accountIndex])
      - BigInt(transaction.post_lamport_balances[accountIndex]);
    const closedLamportsDrained = transaction.post_lamport_balances[accountIndex] === 0;
    if (!identityBound || !authorityBound || !endpointsDistinct || !closedLamportsDrained || decrease < 0n) {
      unresolved.push({ mint: unresolvedClosureMint(identityBound ? before.mint : mint) });
      continue;
    }
    boundAccountIndexes.add(accountIndex);
    provisionallyValid.push({
      account,
      destination: candidate.destination,
      destinationIndex,
      mint: before.mint,
      rentLamports: decrease,
    });
  }

  const destinationGroups = new Map();
  for (const closure of provisionallyValid) {
    const values = destinationGroups.get(closure.destination) ?? [];
    values.push(closure);
    destinationGroups.set(closure.destination, values);
  }
  const valid = [];
  let returnedRentLamports = 0n;
  for (const [destination, closures] of destinationGroups) {
    const expectedIncrease = closures.reduce((sum, closure) => sum + closure.rentLamports, 0n);
    const observedIncrease = BigInt(transaction.post_lamport_balances[closures[0].destinationIndex])
      - BigInt(transaction.pre_lamport_balances[closures[0].destinationIndex]);
    const feeAdjustment = destination === wallet && transaction.fee_payer === wallet
      ? BigInt(transaction.fee_lamports)
      : 0n;
    const destinationReconciled = destination === wallet
      ? observedIncrease + feeAdjustment === expectedIncrease
      : observedIncrease === expectedIncrease;
    if (!destinationReconciled) {
      unresolved.push(...closures.map(closure => ({
        mint: destination === wallet ? null : unresolvedClosureMint(closure.mint),
      })));
      continue;
    }
    valid.push(...closures);
    if (destination === wallet) returnedRentLamports += expectedIncrease;
    else if (expectedIncrease > 0n) unresolved.push(...closures.map(closure => ({ mint: closure.mint })));
  }

  return {
    closures: valid
      .sort((left, right) => compareCodeUnits(left.account, right.account))
      .map((closure, index) => ({ closure_id: `account-close-${index}`, owner: wallet, mint: closure.mint })),
    unresolved,
    boundAccountIndexes,
    consumedInstructionKeys,
    returnedRentLamports,
  };
}

function recognizedPrograms(transaction) {
  const found = new Set();
  const inspect = instructions => {
    for (const instruction of instructions) {
      if (isRecognizedSpotProgramV1(instruction.program_id)) found.add(instruction.program_id);
    }
  };
  inspect(transaction.instructions);
  for (const group of transaction.inner_instruction_groups) inspect(group.instructions);
  return [...found].sort(compareCodeUnits).map(program_id => ({ program_id }));
}

function tokenDeltas(transaction, wallet) {
  const pre = tokenRowsByIndex(transaction.pre_token_balances);
  const post = tokenRowsByIndex(transaction.post_token_balances);
  const indexes = [...new Set([...pre.keys(), ...post.keys()])].sort((left, right) => left - right);
  const legs = [];
  const unresolved = [];
  const walletOwnedAccountIndexes = [];
  for (const accountIndex of indexes) {
    const before = pre.get(accountIndex);
    const after = post.get(accountIndex);
    const identity = before ?? after;
    const delta = BigInt(after?.raw_amount ?? '0') - BigInt(before?.raw_amount ?? '0');
    if (identity.owner === null) {
      if (delta !== 0n) unresolved.push({ mint: identity.mint });
      continue;
    }
    if (identity.owner !== wallet) continue;
    walletOwnedAccountIndexes.push(accountIndex);
    if (delta === 0n) continue;
    const magnitude = delta < 0n ? -delta : delta;
    legs.push({
      account_index: accountIndex,
      leg_id: `token-account-${String(accountIndex).padStart(6, '0')}`,
      economic_group: null,
      direction: delta < 0n ? 'debit' : 'credit',
      owner: wallet,
      mint: identity.mint,
      raw_amount: String(magnitude),
      decimals: identity.decimals,
    });
  }
  return { legs, unresolved, walletOwnedAccountIndexes };
}

function unresolvedNativeEvidence(transaction, wallet, walletOwnedAccountIndexes, boundClosureAccountIndexes) {
  const unresolved = [];
  for (const accountIndex of walletOwnedAccountIndexes) {
    if (boundClosureAccountIndexes.has(accountIndex)) continue;
    const delta = BigInt(transaction.post_lamport_balances[accountIndex])
      - BigInt(transaction.pre_lamport_balances[accountIndex]);
    if (delta === 0n) continue;
    const row = transaction.pre_token_balances.find(item => item.account_index === accountIndex)
      ?? transaction.post_token_balances.find(item => item.account_index === accountIndex);
    unresolved.push({ mint: row?.mint ?? null });
  }
  const walletIndexes = [];
  transaction.accounts.forEach((account, index) => { if (account.address === wallet) walletIndexes.push(index); });
  if (walletIndexes.length !== 1) unresolved.push({ mint: null });
  return { unresolved, walletIndex: walletIndexes.length === 1 ? walletIndexes[0] : null };
}

function unresolvedBalanceEquation(transaction) {
  const pre = transaction.pre_lamport_balances.reduce((sum, value) => sum + BigInt(value), 0n);
  const post = transaction.post_lamport_balances.reduce((sum, value) => sum + BigInt(value), 0n);
  return post - pre + BigInt(transaction.fee_lamports) === 0n ? [] : [{ mint: null }];
}

function unresolvedWalletInstructions(transaction, wallet, consumedClosureInstructionKeys) {
  const walletTokenMints = new Map();
  for (const row of [...transaction.pre_token_balances, ...transaction.post_token_balances]) {
    if (row.owner === wallet) walletTokenMints.set(row.account, row.mint);
  }
  const effectsFor = instruction => {
    if (isRecognizedSpotProgramV1(instruction.program_id)) return [];
    if (instruction.accounts.includes(wallet)) return [{ mint: null }];
    return [...new Set(instruction.accounts.map(account => walletTokenMints.get(account)).filter(Boolean))]
      .sort(compareCodeUnits).map(mint => ({ mint }));
  };
  const unresolved = [];
  for (const { key, instruction, outerProgram } of instructionEntries(transaction)) {
    if (consumedClosureInstructionKeys.has(key)) continue;
    const tokenLegBoundToSpotOuter = outerProgram !== null
      && TOKEN_PROGRAMS.has(instruction.program_id)
      && isRecognizedSpotProgramV1(outerProgram);
    if (!tokenLegBoundToSpotOuter) unresolved.push(...effectsFor(instruction));
  }
  return unresolved;
}

function nativeDeltaLeg(transaction, wallet, walletIndex, returnedRentLamports, unresolved) {
  if (walletIndex === null) return null;
  let economicDelta = BigInt(transaction.post_lamport_balances[walletIndex])
    - BigInt(transaction.pre_lamport_balances[walletIndex]);
  if (transaction.fee_payer === wallet) economicDelta += BigInt(transaction.fee_lamports);
  economicDelta -= returnedRentLamports;
  if (economicDelta === 0n) return null;
  const magnitude = economicDelta < 0n ? -economicDelta : economicDelta;
  if (magnitude > MAX_SAFE_BIGINT) {
    unresolved.push({ mint: null });
    return null;
  }
  return {
    leg_id: `native-wallet-${String(walletIndex).padStart(6, '0')}`,
    economic_group: null,
    direction: economicDelta < 0n ? 'debit' : 'credit',
    owner: wallet,
    amount_lamports: Number(magnitude),
  };
}

function hasExactSupportedShape(tokenLegs, nativeLegs) {
  const operations = [
    ...tokenLegs.map(leg => ({ direction: leg.direction, mint: leg.mint, decimals: leg.decimals })),
    ...nativeLegs.map(leg => ({ direction: leg.direction, mint: SOL_MINT, decimals: 9 })),
  ];
  if (operations.length < 2) return false;
  const debits = operations.filter(operation => operation.direction === 'debit');
  const credits = operations.filter(operation => operation.direction === 'credit');
  if (debits.length === 0 || credits.length !== 1 || debits.length + credits.length !== operations.length) return false;
  if (new Set(debits.map(operation => operation.mint)).size !== 1
      || new Set(debits.map(operation => operation.decimals)).size !== 1) return false;
  const sideMints = [debits[0].mint, credits[0].mint];
  return sideMints[0] !== sideMints[1]
    && sideMints.filter(mint => QUOTE_MINTS.has(mint)).length === 1;
}

function numberUnresolvedEffects(values) {
  return values
    .sort((left, right) => compareCodeUnits(left.mint ?? '', right.mint ?? ''))
    .map((effect, index) => ({ effect_id: `full-transaction-unresolved-${index}`, mint: effect.mint }));
}

export function projectSolanaFullTransactionV1(input) {
  try {
    const detached = detachProviderNeutralValueV1(input);
    exactProjectorInput(detached);
    const transaction = buildSolanaFullTransactionV1(detached.transaction);
    const programs = recognizedPrograms(transaction);

    let tokenLegs = [];
    let nativeLegs = [];
    let unresolved = [];
    let closures = [];
    if (transaction.execution_state === 'succeeded') {
      const tokens = tokenDeltas(transaction, detached.wallet);
      tokenLegs = tokens.legs;
      const closure = closureEvidence(transaction, detached.wallet);
      closures = closure.closures;
      const native = unresolvedNativeEvidence(
        transaction,
        detached.wallet,
        tokens.walletOwnedAccountIndexes,
        closure.boundAccountIndexes,
      );
      unresolved = [
        ...tokens.unresolved,
        ...native.unresolved,
        ...unresolvedBalanceEquation(transaction),
        ...unresolvedWalletInstructions(transaction, detached.wallet, closure.consumedInstructionKeys),
        ...closure.unresolved,
      ];
      const nativeLeg = nativeDeltaLeg(
        transaction,
        detached.wallet,
        native.walletIndex,
        closure.returnedRentLamports,
        unresolved,
      );
      if (nativeLeg !== null) nativeLegs.push(nativeLeg);

      const groupable = unresolved.length === 0
        && transaction.fee_payer === detached.wallet
        && programs.length === 1
        && hasExactSupportedShape(tokenLegs, nativeLegs);
      if (groupable) {
        tokenLegs = tokenLegs.map(leg => ({ ...leg, economic_group: 'swap-0' }));
        nativeLegs = nativeLegs.map(leg => ({ ...leg, economic_group: 'swap-0' }));
      }
    }

    return buildSolanaSpotEvidenceV1({
      spot_evidence_version: 'solana_spot_evidence_v1',
      signature: transaction.signature,
      slot: transaction.slot,
      block_time: transaction.block_time,
      execution_state: transaction.execution_state,
      wallet: detached.wallet,
      fee_payer: transaction.fee_payer,
      provider_transaction_type: null,
      recognized_programs: programs,
      structured_swap_groups: [],
      token_transfer_legs: tokenLegs.map(({ account_index: _accountIndex, ...leg }) => leg),
      native_sol_transfer_legs: nativeLegs,
      account_closures: closures,
      unresolved_wallet_effects: numberUnresolvedEffects(unresolved),
    });
  } catch (error) {
    if (error?.name === 'WalletAcquisitionError') throw error;
    failWalletAcquisitionOperationV1('malformed_provider_response', 'full_transaction_projection_internal_rejection');
  }
}
