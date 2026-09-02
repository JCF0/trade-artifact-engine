#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { createWalletHistoryPortV2 } from '../wallet-acquisition/provider-port-v2.mjs';
import { acquireWalletHistoryV2 } from '../wallet-acquisition/orchestrator.mjs';
import {
  DETACHED_RETAINED_FULL_TRANSACTIONS_V1, offlineFullTransactionHistoryFixtureV2,
} from '../wallet-acquisition/fixtures/retained-full-transaction-fixtures.mjs';
import {
  JUP_MINT_V1, JUP_WALLET_V1, USDC_MINT_V1,
} from '../wallet-acquisition/fixtures/retained-provider-fixtures.mjs';
import { providerPublicKey } from '../wallet-acquisition/fixtures/test-identities.mjs';
import { createTargetAccountEnumerationPortV1 } from '../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import { createEvidenceContextTranscriptPortV1 } from '../wallet-acquisition/evidence-context-sidecar-v1.mjs';
import { buildSourceBoundAuthoritativeEvidenceContextV13 } from './authoritative-evidence-context.mjs';
import { projectSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import { makeRational } from './rational.mjs';
import { sha256CanonicalJson } from './contract.mjs';
import {
  buildPositionEpisodeV13, createPositionEconomicEvidencePortV13,
} from './position-episode.mjs';
import {
  CLAIM_EVALUATION_FIELDS,
  CLAIM_EVALUATION_ID_PREFIX,
  CLAIM_EVALUATION_VERSION,
  claimEvaluationDigestPreimage,
  computeClaimEvaluationScopeDigestV13,
  evaluateClaimOutcomeV13,
  validateClaimEvaluationStructureV13,
  validateSourceBoundClaimEvaluationV13,
} from './claim-outcome-evaluator.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TARGET_ACCOUNT = providerPublicKey('slice5-position-target-account');
const D = char => char.repeat(64);

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
async function authorityFixture(openingRaw = '0', endingRaw = '0', mutateFullTransactions = null) {
  const offline = offlineFullTransactionHistoryFixtureV2({
    wallet: JUP_WALLET_V1, retainedBodyNames: ['jup_buy_full', 'jup_sell_full'],
  });
  const legacyAcquisitionResult = await acquireWalletHistoryV2(offline.request, {
    walletHistoryPort: createWalletHistoryPortV2(offline.port, { beginAcquisitionV2() {} }),
  });
  const fullTransactions = structuredClone([
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_buy_full,
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_sell_full,
  ]).sort((left, right) => right.slot - left.slot || right.block_time - left.block_time);
  if (mutateFullTransactions !== null) mutateFullTransactions(fullTransactions);
  const transactionTranscriptPort = createEvidenceContextTranscriptPortV1({
    async getAuthoritativeTransactionTranscriptV1() {
      return {
        authoritative_population: fullTransactions.map(({ signature, slot, block_time, execution_state }) => ({ signature, slot, block_time, execution_state })),
        full_transactions: fullTransactions,
      };
    },
  });
  const openingEnumerationPort = enumerationPort(fullTransactions.at(-1).slot - 1, openingRaw);
  const endingEnumerationPort = enumerationPort(fullTransactions[0].slot + 1, endingRaw);
  const contextAuthority = {
    transaction_transcript_port: transactionTranscriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
    opening_enumeration_port: openingEnumerationPort,
    ending_enumeration_port: endingEnumerationPort,
    target_mint: JUP_MINT_V1,
    opening_basis_reference: null,
  };
  const evidenceContext = await buildSourceBoundAuthoritativeEvidenceContextV13(contextAuthority);
  const effects = new Map(evidenceContext.transaction_population.transactions.map(item => [
    item.canonical_transaction_coordinate,
    projectSolanaFullTransactionEffectV13({ wallet: JUP_WALLET_V1, transaction: item.full_transaction }),
  ]));
  return { evidenceContext, contextAuthority, effects };
}
function refs(effect, count = 1) { return effect.established_effects.slice(0, count).map(item => item.effect_id).sort(); }
function allEstablishedRefs(effect) { return effect.established_effects.map(item => item.effect_id).sort(); }
function sourceAt(fixture, txCoordinate, { coordinate, kind, payload, sourceEffectIds = refs(fixture.effects.get(txCoordinate)), dependencies = [] }) {
  const effect = fixture.effects.get(txCoordinate);
  return {
    transaction_signature: effect.transaction_identity.signature,
    authoritative_intra_transaction_coordinate: coordinate,
    event_kind: kind,
    payload,
    source_effect_ids: sourceEffectIds,
    corroborating_effect_ids: [],
    dependency_references: dependencies,
  };
}
function trade(fixture, txCoordinate, kind, target, quote, consumeAllEstablishedEffects = false) {
  return sourceAt(fixture, txCoordinate, {
    coordinate: 0, kind, sourceEffectIds: consumeAllEstablishedEffects ? allEstablishedRefs(fixture.effects.get(txCoordinate)) : undefined,
    payload: { target_raw_quantity: target, quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: quote },
  });
}
function positionInput(fixture, events) {
  const eventByEffect = new Map();
  for (const event of events) {
    const locator = {
      transaction_signature: event.transaction_signature,
      authoritative_intra_transaction_coordinate: event.authoritative_intra_transaction_coordinate,
      event_kind: event.event_kind,
    };
    for (const effectId of event.source_effect_ids) eventByEffect.set(effectId, { disposition: 'PRIMARY', event_locator: locator, reason_code: null });
  }
  const allEffectIds = [...fixture.effects.values()].flatMap(effect => [
    ...effect.established_effects.map(item => item.effect_id),
    ...effect.residual_unresolved_effects.map(item => item.residual_id),
  ]).sort();
  const evidence = {
    economic_evidence_profile: 'ARTIFACT_AUTHORITATIVE_POSITION_ECONOMIC_EFFECTS_V1',
    evidence_context_digest: fixture.evidenceContext.evidence_context_digest,
    exact_quote_mint: USDC_MINT_V1,
    opening_basis_evidence: null,
    source_events: events,
    effect_dispositions: allEffectIds.map(effectId => ({ effect_id: effectId, ...(eventByEffect.get(effectId) ?? { disposition: 'NON_ECONOMIC', event_locator: null, reason_code: 'NO_POSITION_ECONOMIC_EFFECT' }) })),
    economic_evidence_digest: null,
  };
  evidence.economic_evidence_digest = sha256CanonicalJson(Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'economic_evidence_digest')));
  const economicEvidencePort = createPositionEconomicEvidencePortV13({
    async captureAuthoritativePositionEconomicsV13() { return structuredClone(evidence); },
  });
  return { evidence_context: fixture.evidenceContext, exact_quote_mint: USDC_MINT_V1, economic_evidence_port: economicEvidencePort };
}
async function positionSource(fixture, events) {
  const input = positionInput(fixture, events);
  const episode = await buildPositionEpisodeV13(input);
  return { context: fixture.evidenceContext, context_authority: fixture.contextAuthority, episode, exact_quote_mint: USDC_MINT_V1, economic_evidence_port: input.economic_evidence_port };
}
function requestFor(claimType, scopeDigest, requested = true) {
  const profiles = { TRANSACTION_EFFECT: 'TRANSACTION_EFFECT_V1', POSITION_EPISODE: 'POSITION_ECONOMICS_V1', WALLET_WINDOW: 'WALLET_EFFECT_COVERAGE_V1' };
  return { claim_type: claimType, claim_profile: profiles[claimType], requested, scope_digest: scopeDigest };
}

