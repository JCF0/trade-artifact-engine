#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { createWalletHistoryPortV2 } from '../wallet-acquisition/provider-port-v2.mjs';
import { acquireWalletHistoryV2 } from '../wallet-acquisition/orchestrator.mjs';
import {
  DETACHED_RETAINED_FULL_TRANSACTIONS_V1, offlineFullTransactionHistoryFixtureV2,
} from '../wallet-acquisition/fixtures/retained-full-transaction-fixtures.mjs';
import {
  JUP_MINT_V1, JUP_WALLET_V1, USDC_MINT_V1, USDT_MINT_V1,
} from '../wallet-acquisition/fixtures/retained-provider-fixtures.mjs';
import { providerPublicKey } from '../wallet-acquisition/fixtures/test-identities.mjs';
import {
  createTargetAccountEnumerationPortV1,
} from '../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import { createEvidenceContextTranscriptPortV1 } from '../wallet-acquisition/evidence-context-sidecar-v1.mjs';
import { buildSourceBoundAuthoritativeEvidenceContextV13 } from './authoritative-evidence-context.mjs';
import { projectSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import { makeRational } from './rational.mjs';
import { sha256CanonicalJson } from './contract.mjs';
import {
  POSITION_EPISODE_VERSION_V1_3,
  buildPositionEpisodeV13,
  createPositionEconomicEvidencePortV13,
  validateSourceBoundPositionEpisodeV13,
  validatePositionEpisodeStructureV13,
} from './position-episode.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TARGET_ACCOUNT = providerPublicKey('slice4-position-target-account');
const BASIS_DIGEST = 'a'.repeat(64);
const dependency = character => character.repeat(64);

function account(rawAmount) {
  return {
    account: TARGET_ACCOUNT, account_program: TOKEN_PROGRAM, lamports: '2039280', executable: false,
    rent_epoch: '0', raw_account_data: { encoding: 'base64', bytes: 'AQIDBA==' },
    normalized_state_profile: 'CAPABILITY_ATTESTED_TOKEN_ACCOUNT_STATE_V1',
    token_state: {
      mint: JUP_MINT_V1, token_authority: JUP_WALLET_V1, raw_amount: rawAmount, decimals: 6,
      delegate_status: 'NONE', delegate: null, delegated_raw_amount: '0',
      close_authority_status: 'NONE', close_authority: null,
      lifecycle_state: 'EXISTS', account_state: 'INITIALIZED',
    },
  };
}
function enumerationPort(slot, rawAmount) {
  return createTargetAccountEnumerationPortV1({
    async enumerateTargetAccountsByProgramV1({ token_program }) {
      return { context: { slot }, accounts: token_program === TOKEN_PROGRAM && rawAmount !== '0' ? [account(rawAmount)] : [] };
    },
  });
}
async function authorityFixture(openingRaw = '0', endingRaw = '0', basisEvidence = null) {
  const offline = offlineFullTransactionHistoryFixtureV2({
    wallet: JUP_WALLET_V1, retainedBodyNames: ['jup_buy_full', 'jup_sell_full'],
  });
  const legacyAcquisitionResult = await acquireWalletHistoryV2(offline.request, {
    walletHistoryPort: createWalletHistoryPortV2(offline.port, { beginAcquisitionV2() {} }),
  });
  const fullTransactions = [
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_buy_full,
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_sell_full,
  ].sort((left, right) => right.slot - left.slot || right.block_time - left.block_time);
  const transcriptPort = createEvidenceContextTranscriptPortV1({
    async getAuthoritativeTransactionTranscriptV1() {
      return {
        authoritative_population: fullTransactions.map(({ signature, slot, block_time, execution_state }) => ({
          signature, slot, block_time, execution_state,
        })),
        full_transactions: fullTransactions,
      };
    },
  });
  const evidenceContext = await buildSourceBoundAuthoritativeEvidenceContextV13({
    transaction_transcript_port: transcriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
    opening_enumeration_port: enumerationPort(fullTransactions.at(-1).slot - 1, openingRaw),
    ending_enumeration_port: enumerationPort(fullTransactions[0].slot + 1, endingRaw),
    target_mint: JUP_MINT_V1,
    opening_basis_reference: openingRaw === '0' ? null : {
      basis_evidence_profile: 'ARTIFACT_OPENING_BASIS_EVIDENCE_V1',
      basis_evidence_digest: basisEvidence?.basis_evidence_digest ?? BASIS_DIGEST,
    },
  });
  const effects = new Map(evidenceContext.transaction_population.transactions.map(item => [
    item.canonical_transaction_coordinate,
    projectSolanaFullTransactionEffectV13({ wallet: JUP_WALLET_V1, transaction: item.full_transaction }),
  ]));
  return { evidenceContext, effects };
}
function refs(effect, count = 1) {
  return effect.established_effects.slice(0, count).map(item => item.effect_id).sort();
}
function sourceEvent({ signature, coordinate, kind, payload, sourceEffectIds, dependencies = [] }) {
  return {
    transaction_signature: signature,
    authoritative_intra_transaction_coordinate: coordinate,
    event_kind: kind,
    payload,
    source_effect_ids: sourceEffectIds,
    corroborating_effect_ids: [],
    dependency_references: dependencies,
  };
}
function sourceAt(fixture, txCoordinate, values) {
  const effect = fixture.effects.get(txCoordinate);
  return sourceEvent({ signature: effect.transaction_identity.signature, sourceEffectIds: refs(effect), ...values });
}
function openingBasis(amount) {
  const evidence = {
    basis_evidence_profile: 'ARTIFACT_OPENING_BASIS_EVIDENCE_V1',
    analyzed_wallet: JUP_WALLET_V1,
    target_mint: JUP_MINT_V1,
    exact_quote_mint: USDC_MINT_V1,
    attributable_basis: makeRational(amount),
    source_references: [dependency('b')],
    basis_evidence_digest: null,
  };
  evidence.basis_evidence_digest = sha256CanonicalJson(Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'basis_evidence_digest'),
  ));
  return evidence;
}
function buildInput(fixture, events, basisEvidence = null, quoteMint = USDC_MINT_V1, alterEvidence = value => value) {
  const eventByEffect = new Map();
  for (const event of events) {
    const locator = {
      transaction_signature: event.transaction_signature,
      authoritative_intra_transaction_coordinate: event.authoritative_intra_transaction_coordinate,
      event_kind: event.event_kind,
    };
    event.source_effect_ids.forEach(effectId => eventByEffect.set(effectId, { disposition: 'PRIMARY', event_locator: locator, reason_code: null }));
    event.corroborating_effect_ids.forEach(effectId => eventByEffect.set(effectId, { disposition: 'CORROBORATING', event_locator: locator, reason_code: null }));
  }
  const allEffectIds = [...fixture.effects.values()].flatMap(effect => [
    ...effect.established_effects.map(item => item.effect_id),
    ...effect.residual_unresolved_effects.map(item => item.residual_id),
  ]).sort();
  const effectDispositions = allEffectIds.map(effectId => ({
    effect_id: effectId,
    ...(eventByEffect.get(effectId) ?? {
      disposition: 'NON_ECONOMIC', event_locator: null, reason_code: 'NO_POSITION_ECONOMIC_EFFECT',
    }),
  }));
  const evidence = {
    economic_evidence_profile: 'ARTIFACT_AUTHORITATIVE_POSITION_ECONOMIC_EFFECTS_V1',
    evidence_context_digest: fixture.evidenceContext.evidence_context_digest,
    exact_quote_mint: quoteMint,
    opening_basis_evidence: basisEvidence,
    source_events: events,
    effect_dispositions: effectDispositions,
    economic_evidence_digest: null,
  };
  evidence.economic_evidence_digest = sha256CanonicalJson(Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'economic_evidence_digest'),
  ));
  const deliveredEvidence = alterEvidence(structuredClone(evidence));
  return {
    evidence_context: fixture.evidenceContext,
    exact_quote_mint: quoteMint,
    economic_evidence_port: createPositionEconomicEvidencePortV13({
      async captureAuthoritativePositionEconomicsV13() { return deliveredEvidence; },
    }),
  };
}

