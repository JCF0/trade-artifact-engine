import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256CanonicalJson } from '../contract.mjs';
import {
  buildEpisodeEvidenceGraphV1,
  buildReconstructionEvidenceV1,
  validateEpisodeEvidenceGraphStructureV1,
} from './episode-evidence-graph-v1.mjs';
import {
  captureFinalizedEvidenceAuthorityV1,
} from './finalized-evidence-adapter-v1.mjs';
import {
  BOUNDED_AGENT_FINAL_PROOF_GATE_RESULT_SHA256_V1,
  runBoundedAgentFinalProofOfflineE2EGateV1,
  validateBoundedAgentFinalProofGateResultV1,
} from './final-proof-e2e-gate-v1.mjs';
import { createBoundedAgentOfflineEpisodeFixtureV1 } from './fixtures/bounded-agent-offline-v1.mjs';

async function fixture() { return createBoundedAgentOfflineEpisodeFixtureV1(); }

test('closed episode graph binds authorization through finalized evidence and v1.3 reconstruction', async () => {
  const source = await fixture();
  assert.equal(validateEpisodeEvidenceGraphStructureV1(source.evidence_graph), true);
  assert.equal(source.evidence_graph.outcome.status, 'CLAIM_VERIFIED_CLOSED');
  assert.equal(source.evidence_graph.reconstruction.claim_outcome, 'VERIFIED');
  assert.equal(source.evidence_graph.reconstruction.position_state, 'CLOSED');
  assert.equal(source.evidence_graph.acquisition.finalized.chain_derived_target_raw_quantity, '21437310');
  assert.equal(source.evidence_graph.disposal.finalized.input_raw_quantity, '21437310');
  assert.equal(source.signer_calls, 2);
});

test('finalized adapter recaptures existing v1.3 source authority and refuses unregistered ports', async () => {
  const source = await fixture();
  const captured = await captureFinalizedEvidenceAuthorityV1({
    finalized_evidence_port: source.finalized_evidence_port,
    evidence_graph: source.evidence_graph,
  });
  assert.equal(captured.context.evidence_context_digest, source.context.evidence_context_digest);
  assert.equal(typeof captured.economic_evidence_port.captureAuthoritativePositionEconomicsV13, 'function');
  await assert.rejects(() => captureFinalizedEvidenceAuthorityV1({
    finalized_evidence_port: { async captureFinalizedEvidenceAuthorityV1() { return captured; } },
    evidence_graph: source.evidence_graph,
  }), error => error.code === 'bounded_agent_finalized_evidence_port_denied');
});

test('counterfeit self-rehashed child evidence and cross-episode substitution fail closed', async () => {
  const source = await fixture();
  const counterfeit = structuredClone(source.evidence_graph);
  counterfeit.acquisition.finalized.chain_derived_target_raw_quantity = '1';
  assert.throws(() => buildEpisodeEvidenceGraphV1({
    mandate: counterfeit.mandate,
    authorization: counterfeit.human_authorization,
    acquisition: counterfeit.acquisition,
    disposal: counterfeit.disposal,
    reconstruction: counterfeit.reconstruction,
    outcome: counterfeit.outcome,
  }), error => ['bounded_agent_finalized_evidence_identity_invalid', 'bounded_agent_episode_evidence_chain_mismatch'].includes(error.code));

  const other = await createBoundedAgentOfflineEpisodeFixtureV1({ episode_nonce_suffix: '-other' });
  assert.throws(() => buildEpisodeEvidenceGraphV1({
    mandate: source.evidence_graph.mandate,
    authorization: source.evidence_graph.human_authorization,
    acquisition: other.evidence_graph.acquisition,
    disposal: source.evidence_graph.disposal,
    reconstruction: source.evidence_graph.reconstruction,
    outcome: source.evidence_graph.outcome,
  }), error => ['bounded_agent_episode_evidence_chain_mismatch', 'bounded_agent_decision_context_mismatch'].includes(error.code));
});

