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
import {
  buildEpisodeCandidatePopulationV13,
  validateEpisodeCandidatePopulationStructureV13,
  validateSourceBoundEpisodeCandidatePopulationV13,
} from './episode-candidate-population.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TARGET_ACCOUNT = providerPublicKey('slice6-position-target-account');

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
  const fullTransactions = [
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_buy_full,
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_sell_full,
  ].sort((left, right) => right.slot - left.slot || right.block_time - left.block_time);
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
  const openingBasisReference = openingRaw === '0' ? null : {
    basis_evidence_profile: 'ARTIFACT_OPENING_BASIS_EVIDENCE_V1',
    basis_evidence_digest: sha256CanonicalJson({ fixture: 'slice6-unresolved-opening-basis' }),
  };
  const contextAuthority = {
    transaction_transcript_port: transactionTranscriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
    opening_enumeration_port: openingEnumerationPort,
    ending_enumeration_port: endingEnumerationPort,
    target_mint: JUP_MINT_V1,
    opening_basis_reference: openingBasisReference,
  };
  const evidenceContext = await buildSourceBoundAuthoritativeEvidenceContextV13({
    transaction_transcript_port: transactionTranscriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
    opening_enumeration_port: openingEnumerationPort,
    ending_enumeration_port: endingEnumerationPort,
    target_mint: JUP_MINT_V1,
    opening_basis_reference: openingBasisReference,
  });
  const effects = new Map(evidenceContext.transaction_population.transactions.map(item => [
    item.canonical_transaction_coordinate,
    projectSolanaFullTransactionEffectV13({ wallet: JUP_WALLET_V1, transaction: item.full_transaction }),
  ]));
  return { evidenceContext, contextAuthority, effects };
}
function allRefs(effect) {
  return [
    ...effect.established_effects.map(item => item.effect_id),
    ...effect.residual_unresolved_effects.map(item => item.residual_id),
  ].sort();
}
function sourceEvent(fixture, txCoordinate, coordinate, kind, target, quote, sourceEffectIds) {
  const effect = fixture.effects.get(txCoordinate);
  return {
    transaction_signature: effect.transaction_identity.signature,
    authoritative_intra_transaction_coordinate: coordinate,
    event_kind: kind,
    payload: {
      target_raw_quantity: target,
      quote_status: 'EXACT',
      quote_mint: USDC_MINT_V1,
      quote_raw_amount: quote,
    },
    source_effect_ids: sourceEffectIds,
    corroborating_effect_ids: [],
    dependency_references: [],
  };
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
  const effectDispositions = [...fixture.effects.values()].flatMap(effect => allRefs(effect)).sort().map(effect_id => ({
    effect_id,
    ...(roles.get(effect_id) ?? {
      disposition: 'NON_ECONOMIC', event_locator: null, reason_code: 'NO_POSITION_ECONOMIC_EFFECT',
    }),
  }));
  const evidence = {
    economic_evidence_profile: 'ARTIFACT_AUTHORITATIVE_POSITION_ECONOMIC_EFFECTS_V1',
    evidence_context_digest: fixture.evidenceContext.evidence_context_digest,
    exact_quote_mint: USDC_MINT_V1,
    opening_basis_evidence: null,
    source_events: sourceEvents,
    effect_dispositions: effectDispositions,
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
function twoAtomicClosedEpisodes(fixture) {
  return [0, 1].flatMap(txCoordinate => {
    const refs = allRefs(fixture.effects.get(txCoordinate));
    assert.ok(refs.length >= 2);
    return [
      sourceEvent(fixture, txCoordinate, 0, 'TARGET_ACQUISITION', '5', '10', [refs[0]]),
      sourceEvent(fixture, txCoordinate, 1, 'TARGET_DISPOSAL', '5', '12', [refs[1]]),
    ];
  });
}

test('zero-positive-genuine-zero within one transaction emits one atomic CLOSED episode and every transaction is partitioned once', async () => {
  const fixture = await authorityFixture();
  const input = populationInput(fixture, twoAtomicClosedEpisodes(fixture));
  const population = await buildEpisodeCandidatePopulationV13(input);

  assert.equal(population.source_transaction_count, 2);
  assert.equal(population.source_episode_count, 2);
  assert.equal(population.transaction_partition.length, 2);
  assert.deepEqual(population.transaction_partition.map(row => row.canonical_transaction_coordinate), [0, 1]);
  assert.equal(population.transaction_partition.every(row => row.transaction_disposition === 'EPISODE_SPAN_MEMBER'), true);
  assert.deepEqual(population.transaction_partition.map(row => row.episode_ordinal), [0, 1]);
  assert.equal(population.episode_dispositions.every(row => row.episode.position_state === 'CLOSED'), true);
  assert.equal(population.episode_dispositions.every(row => row.episode.ordered_admitted_economic_events.length === 2), true);
  assert.equal(population.episode_dispositions.every(row => row.population_disposition !== 'PROFILE_EXCLUDED'), true);
  assert.equal(population.episode_dispositions.every(
    row => row.candidate_eligible === (row.population_disposition === 'VERIFIED'),
  ), true);
  const priorUnresolved = [
    ...population.transaction_partition[0].non_interference_residual_references,
    ...population.transaction_partition[0].activity_finding_digests,
  ];
  assert.ok(priorUnresolved.length > 0);
  assert.equal(population.episode_dispositions[0].episode.ending_boundary.zero_status, 'ECONOMIC_ZERO_UNRESOLVED');
  assert.equal(population.episode_dispositions[1].episode.opening_boundary.zero_status, 'ECONOMIC_ZERO_UNRESOLVED');
  assert.equal(population.episode_dispositions[1].exclusion_references.some(
    exclusion => priorUnresolved.includes(exclusion.evidence_digest)
      && exclusion.non_interference_rule === 'NI-02',
  ), false);
  assert.equal(priorUnresolved.every(
    reference => population.episode_dispositions[1].unresolved_dependency_references.includes(reference),
  ), true);
  assert.equal(
    population.source_episode_count,
    population.verified_count + population.limited_count + population.blocked_count + population.profile_excluded_count,
  );
  assert.equal(population.profile_excluded_count, 0);
  assert.ok(Object.isFrozen(population));
  assert.ok(Object.isFrozen(population.transaction_partition[0].source_effect_ids));
  assert.ok(Object.isFrozen(population.episode_dispositions[0].episode));
  assert.equal(canonicalJson(population).includes('candidate_selection_policy'), false);
  assert.equal(canonicalJson(population).includes('selected_digest'), false);
  assert.equal(validateEpisodeCandidatePopulationStructureV13(population), true);
  assert.equal(await validateSourceBoundEpisodeCandidatePopulationV13({ population, ...input }), true);
});

test('outside transactions remain explicit and unresolved outside evidence is not laundered through NI-02', async () => {
  const fixture = await authorityFixture();
  const events = twoAtomicClosedEpisodes(fixture).filter(event => (
    event.transaction_signature === fixture.effects.get(1).transaction_identity.signature
  ));
  const input = populationInput(fixture, events);
  const population = await buildEpisodeCandidatePopulationV13(input);
  assert.equal(population.source_episode_count, 1);
  assert.equal(population.transaction_partition[0].transaction_disposition, 'OUTSIDE_EPISODE');
  assert.equal(population.transaction_partition[0].episode_ordinal, null);
  assert.ok(population.transaction_partition[0].source_effect_ids.length > 0);
  assert.ok(population.transaction_partition[0].source_residual_ids.length > 0);
  const disposition = population.episode_dispositions[0];
  const earlierResidualDigests = new Set(population.transaction_partition[0].non_interference_residual_references);
  assert.equal(disposition.episode.opening_boundary.zero_status, 'ECONOMIC_ZERO_UNRESOLVED');
  assert.equal(disposition.exclusion_references.some(
    exclusion => earlierResidualDigests.has(exclusion.evidence_digest)
      && exclusion.non_interference_rule === 'NI-02',
  ), false);
  assert.equal([...earlierResidualDigests].every(
    reference => disposition.unresolved_dependency_references.includes(reference),
  ), true);
});

test('positive opening inventory with unresolved opening basis remains a complete LIMITED population row', async () => {
  const fixture = await authorityFixture('5', '5');
  const population = await buildEpisodeCandidatePopulationV13(populationInput(fixture, []));
  assert.equal(population.source_episode_count, 1);
  assert.equal(population.limited_count, 1);
  assert.equal(population.blocked_count, 0);
  assert.equal(population.episode_dispositions[0].population_disposition, 'LIMITED');
  assert.equal(population.episode_dispositions[0].episode.position_state, 'OPEN');
  assert.ok(population.episode_dispositions[0].reason_codes.includes('OPENING_BASIS_UNRESOLVED'));
});

test('unknown position state remains a complete LIMITED projection with explicit null state', async () => {
  const fixture = await authorityFixture('5', '0');
  const effect = fixture.effects.get(0);
  const population = await buildEpisodeCandidatePopulationV13(populationInput(fixture, [{
    transaction_signature: effect.transaction_identity.signature,
    authoritative_intra_transaction_coordinate: 0,
    event_kind: 'TARGET_TRANSFER_OUT',
    payload: { target_raw_quantity: '5', external_continuation_status: 'UNRESOLVED' },
    source_effect_ids: [allRefs(effect)[0]],
    corroborating_effect_ids: [],
    dependency_references: [sha256CanonicalJson({ fixture: 'slice6-external-continuation' })],
  }]));
  assert.equal(population.limited_count, 1);
  assert.equal(population.blocked_count, 0);
  assert.equal(population.episode_dispositions[0].population_disposition, 'LIMITED');
  assert.equal(population.episode_dispositions[0].candidate_eligible, false);
  assert.equal(population.episode_dispositions[0].position_state, null);
  assert.equal(population.episode_dispositions[0].reason_codes.includes('NO_LIMITED_PROJECTION'), false);
});

test('population is order-invariant and source-bound validation rejects cherry-picking with a recomputed outer identity', async () => {
  const fixture = await authorityFixture();
  const events = twoAtomicClosedEpisodes(fixture);
  const canonicalInput = populationInput(fixture, events);
  const reversedInput = populationInput(fixture, [...events].reverse());
  const canonical = await buildEpisodeCandidatePopulationV13(canonicalInput);
  const reversed = await buildEpisodeCandidatePopulationV13(reversedInput);
  assert.equal(canonicalJson(canonical), canonicalJson(reversed));

  const forged = structuredClone(canonical);
  forged.episode_dispositions.pop();
  forged.source_episode_count -= 1;
  forged.limited_count = forged.episode_dispositions.filter(row => row.population_disposition === 'LIMITED').length;
  forged.verified_count = forged.episode_dispositions.filter(row => row.population_disposition === 'VERIFIED').length;
  forged.blocked_count = forged.episode_dispositions.filter(row => row.population_disposition === 'BLOCKED').length;
  forged.profile_excluded_count = 0;
  forged.transaction_partition[1].transaction_disposition = 'OUTSIDE_EPISODE';
  forged.transaction_partition[1].episode_ordinal = null;
  const preimage = Object.fromEntries(Object.entries(forged).filter(([key]) => !['population_id', 'population_digest'].includes(key)));
  forged.population_digest = sha256CanonicalJson(preimage);
  forged.population_id = `episode-population-${forged.population_digest}`;

  await assert.rejects(
    () => validateSourceBoundEpisodeCandidatePopulationV13({ population: forged, ...canonicalInput }),
    error => error.code === 'episode_candidate_population_source_mismatch',
  );

  const manufacturedExclusion = structuredClone(canonical);
  manufacturedExclusion.episode_dispositions[0].population_disposition = 'PROFILE_EXCLUDED';
  manufacturedExclusion.limited_count -= 1;
  manufacturedExclusion.profile_excluded_count = 1;
  const exclusionPreimage = Object.fromEntries(Object.entries(manufacturedExclusion)
    .filter(([key]) => !['population_id', 'population_digest'].includes(key)));
  manufacturedExclusion.population_digest = sha256CanonicalJson(exclusionPreimage);
  manufacturedExclusion.population_id = `episode-population-${manufacturedExclusion.population_digest}`;
  assert.throws(
    () => validateEpisodeCandidatePopulationStructureV13(manufacturedExclusion),
    error => error.code === 'profile_excluded_unreachable',
  );
});

test('production input rejects caller episode, outcome, eligibility, filter, rank, and selection controls', async () => {
  const fixture = await authorityFixture();
  const input = populationInput(fixture, twoAtomicClosedEpisodes(fixture));
  for (const [field, value] of [
    ['episodes', []], ['episode_ids', []], ['episode_ordinals', []], ['boundaries', []],
    ['outcomes', []], ['eligibility', true], ['filters', []], ['rank', 1],
    ['selected_digest', 'a'.repeat(64)], ['selection_key', 'preferred'],
  ]) {
    await assert.rejects(
      () => buildEpisodeCandidatePopulationV13({ ...input, [field]: value }),
      error => error.code === 'unknown_field',
    );
  }
});

test('population construction rejects accessors and proxies without executing hostile traps', async () => {
  const fixture = await authorityFixture();
  const input = populationInput(fixture, twoAtomicClosedEpisodes(fixture));
  let calls = 0;
  const hostileAuthority = { ...input.context_authority };
  Object.defineProperty(hostileAuthority, 'transcript_port', {
    enumerable: true,
    get() { calls += 1; return input.context_authority.transcript_port; },
  });
  await assert.rejects(
    buildEpisodeCandidatePopulationV13({ ...input, context_authority: hostileAuthority }),
    /context_authority/,
  );
  assert.equal(calls, 0);

  const hostileInput = new Proxy(input, {
    ownKeys(target) { calls += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { calls += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  await assert.rejects(buildEpisodeCandidatePopulationV13(hostileInput), /episode_candidate_population_input/);
  assert.equal(calls, 0);
});

test('population fails closed when a recapturable economic authority changes between episode projections', async () => {
  const fixture = await authorityFixture();
  const canonicalEvents = twoAtomicClosedEpisodes(fixture);
  const changedEvents = structuredClone(canonicalEvents);
  changedEvents[0].payload.quote_raw_amount = '11';
  const canonicalInput = populationInput(fixture, canonicalEvents);
  const changedInput = populationInput(fixture, changedEvents);
  let captures = 0;
  const changingPort = createPositionEconomicEvidencePortV13({
    async captureAuthoritativePositionEconomicsV13(request) {
      captures += 1;
      const source = captures === 1 ? canonicalInput.economic_evidence_port : changedInput.economic_evidence_port;
      return source.captureAuthoritativePositionEconomicsV13(request);
    },
  });
  await assert.rejects(
    buildEpisodeCandidatePopulationV13({ ...canonicalInput, economic_evidence_port: changingPort }),
    error => error.code === 'position_economic_evidence_changed',
  );
  assert.equal(captures, 2);
});
