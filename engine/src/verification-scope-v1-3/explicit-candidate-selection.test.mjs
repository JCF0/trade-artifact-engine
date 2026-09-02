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
import { canonicalJson, sha256CanonicalJson } from './contract.mjs';
import { createPositionEconomicEvidencePortV13 } from './position-episode.mjs';
import { buildEpisodeCandidatePopulationV13 } from './episode-candidate-population.mjs';
import {
  CANDIDATE_MEMBER_IDENTITY_PROFILE_V13,
  EXPLICIT_SELECTION_POLICY_V13,
  candidateMemberDigestPreimageV13,
  computeCandidateMemberDigestV13,
  selectExplicitCandidateV13,
  validateSelectionArtifactStructureV13,
  validateSourceBoundExplicitCandidateSelectionV13,
} from './explicit-candidate-selection.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TARGET_ACCOUNT = providerPublicKey('slice7-position-target-account');
const D = character => character.repeat(64);

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
async function authorityFixture(openingRaw = '0', endingRaw = '0') {
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
  for (const transaction of fullTransactions) {
    transaction.instructions = [];
    transaction.inner_instruction_groups = [];
  }
  const transactionTranscriptPort = createEvidenceContextTranscriptPortV1({
    async getAuthoritativeTransactionTranscriptV1() {
      return {
        authoritative_population: fullTransactions.map(({ signature, slot, block_time, execution_state }) => ({
          signature, slot, block_time, execution_state,
        })),
        full_transactions: fullTransactions,
      };
    },
  });
  const openingEnumerationPort = enumerationPort(fullTransactions.at(-1).slot - 1, openingRaw);
  const endingEnumerationPort = enumerationPort(fullTransactions[0].slot + 1, endingRaw);
  const openingBasisEvidence = openingRaw === '0' ? null : {
    basis_evidence_profile: 'ARTIFACT_OPENING_BASIS_EVIDENCE_V1',
    analyzed_wallet: JUP_WALLET_V1,
    target_mint: JUP_MINT_V1,
    exact_quote_mint: USDC_MINT_V1,
    attributable_basis: { numerator: '10', denominator: '1' },
    source_references: [sha256CanonicalJson({ fixture: 'slice7-opening-basis-source' })],
    basis_evidence_digest: null,
  };
  if (openingBasisEvidence !== null) {
    openingBasisEvidence.basis_evidence_digest = sha256CanonicalJson(Object.fromEntries(
      Object.entries(openingBasisEvidence).filter(([key]) => key !== 'basis_evidence_digest'),
    ));
  }
  const openingBasisReference = openingBasisEvidence === null ? null : {
    basis_evidence_profile: openingBasisEvidence.basis_evidence_profile,
    basis_evidence_digest: openingBasisEvidence.basis_evidence_digest,
  };
  const contextAuthority = {
    transaction_transcript_port: transactionTranscriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
    opening_enumeration_port: openingEnumerationPort,
    ending_enumeration_port: endingEnumerationPort,
    target_mint: JUP_MINT_V1,
    opening_basis_reference: openingBasisReference,
  };
  const evidenceContext = await buildSourceBoundAuthoritativeEvidenceContextV13(contextAuthority);
  const effects = new Map(evidenceContext.transaction_population.transactions.map(item => [
    item.canonical_transaction_coordinate,
    projectSolanaFullTransactionEffectV13({ wallet: JUP_WALLET_V1, transaction: item.full_transaction }),
  ]));
  return { evidenceContext, contextAuthority, effects, openingBasisEvidence };
}
function effectIds(effect) { return effect.established_effects.map(item => item.effect_id).sort(); }
function sourceEvent(fixture, txCoordinate, coordinate, kind, payload, sourceEffectIds, dependencies = []) {
  return {
    transaction_signature: fixture.effects.get(txCoordinate).transaction_identity.signature,
    authoritative_intra_transaction_coordinate: coordinate,
    event_kind: kind,
    payload,
    source_effect_ids: sourceEffectIds,
    corroborating_effect_ids: [],
    dependency_references: dependencies,
  };
}
function closedTradeEvents(fixture) {
  return [0, 1].flatMap(txCoordinate => {
    const ids = effectIds(fixture.effects.get(txCoordinate));
    const midpoint = Math.ceil(ids.length / 2);
    return [
      sourceEvent(fixture, txCoordinate, 0, 'TARGET_ACQUISITION', {
        target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '10',
      }, ids.slice(0, midpoint)),
      sourceEvent(fixture, txCoordinate, 1, 'TARGET_DISPOSAL', {
        target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '12',
      }, ids.slice(midpoint)),
    ];
  });
}
function openAcquisitionEvents(fixture) {
  return [0, 1].map(txCoordinate => sourceEvent(
    fixture,
    txCoordinate,
    0,
    'TARGET_ACQUISITION',
    { target_raw_quantity: '1', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '2' },
    effectIds(fixture.effects.get(txCoordinate)),
  ));
}
function mixedLimitedVerifiedEvents(fixture) {
  const firstIds = effectIds(fixture.effects.get(0));
  const secondIds = effectIds(fixture.effects.get(1));
  const firstMidpoint = Math.ceil(firstIds.length / 2);
  const secondMidpoint = Math.ceil(secondIds.length / 2);
  return [
    sourceEvent(fixture, 0, 0, 'TARGET_TRANSFER_IN', {
      target_raw_quantity: '5', basis_status: 'UNKNOWN', attributable_basis: null,
    }, firstIds.slice(0, firstMidpoint), [sha256CanonicalJson({ fixture: 'slice7-transfer-basis' })]),
    sourceEvent(fixture, 0, 1, 'TARGET_DISPOSAL', {
      target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '12',
    }, firstIds.slice(firstMidpoint)),
    sourceEvent(fixture, 1, 0, 'TARGET_ACQUISITION', {
      target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '10',
    }, secondIds.slice(0, secondMidpoint)),
    sourceEvent(fixture, 1, 1, 'TARGET_DISPOSAL', {
      target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '12',
    }, secondIds.slice(secondMidpoint)),
  ];
}
function populationInput(fixture, sourceEvents) {
  const roles = new Map();
  for (const event of sourceEvents) {
    const event_locator = {
      transaction_signature: event.transaction_signature,
      authoritative_intra_transaction_coordinate: event.authoritative_intra_transaction_coordinate,
      event_kind: event.event_kind,
    };
    for (const effect_id of event.source_effect_ids) roles.set(effect_id, { disposition: 'PRIMARY', event_locator, reason_code: null });
  }
  const allIds = [...fixture.effects.values()].flatMap(effect => [
    ...effect.established_effects.map(item => item.effect_id),
    ...effect.residual_unresolved_effects.map(item => item.residual_id),
  ]).sort();
  const evidence = {
    economic_evidence_profile: 'ARTIFACT_AUTHORITATIVE_POSITION_ECONOMIC_EFFECTS_V1',
    evidence_context_digest: fixture.evidenceContext.evidence_context_digest,
    exact_quote_mint: USDC_MINT_V1,
    opening_basis_evidence: fixture.openingBasisEvidence,
    source_events: sourceEvents,
    effect_dispositions: allIds.map(effect_id => ({
      effect_id,
      ...(roles.get(effect_id) ?? {
        disposition: 'NON_ECONOMIC', event_locator: null, reason_code: 'NO_POSITION_ECONOMIC_EFFECT',
      }),
    })),
    economic_evidence_digest: null,
  };
  evidence.economic_evidence_digest = sha256CanonicalJson(Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'economic_evidence_digest'),
  ));
  return {
    context: fixture.evidenceContext,
    context_authority: fixture.contextAuthority,
    exact_quote_mint: USDC_MINT_V1,
    economic_evidence_port: createPositionEconomicEvidencePortV13({
      async captureAuthoritativePositionEconomicsV13() { return structuredClone(evidence); },
    }),
  };
}
async function selectionCase(eventsFactory = closedTradeEvents, openingRaw = '0', endingRaw = '0') {
  const fixture = await authorityFixture(openingRaw, endingRaw);
  const input = populationInput(fixture, eventsFactory(fixture));
  const population = await buildEpisodeCandidatePopulationV13(input);
  const source = { population, ...input };
  return { fixture, input, population, source };
}
function candidateDigest(population, row) {
  return computeCandidateMemberDigestV13({
    candidate_population_digest: population.population_digest,
    episode_disposition: row,
  });
}
function requestFor(population, row) {
  return {
    candidate_population_digest: population.population_digest,
    requested_candidate_digest: candidateDigest(population, row),
  };
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('candidate-member identity binds the exact authoritative Slice 6 row semantics without eligibility', () => {
  const episodeDisposition = {
    episode_ordinal: 3,
    episode: { episode_id: `position-episode-${D('2')}`, position_episode_digest: D('2') },
    claim_evaluation_identity: {
      evaluation_id: `claim-evaluation-${D('3')}`, evaluation_digest: D('3'),
      claim_evaluation_profile: 'ARTIFACT_CLAIM_OUTCOME_EVALUATION_V1', claim_type: 'POSITION_EPISODE',
      claim_profile: 'POSITION_ECONOMICS_V1', scope_digest: D('4'),
    },
    population_disposition: 'VERIFIED', candidate_eligible: true, position_state: 'OPEN',
  };
  const input = { candidate_population_digest: D('1'), episode_disposition: episodeDisposition };
  const expectedPreimage = {
    candidate_member_identity_profile: 'ARTIFACT_EPISODE_CANDIDATE_MEMBER_ID_V1',
    candidate_population_digest: D('1'), dense_episode_ordinal: 3, claim_scope_digest: D('4'),
    position_episode_digest: D('2'), claim_evaluation_identity: episodeDisposition.claim_evaluation_identity,
    population_disposition: 'VERIFIED', position_state: 'OPEN',
  };
  assert.equal(CANDIDATE_MEMBER_IDENTITY_PROFILE_V13, expectedPreimage.candidate_member_identity_profile);
  assert.deepEqual(candidateMemberDigestPreimageV13(input), expectedPreimage);
  assert.equal(computeCandidateMemberDigestV13(input), sha256CanonicalJson(expectedPreimage));
  episodeDisposition.candidate_eligible = false;
  assert.equal(computeCandidateMemberDigestV13(input), sha256CanonicalJson(expectedPreimage));
});

test('exact VERIFIED member selection emits one immutable source-bound no-fallback artifact', async () => {
  const { population, source } = await selectionCase();
  assert.equal(population.episode_dispositions.every(row => row.population_disposition === 'VERIFIED'), true);
  const row = population.episode_dispositions[1];
  const request = requestFor(population, row);
  const result = await selectExplicitCandidateV13({ request, source });
  assert.equal(result.status, 'SELECTED_VERIFIED');
  assert.equal(result.selection_artifact.selection_policy, EXPLICIT_SELECTION_POLICY_V13);
  assert.equal(result.selection_artifact.selection_policy, 'EXPLICIT_DIGEST_NO_FALLBACK_V1');
  assert.equal(result.selection_artifact.selection_status, 'SELECTED_VERIFIED');
  assert.equal(result.selection_artifact.resolved_episode_ordinal, row.episode_ordinal);
  assert.equal(result.selection_artifact.requested_candidate_digest, request.requested_candidate_digest);
  assert.equal(result.selection_artifact.resolved_candidate_digest, request.requested_candidate_digest);
  assert.equal(result.selection_artifact.selection_id, `selection-${result.selection_artifact.selection_digest}`);
  assert.equal(validateSelectionArtifactStructureV13(result.selection_artifact), true);
  assert.equal(await validateSourceBoundExplicitCandidateSelectionV13({ result, request, source }), true);
  assert.equal(/rank|score|profit|return|fallback|candidate_eligible/.test(canonicalJson(result)), false);
  assertDeepFrozen(result);
});

test('VERIFIED CLOSED, OPEN, and OPEN_REALIZED_PARTIAL members are selected without economic preference', async () => {
  const closedCase = await selectionCase();
  const openCase = await selectionCase(openAcquisitionEvents, '5', '7');
  const partialCase = await selectionCase(closedTradeEvents, '5', '5');
  const cases = [
    [closedCase, 'CLOSED'],
    [openCase, 'OPEN'],
    [partialCase, 'OPEN_REALIZED_PARTIAL'],
  ];
  for (const [entry, expectedState] of cases) {
    const row = entry.population.episode_dispositions[0];
    assert.equal(row.population_disposition, 'VERIFIED', `${expectedState}: ${row.reason_codes.join(',')}`);
    assert.equal(row.position_state, expectedState);
    const request = requestFor(entry.population, row);
    const result = await selectExplicitCandidateV13({ request, source: entry.source });
    assert.equal(result.status, 'SELECTED_VERIFIED');
    assert.equal(result.selection_artifact.position_state, expectedState);
  }
});

test('LIMITED requested member returns its exact evaluation refusal and never falls back to a VERIFIED member', async () => {
  const { population, source } = await selectionCase(mixedLimitedVerifiedEvents);
  assert.deepEqual(population.episode_dispositions.map(row => row.population_disposition), ['LIMITED', 'VERIFIED']);
  const requestedRow = population.episode_dispositions[0];
  const verifiedRow = population.episode_dispositions[1];
  const request = requestFor(population, requestedRow);
  const result = await selectExplicitCandidateV13({ request, source });
  assert.deepEqual(Object.keys(result), ['status', 'refusal']);
  assert.equal(result.status, 'REFUSED_SELECTED_CANDIDATE_NOT_VERIFIED');
  assert.deepEqual(Object.keys(result.refusal), [
    'refusal_code', 'requested_population_digest', 'requested_candidate_digest',
    'resolved_candidate_digest', 'resolved_population_disposition',
    'selected_evaluation_id', 'selected_evaluation_digest', 'selected_evaluation_outcome',
  ]);
  assert.equal(result.refusal.refusal_code, 'selected_candidate_not_verified');
  assert.equal(result.refusal.resolved_population_disposition, 'LIMITED');
  assert.equal(result.refusal.selected_evaluation_outcome, 'LIMITED');
  assert.equal(result.refusal.resolved_candidate_digest, request.requested_candidate_digest);
  assert.notEqual(result.refusal.resolved_candidate_digest, candidateDigest(population, verifiedRow));
  assert.equal(canonicalJson(result).includes('selection_id'), false);
  assert.equal(await validateSourceBoundExplicitCandidateSelectionV13({ result, request, source }), true);
  assertDeepFrozen(result);
});

test('selection request is exactly two digests and absent, malformed, or stale targets fail without replacement', async () => {
  const { population, source } = await selectionCase();
  const request = requestFor(population, population.episode_dispositions[0]);
  for (const [field, value] of [
    ['episode_ordinal', 0], ['position_episode_digest', D('1')], ['evaluation_digest', D('2')],
    ['position_state', 'CLOSED'], ['population_disposition', 'VERIFIED'], ['outcome', 'VERIFIED'],
    ['reason_codes', []], ['economics', {}], ['rank', 1], ['fallback', []], ['candidate_alias', 'best'],
  ]) {
    await assert.rejects(
      () => selectExplicitCandidateV13({ request: { ...request, [field]: value }, source }),
      error => error.code === 'unknown_field',
    );
  }
  await assert.rejects(
    () => selectExplicitCandidateV13({ request: { ...request, requested_candidate_digest: 'A'.repeat(64) }, source }),
    error => error.code === 'malformed_digest',
  );
  await assert.rejects(
    () => selectExplicitCandidateV13({ request: { ...request, requested_candidate_digest: D('f') }, source }),
    error => error.code === 'selected_candidate_absent',
  );
  await assert.rejects(
    () => selectExplicitCandidateV13({ request: { ...request, candidate_population_digest: D('e') }, source }),
    error => error.code === 'candidate_population_digest_mismatch',
  );
});

test('source-bound reconstruction rejects completely rehashed row and population forgery', async () => {
  const { population, input } = await selectionCase();
  const forged = structuredClone(population);
  forged.episode_dispositions[0].position_state = 'OPEN';
  const preimage = Object.fromEntries(Object.entries(forged)
    .filter(([field]) => !['population_id', 'population_digest'].includes(field)));
  forged.population_digest = sha256CanonicalJson(preimage);
  forged.population_id = `episode-population-${forged.population_digest}`;
  const forgedSource = { population: forged, ...input };
  const request = requestFor(forged, forged.episode_dispositions[0]);
  await assert.rejects(
    () => selectExplicitCandidateV13({ request, source: forgedSource }),
    error => ['episode_population_incomplete', 'episode_candidate_population_source_mismatch'].includes(error.code),
  );
});

test('selection boundary rejects accessors and proxies without executing traps', async () => {
  const { population, source } = await selectionCase();
  const request = requestFor(population, population.episode_dispositions[0]);
  let calls = 0;
  const accessor = { ...request };
  Object.defineProperty(accessor, 'requested_candidate_digest', {
    enumerable: true, get() { calls += 1; throw new Error('must not execute'); },
  });
  await assert.rejects(
    () => selectExplicitCandidateV13({ request: accessor, source }),
    error => error.code === 'accessor_not_allowed',
  );
  const proxy = new Proxy(request, { ownKeys() { calls += 1; throw new Error('must not execute'); } });
  await assert.rejects(
    () => selectExplicitCandidateV13({ request: proxy, source }),
    error => error.code === 'proxy_not_allowed',
  );
  const hostilePopulation = new Proxy(source.population, {
    get() { calls += 1; throw new Error('population trap must not execute'); },
  });
  await assert.rejects(
    () => selectExplicitCandidateV13({ request, source: { ...source, population: hostilePopulation } }),
    error => error.code === 'proxy_not_allowed',
  );
  assert.equal(calls, 0);
});
