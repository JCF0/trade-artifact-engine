import { types } from 'node:util';
import { canonicalJson, cloneAndFreeze, sha256CanonicalJson } from '../contract.mjs';
import { validateSourceBoundAuthoritativeEvidenceContextV13 } from '../authoritative-evidence-context.mjs';
import { projectSolanaFullTransactionEffectV13 } from '../solana-full-transaction-effect-projector.mjs';
import { buildFinalizedLegEvidenceV1 } from './episode-evidence-graph-v1.mjs';
import { captureAuthoritativeAcquisitionClosureV1, createOfflineAcquisitionClosurePortV1 } from './acquisition-closure-authority-v1.mjs';

function stop() { throw Error('TRUSTED_TERMINAL_SOURCE_AUTHORITY_INVALID'); }
function sourceShell(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== 3) stop();
  const descriptors = Object.getOwnPropertyDescriptors(value), fields = ['context', 'context_authority', 'exact_quote_mint'];
  if (fields.some(k => !descriptors[k]?.enumerable || !Object.hasOwn(descriptors[k], 'value'))) stop();
  return Object.fromEntries(fields.map(k => [k, descriptors[k].value]));
}
// Trusted executor construction only. The callback recaptures a separate v1.3
// source capability. Neither a scheduler digest nor the agent supplies economics.
export async function closeTrustedTerminalSourceV1({ c, authority, x, terminal, capture, retain }) {
  if (typeof capture !== 'function' || terminal.meta?.err !== null) stop();
  const state = await authority.loadCurrentEpisodeStateV1({ episode_id: x.episode_id });

  const source = sourceShell(await capture(cloneAndFreeze({ episode_id: x.episode_id, ordinal: x.row.ordinal,
    signature: x.row.transaction_signature, slot: terminal.slot })));
  await validateSourceBoundAuthoritativeEvidenceContextV13({ context: source.context, ...source.context_authority });
  const rows = source.context.transaction_population.transactions;
  if (rows.length !== 1) stop();
  const tx = rows[0].full_transaction;
  if (tx.signature !== x.row.transaction_signature || tx.slot !== terminal.slot || tx.block_time !== terminal.blockTime
      || source.context.analyzed_wallet !== c.mandate.wallet_scope.wallet
      || source.context.target_mint !== c.mandate.asset_scope.jup_mint
      || source.exact_quote_mint !== c.mandate.asset_scope.usdc_mint) stop();
  const effect = projectSolanaFullTransactionEffectV13({ wallet: c.mandate.wallet_scope.wallet, transaction: tx });
  const transfers = effect.established_effects.filter(e => e.effect_kind === 'token_transfer');
  const target = transfers.find(e => e.mint === c.mandate.asset_scope.jup_mint);
  const quote = transfers.find(e => e.mint === c.mandate.asset_scope.usdc_mint);
  if (effect.finalized_execution_status !== 'succeeded' || effect.fee_payer !== c.mandate.wallet_scope.wallet
      || effect.residual_unresolved_effects.length || transfers.length !== 2 || !target || !quote) stop();
  const acquisition = x.row.ordinal === 1;
  if (!acquisition && source.context.opening_basis_reference?.basis_evidence_digest !== state.acquisition_evidence_digest) stop();
  const delta = BigInt(target.signed_raw_quantity), quoteDelta = BigInt(quote.signed_raw_quantity);
  if (acquisition ? delta <= 0n || quoteDelta !== -BigInt(c.mandate.economic_authority.acquisition_input_usdc_raw)
    : state.chain_derived_acquired_jup_raw === null || delta !== -BigInt(state.chain_derived_acquired_jup_raw) || quoteDelta <= 0n) stop();
  if (source.context.opening_snapshot.aggregate_raw_quantity !== (acquisition ? '0' : state.chain_derived_acquired_jup_raw)
      || source.context.ending_snapshot.aggregate_raw_quantity !== (acquisition ? delta.toString() : '0')) stop();
  const finalized = buildFinalizedLegEvidenceV1({ episode_id: x.episode_id, phase: x.row.phase,
    signed_intent_digest: x.row.signed_intent_digest, signed_wire_sha256: x.row.signed_wire_sha256,
    message_sha256: x.row.message_sha256, signature: tx.signature, finalized_transaction_digest: sha256CanonicalJson(tx),
    slot: tx.slot, block_time: tx.block_time, execution_status: 'SUCCEEDED', wallet: c.mandate.wallet_scope.wallet,
    input_mint: acquisition ? c.mandate.asset_scope.usdc_mint : c.mandate.asset_scope.jup_mint,
    output_mint: acquisition ? c.mandate.asset_scope.jup_mint : c.mandate.asset_scope.usdc_mint,
    input_raw_quantity: acquisition ? c.mandate.economic_authority.acquisition_input_usdc_raw : state.chain_derived_acquired_jup_raw,
    chain_derived_target_raw_quantity: acquisition ? delta.toString() : '0' });
  // Economic source context retained separately from transmission and agent records.
  await retain({ schema: 'artifact_trusted_terminal_economic_source_v1', context: source.context, finalized });
  if (x.row.stage === 'FINALIZED') {
    if (x.row.finalized_evidence_digest !== finalized.finalized_evidence_digest
        || (acquisition ? state.acquisition_evidence_digest : state.disposal_evidence_digest) !== finalized.finalized_evidence_digest) stop();
    return state;
  }
  if (acquisition) {
    const proof = await captureAuthoritativeAcquisitionClosureV1({
      acquisition_closure_port: createOfflineAcquisitionClosurePortV1({ capture_authority: async () => ({ ...source, finalized_acquisition: finalized }) }),
      mandate: c.mandate, authorization: c.authorization, signed_intent_digest: x.row.signed_intent_digest,
      semantic_transaction_digest: x.row.semantic_transaction_digest, message_sha256: x.row.message_sha256,
      signed_transaction_signature: x.row.transaction_signature, signed_wire_sha256: x.row.signed_wire_sha256 });
    return authority.closeAcquisitionFromFinalizedEvidenceV1(proof);
  }
  // Existing atomic disposal transition; exact quantity came only from the durable
  // finalized acquisition state and was rechecked against source-authoritative effects.
  await authority.recordFinalizedV1({ episode_id: x.episode_id, ordinal: 2, signed_intent_digest: x.row.signed_intent_digest,
    signed_wire_sha256: x.row.signed_wire_sha256, finalized_evidence_digest: finalized.finalized_evidence_digest });
  return authority.loadCurrentEpisodeStateV1({ episode_id: x.episode_id });
}
