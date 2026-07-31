import { buildWalletAcquisitionResultV1 } from '../acquisition-result.mjs';
import { buildActivityFindingV1, canonicalizeActivityFindingsV1 } from '../activity-findings.mjs';
import { buildWalletCandidateSetV1 } from '../builder.mjs';
import { recomputeCoverageV1 } from '../coverage.mjs';
import { canonicalizeTransactionDispositionsV1 } from '../dispositions.mjs';
import { buildCandidateEvidenceBundleV1 } from '../evidence-bundle.mjs';
import {
  buildDispositionV1,
  buildEventRecordV1,
  computeSourceTransactionDigest,
} from '../identity.mjs';
import { buildMarkObservationV1 } from '../mark-observations.mjs';
import { deepFreeze } from '../plain-data.mjs';
import { compareCodeUnits } from '../order.mjs';
import { GENESIS_HASH } from '../schema.mjs';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const DEFAULT_PROFILES = Object.freeze({
  wallet_acquisition_profile: 'wallet_wide_bounded_history_v1',
  wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1',
  reconstruction_engine_version: 'artifact_position_ledger_receipt_v1',
  accounting_method_version: 'weighted_average_position_accounting_v1',
  mark_profile: 'direct_quote_mark_v1',
  mark_max_age_seconds: 300,
});

export const COMPLETE_INPUT_STATUS = Object.freeze({
  coverage_status: 'complete',
  acquisition_complete: true,
  normalization_complete: true,
  classification_complete: true,
  pagination_complete: true,
  historical_bound_proven: true,
  chain_boundary_proven: true,
  truncated: false,
  capped: false,
  partial: false,
  provider_uncertain: false,
});

function eventSpec({ token, timestamp, signature, slot, buy, tokenAmount, quoteAmount, quoteMint = USDC_MINT, source = 'deterministic_fixture', extractionMethod = 'events_swap', sameMintInputAmounts = null }) {
  return { token, timestamp, signature, slot, buy, tokenAmount, quoteAmount, quoteMint, source, extractionMethod, sameMintInputAmounts };
}

function compareEventSpecs(left, right) {
  return left.timestamp - right.timestamp
    || compareCodeUnits(left.signature, right.signature)
    || left.slot - right.slot
    || compareCodeUnits(left.token, right.token)
    || compareCodeUnits(left.quoteMint, right.quoteMint)
    || Number(left.buy) - Number(right.buy)
    || left.tokenAmount - right.tokenAmount
    || left.quoteAmount - right.quoteAmount;
}

function buildEventRecords(wallet, specs) {
  return [...specs].sort(compareEventSpecs).map((spec, rawIndex) => buildEventRecordV1({
    source_slot: spec.slot,
    slice7_event: {
      wallet,
      timestamp: spec.timestamp,
      tx_hash: spec.signature,
      source: spec.source,
      token_in_mint: spec.buy ? spec.quoteMint : spec.token,
      token_in_amount: spec.buy ? aggregateSameMintInputs(spec) : spec.tokenAmount,
      token_in_decimals: 6,
      token_out_mint: spec.buy ? spec.token : spec.quoteMint,
      token_out_amount: spec.buy ? spec.tokenAmount : aggregateSameMintInputs(spec),
      token_out_decimals: 6,
      extraction_method: spec.extractionMethod ?? 'events_swap',
      raw_index: rawIndex,
    },
  }));
}

function aggregateSameMintInputs(spec) {
  if (spec.sameMintInputAmounts === null || spec.sameMintInputAmounts === undefined) return spec.quoteAmount;
  let total = 0;
  for (const amount of spec.sameMintInputAmounts) total += amount;
  return total;
}

function buildSupportedDisposition(record) {
  return buildDispositionV1({
    tx_hash: record.slice7_event.tx_hash,
    slot: record.source_slot,
    block_time: record.slice7_event.timestamp,
    disposition_type: 'supported_normalized_event',
    affected_token_mints: [record.slice7_event.token_in_mint, record.slice7_event.token_out_mint].sort(compareCodeUnits),
    normalized_event_digests: [record.event_digest],
    finding_digests: [],
  });
}

