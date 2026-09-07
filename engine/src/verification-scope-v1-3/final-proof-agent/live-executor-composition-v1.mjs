import { assertExactFields, fail } from '../contract.mjs';

export const ARTIFACT_FINAL_PROOF_LIVE_EXECUTOR_STATUS_V1 = 'PASS_OFFLINE_LIVE_BLOCKED';

// This is the only intended production composition surface in the offline slice.
// It deliberately has no dependency on the offline executor core and cannot
// accept, load, or invoke a wallet signer. A later reviewed executor release
// must replace this fail-closed surface rather than extending it in place.
export function createArtifactFinalProofLiveExecutorV1(input) {
  assertExactFields(input, [], 'artifact_final_proof_live_executor_input');
  fail(
    'bounded_agent_live_executor_not_released',
    'production wallet loading, signing, submission, and scheduling remain mechanically unavailable',
  );
}
