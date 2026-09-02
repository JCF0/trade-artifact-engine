#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256CanonicalJson } from './contract.mjs';
import { validateSourceBoundAuthoritativeEvidenceContextV13 } from './authoritative-evidence-context.mjs';
import {
  controlledCaseGateExitCodeV1,
  runControlledCaseOfflineE2EGateV1,
  validateControlledCaseGateResultV1,
} from './controlled-case-e2e-gate-v1.mjs';
import { createControlledCaseAuthorityV1 } from './fixtures/controlled-case-offline-v1.mjs';
import {
  buildEpisodeCandidatePopulationV13,
  validateSourceBoundEpisodeCandidatePopulationV13,
} from './episode-candidate-population.mjs';
import {
  computeCandidateMemberDigestV13,
  selectExplicitCandidateV13,
  validateSourceBoundExplicitCandidateSelectionV13,
} from './explicit-candidate-selection.mjs';
import {
  issueImmutablePositionClaimV13,
  validateSourceBoundImmutablePositionClaimV13,
} from './immutable-claim-artifact.mjs';

async function canonicalSource() {
  const fixture = await createControlledCaseAuthorityV1();
  const populationInput = {
    context: fixture.context,
    context_authority: fixture.context_authority,
    exact_quote_mint: fixture.exact_quote_mint,
    economic_evidence_port: fixture.economic_evidence_port,
  };
  const population = await buildEpisodeCandidatePopulationV13(populationInput);
  const requestedCandidateDigest = computeCandidateMemberDigestV13({
    candidate_population_digest: population.population_digest,
    episode_disposition: population.episode_dispositions[0],
  });
  const request = {
    candidate_population_digest: population.population_digest,
    requested_candidate_digest: requestedCandidateDigest,
  };
  const source = { population, ...populationInput };
  return { fixture, populationInput, population, request, source };
}

function errorCode(error) { return typeof error?.code === 'string'; }
function contextValidationInput(fixture) {
  const authority = fixture.context_authority;
  return {
    context: fixture.context,
    transaction_transcript_port: authority.transaction_transcript_port,
    legacy_acquisition_result: authority.legacy_acquisition_result,
    opening_enumeration_port: authority.opening_enumeration_port,
    ending_enumeration_port: authority.ending_enumeration_port,
    target_mint: authority.target_mint,
    opening_basis_reference: authority.opening_basis_reference,
  };
}

test('realistic wallet-touching swap route remains a non-golden fail-closed UNMATCHED_WALLET_INSTRUCTION diagnostic', async () => {
  const fixture = await createControlledCaseAuthorityV1({ realisticRoute: true });
  const residuals = [...fixture.effects.values()].flatMap(effect => effect.residual_unresolved_effects);
  assert.ok(residuals.length > 0);
  assert.equal(residuals.every(residual => residual.reason_code === 'UNMATCHED_WALLET_INSTRUCTION'), true);
  assert.deepEqual([...new Set(residuals.map(residual => residual.reason_code))], ['UNMATCHED_WALLET_INSTRUCTION']);

  const population = await buildEpisodeCandidatePopulationV13({
    context: fixture.context,
    context_authority: fixture.context_authority,
    exact_quote_mint: fixture.exact_quote_mint,
    economic_evidence_port: fixture.economic_evidence_port,
  });
  assert.equal(population.verified_count, 0);
  assert.equal(population.limited_count + population.blocked_count, population.source_episode_count);
  assert.ok(population.episode_dispositions.every(row => row.reason_codes.includes('UNMATCHED_WALLET_INSTRUCTION')));
});

test('altered, omitted, and reordered upstream transaction evidence fail before candidate selection', async () => {
  const mutators = [
    transactions => {
      transactions[1].post_token_balances.find(
        row => row.mint !== transactions[1].pre_token_balances[0].mint,
      ).raw_amount = '99999999';
    },
    transactions => { transactions.pop(); },
    transactions => { transactions.reverse(); },
  ];
  for (const mutateTranscriptCapture of mutators) {
    const fixture = await createControlledCaseAuthorityV1({
      mutate_transcript_capture: mutateTranscriptCapture,
    });
    await assert.rejects(
      validateSourceBoundAuthoritativeEvidenceContextV13(contextValidationInput(fixture)),
      errorCode,
    );
  }
});

test('explicit selection rejects stale population, absent candidate, and fallback-shaped requests', async () => {
  const canonical = await canonicalSource();
  await assert.rejects(
    selectExplicitCandidateV13({
      request: { ...canonical.request, candidate_population_digest: 'a'.repeat(64) },
      source: canonical.source,
    }),
    error => error.code === 'candidate_population_digest_mismatch',
  );
  await assert.rejects(
    selectExplicitCandidateV13({
      request: { ...canonical.request, requested_candidate_digest: 'b'.repeat(64) },
      source: canonical.source,
    }),
    error => error.code === 'selected_candidate_absent',
  );
  await assert.rejects(
    selectExplicitCandidateV13({
      request: { ...canonical.request, allow_fallback: true },
      source: canonical.source,
    }),
    error => error.code === 'unknown_field',
  );
});

