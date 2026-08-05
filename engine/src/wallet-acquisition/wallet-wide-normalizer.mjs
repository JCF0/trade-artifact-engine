import { types as utilTypes } from 'node:util';

import { aggregateSameMintMultiInputSwap } from '../pipeline/same-mint-input-aggregation.mjs';
import {
  buildSolanaSpotEvidenceV1,
  failSpotEvidenceV1,
} from './solana-spot-evidence.mjs';

export const NORMALIZER_OUTCOME_FIELDS_V1 = Object.freeze([
  'outcome','event','affected_position_token_mints','affected_quote_mints','impact_scope','reason_code',
]);

const OUTCOMES = new Set(['supported_event','unsupported_shape','ambiguous_shape','no_supported_operation']);
const IMPACT_SCOPES = new Set(['none','token_specific','wallet_wide']);
const REASON_CODES = new Set([
  'mixed_input_mints','mixed_input_decimals','multiple_economic_outputs','recognized_dex_required',
  'native_side_below_trade_threshold','no_economic_wallet_movement','one_sided_position_movement',
  'quote_only_movement','failed_transaction','nonquote_to_nonquote','multiple_material_operations',
  'unresolved_wallet_effect','unsupported_swap_shape','native_side_with_account_close',
]);
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const QUOTE_MINTS = Object.freeze([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const MIN_NATIVE_TRADE_LAMPORTS = 1_000_000;
const EVENT_FIELDS = [
  'wallet','timestamp','tx_hash','source','token_in_mint','token_in_amount','token_in_decimals',
  'token_out_mint','token_out_amount','token_out_decimals','extraction_method','raw_index',
];
const MAX_PLAIN_DEPTH = 128;
const MAX_PLAIN_NODES = 100000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedUnique(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

function exact(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) failSpotEvidenceV1('normalization_failed');
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) {
    failSpotEvidenceV1('normalization_failed');
  }
}

function assertPlainData(value, active = new Set(), depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_PLAIN_NODES || depth > MAX_PLAIN_DEPTH) failSpotEvidenceV1('normalization_failed');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) failSpotEvidenceV1('normalization_failed');
    return;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value) || active.has(value)) failSpotEvidenceV1('normalization_failed');
  let prototype;
  let descriptors;
  let symbols;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    failSpotEvidenceV1('normalization_failed');
  }
  const isArray = Array.isArray(value);
  if (prototype !== (isArray ? Array.prototype : Object.prototype) || symbols.length !== 0) failSpotEvidenceV1('normalization_failed');
  const entries = Object.entries(descriptors).filter(([key]) => !(isArray && key === 'length'));
  if (isArray && (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))) {
    failSpotEvidenceV1('normalization_failed');
  }
  active.add(value);
  for (const [, descriptor] of entries) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) failSpotEvidenceV1('normalization_failed');
    assertPlainData(descriptor.value, active, depth + 1, budget);
  }
  active.delete(value);
}

