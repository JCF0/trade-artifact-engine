import { types as utilTypes } from 'node:util';

import { buildWalletSourceTransactionV1 } from './source-transaction.mjs';

export const SOLANA_SPOT_EVIDENCE_VERSION_V1 = 'solana_spot_evidence_v1';

const RECOGNIZED_SPOT_PROGRAMS = Object.freeze([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
]);
const RECOGNIZED_SPOT_PROGRAM_SET = new Set(RECOGNIZED_SPOT_PROGRAMS);
const TOP_FIELDS = [
  'spot_evidence_version','signature','slot','block_time','execution_state','wallet','fee_payer',
  'provider_transaction_type','recognized_programs','structured_swap_groups','token_transfer_legs',
  'native_sol_transfer_legs','account_closures','unresolved_wallet_effects',
];
const PROGRAM_FIELDS = ['program_id'];
const SWAP_GROUP_FIELDS = ['group_id','token_inputs','token_outputs','native_inputs','native_outputs'];
const TOKEN_SWAP_LEG_FIELDS = ['leg_id','owner','mint','raw_amount','decimals'];
const NATIVE_SWAP_LEG_FIELDS = ['leg_id','owner','amount_lamports'];
const TOKEN_TRANSFER_FIELDS = ['leg_id','economic_group','direction','owner','mint','raw_amount','decimals'];
const NATIVE_TRANSFER_FIELDS = ['leg_id','economic_group','direction','owner','amount_lamports'];
const CLOSURE_FIELDS = ['closure_id','owner','mint'];
const UNRESOLVED_FIELDS = ['effect_id','mint'];
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RAW_AMOUNT = /^[1-9][0-9]*$/;
const MAX_DEPTH = 128;
const MAX_NODES = 100000;

const ERROR_MESSAGES = Object.freeze({
  invalid_spot_evidence: 'spot evidence is invalid',
  spot_evidence_mismatch: 'spot evidence does not match its wallet scope',
  normalization_failed: 'spot normalization failed',
  normalization_ambiguous: 'spot normalization is ambiguous',
  unsupported_swap_shape: 'spot swap shape is unsupported',
});

export class WalletSpotEvidenceError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'invalid_spot_evidence';
    super(ERROR_MESSAGES[safeCode]);
    delete this.stack;
    this.name = 'WalletSpotEvidenceError';
    this.code = safeCode;
    this.details = Object.freeze({});
  }
}

export function failSpotEvidenceV1(code) {
  throw new WalletSpotEvidenceError(code);
}

function assertPlain(value, active = new Set(), depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) failSpotEvidenceV1('invalid_spot_evidence');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) failSpotEvidenceV1('invalid_spot_evidence');
    return;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value) || active.has(value)) failSpotEvidenceV1('invalid_spot_evidence');
  let prototype;
  let descriptors;
  let symbols;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    failSpotEvidenceV1('invalid_spot_evidence');
  }
  const array = Array.isArray(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) || symbols.length !== 0) failSpotEvidenceV1('invalid_spot_evidence');
  const entries = Object.entries(descriptors).filter(([key]) => !(array && key === 'length'));
  if (array && (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))) failSpotEvidenceV1('invalid_spot_evidence');
  active.add(value);
  for (const [, descriptor] of entries) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) failSpotEvidenceV1('invalid_spot_evidence');
    assertPlain(descriptor.value, active, depth + 1, budget);
  }
  active.delete(value);
}

function exact(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) failSpotEvidenceV1('invalid_spot_evidence');
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) {
    failSpotEvidenceV1('invalid_spot_evidence');
  }
}

function identifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function decimals(value) {
  return safeInteger(value) && value <= 255;
}

function rawAmount(value) {
  return typeof value === 'string' && RAW_AMOUNT.test(value);
}

function array(value) {
  if (!Array.isArray(value)) failSpotEvidenceV1('invalid_spot_evidence');
  return value;
}

function assertOwned(owner, wallet) {
  if (owner !== wallet) failSpotEvidenceV1('spot_evidence_mismatch');
}

function validateTokenSwapLeg(leg, wallet) {
  exact(leg, TOKEN_SWAP_LEG_FIELDS);
  if (!identifier(leg.leg_id) || !identifier(leg.owner) || !identifier(leg.mint)
      || !rawAmount(leg.raw_amount) || !decimals(leg.decimals)) failSpotEvidenceV1('invalid_spot_evidence');
  assertOwned(leg.owner, wallet);
}