async function evaluateRequested(claimType, source) {
  const scopeDigest = computeClaimEvaluationScopeDigestV13({ claim_type: claimType, source });
  const request = requestFor(claimType, scopeDigest);
  return { request, evaluation: await evaluateClaimOutcomeV13({ request, source }) };
}

test('unrequested companion is immutable status-only and requested caller cannot choose NOT_EVALUATED', async () => {
  const request = requestFor('WALLET_WINDOW', D('a'), false);
  const evaluation = await evaluateClaimOutcomeV13({ request, source: null });
  assert.equal(evaluation.claim_outcome, 'NOT_EVALUATED');
  assert.equal(evaluation.result_profile, null);
  assert.equal(evaluation.position_state, null);
  assert.deepEqual(evaluation.requested_field_set, []);
  assert.equal(evaluation.supporting_profiles, null);
  assert.deepEqual(evaluation.authoritative_evidence_identities, []);
  assert.deepEqual(evaluation.field_availability, []);
  assert.deepEqual(evaluation.established_fields, []);
  assert.deepEqual(evaluation.unresolved_dependencies, []);
  assert.deepEqual(evaluation.non_interference_decisions, []);
  assert.deepEqual(evaluation.reason_codes, []);
  assert.equal(Object.isFrozen(evaluation), true);
  assert.throws(() => { evaluation.claim_outcome = 'VERIFIED'; }, TypeError);
  await assert.rejects(
    () => evaluateClaimOutcomeV13({ request: { ...request, requested: true }, source: null }),
    error => error.code === 'scope_source_required',
  );
});