function buildFindingGroup(spec) {
  const source = { tx_hash: spec.signature, slot: spec.slot, block_time: spec.timestamp };
  const finding = buildActivityFindingV1({
    finding_type: spec.type,
    severity: 'candidate_blocking',
    impact_scope: spec.impactScope ?? 'token_specific',
    time_range: {
      first_observed_at: spec.timestamp,
      last_observed_at: spec.timestamp,
      first_observed_slot: spec.slot,
      last_observed_slot: spec.slot,
    },
    affected_token_mints: [...(spec.tokens ?? [])].sort(compareCodeUnits),
    affected_quote_mints: [...(spec.quotes ?? [])].sort(compareCodeUnits),
    source_transaction_digests: [computeSourceTransactionDigest(source)],
    source_event_digests: [],
    reason_codes: [spec.reason],
    impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
    disclosure_codes: ['activity_not_reconstructable'],
  });
  const disposition = buildDispositionV1({
    ...source,
    disposition_type: spec.type,
    affected_token_mints: [...(spec.tokens ?? [])].sort(compareCodeUnits),
    normalized_event_digests: [],
    finding_digests: [finding.finding_digest],
  });
  return { finding, disposition };
}

function makeScope(wallet, oldestAllowedTimestamp) {
  return {
    scope_version: 'wallet_candidate_scope_input_v1',
    chain: 'solana',
    network: 'mainnet-beta',
    genesis_hash: GENESIS_HASH,
    wallet,
    window: {
      window_version: 'fixed_lookback_latest_state_v1',
      lookback_profile: 'lookback_30d_v1',
      requested_lookback_seconds: 2592000,
      initial_before_signature: null,
      lower_bound: { oldest_allowed_timestamp: oldestAllowedTimestamp, completion_status: 'proven' },
    },
  };
}

function makeBoundary(anchorSlot, anchorBlockTime) {
  return {
    boundary_version: 'solana_finalized_acquisition_boundary_v1',
    chain: 'solana',
    network: 'mainnet-beta',
    genesis_hash: GENESIS_HASH,
    commitment: 'finalized',
    anchor_slot: anchorSlot,
    anchor_block_time: anchorBlockTime,
    anchor_blockhash: 'deterministic-finalized-blockhash',
    history_complete_through_anchor: true,
    lower_bound_completion_proven: true,
    boundary_status: 'proven',
  };
}

export function buildDeterministicCandidateFixtureV1(spec, { permuteInput = false } = {}) {
  const wallet = spec.wallet ?? 'fixture-wallet';
  const records = buildEventRecords(wallet, spec.events ?? []);
  const findingGroups = (spec.findings ?? []).map(buildFindingGroup);
  const findings = canonicalizeActivityFindingsV1(findingGroups.map(item => item.finding));
  const dispositions = canonicalizeTransactionDispositionsV1([
    ...records.map(buildSupportedDisposition),
    ...findingGroups.map(item => item.disposition),
  ]);
  const allSlots = dispositions.map(item => item.slot);
  const allTimes = dispositions.map(item => item.block_time).filter(value => value !== null);
  const anchorSlot = spec.anchorSlot ?? (allSlots.length ? Math.max(...allSlots) + 100 : 100);
  const anchorBlockTime = spec.anchorBlockTime ?? (allTimes.length ? Math.max(...allTimes) + 100 : 1000);
  const oldestAllowedTimestamp = spec.oldestAllowedTimestamp ?? Math.max(0, (allTimes.length ? Math.min(...allTimes) : 1) - 1);
  const profiles = {
    ...DEFAULT_PROFILES,
    mark_profile: (spec.marks ?? []).length === 0 ? null : DEFAULT_PROFILES.mark_profile,
    mark_max_age_seconds: (spec.marks ?? []).length === 0 ? null : DEFAULT_PROFILES.mark_max_age_seconds,
    ...(spec.profiles ?? {}),
  };
  const boundary = makeBoundary(anchorSlot, anchorBlockTime);
  const scope = makeScope(wallet, oldestAllowedTimestamp);
  const inputStatus = { ...COMPLETE_INPUT_STATUS };
  const coverage = recomputeCoverageV1({
    transactionDispositions: dispositions,
    normalizedEventRecords: records,
    activityFindings: findings,
    boundary,
    inputStatus,
    paginationTerminalReason: 'historical_bound_reached',
  });
  const acquisitionInput = {
    acquisition_result_version: 'wallet_wide_acquisition_result_v1',
    scope,
    profiles,
    boundary,
    input_status: inputStatus,
    coverage,
    transaction_dispositions: permuteInput ? [...dispositions].reverse() : dispositions,
    normalized_event_records: permuteInput ? [...records].reverse() : records,
    activity_findings: permuteInput ? [...findings].reverse() : findings,
  };
  if (permuteInput) {
    acquisitionInput.transaction_dispositions = canonicalizeTransactionDispositionsV1(acquisitionInput.transaction_dispositions);
    acquisitionInput.normalized_event_records = buildEventRecords(wallet, [...(spec.events ?? [])].reverse());
    acquisitionInput.activity_findings = canonicalizeActivityFindingsV1(acquisitionInput.activity_findings);
  }
  const acquisitionResult = buildWalletAcquisitionResultV1(acquisitionInput);
  const marks = (spec.marks ?? []).map(mark => buildMarkObservationV1(mark));
  const evidenceBundle = buildCandidateEvidenceBundleV1({ acquisitionResult, markObservations: permuteInput ? [...marks].reverse() : marks, profiles });
  const candidateSet = buildWalletCandidateSetV1({ evidenceBundle });
  return { acquisitionResult, evidenceBundle, candidateSet };
}

