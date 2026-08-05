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
  return [{
    group_id: 'swap-0',
    token_inputs: array(swap.tokenInputs ?? []).map((leg, index) => tokenSwapLeg(leg, wallet, `swap-token-in-${index}`)),
    token_outputs: array(swap.tokenOutputs ?? []).map((leg, index) => tokenSwapLeg(leg, wallet, `swap-token-out-${index}`)),
    native_inputs: swap.nativeInput === null || swap.nativeInput === undefined ? [] : [nativeSwapLeg(swap.nativeInput, wallet, 'swap-native-in-0')],
    native_outputs: swap.nativeOutput === null || swap.nativeOutput === undefined ? [] : [nativeSwapLeg(swap.nativeOutput, wallet, 'swap-native-out-0')],
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
  const token = []; const native = []; const unresolved = []; const consumedChanges = new Set();
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
    token.push({ leg_id: `token-transfer-${index}`, economic_group: group, direction: touchesFrom ? 'debit' : 'credit', owner: wallet, mint, ...amount });
  }
  for (const [index, transfer] of array(transaction.nativeTransfers).entries()) {
    if (transfer === null || typeof transfer !== 'object' || Array.isArray(transfer)) malformed();
    const touchesFrom = transfer.fromUserAccount === wallet; const touchesTo = transfer.toUserAccount === wallet;
    if (!touchesFrom && !touchesTo) continue;
    if (touchesFrom && touchesTo) { unresolved.push({ effect_id: `native-self-${index}`, mint: null }); continue; }
    if (!safeInteger(transfer.amount) || transfer.amount === 0) malformed();
    native.push({ leg_id: `native-transfer-${index}`, economic_group: group, direction: touchesFrom ? 'debit' : 'credit', owner: wallet, amount_lamports: transfer.amount });
  }
  return { token, native, unresolved };
}

function unresolvedClosures(transaction, wallet) {
  if (transaction.type !== 'CLOSE_ACCOUNT') return [];
  const result = [];
  for (const [accountIndex, account] of array(transaction.accountData).entries()) {
    if (account === null || typeof account !== 'object' || Array.isArray(account)) malformed();
    for (const [index, change] of array(account.tokenBalanceChanges ?? []).entries()) {
      if (change === null || typeof change !== 'object' || Array.isArray(change)) malformed();
      if (change.userAccount === wallet) {
        result.push({ effect_id: `unbound-account-close-${accountIndex}-${index}`, mint: isSolanaPublicKeyV1(change.mint) ? change.mint : null });
      }
    }
  }
  return result;
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
    return buildSolanaSpotEvidenceV1({
      spot_evidence_version: 'solana_spot_evidence_v1',
      signature: transaction.signature, slot: transaction.slot, block_time: transaction.timestamp,
      execution_state: transaction.transactionError === null ? 'succeeded' : 'failed',
      wallet: input.wallet, fee_payer: transaction.feePayer, provider_transaction_type: transaction.type,
      recognized_programs: recognizedPrograms(transaction), structured_swap_groups: groups,
      token_transfer_legs: transfers.token, native_sol_transfer_legs: transfers.native,
      account_closures: [], unresolved_wallet_effects: [...transfers.unresolved, ...unresolvedClosures(transaction, input.wallet)],
    });
  } catch (error) {
    if (error?.name === 'WalletAcquisitionError') throw error;
    malformed();
  }
}
