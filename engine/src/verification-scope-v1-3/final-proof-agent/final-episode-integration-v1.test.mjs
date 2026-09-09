import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCandidateMemberDigestV13 } from '../explicit-candidate-selection.mjs';
import { reconstructFinalEpisodeReleaseV1 } from './final-episode-release-v1.mjs';
import { canonicalJson } from '../contract.mjs';

let base;
async function fixture() {
  base ??= import('./fixtures/retained-final-episode-v1.mjs').then(m => m.retainedFinalEpisodeFixtureV1());
  const f = await base;
  return { ...f, descriptor: structuredClone(f.descriptor), control: structuredClone(f.control), files: new Map([...f.files].map(([p, b]) => [p, Buffer.from(b)])) };
}
function edit(f, p, action) { const v = JSON.parse(f.files.get(p)); action(v); f.files.set(p, Buffer.from(canonicalJson(v))); }
async function evaluate(f) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-final-case-'));
  try { return await reconstructFinalEpisodeReleaseV1(f.write(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function acquisitionOnly(f) {
  f.descriptor.selection = null; f.descriptor.transactions.pop(); f.control.legs.pop();
  edit(f, 'history.json', v => v.result.shift());
  edit(f, 'ending-classic.json', v => { const data = Buffer.from(v.result.value[0].account.data[0], 'base64');
    data.writeBigUInt64LE(BigInt(f.control.legs[0].finalized.chain_derived_target_raw_quantity), 64); v.result.value[0].account.data[0] = data.toString('base64'); });
}

test('complete retained synthetic episode independently establishes original eligibility, authenticated direction and exact transmission', async () => {

  const root = mkdtempSync(join(tmpdir(), 'artifact-final-replay-'));
  try {
    const f = await fixture();
    const preview = await reconstructFinalEpisodeReleaseV1(f.write(root));
    assert.equal(preview.selection, null);
    const row = preview.population.episode_dispositions[0];
    f.descriptor.selection = { candidate_population_digest: preview.population.population_digest,
      requested_candidate_digest: computeCandidateMemberDigestV13({ candidate_population_digest: preview.population.population_digest, episode_disposition: row }) };
    (await base).descriptor.selection = f.descriptor.selection;
    const result = await reconstructFinalEpisodeReleaseV1(f.write(root));
    assert.equal(result.claim.claim_evaluation.claim_outcome, 'VERIFIED');
    assert.equal(result.eligibility.status, 'ELIGIBLE');
    assert.equal(result.control.status, 'AUTHENTICATED');
    assert.equal(result.transmission.status, 'RECONCILED');
    assert.equal(result.demonstration.contract_satisfied, true);
    assert.equal(result.demo_summary.full_demonstration_success, false);
    assert.equal(result.demo_summary.synthetic_demonstration_success, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('acquisition-only retains independently observed inventory and refuses to manufacture a two-leg economic claim', async () => {
  const f = await fixture(); acquisitionOnly(f);
  const result = await evaluate(f);
  assert.equal(result.operation.status, 'COMPLETED'); assert.equal(result.claim, null); assert.equal(result.population, null);
  assert.equal(result.economic_availability.status, 'UNAVAILABLE');
  assert.equal(result.economic_availability.dependencies[0].code, 'position_economic_controlled_boundary_invalid');
  assert.equal(result.control.state.state, 'ACQUISITION_EVIDENCE_CLOSED');
  assert.equal(result.control.status, 'AUTHENTICATED');
  assert.equal(result.transaction_reconciliation.length, 1);
  assert.equal(result.economic_observations.ending_target_raw_quantity, f.control.legs[0].finalized.chain_derived_target_raw_quantity);
  assert.equal(result.demonstration.contract_satisfied, false);
});
