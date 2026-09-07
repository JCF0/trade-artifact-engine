import assert from 'node:assert/strict';
import test from 'node:test';

import * as release from './live-executor-composition-v1.mjs';

test('intended production composition is mechanically blocked and exposes no signer bypass', () => {
  assert.deepEqual(Object.keys(release).sort(), [
    'ARTIFACT_FINAL_PROOF_LIVE_EXECUTOR_STATUS_V1',
    'createArtifactFinalProofLiveExecutorV1',
  ]);
  assert.equal(release.ARTIFACT_FINAL_PROOF_LIVE_EXECUTOR_STATUS_V1, 'PASS_OFFLINE_LIVE_BLOCKED');
  let signerCalls = 0;
  assert.throws(() => release.createArtifactFinalProofLiveExecutorV1({
    wallet_signer_port: { signAdmittedTransactionV1() { signerCalls += 1; } },
  }));
  assert.throws(() => release.createArtifactFinalProofLiveExecutorV1({}),
    error => error.code === 'bounded_agent_live_executor_not_released');
  assert.equal(signerCalls, 0);
});
