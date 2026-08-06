import { buildWalletAcquisitionResultV1 } from '../candidate-set/acquisition-result.mjs';
import { canonicalizeActivityFindingsV1 } from '../candidate-set/activity-findings.mjs';
import { recomputeCoverageV1 } from '../candidate-set/coverage.mjs';
import {
  canonicalizeTransactionDispositionsV1,
  compareNormalizedEventRecordsV1,
  compareTransactionDispositionsV1,
  validateDispositionAccountingV1,
} from '../candidate-set/dispositions.mjs';

import {
  buildFinalizedAcquisitionBoundaryV1,
  createFinalizedAnchorSearchStateV1,
  advanceFinalizedAnchorSearchStateV1,
  deriveOldestAllowedTimestampV1,
} from './boundary-contract.mjs';

import {
  acceptWalletHistoryPageV1,
  advancePaginationPhaseV1,
  createPaginationStateV1,
  startPaginationV1,
} from './pagination-contract.mjs';
import {
  beginWalletHistoryAcquisitionV1,
  createWalletHistoryPortV1,
  failWalletAcquisitionOperationV1,
  sanitizeWalletAcquisitionErrorV1,
} from './provider-port.mjs';
import { validateWalletAcquisitionRequestV1 } from './request-contract.mjs';
import { buildSolanaSpotEvidenceV1, buildWalletSourceTransactionFromSpotEvidenceV1 } from './solana-spot-evidence.mjs';
import { classifyWalletSourceTransactionV1 } from './transaction-classifier.mjs';
import { normalizeWalletWideSolanaSpotEvidenceV1 } from './wallet-wide-normalizer.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './solana-identities.mjs';

function fail(code) { failWalletAcquisitionOperationV1(code); }
function exactObject(value, fields, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail(code);
}
function sameSource(left, right) {
  return left.signature === right.signature && left.slot === right.slot
    && left.block_time === right.block_time && left.execution_state === right.execution_state;
}
function validateCanonicalSource(source) {
  exactObject(source, ['signature','slot','block_time','execution_state'], 'pagination_incomplete');
  if (!isSolanaSignatureV1(source.signature)
      || !Number.isSafeInteger(source.slot) || source.slot < 0 || !Number.isSafeInteger(source.block_time) || source.block_time < 0
      || !['succeeded','failed'].includes(source.execution_state)) fail('pagination_incomplete');
}
function assertBoundaryCoherent(source, anchor) {
  if ((source.slot <= anchor.slot && source.block_time > anchor.block_time)
      || (source.slot > anchor.slot && source.block_time <= anchor.block_time)) fail('finalized_boundary_incoherent');
}

async function finalizedAnchor(port, request) {
  const identity = await port.getNetworkIdentityV1();
  exactObject(identity, ['chain','network','genesis_hash'], 'chain_identity_mismatch');
  if (identity.chain !== request.chain || identity.network !== request.network || identity.genesis_hash !== request.genesis_hash) fail('chain_identity_mismatch');
  const initialSlot = await port.getFinalizedSlotV1();
  if (!Number.isSafeInteger(initialSlot) || initialSlot < 0) fail('finalized_boundary_incoherent');
  let state = createFinalizedAnchorSearchStateV1({ initial_slot: initialSlot, max_anchor_search_slots: request.finality.max_anchor_search_slots });
  while (state.search_status === 'searching') {
    const requestedSlot = state.next_slot;
    const block = await port.getFinalizedBlockV1({ slot: requestedSlot });
    if (block === null) {
      state = advanceFinalizedAnchorSearchStateV1(state, 'unavailable');
      continue;
    }
    exactObject(block, ['slot','block_time','blockhash','commitment'], 'finalized_boundary_incoherent');
    if (block.slot !== requestedSlot || !Number.isSafeInteger(block.block_time) || block.block_time < 0
        || !isSolanaPublicKeyV1(block.blockhash) || block.commitment !== 'finalized') fail('finalized_boundary_incoherent');
    state = advanceFinalizedAnchorSearchStateV1(state, 'found');
    return { slot: block.slot, block_time: block.block_time, blockhash: block.blockhash };
  }
  fail('finalized_boundary_unavailable');
}

