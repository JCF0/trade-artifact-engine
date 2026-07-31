import { buildPositionLedger } from '../ledger/position-ledger.mjs';
import { generateReceiptCandidates } from '../ledger/receipt-candidates.mjs';
import { canonicalizeActivityFindingsV1 } from './activity-findings.mjs';
import { buildBlockedSummariesV1, buildBlockedTokenOverlayV1 } from './blocked-summary.mjs';
import { validateCandidateEvidenceBundleV1 } from './evidence-bundle.mjs';
import { fail } from './errors.mjs';
import { buildCandidateSetV1, computeScopeDigest, computeWindowDigest } from './identity.mjs';
import { compareCodeUnits } from './order.mjs';
import { assertPlainJsonValue } from './plain-data.mjs';
import { projectCandidateV1 } from './project-candidate.mjs';
import { buildReceiptScopedEvidenceV1 } from './receipt-scoped-evidence.mjs';
import { CANDIDATE_SET_VERSION, SCOPE_VERSION, validateCandidateSetV1 } from './schema.mjs';
import { canonicalJson } from './serialize.mjs';

function exactInput(input, fields, context) {
  assertPlainJsonValue(input, [context]);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('invalid_candidate_set_input', `${context} must be an object`);
  const keys = Object.keys(input);
  if (keys.some(key => !fields.includes(key)) || fields.some(field => !Object.hasOwn(input, field))) fail('invalid_candidate_set_input', `${context} fields are invalid`);
}

function sortedByDigest(values, field) {
  return [...values].sort((left, right) => compareCodeUnits(left[field], right[field]));
}

function buildCounts(candidates, blockedSummaries, findings) {
  return {
    candidate_count: candidates.length,
    closed_candidate_count: candidates.filter(item => item.projection.candidate_type === 'closed_position').length,
    partial_candidate_count: candidates.filter(item => item.projection.candidate_type === 'realized_partial').length,
    open_candidate_count: candidates.filter(item => item.projection.candidate_type === 'open_snapshot').length,
    limited_candidate_count: candidates.filter(item => item.projection.ledger_evidence_status === 'limited_partial_history').length,
    selectable_candidate_count: candidates.filter(item => item.projection.selection_status === 'selectable').length,
    blocked_summary_count: blockedSummaries.length,
    finding_count: findings.length,
  };
}

function markForCandidate(candidate, marks) {
  const exact = marks.find(mark => mark.token_mint === candidate.token_mint && mark.quote_mint === candidate.quote_mint);
  if (exact) return exact;
  return marks.find(mark => mark.token_mint === candidate.token_mint) ?? null;
}

function candidateScope(payload) {
  const source = payload.scope;
  const windowDigest = computeWindowDigest({ chain: source.chain, network: source.network, genesis_hash: source.genesis_hash, wallet: source.wallet, window: source.window });
  const scopeDigest = computeScopeDigest({ chain: source.chain, network: source.network, genesis_hash: source.genesis_hash, wallet: source.wallet, window_digest: windowDigest, coverage_digest: payload.coverage.coverage_digest, profiles: payload.profiles });
  return {
    scope_version: SCOPE_VERSION,
    scope_digest: scopeDigest,
    window_digest: windowDigest,
    chain: source.chain,
    network: source.network,
    genesis_hash: source.genesis_hash,
    wallet: source.wallet,
    window: source.window,
  };
}

function expectedCommitments(evidenceBundle) {
  const { coverage, integrity } = evidenceBundle.payload;
  return {
    evidence_bundle_digest: evidenceBundle.evidence_bundle_digest,
    coverage_digest: coverage.coverage_digest,
    transaction_dispositions_digest: integrity.transaction_dispositions_digest,
    normalized_events_digest: integrity.normalized_events_digest,
    activity_findings_digest: integrity.activity_findings_digest,
    mark_observations_digest: integrity.mark_observations_digest,
  };
}

function constructCandidateSetPayload(evidenceBundle) {
  const evidence = evidenceBundle.payload;
  const overlay = buildBlockedTokenOverlayV1({ activityFindings: evidence.activity_findings });
  const blockedTokenMints = new Set(overlay.blockedTokenMints);
  const supportedEvents = evidence.normalized_event_records
    .filter(record => !blockedTokenMints.has(record.slice7_event.token_in_mint) && !blockedTokenMints.has(record.slice7_event.token_out_mint))
    .map(record => record.slice7_event);
  const ledger = buildPositionLedger(supportedEvents, { accountingMethodVersion: evidence.profiles.accounting_method_version });
  const ledgerCandidates = generateReceiptCandidates(ledger, evidence.scope.wallet, { chain: evidence.scope.chain, snapshotAt: evidence.boundary.anchor_block_time });
  const candidates = ledgerCandidates.map(ledgerCandidate => {
    if (blockedTokenMints.has(ledgerCandidate.token_mint)) fail('blocked_token_candidate_forbidden', 'blocked token entered ledger candidate construction');
    const receiptScopedEvidence = buildReceiptScopedEvidenceV1({ wallet: evidence.scope.wallet, tokenMint: ledgerCandidate.token_mint, normalizedEventRecords: evidence.normalized_event_records });
    const associatedFindings = evidence.activity_findings.filter(finding => !finding.impact.blocks_candidate_projection && finding.affected_token_mints.includes(ledgerCandidate.token_mint));
    return projectCandidateV1({ ledgerCandidate, receiptScopedEvidence, boundary: evidence.boundary, markObservation: markForCandidate(ledgerCandidate, evidence.mark_observations), associatedFindings });
  });
  const orderedCandidates = sortedByDigest(candidates, 'candidate_digest');
  const blockedSummaries = buildBlockedSummariesV1({ chain: evidence.scope.chain, network: evidence.scope.network, wallet: evidence.scope.wallet, activityFindings: evidence.activity_findings });
  const findings = canonicalizeActivityFindingsV1(evidence.activity_findings);
  return {
    scope: candidateScope(evidence),
    profiles: evidence.profiles,
    commitments: expectedCommitments(evidenceBundle),
    coverage: evidence.coverage,
    counts: buildCounts(orderedCandidates, blockedSummaries, findings),
    candidates: orderedCandidates,
    blocked_summaries: blockedSummaries,
    activity_findings: findings,
  };
}

