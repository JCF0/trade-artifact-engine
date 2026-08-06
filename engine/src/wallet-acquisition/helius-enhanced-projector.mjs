import { assertPlainDataV1 } from './errors.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './helius-rpc-validator.mjs';
import { buildSolanaSpotEvidenceV1, isRecognizedSpotProgramV1 } from './solana-spot-evidence.mjs';
import { failWalletAcquisitionOperationV1 } from './provider-port.mjs';

function malformed() { failWalletAcquisitionOperationV1('malformed_provider_response'); }
function safeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function raw(value, { allowZero = false } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed();
  const amount = value.tokenAmount;
  const decimals = value.decimals;
  if (typeof amount !== 'string' || !(allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(amount)
      || !safeInteger(decimals) || decimals > 255) malformed();
  return { raw_amount: amount, decimals };
}
function array(value) { if (!Array.isArray(value)) malformed(); return value; }
function walletLegOwner(value, wallet) { if (value !== wallet) malformed(); return value; }

function tokenSwapLeg(value, wallet, id) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !isSolanaPublicKeyV1(value.mint)) malformed();
  const amount = raw(value.rawTokenAmount);
  return { leg_id: id, owner: walletLegOwner(value.userAccount, wallet), mint: value.mint, ...amount };
}
function nativeSwapLeg(value, wallet, id) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !safeInteger(value.amount) || value.amount === 0) malformed();
  if (Object.hasOwn(value, 'account') && value.account !== wallet) malformed();
  return { leg_id: id, owner: wallet, amount_lamports: value.amount };
}
function recognizedPrograms(transaction) {
  const found = new Set();
  const visit = instructions => {
    for (const instruction of array(instructions)) {
      if (instruction === null || typeof instruction !== 'object' || Array.isArray(instruction)) malformed();
      if (isRecognizedSpotProgramV1(instruction.programId)) found.add(instruction.programId);
      if (Object.hasOwn(instruction, 'innerInstructions')) visit(instruction.innerInstructions);
    }
  };
  visit(transaction.instructions);
  return [...found].sort().map(program_id => ({ program_id }));
}

function structuredGroups(transaction, wallet) {
  const swap = transaction.events?.swap;
  if (swap === undefined || swap === null) return [];
  if (swap === null || typeof swap !== 'object' || Array.isArray(swap)) malformed();
  const tokenLegs = (values, prefix) => array(values).map(leg => tokenSwapLeg(leg, wallet, 'pending'))
    .sort((left, right) => `${left.owner}\u0000${left.mint}\u0000${left.decimals}\u0000${left.raw_amount}`
      .localeCompare(`${right.owner}\u0000${right.mint}\u0000${right.decimals}\u0000${right.raw_amount}`))
    .map((leg, index) => ({ ...leg, leg_id: `${prefix}-${index}` }));
  const nativeLegs = (value, prefix) => value === null || value === undefined ? []
    : [{ ...nativeSwapLeg(value, wallet, 'pending'), leg_id: `${prefix}-0` }];
  return [{
    group_id: 'swap-0',
    token_inputs: tokenLegs(swap.tokenInputs ?? [], 'swap-token-in'),
    token_outputs: tokenLegs(swap.tokenOutputs ?? [], 'swap-token-out'),
    native_inputs: nativeLegs(swap.nativeInput, 'swap-native-in'),
    native_outputs: nativeLegs(swap.nativeOutput, 'swap-native-out'),
  }];
}