function rehashEconomicEvidence(evidence) {
  evidence.economic_evidence_digest = sha256CanonicalJson(Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'economic_evidence_digest'),
  ));
  return evidence;
}

function trade(fixture, txCoordinate, kind, target, quote, coordinate = 0, quoteMint = USDC_MINT_V1) {
  return sourceAt(fixture, txCoordinate, {
    coordinate, kind,
    payload: { target_raw_quantity: target, quote_status: 'EXACT', quote_mint: quoteMint, quote_raw_amount: quote },
  });
}

test('exact WAC closes a clean buy and sell with immutable exact economics', async () => {
  const fixture = await authorityFixture('0', '0');
  const built = await buildPositionEpisodeV13(buildInput(fixture, [
    trade(fixture, 1, 'TARGET_DISPOSAL', '10', '30'),
    trade(fixture, 0, 'TARGET_ACQUISITION', '10', '20'),
  ]));

  assert.equal(built.position_episode_version, POSITION_EPISODE_VERSION_V1_3);
  assert.equal(built.position_state, 'CLOSED');
  assert.deepEqual(built.realized_basis_consumed, makeRational('20'));
  assert.deepEqual(built.recognized_disposal_proceeds, makeRational('30'));
  assert.deepEqual(built.realized_pnl, makeRational('10'));
  assert.deepEqual(built.realized_return, makeRational('1', '2'));
  assert.deepEqual(built.remaining_attributable_basis, makeRational('0'));
  assert.equal(built.ending_economic_inventory, '0');
  assert.equal(validatePositionEpisodeStructureV13(built), true);
  assert.equal(built.position_episode_digest, 'd61e10cb7b66f364a21d3af89e22e7761ab26965dad41b0fa10019ddb1f77291');
  assert.equal(sha256CanonicalJson(built), '7481f677874e5cddf66f4d2d5953222168c3968c4c17e640f603bf0aa5af7ad9');
  assert.ok(Object.isFrozen(built.ordered_admitted_economic_events[0].basis_after));
});

