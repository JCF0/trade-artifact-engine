import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROLLED_TARGET_MINT_V1,
  USDC_MINT_V1,
  createControlledCaseAuthorityV1,
} from './fixtures/controlled-case-offline-v1.mjs';
import { createPositionEconomicEvidencePortV13 } from './position-episode.mjs';
import {
  CONTROLLED_CLASSIC_SPL_USDC_POSITION_ECONOMIC_BRIDGE_PROFILE_V1,
  createProductionPositionEconomicEvidencePortV13,
  isProductionPositionEconomicEvidencePortV13,
} from './production-position-economic-evidence-bridge-v1-3.mjs';

function productionInput(fixture) {
  return {
    evidence_context: fixture.context,
    context_authority: fixture.context_authority,
    exact_quote_mint: fixture.exact_quote_mint,
  };
}

function code(expected) {
  return error => error?.code === expected;
}

test('the controlled production bridge profile is frozen and not caller supplied', () => {
  assert.equal(
    CONTROLLED_CLASSIC_SPL_USDC_POSITION_ECONOMIC_BRIDGE_PROFILE_V1,
    'ARTIFACT_CONTROLLED_CLASSIC_SPL_USDC_POSITION_ECONOMIC_BRIDGE_V1',
  );
  assert.equal(Object.isFrozen(CONTROLLED_CLASSIC_SPL_USDC_POSITION_ECONOMIC_BRIDGE_PROFILE_V1), true);
});

test('a generic Slice 4 callback port cannot claim production provenance', async () => {
  const fixture = await createControlledCaseAuthorityV1();
  assert.equal(isProductionPositionEconomicEvidencePortV13(fixture.economic_evidence_port), false);
  const forged = createPositionEconomicEvidencePortV13({
    async captureAuthoritativePositionEconomicsV13() { return fixture.economic_evidence; },
  });
  assert.equal(isProductionPositionEconomicEvidencePortV13(forged), false);
  assert.equal(isProductionPositionEconomicEvidencePortV13({}), false);
});

test('residual-free aggregate balance signs cannot establish a same-operation acquisition or disposal', async () => {
  const fixture = await createControlledCaseAuthorityV1();
  await assert.rejects(
    createProductionPositionEconomicEvidencePortV13(productionInput(fixture)),
    code('position_economic_same_operation_unestablished'),
  );
  assert.equal(fixture.context.target_mint, CONTROLLED_TARGET_MINT_V1);
  assert.equal(fixture.exact_quote_mint, USDC_MINT_V1);
});

test('a realistic wallet-touching route is rejected for residual evidence before economic classification', async () => {
  const fixture = await createControlledCaseAuthorityV1({ realisticRoute: true });
  await assert.rejects(
    createProductionPositionEconomicEvidencePortV13(productionInput(fixture)),
    code('position_economic_residual_evidence'),
  );
  assert.ok([...fixture.effects.values()].some(effect => effect.residual_unresolved_effects
    .some(residual => residual.reason_code === 'UNMATCHED_WALLET_INSTRUCTION')));
});

test('the production factory rejects caller-authored profile, effects, events, and completeness fields', async () => {
  const fixture = await createControlledCaseAuthorityV1();
  for (const [field, value] of [
    ['production_evidence_profile', CONTROLLED_CLASSIC_SPL_USDC_POSITION_ECONOMIC_BRIDGE_PROFILE_V1],
    ['effects', []],
    ['source_events', []],
    ['complete', true],
  ]) {
    await assert.rejects(
      createProductionPositionEconomicEvidencePortV13({ ...productionInput(fixture), [field]: value }),
      code('unknown_field'),
    );
  }
});

test('source context must recapture from its exact registered Slice 3B authorities', async () => {
  const fixture = await createControlledCaseAuthorityV1({
    mutate_transcript_capture(transactions) {
      transactions[0].post_token_balances[0].raw_amount = '1';
    },
  });
  await assert.rejects(
    createProductionPositionEconomicEvidencePortV13(productionInput(fixture)),
    code('evidence_context_source_mismatch'),
  );
});