function exactScaledDecimal(value, decimals) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const numeric = typeof value === 'number';
  const decimal = numeric
    ? Number.isFinite(value) && value > 0 && !Object.is(value, -0) ? String(value) : null
    : typeof value === 'string' ? value : null;
  if (decimal === null) return null;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(decimal);
  if (match === null || (match[2]?.length ?? 0) > decimals) return null;
  const scaled = `${match[1]}${(match[2] ?? '').padEnd(decimals, '0')}`.replace(/^0+(?=[0-9])/, '');
  if (numeric) {
    const integer = BigInt(scaled);
    const maximum = BigInt(Number.MAX_SAFE_INTEGER);
    const divisor = 10 ** decimals;
    if (integer > maximum || Number(integer) / divisor !== value) return null;
    if (integer > 0n && Number(integer - 1n) / divisor === value) return null;
    if (integer < maximum && Number(integer + 1n) / divisor === value) return null;
  }
  return scaled === '0' ? null : scaled;
}

function rawFromStructuredTransfer(transfer, direction, groups) {
  const field = direction === 'debit' ? 'token_inputs' : 'token_outputs';
  const candidates = groups.flatMap(group => group[field]).filter(leg => (
    leg.mint === transfer.mint && exactScaledDecimal(transfer.tokenAmount, leg.decimals) === leg.raw_amount
  ));
  return candidates.length === 1 ? { raw_amount: candidates[0].raw_amount, decimals: candidates[0].decimals } : null;
}

function rawFromAccountChanges(transaction, transfer, direction, wallet, consumed) {
  const candidates = [];
  for (const [accountIndex, account] of array(transaction.accountData).entries()) {
    if (account === null || typeof account !== 'object' || Array.isArray(account)) malformed();
    for (const [changeIndex, change] of array(account.tokenBalanceChanges ?? []).entries()) {
      if (change === null || typeof change !== 'object' || Array.isArray(change)) malformed();
      const key = `${accountIndex}-${changeIndex}`;
      if (consumed.has(key) || change.userAccount !== wallet || change.mint !== transfer.mint) continue;
      const value = change.rawTokenAmount;
      if (value === null || typeof value !== 'object' || Array.isArray(value)
          || typeof value.tokenAmount !== 'string' || !/^-?[0-9]+$/.test(value.tokenAmount)
          || !Number.isSafeInteger(value.decimals) || value.decimals < 0 || value.decimals > 18) continue;
      const signed = BigInt(value.tokenAmount);
      if ((direction === 'debit' && signed >= 0n) || (direction === 'credit' && signed <= 0n)) continue;
      const magnitude = signed < 0n ? -signed : signed;
      if (exactScaledDecimal(transfer.tokenAmount, value.decimals) !== String(magnitude)) continue;
      candidates.push({ key, raw_amount: String(magnitude), decimals: value.decimals });
    }
  }
  if (candidates.length !== 1) return null;
  consumed.add(candidates[0].key);
  return { raw_amount: candidates[0].raw_amount, decimals: candidates[0].decimals };
}

