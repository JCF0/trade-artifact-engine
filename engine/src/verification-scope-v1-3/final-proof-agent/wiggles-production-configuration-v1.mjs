import { cloneAndFreeze, fail } from '../contract.mjs';
import { assertLiveReadyBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { RECOVERED_SETUP_PROFILE_V2, assertLiveReadyRecoveredSetupMandateV2 } from './recovered-setup-v2.mjs';
import { OFFLINE_CONTROL_KEYS_V1 } from './executor-mandate-profile-v1.mjs';
import { validateWigglesRuntimeConfigurationV1 } from './wiggles-trusted-runtime-v1.mjs';

function reject() {
  fail('bounded_agent_production_configuration_blocked', 'explicit non-test production authority and unexpired configuration required');
}
// Structural/authentication preflight only. This is NOT release approval and
// cannot load keys, open authority, construct transport, or enable the live factory.
export function validateProductionWigglesConfigurationV1(configuration, now) {
  const input = cloneAndFreeze(configuration);
  if (input.mandate?.mandate_profile === RECOVERED_SETUP_PROFILE_V2) assertLiveReadyRecoveredSetupMandateV2(input.mandate);
  else assertLiveReadyBoundedAgentMandateV1(input.mandate); // Strict final-proof wallet/profile, never disposable.
  const c = validateWigglesRuntimeConfigurationV1(input, now);
  const live = c.mandate.unresolved_live_readiness, offline = c.mandate.offline_identity;
  for (const field of ['human_authorization_public_key', 'agent_control_public_key']) {
    if (OFFLINE_CONTROL_KEYS_V1.includes(live[field]) || /^(.)\1{63}$/.test(live[field])
        || [offline.human_authorization_public_key, offline.agent_control_public_key].includes(live[field])) reject();
  }
  for (const field of ['rpc_budget_table_sha256', 'executor_release_sha256']) {
    if (live[field] === offline[field] || /^(.)\1{63}$/.test(live[field])) reject();
  }
  for (const field of [input.mandate.mandate_profile === RECOVERED_SETUP_PROFILE_V2 ? 'custodian_attestation_sha256' : 'setup_archive_sha256',
    'setup_freeze_sha256', 'setup_evidence_manifest_sha256']) {
    if (/^(.)\1{63}$/.test(c.mandate.setup_authority[field])) reject();
  }
  if (now < c.authorization.not_before_unix_seconds || now >= live.acquisition_not_after_unix_seconds) reject();
  return c;
}
