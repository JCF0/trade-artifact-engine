import { assertPlainJsonValue, cloneAndFreeze, clonePlainData } from './plain-data.mjs';
import { fail } from './errors.mjs';
import {
  EVIDENCE_BUNDLE_VERSION,
  validateEventRecordV1,
  validateEvidenceBundleV1 as validateEvidenceBundleSchemaV1,
  validateProfilesV1,
} from './schema.mjs';
import { validateWalletAcquisitionResultV1 } from './acquisition-result.mjs';
import {
  canonicalizeTransactionDispositionsV1,
  compareNormalizedEventRecordsV1,
  validateDispositionAccountingV1,
} from './dispositions.mjs';
import {
  canonicalizeActivityFindingsV1,
  validateActivityFindingsV1,
} from './activity-findings.mjs';
import {
  canonicalizeMarkObservationsV1,
  validateMarkObservationsV1,
} from './mark-observations.mjs';
import { recomputeCoverageV1, validateRecomputedCoverageV1 } from './coverage.mjs';
import {
  computeDigestIndex,
  computeEvidenceBundleDigest,
  computeEventRecordDigest,
  computeSourceTransactionDigest,
} from './identity.mjs';
import { canonicalJson } from './serialize.mjs';

function canonicalizeEventRecords(records) {
  assertPlainJsonValue(records, ['normalized_event_records']);
  if (!Array.isArray(records)) fail('invalid_normalized_event', 'normalized event records must be an array');
  const detached = records.map(record => {
    validateEventRecordV1(record, { verifyDigest: false });
    if (computeEventRecordDigest(record) !== record.event_digest) fail('event_digest_mismatch', 'normalized event digest mismatch');
    return clonePlainData(record);
  });
  const digests = detached.map(item => item.event_digest);
  const ids = detached.map(item => item.event_record_id);
  if (new Set(digests).size !== digests.length || new Set(ids).size !== ids.length) fail('duplicate_normalized_event', 'normalized event identities must be unique');
  detached.sort(compareNormalizedEventRecordsV1);
  return cloneAndFreeze(detached);
}

function validateEventOrder(records) {
  for (let index = 1; index < records.length; index += 1) if (compareNormalizedEventRecordsV1(records[index - 1], records[index]) >= 0) fail('order_invalid', 'normalized event records are not canonically ordered');
}

function buildIntegrity(dispositions, events, findings, marks) {
  return cloneAndFreeze({
    transaction_dispositions_digest: computeDigestIndex('wallet_transaction_disposition_index_v1', dispositions.map(item => item.disposition_digest)),
    normalized_events_digest: computeDigestIndex('wallet_normalized_event_index_v1', events.map(item => item.event_digest)),
    activity_findings_digest: computeDigestIndex('wallet_activity_finding_index_v1', findings.map(item => item.finding_digest)),
    mark_observations_digest: computeDigestIndex('wallet_mark_observation_index_v1', marks.map(item => item.mark_observation_digest)),
    transaction_disposition_count: dispositions.length,
    normalized_event_count: events.length,
    activity_finding_count: findings.length,
    mark_observation_count: marks.length,
  });
}

function validateProfilesMatch(evidenceProfiles, acquisitionProfiles) {
  validateProfilesV1(evidenceProfiles);
  validateProfilesV1(acquisitionProfiles);
  for (const field of ['wallet_acquisition_profile','wallet_normalization_profile','reconstruction_engine_version','accounting_method_version']) {
    if (evidenceProfiles[field] !== acquisitionProfiles[field]) fail('unsupported_profile', 'evidence profiles do not match acquisition profiles');
  }
  if (acquisitionProfiles.mark_profile !== null && acquisitionProfiles.mark_profile !== evidenceProfiles.mark_profile) fail('unsupported_profile', 'acquisition mark profile conflicts with evidence profile');
}