function transferEvidence(transaction, wallet, groups) {
  const group = groups.length === 1 ? groups[0].group_id : 'fallback-0';
  const token = []; const tokenMatches = []; const native = []; const unresolved = []; const consumedChanges = new Set();
  for (const [index, transfer] of array(transaction.tokenTransfers).entries()) {
    if (transfer === null || typeof transfer !== 'object' || Array.isArray(transfer)) malformed();
    const from = transfer.fromUserAccount; const to = transfer.toUserAccount;
    const touchesFrom = from === wallet; const touchesTo = to === wallet;
    if (!touchesFrom && !touchesTo) continue;
    const mint = isSolanaPublicKeyV1(transfer.mint) ? transfer.mint : null;
    if (touchesFrom && touchesTo) {
      unresolved.push({ effect_id: `token-self-${index}`, mint });
      continue;
    }
    const amount = Object.hasOwn(transfer, 'rawTokenAmount')
      ? raw(transfer.rawTokenAmount)
      : rawFromStructuredTransfer(transfer, touchesFrom ? 'debit' : 'credit', groups)
        ?? rawFromAccountChanges(transaction, transfer, touchesFrom ? 'debit' : 'credit', wallet, consumedChanges);
    if (mint === null || amount === null) {
      unresolved.push({ effect_id: `token-unresolved-${index}`, mint });
      continue;
    }
    token.push({ economic_group: group, direction: touchesFrom ? 'debit' : 'credit', owner: wallet, mint, ...amount });
    tokenMatches.push({
      account: touchesFrom ? (transfer.fromTokenAccount ?? null) : (transfer.toTokenAccount ?? null),
      direction: touchesFrom ? 'debit' : 'credit', owner: wallet, mint, ...amount,
    });
  }
  for (const [index, transfer] of array(transaction.nativeTransfers).entries()) {
    if (transfer === null || typeof transfer !== 'object' || Array.isArray(transfer)) malformed();
    const touchesFrom = transfer.fromUserAccount === wallet; const touchesTo = transfer.toUserAccount === wallet;
    if (!touchesFrom && !touchesTo) continue;
    if (touchesFrom && touchesTo) { unresolved.push({ effect_id: `native-self-${index}`, mint: null }); continue; }
    if (!safeInteger(transfer.amount) || transfer.amount === 0) malformed();
    native.push({ economic_group: group, direction: touchesFrom ? 'debit' : 'credit', owner: wallet, amount_lamports: transfer.amount });
  }
  const tokenLegs = token.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .map((leg, index) => ({ leg_id: `token-transfer-${index}`, ...leg }));
  const nativeLegs = native.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .map((leg, index) => ({ leg_id: `native-transfer-${index}`, ...leg }));
  return { token: tokenLegs, tokenMatches, native: nativeLegs, unresolved };
}

function aggregateRawEffects(effects, fields) {
  const aggregates = new Map();
  for (const effect of effects) {
    const key = fields.map(field => effect[field] ?? '').join('\u0000');
    const current = aggregates.get(key) ?? 0n;
    aggregates.set(key, current + BigInt(effect.raw_amount));
  }
  return aggregates;
}

function accountTokenEffects(transaction, wallet, groups, transfers) {
  const structured = [];
  for (const group of groups) {
    for (const [field, direction] of [['token_inputs','debit'], ['token_outputs','credit']]) {
      for (const leg of group[field]) structured.push({ direction, owner: leg.owner, mint: leg.mint, raw_amount: leg.raw_amount, decimals: leg.decimals });
    }
  }
  const structuredTotals = aggregateRawEffects(structured, ['direction','owner','mint','decimals']);
  const transferTotals = aggregateRawEffects(transfers.tokenMatches, ['account','direction','owner','mint','decimals']);
  const transferScopeTotals = aggregateRawEffects(transfers.tokenMatches, ['direction','owner','mint','decimals']);
  const transferAccounts = new Set(transfers.tokenMatches.filter(effect => effect.account !== null)
    .map(effect => [effect.direction, effect.owner, effect.mint, effect.decimals].join('\u0000')));
  const unresolved = [];
  const changes = new Map();
  for (const account of array(transaction.accountData)) {
    if (account === null || typeof account !== 'object' || Array.isArray(account)) malformed();
    const accountKey = isSolanaPublicKeyV1(account.account) ? account.account : null;
    for (const change of array(account.tokenBalanceChanges ?? [])) {
      if (change === null || typeof change !== 'object' || Array.isArray(change)) malformed();
      const amount = change.rawTokenAmount;
      if (amount === null || typeof amount !== 'object' || Array.isArray(amount)
          || typeof amount.tokenAmount !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(amount.tokenAmount)
          || !safeInteger(amount.decimals) || amount.decimals < 0 || amount.decimals > 255) malformed();
      const signed = BigInt(amount.tokenAmount);
      const hasTokenAccount = Object.hasOwn(change, 'tokenAccount');
      const validTokenAccount = isSolanaPublicKeyV1(change.tokenAccount);
      const tokenAccount = validTokenAccount ? change.tokenAccount : accountKey;
      if (validTokenAccount && accountKey !== null && tokenAccount !== accountKey) malformed();
      if (signed === 0n) continue;
      if (hasTokenAccount && !validTokenAccount) { unresolved.push({ mint: null }); continue; }
      if (!Object.hasOwn(change, 'userAccount') || !isSolanaPublicKeyV1(change.userAccount)) {
        unresolved.push({ mint: null });
        continue;
      }
      if (change.userAccount !== wallet) continue;
      const mint = isSolanaPublicKeyV1(change.mint) ? change.mint : null;
      if (mint === null) { unresolved.push({ mint: null }); continue; }
      const direction = signed < 0n ? 'debit' : 'credit';
      const magnitude = signed < 0n ? -signed : signed;
      const key = [tokenAccount ?? '', direction, wallet, mint, amount.decimals].join('\u0000');
      const prior = changes.get(key);
      changes.set(key, prior === undefined
        ? { account: tokenAccount, direction, owner: wallet, mint, decimals: amount.decimals, magnitude }
        : { ...prior, magnitude: prior.magnitude + magnitude });
    }
  }
  const balanceScopeTotals = new Map();
  for (const change of changes.values()) {
    const common = [change.direction, change.owner, change.mint, change.decimals].join('\u0000');
    balanceScopeTotals.set(common, (balanceScopeTotals.get(common) ?? 0n) + change.magnitude);
  }
  for (const change of changes.values()) {
    const common = [change.direction, change.owner, change.mint, change.decimals].join('\u0000');
    const transferKey = [change.account ?? '', change.direction, change.owner, change.mint, change.decimals].join('\u0000');
    const explained = transferAccounts.has(common)
      ? change.account !== null && transferTotals.get(transferKey) === change.magnitude
      : transferScopeTotals.has(common)
        ? transferScopeTotals.get(common) === balanceScopeTotals.get(common)
        : structuredTotals.get(common) === balanceScopeTotals.get(common);
    if (!explained) unresolved.push({ mint: change.mint });
  }
  return unresolved
    .sort((left, right) => (left.mint ?? '').localeCompare(right.mint ?? ''))
    .map((effect, index) => ({ effect_id: `account-token-unresolved-${index}`, mint: effect.mint }));
}

