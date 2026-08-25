import { types as utilTypes } from 'node:util';

import {
  assertExactFields,
  canonicalJson,
  cloneAndFreeze,
  fail,
  sha256CanonicalJson,
} from '../verification-scope-v1-3/contract.mjs';
import { validateWalletAcquisitionResultV1 } from '../candidate-set/acquisition-result.mjs';
import { isSolanaSignatureV1 } from './solana-identities.mjs';
import { validateSolanaFullTransactionV1 } from './solana-full-transaction.mjs';

export const EVIDENCE_CONTEXT_SIDECAR_VERSION_V1 = 'artifact_evidence_context_sidecar_v1';
export const EVIDENCE_CONTEXT_SIDECAR_PROFILE_V1 = 'ARTIFACT_EVIDENCE_CONTEXT_SIDECAR_V1';

const INPUT_FIELDS = ['legacy_acquisition_result', 'authoritative_population', 'full_transactions'];
const SOURCE_BOUND_FIELDS = ['transcript_port', 'legacy_acquisition_result', 'sidecar'];
const CAPABILITY_FIELDS = ['getAuthoritativeTransactionTranscriptV1'];
const CAPTURE_FIELDS = ['port', 'legacy_acquisition_result'];
const TRANSCRIPT_RESPONSE_FIELDS = ['authoritative_population', 'full_transactions'];
const SOURCE_FIELDS = ['signature', 'slot', 'block_time', 'execution_state'];
const SIDECAR_FIELDS = [
  'evidence_context_sidecar_version', 'sidecar_profile', 'analyzed_wallet',
  'legacy_acquisition_result_digest', 'pagination_terminal_reason', 'population_order_profile',
  'population_evidence_digest', 'transactions', 'sidecar_digest',
];
const TRANSACTION_FIELDS = [
  'acquisition_population_coordinate', 'canonical_transaction_coordinate', 'source_identity',
  'full_transaction_digest', 'full_transaction',
];
const TERMINAL_REASONS = new Set(['historical_bound_reached', 'provider_exhaustion']);
const TRANSCRIPT_PORTS = new WeakSet();

function validateTranscriptCapability(capability) {
  try {
    if (capability === null || typeof capability !== 'object' || Array.isArray(capability)
        || utilTypes.isProxy(capability) || Object.getPrototypeOf(capability) !== Object.prototype
        || Object.getOwnPropertySymbols(capability).length !== 0) {
      fail('invalid_transcript_capability', 'authoritative transaction transcript capability is invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(capability);
    if (Object.keys(descriptors).length !== CAPABILITY_FIELDS.length) {
      fail('invalid_transcript_capability', 'authoritative transaction transcript capability is invalid');
    }
    const descriptor = descriptors.getAuthoritativeTransactionTranscriptV1;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      fail('invalid_transcript_capability', 'authoritative transaction transcript capability is invalid');
    }
    return descriptor.value.bind(capability);
  } catch (error) {
    if (error?.code === 'invalid_transcript_capability') throw error;
    fail('invalid_transcript_capability', 'authoritative transaction transcript capability is invalid');
  }
}

function validateCaptureInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length !== 0) {
    fail('invalid_transcript_port', 'evidence context sidecar capture input is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Object.keys(descriptors)) {
    if (!CAPTURE_FIELDS.includes(key)) fail('unknown_field', 'evidence_context_sidecar_capture_input contains unknown field');
  }
  for (const field of CAPTURE_FIELDS) {
    if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')) {
      fail('missing_field', `evidence_context_sidecar_capture_input is missing ${field}`);
    }
  }
}

function validateSourceBoundInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length !== 0) {
    fail('source_binding_mismatch', 'source-bound sidecar input is invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).length !== SOURCE_BOUND_FIELDS.length) {
    fail('source_binding_mismatch', 'source-bound sidecar input is invalid');
  }
  for (const field of SOURCE_BOUND_FIELDS) {
    if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')) {
      fail('source_binding_mismatch', 'source-bound sidecar input is invalid');
    }
  }
}

function safeNonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function validateSource(value, context) {
  assertExactFields(value, SOURCE_FIELDS, context);
  if (!isSolanaSignatureV1(value.signature) || !safeNonnegative(value.slot)
      || !safeNonnegative(value.block_time) || !['succeeded', 'failed'].includes(value.execution_state)) {
    fail('invalid_authoritative_population', `${context} is invalid`);
  }
}
function sameSource(source, transaction) {
  return source.signature === transaction.signature && source.slot === transaction.slot
    && source.block_time === transaction.block_time && source.execution_state === transaction.execution_state;
}
function populationDigestPreimage(value) {
  return {
    population_identity_profile: 'ARTIFACT_TRANSACTION_POPULATION_EVIDENCE_ID_V1',
    analyzed_wallet: value.analyzed_wallet,
    pagination_terminal_reason: value.pagination_terminal_reason,
    population_order_profile: value.population_order_profile,
    transactions: value.transactions.map(item => ({
      acquisition_population_coordinate: item.acquisition_population_coordinate,
      canonical_transaction_coordinate: item.canonical_transaction_coordinate,
      source_identity: item.source_identity,
      full_transaction_digest: item.full_transaction_digest,
    })),
  };
}
function sidecarDigestPreimage(value) {
  const preimage = {};
  for (const field of SIDECAR_FIELDS) if (field !== 'sidecar_digest') {
    Object.defineProperty(preimage, field, { value: value[field], enumerable: true });
  }
  return preimage;
}
function validateNewestFirst(transactions) {
  transactions.forEach((item, index) => {
    if (index === 0) return;
    const previous = transactions[index - 1].source_identity;
    const current = item.source_identity;
    if (current.slot > previous.slot) {
      fail('noncanonical_population_order', 'authoritative population must retain newest-first acquisition order');
    }
  });
}
function validateDispositionReconciliation(acquisitionResult, population) {
  const dispositions = new Map(acquisitionResult.transaction_dispositions.map(item => [item.tx_hash, item]));
  if (dispositions.size !== population.length) {
    fail('population_disposition_mismatch', 'population and legacy dispositions have different cardinality');
  }
  for (const source of population) {
    const disposition = dispositions.get(source.signature);
    const failed = disposition?.disposition_type === 'failed_transaction';
    if (disposition === undefined || disposition.slot !== source.slot || disposition.block_time !== source.block_time
        || source.execution_state !== (failed ? 'failed' : 'succeeded')) {
      fail('population_disposition_mismatch', 'population does not exactly reconcile with legacy dispositions');
    }
  }
}

export function validateEvidenceContextSidecarStructureV1(value) {
  assertExactFields(value, SIDECAR_FIELDS, 'evidence_context_sidecar');
  if (value.evidence_context_sidecar_version !== EVIDENCE_CONTEXT_SIDECAR_VERSION_V1
      || value.sidecar_profile !== EVIDENCE_CONTEXT_SIDECAR_PROFILE_V1
      || value.population_order_profile !== 'finalized_wallet_signature_newest_first_v1') {
    fail('unsupported_sidecar_version', 'evidence context sidecar version or profile is unsupported');
  }
  if (typeof value.analyzed_wallet !== 'string' || !/^[0-9a-f]{64}$/.test(value.legacy_acquisition_result_digest)) {
    fail('invalid_sidecar_scope', 'evidence context sidecar scope is invalid');
  }
  if (!TERMINAL_REASONS.has(value.pagination_terminal_reason)) {
    fail('unsupported_population_terminal_reason', 'population terminal reason is unsupported');
  }
  if (!Array.isArray(value.transactions)) fail('invalid_authoritative_population', 'transactions must be an array');
  const signatures = new Set();
  value.transactions.forEach((item, index) => {
    assertExactFields(item, TRANSACTION_FIELDS, `transactions.${index}`);
    validateSource(item.source_identity, `transactions.${index}.source_identity`);
    validateSolanaFullTransactionV1(item.full_transaction);
    if (item.acquisition_population_coordinate !== index
        || item.canonical_transaction_coordinate !== value.transactions.length - 1 - index) {
      fail('noncanonical_population_coordinates', 'population coordinates must be dense and mutually reversed');
    }
    if (signatures.has(item.source_identity.signature)) fail('duplicate_transaction_identity', 'population signatures must be unique');
    signatures.add(item.source_identity.signature);
    if (!sameSource(item.source_identity, item.full_transaction)
        || item.full_transaction_digest !== sha256CanonicalJson(item.full_transaction)) {
      fail('source_transaction_mismatch', 'full transaction does not match its authoritative source identity');
    }
  });
  validateNewestFirst(value.transactions);
  if (value.population_evidence_digest !== sha256CanonicalJson(populationDigestPreimage(value))) {
    fail('population_evidence_digest_mismatch', 'population evidence digest is invalid');
  }
  if (value.sidecar_digest !== sha256CanonicalJson(sidecarDigestPreimage(value))) {
    fail('sidecar_digest_mismatch', 'sidecar digest is invalid');
  }
  return true;
}