test('transaction evaluation reconstructs source effects and never localizes its own residuals', async () => {
  const fixture = await authorityFixture();
  const row = fixture.evidenceContext.transaction_population.transactions[0];
  const source = { context: fixture.evidenceContext, context_authority: fixture.contextAuthority, transaction_signature: row.source_identity.signature };
  const { request, evaluation } = await evaluateRequested('TRANSACTION_EFFECT', source);
  const effect = fixture.effects.get(row.canonical_transaction_coordinate);
  assert.equal(evaluation.claim_outcome, effect.residual_unresolved_effects.length === 0 ? 'VERIFIED' : 'LIMITED');
  assert.equal(evaluation.position_state, null);
  assert.ok(evaluation.established_fields.some(item => item.field === (evaluation.claim_outcome === 'VERIFIED' ? 'committed_effects' : 'established_effects')));
  assert.equal(evaluation.non_interference_decisions.every(item => item.decision === 'CLAIM_AFFECTING'), true);
  assert.equal(await validateSourceBoundClaimEvaluationV13({ evaluation, request, source }), true);
});

test('claim-affecting target residuals make Position state unavailable despite a closed admitted-event ledger', async () => {
  const fixture = await authorityFixture('0', '0');
  const source = await positionSource(fixture, [
    trade(fixture, 0, 'TARGET_ACQUISITION', '10', '20', true),
    trade(fixture, 1, 'TARGET_DISPOSAL', '10', '30', true),
  ]);
  const { request, evaluation } = await evaluateRequested('POSITION_EPISODE', source);
  assert.equal(evaluation.claim_outcome, 'LIMITED');
  assert.equal(evaluation.position_state, null);
  assert.ok(evaluation.non_interference_decisions.some(item => item.decision === 'CLAIM_AFFECTING'));
  assert.equal(evaluation.field_availability.find(item => item.field === 'position_state').availability, 'UNAVAILABLE');
  assert.equal(evaluation.field_availability.find(item => item.field === 'realized_return').availability, 'UNAVAILABLE');
  assert.equal(await validateSourceBoundClaimEvaluationV13({ evaluation, request, source }), true);
});

test('residual-backed target events BLOCK when the limited projection cannot establish every target effect', async () => {
  const fixture = await authorityFixture('0', '10');
  const residualId = fixture.effects.get(0).residual_unresolved_effects[0].residual_id;
  const source = await positionSource(fixture, [sourceAt(fixture, 0, {
    coordinate: 0,
    kind: 'TARGET_ACQUISITION',
    sourceEffectIds: [residualId],
    payload: { target_raw_quantity: '10', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '20' },
  })]);
  const evaluation = (await evaluateRequested('POSITION_EPISODE', source)).evaluation;
  assert.equal(evaluation.claim_outcome, 'BLOCKED');
  assert.equal(evaluation.position_state, null);
  assert.deepEqual(evaluation.established_fields, []);
  assert.ok(evaluation.reason_codes.includes('TRANSACTION_EFFECT_UNRESOLVED'));
  assert.ok(evaluation.reason_codes.includes('NO_LIMITED_PROJECTION'));
});

