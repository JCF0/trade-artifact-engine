import { fail, WalletCandidateSetError } from './errors.mjs';
import { assertPlainJsonValue } from './plain-data.mjs';
import { compareCodeUnits } from './order.mjs';
import { sha256CanonicalJson } from './serialize.mjs';

export { WalletCandidateSetError };
export const GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const SOLANA_GENESIS_HASH = GENESIS_HASH;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const SOURCE_TRANSACTION_REFERENCE_VERSION = 'source_transaction_reference_v1';
export const ACQUISITION_RESULT_VERSION = 'wallet_wide_acquisition_result_v1';
export const EVIDENCE_BUNDLE_VERSION = 'candidate_evidence_bundle_v1';
export const FINDING_VERSION = 'wallet_activity_finding_v1';
export const DISPOSITION_VERSION = 'wallet_transaction_disposition_v1';
export const EVENT_RECORD_VERSION = 'wallet_normalized_event_record_v1';
export const MARK_OBSERVATION_VERSION = 'wallet_mark_observation_v1';
export const CANDIDATE_VERSION = 'wallet_candidate_projection_v1';
export const CANDIDATE_IDENTITY_VERSION = 'wallet_candidate_identity_v1';
export const BLOCKED_SUMMARY_VERSION = 'wallet_blocked_candidate_summary_v1';
export const CANDIDATE_SET_VERSION = 'wallet_candidate_set_v1';
export const COVERAGE_VERSION = 'wallet_candidate_coverage_v1';
export const SCOPE_INPUT_VERSION = 'wallet_candidate_scope_input_v1';
export const SCOPE_VERSION = 'wallet_candidate_scope_v1';
export const WINDOW_VERSION = 'fixed_lookback_latest_state_v1';
export const BOUNDARY_VERSION = 'solana_finalized_acquisition_boundary_v1';

const PROFILE_VALUES = Object.freeze({
  wallet_acquisition_profile: 'wallet_wide_bounded_history_v1',
  wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1',
  reconstruction_engine_version: 'artifact_position_ledger_receipt_v1',
  accounting_method_version: 'weighted_average_position_accounting_v1',
});
const STATUS_FIELDS = ['coverage_status','acquisition_complete','normalization_complete','classification_complete','pagination_complete','historical_bound_proven','chain_boundary_proven','truncated','capped','partial','provider_uncertain'];
const COVERAGE_FIELDS = ['coverage_version','coverage_digest','coverage_status','transactions_examined','supported_transaction_count','unsupported_transaction_count','ambiguous_transaction_count','unrelated_transaction_count','failed_transaction_count','normalized_event_count','finding_count','localized_finding_count','wallet_wide_finding_count','oldest_observed_timestamp','newest_observed_timestamp','oldest_observed_slot','newest_observed_slot','pagination_terminal_reason'];
const SLICE7_EVENT_FIELDS = ['wallet','timestamp','tx_hash','source','token_in_mint','token_in_amount','token_in_decimals','token_out_mint','token_out_amount','token_out_decimals','extraction_method','raw_index'];

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function assertExactFields(value, fields, context) {
  assertPlainJsonValue(value, [context]);
  if (!isObject(value)) fail('invalid_object', `${context} must be a plain object`);
  const expected = new Set(fields);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail('unknown_field', `${context} contains unknown field`, { context, field: key });
  for (const key of fields) if (!Object.hasOwn(value, key)) fail('missing_field', `${context} is missing field`, { context, field: key });
}
function nonempty(value, field) { if (typeof value !== 'string' || value.length === 0) fail('invalid_field', `${field} must be a non-empty string`, { field }); }
function safe(value, field, nullable = false) { if (nullable && value === null) return; if (!Number.isSafeInteger(value) || value < 0) fail('invalid_field', `${field} must be ${nullable ? 'null or ' : ''}a non-negative safe integer`, { field }); }
function finite(value, field, { nullable = false, positive = false } = {}) { if (nullable && value === null) return; if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) || (positive && value <= 0)) fail('invalid_field', `${field} is invalid`, { field }); }
function oneOf(value, values, field) { if (!values.includes(value)) fail('invalid_field', `${field} has an unsupported value`, { field }); }
export function assertDigest(value, field = 'digest') { if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) fail('malformed_digest', `${field} must be a full lowercase SHA-256 digest`, { field }); }
function exactId(value, prefix, digest, field) { if (value !== `${prefix}${digest}`) fail('derived_field_mismatch', `${field} must contain the full digest`, { field }); }
function orderedUniqueStrings(value, field, { digests = false, nonemptyArray = false } = {}) {
  if (!Array.isArray(value) || (nonemptyArray && value.length === 0)) fail('invalid_field', `${field} must be an array`, { field });
  value.forEach(item => digests ? assertDigest(item, field) : nonempty(item, field));
  if (new Set(value).size !== value.length) fail('duplicate_value', `${field} contains duplicates`, { field });
  for (let i = 1; i < value.length; i += 1) if (compareCodeUnits(value[i - 1], value[i]) >= 0) fail('order_invalid', `${field} is not in canonical order`, { field });
}
function verifyWithout(record, omitted, digest, code = 'digest_mismatch') {
  const preimage = {};
  for (const key of Object.keys(record)) if (!omitted.includes(key)) Object.defineProperty(preimage, key, { value: record[key], enumerable: true });
  if (sha256CanonicalJson(preimage) !== digest) fail(code, 'digest does not match canonical preimage');
}

