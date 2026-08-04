import {
  assertExactFieldsV1,
  assertSafeNonnegativeIntegerV1,
  assertSafePositiveIntegerV1,
  cloneAndFreezePlainDataV1,
  failWalletAcquisitionV1,
} from './errors.mjs';
import {
  MAX_ANCHOR_SEARCH_SLOTS_V1,
  SOLANA_MAINNET_GENESIS_HASH,
} from './request-contract.mjs';

export const FINALIZED_BOUNDARY_VERSION_V1 = 'solana_finalized_acquisition_boundary_v1';
export const FINALIZED_ANCHOR_SEARCH_STATE_VERSION_V1 = 'solana_finalized_anchor_search_state_v1';

const BOUNDARY_FIELDS = ['boundary_version','chain','network','genesis_hash','commitment','anchor_slot','anchor_block_time','anchor_blockhash','history_complete_through_anchor','lower_bound_completion_proven','boundary_status'];
const LOWER_BOUND_INPUT_FIELDS = ['anchor_block_time','requested_lookback_seconds'];
const SEARCH_INPUT_FIELDS = ['initial_slot','max_anchor_search_slots'];
const SEARCH_STATE_FIELDS = ['search_state_version','initial_slot','next_slot','slots_examined','max_anchor_search_slots','search_status','anchor_slot'];
const BLOCKHASH_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export function deriveOldestAllowedTimestampV1(input) {
  assertExactFieldsV1(input, LOWER_BOUND_INPUT_FIELDS, 'lookback_boundary_mismatch');
  assertSafeNonnegativeIntegerV1(input.anchor_block_time, 'lookback_boundary_mismatch');
  assertSafePositiveIntegerV1(input.requested_lookback_seconds, 'lookback_boundary_mismatch');
  const oldest = input.anchor_block_time - input.requested_lookback_seconds;
  if (!Number.isSafeInteger(oldest) || oldest < 0) failWalletAcquisitionV1('lookback_boundary_mismatch');
  return oldest;
}

export function validateFinalizedAcquisitionBoundaryV1(boundary) {
  assertExactFieldsV1(boundary, BOUNDARY_FIELDS, 'finalized_boundary_incoherent');
  if (boundary.chain !== 'solana' || boundary.network !== 'mainnet-beta' || boundary.genesis_hash !== SOLANA_MAINNET_GENESIS_HASH) failWalletAcquisitionV1('chain_identity_mismatch');
  if (boundary.boundary_version !== FINALIZED_BOUNDARY_VERSION_V1 || boundary.commitment !== 'finalized' || boundary.boundary_status !== 'proven') failWalletAcquisitionV1('finalized_boundary_incoherent');
  assertSafeNonnegativeIntegerV1(boundary.anchor_slot, 'finalized_boundary_incoherent');
  assertSafeNonnegativeIntegerV1(boundary.anchor_block_time, 'finalized_boundary_incoherent');
  if (typeof boundary.anchor_blockhash !== 'string' || !BLOCKHASH_PATTERN.test(boundary.anchor_blockhash)) failWalletAcquisitionV1('finalized_boundary_incoherent');
  if (boundary.history_complete_through_anchor !== true) failWalletAcquisitionV1('latest_state_unproven');
  if (boundary.lower_bound_completion_proven !== true) failWalletAcquisitionV1('lower_bound_unproven');
  return true;
}

export function buildFinalizedAcquisitionBoundaryV1(input) {
  validateFinalizedAcquisitionBoundaryV1(input);
  return cloneAndFreezePlainDataV1(input, 'finalized_boundary_incoherent');
}

