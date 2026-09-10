import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256CanonicalJson, canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { validateProductionWigglesConfigurationV1 } from '../../src/verification-scope-v1-3/final-proof-agent/wiggles-production-configuration-v1.mjs';
import { validateWigglesRuntimeConfigurationV1 } from '../../src/verification-scope-v1-3/final-proof-agent/wiggles-trusted-runtime-v1.mjs';
import { OFFLINE_WALLET_PROFILE_V1 } from '../../src/verification-scope-v1-3/final-proof-agent/executor-mandate-profile-v1.mjs';
import { createAuthorizedEpisodeStateV1 } from '../../src/verification-scope-v1-3/final-proof-agent/episode-state-machine-v1.mjs';
import { provisionCrashDurableDecisionAuthorityV1 } from '../../src/verification-scope-v1-3/final-proof-agent/sqlite-decision-authority-v1.mjs';
import { provisionSupervisedJournalV1, createSupervisedJournalV1 } from '../../src/verification-scope-v1-3/final-proof-agent/supervised-journal-v1.mjs';
import { validateSupervisedPhaseBudgetsV1 } from '../../src/verification-scope-v1-3/final-proof-agent/supervised-profile-v1.mjs';
import { blocked, privateDirectoryV1, fsyncDirectoryV1, readPrivateRecordV1, exclusiveRecordV1 } from './io.mjs';
const started = c => ({ version: 'artifact_private_provision_v1', configuration_sha256: sha256CanonicalJson(c),
  disposition: 'STOP_UNLESS_COMPLETION_VERIFIED' });
const complete = c => ({ version: 'artifact_private_provision_completion_v1', configuration_sha256: sha256CanonicalJson(c), status: 'PROVISIONED' });
// Explicit first-time administrator library operation. No CLI dispatch or launch
// path invokes this API. Public production validation is unchanged.
export function provisionPrivateBindingV1(configuration) {
  return provision(validateProductionWigglesConfigurationV1(configuration, Math.floor(Date.now()/1000)));
}
export function provisionFixtureBindingV1(configuration, now) {
  const c = validateWigglesRuntimeConfigurationV1(configuration, now);
  if (c.mandate.mandate_profile !== OFFLINE_WALLET_PROFILE_V1) throw blocked();
  return provision(c);
}
function provision(c) {
  validateSupervisedPhaseBudgetsV1(c.budget);
  const root = c.state_root, before = privateDirectoryV1(root);
  if (readdirSync(root).length !== 0) throw blocked();
  // This exclusive, synced start marker is intentionally never deleted. Loss of
  // any later output leaves STOP, not a startup invitation to repair/reset.
  exclusiveRecordV1(join(root, 'binding-provision-started.json'), started(c)); fsyncDirectoryV1(root, before);
  try {
    provisionCrashDurableDecisionAuthorityV1({ state_root: root,
      initial_episode_state: createAuthorizedEpisodeStateV1({ mandate: c.mandate, authorization: c.authorization }),
      executor_release_sha256: c.executor_release_sha256 });
    provisionSupervisedJournalV1(root);
    exclusiveRecordV1(join(root, 'binding-provision-complete.json'), complete(c)); fsyncDirectoryV1(root, before);
    verifyProvisionedBindingV1(c); return Object.freeze({ status: 'PROVISIONED' });
  } catch {
    // Never remove a partial completion. A failure tombstone overrides it.
    // If the volume cannot persist this record either, the externally missing
    // PROVISIONED acknowledgment is itself STOP; no automatic launch is allowed.
    try {
      exclusiveRecordV1(join(root, 'binding-provision-stopped.json'), { status: 'STOPPED_NO_REENROLLMENT' });
      fsyncDirectoryV1(root, before);
    } catch { /* Preserve start/partial stores; administrator must stop. */ }
    throw blocked();
  }
}
export function verifyProvisionedBindingV1(c) {
  privateDirectoryV1(c.state_root);
  if (readdirSync(c.state_root).includes('binding-provision-stopped.json')) throw blocked();
  if (canonicalJson(readPrivateRecordV1(join(c.state_root, 'binding-provision-started.json'))) !== canonicalJson(started(c))
    || canonicalJson(readPrivateRecordV1(join(c.state_root, 'binding-provision-complete.json'))) !== canonicalJson(complete(c))) throw blocked();
  createSupervisedJournalV1(c.state_root); // Existing head only; no repair.
}
