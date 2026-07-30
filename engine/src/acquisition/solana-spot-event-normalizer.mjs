import { DEX_PROGRAMS, SOL_MINT } from '../pipeline/constants.mjs';
import { aggregateSameMintMultiInputSwap } from '../pipeline/same-mint-input-aggregation.mjs';
import { acquisitionFail } from './acquisition-errors.mjs';

const EVENT_FIELDS = Object.freeze([
  'wallet', 'timestamp', 'tx_hash', 'source', 'token_in_mint', 'token_in_amount',
  'token_in_decimals', 'token_out_mint', 'token_out_amount', 'token_out_decimals',
  'extraction_method', 'raw_index',
]);
const EXTRACTION_METHOD = 'helius_enhanced_transaction_swap_v1';
const MIN_NATIVE_TRADE_LAMPORTS = 1_000_000n;

function targetMentioned(value, targetMint, active = new Set()) {
  if (value === targetMint) return true;
  if (value === null || typeof value !== 'object' || active.has(value)) return false;
  active.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, 'value') && targetMentioned(descriptor.value, targetMint, active)) return true;
  }
  active.delete(value);
  return false;
}

function ordinaryObject(value, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    acquisitionFail('normalization_ambiguous', `${context} is malformed`);
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(fields)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      acquisitionFail('normalization_ambiguous', `${context} is not plain data`);
    }
  }
  return Object.fromEntries(Object.entries(fields).map(([key, descriptor]) => [key, descriptor.value]));
}

function arrayData(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(fields).filter(([key]) => key !== 'length');
  if (entries.length !== value.length || entries.some(([key, descriptor], index) => (
    key !== String(index) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
  ))) return null;
  return entries.map(([, descriptor]) => descriptor.value);
}

function parseRawAmount(value, context) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    acquisitionFail('normalization_ambiguous', `${context} raw amount is ambiguous`);
  }
  return BigInt(value);
}

function validateDecimals(value, context) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    acquisitionFail('normalization_ambiguous', `${context} decimals are ambiguous`);
  }
  return value;
}

function amountFromRaw(raw, decimals, context) {
  const amount = Number(raw) / (10 ** decimals);
  if (!Number.isFinite(amount) || amount <= 0) {
    acquisitionFail('normalization_ambiguous', `${context} amount exceeds the deterministic numeric range`);
  }
  return amount;
}

function swapLeg(value, wallet, direction, context) {
  const leg = ordinaryObject(value, context);
  if (leg.userAccount !== wallet) {
    acquisitionFail('normalization_ambiguous', `${context} wallet ownership is ambiguous`);
  }
  if (typeof leg.mint !== 'string' || leg.mint.length === 0) {
    acquisitionFail('normalization_ambiguous', `${context} mint is ambiguous`);
  }
  const raw = ordinaryObject(leg.rawTokenAmount, `${context} raw amount`);
  const decimals = validateDecimals(raw.decimals, context);
  return {
    mint: leg.mint,
    raw: parseRawAmount(raw.tokenAmount, context),
    decimals,
    direction,
  };
}

function aggregateLegs(legs, direction, context) {
  if (legs.length === 0) return null;
  const first = legs[0];
  let total = 0n;
  for (const value of legs) {
    if (value.direction !== direction || value.mint !== first.mint
        || value.decimals !== first.decimals) {
      acquisitionFail('normalization_ambiguous', `${context} contains economically distinct legs`);
    }
    total += value.raw;
  }
  return {
    mint: first.mint,
    amount: amountFromRaw(total, first.decimals, context),
    decimals: first.decimals,
  };
}

function aggregateTokenSides(inputs, outputs, context) {
  if (inputs.length >= 2 && outputs.length === 1) {
    const aggregated = aggregateSameMintMultiInputSwap({
      inputs: inputs.map(value => ({
        mint: value.mint,
        rawAmount: value.raw,
        decimals: value.decimals,
        direction: 'in',
        wallet_side: true,
      })),
      outputs: outputs.map(value => ({
        mint: value.mint,
        rawAmount: value.raw,
        decimals: value.decimals,
        direction: 'out',
        wallet_side: true,
      })),
    });
    if (!aggregated.ok) {
      acquisitionFail('normalization_ambiguous', `${context} cannot be canonically aggregated`);
    }
    return {
      input: {
        mint: aggregated.event_fields.token_in_mint,
        amount: amountFromRaw(
          BigInt(aggregated.aggregate_raw.token_in_raw_amount),
          aggregated.event_fields.token_in_decimals,
          `${context} inputs`,
        ),
        decimals: aggregated.event_fields.token_in_decimals,
      },
      output: {
        mint: aggregated.event_fields.token_out_mint,
        amount: amountFromRaw(
          BigInt(aggregated.aggregate_raw.token_out_raw_amount),
          aggregated.event_fields.token_out_decimals,
          `${context} output`,
        ),
        decimals: aggregated.event_fields.token_out_decimals,
      },
    };
  }
  return {
    input: aggregateLegs(inputs, 'input', `${context} inputs`),
    output: aggregateLegs(outputs, 'output', `${context} outputs`),
  };
}

