import { validateCandidateEvidenceBundleV1 } from './evidence-bundle.mjs';
import { fail } from './errors.mjs';
import { computeDispositionDigest, computeEventRecordDigest } from './identity.mjs';
import { assertPlainJsonValue, cloneAndFreeze } from './plain-data.mjs';
import {
  buildReceiptScopedEvidenceV1,
  validateReceiptScopedEvidenceV1,
} from './receipt-scoped-evidence.mjs';
import { canonicalJson } from './serialize.mjs';

export const SELECTION_PROJECTION_VERSION = 'wallet_candidate_selection_projection_v1';
export const PROJECTION_MAPPING_VERSION = 'wallet_candidate_selection_evidence_mapping_v1';

function exactInput(input, fields) {
  try {
    assertPlainJsonValue(input, ['selection_projection_input']);
  } catch {
    fail('selection_projection_incomplete', 'candidate selection projection input is invalid');
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('selection_projection_incomplete', 'candidate selection projection input is invalid');
  const keys = Object.keys(input);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || fields.some(field => !Object.hasOwn(input, field))) fail('selection_projection_incomplete', 'candidate selection projection input is invalid');
}

function affectsToken(record, tokenMint) {
  return record.slice7_event.token_in_mint === tokenMint || record.slice7_event.token_out_mint === tokenMint;
}

function targetFindingPresent(evidence, tokenMint) {
  return evidence.activity_findings.some(finding => (
    finding.affected_token_mints.includes(tokenMint)
    && (finding.finding_type === 'unsupported_activity'
      || finding.finding_type === 'ambiguous_activity'
      || finding.impact.blocks_candidate_projection)
  )) || evidence.activity_findings.some(finding => (
    finding.impact_scope === 'wallet_wide'
    && (finding.finding_type === 'unsupported_activity' || finding.finding_type === 'ambiguous_activity')
  ));
}

function sourceDispositionFor(evidence, eventDigest) {
  const matches = evidence.transaction_dispositions.filter(disposition => disposition.normalized_event_digests.includes(eventDigest));
  if (matches.length !== 1 || matches[0].disposition_type !== 'supported_normalized_event') fail('selection_projection_mapping_invalid', 'projected event does not have exactly one supported source disposition');
  const disposition = matches[0];
  if (computeDispositionDigest(disposition) !== disposition.disposition_digest) fail('selection_projection_mapping_invalid', 'source disposition digest does not recompute');
  return disposition;
}

function construct(evidenceBundle, tokenMint) {
  try {
    validateCandidateEvidenceBundleV1(evidenceBundle);
  } catch {
    fail('selection_projection_incomplete', 'candidate selection evidence is invalid');
  }
  if (typeof tokenMint !== 'string' || tokenMint.length === 0) fail('selection_projection_incomplete', 'candidate selection token is invalid');
  const evidence = evidenceBundle.payload;
  if (targetFindingPresent(evidence, tokenMint)) fail('target_finding_present', 'target token has unsupported or ambiguous activity');
  const blocked = evidence.activity_findings.some(finding => finding.affected_token_mints.includes(tokenMint) && finding.impact.blocks_candidate_projection);
  if (blocked) fail('target_finding_present', 'target token is blocked by evidence');

  let receiptScopedEvidence;
  try {
    receiptScopedEvidence = buildReceiptScopedEvidenceV1({
      wallet: evidence.scope.wallet,
      tokenMint,
      normalizedEventRecords: evidence.normalized_event_records,
    });
  } catch {
    fail('selection_projection_incomplete', 'target-token evidence projection is incomplete');
  }

  const recordsByDigest = new Map(evidence.normalized_event_records.map(record => [record.event_digest, record]));
  const entries = receiptScopedEvidence.source_event_digests.map((sourceEventDigest, projectedRawIndex) => {
    const source = recordsByDigest.get(sourceEventDigest);
    if (!source || !affectsToken(source, tokenMint) || computeEventRecordDigest(source) !== sourceEventDigest) fail('selection_projection_mapping_invalid', 'projected event source digest does not recompute');
    const disposition = sourceDispositionFor(evidence, sourceEventDigest);
    return {
      projected_raw_index: projectedRawIndex,
      source_event_digest: sourceEventDigest,
      source_disposition_digest: disposition.disposition_digest,
    };
  });
  const required = evidence.normalized_event_records.filter(record => affectsToken(record, tokenMint));
  if (entries.length !== required.length) fail('selection_projection_incomplete', 'target-token evidence projection is incomplete');
  if (new Set(entries.map(entry => entry.source_event_digest)).size !== entries.length) fail('target_event_duplicated', 'target-token evidence projection contains a duplicate event');

  return cloneAndFreeze({
    projection_version: SELECTION_PROJECTION_VERSION,
    receipt_scoped_evidence: receiptScopedEvidence,
    projection_mapping: {
      projection_mapping_version: PROJECTION_MAPPING_VERSION,
      entries,
    },
  });
}

