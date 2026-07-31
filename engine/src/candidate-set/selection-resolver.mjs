import { buildPositionLedger } from '../ledger/position-ledger.mjs';
import { generateReceiptCandidates } from '../ledger/receipt-candidates.mjs';
import { RECEIPT_PACKAGE_PROFILES_V1 } from '../receipt-package/profiles.mjs';
import { validateWalletCandidateSetV1AgainstEvidenceBundle } from './builder.mjs';
import { validateCandidateEvidenceBundleV1 } from './evidence-bundle.mjs';
import { fail, WalletCandidateSetError } from './errors.mjs';
import {
  computeCandidateDigest,
  computeCandidateSetDigest,
  computeEvidenceBundleDigest,
} from './identity.mjs';
import { assertPlainJsonValue, cloneAndFreeze, clonePlainData } from './plain-data.mjs';
import {
  buildCandidateSelectionProjectionV1,
  validateCandidateSelectionProjectionV1,
} from './selection-projection.mjs';
import { GENESIS_HASH, validateCandidateSetV1 } from './schema.mjs';
import { canonicalJson } from './serialize.mjs';

export const CANDIDATE_SELECTION_RESOLUTION_VERSION = 'candidate_selection_resolution_v1';

const INPUT_STATUS = Object.freeze({
  acquisition_complete: true,
  normalization_complete: true,
  pagination_complete: true,
  truncated: false,
  capped: false,
  partial: false,
  provider_uncertain: false,
});

function invalidSelection() {
  fail('invalid_candidate_selection', 'candidate selection must contain exactly the two committed digests');
}

function safeInput(input) {
  try {
    assertPlainJsonValue(input, ['candidate_selection_resolution_input']);
  } catch {
    invalidSelection();
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalidSelection();
  const fields = ['candidateSet', 'evidenceBundle', 'selection'];
  const keys = Object.keys(input);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || fields.some(field => !Object.hasOwn(input, field))) invalidSelection();
  const selection = input.selection;
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) invalidSelection();
  const selectionFields = ['candidate_set_digest', 'candidate_digest'];
  const selectionKeys = Object.keys(selection);
  if (selectionKeys.length !== selectionFields.length || selectionKeys.some(key => !selectionFields.includes(key)) || selectionFields.some(field => !Object.hasOwn(selection, field))) invalidSelection();
  for (const field of selectionFields) if (typeof selection[field] !== 'string' || !/^[0-9a-f]{64}$/.test(selection[field])) invalidSelection();
  return clonePlainData(input);
}

function chainGate(candidateSet, evidenceBundle) {
  const setScope = candidateSet?.payload?.scope;
  const evidenceScope = evidenceBundle?.payload?.scope;
  if (setScope?.chain !== 'solana' || evidenceScope?.chain !== 'solana'
      || setScope?.network !== 'mainnet-beta' || evidenceScope?.network !== 'mainnet-beta') {
    fail('unsupported_network', 'candidate selection supports only Solana mainnet-beta');
  }
  if (setScope.genesis_hash !== GENESIS_HASH || evidenceScope.genesis_hash !== GENESIS_HASH) {
    fail('network_genesis_mismatch', 'candidate selection genesis hash does not match Solana mainnet-beta');
  }
}

function validateSetDigest(candidateSet, selectedDigest) {
  let recomputed;
  try {
    recomputed = computeCandidateSetDigest(candidateSet);
  } catch {
    fail('candidate_set_digest_mismatch', 'candidate-set digest does not recompute');
  }
  if (candidateSet === null || typeof candidateSet !== 'object' || Array.isArray(candidateSet)
      || typeof candidateSet.candidate_set_digest !== 'string'
      || recomputed !== candidateSet.candidate_set_digest
      || candidateSet.candidate_set_digest !== selectedDigest) {
    fail('candidate_set_digest_mismatch', 'candidate-set digest does not match the selected set');
  }
}

