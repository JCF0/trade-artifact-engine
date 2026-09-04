import { types as utilTypes } from 'node:util';

import { USDC_MINT } from '../pipeline/constants.mjs';
import { isSolanaPublicKeyV1 } from '../wallet-acquisition/solana-identities.mjs';
import {
  validateAuthoritativeEvidenceContextStructureV13,
  validateSourceBoundAuthoritativeEvidenceContextV13,
} from './authoritative-evidence-context.mjs';
import { canonicalJson, fail, sha256CanonicalJson } from './contract.mjs';
import { createPositionEconomicEvidencePortV13 } from './position-episode.mjs';
import { projectSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';

export const CONTROLLED_CLASSIC_SPL_USDC_POSITION_ECONOMIC_BRIDGE_PROFILE_V1 =
  'ARTIFACT_CONTROLLED_CLASSIC_SPL_USDC_POSITION_ECONOMIC_BRIDGE_V1';
export const PRODUCTION_POSITION_ECONOMIC_EVIDENCE_BRIDGE_VERSION_V1_3 =
  'artifact_production_position_economic_evidence_bridge_v1_3';

const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const INPUT_FIELDS = ['evidence_context', 'context_authority', 'exact_quote_mint'];
const CONTEXT_AUTHORITY_FIELDS = [
  'transaction_transcript_port',
  'legacy_acquisition_result',
  'opening_enumeration_port',
  'ending_enumeration_port',
  'target_mint',
  'opening_basis_reference',
];

// Production ports will be entered here only after Slice 2 can establish the
// same-operation relationship. Generic Slice 4 callback ports never enter it.
const PRODUCTION_PORTS = new WeakMap();

function exactCapabilityShell(value, fields, context) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      fail('invalid_source_bound_input', `${context} must be a plain capability shell`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) {
      if (!fields.includes(key)) fail('unknown_field', `${context} contains unknown field`);
    }
    for (const field of fields) {
      if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')) {
        fail('missing_field', `${context} is missing ${field}`);
      }
    }
    return descriptors;
  } catch (error) {
    if (error?.name === 'VerificationScopeError') throw error;
    fail('invalid_source_bound_input', `${context} is unavailable`);
  }
}

function requireControlledBoundary(context) {
  const opening = context.opening_snapshot;
  const ending = context.ending_snapshot;
  if (context.opening_basis_reference !== null
      || context.opening_basis_status !== 'EXACT_ZERO_DERIVED_FROM_OPENING_SNAPSHOT'
      || opening.zero_status !== 'EXACT_ZERO' || opening.aggregate_raw_quantity !== '0'
      || ending.zero_status !== 'EXACT_ZERO' || ending.aggregate_raw_quantity !== '0') {
    fail(
      'position_economic_controlled_boundary_invalid',
      'production bridge requires exact zero opening and ending target inventory',
    );
  }
  if (opening.accounts.length !== 1 || ending.accounts.length !== 1) {
    fail(
      'position_economic_controlled_boundary_invalid',
      'production bridge requires one persistent target account',
    );
  }
  const before = opening.accounts[0];
  const after = ending.accounts[0];
  if (before.account !== after.account
      || before.mint !== context.target_mint || after.mint !== context.target_mint
      || before.token_authority !== context.analyzed_wallet || after.token_authority !== context.analyzed_wallet
      || before.account_program !== CLASSIC_TOKEN_PROGRAM || after.account_program !== CLASSIC_TOKEN_PROGRAM
      || before.lifecycle_state !== 'EXISTS' || after.lifecycle_state !== 'EXISTS') {
    fail(
      'position_economic_controlled_boundary_invalid',
      'production bridge requires one pre-existing persistent classic target account',
    );
  }
}

function requireNarrowEffectPopulation(reconstructed, context, exactQuoteMint) {
  for (const { effect } of reconstructed) {
    if (effect.finalized_execution_status !== 'succeeded' || effect.fee_payer !== context.analyzed_wallet) {
      fail('position_economic_transaction_unsupported', 'controlled economic transactions must succeed with the wallet as fee payer');
    }
    if (effect.established_effects.some(item => ['account_creation', 'account_closure'].includes(item.effect_kind))) {
      fail(
        'position_economic_target_lifecycle_unsupported',
        'target account lifecycle mutation is outside the production profile',
      );
    }
    const tokenObservations = effect.established_effects
      .filter(item => item.effect_kind === 'token_balance_observation');
    const observedMints = tokenObservations.map(item => item.mint).sort();
    const expectedMints = [context.target_mint, exactQuoteMint].sort();
    if (tokenObservations.length !== 2
        || observedMints.some((mint, index) => mint !== expectedMints[index])) {
      fail(
        'position_economic_unrelated_wallet_activity',
        'controlled transaction must have only exact target and quote observations',
      );
    }
    const fees = effect.established_effects.filter(item => item.effect_kind === 'network_fee');
    const native = effect.established_effects.filter(item => item.effect_kind === 'native_balance_observation');
    if (fees.length !== 1 || native.length !== 1
        || fees[0].account !== context.analyzed_wallet || native[0].account !== context.analyzed_wallet
        || fees[0].signed_lamports !== (-BigInt(effect.fee_lamports)).toString()
        || native[0].signed_lamports !== fees[0].signed_lamports
        || fees[0].corroborating_effect_ids.length !== 1
        || fees[0].corroborating_effect_ids[0] !== native[0].effect_id) {
      fail(
        'position_economic_native_evidence_unresolved',
        'wallet native observation must reconcile only the exact network fee',
      );
    }
    const allowedKinds = new Set([
      'network_fee', 'native_balance_observation', 'token_balance_observation', 'token_transfer',
    ]);
    if (effect.established_effects.some(item => !allowedKinds.has(item.effect_kind))) {
      fail('position_economic_transaction_unsupported', 'transaction contains an unsupported established effect');
    }
  }
}

