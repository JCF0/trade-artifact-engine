import { types as utilTypes } from 'node:util';

import { canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { validateSourceBoundAuthoritativeEvidenceContextV13 } from '../authoritative-evidence-context.mjs';
import { createProductionPositionEconomicEvidencePortV13 } from '../production-position-economic-evidence-bridge-v1-3.mjs';
import { validateEpisodeEvidenceGraphStructureV1 } from './episode-evidence-graph-v1.mjs';

const PORTS = new WeakMap();
const SOURCE_FIELDS = ['context', 'context_authority', 'exact_quote_mint'];
const AUTHORITY_FIELDS = [
  'transaction_transcript_port', 'legacy_acquisition_result', 'opening_enumeration_port',
  'ending_enumeration_port', 'target_mint', 'opening_basis_reference',
];
function shell(value, fields, context, functions = false) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      fail('bounded_agent_finalized_evidence_source_invalid', `${context} is invalid`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) if (!fields.includes(key)) fail('bounded_agent_finalized_evidence_source_invalid', `${context} has unknown field`);
    for (const field of fields) {
      if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')
          || (functions && typeof descriptors[field].value !== 'function')) {
        fail('bounded_agent_finalized_evidence_source_invalid', `${context}.${field} is unavailable`);
      }
    }
    return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
  } catch (error) {
    if (error?.name === 'VerificationScopeError') throw error;
    fail('bounded_agent_finalized_evidence_source_invalid', `${context} is unavailable`);
  }
}
function walletMintDelta(transaction, wallet, mint) {
  const before = transaction.pre_token_balances.filter(row => row.owner === wallet && row.mint === mint);
  const after = transaction.post_token_balances.filter(row => row.owner === wallet && row.mint === mint);
  if (before.length !== 1 || after.length !== 1 || before[0].account !== after[0].account) {
    fail('bounded_agent_finalized_evidence_chain_mismatch', 'finalized transaction lacks one wallet target account');
  }
  return BigInt(after[0].raw_amount) - BigInt(before[0].raw_amount);
}
function bindGraphToContext(graph, context) {
  const rows = [...context.transaction_population.transactions]
    .sort((left, right) => left.canonical_transaction_coordinate - right.canonical_transaction_coordinate);
  if (rows.length !== 2) fail('bounded_agent_finalized_evidence_chain_mismatch', 'finalized authority must contain exactly two transactions');
  const legs = [graph.acquisition.finalized, graph.disposal.finalized];
  for (const [index, row] of rows.entries()) {
    const leg = legs[index];
    if (row.source_identity.signature !== leg.signature
        || row.source_identity.slot !== leg.slot || row.full_transaction.block_time !== leg.block_time
        || sha256CanonicalJson(row.full_transaction) !== leg.finalized_transaction_digest
        || row.full_transaction.execution_state !== 'succeeded'
        || row.full_transaction.fee_payer !== graph.mandate.wallet_scope.wallet) {
      fail('bounded_agent_finalized_evidence_chain_mismatch', 'finalized transaction identity does not match episode evidence');
    }
  }
  const acquisitionDelta = walletMintDelta(rows[0].full_transaction, context.analyzed_wallet, context.target_mint);
  const disposalDelta = walletMintDelta(rows[1].full_transaction, context.analyzed_wallet, context.target_mint);
  const acquisitionQuoteDelta = walletMintDelta(rows[0].full_transaction, context.analyzed_wallet, graph.mandate.asset_scope.usdc_mint);
  if (acquisitionDelta <= 0n || disposalDelta !== -acquisitionDelta
      || acquisitionDelta.toString() !== graph.acquisition.finalized.chain_derived_target_raw_quantity
      || acquisitionQuoteDelta !== -BigInt(graph.acquisition.finalized.input_raw_quantity)
      || (-disposalDelta).toString() !== graph.disposal.finalized.input_raw_quantity
      || graph.disposal.finalized.chain_derived_target_raw_quantity !== '0') {
    fail('bounded_agent_finalized_evidence_chain_mismatch', 'chain-derived complete disposal quantity does not reconcile');
  }
}
export function createOfflineFinalizedEvidencePortV1(input) {
  const top = shell(input, ['capture_authority'], 'offline_finalized_evidence_port_input');
  if (typeof top.capture_authority !== 'function') fail('bounded_agent_finalized_evidence_port_denied', 'capture authority is unavailable');
  const port = Object.freeze({ async captureFinalizedEvidenceAuthorityV1() { return top.capture_authority(); } });
  PORTS.set(port, true);
  return port;
}
export async function captureFinalizedEvidenceAuthorityV1({ finalized_evidence_port, evidence_graph }) {
  if (finalized_evidence_port === null || (typeof finalized_evidence_port !== 'object' && typeof finalized_evidence_port !== 'function')
      || !PORTS.has(finalized_evidence_port)) {
    fail('bounded_agent_finalized_evidence_port_denied', 'only a registered offline finalized-evidence port is admitted');
  }
  validateEpisodeEvidenceGraphStructureV1(evidence_graph);
  const raw = await finalized_evidence_port.captureFinalizedEvidenceAuthorityV1();
  const source = shell(raw, SOURCE_FIELDS, 'offline_finalized_evidence_source');
  const authority = shell(source.context_authority, AUTHORITY_FIELDS, 'offline_finalized_context_authority');
  await validateSourceBoundAuthoritativeEvidenceContextV13({
    context: source.context,
    ...authority,
  });
  if (source.context.analyzed_wallet !== evidence_graph.mandate.wallet_scope.wallet
      || source.context.target_mint !== evidence_graph.mandate.asset_scope.jup_mint
      || source.exact_quote_mint !== evidence_graph.mandate.asset_scope.usdc_mint) {
    fail('bounded_agent_finalized_evidence_scope_mismatch', 'finalized v1.3 authority scope does not match the mandate');
  }
  bindGraphToContext(evidence_graph, source.context);
  const economicEvidencePort = await createProductionPositionEconomicEvidencePortV13({
    evidence_context: source.context,
    context_authority: source.context_authority,
    exact_quote_mint: source.exact_quote_mint,
  });
  return Object.freeze({
    context: source.context,
    context_authority: source.context_authority,
    exact_quote_mint: source.exact_quote_mint,
    economic_evidence_port: economicEvidencePort,
  });
}