function validateEvidenceDigest(evidenceBundle) {
  let recomputed;
  try {
    recomputed = computeEvidenceBundleDigest(evidenceBundle);
  } catch {
    fail('evidence_bundle_digest_mismatch', 'evidence-bundle digest does not recompute');
  }
  if (evidenceBundle === null || typeof evidenceBundle !== 'object' || Array.isArray(evidenceBundle)
      || typeof evidenceBundle.evidence_bundle_digest !== 'string'
      || recomputed !== evidenceBundle.evidence_bundle_digest) {
    fail('evidence_bundle_digest_mismatch', 'evidence-bundle digest does not recompute');
  }
  try {
    validateCandidateEvidenceBundleV1(evidenceBundle);
  } catch {
    fail('evidence_bundle_digest_mismatch', 'evidence bundle is invalid or does not recompute');
  }
}

function locateMember(candidateSet, candidateDigest) {
  if (!Array.isArray(candidateSet?.payload?.candidates)) fail('candidate_not_found', 'selected candidate is absent from the candidate set');
  const matches = candidateSet.payload.candidates.filter(candidate => candidate?.candidate_digest === candidateDigest);
  if (matches.length === 0) fail('candidate_not_found', 'selected candidate is absent from the candidate set');
  if (matches.length !== 1) fail('candidate_selection_ambiguous', 'selected candidate membership is ambiguous');
  const candidate = matches[0];
  try {
    if (computeCandidateDigest(candidate) !== candidate.candidate_digest) fail('candidate_not_member_of_set', 'selected candidate digest does not bind its member content');
  } catch {
    fail('candidate_not_member_of_set', 'selected candidate is not a valid member of the candidate set');
  }
  return candidate;
}

function validateBinding(candidateSet, evidenceBundle) {
  const set = candidateSet.payload;
  const evidence = evidenceBundle.payload;
  if (set.commitments?.evidence_bundle_digest !== evidenceBundle.evidence_bundle_digest) fail('evidence_bundle_not_bound_to_set', 'candidate set does not commit to the supplied evidence bundle');
  const scopeMatches = set.scope.wallet === evidence.scope.wallet
    && set.scope.chain === evidence.scope.chain
    && set.scope.network === evidence.scope.network
    && set.scope.genesis_hash === evidence.scope.genesis_hash
    && canonicalJson(set.scope.window) === canonicalJson(evidence.scope.window);
  const commitmentMatches = set.commitments.coverage_digest === evidence.coverage.coverage_digest
    && set.commitments.transaction_dispositions_digest === evidence.integrity.transaction_dispositions_digest
    && set.commitments.normalized_events_digest === evidence.integrity.normalized_events_digest
    && set.commitments.activity_findings_digest === evidence.integrity.activity_findings_digest
    && set.commitments.mark_observations_digest === evidence.integrity.mark_observations_digest
    && canonicalJson(set.coverage) === canonicalJson(evidence.coverage)
    && canonicalJson(set.profiles) === canonicalJson(evidence.profiles);
  if (!scopeMatches || !commitmentMatches) fail('evidence_bundle_not_bound_to_set', 'candidate-set scope or integrity commitments do not reconcile with evidence');
  try {
    validateCandidateSetV1(candidateSet);
  } catch {
    fail('evidence_bundle_not_bound_to_set', 'candidate set is invalid or does not reconcile with its committed evidence indexes');
  }
}

function validateCompleteCandidateSet(candidateSet, evidenceBundle) {
  try {
    validateWalletCandidateSetV1AgainstEvidenceBundle(candidateSet, evidenceBundle);
  } catch {
    fail('evidence_bundle_not_bound_to_set', 'candidate set does not reconstruct exactly from its committed evidence bundle');
  }
}

function requireSelectable(candidate) {
  const projection = candidate?.projection;
  if (projection === null || typeof projection !== 'object' || Array.isArray(projection)) fail('candidate_not_selectable', 'candidate is not a selectable clean closed position');
  if (projection.selection_status !== 'selectable' || projection.candidate_type !== 'closed_position' || projection.ledger_evidence_status !== 'clean') fail('candidate_not_selectable', 'candidate is not a selectable clean closed position');
  if (projection.package_eligibility !== 'eligible_closed_position_v1') fail('candidate_not_publication_eligible', 'candidate is not eligible for closed-position publication');
}

