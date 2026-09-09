import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../contract.mjs';
import { computeCandidateMemberDigestV13 } from '../explicit-candidate-selection.mjs';
import { reconstructFinalEpisodeReleaseV1 } from './final-episode-release-v1.mjs';
import { validateRetainedSubmissionSnapshotV1 } from './wiggles-submission-v1.mjs';
import { canonicalJson as submissionJson } from './reused/bounded-rebroadcast-v1.mjs';
import { retainedFinalEpisodeFixtureV1 } from './fixtures/retained-final-episode-v1.mjs';
import { hash } from './fixtures/retained-episode-offline-v1.mjs';

let base;
async function fixture() {
  base ??= retainedFinalEpisodeFixtureV1();
  const f = await base;
  return { ...f, descriptor: structuredClone(f.descriptor), control: structuredClone(f.control),
    files: new Map([...f.files].map(([p, b]) => [p, Buffer.from(b)])) };
}
async function evaluate(f, select = true) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-fee-binding-'));
  try {
    f.descriptor.selection = null;
    const preview = await reconstructFinalEpisodeReleaseV1(f.write(root));
    if (!select) return preview;
    const row = preview.population.episode_dispositions[0];
    f.descriptor.selection = { candidate_population_digest: preview.population.population_digest,
      requested_candidate_digest: computeCandidateMemberDigestV13({ candidate_population_digest: preview.population.population_digest, episode_disposition: row }) };
    return await reconstructFinalEpisodeReleaseV1(f.write(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// Change only provider metadata, then propagate its unsigned byte/hash references
// through the existing closed submission DAG. Never rebuild or sign any wire.
function alterFinalizedFee(f, ordinal, fee) {
  const leg = f.control.legs[ordinal - 1];
  const names = new Map(leg.submission_members.map(x => [x.path, x.member]));
  const original = new Map([...names].map(([p, member]) => [p, f.files.get(member)]));
  const files = new Map(original), changes = new Map();
  function replace(path, bytes) {
    const old = files.get(path);
    if (old.equals(bytes)) return false;
    changes.set(hash(old), { sha256: hash(bytes), bytes: bytes.length });
    files.set(path, bytes); return true;
  }
  function mutate(raw) {
    const meta = raw.result.meta;
    meta.fee = fee;
    // Keep the raw native debit coherent at the largest supported integer too.
    if (fee > meta.preBalances[0]) meta.preBalances[0] = fee;
    meta.postBalances[0] = Number(BigInt(meta.preBalances[0]) - BigInt(fee));
  }
  const sourcePath = f.descriptor.transactions[ordinal - 1].response;
  const source = JSON.parse(f.files.get(sourcePath)); mutate(source);
  f.files.set(sourcePath, Buffer.from(canonicalJson(source)));
  const rawPath = 'terminal/finalized-transaction-raw-response.json';
  const raw = JSON.parse(files.get(rawPath)); mutate(raw);
  replace(rawPath, Buffer.from(JSON.stringify(raw)));
  assert.deepEqual(raw.result, source.result);
  function rewrite(value) {
    if (typeof value === 'string') return changes.get(value)?.sha256 ?? value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
    for (const [hashField, sizeField] of [['sha256', 'bytes'], ['raw_sha256', 'raw_bytes']]) {
      if (changes.has(value[hashField]) && Object.hasOwn(value, sizeField)) result[sizeField] = changes.get(value[hashField]).bytes;
    }
    return result;
  }
  let stable = false;
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;
    for (const [path, bytes] of files) {
      if (path.endsWith('SHA256SUMS')) {
        changed = replace(path, Buffer.from(bytes.toString().replace(/[0-9a-f]{64}/g, h => changes.get(h)?.sha256 ?? h))) || changed;
      } else if (!path.endsWith('-raw-response.json')) {
        const value = JSON.parse(bytes), next = rewrite(value);
        if (canonicalJson(value) !== canonicalJson(next)) {
          // Executor records and scheduler records have different serializers.
          const encoded = submissionJson(value).equals(bytes) ? submissionJson(next) : Buffer.from(canonicalJson(next));
          changed = replace(path, encoded) || changed;
        }
      }
    }
    if (!changed) { stable = true; break; }
  }
  assert.equal(stable, true, 'unsigned submission hash graph must converge');
  for (const path of ['binding.json', 'signed-intent.json']) assert.deepEqual(files.get(path), original.get(path));
  const verified = validateRetainedSubmissionSnapshotV1({
    members: [...files].map(([path, b]) => ({ path, base64: b.toString('base64') })),
    expected_binding: JSON.parse(original.get('binding.json')),
  });
  assert.equal(verified.classification, source.result.meta.err === null ? 'FINALIZED_SUCCESS' : 'FINALIZED_FAILURE');
  for (const [path, bytes] of files) f.files.set(names.get(path), bytes);
  // Optional producer carrier is absent, not a stale claim that masks fee checking.
  leg.finalized = null;
}

test('fee binding rejects the fully rehashed authenticated disposal counterexample without changing economics', async () => {
  const f = await fixture(), originalControl = structuredClone(f.control);
  alterFinalizedFee(f, 2, 5001);
  assert.deepEqual(f.control.authorization, originalControl.authorization);
  for (let i = 0; i < 2; i++) for (const field of ['challenge', 'decision', 'admission', 'signed_intent']) {
    assert.deepEqual(f.control.legs[i][field], originalControl.legs[i][field]);
  }
  const result = await evaluate(f);
  assert.equal(result.integrity.status, 'VERIFIED');
  assert.equal(result.claim.claim_evaluation.claim_outcome, 'VERIFIED');
  assert.equal(result.claim.claim_evaluation.position_state, 'CLOSED');
  assert.equal(result.eligibility.status, 'ELIGIBLE');
  assert.equal(result.transmission.status, 'RECONCILED');
  assert.equal(result.economic_observations.transactions[1].fee_lamports, 5001);
  assert.equal(result.demonstration.contract_satisfied, false);
  assert.equal(result.demo_summary.synthetic_demonstration_success, false);
  assert.equal(result.demo_summary.full_demonstration_success, false);
  assert.equal(result.control.status, 'INVALID');
  assert.equal(result.control.issues[0].code, 'FINALIZED_FEE_MISMATCH');
});

function acquisitionOnly(f) {
  f.descriptor.transactions.pop(); f.control.legs.pop();
  const history = JSON.parse(f.files.get('history.json')); history.result.shift();
  f.files.set('history.json', Buffer.from(canonicalJson(history)));
  const ending = JSON.parse(f.files.get('ending-classic.json'));
  const b = Buffer.from(ending.result.value[0].account.data[0], 'base64');
  b.writeBigUInt64LE(BigInt(f.control.legs[0].finalized.chain_derived_target_raw_quantity), 64);
  ending.result.value[0].account.data[0] = b.toString('base64');
  f.files.set('ending-classic.json', Buffer.from(canonicalJson(ending)));
}
function assertFeeRefusal(result, ordinal, fee) {
  assert.equal(result.control.status, 'INVALID');
  assert.equal(result.control.issues[0].code, 'FINALIZED_FEE_MISMATCH');
  assert.equal(result.transmission.status, 'RECONCILED');
  assert.equal(result.economic_observations.transactions[ordinal - 1].fee_lamports, fee);
  assert.equal(result.control.state.state, ordinal === 1 ? 'ACQUISITION_SUBMISSION_RESOLVING' : 'DISPOSAL_SUBMISSION_RESOLVING');
  assert.equal(result.demonstration.contract_satisfied, false);
  assert.equal(result.demo_summary.synthetic_demonstration_success, false);
  assert.equal(result.demo_summary.full_demonstration_success, false);
}
test('fee binding preserves matching authorized fees and complete synthetic success for both legs', async () => {
  const f = await fixture();
  for (const ordinal of [1, 2]) alterFinalizedFee(f, ordinal, 5000);
  const result = await evaluate(f);
  assert.equal(result.control.status, 'AUTHENTICATED');
  assert.equal(result.transmission.status, 'RECONCILED');
  assert.equal(result.claim.claim_evaluation.claim_outcome, 'VERIFIED');
  assert.equal(result.demonstration.contract_satisfied, true);
  assert.equal(result.demo_summary.synthetic_demonstration_success, true);
  assert.equal(result.demo_summary.full_demonstration_success, false);
  assert.deepEqual(result.economic_observations.transactions.map(t => String(t.fee_lamports)),
    [f.control.mandate.opening_contract.acquisition_fee_lamports, f.control.mandate.opening_contract.disposal_fee_lamports]);
});
test('fee binding preserves the existing economic refusal for a rehashed zero-fee disposal', async () => {
  const f = await fixture(); alterFinalizedFee(f, 2, 0);
  await assert.rejects(() => evaluate(f), error => error.code === 'position_economic_native_evidence_unresolved');
});
for (const fee of [4999, Number.MAX_SAFE_INTEGER]) {
  test(`fee binding rejects rehashed disposal fee ${fee} exactly, preserving supported economics`, async () => {
    const f = await fixture(); alterFinalizedFee(f, 2, fee);
    const result = await evaluate(f);
    assertFeeRefusal(result, 2, fee);
    assert.equal(result.claim.claim_evaluation.claim_outcome, 'VERIFIED');
    assert.equal(result.claim.claim_evaluation.position_state, 'CLOSED');
  });
}
for (const fee of [0, 4999, 5001]) {
  test(`fee binding rejects rehashed acquisition-only fee ${fee} without rewriting observations`, async () => {
    const f = await fixture(); acquisitionOnly(f); alterFinalizedFee(f, 1, fee);
    const result = await evaluate(f, false);
    assertFeeRefusal(result, 1, fee);
    assert.equal(result.claim, null);
    assert.equal(result.economic_availability.dependencies[0].code, 'position_economic_controlled_boundary_invalid');
    assert.notEqual(result.economic_observations.ending_target_raw_quantity, '0');
  });
}
test('fee binding preserves matching acquisition-only closure and observed fees', async () => {
  const f = await fixture(); acquisitionOnly(f); alterFinalizedFee(f, 1, 5000);
  const result = await evaluate(f, false);
  assert.equal(result.control.status, 'AUTHENTICATED');
  assert.equal(result.control.state.state, 'ACQUISITION_EVIDENCE_CLOSED');
  assert.equal(result.economic_observations.transactions[0].fee_lamports, 5000);
  assert.equal(result.claim, null);
  assert.equal(result.demonstration.contract_satisfied, false);
});
test('fee binding flags a rehashed finalized-failure fee while preserving failure and its actual fee', async () => {
  const f = await retainedFinalEpisodeFixtureV1({ failed: true });
  alterFinalizedFee(f, 1, 5001);
  const result = await evaluate(f, false);
  assertFeeRefusal(result, 1, 5001);
  assert.equal(result.transmission.legs[0].terminal_classification, 'FINALIZED_FAILURE');
  assert.equal(result.transaction_reconciliation[0].finalized_execution_state, 'failed');
  assert.equal(result.claim, null);
});
for (const fee of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`fee binding source rejects invalid finalized integer ${fee} before economic authority`, async () => {
    const f = await fixture(), path = f.descriptor.transactions[1].response;
    const raw = JSON.parse(f.files.get(path)); raw.result.meta.fee = fee;
    f.files.set(path, Buffer.from(canonicalJson(raw)));
    await assert.rejects(() => evaluate(f), error => ['malformed_provider_response', 'RETAINED_JSON_NUMBER_INVALID'].includes(error.code));
  });
}
