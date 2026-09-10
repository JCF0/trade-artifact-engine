import { assertExactFields, cloneAndFreeze, sha256CanonicalJson } from '../contract.mjs';
import { validateSupervisedRpcBudgetV1 } from './supervised-rpc-v1.mjs';
export const SUPERVISED_SUBMISSION_PROFILE_V1 = 'SUPERVISED_FIXED_RPC_SUBMISSION_V1';
export const SUPERVISED_BUDGET_VERSION_V1 = 'artifact_supervised_phase_budgets_v1';
const TRANSPORTS = new WeakSet();
function stop() { throw Error('SUPERVISED_CONSTRUCTION_INVALID'); }
export function validateSupervisedPhaseBudgetsV1(value) {
  const b = cloneAndFreeze(value);
  assertExactFields(b, ['version', 'capture', 'simulation', 'submission', 'economic_source'], 'supervised_phase_budgets');
  if (b.version !== SUPERVISED_BUDGET_VERSION_V1) stop();
  validateSupervisedRpcBudgetV1(b.simulation, 'simulation');
  validateSupervisedRpcBudgetV1(b.economic_source, 'economic_source');
  assertExactFields(b.submission, ['profile', 'max_calls', 'overall_timeout_ms', 'max_response_bytes'], 'supervised_submission_budget');
  if (b.submission.profile !== SUPERVISED_SUBMISSION_PROFILE_V1 || b.simulation.total_calls !== 1
    || b.simulation.methods.simulateTransaction !== 1 || Object.keys(b.simulation.methods).length !== 1) stop();
  for (const [k, max] of Object.entries({ max_calls: 188, overall_timeout_ms: 190000, max_response_bytes: 1048576 })) {
    if (!Number.isSafeInteger(b.submission[k]) || b.submission[k] < 1 || b.submission[k] > max) stop();
  }
  return b;
}
// The supervisor alone installs this fixed no-retry exchange at construction.
// No agent-controlled transport, options, endpoint, or effect hook is accepted.
export function createSupervisedSubmissionTransportV1(exchange) {
  if (typeof exchange !== 'function') stop();
  const transport = request => exchange(request);
  TRANSPORTS.add(transport);
  return transport;
}
export function assertSupervisedSubmissionConstructionV1(c, submission) {
  const b = validateSupervisedPhaseBudgetsV1(c.budget);
  if (sha256CanonicalJson(b) !== c.mandate.unresolved_live_readiness.rpc_budget_table_sha256
    || !TRANSPORTS.has(submission.transport)
    || sha256CanonicalJson(Object.fromEntries(['profile', 'max_calls', 'overall_timeout_ms', 'max_response_bytes'].map(k => [k, submission[k]])))
      !== sha256CanonicalJson(b.submission)) stop();
}