async function paginateInitial(port, request, anchor, oldest) {
  let state = startPaginationV1(createPaginationStateV1({
    oldest_allowed_timestamp: oldest,
    page_size: request.budgets.page_size,
    max_pages: request.budgets.max_pages,
    max_transactions: request.budgets.max_transactions,
  }));
  const sourceBySignature = new Map();
  let headFloor = null;
  while (['acquiring_head','paginating'].includes(state.phase)) {
    const before = state.phase === 'acquiring_head' ? null : state.next_before_signature;
    const page = await port.getFinalizedWalletSignaturePageV1({ wallet: request.wallet, before, limit: request.budgets.page_size, commitment: 'finalized' });
    if (!Array.isArray(page) || page.length > request.budgets.page_size) fail('pagination_incomplete');
    for (const source of page) {
      validateCanonicalSource(source);
      assertBoundaryCoherent(source, anchor);
      const prior = sourceBySignature.get(source.signature);
      if (prior !== undefined) {
        if (sameSource(prior, source)) fail('pagination_cursor_repeated');
        fail('pagination_duplicate_conflict');
      }
      sourceBySignature.set(source.signature, source);
    }
    if (headFloor === null) {
      const atOrBelow = page.filter(source => source.slot <= anchor.slot && source.block_time <= anchor.block_time);
      if (atOrBelow.length) headFloor = atOrBelow.at(-1).signature;
    }
    state = acceptWalletHistoryPageV1(state, {
      before_signature: before,
      page: page.map(({ signature, slot, block_time }) => ({ signature, slot, block_time })),
    });
    if (state.status === 'failed') fail(state.pagination_terminal_reason);
  }
  const authoritative = [...sourceBySignature.values()].filter(source => (
    source.slot <= anchor.slot && source.block_time <= anchor.block_time
      && source.block_time >= oldest
  ));
  return { state, sourceBySignature, authoritative, headFloor };
}

async function proveLatestState(port, request, anchor, initial) {
  let before = null; let previous = null;
  let pages = initial.state.pages_accepted;
  let entries = initial.state.provider_entries_examined;
  let reached = false;
  const seen = new Map();
  while (!reached) {
    if (pages >= request.budgets.max_pages || entries >= request.budgets.max_transactions) fail('latest_state_unproven');
    let page;
    try { page = await port.getFinalizedWalletSignaturePageV1({ wallet: request.wallet, before, limit: request.budgets.page_size, commitment: 'finalized' }); }
    catch (error) {
      const sanitized = sanitizeWalletAcquisitionErrorV1(error);
      if (['acquisition_deadline_exceeded','provider_retry_exhausted','provider_timeout','provider_transient_failure','provider_uncertain'].includes(sanitized.code)) fail('latest_state_unproven');
      throw sanitized;
    }
    if (!Array.isArray(page) || page.length > request.budgets.page_size || entries + page.length > request.budgets.max_transactions) fail('latest_state_unproven');
    pages += 1; entries += page.length;
    for (const source of page) {
      try { validateCanonicalSource(source); assertBoundaryCoherent(source, anchor); } catch { fail('latest_state_unproven'); }
      if (source.signature === before || seen.has(source.signature)) fail('latest_state_unproven');
      if (previous !== null && (source.slot > previous.slot || source.block_time > previous.block_time)) fail('latest_state_unproven');
      seen.set(source.signature, source); previous = source;
      const priorObserved = initial.sourceBySignature.get(source.signature);
      if (priorObserved !== undefined && !sameSource(priorObserved, source)) fail('latest_state_unproven');
      if (source.slot <= anchor.slot && source.block_time <= anchor.block_time) {
        if (priorObserved === undefined) fail('latest_state_unproven');
      }
      if (initial.headFloor !== null && source.signature === initial.headFloor) reached = true;
    }
    if (reached) break;
    if (page.length < request.budgets.page_size) {
      if (initial.headFloor !== null) fail('latest_state_unproven');
      reached = true;
      break;
    }
    const next = page.at(-1).signature;
    if (next === before) fail('latest_state_unproven');
    before = next;
  }
}

