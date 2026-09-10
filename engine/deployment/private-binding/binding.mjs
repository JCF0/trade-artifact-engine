import { constants, closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { assertExactFields, cloneAndFreeze, sha256CanonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { validateProductionWigglesConfigurationV1 } from '../../src/verification-scope-v1-3/final-proof-agent/wiggles-production-configuration-v1.mjs';
import { validateWigglesRuntimeConfigurationV1, createPrivateSupervisedWigglesRuntimeV1,
  createOfflineSupervisedWigglesRuntimeV1 } from '../../src/verification-scope-v1-3/final-proof-agent/wiggles-trusted-runtime-v1.mjs';
import { OFFLINE_WALLET_PROFILE_V1 } from '../../src/verification-scope-v1-3/final-proof-agent/executor-mandate-profile-v1.mjs';
import { createSupervisedJournalV1 } from '../../src/verification-scope-v1-3/final-proof-agent/supervised-journal-v1.mjs';
import { validateSupervisedPhaseBudgetsV1 } from '../../src/verification-scope-v1-3/final-proof-agent/supervised-profile-v1.mjs';
import { createCrashDurableDecisionAuthorityV1 } from '../../src/verification-scope-v1-3/final-proof-agent/sqlite-decision-authority-v1.mjs';
import { blocked, readBoundedFdV1, parseCanonicalV1 } from './io.mjs';
import { verifyProvisionedBindingV1 } from './provision.mjs';
import { createPrivateExchangeV1, createFixtureExchangeV1, fixedRpcAdaptersV1 } from './exchange.mjs';
import { publishRetainedPackageV1 } from './custody.mjs';

export const FD_ROLES_V1 = Object.freeze({ configuration: 3, release: 4, credential: 5,
  acquisition: 6, challenge1: 7, result1: 8, disposal: 9, challenge2: 10, result2: 11,
  human: 12, context: 13, acknowledgment: 14, result: 15 });
export const REAL_CLOCK_V1 = Object.freeze({ unixSeconds: () => Math.floor(Date.now()/1000), monotonicMs: () => performance.now() });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function publicConfig(bytes, now, fixture) {
  const c = cloneAndFreeze(parseCanonicalV1(bytes));
  assertExactFields(c, ['version', 'release_sha256', 'runtime', 'provider_capability_id', 'decision_timeout_ms', 'episode_timeout_ms'], 'private_binding');
  if (c.version !== 'artifact_private_binding_v1' || !/^[a-f0-9]{64}$/.test(c.release_sha256)
    || c.runtime.executor_release_sha256 !== c.release_sha256 || !/^[a-z][a-z0-9-]{2,63}$/.test(c.provider_capability_id)
    || !Number.isSafeInteger(c.decision_timeout_ms) || c.decision_timeout_ms < 1 || c.decision_timeout_ms > 60000
    || !Number.isSafeInteger(c.episode_timeout_ms) || c.episode_timeout_ms < 1 || c.episode_timeout_ms > 600000) throw blocked();
  if (fixture) {
    validateWigglesRuntimeConfigurationV1(c.runtime, now);
    if (c.runtime.mandate.mandate_profile !== OFFLINE_WALLET_PROFILE_V1) throw blocked();
  } else validateProductionWigglesConfigurationV1(c.runtime, now);
  validateSupervisedPhaseBudgetsV1(c.runtime.budget);
  return c;
}
export function validatePublicBindingV1(bytes) { return publicConfig(bytes, REAL_CLOCK_V1.unixSeconds(), false); }
export function validateFixturePublicBindingV1(bytes, now) { return publicConfig(bytes, now, true); }

// All descriptors are administrator-established, never numbers in channel JSON.
// Permission checks cannot establish cross-UID custody on a same-UID fixture.
export function validateDescriptorTableV1() {
  const seen = new Set();
  for (const [role, fd] of Object.entries(FD_ROLES_V1)) {
    const st = fstatSync(fd), identity = `${st.dev}:${st.ino}`;
    if (seen.has(identity)) throw blocked(); seen.add(identity);
    const info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
    const mode = parseInt(/^flags:\s+([0-7]+)/m.exec(info)?.[1] ?? '', 8) & 3;
    if (fd <= 5) {
      if (!st.isFile() || st.nlink !== 1 || mode !== constants.O_RDONLY) throw blocked();
      if (role === 'credential' && (st.uid !== process.getuid() || (st.mode & 0o077))) throw blocked();
      if (role !== 'credential' && (st.uid !== 0 || (st.mode & 0o022))) throw blocked();
    } else {
      if (!st.isFIFO() && !st.isSocket()) throw blocked();
      const reading = ['acquisition', 'disposal', 'human'].includes(role);
      if (st.isFIFO() && mode !== (reading ? constants.O_RDONLY : constants.O_WRONLY)) throw blocked();
    }
  }
  return FD_ROLES_V1;
}
export function descriptorChannelsV1() {
  const channels = {};
  for (const [role, fd] of Object.entries(FD_ROLES_V1)) if (fd > 5) {
    const reading = ['acquisition', 'disposal', 'human'].includes(role);
    channels[role] = new Socket({ fd, readable: reading, writable: !reading });
  }
  return Object.freeze(channels);
}

export function verifyReleaseInventoryV1(bytes, expected_sha256, fixture = false) {
  if (hash(bytes) !== expected_sha256) throw blocked();
  const r = parseCanonicalV1(bytes);
  assertExactFields(r, ['version', 'predecessor_manifest_sha256', 'node_version', 'members', 'resolution'], 'private_release');
  if (r.version !== 'artifact_private_executable_release_v1' || r.node_version !== process.version
    || r.predecessor_manifest_sha256 !== 'd8de356f38e57403b250cff47c7890eb67401320be233c955800bd016de55fd6'
    || !Array.isArray(r.members) || !r.members.length || r.members.length > 100000) throw blocked();
  let previous = ''; let nodeFound = false;
  for (const m of r.members) {
    assertExactFields(m, ['path', 'resolved', 'bytes', 'sha256', 'mode'], 'release_member');
    if (typeof m.path !== 'string' || m.path <= previous || !isAbsolute(m.resolved)
      || realpathSync(m.resolved) !== m.resolved || !Number.isSafeInteger(m.bytes) || m.bytes < 0
      || m.bytes > 268435456 || !/^[a-f0-9]{64}$/.test(m.sha256)) throw blocked();
    previous = m.path;
    const fd = openSync(m.resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size !== m.bytes || (st.mode & 0o777) !== m.mode
        || (!fixture && (st.uid !== 0 || (st.mode & 0o022) || process.getuid() === 0))) throw blocked();
      // Source/dependency bytes are public. Stream hashing avoids runtime-sized
      // allocations and binds the verified open descriptor, not a template path.
      const digest = createHash('sha256'), buffer = Buffer.alloc(65536);
      // readFileSync is deliberately not used for potentially large Node/WASM.
      let n; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, n));
      const after = fstatSync(fd);
      if (digest.digest('hex') !== m.sha256 || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw blocked();
      if (m.path === 'runtime/node' && m.resolved === realpathSync(process.execPath)) nodeFound = true;
    } finally { closeSync(fd); }
  }
  if (!nodeFound) throw blocked();
  return cloneAndFreeze(r);
}