export const JUP_GOLDEN = deepFreeze({
  name: 'jup_golden_closed',
  wallet: '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni',
  tokenMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  quoteMint: USDC_MINT,
  events: [
    eventSpec({ token: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', timestamp: 1781904268, signature: '2ArLuJC2JEuWiavk1jYxLQ2E4xhq63BbeDV2kCWPcZ9zZNc4XyugUEFEryKrYfqcWnxkUvyacRmj2YNTfZGq17yV', slot: 10, buy: true, tokenAmount: 265951.319268, quoteAmount: 49728.694003 }),
    eventSpec({ token: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', timestamp: 1782068814, signature: '5YCdUYkJVx3kkZUpvz4ygs6QT8GZtYtru4kGkur3LJ8yrMmW2XJ8qXtgjspMpJqqyQA6WPDQxd4BcTpNNSr3Dctk', slot: 20, buy: false, tokenAmount: 265951.319268, quoteAmount: 58016.53285 }),
  ],
  receiptHash: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
  packageDigest: '5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278',
  memberHashes: Object.freeze({
    'archive-record.json': 'd28c5a58b920f526c5ed9e08e4e5b034d99285cd7182a1374f1eb9c10697c6ac',
    'canonical-receipt.json': 'c636cfda958eb87341d3225d33b53b7dc9dcf157def5cc3a054eb56cd4e9eb61',
    'economics.json': 'd8d716459707f3b8c7f95b2f6e64a3c1f1faf91e62629e0477213e4b4ed9ffbd',
    'manifest.json': '2ce234ccedcb52ac555f49129de7a3b6660506b04ed452c02503ec626646f1f6',
    'verification.json': '851c283e7e321bee61a939f1b39dbfb1f09ec038cdd078ceca50c8f7167c6ad0',
  }),
});

export const RAY_GOLDEN = deepFreeze({
  name: 'ray_same_mint_multi_input_closed',
  wallet: '5fK3484fbh8gnmhvTsPYxTC6un7Co5LVUSoubZPVL3YA',
  tokenMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  quoteMint: USDT_MINT,
  events: [
    eventSpec({ token: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', quoteMint: USDT_MINT, timestamp: 1769382291, signature: '2SUoNBBTkQBBGVCinvLQbVZq5LDZS5M8ikx5PLH7QiCuLdf6GWCPSM7wLd6gJsNUbLSousAhbkSX9eXgt1dAeBKm', slot: 10, buy: true, tokenAmount: 26644.791399, quoteAmount: 25000, source: 'JUPITER', extractionMethod: 'helius_enhanced_transaction_swap_v1', sameMintInputAmounts: [24975, 25] }),
    eventSpec({ token: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', quoteMint: USDT_MINT, timestamp: 1769632666, signature: '4TmWRpMxWRTpQqNM7iFCRyP1m9VEyRK54VZwKeQV4cYisYRjQRjuvocF8j7mNAomoQf6H2h4vfd5Qp6Y2LQxeEsB', slot: 20, buy: false, tokenAmount: 26644.791399, quoteAmount: 27347.717902, source: 'JUPITER', extractionMethod: 'helius_enhanced_transaction_swap_v1' }),
  ],
  receiptHash: '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
  packageDigest: '25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2',
  memberHashes: Object.freeze({
    'archive-record.json': '777987cf14a3e41034923a6acc0e87ce15ec7affef68b0e3fb32890ad24bd695',
    'canonical-receipt.json': '94717ca77018826e88bf39313c7b4b810ade1d42ed9f507809c649f1f6f3f2cb',
    'economics.json': '4664d29a151bba54051c4a8ef6044990a2ca474a4b45a421536106e9fa5d0ea8',
    'manifest.json': '9fffd0746b49b5e3b89dbf113675c76290c7ae10f99542a23b1c385e3c75b41e',
    'verification.json': '808c2d03cd54bb13ed418ea034075dc8b523cb01e6a9ce3359d2959498141e6d',
  }),
});

export const FIXTURE_MATRIX = deepFreeze({
  multipleCleanClosed: Object.freeze({
    name: 'multiple_clean_closed_positions', wallet: 'matrix-wallet',
    events: [
      eventSpec({ token: 'TOKEN-A', timestamp: 100, signature: 'sig-a-buy', slot: 10, buy: true, tokenAmount: 5, quoteAmount: 10 }),
      eventSpec({ token: 'TOKEN-B', timestamp: 110, signature: 'sig-b-buy', slot: 11, buy: true, tokenAmount: 4, quoteAmount: 8 }),
      eventSpec({ token: 'TOKEN-A', timestamp: 200, signature: 'sig-a-sell', slot: 20, buy: false, tokenAmount: 5, quoteAmount: 15 }),
      eventSpec({ token: 'TOKEN-B', timestamp: 210, signature: 'sig-b-sell', slot: 21, buy: false, tokenAmount: 4, quoteAmount: 12 }),
    ],
  }),
  reopened: Object.freeze({
    name: 'reopened_nonzero_segment', wallet: 'matrix-wallet',
    events: [
      eventSpec({ token: 'REOPEN', timestamp: 100, signature: 'reopen-buy-0', slot: 10, buy: true, tokenAmount: 5, quoteAmount: 10 }),
      eventSpec({ token: 'REOPEN', timestamp: 200, signature: 'reopen-sell-0', slot: 20, buy: false, tokenAmount: 5, quoteAmount: 12 }),
      eventSpec({ token: 'REOPEN', timestamp: 300, signature: 'reopen-buy-1', slot: 30, buy: true, tokenAmount: 4, quoteAmount: 8 }),
      eventSpec({ token: 'REOPEN', timestamp: 400, signature: 'reopen-sell-1', slot: 40, buy: false, tokenAmount: 4, quoteAmount: 11 }),
    ],
  }),
  openAndPartialHistory: Object.freeze({
    name: 'open_partial_and_limited', wallet: 'matrix-wallet', anchorSlot: 100, anchorBlockTime: 1000,
    events: [
      eventSpec({ token: 'REALIZED-PARTIAL', timestamp: 100, signature: 'partial-buy', slot: 10, buy: true, tokenAmount: 10, quoteAmount: 20 }),
      eventSpec({ token: 'REALIZED-PARTIAL', timestamp: 200, signature: 'partial-sell', slot: 20, buy: false, tokenAmount: 2, quoteAmount: 6 }),
      eventSpec({ token: 'CLEAN-OPEN', timestamp: 300, signature: 'open-buy', slot: 30, buy: true, tokenAmount: 4, quoteAmount: 8 }),
      eventSpec({ token: 'PARTIALLY-OBSERVED', timestamp: 350, signature: 'partially-observed-buy', slot: 35, buy: true, tokenAmount: 1, quoteAmount: 2 }),
      eventSpec({ token: 'LIMITED-HISTORY', timestamp: 400, signature: 'limited-sell', slot: 40, buy: false, tokenAmount: 3, quoteAmount: 9 }),
      eventSpec({ token: 'PARTIALLY-OBSERVED', timestamp: 450, signature: 'partially-observed-sell', slot: 45, buy: false, tokenAmount: 3, quoteAmount: 9 }),
    ],
    marks: [
      Object.freeze({ token_mint: 'REALIZED-PARTIAL', quote_mint: USDC_MINT, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 4, observed_at: 990, source_slot: 99, reason_code: null }),
      Object.freeze({ token_mint: 'CLEAN-OPEN', quote_mint: USDC_MINT, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 3, observed_at: 990, source_slot: 99, reason_code: null }),
      Object.freeze({ token_mint: 'LIMITED-HISTORY', quote_mint: USDC_MINT, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 4, observed_at: 990, source_slot: 99, reason_code: null }),
      Object.freeze({ token_mint: 'PARTIALLY-OBSERVED', quote_mint: USDC_MINT, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 4, observed_at: 990, source_slot: 99, reason_code: null }),
    ],
  }),
  localizedUnsupported: Object.freeze({
    name: 'localized_unsupported', wallet: 'matrix-wallet',
    events: [...JUP_GOLDEN.events],
    findings: [Object.freeze({ type: 'unsupported_activity', timestamp: 300, signature: 'unsupported-tx', slot: 30, tokens: ['BLOCKED'], quotes: [USDC_MINT], reason: 'unsupported_swap_shape' })],
  }),
  localizedAmbiguous: Object.freeze({
    name: 'localized_ambiguous_precedence', wallet: 'matrix-wallet',
    events: [...JUP_GOLDEN.events],
    findings: [
      Object.freeze({ type: 'unsupported_activity', timestamp: 300, signature: 'unsupported-tx', slot: 30, tokens: ['BLOCKED'], quotes: [USDC_MINT], reason: 'unsupported_swap_shape' }),
      Object.freeze({ type: 'ambiguous_activity', timestamp: 301, signature: 'ambiguous-tx', slot: 31, tokens: ['BLOCKED'], quotes: [USDC_MINT], reason: 'ambiguous_swap_direction' }),
    ],
  }),
  walletWideAmbiguous: Object.freeze({
    name: 'wallet_wide_indeterminate_ambiguity', wallet: 'matrix-wallet', events: [],
    findings: [Object.freeze({ type: 'ambiguous_activity', impactScope: 'wallet_wide', timestamp: 100, signature: 'wallet-wide-ambiguous', slot: 10, tokens: [], quotes: [], reason: 'ambiguous_swap_direction' })],
  }),
  sameTimestamp: Object.freeze({
    name: 'same_timestamp_signature_slot_digest_order', wallet: 'matrix-wallet',
    events: [
      eventSpec({ token: 'ORDER-A', timestamp: 100, signature: 'sig-b', slot: 10, buy: true, tokenAmount: 1, quoteAmount: 2 }),
      eventSpec({ token: 'ORDER-B', timestamp: 100, signature: 'sig-a', slot: 30, buy: true, tokenAmount: 1, quoteAmount: 2 }),
      eventSpec({ token: 'ORDER-C', timestamp: 100, signature: 'sig-c', slot: 20, buy: true, tokenAmount: 1, quoteAmount: 2 }),
    ],
  }),
});

export const REQUIRED_FIXTURE_CASES = deepFreeze({
  A: { fixture: 'multipleCleanClosed', proves: 'multiple clean closed positions' },
  B: { fixture: 'reopened', proves: 'nonzero segment index and complete same-mint history' },
  C: { fixture: 'openAndPartialHistory', proves: 'realized partial isolation and ineligibility' },
  D: { fixture: 'openAndPartialHistory', proves: 'clean open economics and mark boundary rules' },
  E: { fixture: 'openAndPartialHistory', proves: 'partial-history limits without fabricated basis' },
  F: { fixture: 'localizedUnsupported', proves: 'localized unsupported activity' },
  G: { fixture: 'localizedAmbiguous', proves: 'localized ambiguous precedence' },
  H: { fixture: 'walletWideAmbiguous', proves: 'wallet-wide indeterminate failure' },
  I: { fixture: 'reopened', proves: 'reopened ordering and complete event retention' },
  J: { fixture: 'RAY_GOLDEN', proves: 'same-mint multi-input aggregation identity' },
  K: { fixture: 'sameTimestamp', proves: 'timestamp/signature/slot/digest ordering' },
  L: { fixture: 'markCases', proves: 'available, missing, stale, after-boundary, and quote-mismatch marks' },
});
