import { types } from 'node:util';
import { canonicalJson, cloneAndFreeze, sha256CanonicalJson } from '../contract.mjs';
import { captureTargetAccountEnumerationV1, HELIUS_FINALIZED_OWNER_ENUMERATION_WATERMARK_PROFILE_V2 } from '../../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import { projectSolanaFullTransactionEffectV13 } from '../solana-full-transaction-effect-projector.mjs';
import { validateFinalizedLegEvidenceV1 } from './episode-evidence-graph-v1.mjs';
function require(value) { if (!value) throw Error('TRUSTED_TERMINAL_LEG_PROJECTION_INVALID'); }

// Projection authority is derived, never a replacement one-row history/context.
// The caller has independently recaptured/validated the entire source context.
export async function projectTrustedTerminalLegV1({ source, state, c, x }) {
  const p = source.terminal_projection;
  require(p && typeof p === 'object' && !types.isProxy(p) && Object.getPrototypeOf(p) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(p);
  const fields = ['version', 'acquisition_finalized', 'opening_enumeration_port'];
  require(Reflect.ownKeys(p).length === fields.length && fields.every(k => descriptors[k]?.enumerable && Object.hasOwn(descriptors[k], 'value')));
  require(p.version === 'artifact_terminal_leg_projection_v1' && x.row.ordinal === 2 && x.row.phase === 'DISPOSAL');
  const rows = source.context.transaction_population.transactions;
  require(rows.length === 2);
  const a = p.acquisition_finalized;
  validateFinalizedLegEvidenceV1(a);
  const acquisition = rows.find(r => r.full_transaction.signature === a.signature)?.full_transaction;
  const disposal = rows.find(r => r.full_transaction.signature === x.row.transaction_signature)?.full_transaction;
  require(acquisition && disposal && acquisition !== disposal);
  require(a.episode_id === x.episode_id && a.phase === 'ACQUISITION' && a.execution_status === 'SUCCEEDED'
    && a.finalized_evidence_digest === state.acquisition_evidence_digest
    && a.finalized_transaction_digest === sha256CanonicalJson(acquisition)
    && a.signature === acquisition.signature && a.slot === acquisition.slot && a.block_time === acquisition.block_time
    && disposal.signature === x.row.transaction_signature && acquisition.slot < disposal.slot
    && acquisition.block_time <= disposal.block_time);
  const m = c.mandate;
  const effect = projectSolanaFullTransactionEffectV13({ wallet: m.wallet_scope.wallet, transaction: acquisition });
  const transfers = effect.established_effects.filter(e => e.effect_kind === 'token_transfer');
  const target = transfers.find(e => e.mint === m.asset_scope.jup_mint), quote = transfers.find(e => e.mint === m.asset_scope.usdc_mint);
  require(effect.finalized_execution_status === 'succeeded' && effect.fee_payer === m.wallet_scope.wallet
    && effect.residual_unresolved_effects.length === 0 && transfers.length === 2 && target && quote
    && BigInt(target.signed_raw_quantity) > 0n && quote.signed_raw_quantity === `-${m.economic_authority.acquisition_input_usdc_raw}`
    && target.signed_raw_quantity === state.chain_derived_acquired_jup_raw
    && a.chain_derived_target_raw_quantity === state.chain_derived_acquired_jup_raw
    && source.context.opening_snapshot.aggregate_raw_quantity === '0'
    && source.context.ending_snapshot.aggregate_raw_quantity === '0');
  const enumeration = await captureTargetAccountEnumerationV1({ port: p.opening_enumeration_port,
    wallet: m.wallet_scope.wallet, target_mint: m.asset_scope.jup_mint, boundary_kind: 'OPENING' });
  require(enumeration.enumeration_profile !== HELIUS_FINALIZED_OWNER_ENUMERATION_WATERMARK_PROFILE_V2
    && enumeration.enumeration_context.slot >= acquisition.slot && enumeration.enumeration_context.slot < disposal.slot);
  const accounts = enumeration.program_results.flatMap(r => r.accounts);
  require(accounts.length === 1 && accounts[0].account === m.wallet_scope.jup_ata
    && accounts[0].token_state.raw_amount === state.chain_derived_acquired_jup_raw);
  // Require the same controlled owner/account shape as the source-authoritative
  // whole opening. Quantity and observation time change; authority does not.
  const original = source.context.opening_snapshot.enumeration_evidence.program_results.flatMap(r => r.accounts);
  require(original.length === 1 && original[0].account === accounts[0].account);
  const shape = t => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'raw_amount'));
  require(canonicalJson(shape(original[0].token_state)) === canonicalJson(shape(accounts[0].token_state)));
  const facts = { version: 'artifact_terminal_leg_projection_v1', whole_source_digest: source.context.evidence_context_digest,
    episode_id: x.episode_id, ordinal: 2, signed_intent_digest: x.row.signed_intent_digest,
    signed_wire_sha256: x.row.signed_wire_sha256, message_sha256: x.row.message_sha256,
    signature: disposal.signature, transaction_digest: sha256CanonicalJson(disposal),
    acquisition_evidence_digest: a.finalized_evidence_digest, opening_enumeration: enumeration,
    opening_quantity: state.chain_derived_acquired_jup_raw, ending_quantity: '0' };
  return { transaction: disposal, evidence: cloneAndFreeze({ ...facts, projection_digest: sha256CanonicalJson(facts) }) };
}