function makeEvent(transaction, wallet, input, output) {
  if (input === null || output === null || input.mint === output.mint) {
    acquisitionFail('normalization_ambiguous', 'target-affecting trade direction is ambiguous');
  }
  if (typeof transaction.source !== 'string' || transaction.source.length === 0) {
    acquisitionFail('normalization_failed', 'target-affecting trade source is missing');
  }
  return {
    wallet,
    timestamp: transaction.timestamp,
    tx_hash: transaction.signature,
    source: transaction.source,
    token_in_mint: input.mint,
    token_in_amount: input.amount,
    token_in_decimals: input.decimals,
    token_out_mint: output.mint,
    token_out_amount: output.amount,
    token_out_decimals: output.decimals,
    extraction_method: EXTRACTION_METHOD,
  };
}

function normalizeSwapEvidence(transaction, wallet, targetMint) {
  const swap = transaction.events?.swap;
  const inputValues = arrayData(swap?.tokenInputs);
  const outputValues = arrayData(swap?.tokenOutputs);
  if (inputValues === null || outputValues === null) return { event: null, status: 'malformed' };
  const mentionsTarget = [...inputValues, ...outputValues].some(value => value?.mint === targetMint);
  if (!mentionsTarget) return { event: null, status: 'unrelated' };
  if (transaction.feePayer !== wallet) {
    acquisitionFail('normalization_ambiguous', 'target-affecting swap fee-payer ownership is ambiguous');
  }
  if (swap.nativeInput || swap.nativeOutput) {
    acquisitionFail('normalization_ambiguous', 'target-affecting native swap evidence is unsupported');
  }
  if (inputValues.length === 0 || outputValues.length !== 1) {
    acquisitionFail('normalization_ambiguous', 'target-affecting swap must have one economic output leg');
  }
  const inputs = inputValues.map((value, index) => swapLeg(value, wallet, 'input', `swap input ${index}`));
  const outputs = outputValues.map((value, index) => swapLeg(value, wallet, 'output', `swap output ${index}`));
  const { input, output } = aggregateTokenSides(inputs, outputs, 'swap');
  const event = makeEvent(transaction, wallet, input, output);
  if (event.token_in_mint !== targetMint && event.token_out_mint !== targetMint) {
    acquisitionFail('normalization_ambiguous', 'target-affecting swap direction is ambiguous');
  }
  return { event, status: 'normalized' };
}

function touchesRecognizedDex(transaction) {
  const instructions = arrayData(transaction.instructions);
  if (instructions === null) return false;
  for (const instruction of instructions) {
    if (DEX_PROGRAMS.has(instruction?.programId)) return true;
    const inner = arrayData(instruction?.innerInstructions);
    if (inner !== null && inner.some(value => DEX_PROGRAMS.has(value?.programId))) return true;
  }
  return false;
}

function transferDecimals(transaction, mint) {
  const found = new Set();
  const accounts = arrayData(transaction.accountData);
  if (accounts === null) return null;
  for (const account of accounts) {
    const changes = arrayData(account?.tokenBalanceChanges);
    if (changes === null) continue;
    for (const change of changes) {
      if (change?.mint === mint && Number.isSafeInteger(change?.rawTokenAmount?.decimals)
          && change.rawTokenAmount.decimals >= 0 && change.rawTokenAmount.decimals <= 255) {
        found.add(change.rawTokenAmount.decimals);
      }
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

function transferRawAmount(transfer, transaction, context) {
  if (transfer.rawTokenAmount !== undefined) {
    const raw = ordinaryObject(transfer.rawTokenAmount, `${context} raw amount`);
    const decimals = validateDecimals(raw.decimals, context);
    return { raw: parseRawAmount(raw.tokenAmount, context), decimals };
  }
  const decimals = transferDecimals(transaction, transfer.mint);
  if (decimals === null || typeof transfer.tokenAmount !== 'number'
      || !Number.isFinite(transfer.tokenAmount) || transfer.tokenAmount <= 0) {
    acquisitionFail('normalization_ambiguous', `${context} amount or decimals are ambiguous`);
  }
  const scaled = transfer.tokenAmount * (10 ** decimals);
  if (!Number.isSafeInteger(scaled) || scaled <= 0) {
    acquisitionFail('normalization_ambiguous', `${context} amount cannot be represented exactly`);
  }
  return { raw: BigInt(scaled), decimals };
}

function walletTransferLegs(transaction, wallet) {
  const values = arrayData(transaction.tokenTransfers);
  if (values === null) return { inputs: [], outputs: [], malformed: true, targetMints: new Set() };
  const inputs = [];
  const outputs = [];
  const targetMints = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const transfer = ordinaryObject(values[index], `token transfer ${index}`);
    const sent = transfer.fromUserAccount === wallet;
    const received = transfer.toUserAccount === wallet;
    if (!sent && !received) continue;
    if (typeof transfer.mint === 'string') targetMints.add(transfer.mint);
    if (sent === received || typeof transfer.mint !== 'string' || transfer.mint.length === 0) {
      return { inputs, outputs, malformed: true, targetMints };
    }
    const amount = transferRawAmount(transfer, transaction, `token transfer ${index}`);
    const leg = { mint: transfer.mint, ...amount, direction: sent ? 'input' : 'output' };
    (sent ? inputs : outputs).push(leg);
  }
  return { inputs, outputs, malformed: false, targetMints };
}

function netNativeLamports(transaction, wallet) {
  const values = arrayData(transaction.nativeTransfers);
  if (values === null) return 0n;
  let net = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value?.amount) || value.amount < 0) continue;
    const amount = BigInt(value.amount);
    if (value.fromUserAccount === wallet) net -= amount;
    if (value.toUserAccount === wallet) net += amount;
  }
  return net;
}