test('NI-03 exclusion of a residual original shape cannot leave its residual-backed target event without a substantive BLOCKED reason', async () => {
  const otherMint = providerPublicKey('slice5-ni03-other-mint');
  const fixture = await authorityFixture('0', '0', fullTransactions => {
    for (const transaction of fullTransactions) {
      transaction.pre_token_balances = [];
      transaction.post_token_balances = [];
      transaction.instructions = [];
      transaction.inner_instruction_groups = [];
    }
    const transaction = fullTransactions[0];
    transaction.post_token_balances = [{
      account_index: 4,
      account: transaction.accounts[4].address,
      mint: otherMint,
      owner: transaction.accounts[0].address,
      raw_amount: '1',
      decimals: 6,
      token_program: TOKEN_PROGRAM,
    }];
  });
  const candidates = [...fixture.effects.entries()].flatMap(([coordinate, effect]) => (
    effect.residual_unresolved_effects
      .filter(residual => ['TOKEN_BALANCE_SIDE_MISSING', 'FAILED_TOKEN_BALANCE_OBSERVATION'].includes(residual.reason_code)
        && residual.mint !== null && residual.mint !== JUP_MINT_V1 && residual.mint !== USDC_MINT_V1
        && [...new Set([...(residual.accounts ?? []), residual.account].filter(item => item !== null))].length > 0
        && ![...new Set([...(residual.accounts ?? []), residual.account].filter(item => item !== null))].includes(TARGET_ACCOUNT))
      .map(residual => ({ coordinate, effect, residual }))
  ));
  assert.ok(candidates.length > 0);

  let ni03Evaluation = null;
  for (const { coordinate, effect, residual } of candidates) {
    const otherCoordinate = [...fixture.effects.keys()].find(item => item !== coordinate);
    const orderedCoordinates = [coordinate, otherCoordinate].sort((left, right) => left - right);
    const source = await positionSource(fixture, orderedCoordinates.map((item, index) => sourceAt(fixture, item, {
      coordinate: 0,
      kind: index === 0 ? 'TARGET_ACQUISITION' : 'TARGET_DISPOSAL',
      sourceEffectIds: [
        ...allEstablishedRefs(fixture.effects.get(item)),
        ...(item === coordinate ? [residual.residual_id] : []),
      ].sort(),
      payload: { target_raw_quantity: '10', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '20' },
    })));
    const evaluation = (await evaluateRequested('POSITION_EPISODE', source)).evaluation;
    if (evaluation.non_interference_decisions.some(item => item.applied_rule === 'NI-03')) {
      ni03Evaluation = evaluation;
      break;
    }
  }

  assert.notEqual(ni03Evaluation, null);
  assert.equal(ni03Evaluation.claim_outcome, 'BLOCKED');
  assert.ok(ni03Evaluation.reason_codes.includes('TRANSACTION_EFFECT_UNRESOLVED'));
  assert.ok(ni03Evaluation.reason_codes.includes('NO_LIMITED_PROJECTION'));
});

test('claim-affecting residuals make admitted-ledger OPEN states and affected disposal fields unavailable', async () => {
  const fixture = await authorityFixture('0', '11');
  const openSource = await positionSource(fixture, [
    trade(fixture, 0, 'TARGET_ACQUISITION', '10', '20', true),
    trade(fixture, 1, 'TARGET_ACQUISITION', '1', '2', true),
  ]);
  const open = (await evaluateRequested('POSITION_EPISODE', openSource)).evaluation;
  assert.equal(open.claim_outcome, 'LIMITED');
  assert.equal(open.position_state, null);
  for (const field of ['disposal_proceeds', 'realized_basis_consumed', 'realized_pnl', 'realized_return']) {
    assert.equal(open.field_availability.find(item => item.field === field).availability, 'UNAVAILABLE');
  }

  const partialFixture = await authorityFixture('0', '6');
  const partialSource = await positionSource(partialFixture, [
    trade(partialFixture, 0, 'TARGET_ACQUISITION', '10', '20', true),
    trade(partialFixture, 1, 'TARGET_DISPOSAL', '4', '12', true),
  ]);
  const partial = (await evaluateRequested('POSITION_EPISODE', partialSource)).evaluation;
  assert.equal(partial.claim_outcome, 'LIMITED');
  assert.equal(partial.position_state, null);
});

test('an admitted-ledger CLOSED state is unavailable when source residuals remain claim-affecting', async () => {
  const fixture = await authorityFixture('0', '0');
  const source = await positionSource(fixture, [
    trade(fixture, 0, 'TARGET_ACQUISITION', '10', '20'),
    trade(fixture, 1, 'TARGET_DISPOSAL', '10', '30'),
  ]);
  const evaluation = (await evaluateRequested('POSITION_EPISODE', source)).evaluation;
  assert.equal(evaluation.position_state, null);
  assert.equal(evaluation.claim_outcome, 'LIMITED');
  assert.ok(evaluation.unresolved_dependencies.length > 0);
  assert.ok(evaluation.non_interference_decisions.some(item => item.source_kind === 'TRANSACTION_EFFECT_RESIDUAL'));
});