function requireSameOperationAuthority(reconstructed, targetMint, quoteMint) {
  const sourceEvents = [];
  for (const { effect } of reconstructed) {
    const transfers = effect.established_effects.filter(item => item.effect_kind === 'token_transfer');
    const byMint = new Map(transfers.map(item => [item.mint, item]));
    if (transfers.length !== 2 || byMint.size !== 2 || !byMint.has(targetMint) || !byMint.has(quoteMint)) {
      fail(
        'position_economic_same_operation_unestablished',
        'aggregate balance observations do not establish one economic operation',
      );
    }
    const target = byMint.get(targetMint);
    const quote = byMint.get(quoteMint);
    if (target.source_coordinate.coordinate_kind !== 'instruction'
        || quote.source_coordinate.coordinate_kind !== 'instruction'
        || target.source_coordinate.inner_instruction_index === null
        || quote.source_coordinate.inner_instruction_index === null
        || target.source_coordinate.outer_instruction_index !== quote.source_coordinate.outer_instruction_index) {
      fail(
        'position_economic_same_operation_unestablished',
        'instruction-bound target and quote effects do not share one admitted route root',
      );
    }
    if ((BigInt(target.signed_raw_quantity) > 0n) === (BigInt(quote.signed_raw_quantity) > 0n)
        || target.signed_raw_quantity === '0' || quote.signed_raw_quantity === '0') {
      fail('position_economic_same_operation_unestablished', 'target and quote transfer directions must oppose');
    }
    const observations = new Map(effect.established_effects
      .filter(item => item.effect_kind === 'token_balance_observation')
      .map(item => [item.effect_id, item]));
    for (const transfer of [target, quote]) {
      const observation = transfer.corroborating_effect_ids.length === 1
        ? observations.get(transfer.corroborating_effect_ids[0]) : null;
      if (observation === null || observation === undefined
          || observation.account !== transfer.account || observation.owner !== transfer.owner
          || observation.mint !== transfer.mint || observation.token_program !== transfer.token_program
          || observation.decimals !== transfer.decimals
          || observation.signed_raw_quantity !== transfer.signed_raw_quantity) {
        fail('position_economic_same_operation_unestablished', 'transfer effects require exact wallet-balance corroboration');
      }
    }
    const targetQuantity = BigInt(target.signed_raw_quantity);
    const eventKind = targetQuantity > 0n ? 'TARGET_ACQUISITION' : 'TARGET_DISPOSAL';
    sourceEvents.push({
      transaction_signature: effect.transaction_identity.signature,
      authoritative_intra_transaction_coordinate: target.source_coordinate.outer_instruction_index,
      event_kind: eventKind,
      payload: {
        target_raw_quantity: (targetQuantity < 0n ? -targetQuantity : targetQuantity).toString(),
        quote_status: 'EXACT',
        quote_mint: quoteMint,
        quote_raw_amount: (BigInt(quote.signed_raw_quantity) < 0n
          ? -BigInt(quote.signed_raw_quantity) : BigInt(quote.signed_raw_quantity)).toString(),
      },
      source_effect_ids: [target.effect_id, quote.effect_id].sort(),
      corroborating_effect_ids: [
        ...target.corroborating_effect_ids, ...quote.corroborating_effect_ids,
      ].sort(),
      dependency_references: [],
    });
  }
  if (sourceEvents.length !== 2
      || sourceEvents[0].event_kind !== 'TARGET_ACQUISITION'
      || sourceEvents[1].event_kind !== 'TARGET_DISPOSAL') {
    fail('position_economic_controlled_population_invalid', 'controlled round trip requires one acquisition followed by one disposal');
  }
  return sourceEvents;
}