function normalizeTransferEvidence(transaction, wallet, targetMint) {
  const transfers = walletTransferLegs(transaction, wallet);
  const mentionsTargetTransfer = transfers.targetMints.has(targetMint);
  if (transfers.malformed) return { event: null, status: mentionsTargetTransfer ? 'ambiguous' : 'none' };
  if (transfers.outputs.length > 1) {
    return { event: null, status: mentionsTargetTransfer ? 'ambiguous' : 'unrelated' };
  }
  let input;
  let output;
  try {
    ({ input, output } = aggregateTokenSides(transfers.inputs, transfers.outputs, 'wallet token transfers'));
  } catch (error) {
    if (mentionsTargetTransfer) throw error;
    return { event: null, status: 'unrelated' };
  }
  const nativeNet = netNativeLamports(transaction, wallet);
  if (input !== null && output === null && nativeNet >= MIN_NATIVE_TRADE_LAMPORTS) {
    output = { mint: SOL_MINT, amount: amountFromRaw(nativeNet, 9, 'native output'), decimals: 9 };
  } else if (input === null && output !== null && nativeNet <= -MIN_NATIVE_TRADE_LAMPORTS) {
    input = { mint: SOL_MINT, amount: amountFromRaw(-nativeNet, 9, 'native input'), decimals: 9 };
  }
  if (input === null || output === null) {
    return { event: null, status: mentionsTargetTransfer ? 'insufficient' : 'none' };
  }
  if (input.mint !== targetMint && output.mint !== targetMint) return { event: null, status: 'unrelated' };
  return { event: makeEvent(transaction, wallet, input, output), status: 'normalized' };
}

function normalizeTransaction(transaction, request) {
  const { wallet, target } = request;
  const targetMint = target.token_mint;
  const affectsTarget = targetMentioned(transaction, targetMint);
  if (transaction.transactionError) return null;

  if (transaction.type === 'SWAP') {
    const structured = normalizeSwapEvidence(transaction, wallet, targetMint);
    if (structured.event !== null) return structured.event;
    const fallback = normalizeTransferEvidence(transaction, wallet, targetMint);
    if (fallback.event !== null) return fallback.event;
    if (!affectsTarget) return null;
    if (fallback.status === 'ambiguous' || structured.status === 'malformed') {
      acquisitionFail('normalization_ambiguous', 'target-affecting swap evidence is ambiguous');
    }
    acquisitionFail('unsupported_target_activity', 'target activity is outside supported swap evidence');
  }

  if (!touchesRecognizedDex(transaction)) {
    if (affectsTarget) acquisitionFail('unsupported_target_activity', 'non-swap target activity lacks recognized DEX evidence');
    return null;
  }
  const fallback = normalizeTransferEvidence(transaction, wallet, targetMint);
  if (fallback.event !== null) return fallback.event;
  if (!affectsTarget) return null;
  if (fallback.status === 'ambiguous') {
    acquisitionFail('normalization_ambiguous', 'target-affecting DEX transfer evidence is ambiguous');
  }
  acquisitionFail('unsupported_target_activity', 'account closure or DEX invocation alone is not trade evidence');
}

export function normalizeHeliusSolanaSpotEventsV1(transactions, request) {
  const selected = [];
  for (const transaction of transactions) {
    if (transaction.timestamp < request.bounds.oldest_allowed_timestamp
        || transaction.timestamp > request.bounds.newest_allowed_timestamp) continue;
    const normalized = normalizeTransaction(transaction, request);
    if (normalized !== null) selected.push(normalized);
  }
  selected.sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    if (left.tx_hash < right.tx_hash) return -1;
    if (left.tx_hash > right.tx_hash) return 1;
    return 0;
  });
  const result = selected.map((event, rawIndex) => ({ ...event, raw_index: rawIndex }));
  for (const event of result) {
    if (Object.keys(event).length !== EVENT_FIELDS.length
        || EVENT_FIELDS.some(field => !Object.hasOwn(event, field))) {
      acquisitionFail('normalization_failed', 'normalized event envelope is incomplete');
    }
  }
  return result;
}