test('positive opening inventory requires and consumes its bound exact basis reference', async () => {
  const basisEvidence = openingBasis('20');
  const fixture = await authorityFixture('10', '0', basisEvidence);
  const built = await buildPositionEpisodeV13(buildInput(
    fixture,
    [trade(fixture, 0, 'TARGET_DISPOSAL', '10', '30')],
    basisEvidence,
  ));
  assert.deepEqual(built.opening_attributable_basis, makeRational('20'));
  assert.deepEqual(built.realized_basis_consumed, makeRational('20'));
  assert.deepEqual(built.realized_pnl, makeRational('10'));
  assert.equal(built.position_state, 'CLOSED');
});

test('each disposal consumes the WAC immediately before it and later acquisitions cannot alter prior basis', async () => {
  const fixture = await authorityFixture('0', '10');
  const first = sourceAt(fixture, 0, {
    coordinate: 0, kind: 'TARGET_ACQUISITION', sourceEffectIds: refs(fixture.effects.get(0), 1),
    payload: { target_raw_quantity: '10', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '20' },
  });
  const disposal = sourceAt(fixture, 0, {
    coordinate: 1, kind: 'TARGET_DISPOSAL', sourceEffectIds: refs(fixture.effects.get(0), 2).slice(1),
    payload: { target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '15' },
  });
  const later = sourceAt(fixture, 1, {
    coordinate: 0, kind: 'TARGET_ACQUISITION', sourceEffectIds: refs(fixture.effects.get(1), 1),
    payload: { target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '40' },
  });
  const built = await buildPositionEpisodeV13(buildInput(fixture, [later, disposal, first]));
  const projectedDisposal = built.ordered_admitted_economic_events.find(event => event.event_kind === 'TARGET_DISPOSAL');
  assert.deepEqual(projectedDisposal.basis_consumed, makeRational('10'));
  assert.deepEqual(built.remaining_attributable_basis, makeRational('50'));
  assert.equal(built.position_state, 'OPEN_REALIZED_PARTIAL');
});

test('one raw unit is open and no dust threshold or display rounding is applied', async () => {
  const fixture = await authorityFixture('0', '1');
  const built = await buildPositionEpisodeV13(buildInput(fixture, [trade(fixture, 0, 'TARGET_ACQUISITION', '1', '3')]));
  assert.equal(built.ending_economic_inventory, '1');
  assert.equal(built.position_state, 'OPEN');
  assert.deepEqual(built.remaining_attributable_basis, makeRational('3'));
});

test('oversell fails closed instead of splitting an accounted and unaccounted portion', async () => {
  const fixture = await authorityFixture('0', '0');
  await assert.rejects(
    () => buildPositionEpisodeV13(buildInput(fixture, [trade(fixture, 1, 'TARGET_DISPOSAL', '1', '2')])),
    error => error.code === 'OVERSOLD_ESTABLISHED_INVENTORY',
  );
});

