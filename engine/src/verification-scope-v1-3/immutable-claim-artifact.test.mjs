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
import { computeClaimDigest } from './claim-envelope.mjs';
import { claimEvaluationDigestPreimage } from './claim-outcome-evaluator.mjs';
import { createPositionEconomicEvidencePortV13 } from './position-episode.mjs';
import { buildEpisodeCandidatePopulationV13 } from './episode-candidate-population.mjs';
import { computeCandidateMemberDigestV13 } from './explicit-candidate-selection.mjs';
import {
  IMMUTABLE_CLAIM_ARTIFACT_PROFILE_V13,
  claimArtifactDigestPreimageV13,
  issueImmutablePositionClaimV13,
  validateImmutableClaimArtifactStructureV13,
  validateSourceBoundImmutablePositionClaimV13,
} from './immutable-claim-artifact.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TARGET_ACCOUNT = providerPublicKey('slice7-claim-target-account');

function enumerationPort(slot) {
  return createTargetAccountEnumerationPortV1({
    async enumerateTargetAccountsByProgramV1() { return { context: { slot }, accounts: [] }; },
  });
}
async function authorityFixture() {
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
  const contextAuthority = {
    transaction_transcript_port: transactionTranscriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
    opening_enumeration_port: enumerationPort(fullTransactions.at(-1).slot - 1),
    ending_enumeration_port: enumerationPort(fullTransactions[0].slot + 1),
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
function sourceEvent(fixture, txCoordinate, coordinate, kind, payload, sourceEffectIds) {
  return {
    transaction_signature: fixture.effects.get(txCoordinate).transaction_identity.signature,
    authoritative_intra_transaction_coordinate: coordinate,
    event_kind: kind,
    payload,
    source_effect_ids: sourceEffectIds,
    corroborating_effect_ids: [],
    dependency_references: [],
  };
}
function closedTradeEvents(fixture) {
  return [0, 1].flatMap(txCoordinate => {
    const ids = fixture.effects.get(txCoordinate).established_effects.map(item => item.effect_id).sort();
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
function mixedLimitedVerifiedEvents(fixture) {
  const ids = [0, 1].map(txCoordinate => (
    fixture.effects.get(txCoordinate).established_effects.map(item => item.effect_id).sort()
  ));
  const midpoints = ids.map(values => Math.ceil(values.length / 2));
  return [
    {
      ...sourceEvent(fixture, 0, 0, 'TARGET_TRANSFER_IN', {
        target_raw_quantity: '5', basis_status: 'UNKNOWN', attributable_basis: null,
      }, ids[0].slice(0, midpoints[0])),
      dependency_references: [sha256CanonicalJson({ fixture: 'slice7-claim-transfer-basis' })],
    },
    sourceEvent(fixture, 0, 1, 'TARGET_DISPOSAL', {
      target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '12',
    }, ids[0].slice(midpoints[0])),
    sourceEvent(fixture, 1, 0, 'TARGET_ACQUISITION', {
      target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '10',
    }, ids[1].slice(0, midpoints[1])),
    sourceEvent(fixture, 1, 1, 'TARGET_DISPOSAL', {
      target_raw_quantity: '5', quote_status: 'EXACT', quote_mint: USDC_MINT_V1, quote_raw_amount: '12',
    }, ids[1].slice(midpoints[1])),
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
    opening_basis_evidence: null,
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
async function claimCase(eventsFactory = closedTradeEvents, rowIndex = 1) {
  const fixture = await authorityFixture();
  const input = populationInput(fixture, eventsFactory(fixture));
  const population = await buildEpisodeCandidatePopulationV13(input);
  const row = population.episode_dispositions[rowIndex];
  const requestedCandidateDigest = computeCandidateMemberDigestV13({
    candidate_population_digest: population.population_digest,
    episode_disposition: row,
  });
  const request = {
    candidate_population_digest: population.population_digest,
    requested_candidate_digest: requestedCandidateDigest,
  };
  const source = { population, ...input };
  return { population, row, request, source };
}
function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('authoritative issuance reconstructs and binds the complete evaluation, envelope, population, candidate, and selection', async () => {
  const { population, row, request, source } = await claimCase();
  const artifact = await issueImmutablePositionClaimV13({ request, source });
  assert.equal(artifact.claim_artifact_profile, IMMUTABLE_CLAIM_ARTIFACT_PROFILE_V13);
  assert.equal(artifact.candidate_population_digest, population.population_digest);
  assert.equal(artifact.candidate_digest, request.requested_candidate_digest);
  assert.equal(artifact.position_episode_digest, row.episode.position_episode_digest);
  assert.equal(artifact.claim_evaluation.evaluation_digest, row.claim_evaluation_identity.evaluation_digest);
  assert.equal(artifact.claim_evaluation.claim_outcome, 'VERIFIED');
  assert.equal(artifact.claim_envelope.claim_outcome, 'VERIFIED');
  assert.equal(artifact.claim_envelope.position_state, row.position_state);
  assert.equal(artifact.claim_envelope.candidate_digest, request.requested_candidate_digest);
  assert.equal(artifact.claim_artifact_id, `immutable-claim-${artifact.claim_artifact_digest}`);
  assert.equal(validateImmutableClaimArtifactStructureV13(artifact), true);
  assert.equal(await validateSourceBoundImmutablePositionClaimV13({ artifact, request, source }), true);
  assertDeepFrozen(artifact);
});

test('issuance accepts no caller-authored envelope, outcome, disclosure, companion, or receipt content', async () => {
  const { request, source } = await claimCase();
  for (const [field, value] of [
    ['claim_envelope', {}], ['claim_outcome', 'VERIFIED'], ['reason_codes', []], ['field_availability', []],
    ['episode', {}], ['economics', {}], ['companions', []], ['transaction_claim', {}],
    ['wallet_window_claim', {}], ['receipt', {}], ['legacy_reference', {}],
  ]) {
    await assert.rejects(
      () => issueImmutablePositionClaimV13({ request: { ...request, [field]: value }, source }),
      error => error.code === 'unknown_field',
    );
  }
  await assert.rejects(
    () => issueImmutablePositionClaimV13({ request, source, claim_envelope: {} }),
    error => error.code === 'unknown_field',
  );
});

test('non-VERIFIED selected member cannot issue an immutable claim even when another member is VERIFIED', async () => {
  const { population, row, request, source } = await claimCase(mixedLimitedVerifiedEvents, 0);
  assert.equal(row.population_disposition, 'LIMITED');
  assert.equal(population.verified_count, 1);
  await assert.rejects(
    () => issueImmutablePositionClaimV13({ request, source }),
    error => error.code === 'selected_candidate_not_verified'
      && error.details.refusal.resolved_candidate_digest === request.requested_candidate_digest
      && error.details.refusal.selected_evaluation_outcome === 'LIMITED',
  );
});

test('issuance and validation reject a proxied nested population without executing traps', async () => {
  const { request, source } = await claimCase();
  const artifact = await issueImmutablePositionClaimV13({ request, source });
  let calls = 0;
  const hostilePopulation = new Proxy(source.population, {
    get() { calls += 1; throw new Error('population trap must not execute'); },
  });
  const hostileSource = { ...source, population: hostilePopulation };
  await assert.rejects(
    () => issueImmutablePositionClaimV13({ request, source: hostileSource }),
    error => error.code === 'proxy_not_allowed',
  );
  await assert.rejects(
    () => validateSourceBoundImmutablePositionClaimV13({ artifact, request, source: hostileSource }),
    error => error.code === 'proxy_not_allowed',
  );
  assert.equal(calls, 0);
});

test('complete source-bound validation rejects a fully self-rehashed forged semantic result', async () => {
  const { request, source } = await claimCase();
  const artifact = await issueImmutablePositionClaimV13({ request, source });
  const forged = structuredClone(artifact);
  const field = forged.claim_evaluation.established_fields.find(item => item.field === 'aggregate_acquisition_basis');
  assert.ok(field);
  field.value = { numerator: '999', denominator: '1' };
  field.value_digest = sha256CanonicalJson({ field: field.field, value: field.value });
  const reference = forged.claim_envelope.result_field_references.find(item => item.field === field.field);
  assert.ok(reference);
  reference.value_digest = field.value_digest;
  forged.claim_envelope.claim_digest = computeClaimDigest(forged.claim_envelope);
  forged.claim_envelope.claim_id = `avc13_${forged.claim_envelope.claim_digest}`;
  forged.claim_envelope_digest = forged.claim_envelope.claim_digest;
  forged.claim_envelope_id = forged.claim_envelope.claim_id;
  forged.claim_evaluation.evaluation_digest = sha256CanonicalJson(
    claimEvaluationDigestPreimage(forged.claim_evaluation),
  );
  forged.claim_evaluation.evaluation_id = `claim-evaluation-${forged.claim_evaluation.evaluation_digest}`;
  forged.claim_evaluation_digest = forged.claim_evaluation.evaluation_digest;
  forged.claim_evaluation_id = forged.claim_evaluation.evaluation_id;
  forged.claim_artifact_digest = sha256CanonicalJson(claimArtifactDigestPreimageV13(forged));
  forged.claim_artifact_id = `immutable-claim-${forged.claim_artifact_digest}`;

  assert.equal(validateImmutableClaimArtifactStructureV13(forged), true);
  await assert.rejects(
    () => validateSourceBoundImmutablePositionClaimV13({ artifact: forged, request, source }),
    error => error.code === 'immutable_claim_source_mismatch',
  );
});