function reconcileEnhanced(wallet, sources, evidenceRecords) {
  if (!Array.isArray(evidenceRecords) || evidenceRecords.length !== sources.length) fail('source_transaction_mismatch');
  const canonical = new Map(sources.map(source => [source.signature, source]));
  const projected = new Map();
  for (const candidate of evidenceRecords) {
    let evidence;
    try { evidence = buildSolanaSpotEvidenceV1(candidate); } catch { fail('source_transaction_mismatch'); }
    const source = canonical.get(evidence.signature);
    if (evidence.wallet !== wallet || source === undefined || projected.has(evidence.signature)
        || evidence.slot !== source.slot || evidence.block_time !== source.block_time || evidence.execution_state !== source.execution_state) fail('source_transaction_mismatch');
    projected.set(evidence.signature, evidence);
  }
  if (projected.size !== canonical.size) fail('source_transaction_mismatch');
  return projected;
}

function classifyOne(source, evidenceBySignature, provisionalRawIndex) {
  const evidence = evidenceBySignature.get(source.signature);
  if (evidence === undefined) fail('source_transaction_mismatch');
  let classification;
  try {
    const sourceTransaction = buildWalletSourceTransactionFromSpotEvidenceV1(evidence);
    classification = classifyWalletSourceTransactionV1({
      sourceTransaction,
      normalizeSupportedSpotOperation: () => normalizeWalletWideSolanaSpotEvidenceV1({ evidence, provisional_raw_index: provisionalRawIndex }),
    });
  } catch (error) {
    throw sanitizeWalletAcquisitionErrorV1(error, 'transaction_disposition_failed');
  }
  if (classification.activity_findings.some(finding => finding.impact_scope === 'wallet_wide')) fail('wallet_wide_impact_unresolved');
  return classification;
}

function classifyAll(sources, evidenceBySignature) {
  const discovery = sources.map(source => ({ source, classification: classifyOne(source, evidenceBySignature, 0) }));
  const canonicalSources = discovery.sort((left, right) => compareTransactionDispositionsV1(left.classification.disposition, right.classification.disposition)).map(item => item.source);
  let counter = 0;
  let classifications = canonicalSources.map(source => {
    const classification = classifyOne(source, evidenceBySignature, counter);
    if (classification.disposition.disposition_type === 'supported_normalized_event') counter += 1;
    return classification;
  });
  let events = classifications.flatMap(item => item.normalized_event_records).sort(compareNormalizedEventRecordsV1);
  if (events.some((event, index) => event.slice7_event.raw_index !== index)) {
    const canonicalIndex = new Map(events.map((event, index) => [event.slice7_event.tx_hash, index]));
    classifications = canonicalSources.map(source => classifyOne(source, evidenceBySignature, canonicalIndex.get(source.signature) ?? 0));
    events = classifications.flatMap(item => item.normalized_event_records).sort(compareNormalizedEventRecordsV1);
  }
  if (events.some((event, index) => event.slice7_event.raw_index !== index)) fail('event_finding_reconciliation_failed');
  return {
    dispositions: canonicalizeTransactionDispositionsV1(classifications.map(item => item.disposition)),
    events,
    findings: canonicalizeActivityFindingsV1(classifications.flatMap(item => item.activity_findings)),
  };
}

function completeStatus() {
  return { coverage_status: 'complete', acquisition_complete: true, normalization_complete: true, classification_complete: true, pagination_complete: true, historical_bound_proven: true, chain_boundary_proven: true, truncated: false, capped: false, partial: false, provider_uncertain: false };
}

