import { cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import {
  BOUNDED_AGENT_MANDATE_VERSION_V1, BOUNDED_AGENT_MANDATE_PROFILE_V1,
  buildBoundedAgentMandateV1, validateBoundedAgentMandateV1, assertLiveReadyBoundedAgentMandateV1,
} from './mandate-v1.mjs';

export const OFFLINE_WALLET_PROFILE_V1 = 'ARTIFACT_DISPOSABLE_WALLET_OFFLINE_TEST_ONLY_V1';
export const OFFLINE_WALLET_SCOPE_V1 = Object.freeze({
  wallet: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
  jup_ata: '4MrBbrbnZFCcxWh8gtX57onPMuvB9SBCz3rsBAbQTYZ1',
  usdc_ata: '7woc3ajaGMMXczFYjxon4aQoHH3j126fMUR9c58eHRsK',
});
export const OFFLINE_CONTROL_KEYS_V1 = Object.freeze([
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
]);
const FINAL_WALLET = Object.freeze({
  wallet: '5CJdSbz9d5CifzFcWL5NcbicgpSAEuDGpSZBgaLHN1tA',
  jup_ata: '4HgYhw4FSPPGwhAs65vWFxHLyGbTNUVfZcTtKVteP6E2',
  usdc_ata: 'Db7uFgxUjDFpngThm18ho6DxK9gsFcA6AZKX8ryPPBe7',
});
function identity(value) {
  const { mandate_id, mandate_digest, ...preimage } = value;
  const digest = sha256CanonicalJson(preimage);
  return { ...preimage, mandate_id: `bounded-agent-mandate-${digest}`, mandate_digest: digest };
}
// Separate test domain; the frozen final-proof validator is unchanged. Only these
// public disposable identities may use the alternate domain, never a real wallet.
export function buildOfflineWalletMandateV1(input) {
  const base = buildBoundedAgentMandateV1(input);
  const result = identity({ ...base, mandate_version: OFFLINE_WALLET_PROFILE_V1,
    mandate_profile: OFFLINE_WALLET_PROFILE_V1,
    wallet_scope: { ...base.wallet_scope, ...OFFLINE_WALLET_SCOPE_V1 } });
  validateExecutorMandateV1(result);
  return cloneAndFreeze(result);
}
export function validateExecutorMandateV1(value) {
  const v = cloneAndFreeze(value);
  if (v.mandate_profile !== OFFLINE_WALLET_PROFILE_V1) return validateBoundedAgentMandateV1(v);
  if (v.mandate_version !== OFFLINE_WALLET_PROFILE_V1
      || Object.entries(OFFLINE_WALLET_SCOPE_V1).some(([k, x]) => v.wallet_scope[k] !== x)
      || v.offline_identity.human_authorization_public_key !== OFFLINE_CONTROL_KEYS_V1[0]
      || v.offline_identity.agent_control_public_key !== OFFLINE_CONTROL_KEYS_V1[1]
      || sha256CanonicalJson(identity(v)) !== sha256CanonicalJson(v)) {
    fail('bounded_agent_test_mandate_invalid', 'separate disposable test identity required');
  }
  if (v.unresolved_live_readiness.status === 'RESOLVED') {
    for (const field of Object.keys(v.unresolved_live_readiness).filter(k => k !== 'status')) {
      if (v.unresolved_live_readiness[field] !== v.offline_identity[field]) {
        fail('bounded_agent_test_mandate_invalid', 'test authority must remain test-only');
      }
    }
  }
  return validateBoundedAgentMandateV1(identity({ ...v,
    mandate_version: BOUNDED_AGENT_MANDATE_VERSION_V1, mandate_profile: BOUNDED_AGENT_MANDATE_PROFILE_V1,
    wallet_scope: { ...v.wallet_scope, ...FINAL_WALLET } }));
}
export function assertConfiguredExecutorMandateV1(value) {
  if (value?.mandate_profile !== OFFLINE_WALLET_PROFILE_V1) return assertLiveReadyBoundedAgentMandateV1(value);
  validateExecutorMandateV1(value);
  if (value.unresolved_live_readiness.status !== 'RESOLVED') {
    fail('bounded_agent_live_readiness_unresolved', 'explicit test configuration required');
  }
  return true;
}