test('zero realized basis uses the authoritative UNDEFINED_ZERO_BASIS sentinel', async () => {
  const fixture = await authorityFixture('0', '0');
  const transfer = sourceAt(fixture, 0, {
    coordinate: 0, kind: 'TARGET_TRANSFER_IN',
    payload: { target_raw_quantity: '4', basis_status: 'KNOWN', attributable_basis: makeRational('0') },
  });
  const disposal = trade(fixture, 1, 'TARGET_DISPOSAL', '4', '8');
  const built = await buildPositionEpisodeV13(buildInput(fixture, [transfer, disposal]));
  assert.equal(built.realized_return, 'UNDEFINED_ZERO_BASIS');
  assert.deepEqual(built.realized_pnl, makeRational('8'));
});

test('mixed exact quote mints remain unresolved and are never combined', async () => {
  const fixture = await authorityFixture('0', '0');
  const built = await buildPositionEpisodeV13(buildInput(fixture, [
    trade(fixture, 0, 'TARGET_ACQUISITION', '5', '10'),
    trade(fixture, 1, 'TARGET_DISPOSAL', '5', '20', 0, USDT_MINT_V1),
  ]));
  assert.equal(built.recognized_disposal_proceeds, null);
  assert.equal(built.realized_pnl, null);
  assert.ok(built.unresolved_economic_dependencies.some(item => item.dependency_code === 'MIXED_QUOTE_UNSUPPORTED'));
  assert.equal(built.position_state, 'CLOSED');
});

test('unresolved quote and shared quote fee dependencies remain economic nulls, not claim outcomes', async () => {
  const unresolvedFixture = await authorityFixture('0', '5');
  const unresolvedAcquisition = sourceAt(unresolvedFixture, 0, {
    coordinate: 0, kind: 'TARGET_ACQUISITION', dependencies: [dependency('5')],
    payload: { target_raw_quantity: '5', quote_status: 'UNRESOLVED', quote_mint: null, quote_raw_amount: null },
  });
  const unresolved = await buildPositionEpisodeV13(buildInput(unresolvedFixture, [unresolvedAcquisition]));
  assert.equal(unresolved.aggregate_acquisition_basis, null);
  assert.equal(unresolved.remaining_attributable_basis, null);
  assert.equal(unresolved.position_state, 'OPEN');
  assert.equal(Object.hasOwn(unresolved, 'claim_outcome'), false);

  const sharedFixture = await authorityFixture('0', '5');
  const effectRefs = refs(sharedFixture.effects.get(0), 2);
  const acquisition = sourceAt(sharedFixture, 0, {
    coordinate: 0, kind: 'TARGET_ACQUISITION', sourceEffectIds: [effectRefs[0]],
    payload: { target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '10' },
  });
  const sharedFee = sourceAt(sharedFixture, 0, {
    coordinate: 1, kind: 'FEE', sourceEffectIds: [effectRefs[1]], dependencies: [dependency('6')],
    payload: {
      denomination_kind: 'TOKEN_MINT', denomination_mint: USDC_MINT_V1, raw_fee_amount: '1',
      allocation_status: 'UNALLOCATED_SHARED', attributed_event_locator: null,
    },
  });
  const shared = await buildPositionEpisodeV13(buildInput(sharedFixture, [acquisition, sharedFee]));
  assert.equal(shared.aggregate_acquisition_basis, null);
  assert.equal(shared.remaining_attributable_basis, null);
  assert.ok(shared.unresolved_economic_dependencies.some(
    item => item.dependency_code === 'SHARED_EFFECT_ALLOCATION_UNRESOLVED',
  ));
});

test('unknown-basis contamination clears only at genuine economic zero and never reconstructs prior realized economics', async () => {
  const fixture = await authorityFixture('10', '5');
  const disposal = trade(fixture, 0, 'TARGET_DISPOSAL', '10', '30');
  const acquisition = trade(fixture, 1, 'TARGET_ACQUISITION', '5', '20');
  const built = await buildPositionEpisodeV13(buildInput(fixture, [disposal, acquisition]));

  assert.equal(built.opening_attributable_basis, null);
  assert.equal(built.realized_basis_consumed, null);
  assert.equal(built.realized_pnl, null);
  assert.deepEqual(built.remaining_attributable_basis, makeRational('20'));
  assert.equal(built.ending_economic_inventory, '5');
  assert.equal(built.position_state, 'OPEN_REALIZED_PARTIAL');
  const projectedDisposal = built.ordered_admitted_economic_events[0];
  assert.deepEqual(projectedDisposal.basis_after, makeRational('0'));
  assert.equal(projectedDisposal.genuine_economic_zero_after, true);
});

