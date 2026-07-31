import { assertPlainJsonValue, cloneAndFreeze, clonePlainData } from './plain-data.mjs';
import { compareCodeUnits } from './order.mjs';
import { fail } from './errors.mjs';
import { validateFindingV1 } from './schema.mjs';
import { buildFindingV1, computeFindingDigest } from './identity.mjs';

export const ACTIVITY_FINDING_REASON_CODES_V1 = Object.freeze([
  'ambiguous_swap_direction',
  'unsupported_swap_shape',
  'unsupported_transfer_activity',
]);

export const ACTIVITY_FINDING_DISCLOSURE_CODES_V1 = Object.freeze([
  'open_outcome_not_final',
  'partial_exit_position_remains_open',
  'history_begins_mid_position',
  'activity_not_reconstructable',
]);

const REASONS_BY_TYPE = Object.freeze({
  unsupported_activity: new Set(['unsupported_swap_shape', 'unsupported_transfer_activity']),
  ambiguous_activity: new Set(['ambiguous_swap_direction']),
});

function validateFindingSemantics(finding) {
  const allowedReasons = REASONS_BY_TYPE[finding.finding_type];
  if (!finding.reason_codes.every(code => allowedReasons.has(code))) fail('invalid_activity_finding', 'activity finding reason code is invalid');
  if (!finding.disclosure_codes.every(code => ACTIVITY_FINDING_DISCLOSURE_CODES_V1.includes(code))) fail('invalid_activity_finding', 'activity finding disclosure code is invalid');

  if (finding.severity !== 'candidate_blocking' || !finding.impact.blocks_candidate_projection || !finding.impact.blocks_receipt_publication) {
    fail('invalid_activity_finding', 'candidate-blocking finding impact is invalid');
  }
  if (finding.impact_scope === 'wallet_wide') {
    if (finding.finding_type !== 'ambiguous_activity' || finding.affected_token_mints.length !== 0 || finding.affected_quote_mints.length !== 0) fail('invalid_activity_finding', 'wallet-wide impact must be indeterminate ambiguity');
  }
  return true;
}

export function compareActivityFindingsV1(left, right) {
  return left.time_range.first_observed_slot - right.time_range.first_observed_slot
    || left.time_range.last_observed_slot - right.time_range.last_observed_slot
    || compareCodeUnits(left.finding_type, right.finding_type)
    || compareCodeUnits(left.impact_scope, right.impact_scope)
    || compareCodeUnits(left.finding_digest, right.finding_digest);
}

export function buildActivityFindingV1(input) {
  const finding = buildFindingV1(input);
  validateFindingSemantics(finding);
  return finding;
}

export function canonicalizeActivityFindingsV1(findings) {
  assertPlainJsonValue(findings, ['activity_findings']);
  if (!Array.isArray(findings)) fail('invalid_activity_finding', 'activity findings must be an array');
  const detached = findings.map(finding => {
    validateFindingV1(finding);
    validateFindingSemantics(finding);
    return clonePlainData(finding);
  });
  const digests = detached.map(item => item.finding_digest);
  const ids = detached.map(item => item.finding_id);
  if (new Set(digests).size !== digests.length || new Set(ids).size !== ids.length) fail('duplicate_activity_finding', 'activity finding identities must be unique');
  detached.sort(compareActivityFindingsV1);
  return cloneAndFreeze(detached);
}

export function validateActivityFindingsV1(findings, options = {}) {
  assertPlainJsonValue({ findings, options });
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('invalid_activity_finding', 'activity finding validation options are invalid');
  const expectedFields = ['sourceTransactionDigests','sourceEventDigests','allowWalletWide'];
  const keys = Object.keys(options);
  if (keys.some(key => !expectedFields.includes(key)) || expectedFields.slice(0, 2).some(key => !Object.hasOwn(options, key))) fail('invalid_activity_finding', 'activity finding validation options are invalid');
  const sourceTransactionDigests = options.sourceTransactionDigests;
  const sourceEventDigests = options.sourceEventDigests;
  const allowWalletWide = Object.hasOwn(options, 'allowWalletWide') ? options.allowWalletWide : false;
  if (!Array.isArray(findings) || !Array.isArray(sourceTransactionDigests) || !Array.isArray(sourceEventDigests) || typeof allowWalletWide !== 'boolean') fail('invalid_activity_finding', 'activity finding validation input is invalid');
  const knownTransactions = new Set(sourceTransactionDigests);
  const knownEvents = new Set(sourceEventDigests);
  const ids = new Set();
  const digests = new Set();
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    validateFindingV1(finding, { verifyDigest: false });
    validateFindingSemantics(finding);
    if (computeFindingDigest(finding) !== finding.finding_digest) fail('finding_digest_mismatch', 'activity finding digest mismatch');
    if (ids.has(finding.finding_id) || digests.has(finding.finding_digest)) fail('duplicate_activity_finding', 'activity finding identities must be unique');
    ids.add(finding.finding_id); digests.add(finding.finding_digest);
    if (index > 0 && compareActivityFindingsV1(findings[index - 1], finding) >= 0) fail('order_invalid', 'activity findings are not canonically ordered');
    for (const digest of finding.source_transaction_digests) if (!knownTransactions.has(digest)) fail('finding_disposition_mismatch', 'finding references an unknown source transaction');
    for (const digest of finding.source_event_digests) if (!knownEvents.has(digest)) fail('finding_disposition_mismatch', 'finding references an unknown source event');
    if (!allowWalletWide && finding.impact_scope === 'wallet_wide') fail('wallet_wide_impact_unresolved', 'wallet-wide activity finding prevents evidence-bundle issuance');
  }
  return true;
}