function classifyProjectionMismatch(expected, supplied) {
  const expectedEvidence = expected.receipt_scoped_evidence;
  const suppliedEvidence = supplied?.receipt_scoped_evidence;
  if (!suppliedEvidence || !Array.isArray(suppliedEvidence.events)) return 'selection_projection_incomplete';
  if (suppliedEvidence.events.length < expectedEvidence.events.length) return 'target_event_omitted';
  const suppliedDigests = Array.isArray(suppliedEvidence.source_event_digests) ? suppliedEvidence.source_event_digests : [];
  if (new Set(suppliedDigests).size !== suppliedDigests.length) return 'target_event_duplicated';
  if (suppliedEvidence.events.length > expectedEvidence.events.length) return 'selection_projection_incomplete';
  if (suppliedEvidence.events.some((event, index) => event?.raw_index !== index)) return 'selection_projection_order_invalid';
  const expectedDigests = expectedEvidence.source_event_digests;
  if (suppliedDigests.length === expectedDigests.length
      && suppliedDigests.every(digest => expectedDigests.includes(digest))
      && suppliedDigests.some((digest, index) => digest !== expectedDigests[index])) return 'selection_projection_order_invalid';
  return 'selection_projection_incomplete';
}

export function buildCandidateSelectionProjectionV1(input) {
  exactInput(input, ['evidenceBundle', 'tokenMint']);
  return construct(input.evidenceBundle, input.tokenMint);
}

export function validateCandidateSelectionProjectionV1(input) {
  exactInput(input, ['evidenceBundle', 'tokenMint', 'projection']);
  let expected;
  try {
    expected = construct(input.evidenceBundle, input.tokenMint);
  } catch (error) {
    throw error;
  }
  try {
    assertPlainJsonValue(input.projection, ['projection']);
  } catch {
    fail('selection_projection_incomplete', 'candidate selection projection is invalid');
  }
  try {
    validateReceiptScopedEvidenceV1(input.projection.receipt_scoped_evidence);
  } catch (error) {
    if (error?.code === 'event_index_mismatch' || error?.code === 'receipt_scoped_event_order_mismatch') fail('selection_projection_order_invalid', 'candidate selection projection order is invalid');
    if (error?.code === 'duplicate_normalized_event') fail('target_event_duplicated', 'candidate selection projection contains a duplicate event');
    fail(classifyProjectionMismatch(expected, input.projection), 'candidate selection projection is incomplete');
  }
  if (canonicalJson(input.projection.receipt_scoped_evidence) !== canonicalJson(expected.receipt_scoped_evidence)) fail(classifyProjectionMismatch(expected, input.projection), 'candidate selection projection is incomplete');
  if (input.projection?.projection_mapping?.projection_mapping_version !== PROJECTION_MAPPING_VERSION
      || canonicalJson(input.projection?.projection_mapping) !== canonicalJson(expected.projection_mapping)) {
    fail('selection_projection_mapping_invalid', 'candidate selection projection mapping is invalid');
  }
  if (canonicalJson(input.projection) !== canonicalJson(expected)) fail('selection_projection_incomplete', 'candidate selection projection is incomplete');
  return true;
}

export const buildWalletCandidateSelectionProjectionV1 = buildCandidateSelectionProjectionV1;
export const validateWalletCandidateSelectionProjectionV1 = validateCandidateSelectionProjectionV1;
