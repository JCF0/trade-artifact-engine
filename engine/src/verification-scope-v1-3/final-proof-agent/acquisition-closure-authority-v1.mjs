import { types as utilTypes } from 'node:util';

import { validateSourceBoundAuthoritativeEvidenceContextV13 } from '../authoritative-evidence-context.mjs';
import { canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { projectSolanaFullTransactionEffectV13 } from '../solana-full-transaction-effect-projector.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { validateFinalizedLegEvidenceV1 } from './episode-evidence-graph-v1.mjs';
import { validateExecutorMandateV1 as validateBoundedAgentMandateV1 } from './executor-mandate-profile-v1.mjs';

const PORTS = new WeakMap();
const PROOFS = new WeakSet();
const SOURCE_FIELDS = ['context', 'context_authority', 'exact_quote_mint', 'finalized_acquisition'];
const AUTHORITY_FIELDS = [
  'transaction_transcript_port', 'legacy_acquisition_result', 'opening_enumeration_port',
  'ending_enumeration_port', 'target_mint', 'opening_basis_reference',
];

function exactPlainObject(value, fields, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    fail('bounded_agent_acquisition_closure_source_invalid', `${context} must be a plain exact object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== fields.length
      || fields.some(field => !descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value'))
      || Object.keys(descriptors).some(field => !fields.includes(field))) {
    fail('bounded_agent_acquisition_closure_source_invalid', `${context} fields are invalid`);
  }
  return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
}

export function createOfflineAcquisitionClosurePortV1({ capture_authority }) {
  if (typeof capture_authority !== 'function') throw new TypeError('capture_authority must be a function');
  const port = Object.freeze({
    async captureAuthoritativeAcquisitionClosureV1(request) {
      return capture_authority(structuredClone(request));
    },
  });
  PORTS.set(port, true);
  return port;
}

export function isAuthoritativeAcquisitionClosureProofV1(value) {
  return value !== null && typeof value === 'object' && PROOFS.has(value);
}

export async function captureAuthoritativeAcquisitionClosureV1({
  acquisition_closure_port,
  mandate,
  authorization,
  signed_intent_digest,
  semantic_transaction_digest,
  message_sha256,
  signed_transaction_signature,
  signed_wire_sha256,
}) {
  validateBoundedAgentMandateV1(mandate);
  validateHumanEpisodeAuthorizationV1(authorization, { mandate });
  if (!PORTS.has(acquisition_closure_port)) {
    fail('bounded_agent_acquisition_closure_capability_denied', 'acquisition closure requires a registered source-bound port');
  }
  const request = {
    episode_id: `bounded-agent-episode-${authorization.authorization_digest}`,
    mandate_digest: mandate.mandate_digest,
    authorization_digest: authorization.authorization_digest,
    signed_intent_digest,
    semantic_transaction_digest,
    message_sha256,
    signed_transaction_signature,
    signed_wire_sha256,
  };
  const source = exactPlainObject(
    await acquisition_closure_port.captureAuthoritativeAcquisitionClosureV1(request),
    SOURCE_FIELDS,
    'acquisition_closure_source',
  );
  const contextAuthority = exactPlainObject(source.context_authority, AUTHORITY_FIELDS, 'acquisition_closure_context_authority');
  await validateSourceBoundAuthoritativeEvidenceContextV13({
    context: source.context,
    ...contextAuthority,
  });
  validateFinalizedLegEvidenceV1(source.finalized_acquisition);
  const finalized = source.finalized_acquisition;
  const rows = [...source.context.transaction_population.transactions];
  if (rows.length !== 1 || rows[0].canonical_transaction_coordinate !== 0) {
    fail('bounded_agent_acquisition_closure_population_invalid', 'acquisition closure requires exactly one source-bound finalized transaction');
  }
  const transaction = rows[0].full_transaction;
  const transactionDigest = sha256CanonicalJson(transaction);
  const effect = projectSolanaFullTransactionEffectV13({ wallet: mandate.wallet_scope.wallet, transaction });
  const transfers = effect.established_effects.filter(item => item.effect_kind === 'token_transfer');
  const target = transfers.find(item => item.mint === mandate.asset_scope.jup_mint);
  const quote = transfers.find(item => item.mint === mandate.asset_scope.usdc_mint);
  const acquired = target === undefined ? 0n : BigInt(target.signed_raw_quantity);
  const quoteDelta = quote === undefined ? 0n : BigInt(quote.signed_raw_quantity);
  if (transaction.signature !== signed_transaction_signature
      || effect.finalized_execution_status !== 'succeeded'
      || effect.fee_payer !== mandate.wallet_scope.wallet
      || effect.residual_unresolved_effects.length !== 0 || transfers.length !== 2
      || acquired <= 0n || quoteDelta >= 0n
      || (-quoteDelta).toString() !== mandate.economic_authority.acquisition_input_usdc_raw
      || source.context.opening_snapshot.aggregate_raw_quantity !== '0'
      || source.context.ending_snapshot.aggregate_raw_quantity !== acquired.toString()
      || source.exact_quote_mint !== mandate.asset_scope.usdc_mint) {
    fail('bounded_agent_acquisition_closure_economics_invalid', 'source-bound acquisition economics do not match the mandate');
  }
  const expected = {
    episode_id: request.episode_id,
    phase: 'ACQUISITION',
    signed_intent_digest,
    signed_wire_sha256,
    message_sha256,
    signature: transaction.signature,
    finalized_transaction_digest: transactionDigest,
    slot: transaction.slot,
    block_time: transaction.block_time,
    execution_status: 'SUCCEEDED',
    wallet: mandate.wallet_scope.wallet,
    input_mint: mandate.asset_scope.usdc_mint,
    output_mint: mandate.asset_scope.jup_mint,
    input_raw_quantity: mandate.economic_authority.acquisition_input_usdc_raw,
    chain_derived_target_raw_quantity: acquired.toString(),
  };
  const compared = Object.fromEntries(Object.keys(expected).map(field => [field, finalized[field]]));
  if (canonicalJson(compared) !== canonicalJson(expected)
      || finalized.finalized_evidence_digest !== sha256CanonicalJson(Object.fromEntries(
        Object.entries(finalized).filter(([field]) => !['finalized_evidence_id', 'finalized_evidence_digest'].includes(field)),
      ))) {
    fail('bounded_agent_acquisition_closure_chain_mismatch', 'finalized acquisition does not match reconstructed source authority');
  }
  const proof = cloneAndFreeze({
    acquisition_closure_proof_version: 'artifact_authoritative_acquisition_closure_proof_v1',
    episode_id: request.episode_id,
    finalized_evidence_digest: finalized.finalized_evidence_digest,
    finalized_transaction_digest: transactionDigest,
    chain_derived_acquired_jup_raw: acquired.toString(),
    evidence_context_digest: source.context.evidence_context_digest,
    signed_intent_digest,
    semantic_transaction_digest,
    message_sha256,
    signed_transaction_signature,
    signed_wire_sha256,
  });
  PROOFS.add(proof);
  return proof;
}