function nativeBalanceEffects(transaction, wallet, groups, transfers, closure) {
  const unresolved = [];
  let walletChange = null;
  for (const account of array(transaction.accountData)) {
    if (account === null || typeof account !== 'object' || Array.isArray(account)) malformed();
    if (!Object.hasOwn(account, 'nativeBalanceChange')) continue;
    if (!Number.isSafeInteger(account.nativeBalanceChange)) malformed();
    if (account.account === wallet) walletChange = (walletChange ?? 0n) + BigInt(account.nativeBalanceChange);
    else if (!isSolanaPublicKeyV1(account.account) && account.nativeBalanceChange !== 0) {
      unresolved.push({ effect_id: `account-native-owner-unresolved-${unresolved.length}`, mint: null });
    } else if (account.nativeBalanceChange !== 0) {
      const ownedByBalance = array(account.tokenBalanceChanges ?? []).some(change => (
        change !== null && typeof change === 'object' && !Array.isArray(change)
        && change.userAccount === wallet && (change.tokenAccount === account.account || !Object.hasOwn(change, 'tokenAccount'))
      ));
      const uncertainByBalance = array(account.tokenBalanceChanges ?? []).some(change => (
        change !== null && typeof change === 'object' && !Array.isArray(change)
        && (!isSolanaPublicKeyV1(change.userAccount)
          || (Object.hasOwn(change, 'tokenAccount') && !isSolanaPublicKeyV1(change.tokenAccount)))
      ));
      const ownedByTransfer = array(transaction.tokenTransfers).some(transfer => (
        transfer !== null && typeof transfer === 'object' && !Array.isArray(transfer)
        && ((transfer.fromTokenAccount === account.account && transfer.fromUserAccount === wallet)
          || (transfer.toTokenAccount === account.account && transfer.toUserAccount === wallet))
      ));
      const uncertainByTransfer = array(transaction.tokenTransfers).some(transfer => (
        transfer !== null && typeof transfer === 'object' && !Array.isArray(transfer)
        && ((transfer.fromTokenAccount === account.account && !isSolanaPublicKeyV1(transfer.fromUserAccount))
          || (transfer.toTokenAccount === account.account && !isSolanaPublicKeyV1(transfer.toUserAccount)))
      ));
      if ((ownedByBalance || ownedByTransfer || uncertainByBalance || uncertainByTransfer)
          && !closure.bound_accounts.includes(account.account)) {
        unresolved.push({ effect_id: `account-native-owned-unresolved-${unresolved.length}`, mint: null });
      }
    }
  }
  if (walletChange === null) return unresolved;
  const transferDebits = transfers.native.filter(leg => leg.direction === 'debit').reduce((sum, leg) => sum + BigInt(leg.amount_lamports), 0n);
  const transferCredits = transfers.native.filter(leg => leg.direction === 'credit').reduce((sum, leg) => sum + BigInt(leg.amount_lamports), 0n);
  const structuredDebits = groups.flatMap(group => group.native_inputs).reduce((sum, leg) => sum + BigInt(leg.amount_lamports), 0n);
  const structuredCredits = groups.flatMap(group => group.native_outputs).reduce((sum, leg) => sum + BigInt(leg.amount_lamports), 0n);
  const hasTransfers = transferDebits !== 0n || transferCredits !== 0n;
  const hasStructured = structuredDebits !== 0n || structuredCredits !== 0n;
  const representationsAgree = !hasTransfers || !hasStructured
    || (transferDebits === structuredDebits && transferCredits === structuredCredits);
  const fee = Object.hasOwn(transaction, 'fee')
    ? safeInteger(transaction.fee) ? BigInt(transaction.fee) : malformed()
    : 0n;
  const representedDebits = hasTransfers ? transferDebits : structuredDebits;
  const representedCredits = hasTransfers ? transferCredits : structuredCredits;
  const expected = representedCredits - representedDebits - (transaction.feePayer === wallet ? fee : 0n);
  if ((!representationsAgree && closure.closures.length === 0) || walletChange !== expected) {
    unresolved.push({ effect_id: 'account-native-unresolved-0', mint: null });
  }
  return unresolved;
}

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

