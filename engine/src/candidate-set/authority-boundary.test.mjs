#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildWalletAcquisitionResultV1 } from './acquisition-result.mjs';
import { buildCandidateEvidenceBundleV1 } from './evidence-bundle.mjs';
import { buildDispositionV1 } from './identity.mjs';
import { buildDeterministicCandidateFixtureV1, FIXTURE_MATRIX, JUP_GOLDEN } from './fixtures/deterministic-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXPECTED_EXPORTS = Object.freeze({
  'acquisition-result.mjs': ['validateWalletAcquisitionResultV1','buildWalletAcquisitionResultV1','buildAcquisitionResultV1','validateAcquisitionResultV1'],
  'activity-findings.mjs': ['ACTIVITY_FINDING_REASON_CODES_V1','ACTIVITY_FINDING_DISCLOSURE_CODES_V1','compareActivityFindingsV1','buildActivityFindingV1','canonicalizeActivityFindingsV1','validateActivityFindingsV1'],
  'blocked-summary.mjs': ['buildBlockedTokenOverlayV1','buildBlockedSummariesV1','buildBlockedCandidateSummariesV1','deriveBlockedTokenOverlayV1'],
  'builder.mjs': ['validateWalletCandidateSetV1AgainstEvidenceBundle','buildWalletCandidateSetV1','validateWalletCandidateSetV1'],
  'coverage.mjs': ['recomputeCoverageV1','validateRecomputedCoverageV1'],
  'dispositions.mjs': ['compareTransactionDispositionsV1','compareNormalizedEventRecordsV1','canonicalizeTransactionDispositionsV1','validateDispositionAccountingV1'],
  'errors.mjs': ['WalletCandidateSetError','fail'],
  'evidence-bundle.mjs': ['validateCandidateEvidenceBundleV1','buildCandidateEvidenceBundleV1','validateEvidenceBundleV1'],
  'identity.mjs': ['buildSourceTransactionReferenceV1','sourceTransactionDigestPreimage','computeSourceTransactionDigest','sourceTransactionReferenceDigestPreimage','computeSourceTransactionReferenceDigest','findingDigestPreimage','computeFindingDigest','buildFindingV1','dispositionDigestPreimage','computeDispositionDigest','buildDispositionV1','eventRecordDigestPreimage','computeEventRecordDigest','buildEventRecordV1','markObservationDigestPreimage','computeMarkObservationDigest','buildMarkObservationV1','blockedSummaryDigestPreimage','computeBlockedSummaryDigest','buildBlockedSummaryV1','computeDigestIndex','coverageDigestPreimage','computeCoverageDigest','windowDigestPreimage','computeWindowDigest','scopeDigestPreimage','computeScopeDigest','receiptScopedEvidenceDigestPreimage','computeReceiptScopedEvidenceDigest','evidenceBundleDigestPreimage','computeEvidenceBundleDigest','candidateDigestPreimage','computeCandidateDigest','buildCandidateV1','candidateSetDigestPreimage','computeCandidateSetDigest','buildCandidateSetV1'],
  'mark-observations.mjs': ['MARK_UNAVAILABLE_REASON_CODES_V1','compareMarkObservationsV1','buildMarkObservationV1','canonicalizeMarkObservationsV1','validateMarkObservationsV1'],
  'open-snapshot.mjs': ['buildOpenPositionSnapshotV1','buildOpenSnapshotV1'],
  'order.mjs': ['compareCodeUnits','sortedCodeUnitCopy','sortCodeUnitKeys'],
  'plain-data.mjs': ['assertPlainJsonValue','clonePlainData','deepFreeze','cloneAndFreeze','safeDeepClone','safeDeepFreeze'],
  'project-candidate.mjs': ['projectCandidateV1','buildCandidateProjectionV1'],
  'receipt-scoped-evidence.mjs': ['RECEIPT_SCOPED_EVIDENCE_VERSION','compareReceiptScopedEventRecordsV1','validateReceiptScopedEvidenceV1','buildReceiptScopedEvidenceV1','buildReceiptScopedCandidateEvidenceV1','validateReceiptScopedCandidateEvidenceV1','receiptScopedEvidenceDigestInputV1','receiptScopedEvidenceEqualV1'],
  'schema.mjs': ['WalletCandidateSetError','GENESIS_HASH','SOLANA_GENESIS_HASH','DIGEST_PATTERN','SOURCE_TRANSACTION_REFERENCE_VERSION','ACQUISITION_RESULT_VERSION','EVIDENCE_BUNDLE_VERSION','FINDING_VERSION','FINDING_IDENTITY_VERSION','DISPOSITION_VERSION','EVENT_RECORD_VERSION','MARK_OBSERVATION_VERSION','CANDIDATE_VERSION','CANDIDATE_IDENTITY_VERSION','BLOCKED_SUMMARY_VERSION','CANDIDATE_SET_VERSION','COVERAGE_VERSION','SCOPE_INPUT_VERSION','SCOPE_VERSION','WINDOW_VERSION','BOUNDARY_VERSION','MARK_PROFILE_VERSION','MARK_PROFILE_MAX_AGE_SECONDS','LOOKBACK_SECONDS_BY_PROFILE_V1','assertExactFields','assertDigest','validateSourceTransactionReferenceV1','validateProfilesV1','validateBoundaryV1','validateInputStatusV1','validateCoverageV1','validateFindingV1','validateDispositionV1','validateSlice7EventV1','validateEventRecordV1','validateMarkObservationV1','validateBlockedSummaryV1','validateCandidateV1','validateEvidenceIntegrityV1','validateEvidenceBundleV1','validateScopeInputV1','validateWalletAcquisitionScopeBoundaryV1','validateCandidateSetV1'],
  'selection-projection.mjs': ['SELECTION_PROJECTION_VERSION','PROJECTION_MAPPING_VERSION','buildCandidateSelectionProjectionV1','validateCandidateSelectionProjectionV1','buildWalletCandidateSelectionProjectionV1','validateWalletCandidateSelectionProjectionV1'],
  'selection-resolver.mjs': ['CANDIDATE_SELECTION_RESOLUTION_VERSION','resolveCandidateSelectionV1'],
  'serialize.mjs': ['canonicalJson','sha256Bytes','sha256CanonicalJson','canonicalSerialize'],
});

