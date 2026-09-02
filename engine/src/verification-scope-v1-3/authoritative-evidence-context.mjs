import { types as utilTypes } from 'node:util';

import {
  assertExactFields,
  canonicalJson,
  cloneAndFreeze,
  fail,
  sha256CanonicalJson,
} from './contract.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from '../wallet-acquisition/request-contract.mjs';
import {
  HELIUS_FINALIZED_OWNER_ENUMERATION_WATERMARK_PROFILE_V2,
  TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1,
  captureTargetAccountEnumerationV1,
  validateTargetAccountEnumerationStructureV1,
} from '../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import {
  captureEvidenceContextSidecarV1,
  validateEvidenceContextSidecarStructureV1,
} from '../wallet-acquisition/evidence-context-sidecar-v1.mjs';

export const AUTHORITATIVE_EVIDENCE_CONTEXT_VERSION_V13 = 'artifact_authoritative_evidence_context_v1_3';
export const AUTHORITATIVE_EVIDENCE_CONTEXT_PROFILE_V13 = 'ARTIFACT_AUTHORITATIVE_EVIDENCE_CONTEXT_V1';

const INPUT_FIELDS = [
  'transaction_sidecar', 'opening_enumeration', 'ending_enumeration', 'opening_basis_reference',
];
const SOURCE_CONSTRUCTION_FIELDS = [
  'transaction_transcript_port', 'legacy_acquisition_result',
  'opening_enumeration_port', 'ending_enumeration_port', 'target_mint', 'opening_basis_reference',
];
const SOURCE_BOUND_FIELDS = [
  'context', 'transaction_transcript_port', 'legacy_acquisition_result',
  'opening_enumeration_port', 'ending_enumeration_port', 'target_mint', 'opening_basis_reference',
];
const CONTEXT_FIELDS = [
  'authoritative_evidence_context_version', 'evidence_context_profile', 'network', 'analyzed_wallet',
  'target_mint', 'transaction_population', 'opening_snapshot', 'ending_snapshot',
  'population_reconciliation', 'external_custody_continuity', 'opening_basis_reference',
  'opening_basis_status', 'evidence_context_digest',
];
const NETWORK_FIELDS = ['chain', 'network', 'genesis_hash'];
const SNAPSHOT_FIELDS = [
  'boundary_kind', 'boundary', 'enumeration_evidence', 'enumeration_digest', 'required_token_programs',
  'program_coverage_evidence', 'account_population_status', 'account_count', 'target_decimals',
  'accounts', 'aggregate_raw_quantity', 'zero_status',
];
const BOUNDARY_FIELDS = ['boundary_profile', 'commitment', 'slot'];
const PROGRAM_COVERAGE_FIELDS = ['token_program', 'response_status', 'context', 'account_count'];
const ACCOUNT_FIELDS = [
  'account', 'account_program', 'mint', 'token_authority', 'raw_amount', 'decimals',
  'delegate_status', 'delegate', 'delegated_raw_amount', 'close_authority_status', 'close_authority',
  'lifecycle_state', 'account_state', 'normalized_state_profile', 'normalized_state_evidence_digest',
  'raw_account_evidence_digest',
];
const RECONCILIATION_FIELDS = [
  'status', 'transaction_count', 'opening_account_count', 'ending_account_count',
  'transaction_population_digest', 'opening_population_digest', 'ending_population_digest',
];
const CONTINUITY_FIELDS = ['status', 'reason', 'source_effect_references'];
const BASIS_REFERENCE_FIELDS = ['basis_evidence_profile', 'basis_evidence_digest'];
const DIGEST = /^[0-9a-f]{64}$/;
const RAW_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const LEGACY_STATE_PROFILE = 'CAPABILITY_ATTESTED_TOKEN_ACCOUNT_STATE_V1';
const LOCAL_STATE_PROFILE = 'LOCALLY_DECODED_SOLANA_TOKEN_ACCOUNT_STATE_V1';

