export const RECEIPT_COVERAGE_STATEMENT_VERSION = 'receipt_coverage_v1';

const RECEIPT_SCOPE_LIMITATIONS = [
  'Receipt-scoped only. Not wallet, portfolio, trader, or track-record coverage.',
  'Raw quote only. No USD normalization.',
  'Position-episode fields are descriptive only and do not redefine ledger, candidate, accounting, or verifier semantics.',
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNull(value) {
  return value == null ? null : value;
}

function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

function addCode(codes, code) {
  if (!codes.includes(code)) codes.push(code);
}

function buildCoverageCodes(record, publicationContext) {
  const codes = [
    'receipt_scope_only',
    'canonical_inventory_receipt',
    'raw_quote_no_usd_normalization',
  ];

  if (record.receipt_type === 'closed_position') addCode(codes, 'closed_position_receipt');
  else addCode(codes, 'non_closed_position_receipt');

  if (record.verification_status === 'verified') addCode(codes, 'canonical_status_verified');
  else addCode(codes, 'canonical_status_not_verified');

  if (record.hash_valid === true) addCode(codes, 'hash_valid');
  else addCode(codes, 'hash_not_confirmed_valid');

  if (record.verifier_passed === true) addCode(codes, 'verifier_passed');
  else addCode(codes, 'verifier_not_passed');

  if (record.verifier_schema_valid === true) addCode(codes, 'schema_valid');
  else addCode(codes, 'schema_not_valid');

  if (record.verifier_consistency_valid === true) addCode(codes, 'consistency_valid');
  else addCode(codes, 'consistency_not_valid');

  if (record.valuation_status === 'raw_quote') addCode(codes, 'valuation_raw_quote');
  else addCode(codes, 'valuation_not_raw_quote');

  if (isPresent(record.first_event_at) && isPresent(record.last_event_at)) addCode(codes, 'event_bounds_complete');
  if (!isPresent(record.first_event_at)) addCode(codes, 'event_bounds_missing_first_event_at');
  if (!isPresent(record.last_event_at)) addCode(codes, 'event_bounds_missing_last_event_at');

  if (publicationContext?.surface) addCode(codes, `surface_${publicationContext.surface}`);
  if (publicationContext?.selection_mode) addCode(codes, `selection_${publicationContext.selection_mode}`);

  return codes;
}

function buildCoverageStatus(codes) {
  const incompleteCodes = [
    'hash_not_confirmed_valid',
    'verifier_not_passed',
    'schema_not_valid',
    'consistency_not_valid',
    'valuation_not_raw_quote',
    'event_bounds_missing_first_event_at',
    'event_bounds_missing_last_event_at',
  ];
  return codes.some(code => incompleteCodes.includes(code)) ? 'incomplete' : 'complete';
}

export function buildReceiptCoverageStatement(inventoryRecord, options = {}) {
  if (!inventoryRecord || typeof inventoryRecord !== 'object') {
    throw new TypeError('inventoryRecord is required');
  }

  const publicationContext = options.publicationContext && typeof options.publicationContext === 'object'
    ? {
        surface: asNull(options.publicationContext.surface),
        selection_mode: asNull(options.publicationContext.selection_mode),
      }
    : null;
  const coverageCodes = buildCoverageCodes(inventoryRecord, publicationContext);
  const limitations = [...RECEIPT_SCOPE_LIMITATIONS];

  if (publicationContext?.selection_mode === 'publisher_selected') {
    limitations.push('Publisher-selected board entry unless a future explicit coverage scope is supplied.');
  }

  return {
    coverage_statement_version: RECEIPT_COVERAGE_STATEMENT_VERSION,
    coverage_status: buildCoverageStatus(coverageCodes),
    coverage_codes: coverageCodes,
    scope: {
      scope_type: 'receipt',
      coverage_basis: 'canonical_inventory_receipt',
    },
    receipt: {
      receipt_hash: asNull(inventoryRecord.receipt_hash),
      receipt_id: asNull(inventoryRecord.receipt_id),
      receipt_type: asNull(inventoryRecord.receipt_type),
      receipt_version: asNull(inventoryRecord.receipt_version),
    },
    position_episode: {
      semantic: inventoryRecord.receipt_type === 'closed_position'
        ? 'closed_position_receipt_episode'
        : 'receipt_event_bounds',
      opened_at: asNull(inventoryRecord.first_event_at),
      closed_at: asNull(inventoryRecord.last_event_at),
      snapshot_at: asNull(inventoryRecord.snapshot_at),
      time_basis: 'receipt_first_last_event_at',
      descriptive_only: true,
    },
    verification_basis: {
      verification_status: asNull(inventoryRecord.verification_status),
      hash_valid: inventoryRecord.hash_valid ?? null,
      verifier_passed: inventoryRecord.verifier_passed ?? null,
      schema_valid: inventoryRecord.verifier_schema_valid ?? null,
      consistency_valid: inventoryRecord.verifier_consistency_valid ?? null,
      rule_violations: asArray(inventoryRecord.verifier_rule_violations),
    },
    valuation_basis: {
      valuation_status: asNull(inventoryRecord.valuation_status),
      valuation_currency: 'raw_quote',
      quote_symbol: asNull(inventoryRecord.quote_symbol),
      quote_mint: asNull(inventoryRecord.quote_mint),
      usd_normalized: false,
    },
    publication_context: publicationContext,
    limitations,
  };
}