export function validateCandidateEvidenceBundleV1(bundle) {
  assertPlainJsonValue(bundle, ['evidence_bundle']);
  validateEvidenceBundleSchemaV1(bundle);
  const payload = bundle.payload;
  validateProfilesV1(payload.profiles);

  const canonicalDispositions = canonicalizeTransactionDispositionsV1(payload.transaction_dispositions);
  if (canonicalJson(canonicalDispositions) !== canonicalJson(payload.transaction_dispositions)) fail('order_invalid', 'transaction dispositions are not canonically ordered');
  const canonicalFindings = canonicalizeActivityFindingsV1(payload.activity_findings);
  if (canonicalJson(canonicalFindings) !== canonicalJson(payload.activity_findings)) fail('order_invalid', 'activity findings are not canonically ordered');
  validateEventOrder(payload.normalized_event_records);

  validateDispositionAccountingV1({
    transactionDispositions: payload.transaction_dispositions,
    normalizedEventRecords: payload.normalized_event_records,
    activityFindings: payload.activity_findings,
    wallet: payload.scope.wallet,
    anchorSlot: payload.boundary.anchor_slot,
  });
  const sourceTransactionDigests = payload.transaction_dispositions.map(item => computeSourceTransactionDigest({ tx_hash: item.tx_hash, slot: item.slot, block_time: item.block_time }));
  validateActivityFindingsV1(payload.activity_findings, {
    sourceTransactionDigests,
    sourceEventDigests: payload.normalized_event_records.map(item => item.event_digest),
    allowWalletWide: false,
  });
  validateMarkObservationsV1(payload.mark_observations, {
    markProfile: payload.profiles.mark_profile,
    anchorSlot: payload.boundary.anchor_slot,
    anchorBlockTime: payload.boundary.anchor_block_time,
  });

  const coverageInputs = {
    transactionDispositions: payload.transaction_dispositions,
    normalizedEventRecords: payload.normalized_event_records,
    activityFindings: payload.activity_findings,
    boundary: payload.boundary,
    inputStatus: payload.input_status,
    paginationTerminalReason: payload.coverage.pagination_terminal_reason,
  };
  validateRecomputedCoverageV1(payload.coverage, coverageInputs);

  const expectedIntegrity = buildIntegrity(payload.transaction_dispositions, payload.normalized_event_records, payload.activity_findings, payload.mark_observations);
  if (canonicalJson(payload.integrity) !== canonicalJson(expectedIntegrity)) fail('integrity_digest_mismatch', 'evidence integrity indexes or counts do not reconcile');
  if (computeEvidenceBundleDigest(payload) !== bundle.evidence_bundle_digest) fail('evidence_bundle_digest_mismatch', 'evidence bundle digest mismatch');
  return true;
}

export function buildCandidateEvidenceBundleV1(input) {
  assertPlainJsonValue(input, ['evidence_bundle_builder_input']);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('invalid_object', 'evidence bundle builder input must be an object');
  const fields = ['acquisitionResult', 'markObservations', 'profiles'];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Object.keys(descriptors)) if (!fields.includes(key)) fail('unknown_field', 'evidence bundle builder input contains unknown field', { field: key });
  for (const key of fields) if (!Object.hasOwn(descriptors, key)) fail('missing_field', 'evidence bundle builder input is missing field', { field: key });
  const detachedInput = clonePlainData(input);
  const acquisition = detachedInput.acquisitionResult;
  const detachedProfiles = detachedInput.profiles;
  const markObservations = detachedInput.markObservations;
  validateWalletAcquisitionResultV1(acquisition);
  validateProfilesMatch(detachedProfiles, acquisition.profiles);

  const transactionDispositions = canonicalizeTransactionDispositionsV1(acquisition.transaction_dispositions);
  const normalizedEventRecords = canonicalizeEventRecords(acquisition.normalized_event_records);
  const activityFindings = canonicalizeActivityFindingsV1(acquisition.activity_findings);
  const marks = canonicalizeMarkObservationsV1(markObservations, { markProfile: detachedProfiles.mark_profile });

  validateDispositionAccountingV1({
    transactionDispositions,
    normalizedEventRecords,
    activityFindings,
    wallet: acquisition.scope.wallet,
    anchorSlot: acquisition.boundary.anchor_slot,
  });
  const sourceTransactionDigests = transactionDispositions.map(item => computeSourceTransactionDigest({ tx_hash: item.tx_hash, slot: item.slot, block_time: item.block_time }));
  validateActivityFindingsV1(activityFindings, {
    sourceTransactionDigests,
    sourceEventDigests: normalizedEventRecords.map(item => item.event_digest),
    allowWalletWide: false,
  });
  validateMarkObservationsV1(marks, {
    markProfile: detachedProfiles.mark_profile,
    anchorSlot: acquisition.boundary.anchor_slot,
    anchorBlockTime: acquisition.boundary.anchor_block_time,
  });

  const coverageInputs = {
    transactionDispositions,
    normalizedEventRecords,
    activityFindings,
    boundary: acquisition.boundary,
    inputStatus: acquisition.input_status,
    paginationTerminalReason: acquisition.coverage.pagination_terminal_reason,
  };
  validateRecomputedCoverageV1(acquisition.coverage, coverageInputs);
  const coverage = recomputeCoverageV1(coverageInputs);
  const integrity = buildIntegrity(transactionDispositions, normalizedEventRecords, activityFindings, marks);
  const payload = cloneAndFreeze({
    scope: acquisition.scope,
    profiles: detachedProfiles,
    boundary: acquisition.boundary,
    input_status: acquisition.input_status,
    coverage,
    transaction_dispositions: transactionDispositions,
    normalized_event_records: normalizedEventRecords,
    activity_findings: activityFindings,
    mark_observations: marks,
    integrity,
  });
  const envelope = cloneAndFreeze({
    evidence_bundle_version: EVIDENCE_BUNDLE_VERSION,
    evidence_bundle_digest: computeEvidenceBundleDigest(payload),
    payload,
  });
  validateCandidateEvidenceBundleV1(envelope);
  return envelope;
}

export const buildEvidenceBundleV1 = buildCandidateEvidenceBundleV1;
export const validateEvidenceBundleV1 = validateCandidateEvidenceBundleV1;