async function acquire(requestInput, dependencyInput) {
  validateWalletAcquisitionRequestV1(requestInput);
  exactObject(dependencyInput, ['walletHistoryPort'], 'acquisition_capability_denied');
  const request = structuredClone(requestInput);
  const port = createWalletHistoryPortV1(dependencyInput.walletHistoryPort);
  beginWalletHistoryAcquisitionV1(port, request.budgets);
  const anchor = await finalizedAnchor(port, request);
  const oldest = deriveOldestAllowedTimestampV1({ anchor_block_time: anchor.block_time, requested_lookback_seconds: request.window.requested_lookback_seconds });
  const pagination = await paginateInitial(port, request, anchor, oldest);
  await proveLatestState(port, request, anchor, pagination);
  let state = advancePaginationPhaseV1(pagination.state, 'enriching');
  const signatures = pagination.authoritative.map(source => source.signature);
  const evidenceRecords = await port.getEnhancedTransactionsBySignatureV1({ wallet: request.wallet, signatures });
  const evidence = reconcileEnhanced(request.wallet, pagination.authoritative, evidenceRecords);
  state = advancePaginationPhaseV1(state, 'classifying');
  const assembled = classifyAll(pagination.authoritative, evidence);
  state = advancePaginationPhaseV1(state, 'reconciling');
  const boundary = buildFinalizedAcquisitionBoundaryV1({
    boundary_version: 'solana_finalized_acquisition_boundary_v1', chain: request.chain, network: request.network,
    genesis_hash: request.genesis_hash, commitment: 'finalized', anchor_slot: anchor.slot,
    anchor_block_time: anchor.block_time, anchor_blockhash: anchor.blockhash,
    history_complete_through_anchor: true, lower_bound_completion_proven: true, boundary_status: 'proven',
  });
  validateDispositionAccountingV1({ transactionDispositions: assembled.dispositions, normalizedEventRecords: assembled.events, activityFindings: assembled.findings, wallet: request.wallet, anchorSlot: anchor.slot });
  if (assembled.dispositions.length !== pagination.authoritative.length
      || new Set(assembled.dispositions.map(item => item.tx_hash)).size !== pagination.authoritative.length
      || pagination.authoritative.some(source => !assembled.dispositions.some(item => item.tx_hash === source.signature))) fail('event_finding_reconciliation_failed');
  const inputStatus = completeStatus();
  const coverage = recomputeCoverageV1({ transactionDispositions: assembled.dispositions, normalizedEventRecords: assembled.events, activityFindings: assembled.findings, boundary, inputStatus, paginationTerminalReason: state.pagination_terminal_reason });
  state = advancePaginationPhaseV1(state, 'complete');
  if (state.status !== 'successful') fail('pagination_incomplete');
  return buildWalletAcquisitionResultV1({
    acquisition_result_version: 'wallet_wide_acquisition_result_v1',
    scope: { scope_version: 'wallet_candidate_scope_input_v1', chain: request.chain, network: request.network, genesis_hash: request.genesis_hash, wallet: request.wallet, window: { ...request.window, lower_bound: { oldest_allowed_timestamp: oldest, completion_status: 'proven' } } },
    profiles: { ...request.profiles, reconstruction_engine_version: 'artifact_position_ledger_receipt_v1', accounting_method_version: 'weighted_average_position_accounting_v1', mark_profile: null, mark_max_age_seconds: null },
    boundary, input_status: inputStatus, coverage,
    transaction_dispositions: assembled.dispositions, normalized_event_records: assembled.events, activity_findings: assembled.findings,
  });
}

export async function acquireWalletHistoryV1(request, dependencies) {
  try { return await acquire(request, dependencies); }
  catch (error) { throw sanitizeWalletAcquisitionErrorV1(error, 'provider_uncertain'); }
}