test('unknown transfer-in basis does not affect state but independent source residuals still make state unavailable', async () => {
  const fixture = await authorityFixture('0', '5');
  const transfer = sourceAt(fixture, 0, {
    coordinate: 0,
    kind: 'TARGET_TRANSFER_IN',
    dependencies: [D('5')],
    payload: { target_raw_quantity: '5', basis_status: 'UNKNOWN', attributable_basis: null },
  });
  const source = await positionSource(fixture, [transfer]);
  const { evaluation } = await evaluateRequested('POSITION_EPISODE', source);
  assert.equal(evaluation.claim_outcome, 'LIMITED');
  assert.equal(evaluation.position_state, null);
  assert.ok(evaluation.reason_codes.includes('TRANSFER_IN_BASIS_UNRESOLVED'));
  assert.equal(evaluation.field_availability.find(item => item.field === 'position_state').availability, 'UNAVAILABLE');
  assert.equal(evaluation.non_interference_decisions.filter(
    item => item.source_kind === 'POSITION_ECONOMIC_DEPENDENCY',
  ).every(item => !item.affected_fields.includes('position_state')), true);
  assert.equal(evaluation.field_availability.find(item => item.field === 'remaining_attributable_basis').availability, 'UNAVAILABLE');
  assert.equal(evaluation.field_availability.find(item => item.field === 'realized_pnl').availability, 'UNAVAILABLE');
});

test('genuine later economic zero restores subsequent basis only while source residuals keep state unavailable', async () => {
  const fixture = await authorityFixture('0', '0');
  const transfer = sourceAt(fixture, 0, {
    coordinate: 0,
    kind: 'TARGET_TRANSFER_IN',
    sourceEffectIds: allEstablishedRefs(fixture.effects.get(0)),
    dependencies: [D('6')],
    payload: { target_raw_quantity: '5', basis_status: 'UNKNOWN', attributable_basis: null },
  });
  const source = await positionSource(fixture, [
    transfer,
    trade(fixture, 1, 'TARGET_DISPOSAL', '5', '10', true),
  ]);
  const evaluation = (await evaluateRequested('POSITION_EPISODE', source)).evaluation;
  assert.equal(evaluation.claim_outcome, 'LIMITED');
  assert.equal(evaluation.position_state, null);
  assert.ok(evaluation.reason_codes.includes('TRANSFER_IN_BASIS_UNRESOLVED'));
  assert.equal(evaluation.field_availability.find(item => item.field === 'remaining_attributable_basis').availability, 'UNAVAILABLE');
  for (const field of ['realized_basis_consumed', 'realized_pnl', 'realized_return']) {
    assert.equal(evaluation.field_availability.find(item => item.field === field).availability, 'UNAVAILABLE');
  }
});

test('wallet coverage keeps unsupported/residual wallet effects visible and remains separate from Position', async () => {
  const fixture = await authorityFixture();
  const source = { context: fixture.evidenceContext, context_authority: fixture.contextAuthority };
  const { request, evaluation } = await evaluateRequested('WALLET_WINDOW', source);
  assert.ok(['VERIFIED', 'LIMITED'].includes(evaluation.claim_outcome));
  assert.deepEqual(evaluation.field_availability, []);
  assert.equal(evaluation.position_state, null);
  const residualCount = [...fixture.effects.values()].reduce((sum, effect) => sum + effect.residual_unresolved_effects.length, 0);
  assert.equal(evaluation.claim_outcome, residualCount === 0 && fixture.contextAuthority.legacy_acquisition_result.activity_findings.length === 0 ? 'VERIFIED' : 'LIMITED');
  assert.equal(await validateSourceBoundClaimEvaluationV13({ evaluation, request, source }), true);
});

test('evaluation identity binds all derived facts and source-bound validation rejects rehashed forgery', async () => {
  const fixture = await authorityFixture();
  const source = { context: fixture.evidenceContext, context_authority: fixture.contextAuthority };
  const { request, evaluation } = await evaluateRequested('WALLET_WINDOW', source);
  assert.deepEqual(Object.keys(evaluation).sort(), [...CLAIM_EVALUATION_FIELDS].sort());
  assert.equal(evaluation.claim_evaluation_version, CLAIM_EVALUATION_VERSION);
  assert.equal(validateClaimEvaluationStructureV13(evaluation), true);

  const forged = structuredClone(evaluation);
  const forgedField = forged.established_fields.find(item => item.field === 'acquisition_window_identity');
  forgedField.value = D('e');
  forgedField.value_digest = sha256CanonicalJson({ field: forgedField.field, value: forgedField.value });
  forged.evaluation_digest = sha256CanonicalJson(claimEvaluationDigestPreimage(forged));
  forged.evaluation_id = `${CLAIM_EVALUATION_ID_PREFIX}${forged.evaluation_digest}`;
  assert.equal(validateClaimEvaluationStructureV13(forged), true);
  await assert.rejects(
    () => validateSourceBoundClaimEvaluationV13({ evaluation: forged, request, source }),
    error => error.code === 'claim_evaluation_source_mismatch',
  );
});