function validateCapabilityBearingInput(input, fields, context) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length !== 0) {
    fail('invalid_source_bound_input', `${context} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Object.keys(descriptors)) {
    if (!fields.includes(key)) fail('unknown_field', `${context} contains unknown field`);
  }
  for (const field of fields) {
    if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')) {
      fail('missing_field', `${context} is missing ${field}`);
    }
  }
}

function digestPreimage(value) {
  const preimage = {};
  for (const field of CONTEXT_FIELDS) if (field !== 'evidence_context_digest') {
    Object.defineProperty(preimage, field, { value: value[field], enumerable: true });
  }
  return preimage;
}
function validateBasisReference(value) {
  if (value === null) return;
  assertExactFields(value, BASIS_REFERENCE_FIELDS, 'opening_basis_reference');
  if (value.basis_evidence_profile !== 'ARTIFACT_OPENING_BASIS_EVIDENCE_V1'
      || !DIGEST.test(value.basis_evidence_digest)) {
    fail('opening_basis_reference_invalid', 'opening basis reference is invalid');
  }
}
function flattenedAccounts(enumeration) {
  return enumeration.program_results.flatMap(result => result.accounts.map(source => ({ source, tokenProgram: result.token_program })))
    .sort((left, right) => left.source.account < right.source.account ? -1 : left.source.account > right.source.account ? 1 : 0);
}
function snapshotFromEnumeration(boundaryKind, enumeration) {
  validateTargetAccountEnumerationStructureV1(enumeration);
  if (enumeration.enumeration_profile === HELIUS_FINALIZED_OWNER_ENUMERATION_WATERMARK_PROFILE_V2) {
    fail(
      'combined_boundary_authority_not_admitted',
      'equal finalized watermarks do not independently establish combined boundary authority',
    );
  }
  const flattened = flattenedAccounts(enumeration);
  const decimals = new Set(flattened.map(item => item.source.token_state.decimals));
  if (decimals.size > 1) fail('target_decimals_mismatch', 'one target mint cannot have conflicting decimals');
  let aggregate = 0n;
  const accounts = flattened.map(({ source }) => {
    aggregate += BigInt(source.token_state.raw_amount);
    return {
      account: source.account,
      account_program: source.account_program,
      mint: source.token_state.mint,
      token_authority: source.token_state.token_authority,
      raw_amount: source.token_state.raw_amount,
      decimals: source.token_state.decimals,
      delegate_status: source.token_state.delegate_status,
      delegate: source.token_state.delegate,
      delegated_raw_amount: source.token_state.delegated_raw_amount,
      close_authority_status: source.token_state.close_authority_status,
      close_authority: source.token_state.close_authority,
      lifecycle_state: source.token_state.lifecycle_state,
      account_state: source.token_state.account_state,
      normalized_state_profile: source.normalized_state_profile,
      normalized_state_evidence_digest: sha256CanonicalJson(source.token_state),
      raw_account_evidence_digest: sha256CanonicalJson(source.raw_account_data),
    };
  });
  return {
    boundary_kind: boundaryKind,
    boundary: {
      boundary_profile: 'finalized_enumeration_response_context_slot_v1',
      commitment: 'finalized',
      slot: enumeration.enumeration_context.slot,
    },
    enumeration_evidence: enumeration,
    enumeration_digest: enumeration.enumeration_digest,
    required_token_programs: [...TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1],
    program_coverage_evidence: enumeration.program_results.map(result => ({
      token_program: result.token_program,
      response_status: result.response_status,
      context: result.context,
      account_count: result.accounts.length,
    })),
    account_population_status: 'COMPLETE',
    account_count: accounts.length,
    target_decimals: decimals.size === 0 ? null : [...decimals][0],
    accounts,
    aggregate_raw_quantity: aggregate.toString(),
    zero_status: aggregate === 0n ? 'EXACT_ZERO' : 'EXACT_NONZERO',
  };
}
function validateSnapshot(value, boundaryKind, wallet, targetMint) {
  assertExactFields(value, SNAPSHOT_FIELDS, `${boundaryKind.toLowerCase()}_snapshot`);
  const expected = snapshotFromEnumeration(boundaryKind, value.enumeration_evidence);
  if (value.enumeration_evidence.analyzed_wallet !== wallet || value.enumeration_evidence.target_mint !== targetMint) {
    fail('evidence_context_scope_mismatch', 'snapshot scope does not match evidence context');
  }
  if (canonicalJson(value) !== canonicalJson(expected)) {
    fail('snapshot_derivation_mismatch', 'snapshot must derive exactly from validated enumeration response evidence');
  }
  assertExactFields(value.boundary, BOUNDARY_FIELDS, `${boundaryKind.toLowerCase()}_snapshot.boundary`);
  value.program_coverage_evidence.forEach((coverage, index) => {
    assertExactFields(coverage, PROGRAM_COVERAGE_FIELDS, `${boundaryKind.toLowerCase()}_snapshot.program_coverage_evidence.${index}`);
  });
  value.accounts.forEach((account, index) => {
    assertExactFields(account, ACCOUNT_FIELDS, `${boundaryKind.toLowerCase()}_snapshot.accounts.${index}`);
    const profileValid = account.normalized_state_profile === LEGACY_STATE_PROFILE
      || (account.normalized_state_profile === LOCAL_STATE_PROFILE && account.decimals === null);
    if (!RAW_INTEGER.test(account.raw_amount) || !DIGEST.test(account.normalized_state_evidence_digest)
        || !DIGEST.test(account.raw_account_evidence_digest)
        || !profileValid) {
      fail('snapshot_derivation_mismatch', 'snapshot account quantity or evidence digest is invalid');
    }
  });
}
function populationReconciliation(sidecar, openingSnapshot, endingSnapshot) {
  return {
    status: 'EXACT',
    transaction_count: sidecar.transactions.length,
    opening_account_count: openingSnapshot.account_count,
    ending_account_count: endingSnapshot.account_count,
    transaction_population_digest: sidecar.population_evidence_digest,
    opening_population_digest: openingSnapshot.enumeration_digest,
    ending_population_digest: endingSnapshot.enumeration_digest,
  };
}
function unresolvedContinuity() {
  return {
    status: 'UNRESOLVED',
    reason: 'TRANSFER_SEMANTICS_NOT_ESTABLISHED_IN_3B_1',
    source_effect_references: [],
  };
}
function validateBoundaryOrdering(sidecar, openingSnapshot, endingSnapshot) {
  if (openingSnapshot.boundary.slot > endingSnapshot.boundary.slot) {
    fail('snapshot_boundary_not_authoritative', 'opening snapshot must not follow ending snapshot');
  }
  if (sidecar.transactions.length === 0) return;
  const newest = sidecar.transactions[0].source_identity.slot;
  const oldest = sidecar.transactions.at(-1).source_identity.slot;
  if (openingSnapshot.boundary.slot >= oldest || endingSnapshot.boundary.slot <= newest) {
    fail('snapshot_boundary_not_authoritative', 'snapshot response contexts must strictly bracket the transaction population');
  }
}

export function validateAuthoritativeEvidenceContextStructureV13(value) {
  assertExactFields(value, CONTEXT_FIELDS, 'authoritative_evidence_context');
  if (value.authoritative_evidence_context_version !== AUTHORITATIVE_EVIDENCE_CONTEXT_VERSION_V13
      || value.evidence_context_profile !== AUTHORITATIVE_EVIDENCE_CONTEXT_PROFILE_V13) {
    fail('unsupported_evidence_context_version', 'authoritative evidence context version is unsupported');
  }
  assertExactFields(value.network, NETWORK_FIELDS, 'network');
  if (value.network.chain !== 'solana' || value.network.network !== 'mainnet-beta'
      || value.network.genesis_hash !== SOLANA_MAINNET_GENESIS_HASH) {
    fail('unsupported_evidence_context_network', 'authoritative evidence context network is unsupported');
  }
  validateEvidenceContextSidecarStructureV1(value.transaction_population);
  if (value.analyzed_wallet !== value.transaction_population.analyzed_wallet) {
    fail('evidence_context_scope_mismatch', 'transaction population wallet does not match context');
  }
  validateSnapshot(value.opening_snapshot, 'OPENING', value.analyzed_wallet, value.target_mint);
  validateSnapshot(value.ending_snapshot, 'ENDING_AS_OF', value.analyzed_wallet, value.target_mint);
  validateBoundaryOrdering(value.transaction_population, value.opening_snapshot, value.ending_snapshot);
  assertExactFields(value.population_reconciliation, RECONCILIATION_FIELDS, 'population_reconciliation');
  const expectedReconciliation = populationReconciliation(
    value.transaction_population, value.opening_snapshot, value.ending_snapshot,
  );
  if (canonicalJson(value.population_reconciliation) !== canonicalJson(expectedReconciliation)) {
    fail('population_reconciliation_mismatch', 'population reconciliation is invalid');
  }
  assertExactFields(value.external_custody_continuity, CONTINUITY_FIELDS, 'external_custody_continuity');
  if (canonicalJson(value.external_custody_continuity) !== canonicalJson(unresolvedContinuity())) {
    fail('unsupported_external_custody_authority', '3B-1 cannot assert external custody continuity');
  }
  validateBasisReference(value.opening_basis_reference);
  const openingZero = value.opening_snapshot.zero_status === 'EXACT_ZERO';
  if (openingZero) {
    if (value.opening_basis_reference !== null
        || value.opening_basis_status !== 'EXACT_ZERO_DERIVED_FROM_OPENING_SNAPSHOT') {
      fail('opening_basis_reference_invalid', 'opening zero must derive its basis from the opening snapshot');
    }
  } else if (value.opening_basis_reference === null) {
    fail('opening_basis_reference_required', 'positive opening inventory requires an identity-bound basis reference');
  } else if (value.opening_basis_status !== 'REFERENCED_NOT_RESOLVED') {
    fail('opening_basis_reference_invalid', 'opening basis status is invalid');
  }
  if (!DIGEST.test(value.evidence_context_digest)
      || value.evidence_context_digest !== sha256CanonicalJson(digestPreimage(value))) {
    fail('evidence_context_digest_mismatch', 'authoritative evidence context digest is invalid');
  }
  return true;
}

function buildAuthoritativeEvidenceContextV13(input) {
  assertExactFields(input, INPUT_FIELDS, 'authoritative_evidence_context_input');
  validateEvidenceContextSidecarStructureV1(input.transaction_sidecar);
  validateTargetAccountEnumerationStructureV1(input.opening_enumeration);
  validateTargetAccountEnumerationStructureV1(input.ending_enumeration);
  validateBasisReference(input.opening_basis_reference);
  const wallet = input.transaction_sidecar.analyzed_wallet;
  if (input.opening_enumeration.analyzed_wallet !== wallet
      || input.ending_enumeration.analyzed_wallet !== wallet
      || input.opening_enumeration.target_mint !== input.ending_enumeration.target_mint) {
    fail('evidence_context_scope_mismatch', 'sidecar and enumerations must have one wallet and target mint');
  }
  const openingSnapshot = snapshotFromEnumeration('OPENING', input.opening_enumeration);
  const endingSnapshot = snapshotFromEnumeration('ENDING_AS_OF', input.ending_enumeration);
  validateBoundaryOrdering(input.transaction_sidecar, openingSnapshot, endingSnapshot);
  if (openingSnapshot.zero_status === 'EXACT_ZERO' && input.opening_basis_reference !== null) {
    fail('opening_basis_reference_invalid', 'zero opening inventory does not accept a separate basis reference');
  }
  if (openingSnapshot.zero_status === 'EXACT_NONZERO' && input.opening_basis_reference === null) {
    fail('opening_basis_reference_required', 'positive opening inventory requires an identity-bound basis reference');
  }
  const context = {
    authoritative_evidence_context_version: AUTHORITATIVE_EVIDENCE_CONTEXT_VERSION_V13,
    evidence_context_profile: AUTHORITATIVE_EVIDENCE_CONTEXT_PROFILE_V13,
    network: {
      chain: 'solana',
      network: 'mainnet-beta',
      genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    },
    analyzed_wallet: wallet,
    target_mint: input.opening_enumeration.target_mint,
    transaction_population: input.transaction_sidecar,
    opening_snapshot: openingSnapshot,
    ending_snapshot: endingSnapshot,
    population_reconciliation: populationReconciliation(input.transaction_sidecar, openingSnapshot, endingSnapshot),
    external_custody_continuity: unresolvedContinuity(),
    opening_basis_reference: input.opening_basis_reference,
    opening_basis_status: openingSnapshot.zero_status === 'EXACT_ZERO'
      ? 'EXACT_ZERO_DERIVED_FROM_OPENING_SNAPSHOT'
      : 'REFERENCED_NOT_RESOLVED',
    evidence_context_digest: null,
  };
  context.evidence_context_digest = sha256CanonicalJson(digestPreimage(context));
  const frozen = cloneAndFreeze(context);
  validateAuthoritativeEvidenceContextStructureV13(frozen);
  return frozen;
}

export async function buildSourceBoundAuthoritativeEvidenceContextV13(input) {
  validateCapabilityBearingInput(
    input, SOURCE_CONSTRUCTION_FIELDS, 'source_bound_authoritative_evidence_context_construction_input',
  );
  const transactionSidecar = await captureEvidenceContextSidecarV1({
    port: input.transaction_transcript_port,
    legacy_acquisition_result: input.legacy_acquisition_result,
  });
  const openingEnumeration = await captureTargetAccountEnumerationV1({
    port: input.opening_enumeration_port,
    wallet: transactionSidecar.analyzed_wallet,
    target_mint: input.target_mint,
    boundary_kind: 'OPENING',
  });
  const endingEnumeration = await captureTargetAccountEnumerationV1({
    port: input.ending_enumeration_port,
    wallet: transactionSidecar.analyzed_wallet,
    target_mint: input.target_mint,
    boundary_kind: 'ENDING_AS_OF',
  });
  return buildAuthoritativeEvidenceContextV13({
    transaction_sidecar: transactionSidecar,
    opening_enumeration: openingEnumeration,
    ending_enumeration: endingEnumeration,
    opening_basis_reference: input.opening_basis_reference,
  });
}

export async function validateSourceBoundAuthoritativeEvidenceContextV13(input) {
  validateCapabilityBearingInput(input, SOURCE_BOUND_FIELDS, 'source_bound_authoritative_evidence_context_input');
  const expected = await buildSourceBoundAuthoritativeEvidenceContextV13({
    transaction_transcript_port: input.transaction_transcript_port,
    legacy_acquisition_result: input.legacy_acquisition_result,
    opening_enumeration_port: input.opening_enumeration_port,
    ending_enumeration_port: input.ending_enumeration_port,
    target_mint: input.target_mint,
    opening_basis_reference: input.opening_basis_reference,
  });
  if (canonicalJson(input.context) !== canonicalJson(expected)) {
    fail('evidence_context_source_mismatch', 'authoritative evidence context does not match admitted sources');
  }
  return true;
}
