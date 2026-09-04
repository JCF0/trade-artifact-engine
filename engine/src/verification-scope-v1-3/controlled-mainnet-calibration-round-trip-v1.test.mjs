import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256CanonicalJson } from './contract.mjs';
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
import { createProductionPositionEconomicEvidencePortV13 } from './production-position-economic-evidence-bridge-v1-3.mjs';
import {
  CONTROLLED_MAINNET_CALIBRATION_ARCHIVE_SHA256_V1,
  createControlledMainnetCalibrationAuthorityV1,
} from './fixtures/controlled-mainnet-calibration-round-trip-v1.mjs';

function establishedValue(evaluation, field) {
  return evaluation.established_fields.find(item => item.field === field)?.value ?? null;
}

const FROZEN_CONTROLLED_CALIBRATION_IDENTITIES_V1 = {
  archive_sha256: 'c6579cf3dc14413d12ccabb9227aa9b931960ccc1441f76f0450b919a8f16d75',
  candidate_digest: 'a5bfbd305befca4912e12618c2ab54e6b9fc3e3892ac14159a88e58d00d409f8',
  claim_evaluation_digest: '034a9357add51262c7b6b6455742c12bc364f921769724772c3c00f858ab3fe9',
  economic_evidence_digest: '0a9b0adc77b69ca89a279cb5d1305b8362c64273b3d6a87009427fc6e3c4425f',
  evidence_context_digest: '22667294c385343bf9ebb2573b8e25c35b10dc3fc522fdb9b5a933bce2c2257f',
  immutable_claim_canonical_sha256: 'eb37db3e3c8eb805b3c67da7e435d5fea3c8a89cceea8e00e27553e7ca3611dc',
  immutable_claim_digest: '7e09930f32a947f6678773182b26b3c5858ca16375d9880877948c19ec4459b8',
  population_digest: '95378d1eeb27a1b3a4e3c7da8d2fec15eb698ac6632bfdfe28805d4423126b99',
  position_episode_digest: '7433a49395cef7af51d8c3570a3d09e52c98b4d90aa7d0586ca30c4f8ad60aa8',
  selection_digest: 'b6e8863f3ba9fdee5af5218865092475c700b224bc5b0c6146eccd0bee66a145',
  transaction_population_digest: '3621cd594a18dbaf42cbe106a4880b3d5a0174ad0a83a8043c1853616cccafb2',
};

test('reconstructs the frozen controlled mainnet Whirlpool round trip through Slices 1-7', async () => {
  const fixture = await createControlledMainnetCalibrationAuthorityV1();
  assert.equal(fixture.archive_sha256, CONTROLLED_MAINNET_CALIBRATION_ARCHIVE_SHA256_V1);
  const economicEvidencePort = await createProductionPositionEconomicEvidencePortV13({
    evidence_context: fixture.context,
    context_authority: fixture.context_authority,
    exact_quote_mint: fixture.exact_quote_mint,
  });
  const populationInput = {
    context: fixture.context,
    context_authority: fixture.context_authority,
    exact_quote_mint: fixture.exact_quote_mint,
    economic_evidence_port: economicEvidencePort,
  };
  const population = await buildEpisodeCandidatePopulationV13(populationInput);
  await validateSourceBoundEpisodeCandidatePopulationV13({ population, ...populationInput });
  assert.equal(population.source_transaction_count, 2);
  assert.equal(population.source_episode_count, 1);
  assert.equal(population.verified_count, 1);
  assert.equal(population.limited_count, 0);
  assert.equal(population.blocked_count, 0);

  const disposition = population.episode_dispositions[0];
  const requestedCandidateDigest = computeCandidateMemberDigestV13({
    candidate_population_digest: population.population_digest,
    episode_disposition: disposition,
  });
  const request = {
    candidate_population_digest: population.population_digest,
    requested_candidate_digest: requestedCandidateDigest,
  };
  const source = { population, ...populationInput };
  const selection = await selectExplicitCandidateV13({ request, source });
  await validateSourceBoundExplicitCandidateSelectionV13({ result: selection, request, source });
  assert.equal(selection.status, 'SELECTED_VERIFIED');

  const claim = await issueImmutablePositionClaimV13({ request, source });
  await validateSourceBoundImmutablePositionClaimV13({ artifact: claim, request, source });
  const reconstructed = await issueImmutablePositionClaimV13({ request, source });
  assert.equal(canonicalJson(reconstructed), canonicalJson(claim));

  const episode = disposition.episode;
  const evaluation = claim.claim_evaluation;
  assert.equal(evaluation.claim_outcome, 'VERIFIED');
  assert.equal(evaluation.position_state, 'CLOSED');
  assert.deepEqual(episode.aggregate_acquisition_basis, { numerator: '5000000', denominator: '1' });
  assert.deepEqual(episode.recognized_disposal_proceeds, { numerator: '4748794', denominator: '1' });
  assert.deepEqual(episode.realized_basis_consumed, { numerator: '5000000', denominator: '1' });
  assert.deepEqual(episode.realized_pnl, { numerator: '-251206', denominator: '1' });
  assert.deepEqual(episode.realized_return, { numerator: '-125603', denominator: '2500000' });
  assert.deepEqual(episode.remaining_attributable_basis, { numerator: '0', denominator: '1' });
  assert.equal(episode.ending_economic_inventory, '0');
  assert.deepEqual(episode.unresolved_economic_dependencies, []);
  assert.deepEqual(evaluation.reason_codes, []);
  assert.deepEqual(establishedValue(evaluation, 'fee_treatment'), []);

  const identities = {
    archive_sha256: fixture.archive_sha256,
    evidence_context_digest: fixture.context.evidence_context_digest,
    transaction_population_digest: fixture.context.transaction_population.population_evidence_digest,
    economic_evidence_digest: episode.economic_evidence_identity.economic_evidence_digest,
    position_episode_digest: episode.position_episode_digest,
    claim_evaluation_digest: evaluation.evaluation_digest,
    population_digest: population.population_digest,
    candidate_digest: requestedCandidateDigest,
    selection_digest: selection.selection_artifact.selection_digest,
    immutable_claim_digest: claim.claim_artifact_digest,
    immutable_claim_canonical_sha256: sha256CanonicalJson(claim),
  };
  assert.deepEqual(identities, FROZEN_CONTROLLED_CALIBRATION_IDENTITIES_V1);
  console.log(`CONTROLLED_CALIBRATION_IDENTITIES ${canonicalJson(identities)}`);
});