export function validateWalletCandidateSetV1AgainstEvidenceBundle(candidateSet, evidenceBundle) {
  validateCandidateEvidenceBundleV1(evidenceBundle);
  validateCandidateSetV1(candidateSet);
  const evidence = evidenceBundle.payload;
  const payload = candidateSet.payload;
  if (candidateSet.candidate_set_version !== CANDIDATE_SET_VERSION || canonicalJson(payload.commitments) !== canonicalJson(expectedCommitments(evidenceBundle))) fail('candidate_set_commitment_mismatch', 'candidate-set commitments do not match the evidence bundle');
  if (canonicalJson(payload.scope.window) !== canonicalJson(evidence.scope.window) || payload.scope.wallet !== evidence.scope.wallet || payload.scope.chain !== evidence.scope.chain || payload.scope.network !== evidence.scope.network || payload.scope.genesis_hash !== evidence.scope.genesis_hash) fail('candidate_scope_mismatch', 'candidate-set scope does not match evidence scope');
  if (canonicalJson(payload.profiles) !== canonicalJson(evidence.profiles) || canonicalJson(payload.coverage) !== canonicalJson(evidence.coverage)) fail('candidate_set_commitment_mismatch', 'candidate-set profiles or coverage do not match evidence');
  const overlay = buildBlockedTokenOverlayV1({ activityFindings: evidence.activity_findings });
  const blocked = new Set(overlay.blockedTokenMints);
  for (const candidate of payload.candidates) {
    if (blocked.has(candidate.projection.token_mint)) fail('blocked_token_candidate_forbidden', 'blocked token has an authoritative candidate projection');
    const scoped = buildReceiptScopedEvidenceV1({ wallet: evidence.scope.wallet, tokenMint: candidate.projection.token_mint, normalizedEventRecords: evidence.normalized_event_records });
    if (scoped.receipt_scoped_evidence_digest !== candidate.receipt_scoped_evidence_digest || candidate.projection.event_counts.supported_events !== scoped.events.length) fail('candidate_evidence_incomplete', 'candidate receipt-scoped evidence does not reconcile');
    if (candidate.projection.snapshot !== null) {
      const boundary = candidate.projection.snapshot.source_boundary;
      if (boundary.genesis_hash !== evidence.scope.genesis_hash || boundary.source_slot !== evidence.boundary.anchor_slot || boundary.source_block_time !== evidence.boundary.anchor_block_time || candidate.projection.snapshot.snapshot_at !== evidence.boundary.anchor_block_time) fail('candidate_scope_mismatch', 'candidate snapshot boundary does not match evidence');
    }
  }
  const expectedSummaries = buildBlockedSummariesV1({ chain: evidence.scope.chain, network: evidence.scope.network, wallet: evidence.scope.wallet, activityFindings: evidence.activity_findings });
  if (canonicalJson(payload.blocked_summaries) !== canonicalJson(expectedSummaries)) fail('blocked_summary_mismatch', 'blocked summaries do not reconcile with evidence findings');
  const expectedFindings = canonicalizeActivityFindingsV1(evidence.activity_findings);
  if (canonicalJson(payload.activity_findings) !== canonicalJson(expectedFindings)) fail('candidate_set_finding_mismatch', 'candidate-set findings do not reconcile with evidence');
  const counts = buildCounts(payload.candidates, payload.blocked_summaries, payload.activity_findings);
  if (canonicalJson(payload.counts) !== canonicalJson(counts)) fail('candidate_set_count_mismatch', 'candidate-set counts were not recomputed');
  const reconstructed = constructCandidateSetPayload(evidenceBundle);
  if (canonicalJson(payload.candidates) !== canonicalJson(reconstructed.candidates)) fail('candidate_projection_mismatch', 'candidate projections do not reconstruct exactly from evidence');
  if (canonicalJson(payload) !== canonicalJson(reconstructed)) fail('candidate_set_reconstruction_mismatch', 'candidate-set payload does not reconstruct exactly from evidence');
  return true;
}

export function buildWalletCandidateSetV1(input) {
  exactInput(input, ['evidenceBundle'], 'wallet candidate set builder input');
  const evidenceBundle = input.evidenceBundle;
  validateCandidateEvidenceBundleV1(evidenceBundle);
  const evidence = evidenceBundle.payload;
  if (evidence.coverage.coverage_status !== 'complete' || evidence.input_status.coverage_status !== 'complete') fail('incomplete_acquisition_input', 'candidate construction requires complete evidence coverage');
  const payload = constructCandidateSetPayload(evidenceBundle);
  const candidateSet = buildCandidateSetV1(payload);
  validateWalletCandidateSetV1AgainstEvidenceBundle(candidateSet, evidenceBundle);
  return candidateSet;
}

export const validateWalletCandidateSetV1 = validateWalletCandidateSetV1AgainstEvidenceBundle;