function assertPlainEnvelope(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    failSpotEvidenceV1('normalization_failed');
  }
  let prototype;
  let descriptors;
  let symbols;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    failSpotEvidenceV1('normalization_failed');
  }
  const keys = Object.keys(descriptors);
  if (prototype !== Object.prototype || symbols.length !== 0 || keys.length !== fields.length
      || keys.some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(descriptors, key))
      || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    failSpotEvidenceV1('normalization_failed');
  }
}

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      Object.defineProperty(result, key, { value: clone(descriptor.value), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return value;
}

function amountFromRaw(rawAmount, decimals) {
  const amount = Number(BigInt(rawAmount)) / (10 ** decimals);
  if (!Number.isFinite(amount) || amount <= 0) failSpotEvidenceV1('normalization_ambiguous');
  return amount;
}

function mintContext(evidence) {
  const values = [];
  for (const group of evidence.structured_swap_groups) {
    values.push(...group.token_inputs.map(leg => leg.mint), ...group.token_outputs.map(leg => leg.mint));
    if (group.native_inputs.length || group.native_outputs.length) values.push(SOL_MINT);
  }
  values.push(...evidence.token_transfer_legs.map(leg => leg.mint));
  if (evidence.native_sol_transfer_legs.length) values.push(SOL_MINT);
  values.push(...evidence.unresolved_wallet_effects.map(effect => effect.mint).filter(mint => mint !== null));
  return {
    positions: orderedUnique(values.filter(mint => !QUOTE_MINTS.includes(mint))),
    quotes: orderedUnique(values.filter(mint => QUOTE_MINTS.includes(mint))),
  };
}

function outcome(outcomeValue, {
  event = null,
  positions = [],
  quotes = [],
  impact = positions.length ? 'token_specific' : 'none',
  reason = null,
} = {}) {
  const result = {
    outcome: outcomeValue,
    event,
    affected_position_token_mints: orderedUnique(positions),
    affected_quote_mints: orderedUnique(quotes),
    impact_scope: impact,
    reason_code: reason,
  };
  validateWalletWideNormalizerOutcomeV1(result);
  return freeze(clone(result));
}

function unsupported(context, reason) {
  return outcome('unsupported_shape', { positions: context.positions, quotes: context.quotes, reason });
}

function classifySides(input, output, context) {
  const inputQuote = QUOTE_MINTS.includes(input.mint);
  const outputQuote = QUOTE_MINTS.includes(output.mint);
  if (!inputQuote && !outputQuote) return { unsupported: unsupported(context, 'nonquote_to_nonquote') };
  if (inputQuote === outputQuote) return { unsupported: unsupported(context, 'unsupported_swap_shape') };
  return {
    position: inputQuote ? output.mint : input.mint,
    quote: inputQuote ? input.mint : output.mint,
  };
}

function validateSupportedEvent(event, positions, quotes) {
  exact(event, EVENT_FIELDS);
  if (!SAFE_IDENTIFIER.test(event.wallet) || !SAFE_IDENTIFIER.test(event.tx_hash)
      || !SAFE_IDENTIFIER.test(event.token_in_mint) || !SAFE_IDENTIFIER.test(event.token_out_mint)
      || event.source !== 'wallet_source_transaction_v1'
      || event.extraction_method !== 'injected_wallet_spot_normalizer_v1'
      || !Number.isSafeInteger(event.timestamp) || event.timestamp < 0
      || !Number.isSafeInteger(event.token_in_decimals) || event.token_in_decimals < 0 || event.token_in_decimals > 255
      || !Number.isSafeInteger(event.token_out_decimals) || event.token_out_decimals < 0 || event.token_out_decimals > 255
      || typeof event.token_in_amount !== 'number' || !Number.isFinite(event.token_in_amount) || event.token_in_amount <= 0
      || typeof event.token_out_amount !== 'number' || !Number.isFinite(event.token_out_amount) || event.token_out_amount <= 0
      || !Number.isSafeInteger(event.raw_index) || event.raw_index < 0
      || event.token_in_mint === event.token_out_mint) failSpotEvidenceV1('normalization_failed');
  const inputQuote = QUOTE_MINTS.includes(event.token_in_mint);
  const outputQuote = QUOTE_MINTS.includes(event.token_out_mint);
  if (inputQuote === outputQuote) failSpotEvidenceV1('normalization_failed');
  const expectedPosition = inputQuote ? event.token_out_mint : event.token_in_mint;
  const expectedQuote = inputQuote ? event.token_in_mint : event.token_out_mint;
  if (positions.length !== 1 || positions[0] !== expectedPosition || quotes.length !== 1 || quotes[0] !== expectedQuote) {
    failSpotEvidenceV1('normalization_failed');
  }
}

function eventFor(evidence, input, output, provisionalRawIndex) {
  return {
    wallet: evidence.wallet,
    timestamp: evidence.block_time,
    tx_hash: evidence.signature,
    source: 'wallet_source_transaction_v1',
    token_in_mint: input.mint,
    token_in_amount: input.amount,
    token_in_decimals: input.decimals,
    token_out_mint: output.mint,
    token_out_amount: output.amount,
    token_out_decimals: output.decimals,
    extraction_method: 'injected_wallet_spot_normalizer_v1',
    raw_index: provisionalRawIndex,
  };
}

function tokenInput(leg) {
  return {
    mint: leg.mint,
    rawAmount: leg.raw_amount,
    decimals: leg.decimals,
    direction: 'in',
    wallet_side: true,
    ref: null,
  };
}

function tokenOutput(leg) {
  return {
    mint: leg.mint,
    rawAmount: leg.raw_amount,
    decimals: leg.decimals,
    direction: 'out',
    wallet_side: true,
  };
}

function aggregateTokenInputs(inputs, outputs, context) {
  if (outputs.length !== 1) return { unsupported: unsupported(context, 'multiple_economic_outputs') };
  if (inputs.length === 0) return { oneSided: true };
  if (inputs.length === 1) {
    return {
      input: { mint: inputs[0].mint, amount: amountFromRaw(inputs[0].raw_amount, inputs[0].decimals), decimals: inputs[0].decimals },
      output: { mint: outputs[0].mint, amount: amountFromRaw(outputs[0].raw_amount, outputs[0].decimals), decimals: outputs[0].decimals },
    };
  }
  const aggregated = aggregateSameMintMultiInputSwap({
    inputs: inputs.map(tokenInput),
    outputs: outputs.map(tokenOutput),
  });
  if (!aggregated.ok) {
    const reason = aggregated.reason === 'mixed_input_mints'
      ? 'mixed_input_mints'
      : aggregated.reason === 'mixed_input_decimals'
        ? 'mixed_input_decimals'
        : aggregated.reason === 'multiple_output_mints'
          ? 'multiple_economic_outputs'
          : 'unsupported_swap_shape';
    return { unsupported: unsupported(context, reason) };
  }
  return {
    input: {
      mint: aggregated.event_fields.token_in_mint,
      amount: amountFromRaw(aggregated.aggregate_raw.token_in_raw_amount, aggregated.event_fields.token_in_decimals),
      decimals: aggregated.event_fields.token_in_decimals,
    },
    output: {
      mint: aggregated.event_fields.token_out_mint,
      amount: amountFromRaw(aggregated.aggregate_raw.token_out_raw_amount, aggregated.event_fields.token_out_decimals),
      decimals: aggregated.event_fields.token_out_decimals,
    },
  };
}

function aggregateEconomicGroup({ tokenInputs, tokenOutputs, nativeInputs, nativeOutputs }, context) {
  const inputCount = tokenInputs.length + nativeInputs.length;
  const outputCount = tokenOutputs.length + nativeOutputs.length;
  if (outputCount > 1) return { unsupported: unsupported(context, 'multiple_economic_outputs') };
  if (inputCount === 0 || outputCount === 0) return { oneSided: true };
  if (nativeInputs.length && tokenInputs.length) return { unsupported: unsupported(context, 'mixed_input_mints') };
  if (nativeInputs.length > 1 || nativeOutputs.length > 1) return { unsupported: unsupported(context, 'unsupported_swap_shape') };
  if (nativeInputs.length) {
    const native = nativeInputs[0];
    if (native.amount_lamports < MIN_NATIVE_TRADE_LAMPORTS) return { unsupported: unsupported(context, 'native_side_below_trade_threshold') };
    if (tokenOutputs.length !== 1) return { unsupported: unsupported(context, 'unsupported_swap_shape') };
    return {
      input: { mint: SOL_MINT, amount: native.amount_lamports / 1_000_000_000, decimals: 9 },
      output: { mint: tokenOutputs[0].mint, amount: amountFromRaw(tokenOutputs[0].raw_amount, tokenOutputs[0].decimals), decimals: tokenOutputs[0].decimals },
    };
  }
  if (nativeOutputs.length) {
    const native = nativeOutputs[0];
    if (native.amount_lamports < MIN_NATIVE_TRADE_LAMPORTS) return { unsupported: unsupported(context, 'native_side_below_trade_threshold') };
    if (tokenInputs.length === 0) return { oneSided: true };
    const placeholderOutput = [{ mint: SOL_MINT, raw_amount: String(native.amount_lamports), decimals: 9 }];
    return aggregateTokenInputs(tokenInputs, placeholderOutput, context);
  }
  return aggregateTokenInputs(tokenInputs, tokenOutputs, context);
}

function supportedFromSides(evidence, sides, context, provisionalRawIndex) {
  if (sides.unsupported) return sides.unsupported;
  if (sides.oneSided) {
    if (context.positions.length === 0) return outcome('no_supported_operation', { reason: 'quote_only_movement' });
    return unsupported(context, 'one_sided_position_movement');
  }
  if (sides.input.mint === sides.output.mint) return unsupported(context, 'unsupported_swap_shape');
  const classification = classifySides(sides.input, sides.output, context);
  if (classification.unsupported) return classification.unsupported;
  return outcome('supported_event', {
    event: eventFor(evidence, sides.input, sides.output, provisionalRawIndex),
    positions: [classification.position],
    quotes: [classification.quote],
    impact: 'token_specific',
  });
}

function groupedTransfers(evidence) {
  const groups = new Map();
  const get = key => {
    const stableKey = key ?? '__ungrouped__';
    if (!groups.has(stableKey)) groups.set(stableKey, { tokenInputs: [], tokenOutputs: [], nativeInputs: [], nativeOutputs: [] });
    return groups.get(stableKey);
  };
  for (const leg of evidence.token_transfer_legs) get(leg.economic_group)[leg.direction === 'debit' ? 'tokenInputs' : 'tokenOutputs'].push(leg);
  for (const leg of evidence.native_sol_transfer_legs) {
    const value = { amount_lamports: leg.amount_lamports };
    get(leg.economic_group)[leg.direction === 'debit' ? 'nativeInputs' : 'nativeOutputs'].push(value);
  }
  return groups;
}

function normalizeStructured(evidence, context, provisionalRawIndex) {
  if (evidence.structured_swap_groups.length !== 1) return unsupported(context, 'multiple_material_operations');
  const group = evidence.structured_swap_groups[0];
  const extraTransfer = evidence.token_transfer_legs.some(leg => leg.economic_group !== group.group_id)
    || evidence.native_sol_transfer_legs.some(leg => leg.economic_group !== group.group_id);
  if (extraTransfer) return unsupported(context, 'multiple_material_operations');
  const sides = aggregateEconomicGroup({
    tokenInputs: group.token_inputs,
    tokenOutputs: group.token_outputs,
    nativeInputs: group.native_inputs,
    nativeOutputs: group.native_outputs,
  }, context);
  if (evidence.token_transfer_legs.length || evidence.native_sol_transfer_legs.length) {
    const transferGroups = groupedTransfers(evidence);
    if (transferGroups.size !== 1 || !transferGroups.has(group.group_id)) return unsupported(context, 'multiple_material_operations');
    const corroborating = aggregateEconomicGroup(transferGroups.get(group.group_id), context);
    const sameSide = (left, right) => left.mint === right.mint
      && left.amount === right.amount
      && left.decimals === right.decimals;
    if (sides.unsupported || sides.oneSided || corroborating.unsupported || corroborating.oneSided
        || !sameSide(sides.input, corroborating.input) || !sameSide(sides.output, corroborating.output)) {
      return unsupported(context, 'multiple_material_operations');
    }
  }
  return supportedFromSides(evidence, sides, context, provisionalRawIndex);
}

function normalizeFallback(evidence, context, provisionalRawIndex) {
  const groups = groupedTransfers(evidence);
  if (groups.size === 0) {
    if (evidence.account_closures.length) return outcome('no_supported_operation', { reason: 'no_economic_wallet_movement' });
    return outcome('no_supported_operation', { reason: 'no_economic_wallet_movement' });
  }
  if (groups.size !== 1) return unsupported(context, 'multiple_material_operations');
  const sides = aggregateEconomicGroup([...groups.values()][0], context);
  if (!sides.oneSided && !sides.unsupported && evidence.recognized_programs.length === 0) return unsupported(context, 'recognized_dex_required');
  return supportedFromSides(evidence, sides, context, provisionalRawIndex);
}

export function validateWalletWideNormalizerOutcomeV1(value) {
  try {
    assertPlainData(value);
    exact(value, NORMALIZER_OUTCOME_FIELDS_V1);
    if (!OUTCOMES.has(value.outcome) || !Array.isArray(value.affected_position_token_mints)
        || !Array.isArray(value.affected_quote_mints) || !IMPACT_SCOPES.has(value.impact_scope)) {
      failSpotEvidenceV1('normalization_failed');
    }
    const positions = value.affected_position_token_mints;
    const quotes = value.affected_quote_mints;
    if (positions.some(mint => typeof mint !== 'string' || QUOTE_MINTS.includes(mint))
        || quotes.some(mint => !QUOTE_MINTS.includes(mint))
        || new Set([...positions, ...quotes]).size !== positions.length + quotes.length
        || orderedUnique(positions).join('\u0000') !== positions.join('\u0000')
        || orderedUnique(quotes).join('\u0000') !== quotes.join('\u0000')) failSpotEvidenceV1('normalization_failed');
    if (value.outcome === 'supported_event') {
      validateSupportedEvent(value.event, positions, quotes);
      if (value.reason_code !== null || value.impact_scope !== 'token_specific') failSpotEvidenceV1('normalization_failed');
    } else {
      if (value.event !== null || !REASON_CODES.has(value.reason_code)) failSpotEvidenceV1('normalization_failed');
      if (value.outcome === 'no_supported_operation' && (positions.length || quotes.length || value.impact_scope !== 'none')) failSpotEvidenceV1('normalization_failed');
      if (value.impact_scope === 'token_specific' && positions.length === 0) failSpotEvidenceV1('normalization_failed');
      if (value.impact_scope === 'wallet_wide' && value.outcome !== 'ambiguous_shape') failSpotEvidenceV1('normalization_failed');
    }
    return true;
  } catch (error) {
    if (error?.name === 'WalletSpotEvidenceError' && error.code === 'normalization_failed') throw error;
    failSpotEvidenceV1('normalization_failed');
  }
}

export function normalizeWalletWideSolanaSpotEvidenceV1(input) {
  try {
    assertPlainEnvelope(input, ['evidence','provisional_raw_index']);
    exact(input, ['evidence','provisional_raw_index']);
    if (!Number.isSafeInteger(input.provisional_raw_index) || input.provisional_raw_index < 0) failSpotEvidenceV1('normalization_failed');
    const evidence = buildSolanaSpotEvidenceV1(input.evidence);
    const context = mintContext(evidence);
    if (evidence.execution_state === 'failed') return outcome('no_supported_operation', { reason: 'failed_transaction' });
    if (evidence.unresolved_wallet_effects.length) {
      const walletWide = evidence.unresolved_wallet_effects.some(effect => effect.mint === null);
      if (!walletWide && context.positions.length === 0) {
        return outcome('no_supported_operation', { reason: 'quote_only_movement' });
      }
      return outcome('ambiguous_shape', {
        positions: walletWide ? [] : context.positions,
        quotes: walletWide ? [] : context.quotes,
        impact: walletWide ? 'wallet_wide' : 'token_specific',
        reason: 'unresolved_wallet_effect',
      });
    }
    const hasEconomicMovement = evidence.structured_swap_groups.length
      || evidence.token_transfer_legs.length || evidence.native_sol_transfer_legs.length;
    if (!hasEconomicMovement) return outcome('no_supported_operation', { reason: 'no_economic_wallet_movement' });
    if (evidence.fee_payer !== evidence.wallet) return unsupported(context, 'unsupported_swap_shape');
    if (evidence.account_closures.length && (evidence.native_sol_transfer_legs.length
        || evidence.structured_swap_groups.some(group => group.native_inputs.length || group.native_outputs.length))) {
      return unsupported(context, 'native_side_with_account_close');
    }
    if (evidence.recognized_programs.length === 0 && evidence.structured_swap_groups.length) return unsupported(context, 'recognized_dex_required');
    return evidence.structured_swap_groups.length
      ? normalizeStructured(evidence, context, input.provisional_raw_index)
      : normalizeFallback(evidence, context, input.provisional_raw_index);
  } catch (error) {
    if (error?.name === 'WalletSpotEvidenceError') throw error;
    failSpotEvidenceV1('normalization_failed');
  }
}