function regenerate(candidate, events, accountingMethodVersion) {
  let candidates;
  try {
    const ledger = buildPositionLedger(events, { accountingMethodVersion });
    candidates = generateReceiptCandidates(ledger, candidate.selection_key.wallet, { chain: candidate.projection.chain });
  } catch {
    fail('slice7_input_derivation_failed', 'candidate ledger regeneration failed');
  }
  const key = candidate.selection_key;
  const matches = candidates.filter(item => item.wallet === key.wallet
    && item.token_mint === key.token_mint
    && item.candidate_type === key.receipt_type
    && item.segment_index === key.segment_index);
  if (matches.length === 0) fail('regenerated_candidate_not_found', 'selected candidate did not regenerate from projected evidence');
  if (matches.length !== 1) fail('regenerated_candidate_ambiguous', 'selected candidate regenerated ambiguously');
  if (matches[0].candidate_hash !== candidate.ledger_candidate_hash) fail('ledger_candidate_hash_mismatch', 'regenerated ledger candidate hash does not match the committed candidate');
}

export function resolveCandidateSelectionV1(input) {
  const detached = safeInput(input);
  const { candidateSet, evidenceBundle, selection } = detached;
  validateSetDigest(candidateSet, selection.candidate_set_digest);
  chainGate(candidateSet, evidenceBundle);
  validateEvidenceDigest(evidenceBundle);
  const candidate = locateMember(candidateSet, selection.candidate_digest);
  requireSelectable(candidate);
  validateBinding(candidateSet, evidenceBundle);

  const projection = buildCandidateSelectionProjectionV1({
    evidenceBundle,
    tokenMint: candidate.selection_key.token_mint,
  });
  validateCandidateSelectionProjectionV1({
    evidenceBundle,
    tokenMint: candidate.selection_key.token_mint,
    projection,
  });
  const receiptScopedEvidence = projection.receipt_scoped_evidence;
  if (receiptScopedEvidence.receipt_scoped_evidence_digest !== candidate.receipt_scoped_evidence_digest) fail('receipt_scoped_evidence_digest_mismatch', 'projected receipt-scoped evidence does not match the selected candidate commitment');

  regenerate(candidate, receiptScopedEvidence.events, evidenceBundle.payload.profiles.accounting_method_version);
  validateCompleteCandidateSet(candidateSet, evidenceBundle);

  const key = candidate.selection_key;
  const slice7Request = {
    normalizedEvents: receiptScopedEvidence.events,
    inputStatus: INPUT_STATUS,
    target: {
      wallet: key.wallet,
      token_mint: key.token_mint,
      receipt_type: 'closed_position',
      segment_index: key.segment_index,
    },
    profiles: {
      ...RECEIPT_PACKAGE_PROFILES_V1,
      accounting_method_version: evidenceBundle.payload.profiles.accounting_method_version,
    },
    mode: 'dry_run',
  };
  const result = {
    resolution_version: CANDIDATE_SELECTION_RESOLUTION_VERSION,
    slice7_request: slice7Request,
    audit: {
      candidate_set_digest: candidateSet.candidate_set_digest,
      evidence_bundle_digest: evidenceBundle.evidence_bundle_digest,
      candidate_digest: candidate.candidate_digest,
      receipt_scoped_evidence_digest: receiptScopedEvidence.receipt_scoped_evidence_digest,
      ledger_candidate_hash: candidate.ledger_candidate_hash,
      projection_mapping: projection.projection_mapping,
    },
  };
  try {
    return cloneAndFreeze(result);
  } catch (error) {
    if (error instanceof WalletCandidateSetError) throw error;
    fail('slice7_input_derivation_failed', 'Slice 7 request derivation failed');
  }
}