export function validateFinalizedAnchorSearchStateV1(state) {
  assertExactFieldsV1(state, SEARCH_STATE_FIELDS, 'finalized_boundary_incoherent');
  if (state.search_state_version !== FINALIZED_ANCHOR_SEARCH_STATE_VERSION_V1 || state.max_anchor_search_slots !== MAX_ANCHOR_SEARCH_SLOTS_V1) failWalletAcquisitionV1('finalized_boundary_incoherent');
  assertSafeNonnegativeIntegerV1(state.initial_slot, 'finalized_boundary_incoherent');
  assertSafeNonnegativeIntegerV1(state.slots_examined, 'finalized_boundary_incoherent');
  if (state.slots_examined > MAX_ANCHOR_SEARCH_SLOTS_V1 || !['searching','found','exhausted'].includes(state.search_status)) failWalletAcquisitionV1('finalized_boundary_incoherent');

  if (state.search_status === 'searching') {
    if (state.slots_examined >= MAX_ANCHOR_SEARCH_SLOTS_V1 || state.anchor_slot !== null) failWalletAcquisitionV1('finalized_boundary_incoherent');
    const expectedNext = state.initial_slot - state.slots_examined;
    if (!Number.isSafeInteger(expectedNext) || expectedNext < 0 || state.next_slot !== expectedNext) failWalletAcquisitionV1('finalized_boundary_incoherent');
  } else if (state.search_status === 'found') {
    if (state.slots_examined < 1 || state.slots_examined > MAX_ANCHOR_SEARCH_SLOTS_V1 || state.next_slot !== null) failWalletAcquisitionV1('finalized_boundary_incoherent');
    const expectedAnchor = state.initial_slot - (state.slots_examined - 1);
    if (!Number.isSafeInteger(expectedAnchor) || expectedAnchor < 0 || state.anchor_slot !== expectedAnchor) failWalletAcquisitionV1('finalized_boundary_incoherent');
  } else {
    const availableSlots = Math.min(MAX_ANCHOR_SEARCH_SLOTS_V1, state.initial_slot + 1);
    if (state.slots_examined !== availableSlots || state.next_slot !== null || state.anchor_slot !== null) failWalletAcquisitionV1('finalized_boundary_incoherent');
  }
  return true;
}

export function createFinalizedAnchorSearchStateV1(input) {
  assertExactFieldsV1(input, SEARCH_INPUT_FIELDS, 'finalized_boundary_incoherent');
  assertSafeNonnegativeIntegerV1(input.initial_slot, 'finalized_boundary_incoherent');
  if (input.max_anchor_search_slots !== MAX_ANCHOR_SEARCH_SLOTS_V1) failWalletAcquisitionV1('finalized_boundary_incoherent');
  return cloneAndFreezePlainDataV1({
    search_state_version: FINALIZED_ANCHOR_SEARCH_STATE_VERSION_V1,
    initial_slot: input.initial_slot,
    next_slot: input.initial_slot,
    slots_examined: 0,
    max_anchor_search_slots: MAX_ANCHOR_SEARCH_SLOTS_V1,
    search_status: 'searching',
    anchor_slot: null,
  }, 'finalized_boundary_incoherent');
}

export function advanceFinalizedAnchorSearchStateV1(state, outcome) {
  validateFinalizedAnchorSearchStateV1(state);
  if (state.search_status !== 'searching') failWalletAcquisitionV1('finalized_boundary_unavailable');
  if (!['found','unavailable'].includes(outcome)) failWalletAcquisitionV1('finalized_boundary_incoherent');
  const slotsExamined = state.slots_examined + 1;
  if (outcome === 'found') {
    return cloneAndFreezePlainDataV1({
      ...state,
      next_slot: null,
      slots_examined: slotsExamined,
      search_status: 'found',
      anchor_slot: state.next_slot,
    }, 'finalized_boundary_incoherent');
  }
  if (slotsExamined === MAX_ANCHOR_SEARCH_SLOTS_V1 || state.next_slot === 0) {
    return cloneAndFreezePlainDataV1({
      ...state,
      next_slot: null,
      slots_examined: slotsExamined,
      search_status: 'exhausted',
      anchor_slot: null,
    }, 'finalized_boundary_incoherent');
  }
  return cloneAndFreezePlainDataV1({
    ...state,
    next_slot: state.next_slot - 1,
    slots_examined: slotsExamined,
  }, 'finalized_boundary_incoherent');
}