test('structural validation rejects rehashed decision extensions and noncanonical source references', async () => {
  const fixture = await authorityFixture();
  const source = {
    context: fixture.evidenceContext,
    context_authority: fixture.contextAuthority,
    transaction_signature: fixture.evidenceContext.transaction_population.transactions[0].source_identity.signature,
  };
  const { evaluation } = await evaluateRequested('TRANSACTION_EFFECT', source);
  assert.ok(evaluation.non_interference_decisions.length > 0);

  const extension = structuredClone(evaluation);
  extension.non_interference_decisions[0].caller_safety_override = true;
  extension.evaluation_digest = sha256CanonicalJson(claimEvaluationDigestPreimage(extension));
  extension.evaluation_id = `${CLAIM_EVALUATION_ID_PREFIX}${extension.evaluation_digest}`;
  assert.throws(() => validateClaimEvaluationStructureV13(extension), error => error.code === 'unknown_field');

  const duplicateReference = structuredClone(evaluation);
  duplicateReference.established_fields[0].source_references.push(duplicateReference.established_fields[0].source_references[0]);
  duplicateReference.evaluation_digest = sha256CanonicalJson(claimEvaluationDigestPreimage(duplicateReference));
  duplicateReference.evaluation_id = `${CLAIM_EVALUATION_ID_PREFIX}${duplicateReference.evaluation_digest}`;
  assert.throws(() => validateClaimEvaluationStructureV13(duplicateReference), error => error.code === 'established_source_reference_noncanonical');

  const incompleteProjection = structuredClone(evaluation);
  incompleteProjection.established_fields = [];
  incompleteProjection.evaluation_digest = sha256CanonicalJson(claimEvaluationDigestPreimage(incompleteProjection));
  incompleteProjection.evaluation_id = `${CLAIM_EVALUATION_ID_PREFIX}${incompleteProjection.evaluation_digest}`;
  assert.throws(() => validateClaimEvaluationStructureV13(incompleteProjection), error => error.code === 'result_projection_incomplete');
});

test('scope mismatch, unknown fields, availability type confusion, and hostile values fail closed', async () => {
  const fixture = await authorityFixture();
  const source = { context: fixture.evidenceContext, context_authority: fixture.contextAuthority };
  const scope = computeClaimEvaluationScopeDigestV13({ claim_type: 'WALLET_WINDOW', source });
  await assert.rejects(() => evaluateClaimOutcomeV13({ request: requestFor('WALLET_WINDOW', D('f')), source }), error => error.code === 'scope_digest_mismatch');
  await assert.rejects(() => evaluateClaimOutcomeV13({ request: { ...requestFor('WALLET_WINDOW', scope), outcome: 'VERIFIED' }, source }), error => error.code === 'unknown_field');

  const { evaluation } = await evaluateRequested('WALLET_WINDOW', source);
  const confused = { ...structuredClone(evaluation), field_availability: '' };
  assert.throws(() => validateClaimEvaluationStructureV13(confused), error => error.code === 'field_availability_invalid');

  let calls = 0;
  const request = requestFor('WALLET_WINDOW', scope);
  Object.defineProperty(request, 'requested', { enumerable: true, get() { calls += 1; return true; } });
  await assert.rejects(() => evaluateClaimOutcomeV13({ request, source }), error => error.code === 'accessor_not_allowed');
  assert.equal(calls, 0);

  let proxyCalls = 0;
  const proxy = new Proxy({}, { ownKeys() { proxyCalls += 1; return []; } });
  await assert.rejects(() => evaluateClaimOutcomeV13(proxy), error => error.code === 'proxy_not_allowed');
  assert.equal(proxyCalls, 0);

  for (const prototype of [{ inherited_authority_override: true }, null]) {
    const hostile = Object.create(prototype);
    Object.defineProperties(hostile, {
      request: { value: requestFor('WALLET_WINDOW', scope), enumerable: true },
      source: { value: null, enumerable: true },
    });
    await assert.rejects(() => evaluateClaimOutcomeV13(hostile), error => error.code === 'custom_prototype_not_allowed');
  }
});