test('claim promotion cannot use agent provenance without finalized chain authority', async () => {
  const source = await fixture();
  const forged = structuredClone(source.evidence_graph);
  forged.reconstruction.evidence_context_digest = '0'.repeat(64);
  assert.throws(() => validateEpisodeEvidenceGraphStructureV1(forged));
  await assert.rejects(() => captureFinalizedEvidenceAuthorityV1({
    finalized_evidence_port: {}, evidence_graph: source.evidence_graph,
  }), error => error.code === 'bounded_agent_finalized_evidence_port_denied');

  const counterfeitResult = structuredClone(await runBoundedAgentFinalProofOfflineE2EGateV1());
  counterfeitResult.evidence_context_digest = '0'.repeat(64);
  counterfeitResult.gate_result_sha256 = sha256CanonicalJson(Object.fromEntries(
    Object.entries(counterfeitResult).filter(([field]) => field !== 'gate_result_sha256'),
  ));
  await assert.rejects(() => validateBoundedAgentFinalProofGateResultV1(counterfeitResult, {
    evidence_graph: source.evidence_graph,
    finalized_evidence_port: source.finalized_evidence_port,
  }), error => error.code === 'bounded_agent_final_proof_gate_source_mismatch');

  for (const field of ['economic_evidence_digest', 'position_episode_digest', 'claim_evaluation_digest', 'candidate_digest']) {
    const reconstructionInput = Object.fromEntries(Object.entries(source.evidence_graph.reconstruction)
      .filter(([name]) => !['reconstruction_evidence_version', 'reconstruction_id', 'reconstruction_digest'].includes(name)));
    reconstructionInput[field] = 'f'.repeat(64);
    const forgedGraph = buildEpisodeEvidenceGraphV1({
      mandate: source.evidence_graph.mandate,
      authorization: source.evidence_graph.human_authorization,
      acquisition: source.evidence_graph.acquisition,
      disposal: source.evidence_graph.disposal,
      reconstruction: buildReconstructionEvidenceV1(reconstructionInput),
      outcome: source.evidence_graph.outcome,
    });
    const forgedResult = structuredClone(await runBoundedAgentFinalProofOfflineE2EGateV1());
    forgedResult.episode_evidence_graph_id = forgedGraph.episode_evidence_graph_id;
    forgedResult.episode_evidence_graph_digest = forgedGraph.episode_evidence_graph_digest;
    forgedResult.gate_result_sha256 = sha256CanonicalJson(Object.fromEntries(
      Object.entries(forgedResult).filter(([name]) => name !== 'gate_result_sha256'),
    ));
    await assert.rejects(() => validateBoundedAgentFinalProofGateResultV1(forgedResult, {
      evidence_graph: forgedGraph,
      finalized_evidence_port: source.finalized_evidence_port,
    }), error => error.code === 'bounded_agent_final_proof_gate_source_mismatch');
  }
});

test('episode graph rejects accessors, proxies, and custom prototypes without getter execution', async () => {
  const source = await fixture();
  let getterCalls = 0;
  const accessor = structuredClone(source.evidence_graph);
  Object.defineProperty(accessor, 'mandate', { enumerable: true, get() { getterCalls += 1; return {}; } });
  assert.throws(() => validateEpisodeEvidenceGraphStructureV1(accessor), error => error.code === 'accessor_not_allowed');
  assert.equal(getterCalls, 0);
  assert.throws(() => validateEpisodeEvidenceGraphStructureV1(new Proxy(source.evidence_graph, {})), error => error.code === 'proxy_not_allowed');
  assert.throws(() => validateEpisodeEvidenceGraphStructureV1(Object.assign(Object.create(null), source.evidence_graph)),
    error => error.code === 'custom_prototype_not_allowed');
});

test('offline final-proof gate is byte-stable, VERIFIED/CLOSED, and mechanically live-blocked', async () => {
  const first = await runBoundedAgentFinalProofOfflineE2EGateV1();
  const second = await runBoundedAgentFinalProofOfflineE2EGateV1();
  assert.equal(canonicalJson(first), canonicalJson(second));
  const source = await fixture();
  assert.equal(await validateBoundedAgentFinalProofGateResultV1(first, {
    evidence_graph: source.evidence_graph,
    finalized_evidence_port: source.finalized_evidence_port,
  }), true);
  await assert.rejects(() => validateBoundedAgentFinalProofGateResultV1(first),
    error => error.code === 'bounded_agent_final_proof_gate_authority_missing');
  assert.equal(first.overall_status, 'PASS_OFFLINE_LIVE_BLOCKED');
  assert.deepEqual(first.unresolved_live_readiness, [
    'REAL_HUMAN_AUTHORIZATION_PUBLIC_KEY',
    'REAL_AGENT_CONTROL_PUBLIC_KEY',
    'ACQUISITION_NOT_AFTER_UNIX_SECONDS',
    'LIVE_RPC_BUDGET_TABLE_SHA256',
    'FINAL_WIGGLES_EXECUTOR_RELEASE_SHA256',
  ]);
  assert.equal(first.claim_outcome, 'VERIFIED');
  assert.equal(first.position_state, 'CLOSED');
  assert.equal(first.gate_result_sha256, BOUNDED_AGENT_FINAL_PROOF_GATE_RESULT_SHA256_V1);
});
