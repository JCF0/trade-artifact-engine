import { buildPositionLedger } from '../ledger/position-ledger.mjs';
import { computeCandidateHash, generateReceiptCandidates } from '../ledger/receipt-candidates.mjs';
import { canonicalizeActivityFindingsV1 } from './activity-findings.mjs';
import { fail } from './errors.mjs';
import { buildCandidateV1 } from './identity.mjs';
import { compareCodeUnits } from './order.mjs';
import { assertPlainJsonValue } from './plain-data.mjs';
import { validateBoundaryV1 } from './schema.mjs';
import { buildOpenPositionSnapshotV1 } from './open-snapshot.mjs';
import { validateReceiptScopedEvidenceV1 } from './receipt-scoped-evidence.mjs';
import { canonicalJson } from './serialize.mjs';

const ACCOUNTING_METHOD = 'weighted_average_position_accounting_v1';
const LIMITED_FLAGS = new Set(['partial_history','unsupported_inventory','external_transfer_possible','negative_inventory']);

function uniqueSorted(values) { return [...new Set(values)].sort(compareCodeUnits); }
function finite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) fail('invalid_ledger_candidate', `${field} must be a finite number`);
  return value;
}

function recomputeLegacyHash(candidate) {
  return computeCandidateHash({
    candidate_type: candidate.candidate_type,
    candidate_version: candidate.candidate_version,
    wallet: candidate.wallet,
    chain: candidate.chain,
    token_mint: candidate.token_mint,
    quote_mint: candidate.quote_mint,
    quote_symbol: candidate.quote_symbol,
    valuation_status: candidate.valuation_status,
    segment_index: candidate.segment_index,
    first_event_at: candidate.first_event_at,
    last_event_at: candidate.last_event_at,
    entry_tx_hashes: candidate.entry_tx_hashes,
    exit_tx_hashes: candidate.exit_tx_hashes,
    total_bought_qty: candidate.total_bought_qty,
    total_bought_quote: candidate.total_bought_quote,
    total_sold_qty: candidate.total_sold_qty,
    total_sold_quote: candidate.total_sold_quote,
    allocated_cost_basis_quote: candidate.allocated_cost_basis_quote,
    remaining_qty: candidate.remaining_qty,
    remaining_cost_basis_quote: candidate.remaining_cost_basis_quote,
    realized_pnl_quote: candidate.realized_pnl_quote,
    realized_pnl_pct: candidate.realized_pnl_pct,
    flags: candidate.flags,
    accounting_method: candidate.accounting_method,
  });
}

function validateLegacyCandidate(candidate, evidence, boundary) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) fail('invalid_ledger_candidate', 'ledger candidate must be an object');
  if (!['closed_position','realized_partial','open_snapshot'].includes(candidate.candidate_type) || candidate.wallet !== evidence.wallet || candidate.token_mint !== evidence.token_mint || candidate.chain !== 'solana') fail('candidate_evidence_scope_mismatch', 'ledger candidate does not match receipt-scoped evidence');
  if (candidate.accounting_method !== ACCOUNTING_METHOD || candidate.ledger_accounting_version !== ACCOUNTING_METHOD) fail('unsupported_profile', 'ledger accounting profile is unsupported');
  if (typeof candidate.candidate_hash !== 'string' || recomputeLegacyHash(candidate) !== candidate.candidate_hash) fail('ledger_candidate_hash_mismatch', 'legacy candidate hash does not recompute');
  const reconstructedLedger = buildPositionLedger(evidence.events);
  const reconstructedCandidates = generateReceiptCandidates(reconstructedLedger, evidence.wallet, { snapshotAt: boundary.anchor_block_time });
  const reconstructed = reconstructedCandidates.find(item => item.candidate_type === candidate.candidate_type && item.token_mint === candidate.token_mint && item.segment_index === candidate.segment_index);
  if (reconstructed === undefined || canonicalJson(reconstructed) !== canonicalJson(candidate)) {
    const differing_fields = reconstructed === undefined ? [] : [...new Set([...Object.keys(reconstructed), ...Object.keys(candidate)])].filter(key => canonicalJson(reconstructed[key]) !== canonicalJson(candidate[key]));
    fail('ledger_candidate_reconstruction_mismatch', 'legacy candidate does not exactly match receipt-scoped ledger reconstruction', { differing_fields });
  }
}

function commonEconomics(candidate) {
  const openSnapshot = candidate.candidate_type === 'open_snapshot';
  return {
    total_bought_qty: finite(candidate.total_bought_qty, 'total_bought_qty'),
    total_bought_quote: finite(candidate.total_bought_quote, 'total_bought_quote'),
    avg_buy_quote_price: finite(candidate.avg_buy_quote_price, 'avg_buy_quote_price'),
    total_sold_qty: openSnapshot ? 0 : finite(candidate.total_sold_qty, 'total_sold_qty'),
    total_sold_quote: openSnapshot ? 0 : finite(candidate.total_sold_quote, 'total_sold_quote'),
    avg_sell_quote_price: openSnapshot ? 0 : finite(candidate.avg_sell_quote_price, 'avg_sell_quote_price'),
    allocated_cost_basis_quote: openSnapshot ? 0 : finite(candidate.allocated_cost_basis_quote, 'allocated_cost_basis_quote'),
    remaining_qty: finite(candidate.remaining_qty, 'remaining_qty'),
    remaining_cost_basis_quote: finite(candidate.remaining_cost_basis_quote, 'remaining_cost_basis_quote'),
    entry_count: candidate.num_buys,
    exit_count: candidate.num_sells,
    accounting_method: candidate.accounting_method,
  };
}

