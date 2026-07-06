import {
  buildDisclosureSet,
  getCorrelatableDisclosure,
  getHostedSemanticsDisclosure,
} from './disclosures.mjs';

export const TRUST_LEVELS = [
  { level: 1, code: 'generated_receipt', label: 'Generated Receipt' },
  { level: 2, code: 'hash_verified', label: 'Hash Verified' },
  { level: 3, code: 'rule_verified', label: 'Rule Verified' },
  { level: 4, code: 'source_anchored', label: 'Source Anchored' },
  { level: 5, code: 'coverage_scoped', label: 'Coverage Scoped' },
];

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getLevelDescriptor(level) {
  return TRUST_LEVELS.find(entry => entry.level === level) || TRUST_LEVELS[0];
}

export function getSourceAnchors(record = {}) {
  const anchors = [];

  if (hasText(record.transaction_signature)) {
    anchors.push({ type: 'transaction_signature', value: record.transaction_signature });
  }
  if (hasText(record.mint_address)) {
    anchors.push({ type: 'mint_address', value: record.mint_address });
  }
  if (hasText(record.token_account)) {
    anchors.push({ type: 'token_account', value: record.token_account });
  }
  if (hasText(record.metadata_uri)) {
    anchors.push({ type: 'metadata_uri', value: record.metadata_uri });
  }
  if (hasText(record.image_uri)) {
    anchors.push({ type: 'image_uri', value: record.image_uri });
  }
  if (hasText(record.final_metadata_uri)) {
    anchors.push({ type: 'final_metadata_uri', value: record.final_metadata_uri });
  }
  if (hasText(record.final_image_uri)) {
    anchors.push({ type: 'final_image_uri', value: record.final_image_uri });
  }
  if (hasText(record.external_url)) {
    anchors.push({ type: 'external_url', value: record.external_url });
  }

  return anchors;
}

export function hasCoverageStatement(record = {}) {
  if (hasText(record.coverage_statement)) return true;
  if (hasText(record.coverage_scope)) return true;
  return false;
}

export function deriveTrustLevel(record = {}) {
  const reasons = [];
  const sourceAnchors = getSourceAnchors(record);
  const coverageStatementPresent = hasCoverageStatement(record);
  const coverageStatement = hasText(record.coverage_statement)
    ? record.coverage_statement.trim()
    : hasText(record.coverage_scope)
      ? record.coverage_scope.trim()
      : null;

  const hasLevel1 = hasText(record.receipt_hash) && hasText(record.receipt_id);
  const hasLevel2 = hasLevel1 && record.hash_valid === true;
  const hasLevel3 = hasLevel2 && record.verifier_passed === true && record.verifier_schema_valid === true && record.verifier_consistency_valid === true;
  const hasLevel4 = hasLevel3 && sourceAnchors.length > 0;
  const hasLevel5 = hasLevel4 && coverageStatementPresent;

  if (!hasLevel1) {
    return {
      current_level: 0,
      current_code: 'unavailable',
      current_label: 'Unavailable',
      max_level: 5,
      reasons: ['No generated receipt identity is available.'],
      source_anchors: sourceAnchors,
      source_anchor_types: sourceAnchors.map(anchor => anchor.type),
      correlatable: sourceAnchors.length > 0,
      coverage_statement_present: coverageStatementPresent,
      coverage_statement: coverageStatement,
      disclosures: buildDisclosureSet({
        includeHostedSemantics: true,
        includeCorrelatableDisclosure: sourceAnchors.length > 0,
      }),
      hosted_visibility_disclosure: getHostedSemanticsDisclosure(),
      correlatable_disclosure: sourceAnchors.length > 0 ? getCorrelatableDisclosure() : null,
      planned_levels: [getLevelDescriptor(5)],
    };
  }

  reasons.push('Receipt exists as a generated, selected artifact.');

  let level = 1;
  if (hasLevel2) {
    level = 2;
    reasons.push('Receipt hash matches the recomputed hash.');
  }
  if (hasLevel3) {
    level = 3;
    reasons.push('Verifier passed with schema-valid and consistency-valid results.');
  }
  if (hasLevel4) {
    level = 4;
    reasons.push('At least one source anchor is exposed for independent correlation.');
  }
  if (hasLevel5) {
    level = 5;
    reasons.push('An explicit coverage statement is present for scope interpretation.');
  }

  const current = getLevelDescriptor(level);
  const disclosures = buildDisclosureSet({
    includeHostedSemantics: true,
    includeCorrelatableDisclosure: sourceAnchors.length > 0,
  });

  return {
    current_level: current.level,
    current_code: current.code,
    current_label: current.label,
    max_level: 5,
    reasons,
    source_anchors: sourceAnchors,
    source_anchor_types: sourceAnchors.map(anchor => anchor.type),
    correlatable: sourceAnchors.length > 0,
    coverage_statement_present: coverageStatementPresent,
    coverage_statement: coverageStatement,
    disclosures,
    hosted_visibility_disclosure: getHostedSemanticsDisclosure(),
    correlatable_disclosure: sourceAnchors.length > 0 ? getCorrelatableDisclosure() : null,
    planned_levels: coverageStatementPresent ? [] : [getLevelDescriptor(5)],
  };
}

export function buildTrustSummary(record = {}) {
  const trust = deriveTrustLevel(record);
  return {
    level: trust.current_level,
    code: trust.current_code,
    label: trust.current_label,
    correlatable: trust.correlatable,
    coverage_statement_present: trust.coverage_statement_present,
  };
}
