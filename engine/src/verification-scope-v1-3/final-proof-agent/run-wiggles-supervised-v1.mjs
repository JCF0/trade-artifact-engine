import { createArtifactFinalProofLiveExecutorV1 } from './live-executor-composition-v1.mjs';

// Deliberately no argument/environment/configuration/key/channel processing before
// the immutable release block. A reviewed source release, not an enable flag, is
// required to bind a production supervisor. No daemon or transport is started.
try {
  createArtifactFinalProofLiveExecutorV1({});
} catch {
  process.stderr.write('bounded_agent_live_executor_not_released\n');
  process.exitCode = 1;
}