function closureEvidence(transaction, wallet) {
  const candidates = [];
  const unresolved = [];
  const visit = instructions => {
    for (const instruction of array(instructions)) {
      if (instruction === null || typeof instruction !== 'object' || Array.isArray(instruction)) malformed();
      if (TOKEN_PROGRAMS.has(instruction.programId)) {
        let closedAccount = null; let owner = null; let destination = null;
        if (instruction.data === 'A' && Array.isArray(instruction.accounts) && instruction.accounts.length === 3) {
          [closedAccount, destination, owner] = instruction.accounts;
        } else if (instruction.parsed?.type === 'closeAccount') {
          const info = instruction.parsed.info;
          if (info !== null && typeof info === 'object' && !Array.isArray(info)) {
            closedAccount = info.account; destination = info.destination; owner = info.owner ?? info.authority;
          }
        }
        if (owner === wallet && isSolanaPublicKeyV1(destination) && isSolanaPublicKeyV1(closedAccount)) candidates.push(closedAccount);
      }
      if (Object.hasOwn(instruction, 'innerInstructions')) visit(instruction.innerInstructions);
    }
  };
  visit(transaction.instructions);
  const closures = [];
  for (const closedAccount of [...new Set(candidates)].sort()) {
    const mints = new Set();
    for (const transfer of array(transaction.tokenTransfers)) {
      if (transfer === null || typeof transfer !== 'object' || Array.isArray(transfer)) malformed();
      const ownedEndpoint = (transfer.fromTokenAccount === closedAccount && transfer.fromUserAccount === wallet)
        || (transfer.toTokenAccount === closedAccount && transfer.toUserAccount === wallet);
      if (ownedEndpoint && isSolanaPublicKeyV1(transfer.mint)) mints.add(transfer.mint);
    }
    for (const account of array(transaction.accountData)) {
      if (account === null || typeof account !== 'object' || Array.isArray(account)) malformed();
      for (const change of array(account.tokenBalanceChanges ?? [])) {
        if (change === null || typeof change !== 'object' || Array.isArray(change)) malformed();
        if ((change.tokenAccount === closedAccount || account.account === closedAccount)
            && change.userAccount === wallet && isSolanaPublicKeyV1(change.mint)) mints.add(change.mint);
      }
    }
    if (mints.size === 1) closures.push({ owner: wallet, mint: [...mints][0], account: closedAccount });
    else unresolved.push({ mint: null });
  }
  if (transaction.type === 'CLOSE_ACCOUNT' && closures.length === 0 && candidates.length === 0) {
    const mints = [];
    for (const account of array(transaction.accountData)) {
      for (const change of array(account.tokenBalanceChanges ?? [])) {
        if (change.userAccount === wallet) mints.push(isSolanaPublicKeyV1(change.mint) ? change.mint : null);
      }
    }
    if (mints.length === 0) unresolved.push({ mint: null });
    else unresolved.push(...mints.map(mint => ({ mint })));
  }
  return {
    closures: closures.sort((left, right) => left.account.localeCompare(right.account))
      .map((closure, index) => ({ closure_id: `account-close-${index}`, owner: closure.owner, mint: closure.mint })),
    unresolved: unresolved.sort((left, right) => (left.mint ?? '').localeCompare(right.mint ?? ''))
      .map((effect, index) => ({ effect_id: `unbound-account-close-${index}`, mint: effect.mint })),
    bound_accounts: closures.map(closure => closure.account).sort(),
  };
}