test('temporary intra-transaction zero does not clear unknown-basis contamination', async () => {
  const fixture = await authorityFixture('10', '5');
  const effect = fixture.effects.get(0);
  const firstTwoRefs = refs(effect, 2);
  const disposal = sourceAt(fixture, 0, {
    coordinate: 0, kind: 'TARGET_DISPOSAL', sourceEffectIds: [firstTwoRefs[0]],
    payload: { target_raw_quantity: '10', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '30' },
  });
  const acquisition = sourceAt(fixture, 0, {
    coordinate: 1, kind: 'TARGET_ACQUISITION', sourceEffectIds: [firstTwoRefs[1]],
    payload: { target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '20' },
  });
  const built = await buildPositionEpisodeV13(buildInput(fixture, [acquisition, disposal]));

  assert.equal(built.ordered_admitted_economic_events[0].genuine_economic_zero_after, false);
  assert.equal(built.ordered_admitted_economic_events[0].basis_after, null);
  assert.equal(built.remaining_attributable_basis, null);
  assert.equal(built.realized_basis_consumed, null);
  assert.equal(built.position_state, 'OPEN_REALIZED_PARTIAL');
});

test('custody zero, transfer-out, closure, and unresolved continuation cannot clear contamination', async () => {
  const fixture = await authorityFixture('10', '0');
  const transferOut = sourceAt(fixture, 0, {
    coordinate: 0, kind: 'TARGET_TRANSFER_OUT', dependencies: [dependency('1')],
    payload: { target_raw_quantity: '10', external_continuation_status: 'UNRESOLVED' },
  });
  const closure = sourceAt(fixture, 1, {
    coordinate: 0, kind: 'TARGET_ACCOUNT_LIFECYCLE',
    payload: { lifecycle_action: 'CLOSE', account: TARGET_ACCOUNT },
  });
  const built = await buildPositionEpisodeV13(buildInput(fixture, [transferOut, closure]));
  assert.equal(built.ending_wallet_custody, '0');
  assert.equal(built.ending_economic_inventory, null);
  assert.equal(built.remaining_attributable_basis, null);
  assert.equal(built.position_state, null);
  assert.ok(built.unresolved_economic_dependencies.some(item => item.dependency_code === 'TARGET_TRANSFER_EXTERNAL_CONTINUATION'));
  assert.ok(built.ordered_admitted_economic_events.every(event => event.genuine_economic_zero_after === false));
});

test('known-basis transfer-in participates in WAC while transfer-out creates no proceeds or PnL', async () => {
  const fixture = await authorityFixture('0', '0');
  const transferIn = sourceAt(fixture, 0, {
    coordinate: 0, kind: 'TARGET_TRANSFER_IN',
    payload: { target_raw_quantity: '7', basis_status: 'KNOWN', attributable_basis: makeRational('14') },
  });
  const transferOut = sourceAt(fixture, 1, {
    coordinate: 0, kind: 'TARGET_TRANSFER_OUT',
    payload: { target_raw_quantity: '7', external_continuation_status: 'CONTINUING' },
  });
  const built = await buildPositionEpisodeV13(buildInput(fixture, [transferIn, transferOut]));
  assert.deepEqual(built.recognized_disposal_proceeds, makeRational('0'));
  assert.deepEqual(built.realized_basis_consumed, makeRational('0'));
  assert.deepEqual(built.realized_pnl, makeRational('0'));
  assert.equal(built.ending_economic_inventory, '7');
  assert.equal(built.ending_wallet_custody, '0');
  assert.equal(built.position_state, 'OPEN');
});