function buildEvidenceContextSidecarV1(input) {
  assertExactFields(input, INPUT_FIELDS, 'evidence_context_sidecar_input');
  validateWalletAcquisitionResultV1(input.legacy_acquisition_result);
  if (!Array.isArray(input.authoritative_population) || !Array.isArray(input.full_transactions)
      || input.authoritative_population.length !== input.full_transactions.length) {
    fail('source_transaction_mismatch', 'population and full transaction cardinality must match');
  }
  const sources = input.authoritative_population.map((source, index) => {
    validateSource(source, `authoritative_population.${index}`);
    return source;
  });
  if (new Set(sources.map(source => source.signature)).size !== sources.length) {
    fail('duplicate_transaction_identity', 'authoritative population signatures must be unique');
  }
  validateDispositionReconciliation(input.legacy_acquisition_result, sources);
  const transactions = sources.map((source, index) => {
    const fullTransaction = input.full_transactions[index];
    validateSolanaFullTransactionV1(fullTransaction);
    if (!sameSource(source, fullTransaction)) fail('source_transaction_mismatch', 'full transaction does not match source order');
    return {
      acquisition_population_coordinate: index,
      canonical_transaction_coordinate: sources.length - 1 - index,
      source_identity: source,
      full_transaction_digest: sha256CanonicalJson(fullTransaction),
      full_transaction: fullTransaction,
    };
  });
  validateNewestFirst(transactions);
  const sidecar = {
    evidence_context_sidecar_version: EVIDENCE_CONTEXT_SIDECAR_VERSION_V1,
    sidecar_profile: EVIDENCE_CONTEXT_SIDECAR_PROFILE_V1,
    analyzed_wallet: input.legacy_acquisition_result.scope.wallet,
    legacy_acquisition_result_digest: sha256CanonicalJson(input.legacy_acquisition_result),
    pagination_terminal_reason: input.legacy_acquisition_result.coverage.pagination_terminal_reason,
    population_order_profile: 'finalized_wallet_signature_newest_first_v1',
    population_evidence_digest: null,
    transactions,
    sidecar_digest: null,
  };
  sidecar.population_evidence_digest = sha256CanonicalJson(populationDigestPreimage(sidecar));
  sidecar.sidecar_digest = sha256CanonicalJson(sidecarDigestPreimage(sidecar));
  const frozen = cloneAndFreeze(sidecar);
  validateEvidenceContextSidecarStructureV1(frozen);
  return frozen;
}

export function createEvidenceContextTranscriptPortV1(capabilities) {
  const captureTranscript = validateTranscriptCapability(capabilities);
  const port = Object.freeze({
    async getAuthoritativeTransactionTranscriptV1(request) {
      try {
        return cloneAndFreeze(await captureTranscript(cloneAndFreeze(request)));
      } catch {
        fail('transaction_transcript_unavailable', 'authoritative transaction transcript is unavailable');
      }
    },
  });
  TRANSCRIPT_PORTS.add(port);
  return port;
}

export async function captureEvidenceContextSidecarV1(input) {
  validateCaptureInput(input);
  if (!TRANSCRIPT_PORTS.has(input.port)) {
    fail('invalid_transcript_port', 'authoritative transaction transcript port is invalid');
  }
  validateWalletAcquisitionResultV1(input.legacy_acquisition_result);
  const response = await input.port.getAuthoritativeTransactionTranscriptV1({
    analyzed_wallet: input.legacy_acquisition_result.scope.wallet,
    legacy_acquisition_result_digest: sha256CanonicalJson(input.legacy_acquisition_result),
  });
  assertExactFields(response, TRANSCRIPT_RESPONSE_FIELDS, 'authoritative_transaction_transcript_response');
  return buildEvidenceContextSidecarV1({
    legacy_acquisition_result: input.legacy_acquisition_result,
    authoritative_population: response.authoritative_population,
    full_transactions: response.full_transactions,
  });
}

export async function validateSourceBoundEvidenceContextSidecarV1(input) {
  validateSourceBoundInput(input);
  validateCaptureInput({
    port: input.transcript_port,
    legacy_acquisition_result: input.legacy_acquisition_result,
  });
  assertExactFields(input.sidecar, SIDECAR_FIELDS, 'source_bound_evidence_context_sidecar');
  const expected = await captureEvidenceContextSidecarV1({
    port: input.transcript_port,
    legacy_acquisition_result: input.legacy_acquisition_result,
  });
  if (canonicalJson(expected) !== canonicalJson(input.sidecar)) {
    fail('source_binding_mismatch', 'evidence context sidecar does not match its admitted sources');
  }
  return true;
}