test('source-bound validators reject forged population, selection, and immutable claim identities', async () => {
  const canonical = await canonicalSource();
  const selection = await selectExplicitCandidateV13({ request: canonical.request, source: canonical.source });
  const claim = await issueImmutablePositionClaimV13({ request: canonical.request, source: canonical.source });

  const forgedPopulation = structuredClone(canonical.population);
  forgedPopulation.verified_count = 0;
  const populationPreimage = structuredClone(forgedPopulation);
  delete populationPreimage.population_id;
  delete populationPreimage.population_digest;
  forgedPopulation.population_digest = sha256CanonicalJson(populationPreimage);
  forgedPopulation.population_id = `episode-population-${forgedPopulation.population_digest}`;
  await assert.rejects(
    validateSourceBoundEpisodeCandidatePopulationV13({ population: forgedPopulation, ...canonical.populationInput }),
    errorCode,
  );

  const forgedSelection = structuredClone(selection);
  forgedSelection.selection_artifact.position_episode_digest = 'c'.repeat(64);
  await assert.rejects(
    validateSourceBoundExplicitCandidateSelectionV13({
      result: forgedSelection, request: canonical.request, source: canonical.source,
    }),
    errorCode,
  );

  const forgedClaim = structuredClone(claim);
  forgedClaim.claim_evaluation.reason_codes = ['TRANSACTION_EFFECT_UNRESOLVED'];
  await assert.rejects(
    validateSourceBoundImmutablePositionClaimV13({
      artifact: forgedClaim, request: canonical.request, source: canonical.source,
    }),
    errorCode,
  );
});

test('gate evidence is closed, canonical, proxy/accessor-safe, and detached from mutable copies', async () => {
  const result = await runControlledCaseOfflineE2EGateV1();
  const unknown = structuredClone(result);
  unknown.semantic_claim = {};
  assert.throws(() => validateControlledCaseGateResultV1(unknown), error => error.code === 'unknown_field');

  const reordered = structuredClone(result);
  reordered.transaction_effect_identities.reverse();
  assert.throws(() => validateControlledCaseGateResultV1(reordered), error => error.code === 'controlled_case_gate_effects_invalid');

  const omittedAssertion = structuredClone(result);
  omittedAssertion.assertions.pop();
  assert.throws(() => validateControlledCaseGateResultV1(omittedAssertion),
    error => error.code === 'controlled_case_gate_assertions_invalid');
  const reorderedAssertions = structuredClone(result);
  reorderedAssertions.assertions.reverse();
  assert.throws(() => validateControlledCaseGateResultV1(reorderedAssertions),
    error => error.code === 'controlled_case_gate_assertions_invalid');

  const forgedStageIdentity = structuredClone(result);
  forgedStageIdentity.selection_identity.id = `selection-${'f'.repeat(64)}`;
  assert.throws(() => validateControlledCaseGateResultV1(forgedStageIdentity),
    error => error.code === 'controlled_case_gate_identity_invalid');
  const forgedFixtureVersion = structuredClone(result);
  forgedFixtureVersion.fixture_identity.fixture_version = 'artifact_verification_scope_v1_3_controlled_case_fixture_v2';
  assert.throws(() => validateControlledCaseGateResultV1(forgedFixtureVersion),
    error => error.code === 'controlled_case_gate_fixture_invalid');

  const selfConsistentFalsePass = structuredClone(result);
  selfConsistentFalsePass.assertions.forEach(row => {
    row.expected = null;
    row.observed = null;
    row.status = 'PASS';
  });
  selfConsistentFalsePass.authoritative_source_identities.transaction_population_digest = 'f'.repeat(64);
  selfConsistentFalsePass.selection_identity.digest = 'e'.repeat(64);
  selfConsistentFalsePass.selection_identity.id = `selection-${'e'.repeat(64)}`;
  selfConsistentFalsePass.transaction_effect_identities[0].signature = '';
  assert.throws(() => validateControlledCaseGateResultV1(selfConsistentFalsePass),
    error => error.code === 'controlled_case_gate_release_identity_mismatch');
  assert.equal(controlledCaseGateExitCodeV1(result), 0);
  assert.equal(controlledCaseGateExitCodeV1({ overall_status: 'FAIL' }), 1);

  const accessor = structuredClone(result);
  Object.defineProperty(accessor, 'overall_status', { enumerable: true, get() { return 'PASS'; } });
  assert.throws(() => validateControlledCaseGateResultV1(accessor), error => error.code === 'accessor_not_allowed');
  assert.throws(() => validateControlledCaseGateResultV1(new Proxy(structuredClone(result), {})),
    error => error.code === 'proxy_not_allowed');

  const mutable = structuredClone(result);
  mutable.assertions[0].observed = 'forged';
  assert.equal(result.assertions[0].status, 'PASS');
});
