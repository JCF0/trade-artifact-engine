import { fail } from './errors.mjs';
import { assertPlainJsonValue, cloneAndFreeze } from './plain-data.mjs';
import { roundPct, roundPrice } from '../ledger/precision.mjs';
import { MARK_PROFILE_MAX_AGE_SECONDS, MARK_PROFILE_VERSION, validateBoundaryV1, validateMarkObservationV1 } from './schema.mjs';

const MARK_PROFILE = MARK_PROFILE_VERSION;
const REASON_TO_FRESHNESS = Object.freeze({
  mark_source_unavailable: 'unavailable',
  mark_stale: 'stale',
  mark_quote_mismatch: 'quote_mismatch',
  mark_after_snapshot_boundary: 'after_boundary',
  snapshot_boundary_unavailable: 'unavailable',
});

function unavailableMark(reasonCode) {
  return {
    status: 'unavailable',
    mark_profile: MARK_PROFILE,
    mark_price_raw_quote: null,
    mark_observed_at: null,
    mark_source_slot: null,
    freshness_status: REASON_TO_FRESHNESS[reasonCode] ?? 'unavailable',
    reason_code: reasonCode,
  };
}

function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) fail('invalid_snapshot_input', `${field} must be a finite number`);
  return value;
}

function resolveMark(position, boundary, observation) {
  if (observation === null) return unavailableMark('mark_source_unavailable');
  validateMarkObservationV1(observation);
  if (observation.token_mint !== position.token_mint || observation.quote_mint !== position.quote_mint) return unavailableMark('mark_quote_mismatch');
  if (observation.observation_status === 'unavailable') return unavailableMark(observation.reason_code);
  if (observation.source_slot > boundary.anchor_slot || observation.observed_at > boundary.anchor_block_time) return unavailableMark('mark_after_snapshot_boundary');
  if (boundary.anchor_block_time - observation.observed_at > MARK_PROFILE_MAX_AGE_SECONDS) return unavailableMark('mark_stale');
  return {
    status: 'available',
    mark_profile: observation.source_profile,
    mark_price_raw_quote: observation.mark_price_raw_quote,
    mark_observed_at: observation.observed_at,
    mark_source_slot: observation.source_slot,
    freshness_status: 'fresh',
    reason_code: null,
  };
}

export function buildOpenPositionSnapshotV1(input) {
  assertPlainJsonValue(input, ['open_snapshot_input']);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('invalid_snapshot_input', 'open snapshot input must be an object');
  const fields = ['position','boundary','markObservation'];
  const required = fields;
  const keys = Object.keys(input);
  if (keys.some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(input, key))) fail('invalid_snapshot_input', 'open snapshot input fields are invalid');
  if (input.boundary === null) fail('snapshot_boundary_unavailable', 'an authoritative snapshot boundary is required');
  validateBoundaryV1(input.boundary);
  const position = input.position;
  if (position === null || typeof position !== 'object' || Array.isArray(position) || !['realized_partial','open_snapshot'].includes(position.candidate_type)) fail('invalid_snapshot_input', 'snapshot position is invalid');
  for (const field of ['token_mint','quote_mint']) if (typeof position[field] !== 'string' || position[field].length === 0) fail('invalid_snapshot_input', `position ${field} is invalid`);
  const remainingQty = finiteNumber(position.remaining_qty, 'remaining_qty');
  const remainingBasis = finiteNumber(position.remaining_cost_basis_quote, 'remaining_cost_basis_quote');
  const isPartial = position.candidate_type === 'realized_partial';
  const realizedPnl = isPartial ? finiteNumber(position.realized_pnl_quote, 'realized_pnl_quote') : 0;
  const realizedPct = isPartial
    ? (position.realized_pnl_pct === null ? null : finiteNumber(position.realized_pnl_pct, 'realized_pnl_pct'))
    : null;
  const mark = resolveMark(position, input.boundary, input.markObservation);
  let unrealizedPnl = null;
  if (mark.status === 'available' && mark.freshness_status === 'fresh') {
    const marketValue = roundPrice(remainingQty * mark.mark_price_raw_quote);
    const unrealized = roundPrice(marketValue - remainingBasis);
    unrealizedPnl = {
      unrealized_pnl_version: 'unrealized_pnl_raw_quote_v1',
      market_value_quote: marketValue,
      unrealized_pnl_quote: unrealized,
      unrealized_pnl_pct: remainingBasis > 0 ? roundPct((unrealized / remainingBasis) * 100) : null,
    };
  }
  const disclosureCodes = isPartial
    ? ['open_outcome_not_final','partial_exit_position_remains_open']
    : ['open_outcome_not_final'];
  return cloneAndFreeze({
    snapshot_version: 'open_position_snapshot_v1',
    snapshot_at: input.boundary.anchor_block_time,
    source_boundary: {
      boundary_type: 'authoritative_acquisition_boundary_v1',
      chain: input.boundary.chain,
      network: input.boundary.network,
      genesis_hash: input.boundary.genesis_hash,
      source_slot: input.boundary.anchor_slot,
      source_block_time: input.boundary.anchor_block_time,
      source_blockhash: input.boundary.anchor_blockhash,
      boundary_status: input.boundary.boundary_status,
    },
    remaining_qty: remainingQty,
    remaining_cost_basis_quote: remainingBasis,
    realized_pnl_to_date_quote: realizedPnl,
    realized_pnl_to_date_pct: realizedPct,
    mark,
    unrealized_pnl: unrealizedPnl,
    disclosure_codes: disclosureCodes,
  });
}

export const buildOpenSnapshotV1 = buildOpenPositionSnapshotV1;