export function validateSourceTransactionReferenceV1(value) {
  assertExactFields(value, ['tx_hash','slot','block_time'], 'source_transaction_reference');
  nonempty(value.tx_hash, 'tx_hash'); safe(value.slot, 'slot'); safe(value.block_time, 'block_time', true); return true;
}
export function validateProfilesV1(value) {
  assertExactFields(value, ['wallet_acquisition_profile','wallet_normalization_profile','reconstruction_engine_version','accounting_method_version','mark_profile'], 'profiles');
  for (const [key, expected] of Object.entries(PROFILE_VALUES)) if (value[key] !== expected) fail('unsupported_profile', `${key} is unsupported`);
  if (value.mark_profile !== null) nonempty(value.mark_profile, 'mark_profile'); return true;
}
export function validateBoundaryV1(value) {
  assertExactFields(value, ['boundary_version','chain','network','genesis_hash','commitment','anchor_slot','anchor_block_time','anchor_blockhash','history_complete_through_anchor','lower_bound_completion_proven','boundary_status'], 'boundary');
  if (value.boundary_version !== BOUNDARY_VERSION || value.chain !== 'solana' || value.network !== 'mainnet-beta' || value.genesis_hash !== GENESIS_HASH || value.commitment !== 'finalized' || value.boundary_status !== 'proven') fail('chain_boundary_invalid', 'boundary must identify finalized Solana mainnet-beta');
  safe(value.anchor_slot, 'anchor_slot'); safe(value.anchor_block_time, 'anchor_block_time'); nonempty(value.anchor_blockhash, 'anchor_blockhash');
  if (value.history_complete_through_anchor !== true || value.lower_bound_completion_proven !== true) fail('chain_boundary_unproven', 'boundary completeness must be proven'); return true;
}
export function validateInputStatusV1(value) {
  assertExactFields(value, STATUS_FIELDS, 'input_status');
  for (const field of STATUS_FIELDS) if (typeof value[field] !== 'boolean' && field !== 'coverage_status') fail('invalid_field', `${field} must be boolean`);
  if (value.coverage_status !== 'complete' || !value.acquisition_complete || !value.normalization_complete || !value.classification_complete || !value.pagination_complete || !value.historical_bound_proven || !value.chain_boundary_proven || value.truncated || value.capped || value.partial || value.provider_uncertain) fail('incomplete_acquisition_input', 'input status is not complete'); return true;
}
export function validateCoverageV1(value, { verifyDigest = true } = {}) {
  assertExactFields(value, COVERAGE_FIELDS, 'coverage');
  if (value.coverage_version !== COVERAGE_VERSION || value.coverage_status !== 'complete') fail('invalid_field', 'coverage version/status is invalid');
  assertDigest(value.coverage_digest, 'coverage_digest');
  for (const field of COVERAGE_FIELDS.filter(field => field.endsWith('_count') || field === 'transactions_examined' || field === 'normalized_event_count' || field === 'finding_count')) safe(value[field], field);
  for (const field of ['oldest_observed_timestamp','newest_observed_timestamp','oldest_observed_slot','newest_observed_slot']) safe(value[field], field, true);
  oneOf(value.pagination_terminal_reason, ['historical_bound_reached','provider_exhaustion'], 'pagination_terminal_reason');
  const partition = value.supported_transaction_count + value.unsupported_transaction_count + value.ambiguous_transaction_count + value.unrelated_transaction_count + value.failed_transaction_count;
  if (partition !== value.transactions_examined || value.normalized_event_count !== value.supported_transaction_count || value.finding_count !== value.localized_finding_count + value.wallet_wide_finding_count) fail('coverage_count_mismatch', 'coverage counts do not reconcile');
  if ((value.transactions_examined === 0) !== (value.oldest_observed_timestamp === null) || (value.oldest_observed_timestamp === null) !== (value.newest_observed_timestamp === null) || (value.oldest_observed_slot === null) !== (value.newest_observed_slot === null)) fail('coverage_count_mismatch', 'coverage observed bounds do not reconcile');
  if (value.oldest_observed_timestamp !== null && (value.oldest_observed_timestamp > value.newest_observed_timestamp || value.oldest_observed_slot > value.newest_observed_slot)) fail('coverage_count_mismatch', 'coverage bounds are reversed');
  if (verifyDigest) {
    const coverage = {};
    for (const key of Object.keys(value)) if (key !== 'coverage_digest') Object.defineProperty(coverage, key, { value: value[key], enumerable: true });
    if (sha256CanonicalJson({ coverage_identity_version: 'wallet_candidate_coverage_identity_v1', coverage }) !== value.coverage_digest) fail('coverage_digest_mismatch', 'coverage digest does not match canonical preimage');
  }
  return true;
}
export function validateFindingV1(value, { verifyDigest = true } = {}) {
  assertExactFields(value, ['finding_version','finding_id','finding_digest','finding_type','severity','impact_scope','time_range','affected_token_mints','affected_quote_mints','source_transaction_digests','source_event_digests','reason_codes','impact','disclosure_codes'], 'finding');
  if (value.finding_version !== FINDING_VERSION) fail('unsupported_version', 'finding version is unsupported');
  assertDigest(value.finding_digest, 'finding_digest'); exactId(value.finding_id, 'aaf1_', value.finding_digest, 'finding_id');
  oneOf(value.finding_type, ['unsupported_activity','ambiguous_activity','partial_history_boundary','external_transfer_gap','unobserved_inventory','mark_source_limitation','balance_boundary_mismatch'], 'finding_type');
  oneOf(value.severity, ['candidate_blocking','informational'], 'severity'); oneOf(value.impact_scope, ['token_specific','wallet_wide'], 'impact_scope');
  assertExactFields(value.time_range, ['first_observed_at','last_observed_at','first_observed_slot','last_observed_slot'], 'finding.time_range');
  for (const field of Object.keys(value.time_range)) safe(value.time_range[field], field); if (value.time_range.first_observed_at > value.time_range.last_observed_at || value.time_range.first_observed_slot > value.time_range.last_observed_slot) fail('invalid_field', 'finding time range is reversed');
  orderedUniqueStrings(value.affected_token_mints, 'affected_token_mints'); orderedUniqueStrings(value.affected_quote_mints, 'affected_quote_mints');
  if (value.impact_scope === 'token_specific' && value.affected_token_mints.length === 0) fail('invalid_field', 'token-specific finding requires an affected mint');
  orderedUniqueStrings(value.source_transaction_digests, 'source_transaction_digests', { digests: true, nonemptyArray: true }); orderedUniqueStrings(value.source_event_digests, 'source_event_digests', { digests: true });
  orderedUniqueStrings(value.reason_codes, 'reason_codes', { nonemptyArray: true }); orderedUniqueStrings(value.disclosure_codes, 'disclosure_codes');
  assertExactFields(value.impact, ['blocks_candidate_projection','blocks_receipt_publication'], 'finding.impact'); if (typeof value.impact.blocks_candidate_projection !== 'boolean' || typeof value.impact.blocks_receipt_publication !== 'boolean') fail('invalid_field', 'finding impact fields must be boolean');
  if (verifyDigest) verifyWithout(value, ['finding_id','finding_digest'], value.finding_digest); return true;
}
export function validateDispositionV1(value, { verifyDigest = true } = {}) {
  assertExactFields(value, ['disposition_version','disposition_id','disposition_digest','tx_hash','slot','block_time','disposition_type','affected_token_mints','normalized_event_digests','finding_digests'], 'disposition');
  if (value.disposition_version !== DISPOSITION_VERSION) fail('unsupported_version', 'disposition version is unsupported'); assertDigest(value.disposition_digest, 'disposition_digest'); exactId(value.disposition_id, 'awd1_', value.disposition_digest, 'disposition_id');
  validateSourceTransactionReferenceV1({ tx_hash: value.tx_hash, slot: value.slot, block_time: value.block_time });
  oneOf(value.disposition_type, ['supported_normalized_event','unsupported_activity','ambiguous_activity','unrelated_activity','failed_transaction'], 'disposition_type');
  orderedUniqueStrings(value.affected_token_mints, 'affected_token_mints'); orderedUniqueStrings(value.normalized_event_digests, 'normalized_event_digests', { digests: true }); orderedUniqueStrings(value.finding_digests, 'finding_digests', { digests: true });
  if (value.disposition_type === 'supported_normalized_event' && (value.normalized_event_digests.length !== 1 || value.finding_digests.length || !value.affected_token_mints.length)) fail('event_disposition_mismatch', 'supported disposition must reference exactly one event and no findings');
  if (['unsupported_activity','ambiguous_activity'].includes(value.disposition_type) && (value.normalized_event_digests.length || !value.finding_digests.length || (value.disposition_type === 'unsupported_activity' && !value.affected_token_mints.length))) fail('finding_disposition_mismatch', 'unsupported/ambiguous disposition references are invalid');
  if (['unrelated_activity','failed_transaction'].includes(value.disposition_type) && (value.affected_token_mints.length || value.normalized_event_digests.length || value.finding_digests.length)) fail('event_disposition_mismatch', 'unrelated/failed disposition must have no references');
  if (verifyDigest) verifyWithout(value, ['disposition_id','disposition_digest'], value.disposition_digest); return true;
}
export function validateSlice7EventV1(value) {
  assertExactFields(value, SLICE7_EVENT_FIELDS, 'slice7_event'); for (const field of ['wallet','tx_hash','source','token_in_mint','token_out_mint','extraction_method']) nonempty(value[field], field);
  for (const field of ['timestamp','token_in_decimals','token_out_decimals','raw_index']) safe(value[field], field); if (value.token_in_decimals > 255 || value.token_out_decimals > 255 || value.token_in_mint === value.token_out_mint) fail('invalid_field', 'event identity/decimals are invalid');
  finite(value.token_in_amount, 'token_in_amount', { positive: true }); finite(value.token_out_amount, 'token_out_amount', { positive: true }); return true;
}
export function validateEventRecordV1(value, { verifyDigest = true } = {}) {
  assertExactFields(value, ['event_record_version','event_record_id','event_digest','source_slot','slice7_event'], 'event_record'); if (value.event_record_version !== EVENT_RECORD_VERSION) fail('unsupported_version', 'event version is unsupported'); assertDigest(value.event_digest, 'event_digest'); exactId(value.event_record_id, 'awer1_', value.event_digest, 'event_record_id'); safe(value.source_slot, 'source_slot'); validateSlice7EventV1(value.slice7_event); if (verifyDigest) verifyWithout(value, ['event_record_id','event_digest'], value.event_digest); return true;
}
export function validateMarkObservationV1(value, { verifyDigest = true } = {}) {
  assertExactFields(value, ['mark_observation_version','mark_observation_id','mark_observation_digest','token_mint','quote_mint','observation_status','source_profile','mark_price_raw_quote','observed_at','source_slot','reason_code'], 'mark_observation'); if (value.mark_observation_version !== MARK_OBSERVATION_VERSION) fail('unsupported_version', 'mark version is unsupported'); assertDigest(value.mark_observation_digest, 'mark_observation_digest'); exactId(value.mark_observation_id, 'amo1_', value.mark_observation_digest, 'mark_observation_id'); nonempty(value.token_mint, 'token_mint'); nonempty(value.quote_mint, 'quote_mint'); nonempty(value.source_profile, 'source_profile'); oneOf(value.observation_status, ['available','unavailable'], 'observation_status');
  if (value.observation_status === 'available') { finite(value.mark_price_raw_quote, 'mark_price_raw_quote', { positive: true }); safe(value.observed_at, 'observed_at'); safe(value.source_slot, 'source_slot'); if (value.reason_code !== null) fail('invalid_field', 'available mark reason_code must be null'); }
  else { if (value.mark_price_raw_quote !== null || value.observed_at !== null || value.source_slot !== null) fail('invalid_field', 'unavailable mark values must be null'); nonempty(value.reason_code, 'reason_code'); }
  if (verifyDigest) verifyWithout(value, ['mark_observation_id','mark_observation_digest'], value.mark_observation_digest); return true;
}
export function validateBlockedSummaryV1(value, { verifyDigest = true } = {}) {
  assertExactFields(value, ['blocked_summary_version','blocked_summary_id','blocked_summary_digest','chain','network','wallet','token_mint','position_status','ledger_evidence_status','boundary_status','valuation_status','selection_status','package_eligibility','economics_status','associated_finding_digests','reason_codes','disclosure_codes'], 'blocked_summary'); if (value.blocked_summary_version !== BLOCKED_SUMMARY_VERSION) fail('unsupported_version', 'blocked summary version is unsupported'); assertDigest(value.blocked_summary_digest, 'blocked_summary_digest'); exactId(value.blocked_summary_id, 'abs1_', value.blocked_summary_digest, 'blocked_summary_id'); if (value.chain !== 'solana' || value.network !== 'mainnet-beta') fail('invalid_chain_identity', 'blocked summary chain identity is invalid'); nonempty(value.wallet, 'wallet'); if (value.token_mint !== null) nonempty(value.token_mint, 'token_mint');
  if (value.position_status !== 'unknown' || !['blocked_unsupported_activity','blocked_ambiguous_activity'].includes(value.ledger_evidence_status) || value.boundary_status !== 'unavailable' || value.valuation_status !== 'unavailable' || value.selection_status !== 'blocked' || value.package_eligibility !== 'blocked_by_evidence' || value.economics_status !== 'unavailable') fail('invalid_candidate_status', 'blocked summary status axes are invalid');
  orderedUniqueStrings(value.associated_finding_digests, 'associated_finding_digests', { digests: true, nonemptyArray: true }); orderedUniqueStrings(value.reason_codes, 'reason_codes', { nonemptyArray: true }); orderedUniqueStrings(value.disclosure_codes, 'disclosure_codes'); if (verifyDigest) verifyWithout(value, ['blocked_summary_id','blocked_summary_digest'], value.blocked_summary_digest); return true;
}