test('quote fees apply exactly once when uniquely allocated and non-quote fees remain disclosure-only', async () => {
  const fixture = await authorityFixture('0', '10');
  const acquisition = sourceAt(fixture, 0, {
    coordinate: 0, kind: 'TARGET_ACQUISITION', sourceEffectIds: refs(fixture.effects.get(0), 1),
    payload: { target_raw_quantity: '10', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '20' },
  });
  const fee = sourceAt(fixture, 0, {
    coordinate: 1, kind: 'FEE', sourceEffectIds: refs(fixture.effects.get(0), 2).slice(1),
    payload: {
      denomination_kind: 'TOKEN_MINT', denomination_mint: USDC_MINT_V1, raw_fee_amount: '2',
      allocation_status: 'ACQUISITION',
      attributed_event_locator: {
        transaction_signature: fixture.effects.get(0).transaction_identity.signature,
        authoritative_intra_transaction_coordinate: 0, event_kind: 'TARGET_ACQUISITION',
      },
    },
  });
  const nonQuote = sourceAt(fixture, 1, {
    coordinate: 0, kind: 'FEE',
    payload: {
      denomination_kind: 'TOKEN_MINT', denomination_mint: USDT_MINT_V1, raw_fee_amount: '99',
      allocation_status: 'NON_QUOTE_DISCLOSURE', attributed_event_locator: null,
    },
  });
  const built = await buildPositionEpisodeV13(buildInput(fixture, [nonQuote, fee, acquisition]));
  assert.deepEqual(built.aggregate_acquisition_basis, makeRational('22'));
  assert.deepEqual(built.remaining_attributable_basis, makeRational('22'));
  assert.equal(built.fee_treatment.length, 2);
});

test('projection identity, totals, and order reject caller mutation and remain input-detached', async () => {
  const fixture = await authorityFixture('0', '1');
  const events = [trade(fixture, 0, 'TARGET_ACQUISITION', '1', '2')];
  const built = await buildPositionEpisodeV13(buildInput(fixture, events));
  events[0].payload.target_raw_quantity = '999';
  assert.equal(built.ending_economic_inventory, '1');

  const forged = structuredClone(built);
  forged.remaining_attributable_basis = makeRational('999');
  assert.throws(() => validatePositionEpisodeStructureV13(forged), error => error.code === 'position_episode_digest_mismatch');
});

test('episode construction requires a registered recapturable authority port, not caller event arrays', async () => {
  const fixture = await authorityFixture('0', '0');
  await assert.rejects(
    () => buildPositionEpisodeV13({
      evidence_context: fixture.evidenceContext,
      exact_quote_mint: USDC_MINT_V1,
      authoritative_economic_events: [],
      opening_basis_evidence: null,
    }),
    error => error.code === 'unknown_field',
  );
  await assert.rejects(
    () => buildPositionEpisodeV13({
      evidence_context: fixture.evidenceContext,
      exact_quote_mint: USDC_MINT_V1,
      economic_evidence_port: {
        async captureAuthoritativePositionEconomicsV13() { return {}; },
      },
    }),
    error => error.code === 'position_economic_evidence_capability_denied',
  );
});

test('authority response must exhaust every effect and opening basis digest must bind its rational', async () => {
  const zeroFixture = await authorityFixture('0', '0');
  await assert.rejects(
    () => buildPositionEpisodeV13(buildInput(zeroFixture, [], null, USDC_MINT_V1, evidence => {
      evidence.effect_dispositions.pop();
      return rehashEconomicEvidence(evidence);
    })),
    error => error.code === 'incomplete_effect_disposition',
  );

  const basisEvidence = openingBasis('20');
  const positiveFixture = await authorityFixture('10', '0', basisEvidence);
  await assert.rejects(
    () => buildPositionEpisodeV13(buildInput(
      positiveFixture,
      [trade(positiveFixture, 0, 'TARGET_DISPOSAL', '10', '30')],
      basisEvidence,
      USDC_MINT_V1,
      evidence => {
        evidence.opening_basis_evidence.attributable_basis = makeRational('999');
        return rehashEconomicEvidence(evidence);
      },
    )),
    error => error.code === 'opening_basis_digest_mismatch',
  );
});

test('source-bound validation reconstructs economics and rejects a self-rehashed structural forgery', async () => {
  const fixture = await authorityFixture('0', '1');
  const input = buildInput(fixture, [trade(fixture, 0, 'TARGET_ACQUISITION', '1', '2')]);
  const built = await buildPositionEpisodeV13(input);
  const forged = structuredClone(built);
  forged.remaining_attributable_basis = makeRational('999');
  const preimage = structuredClone(forged);
  delete preimage.episode_id;
  delete preimage.position_episode_digest;
  forged.position_episode_digest = sha256CanonicalJson(preimage);
  forged.episode_id = `position-episode-${forged.position_episode_digest}`;
  assert.equal(validatePositionEpisodeStructureV13(forged), true);
  await assert.rejects(
    () => validateSourceBoundPositionEpisodeV13({ episode: forged, ...input }),
    error => error.code === 'position_episode_source_mismatch',
  );
});