function economicEvidenceResponse(context, exactQuoteMint, reconstructed, sourceEvents) {
  const roles = new Map();
  for (const event of sourceEvents) {
    const locator = {
      transaction_signature: event.transaction_signature,
      authoritative_intra_transaction_coordinate: event.authoritative_intra_transaction_coordinate,
      event_kind: event.event_kind,
    };
    for (const id of event.source_effect_ids) roles.set(id, { disposition: 'PRIMARY', event_locator: locator, reason_code: null });
    for (const id of event.corroborating_effect_ids) roles.set(id, { disposition: 'CORROBORATING', event_locator: locator, reason_code: null });
  }
  const allEffectIds = reconstructed.flatMap(({ effect }) => effect.established_effects.map(item => item.effect_id)).sort();
  if (roles.size !== sourceEvents.length * 4 || [...roles.keys()].some(id => !allEffectIds.includes(id))) {
    fail('position_economic_effect_disposition_invalid', 'economic effect roles are not unique and source-bound');
  }
  const response = {
    economic_evidence_profile: 'ARTIFACT_AUTHORITATIVE_POSITION_ECONOMIC_EFFECTS_V1',
    evidence_context_digest: context.evidence_context_digest,
    exact_quote_mint: exactQuoteMint,
    opening_basis_evidence: null,
    source_events: sourceEvents,
    effect_dispositions: allEffectIds.map(effectId => ({
      effect_id: effectId,
      ...(roles.get(effectId) ?? {
        disposition: 'NON_ECONOMIC', event_locator: null, reason_code: 'NO_POSITION_ECONOMIC_EFFECT',
      }),
    })),
    economic_evidence_digest: null,
  };
  response.economic_evidence_digest = sha256CanonicalJson(Object.fromEntries(
    Object.entries(response).filter(([field]) => field !== 'economic_evidence_digest'),
  ));
  return response;
}

export function isProductionPositionEconomicEvidencePortV13(port) {
  return (port !== null && (typeof port === 'object' || typeof port === 'function'))
    ? PRODUCTION_PORTS.has(port) : false;
}

export async function createProductionPositionEconomicEvidencePortV13(input) {
  const inputDescriptors = exactCapabilityShell(
    input, INPUT_FIELDS, 'production_position_economic_evidence_bridge_input',
  );
  const context = inputDescriptors.evidence_context.value;
  const contextAuthority = inputDescriptors.context_authority.value;
  const exactQuoteMint = inputDescriptors.exact_quote_mint.value;
  validateAuthoritativeEvidenceContextStructureV13(context);
  const authorityDescriptors = exactCapabilityShell(
    contextAuthority,
    CONTEXT_AUTHORITY_FIELDS,
    'production_position_economic_evidence_context_authority',
  );
  if (!isSolanaPublicKeyV1(exactQuoteMint)
      || exactQuoteMint !== USDC_MINT || context.target_mint === exactQuoteMint) {
    fail(
      'position_economic_quote_profile_unsupported',
      'production bridge requires classic USDC as the sole quote mint',
    );
  }
  await validateSourceBoundAuthoritativeEvidenceContextV13({
    context,
    ...Object.fromEntries(CONTEXT_AUTHORITY_FIELDS.map(field => [field, authorityDescriptors[field].value])),
  });
  requireControlledBoundary(context);
  const rows = [...context.transaction_population.transactions]
    .sort((left, right) => left.canonical_transaction_coordinate - right.canonical_transaction_coordinate);
  if (rows.length !== 2 || rows.some((row, index) => row.canonical_transaction_coordinate !== index)) {
    fail(
      'position_economic_controlled_population_invalid',
      'production bridge requires exactly two canonical transactions',
    );
  }
  const reconstructed = rows.map(row => ({
    row,
    effect: projectSolanaFullTransactionEffectV13({
      wallet: context.analyzed_wallet,
      transaction: row.full_transaction,
    }),
  }));
  if (reconstructed.some(item => item.effect.residual_unresolved_effects.length !== 0)) {
    fail(
      'position_economic_residual_evidence',
      'production bridge refuses every residual-bearing Slice 2 population',
    );
  }
  requireNarrowEffectPopulation(reconstructed, context, exactQuoteMint);
  const sourceEvents = requireSameOperationAuthority(reconstructed, context.target_mint, exactQuoteMint);
  const response = economicEvidenceResponse(context, exactQuoteMint, reconstructed, sourceEvents);
  const expectedRequest = {
    economic_evidence_profile: 'ARTIFACT_AUTHORITATIVE_POSITION_ECONOMIC_EFFECTS_V1',
    evidence_context_digest: context.evidence_context_digest,
    analyzed_wallet: context.analyzed_wallet,
    target_mint: context.target_mint,
    exact_quote_mint: exactQuoteMint,
  };
  const port = createPositionEconomicEvidencePortV13({
    async captureAuthoritativePositionEconomicsV13(request) {
      if (canonicalJson(request) !== canonicalJson(expectedRequest)) {
        fail('position_economic_evidence_scope_mismatch', 'production evidence request does not match its bound context');
      }
      await validateSourceBoundAuthoritativeEvidenceContextV13({
        context,
        ...Object.fromEntries(CONTEXT_AUTHORITY_FIELDS.map(
          field => [field, authorityDescriptors[field].value],
        )),
      });
      return response;
    },
  });
  PRODUCTION_PORTS.set(port, CONTROLLED_CLASSIC_SPL_USDC_POSITION_ECONOMIC_BRIDGE_PROFILE_V1);
  return port;
}
