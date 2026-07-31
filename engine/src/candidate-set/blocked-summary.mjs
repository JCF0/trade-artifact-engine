import { canonicalizeActivityFindingsV1 } from './activity-findings.mjs';
import { fail } from './errors.mjs';
import { buildBlockedSummaryV1 } from './identity.mjs';
import { compareCodeUnits } from './order.mjs';
import { assertPlainJsonValue, cloneAndFreeze } from './plain-data.mjs';

function assertInput(input, fields, context) {
  assertPlainJsonValue(input, [context]);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('invalid_blocked_summary_input', `${context} must be an object`);
  const keys = Object.keys(input);
  if (keys.some(key => !fields.includes(key)) || fields.some(field => !Object.hasOwn(input, field))) fail('invalid_blocked_summary_input', `${context} fields are invalid`);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

export function buildBlockedTokenOverlayV1(input) {
  assertInput(input, ['activityFindings'], 'blocked token overlay input');
  if (!Array.isArray(input.activityFindings)) fail('invalid_blocked_summary_input', 'activity findings must be an array');
  for (const finding of input.activityFindings) {
    if (finding !== null && typeof finding === 'object' && finding.impact_scope === 'wallet_wide') fail('wallet_wide_impact_unresolved', 'wallet-wide findings must be rejected before candidate construction');
  }
  const findings = canonicalizeActivityFindingsV1(input.activityFindings);
  const findingsByToken = new Map();
  for (const finding of findings) {
    if (!finding.impact.blocks_candidate_projection) continue;
    for (const tokenMint of finding.affected_token_mints) {
      const tokenFindings = findingsByToken.get(tokenMint) ?? [];
      tokenFindings.push(finding);
      findingsByToken.set(tokenMint, tokenFindings);
    }
  }
  const blockedTokenMints = [...findingsByToken.keys()].sort(compareCodeUnits);
  const findingGroups = blockedTokenMints.map(tokenMint => ({ token_mint: tokenMint, findings: findingsByToken.get(tokenMint) }));
  return cloneAndFreeze({ blockedTokenMints, findingsByToken: findingGroups });
}

export function buildBlockedSummariesV1(input) {
  assertInput(input, ['chain','network','wallet','activityFindings'], 'blocked summary builder input');
  if (input.chain !== 'solana' || input.network !== 'mainnet-beta' || typeof input.wallet !== 'string' || input.wallet.length === 0) fail('invalid_blocked_summary_input', 'blocked summary scope is invalid');
  const overlay = buildBlockedTokenOverlayV1({ activityFindings: input.activityFindings });
  const summaries = [];
  for (const tokenMint of overlay.blockedTokenMints) {
    const findings = overlay.findingsByToken.find(group => group.token_mint === tokenMint).findings;
    const ambiguous = findings.some(finding => finding.finding_type === 'ambiguous_activity');
    summaries.push(buildBlockedSummaryV1({
      chain: input.chain,
      network: input.network,
      wallet: input.wallet,
      token_mint: tokenMint,
      position_status: 'unknown',
      ledger_evidence_status: ambiguous ? 'blocked_ambiguous_activity' : 'blocked_unsupported_activity',
      boundary_status: 'unavailable',
      valuation_status: 'unavailable',
      selection_status: 'blocked',
      package_eligibility: 'blocked_by_evidence',
      economics_status: 'unavailable',
      associated_finding_digests: uniqueSorted(findings.map(finding => finding.finding_digest)),
      reason_codes: uniqueSorted(findings.flatMap(finding => finding.reason_codes)),
      disclosure_codes: uniqueSorted(findings.flatMap(finding => finding.disclosure_codes)),
    }));
  }
  summaries.sort((left, right) => compareCodeUnits(left.blocked_summary_digest, right.blocked_summary_digest));
  return cloneAndFreeze(summaries);
}

export const buildBlockedCandidateSummariesV1 = buildBlockedSummariesV1;
export const deriveBlockedTokenOverlayV1 = buildBlockedTokenOverlayV1;