function productionSources() {
  return readdirSync(here)
    .filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .sort()
    .map(name => ({ name, source: readFileSync(join(here, name), 'utf8') }));
}

function declaredExports(source) {
  const names = [];
  const pattern = /^\s*export\s+(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|\{([^}]*)\}\s*;?)/gm;
  for (const match of source.matchAll(pattern)) {
    if (match[4] !== undefined) {
      for (const item of match[4].split(',')) names.push(item.trim().split(/\s+as\s+/).at(-1));
    } else names.push(match[1] ?? match[2] ?? match[3]);
  }
  return names;
}

test('every candidate-set production export is enumerated and only the authoritative builder constructs the evidence envelope', () => {
  const sources = productionSources();
  assert.deepEqual(sources.map(item => item.name), Object.keys(EXPECTED_EXPORTS).sort());
  for (const { name, source } of sources) {
    const exports = declaredExports(source);
    const exportStatements = [...source.matchAll(/^\s*export\s+([^\n]+)/gm)].map(match => match[1]);
    assert.equal(exportStatements.length, exports.length, `${name} contains an unenumerated export form`);
    assert.ok(exportStatements.every(statement => /^(?:async\s+)?function\s+|^const\s+|^class\s+|^\{/.test(statement)), `${name} contains an unsupported export form`);
    assert.deepEqual(exports, EXPECTED_EXPORTS[name], name);
  }
  const envelopeConstructors = sources.filter(item => /evidence_bundle_version\s*:\s*EVIDENCE_BUNDLE_VERSION/.test(item.source));
  assert.deepEqual(envelopeConstructors.map(item => item.name), ['evidence-bundle.mjs']);
  assert.match(envelopeConstructors[0].source, /export\s+function\s+buildCandidateEvidenceBundleV1\s*\(/);
  assert.doesNotMatch(sources.find(item => item.name === 'identity.mjs').source, /buildEvidenceBundleV1|evidence_bundle_version\s*:/);
});

test('wallet-wide ambiguity cannot be issued through a supported production constructor', () => {
  assert.throws(
    () => buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.walletWideAmbiguous),
    error => error.code === 'wallet_wide_impact_unresolved',
  );
});

test('malformed disposition accounting cannot reach a content-addressed evidence bundle', () => {
  const normal = buildDeterministicCandidateFixtureV1(JUP_GOLDEN);
  const originalDisposition = normal.acquisitionResult.transaction_dispositions[0];
  const {
    disposition_version: _version,
    disposition_id: _id,
    disposition_digest: _digest,
    ...dispositionInput
  } = originalDisposition;
  const malformedDisposition = buildDispositionV1({
    ...dispositionInput,
    affected_token_mints: [JUP_GOLDEN.quoteMint, JUP_GOLDEN.tokenMint].sort(),
  });
  const malformed = buildWalletAcquisitionResultV1({
    ...structuredClone(normal.acquisitionResult),
    transaction_dispositions: [
      malformedDisposition,
      ...normal.acquisitionResult.transaction_dispositions.slice(1),
    ],
  });
  assert.throws(
    () => buildCandidateEvidenceBundleV1({
      acquisitionResult: malformed,
      markObservations: [],
      profiles: malformed.profiles,
    }),
    error => error.code === 'event_disposition_mismatch',
  );
});

test('the authoritative normal path is deterministic', () => {
  const first = buildDeterministicCandidateFixtureV1(JUP_GOLDEN);
  const second = buildDeterministicCandidateFixtureV1(JUP_GOLDEN);
  assert.deepEqual(second.evidenceBundle, first.evidenceBundle);
  assert.equal(second.evidenceBundle.evidence_bundle_digest, first.evidenceBundle.evidence_bundle_digest);
});