function validateNativeSwapLeg(leg, wallet) {
  exact(leg, NATIVE_SWAP_LEG_FIELDS);
  if (!identifier(leg.leg_id) || !identifier(leg.owner) || !safeInteger(leg.amount_lamports) || leg.amount_lamports === 0) {
    failSpotEvidenceV1('invalid_spot_evidence');
  }
  assertOwned(leg.owner, wallet);
}

function validateTransferGroup(value) {
  if (value !== null && !identifier(value)) failSpotEvidenceV1('invalid_spot_evidence');
}

function validateEvidence(evidence) {
  exact(evidence, TOP_FIELDS);
  if (evidence.spot_evidence_version !== SOLANA_SPOT_EVIDENCE_VERSION_V1
      || !identifier(evidence.signature) || !safeInteger(evidence.slot) || !safeInteger(evidence.block_time)
      || !['succeeded','failed'].includes(evidence.execution_state) || !identifier(evidence.wallet)
      || !identifier(evidence.fee_payer) || (evidence.provider_transaction_type !== null
        && (typeof evidence.provider_transaction_type !== 'string' || !PROVIDER_TYPE.test(evidence.provider_transaction_type)))) {
    failSpotEvidenceV1('invalid_spot_evidence');
  }
  for (const program of array(evidence.recognized_programs)) {
    exact(program, PROGRAM_FIELDS);
    if (!isRecognizedSpotProgramV1(program.program_id)) failSpotEvidenceV1('invalid_spot_evidence');
  }
  for (const group of array(evidence.structured_swap_groups)) {
    exact(group, SWAP_GROUP_FIELDS);
    if (!identifier(group.group_id)) failSpotEvidenceV1('invalid_spot_evidence');
    array(group.token_inputs).forEach(leg => validateTokenSwapLeg(leg, evidence.wallet));
    array(group.token_outputs).forEach(leg => validateTokenSwapLeg(leg, evidence.wallet));
    array(group.native_inputs).forEach(leg => validateNativeSwapLeg(leg, evidence.wallet));
    array(group.native_outputs).forEach(leg => validateNativeSwapLeg(leg, evidence.wallet));
  }
  for (const leg of array(evidence.token_transfer_legs)) {
    exact(leg, TOKEN_TRANSFER_FIELDS);
    validateTransferGroup(leg.economic_group);
    if (!identifier(leg.leg_id) || !['debit','credit'].includes(leg.direction) || !identifier(leg.owner)
        || !identifier(leg.mint) || !rawAmount(leg.raw_amount) || !decimals(leg.decimals)) failSpotEvidenceV1('invalid_spot_evidence');
    assertOwned(leg.owner, evidence.wallet);
  }
  for (const leg of array(evidence.native_sol_transfer_legs)) {
    exact(leg, NATIVE_TRANSFER_FIELDS);
    validateTransferGroup(leg.economic_group);
    if (!identifier(leg.leg_id) || !['debit','credit'].includes(leg.direction) || !identifier(leg.owner)
        || !safeInteger(leg.amount_lamports) || leg.amount_lamports === 0) failSpotEvidenceV1('invalid_spot_evidence');
    assertOwned(leg.owner, evidence.wallet);
  }
  for (const closure of array(evidence.account_closures)) {
    exact(closure, CLOSURE_FIELDS);
    if (!identifier(closure.closure_id) || !identifier(closure.owner) || !identifier(closure.mint)) failSpotEvidenceV1('invalid_spot_evidence');
    assertOwned(closure.owner, evidence.wallet);
  }
  for (const effect of array(evidence.unresolved_wallet_effects)) {
    exact(effect, UNRESOLVED_FIELDS);
    if (!identifier(effect.effect_id) || (effect.mint !== null && !identifier(effect.mint))) failSpotEvidenceV1('invalid_spot_evidence');
  }
  const ids = [
    ...evidence.structured_swap_groups.flatMap(group => [...group.token_inputs, ...group.token_outputs, ...group.native_inputs, ...group.native_outputs].map(leg => leg.leg_id)),
    ...evidence.token_transfer_legs.map(leg => leg.leg_id),
    ...evidence.native_sol_transfer_legs.map(leg => leg.leg_id),
    ...evidence.account_closures.map(item => item.closure_id),
    ...evidence.unresolved_wallet_effects.map(item => item.effect_id),
  ];
  const groups = evidence.structured_swap_groups.map(group => group.group_id);
  const programs = evidence.recognized_programs.map(program => program.program_id);
  if (new Set(ids).size !== ids.length || new Set(groups).size !== groups.length || new Set(programs).size !== programs.length) {
    failSpotEvidenceV1('invalid_spot_evidence');
  }
  return true;
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

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(evidence) {
  const result = clone(evidence);
  result.recognized_programs.sort((left, right) => compareCodeUnits(left.program_id, right.program_id));
  result.structured_swap_groups.sort((left, right) => compareCodeUnits(left.group_id, right.group_id));
  for (const group of result.structured_swap_groups) {
    for (const field of ['token_inputs','token_outputs','native_inputs','native_outputs']) {
      group[field].sort((left, right) => compareCodeUnits(left.leg_id, right.leg_id));
    }
  }
  result.token_transfer_legs.sort((left, right) => compareCodeUnits(left.leg_id, right.leg_id));
  result.native_sol_transfer_legs.sort((left, right) => compareCodeUnits(left.leg_id, right.leg_id));
  result.account_closures.sort((left, right) => compareCodeUnits(left.closure_id, right.closure_id));
  result.unresolved_wallet_effects.sort((left, right) => compareCodeUnits(left.effect_id, right.effect_id));
  return freeze(result);
}

function amountFromRaw(raw, valueDecimals) {
  const amount = Number(BigInt(raw)) / (10 ** valueDecimals);
  if (!Number.isFinite(amount) || amount <= 0) failSpotEvidenceV1('invalid_spot_evidence');
  return amount;
}

export function isRecognizedSpotProgramV1(programId) {
  return typeof programId === 'string' && RECOGNIZED_SPOT_PROGRAM_SET.has(programId);
}

export function validateSolanaSpotEvidenceV1(evidence) {
  try {
    assertPlain(evidence);
    return validateEvidence(evidence);
  } catch (error) {
    if (error?.name === 'WalletSpotEvidenceError') throw error;
    failSpotEvidenceV1('invalid_spot_evidence');
  }
}

export function buildSolanaSpotEvidenceV1(input) {
  validateSolanaSpotEvidenceV1(input);
  return canonicalize(input);
}

export function buildWalletSourceTransactionFromSpotEvidenceV1(input) {
  const evidence = buildSolanaSpotEvidenceV1(input);
  const tokenOperations = [];
  const nativeOperations = [];
  for (const group of evidence.structured_swap_groups) {
    for (const [field, direction] of [['token_inputs','debit'], ['token_outputs','credit']]) {
      for (const leg of group[field]) tokenOperations.push({
        operation_id: leg.leg_id, economic_group: group.group_id, operation_kind: 'swap', direction,
        owner: leg.owner, mint: leg.mint, amount: amountFromRaw(leg.raw_amount, leg.decimals), decimals: leg.decimals,
      });
    }
    for (const [field, direction] of [['native_inputs','debit'], ['native_outputs','credit']]) {
      for (const leg of group[field]) nativeOperations.push({
        operation_id: leg.leg_id, economic_group: group.group_id, operation_kind: 'swap', direction,
        owner: leg.owner, amount_lamports: leg.amount_lamports,
      });
    }
  }
  for (const leg of evidence.token_transfer_legs) {
    tokenOperations.push({
      operation_id: leg.leg_id, economic_group: leg.economic_group, operation_kind: 'transfer', direction: leg.direction,
      owner: leg.owner, mint: leg.mint, amount: amountFromRaw(leg.raw_amount, leg.decimals), decimals: leg.decimals,
    });
  }
  for (const leg of evidence.native_sol_transfer_legs) {
    nativeOperations.push({
      operation_id: leg.leg_id, economic_group: leg.economic_group, operation_kind: 'transfer', direction: leg.direction,
      owner: leg.owner, amount_lamports: leg.amount_lamports,
    });
  }
  for (const closure of evidence.account_closures) tokenOperations.push({
    operation_id: closure.closure_id, economic_group: null, operation_kind: 'account_close', direction: 'none',
    owner: closure.owner, mint: closure.mint, amount: null, decimals: null,
  });
  for (const effect of evidence.unresolved_wallet_effects) tokenOperations.push({
    operation_id: effect.effect_id, economic_group: null, operation_kind: 'unknown', direction: 'unknown',
    owner: evidence.wallet, mint: effect.mint, amount: null, decimals: null,
  });
  return buildWalletSourceTransactionV1({
    source_transaction_version: 'wallet_source_transaction_v1',
    signature: evidence.signature,
    slot: evidence.slot,
    block_time: evidence.block_time,
    execution_state: evidence.execution_state,
    provider_failure_indicator: evidence.execution_state,
    wallet: evidence.wallet,
    fee_payer: evidence.fee_payer,
    token_operations: tokenOperations,
    native_sol_operations: nativeOperations,
    provider_classification_code: evidence.provider_transaction_type,
    recognized_programs: evidence.recognized_programs.map(program => ({ ...program, program_role: 'spot_swap' })),
  });
}