function validateEconomics(value, type) {
  const common = ['economics_type','total_bought_qty','total_bought_quote','avg_buy_quote_price','total_sold_qty','total_sold_quote','avg_sell_quote_price','allocated_cost_basis_quote','remaining_qty','remaining_cost_basis_quote','entry_count','exit_count','accounting_method'];
  const fields = type === 'closed_position' ? [...common,'realized_pnl_quote','realized_pnl_pct','hold_time_seconds','close_reason_code','dust_classification_code'] : type === 'realized_partial' ? [...common,'realized_pnl_quote','realized_pnl_pct'] : [...common,'realized_pnl_to_date_quote','realized_pnl_to_date_pct'];
  assertExactFields(value, fields, 'candidate.economics'); if (value.economics_type !== ({ closed_position:'closed_position_raw_quote_v1', realized_partial:'realized_partial_raw_quote_v1', open_snapshot:'open_position_raw_quote_v1' })[type] || value.accounting_method !== PROFILE_VALUES.accounting_method_version) fail('invalid_field', 'economics type/accounting method is invalid');
  for (const field of fields.filter(field => !['economics_type','accounting_method','close_reason_code','dust_classification_code'].includes(field))) finite(value[field], field); safe(value.entry_count, 'entry_count'); safe(value.exit_count, 'exit_count'); for (const field of ['close_reason_code','dust_classification_code']) if (Object.hasOwn(value, field) && value[field] !== null) nonempty(value[field], field);
}
function validateSnapshot(value) {
  assertExactFields(value, ['snapshot_version','snapshot_at','source_boundary','remaining_qty','remaining_cost_basis_quote','realized_pnl_to_date_quote','realized_pnl_to_date_pct','mark','unrealized_pnl','disclosure_codes'], 'snapshot'); if (value.snapshot_version !== 'open_position_snapshot_v1') fail('unsupported_version', 'snapshot version is unsupported'); safe(value.snapshot_at, 'snapshot_at');
  assertExactFields(value.source_boundary, ['boundary_type','chain','network','genesis_hash','source_slot','source_block_time','source_blockhash','boundary_status'], 'snapshot.source_boundary'); if (value.source_boundary.boundary_type !== 'authoritative_acquisition_boundary_v1' || value.source_boundary.chain !== 'solana' || value.source_boundary.network !== 'mainnet-beta' || value.source_boundary.genesis_hash !== GENESIS_HASH || value.source_boundary.boundary_status !== 'proven') fail('chain_boundary_invalid', 'snapshot source boundary is invalid'); safe(value.source_boundary.source_slot, 'source_slot'); safe(value.source_boundary.source_block_time, 'source_block_time'); nonempty(value.source_boundary.source_blockhash, 'source_blockhash'); if (value.snapshot_at !== value.source_boundary.source_block_time) fail('derived_field_mismatch', 'snapshot_at must equal source block time');
  finite(value.remaining_qty, 'remaining_qty'); finite(value.remaining_cost_basis_quote, 'remaining_cost_basis_quote'); finite(value.realized_pnl_to_date_quote, 'realized_pnl_to_date_quote'); finite(value.realized_pnl_to_date_pct, 'realized_pnl_to_date_pct', { nullable: true });
  assertExactFields(value.mark, ['status','mark_profile','mark_price_raw_quote','mark_observed_at','mark_source_slot','freshness_status','reason_code'], 'snapshot.mark'); oneOf(value.mark.status, ['available','unavailable'], 'mark.status'); nonempty(value.mark.mark_profile, 'mark_profile'); oneOf(value.mark.freshness_status, ['fresh','stale','unavailable','quote_mismatch','after_boundary'], 'freshness_status');
  if (value.mark.status === 'available') { finite(value.mark.mark_price_raw_quote, 'mark_price_raw_quote', { positive: true }); safe(value.mark.mark_observed_at, 'mark_observed_at'); safe(value.mark.mark_source_slot, 'mark_source_slot'); if (value.mark.reason_code !== null) fail('invalid_field', 'available mark reason must be null'); } else { if (value.mark.mark_price_raw_quote !== null || value.mark.mark_observed_at !== null || value.mark.mark_source_slot !== null) fail('invalid_field', 'unavailable mark values must be null'); nonempty(value.mark.reason_code, 'mark.reason_code'); }
  if (value.unrealized_pnl !== null) { assertExactFields(value.unrealized_pnl, ['unrealized_pnl_version','market_value_quote','unrealized_pnl_quote','unrealized_pnl_pct'], 'snapshot.unrealized_pnl'); if (value.unrealized_pnl.unrealized_pnl_version !== 'unrealized_pnl_raw_quote_v1' || value.mark.status !== 'available' || value.mark.freshness_status !== 'fresh') fail('invalid_field', 'unrealized PnL requires a fresh available mark'); finite(value.unrealized_pnl.market_value_quote, 'market_value_quote'); finite(value.unrealized_pnl.unrealized_pnl_quote, 'unrealized_pnl_quote'); finite(value.unrealized_pnl.unrealized_pnl_pct, 'unrealized_pnl_pct', { nullable: true }); }
  orderedUniqueStrings(value.disclosure_codes, 'disclosure_codes', { nonemptyArray: true });
}
export function validateCandidateV1(value, { verifyDigest = true } = {}) {
  assertExactFields(value, ['candidate_version','candidate_identity_version','candidate_id','candidate_digest','ledger_candidate_hash','receipt_scoped_evidence_digest','selection_key','projection','handoff'], 'candidate'); if (value.candidate_version !== CANDIDATE_VERSION || value.candidate_identity_version !== CANDIDATE_IDENTITY_VERSION) fail('unsupported_version', 'candidate version is unsupported'); assertDigest(value.candidate_digest, 'candidate_digest'); assertDigest(value.ledger_candidate_hash, 'ledger_candidate_hash'); assertDigest(value.receipt_scoped_evidence_digest, 'receipt_scoped_evidence_digest'); exactId(value.candidate_id, 'acv1_', value.candidate_digest, 'candidate_id');
  assertExactFields(value.selection_key, ['wallet','token_mint','receipt_type','segment_index'], 'selection_key'); nonempty(value.selection_key.wallet, 'wallet'); nonempty(value.selection_key.token_mint, 'token_mint'); oneOf(value.selection_key.receipt_type, ['closed_position','realized_partial','open_snapshot'], 'receipt_type'); safe(value.selection_key.segment_index, 'segment_index');
  const pfields = ['candidate_type','position_status','ledger_evidence_status','boundary_status','valuation_status','selection_status','package_eligibility','chain','network','wallet','token_mint','quote_mint','quote_symbol_code','segment_index','first_event_at','last_event_at','event_counts','ledger_eligibility','economics','snapshot','flags','limitations','reason_codes','disclosure_codes']; assertExactFields(value.projection, pfields, 'candidate.projection'); const p = value.projection; oneOf(p.candidate_type, ['closed_position','realized_partial','open_snapshot'], 'candidate_type'); oneOf(p.position_status, ['closed','open'], 'position_status'); oneOf(p.ledger_evidence_status, ['clean','limited_partial_history'], 'ledger_evidence_status'); oneOf(p.boundary_status, ['not_applicable','proven','unavailable'], 'boundary_status'); oneOf(p.valuation_status, ['raw_quote','mark_available','mark_unavailable','mark_stale','mark_quote_mismatch','mark_after_boundary','unavailable'], 'valuation_status'); oneOf(p.selection_status, ['selectable','visible_only'], 'selection_status'); oneOf(p.package_eligibility, ['eligible_closed_position_v1','not_publication_eligible_v1'], 'package_eligibility'); if (p.chain !== 'solana' || p.network !== 'mainnet-beta') fail('invalid_chain_identity', 'candidate chain identity is invalid'); for (const f of ['wallet','token_mint','quote_mint','quote_symbol_code']) nonempty(p[f], f); safe(p.segment_index, 'segment_index'); safe(p.first_event_at, 'first_event_at'); safe(p.last_event_at, 'last_event_at'); if (p.first_event_at > p.last_event_at) fail('invalid_field', 'candidate event range is reversed');
  assertExactFields(p.event_counts, ['buys','sells','supported_events','associated_findings'], 'event_counts'); for (const f of Object.keys(p.event_counts)) safe(p.event_counts[f], f); assertExactFields(p.ledger_eligibility, ['eligible_for_closed_position','eligible_for_verified_receipt'], 'ledger_eligibility'); if (typeof p.ledger_eligibility.eligible_for_closed_position !== 'boolean' || typeof p.ledger_eligibility.eligible_for_verified_receipt !== 'boolean') fail('invalid_field', 'ledger eligibility must be boolean'); validateEconomics(p.economics, p.candidate_type); if ((p.candidate_type === 'closed_position') !== (p.snapshot === null)) fail('invalid_field', 'snapshot type invariant failed'); if (p.snapshot !== null) validateSnapshot(p.snapshot); for (const f of ['flags','limitations','reason_codes','disclosure_codes']) orderedUniqueStrings(p[f], f);
  if (value.selection_key.wallet !== p.wallet || value.selection_key.token_mint !== p.token_mint || value.selection_key.receipt_type !== p.candidate_type || value.selection_key.segment_index !== p.segment_index) fail('derived_field_mismatch', 'selection key does not match projection');
  const eligible = p.candidate_type === 'closed_position' && p.position_status === 'closed' && p.ledger_evidence_status === 'clean' && p.ledger_eligibility.eligible_for_closed_position && p.ledger_eligibility.eligible_for_verified_receipt;
  if ((p.package_eligibility === 'eligible_closed_position_v1') !== eligible || (p.selection_status === 'selectable') !== eligible) fail('invalid_candidate_eligibility', 'candidate eligibility axes are inconsistent');
  assertExactFields(value.handoff, ['handoff_version','candidate_digest','receipt_scoped_evidence_digest','ledger_candidate_hash'], 'handoff'); if (value.handoff.handoff_version !== 'candidate_selection_handoff_v1' || value.handoff.candidate_digest !== value.candidate_digest || value.handoff.receipt_scoped_evidence_digest !== value.receipt_scoped_evidence_digest || value.handoff.ledger_candidate_hash !== value.ledger_candidate_hash) fail('derived_field_mismatch', 'candidate handoff is inconsistent');
  if (verifyDigest) {
    const preimage = { candidate_identity_version: value.candidate_identity_version, receipt_scoped_evidence_digest: value.receipt_scoped_evidence_digest, ledger_candidate_hash: value.ledger_candidate_hash, projection: value.projection };
    if (sha256CanonicalJson(preimage) !== value.candidate_digest) fail('digest_mismatch', 'candidate digest does not match candidate-local preimage');
  }
  return true;
}