function loadCredential(c) {
  const bytes = readBoundedFdV1(FD_ROLES_V1.credential, 73728, process.getuid());
  try {
    const secret = parseCanonicalV1(bytes);
    assertExactFields(secret, ['capability_id', 'endpoint', 'bearer', 'ca'], 'private_credential');
    if (secret.capability_id !== c.provider_capability_id) throw blocked();
    return secret;
  } finally { bytes.fill(0); closeSync(FD_ROLES_V1.credential); }
}

// Mechanical candidate stop. It validates all public/FD/release bindings before
// refusing and never opens state, reads credential bytes, or constructs a wallet.
// The private production call below is held behind this unconditional stop;
// changing it is the separately approved activation diff, not a runtime flag.
export function openDisabledPrivateBindingV1() {
  validateDescriptorTableV1();
  const c = validatePublicBindingV1(readBoundedFdV1(3, 262144, 0, false));
  verifyReleaseInventoryV1(readBoundedFdV1(4, 33554432, 0, false), c.release_sha256);
  requireActivationV1();
  return compose(c, loadCredential(c), false, REAL_CLOCK_V1);
}
function requireActivationV1() {
  throw Error('PRIVATE_DEPLOYMENT_ACTIVATION_NOT_AUTHORIZED');
}

// Fixed composition kernel. No entry point invokes it for a production profile.
// Kept private so a controller cannot select a constructor, clock or transport.
function compose(c, credential, fixture, clock) {
  if (credential.capability_id !== c.provider_capability_id) throw blocked();
  const exchange = (fixture ? createFixtureExchangeV1 : createPrivateExchangeV1)({ ...credential,
    timeout_ms: 60000, max_response_bytes: 16777216 });
  let runtime, contextAuthority;
  try {
    verifyProvisionedBindingV1(c.runtime);
    const dependencies = { ...fixedRpcAdaptersV1(exchange, c.runtime.budget), clock,
      supervision: createSupervisedJournalV1(c.runtime.state_root) };
    runtime = (fixture ? createOfflineSupervisedWigglesRuntimeV1 : createPrivateSupervisedWigglesRuntimeV1)(c.runtime, dependencies);
    contextAuthority = createCrashDurableDecisionAuthorityV1({ state_root: c.runtime.state_root });
  } catch { exchange.close(); runtime?.closeV1(); throw blocked(); }
  return Object.freeze({ runtime, mapping: exchange.mapping, stopExchange: () => exchange.close(),
    decision_timeout_ms: c.decision_timeout_ms, episode_timeout_ms: Math.min(c.episode_timeout_ms,
      Math.max(1, (c.runtime.deadline_unix_seconds - clock.unixSeconds()) * 1000)),
    publish: ordinal => publishRetainedPackageV1(runtime, c.runtime.state_root, ordinal),
    async humanContext() {
      const s = await contextAuthority.loadCurrentEpisodeStateV1({ episode_id: `bounded-agent-episode-${c.runtime.authorization.authorization_digest}` });
      return Object.freeze({ version: 'artifact_private_human_context_v1', episode_id: s.episode_id,
        mandate_digest: c.runtime.mandate.mandate_digest, authorization_digest: c.runtime.authorization.authorization_digest,
        human_public_key: c.runtime.authorization.human_public_key, predecessor_state: s.state, predecessor_state_digest: s.state_digest });
    },
    close() { exchange.close(); contextAuthority.closeV1(); runtime.closeV1(); } });
}
export function composeFixtureBindingV1(publicBytes, credential, clock = REAL_CLOCK_V1) {
  const c = validateFixturePublicBindingV1(publicBytes, clock.unixSeconds());
  return compose(c, credential, true, clock);
}
