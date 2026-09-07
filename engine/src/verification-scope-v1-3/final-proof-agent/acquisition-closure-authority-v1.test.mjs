import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFinalizedLegEvidenceV1 } from './episode-evidence-graph-v1.mjs';
import {
  captureAuthoritativeAcquisitionClosureV1,
  createOfflineAcquisitionClosurePortV1,
  isAuthoritativeAcquisitionClosureProofV1,
} from './acquisition-closure-authority-v1.mjs';
import {
  createBoundedAgentOfflineEpisodeFixtureV1,
  createSyntheticAcquisitionAuthorityFixtureV1,
} from './fixtures/bounded-agent-offline-v1.mjs';

async function sourceFrom(fixture, finalized = fixture.evidence_graph.acquisition.finalized) {
  const authority = await createSyntheticAcquisitionAuthorityFixtureV1(fixture.mandate);
  return {
    context: authority.context,
    context_authority: authority.context_authority,
    exact_quote_mint: fixture.mandate.asset_scope.usdc_mint,
    finalized_acquisition: finalized,
  };
}

test('acquisition closure is branded only after source-bound transaction reconstruction', async () => {
  const fixture = await createBoundedAgentOfflineEpisodeFixtureV1();
  const port = createOfflineAcquisitionClosurePortV1({
    capture_authority: async () => sourceFrom(fixture),
  });
  const proof = await captureAuthoritativeAcquisitionClosureV1({
    acquisition_closure_port: port,
    mandate: fixture.mandate,
    authorization: fixture.authorization,
    signed_intent_digest: fixture.evidence_graph.acquisition.signed_transaction_intent_digest,
    semantic_transaction_digest: fixture.evidence_graph.acquisition.signed_transaction_intent.semantic_transaction_digest,
    message_sha256: fixture.evidence_graph.acquisition.signed_transaction_intent.message_sha256,
    signed_transaction_signature: fixture.evidence_graph.acquisition.signed_transaction_intent.signature,
    signed_wire_sha256: fixture.evidence_graph.acquisition.signed_transaction_intent.signed_wire_sha256,
  });
  assert.equal(isAuthoritativeAcquisitionClosureProofV1(proof), true);
  assert.equal(proof.finalized_evidence_digest, fixture.evidence_graph.acquisition.finalized.finalized_evidence_digest);
  assert.equal(proof.chain_derived_acquired_jup_raw, '21437310');
  assert.equal(proof.finalized_transaction_digest, fixture.evidence_graph.acquisition.finalized.finalized_transaction_digest);
  assert.equal(isAuthoritativeAcquisitionClosureProofV1(structuredClone(proof)), false);
});

test('self-rehashed finalized evidence cannot substitute digest or acquired quantity', async () => {
  const fixture = await createBoundedAgentOfflineEpisodeFixtureV1();
  const original = fixture.evidence_graph.acquisition.finalized;
  const forged = buildFinalizedLegEvidenceV1({
    episode_id: original.episode_id,
    phase: original.phase,
    signed_intent_digest: original.signed_intent_digest,
    signed_wire_sha256: original.signed_wire_sha256,
    message_sha256: original.message_sha256,
    signature: original.signature,
    finalized_transaction_digest: original.finalized_transaction_digest,
    slot: original.slot,
    block_time: original.block_time,
    execution_status: original.execution_status,
    wallet: original.wallet,
    input_mint: original.input_mint,
    output_mint: original.output_mint,
    input_raw_quantity: original.input_raw_quantity,
    chain_derived_target_raw_quantity: '21437311',
  });
  const port = createOfflineAcquisitionClosurePortV1({
    capture_authority: async () => sourceFrom(fixture, forged),
  });
  await assert.rejects(() => captureAuthoritativeAcquisitionClosureV1({
    acquisition_closure_port: port,
    mandate: fixture.mandate,
    authorization: fixture.authorization,
    signed_intent_digest: fixture.evidence_graph.acquisition.signed_transaction_intent_digest,
    semantic_transaction_digest: fixture.evidence_graph.acquisition.signed_transaction_intent.semantic_transaction_digest,
    message_sha256: fixture.evidence_graph.acquisition.signed_transaction_intent.message_sha256,
    signed_transaction_signature: fixture.evidence_graph.acquisition.signed_transaction_intent.signature,
    signed_wire_sha256: fixture.evidence_graph.acquisition.signed_transaction_intent.signed_wire_sha256,
  }), error => error.code === 'bounded_agent_acquisition_closure_chain_mismatch');
  await assert.rejects(() => captureAuthoritativeAcquisitionClosureV1({
    acquisition_closure_port: createOfflineAcquisitionClosurePortV1({
      capture_authority: async () => sourceFrom(fixture),
    }),
    mandate: fixture.mandate,
    authorization: fixture.authorization,
    signed_intent_digest: fixture.evidence_graph.acquisition.signed_transaction_intent_digest,
    semantic_transaction_digest: fixture.evidence_graph.acquisition.signed_transaction_intent.semantic_transaction_digest,
    message_sha256: fixture.evidence_graph.acquisition.signed_transaction_intent.message_sha256,
    signed_transaction_signature: '4'.repeat(88),
    signed_wire_sha256: fixture.evidence_graph.acquisition.signed_transaction_intent.signed_wire_sha256,
  }), error => error.code === 'bounded_agent_acquisition_closure_economics_invalid');
});