export function projectHeliusEnhancedTransactionV1(input) {
  try {
    assertPlainDataV1(input, 'invalid_acquisition_request');
    if (input === null || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'wallet') || !Object.hasOwn(input, 'transaction')
        || !isSolanaPublicKeyV1(input.wallet)) malformed();
    const transaction = input.transaction;
    if (transaction === null || typeof transaction !== 'object' || Array.isArray(transaction)) malformed();
    for (const field of ['signature','slot','timestamp','type','feePayer','transactionError','events','tokenTransfers','nativeTransfers','accountData','instructions']) if (!Object.hasOwn(transaction, field)) malformed();
    if (!isSolanaSignatureV1(transaction.signature) || !safeInteger(transaction.slot) || !safeInteger(transaction.timestamp)
        || !isSolanaPublicKeyV1(transaction.feePayer) || typeof transaction.type !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(transaction.type)) malformed();
    const groups = structuredGroups(transaction, input.wallet);
    const transfers = transferEvidence(transaction, input.wallet, groups);
    const accountTokenUnresolved = accountTokenEffects(transaction, input.wallet, groups, transfers);
    const closure = closureEvidence(transaction, input.wallet);
    const nativeUnresolved = nativeBalanceEffects(transaction, input.wallet, groups, transfers, closure);
    return buildSolanaSpotEvidenceV1({
      spot_evidence_version: 'solana_spot_evidence_v1',
      signature: transaction.signature, slot: transaction.slot, block_time: transaction.timestamp,
      execution_state: transaction.transactionError === null ? 'succeeded' : 'failed',
      wallet: input.wallet, fee_payer: transaction.feePayer, provider_transaction_type: transaction.type,
      recognized_programs: recognizedPrograms(transaction), structured_swap_groups: groups,
      token_transfer_legs: transfers.token, native_sol_transfer_legs: transfers.native,
      account_closures: closure.closures,
      unresolved_wallet_effects: [...transfers.unresolved, ...accountTokenUnresolved, ...nativeUnresolved, ...closure.unresolved],
    });
  } catch (error) {
    if (error?.name === 'WalletAcquisitionError') throw error;
    malformed();
  }
}
