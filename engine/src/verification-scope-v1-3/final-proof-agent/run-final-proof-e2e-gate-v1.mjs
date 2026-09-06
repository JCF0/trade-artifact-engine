import { canonicalJson } from '../contract.mjs';
import { runBoundedAgentFinalProofOfflineE2EGateV1 } from './final-proof-e2e-gate-v1.mjs';

const result = await runBoundedAgentFinalProofOfflineE2EGateV1();
process.stdout.write(canonicalJson(result));
process.exitCode = result.overall_status === 'PASS_OFFLINE_LIVE_BLOCKED' ? 0 : 1;