export function validateEvidenceIntegrityV1(value) {
  assertExactFields(value, ['transaction_dispositions_digest','normalized_events_digest','activity_findings_digest','mark_observations_digest','transaction_disposition_count','normalized_event_count','activity_finding_count','mark_observation_count'], 'integrity'); for (const f of ['transaction_dispositions_digest','normalized_events_digest','activity_findings_digest','mark_observations_digest']) assertDigest(value[f], f); for (const f of ['transaction_disposition_count','normalized_event_count','activity_finding_count','mark_observation_count']) safe(value[f], f); return true;
}
export function validateEvidenceBundleV1(bundle) {
  assertExactFields(bundle, ['evidence_bundle_version','evidence_bundle_digest','payload'], 'evidence_bundle'); if (bundle.evidence_bundle_version !== EVIDENCE_BUNDLE_VERSION) fail('unsupported_version', 'evidence bundle version is unsupported'); assertDigest(bundle.evidence_bundle_digest, 'evidence_bundle_digest');
  const fields = ['scope','profiles','boundary','input_status','coverage','transaction_dispositions','normalized_event_records','activity_findings','mark_observations','integrity']; assertExactFields(bundle.payload, fields, 'evidence_bundle.payload'); rejectDigestBacklink(bundle.payload, 'evidence_bundle_digest', 'evidence_bundle_digest_in_payload'); validateScopeInputV1(bundle.payload.scope); validateProfilesV1(bundle.payload.profiles); validateBoundaryV1(bundle.payload.boundary); validateInputStatusV1(bundle.payload.input_status); validateCoverageV1(bundle.payload.coverage);
  for (const [field, validator] of [['transaction_dispositions',validateDispositionV1],['normalized_event_records',validateEventRecordV1],['activity_findings',validateFindingV1],['mark_observations',validateMarkObservationV1]]) {
    if (!Array.isArray(bundle.payload[field])) fail('invalid_field', `${field} must be an array`); bundle.payload[field].forEach(item => validator(item));
    const digests = bundle.payload[field].map(item => item.disposition_digest ?? item.event_digest ?? item.finding_digest ?? item.mark_observation_digest);
    if (new Set(digests).size !== digests.length) fail('duplicate_value', `${field} contains duplicate digests`);
    for (let index = 1; index < digests.length; index += 1) if (compareCodeUnits(digests[index - 1], digests[index]) >= 0) fail('order_invalid', `${field} is not in canonical digest order`);
  }
  const eventByDigest = new Map(bundle.payload.normalized_event_records.map(x => [x.event_digest, x])); const eventDigests = new Set(eventByDigest.keys()); const findingDigests = new Set(bundle.payload.activity_findings.map(x => x.finding_digest));
  const sourceDigests = new Set(bundle.payload.transaction_dispositions.map(x => sha256CanonicalJson({ source_transaction_reference_version: SOURCE_TRANSACTION_REFERENCE_VERSION, source_transaction: { tx_hash: x.tx_hash, slot: x.slot, block_time: x.block_time } })));
  for (const disposition of bundle.payload.transaction_dispositions) {
    for (const digest of disposition.normalized_event_digests) { const event = eventByDigest.get(digest); if (!event) fail('event_disposition_mismatch', 'unknown normalized event digest'); if (event.slice7_event.tx_hash !== disposition.tx_hash || event.source_slot !== disposition.slot || (disposition.block_time !== null && event.slice7_event.timestamp !== disposition.block_time)) fail('event_source_mismatch', 'event source does not match its disposition'); }
    for (const digest of disposition.finding_digests) if (!findingDigests.has(digest)) fail('finding_disposition_mismatch', 'unknown finding digest');
  }
  for (const event of bundle.payload.normalized_event_records) { if (event.slice7_event.wallet !== bundle.payload.scope.wallet) fail('event_scope_mismatch', 'event wallet does not match evidence scope'); if (bundle.payload.transaction_dispositions.filter(x => x.normalized_event_digests.includes(event.event_digest)).length !== 1) fail('event_disposition_mismatch', 'event must be referenced exactly once'); }
  for (const finding of bundle.payload.activity_findings) { for (const digest of finding.source_transaction_digests) if (!sourceDigests.has(digest)) fail('finding_disposition_mismatch', 'unknown source transaction digest'); for (const digest of finding.source_event_digests) if (!eventDigests.has(digest)) fail('finding_disposition_mismatch', 'unknown source event digest'); }
  validateEvidenceIntegrityV1(bundle.payload.integrity); const i = bundle.payload.integrity; if (i.transaction_disposition_count !== bundle.payload.transaction_dispositions.length || i.normalized_event_count !== bundle.payload.normalized_event_records.length || i.activity_finding_count !== bundle.payload.activity_findings.length || i.mark_observation_count !== bundle.payload.mark_observations.length) fail('integrity_count_mismatch', 'evidence integrity counts do not match arrays');
  const indexDigest = (version, digests) => sha256CanonicalJson({ index_version: version, digests });
  if (i.transaction_dispositions_digest !== indexDigest('wallet_transaction_disposition_index_v1', bundle.payload.transaction_dispositions.map(x => x.disposition_digest)) || i.normalized_events_digest !== indexDigest('wallet_normalized_event_index_v1', bundle.payload.normalized_event_records.map(x => x.event_digest)) || i.activity_findings_digest !== indexDigest('wallet_activity_finding_index_v1', bundle.payload.activity_findings.map(x => x.finding_digest)) || i.mark_observations_digest !== indexDigest('wallet_mark_observation_index_v1', bundle.payload.mark_observations.map(x => x.mark_observation_digest))) fail('integrity_digest_mismatch', 'evidence integrity digests do not match arrays');
  if (bundle.payload.coverage.transactions_examined !== bundle.payload.transaction_dispositions.length || bundle.payload.coverage.normalized_event_count !== bundle.payload.normalized_event_records.length || bundle.payload.coverage.finding_count !== bundle.payload.activity_findings.length) fail('coverage_count_mismatch', 'coverage does not match evidence arrays');
  const dispositionCounts = Object.fromEntries(['supported_normalized_event','unsupported_activity','ambiguous_activity','unrelated_activity','failed_transaction'].map(type => [type, bundle.payload.transaction_dispositions.filter(x => x.disposition_type === type).length]));
  if (bundle.payload.coverage.supported_transaction_count !== dispositionCounts.supported_normalized_event || bundle.payload.coverage.unsupported_transaction_count !== dispositionCounts.unsupported_activity || bundle.payload.coverage.ambiguous_transaction_count !== dispositionCounts.ambiguous_activity || bundle.payload.coverage.unrelated_transaction_count !== dispositionCounts.unrelated_activity || bundle.payload.coverage.failed_transaction_count !== dispositionCounts.failed_transaction) fail('coverage_count_mismatch', 'coverage disposition partition does not match evidence');
  if (sha256CanonicalJson(bundle.payload) !== bundle.evidence_bundle_digest) fail('digest_mismatch', 'evidence bundle digest must hash payload only'); return true;
}
export function validateScopeInputV1(value) {
  assertExactFields(value, ['scope_version','chain','network','genesis_hash','wallet','window'], 'scope'); if (value.scope_version !== SCOPE_INPUT_VERSION || value.chain !== 'solana' || value.network !== 'mainnet-beta' || value.genesis_hash !== GENESIS_HASH) fail('invalid_chain_identity', 'scope chain identity is invalid'); nonempty(value.wallet, 'wallet'); assertExactFields(value.window, ['window_version','lookback_profile','requested_lookback_seconds','initial_before_signature','lower_bound'], 'scope.window'); if (value.window.window_version !== WINDOW_VERSION || value.window.initial_before_signature !== null) fail('non_null_latest_state_cursor', 'latest-state window requires null initial cursor'); nonempty(value.window.lookback_profile, 'lookback_profile'); safe(value.window.requested_lookback_seconds, 'requested_lookback_seconds'); assertExactFields(value.window.lower_bound, ['oldest_allowed_timestamp','completion_status'], 'scope.window.lower_bound'); safe(value.window.lower_bound.oldest_allowed_timestamp, 'oldest_allowed_timestamp'); if (value.window.lower_bound.completion_status !== 'proven') fail('historical_bound_unproven', 'lower bound must be proven'); return true;
}
function rejectDigestBacklink(value, key, code) { if (value === null || typeof value !== 'object') return; for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) { if (Array.isArray(value) && name === 'length') continue; if (name === key) fail(code, `${key} is forbidden in payload`); if (Object.hasOwn(descriptor, 'value')) rejectDigestBacklink(descriptor.value, key, code); } }
export function validateCandidateSetV1(value) {
  assertPlainJsonValue(value); if (isObject(value) && Object.hasOwn(value, 'payload')) rejectDigestBacklink(value.payload, 'candidate_set_digest', 'candidate_set_digest_in_payload'); assertExactFields(value, ['candidate_set_version','candidate_set_digest','payload'], 'candidate_set'); if (value.candidate_set_version !== CANDIDATE_SET_VERSION) fail('unsupported_version', 'candidate set version is unsupported'); assertDigest(value.candidate_set_digest, 'candidate_set_digest');
  assertExactFields(value.payload, ['scope','profiles','commitments','coverage','counts','candidates','blocked_summaries','activity_findings'], 'candidate_set.payload'); assertExactFields(value.payload.scope, ['scope_version','scope_digest','window_digest','chain','network','genesis_hash','wallet','window'], 'candidate_set.scope'); if (value.payload.scope.scope_version !== SCOPE_VERSION || value.payload.scope.chain !== 'solana' || value.payload.scope.network !== 'mainnet-beta' || value.payload.scope.genesis_hash !== GENESIS_HASH) fail('invalid_chain_identity', 'candidate set scope is invalid'); assertDigest(value.payload.scope.scope_digest, 'scope_digest'); assertDigest(value.payload.scope.window_digest, 'window_digest'); nonempty(value.payload.scope.wallet, 'wallet');
  validateScopeInputV1({ scope_version: SCOPE_INPUT_VERSION, chain: value.payload.scope.chain, network: value.payload.scope.network, genesis_hash: value.payload.scope.genesis_hash, wallet: value.payload.scope.wallet, window: value.payload.scope.window }); validateProfilesV1(value.payload.profiles);
  const windowPreimage = { window_identity_version: 'wallet_candidate_window_identity_v1', chain: value.payload.scope.chain, network: value.payload.scope.network, genesis_hash: value.payload.scope.genesis_hash, wallet: value.payload.scope.wallet, window: value.payload.scope.window };
  if (sha256CanonicalJson(windowPreimage) !== value.payload.scope.window_digest) fail('window_digest_mismatch', 'window digest is inconsistent');
  const scopePreimage = { scope_identity_version: 'wallet_candidate_scope_identity_v1', chain: value.payload.scope.chain, network: value.payload.scope.network, genesis_hash: value.payload.scope.genesis_hash, wallet: value.payload.scope.wallet, window_digest: value.payload.scope.window_digest, coverage_digest: value.payload.coverage.coverage_digest, profiles: value.payload.profiles };
  if (sha256CanonicalJson(scopePreimage) !== value.payload.scope.scope_digest) fail('scope_digest_mismatch', 'scope digest is inconsistent');
  assertExactFields(value.payload.commitments, ['evidence_bundle_digest','coverage_digest','transaction_dispositions_digest','normalized_events_digest','activity_findings_digest','mark_observations_digest'], 'candidate_set.commitments'); for (const [f,d] of Object.entries(value.payload.commitments)) assertDigest(d, f); validateCoverageV1(value.payload.coverage); if (value.payload.commitments.coverage_digest !== value.payload.coverage.coverage_digest) fail('coverage_digest_mismatch', 'candidate set coverage commitment is inconsistent');
  assertExactFields(value.payload.counts, ['candidate_count','closed_candidate_count','partial_candidate_count','open_candidate_count','limited_candidate_count','selectable_candidate_count','blocked_summary_count','finding_count'], 'candidate_set.counts'); for (const f of Object.keys(value.payload.counts)) safe(value.payload.counts[f], f); for (const f of ['candidates','blocked_summaries','activity_findings']) if (!Array.isArray(value.payload[f])) fail('invalid_field', `${f} must be an array`); value.payload.candidates.forEach(validateCandidateV1); value.payload.blocked_summaries.forEach(validateBlockedSummaryV1); value.payload.activity_findings.forEach(validateFindingV1);
  for (const candidate of value.payload.candidates) if (candidate.selection_key.wallet !== value.payload.scope.wallet || candidate.projection.wallet !== value.payload.scope.wallet || candidate.projection.chain !== value.payload.scope.chain || candidate.projection.network !== value.payload.scope.network) fail('candidate_scope_mismatch', 'candidate does not match candidate-set scope');
  for (const summary of value.payload.blocked_summaries) if (summary.wallet !== value.payload.scope.wallet || summary.chain !== value.payload.scope.chain || summary.network !== value.payload.scope.network) fail('candidate_scope_mismatch', 'blocked summary does not match candidate-set scope');
  const selectionKeys = value.payload.candidates.map(candidate => sha256CanonicalJson(candidate.selection_key)); if (new Set(selectionKeys).size !== selectionKeys.length) fail('duplicate_selection_key', 'candidate semantic selection keys must be unique');
  const c = value.payload.counts; const candidates = value.payload.candidates; if (c.candidate_count !== candidates.length || c.closed_candidate_count !== candidates.filter(x => x.projection.candidate_type === 'closed_position').length || c.partial_candidate_count !== candidates.filter(x => x.projection.candidate_type === 'realized_partial').length || c.open_candidate_count !== candidates.filter(x => x.projection.candidate_type === 'open_snapshot').length || c.limited_candidate_count !== candidates.filter(x => x.projection.ledger_evidence_status === 'limited_partial_history').length || c.selectable_candidate_count !== candidates.filter(x => x.projection.selection_status === 'selectable').length || c.blocked_summary_count !== value.payload.blocked_summaries.length || c.finding_count !== value.payload.activity_findings.length) fail('candidate_set_count_mismatch', 'candidate set counts do not reconcile');
  if (value.payload.coverage.finding_count !== value.payload.activity_findings.length) fail('coverage_count_mismatch', 'candidate set findings do not match coverage');
  const setFindingDigests = new Set(value.payload.activity_findings.map(x => x.finding_digest)); for (const summary of value.payload.blocked_summaries) for (const digest of summary.associated_finding_digests) if (!setFindingDigests.has(digest)) fail('unknown_finding_digest', 'blocked summary references an unknown finding');
  for (const field of ['candidates','blocked_summaries','activity_findings']) {
    const digests = value.payload[field].map(x => x.candidate_digest ?? x.blocked_summary_digest ?? x.finding_digest);
    if (new Set(digests).size !== digests.length) fail('duplicate_value', `${field} contains duplicate digests`);
    for (let index = 1; index < digests.length; index += 1) if (compareCodeUnits(digests[index - 1], digests[index]) >= 0) fail('order_invalid', `${field} is not in canonical digest order`);
  }
  const findingIndex = sha256CanonicalJson({ index_version: 'wallet_activity_finding_index_v1', digests: value.payload.activity_findings.map(x => x.finding_digest) });
  if (findingIndex !== value.payload.commitments.activity_findings_digest) fail('integrity_digest_mismatch', 'candidate-set finding commitment is inconsistent');
  if (sha256CanonicalJson(value.payload) !== value.candidate_set_digest) fail('digest_mismatch', 'candidate set digest must hash payload only'); return true;
}