function buildEconomics(candidate) {
  const common = commonEconomics(candidate);
  if (candidate.candidate_type === 'closed_position') return {
    economics_type: 'closed_position_raw_quote_v1', ...common,
    realized_pnl_quote: finite(candidate.realized_pnl_quote, 'realized_pnl_quote'),
    realized_pnl_pct: finite(candidate.realized_pnl_pct, 'realized_pnl_pct'),
    hold_time_seconds: finite(candidate.last_event_at - candidate.first_event_at, 'hold_time_seconds'),
    close_reason_code: null,
    dust_classification_code: candidate.flags.includes('dust_closed') ? 'dust_closed' : null,
  };
  if (candidate.candidate_type === 'realized_partial') return {
    economics_type: 'realized_partial_raw_quote_v1', ...common,
    realized_pnl_quote: finite(candidate.realized_pnl_quote, 'realized_pnl_quote'),
    realized_pnl_pct: finite(candidate.realized_pnl_pct, 'realized_pnl_pct'),
  };
  return {
    economics_type: 'open_position_raw_quote_v1', ...common,
    realized_pnl_to_date_quote: 0,
    realized_pnl_to_date_pct: null,
  };
}

function valuationStatus(snapshot) {
  if (snapshot.mark.status === 'available') return 'mark_available';
  return ({
    mark_stale: 'mark_stale',
    mark_quote_mismatch: 'mark_quote_mismatch',
    mark_after_snapshot_boundary: 'mark_after_boundary',
  })[snapshot.mark.reason_code] ?? 'mark_unavailable';
}

export function projectCandidateV1(input) {
  assertPlainJsonValue(input, ['candidate_projection_input']);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('invalid_candidate_projection_input', 'candidate projection input must be an object');
  const fields = ['ledgerCandidate','receiptScopedEvidence','boundary','markObservation','associatedFindings'];
  const keys = Object.keys(input);
  if (keys.some(key => !fields.includes(key)) || fields.some(field => !Object.hasOwn(input, field))) fail('invalid_candidate_projection_input', 'candidate projection input fields are invalid');
  validateReceiptScopedEvidenceV1(input.receiptScopedEvidence);
  validateBoundaryV1(input.boundary);
  if (!Array.isArray(input.associatedFindings)) fail('invalid_candidate_projection_input', 'associated findings must be an array');
  const findings = canonicalizeActivityFindingsV1(input.associatedFindings);
  if (findings.some(finding => finding.impact.blocks_candidate_projection || !finding.affected_token_mints.includes(input.receiptScopedEvidence.token_mint))) fail('blocked_token_candidate_forbidden', 'blocked or unrelated finding cannot be attached to an authoritative candidate');
  const candidate = input.ledgerCandidate;
  validateLegacyCandidate(candidate, input.receiptScopedEvidence, input.boundary);
  const limited = candidate.status === 'partial_history' || candidate.flags.some(flag => LIMITED_FLAGS.has(flag));
  const isClosed = candidate.candidate_type === 'closed_position';
  const snapshot = isClosed ? null : buildOpenPositionSnapshotV1({ position: candidate, boundary: input.boundary, markObservation: input.markObservation });
  const cleanEligible = isClosed && !limited && candidate.status === 'closed' && candidate.eligible_for_closed_position_receipt === true && candidate.eligible_for_verified_receipt === true;
  const disclosureCodes = uniqueSorted([
    ...(snapshot?.disclosure_codes ?? []),
    ...findings.flatMap(finding => finding.disclosure_codes),
  ]);
  const projection = {
    candidate_type: candidate.candidate_type,
    position_status: isClosed ? 'closed' : 'open',
    ledger_evidence_status: limited ? 'limited_partial_history' : 'clean',
    boundary_status: isClosed ? 'not_applicable' : 'proven',
    valuation_status: isClosed ? 'raw_quote' : valuationStatus(snapshot),
    selection_status: cleanEligible ? 'selectable' : 'visible_only',
    package_eligibility: cleanEligible ? 'eligible_closed_position_v1' : 'not_publication_eligible_v1',
    chain: 'solana',
    network: 'mainnet-beta',
    wallet: candidate.wallet,
    token_mint: candidate.token_mint,
    quote_mint: candidate.quote_mint,
    quote_symbol_code: candidate.quote_symbol,
    segment_index: candidate.segment_index,
    first_event_at: candidate.first_event_at,
    last_event_at: candidate.last_event_at,
    event_counts: { buys: candidate.num_buys, sells: candidate.num_sells, supported_events: input.receiptScopedEvidence.events.length, associated_findings: findings.length },
    ledger_eligibility: { eligible_for_closed_position: candidate.eligible_for_closed_position_receipt, eligible_for_verified_receipt: candidate.eligible_for_verified_receipt },
    economics: buildEconomics(candidate),
    snapshot,
    flags: uniqueSorted(candidate.flags),
    limitations: uniqueSorted(candidate.warnings),
    reason_codes: uniqueSorted(findings.flatMap(finding => finding.reason_codes)),
    disclosure_codes: disclosureCodes,
  };
  return buildCandidateV1({
    ledger_candidate_hash: candidate.candidate_hash,
    receipt_scoped_evidence_digest: input.receiptScopedEvidence.receipt_scoped_evidence_digest,
    selection_key: { wallet: candidate.wallet, token_mint: candidate.token_mint, receipt_type: candidate.candidate_type, segment_index: candidate.segment_index },
    projection,
  });
}

export const buildCandidateProjectionV1 = projectCandidateV1;
