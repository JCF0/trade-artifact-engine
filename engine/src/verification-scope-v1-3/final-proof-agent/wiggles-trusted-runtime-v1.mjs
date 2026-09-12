
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Message, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { assertExactFields, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { isOfflineExecutorMandateV1, isRecoveredSetupExecutorMandateV2, assertConfiguredExecutorMandateV1 } from './executor-mandate-profile-v1.mjs';
import { validateExecutorRecoveredSetupEvidenceV2 as validateRecoveredSetupEvidenceV2 } from './recovered-setup-v2.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { createCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { createOrcaReadinessCaptureV1 } from './orca-readiness-capture-v1.mjs';
import { createOfflineOrcaSigningCompositionV1 } from './orca-signing-composition-v1.mjs';
import { createOfflineTrustedSubmissionV1, createSupervisedTrustedSubmissionV1 } from './wiggles-submission-v1.mjs';
import { validateSupervisedPhaseBudgetsV1 } from './supervised-profile-v1.mjs';
import { createBoundedSupervisedRpcV1 } from './supervised-rpc-v1.mjs';
import { simulateExactPreparedMessageV1 } from './supervised-simulation-v1.mjs';
import { validateProductionWigglesConfigurationV1 } from './wiggles-production-configuration-v1.mjs';
import { captureSupervisedFinalizedSourceV1 } from './supervised-finalized-source-v1.mjs';
import { exportSupervisedRetainedEpisodeV1, inspectSupervisedExportCandidatesV1 } from './supervised-exporter-v1.mjs';

const CONFIG_FIELDS = ['mandate', 'authorization', 'executor_release_sha256', 'expected_wallet',
  'wallet_key_path', 'state_root', 'budget', 'deadline_unix_seconds'];
function reject(message) { fail('bounded_agent_trusted_runtime_blocked', message); }

function privateRoot(root) {
  const st = lstatSync(root);
  if (!isAbsolute(root) || realpathSync(root) !== root || !st.isDirectory()
      || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) reject('private executor root required');
  return st;
}
// Owned buffers/plain JSON arrays only. Do not invoke replaceable .fill methods:
// a throwing cleanup method must not interrupt erasure of this or later arrays.
function clearMutable(value) {
  if (value !== undefined) for (let i = 0; i < value.length; i++) value[i] = 0;
}
function privateBytes(path, maximum, durable = false) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) reject('private file path required');
  privateRoot(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) !== 0
          || before.nlink !== 1 || before.size < 1 || before.size > maximum) reject('private bounded file required');
      if (durable) fsyncSync(fd);
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (n === 0) reject('short private file read');
        offset += n;
      }
      const after = fstatSync(fd), current = lstatSync(path);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || current.dev !== before.dev || current.ino !== before.ino) {
        reject('private file changed');
      }
      return bytes;
    } finally { closeSync(fd); }
  } catch (error) {
    // Ownership transfers only after close succeeds; even a cancelled return
    // leaves this helper responsible for its exact allocation.
    clearMutable(bytes);
    throw error;
  }
}
// Not exported: only the private Orca composition callback can reach key loading.
// Uses the existing Solana JSON 64-byte secret-key format and tweetnacl Ed25519.
async function signWithWallet(path, expectedWallet, message, beforeSign, atSign) {
  const parsed = Message.from(message);
  if (parsed.header.numRequiredSignatures !== 1 || !Buffer.from(parsed.serialize()).equals(message)
      || parsed.accountKeys[0].toBase58() !== expectedWallet) reject('wallet/message identity mismatch');
  let bytes, values, secret, derived;
  try {
    bytes = privateBytes(path, 4096);
    values = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(values) || values.length !== 64
        || values.some(n => !Number.isInteger(n) || n < 0 || n > 255)) reject('wallet key format invalid');
    secret = Uint8Array.from(values);
    derived = nacl.sign.keyPair.fromSeed(secret.subarray(0, 32));
    if (!nacl.verify(derived.secretKey, secret)
        || new PublicKey(derived.publicKey).toBase58() !== expectedWallet) reject('wrong wallet key');
    // File IO/key derivation may consume freshness. Recheck after loading too;
    // a failure remains durably ambiguous and never reloads or re-signs.
    await beforeSign();
    // No promise turn or I/O between the final V2 custody check and signature.
    atSign();
    const signature = nacl.sign.detached(message, secret);
    if (!nacl.sign.detached.verify(message, signature, derived.publicKey)) reject('wallet signature verification failed');
    return Buffer.concat([Buffer.from([1]), Buffer.from(signature), message]);
  } catch (error) {
    // Never expose parser/file error text or key material through the channel.
    if (error?.name === 'VerificationScopeError') throw error;
    reject('wallet loading/signing ambiguous; no retry');
  } finally {
    clearMutable(bytes); if (Array.isArray(values)) clearMutable(values);
    clearMutable(secret); clearMutable(derived?.secretKey);
    // JSON strings/VM and crypto internals cannot be proven erased by JavaScript.
  }
}
function retainEvidence(root, record) {
  const bytes = Buffer.from(canonicalJson(record));
  if (bytes.length > 4194304) reject('evidence record too large');
  const before = privateRoot(root), digest = sha256CanonicalJson(record);
  const path = join(root, `readiness-evidence-${digest}.json`);
  let fd;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fd !== undefined) {
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset);
        if (n <= 0) reject('short evidence write');
        offset += n;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  // EEXIST may be a complete file left by a failed fsync. Re-establish its
  // data durability through the verified descriptor before accepting readback.
  if (!privateBytes(path, 4194304, fd === undefined).equals(bytes)) reject('evidence readback mismatch');
  const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const after = fstatSync(rootFd);
    if (before.dev !== after.dev || before.ino !== after.ino) reject('evidence root changed');
    fsyncSync(rootFd);
  } finally { closeSync(rootFd); }
  return digest;
}
export function validateWigglesRuntimeConfigurationV1(configuration, now) {
  const c = cloneAndFreeze(configuration);
  assertExactFields(c, [...CONFIG_FIELDS, ...(isRecoveredSetupExecutorMandateV2(c.mandate) ? ['setup_provenance'] : [])], 'wiggles_runtime_configuration');
  assertConfiguredExecutorMandateV1(c.mandate);
  validateHumanEpisodeAuthorizationV1(c.authorization, { mandate: c.mandate });
  if (isRecoveredSetupExecutorMandateV2(c.mandate)) validateRecoveredSetupEvidenceV2({
    mandate: c.mandate, authorization: c.authorization, evidence: c.setup_provenance, now, mode: 'admission' });
  if (isRecoveredSetupExecutorMandateV2(c.mandate)
      && c.deadline_unix_seconds > c.setup_provenance.enrollment.payload.not_after_unix_seconds) {
    reject('runtime deadline outlives custody enrollment');
  }
  if (c.executor_release_sha256 !== c.authorization.executor_release_sha256
      || c.executor_release_sha256 !== c.mandate.unresolved_live_readiness.executor_release_sha256
      || c.expected_wallet !== c.mandate.wallet_scope.wallet
      || sha256CanonicalJson(c.budget) !== c.mandate.unresolved_live_readiness.rpc_budget_table_sha256) {
    reject('configuration authority mismatch');
  }
  if (!Number.isSafeInteger(now) || now < c.authorization.issued_at_unix_seconds
      || !Number.isSafeInteger(c.deadline_unix_seconds) || now >= c.deadline_unix_seconds) {
    reject('configuration time expired or invalid');
  }
  for (const p of [c.wallet_key_path, c.state_root]) {
    if (typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p) reject('explicit absolute runtime paths required');
  }
  return c;
}
// Released offline qualification surface. No production-wallet configuration can
// reach this body. The intended live factory is unchanged and has no enable flag.
// transport/clock are trusted process construction, NEVER agent channel values.
export function createOfflineTrustedWigglesRuntimeV1(configuration, { transport, clock, submission }) {
  const c = validateWigglesRuntimeConfigurationV1(configuration, clock.unixSeconds());
  if (!isOfflineExecutorMandateV1(c.mandate)) reject('offline disposable wallet profile required');
  return createTrustedRuntime(c, { transport, clock, submission });
}
// Administrator-private construction, not a launcher or an agent-facing factory.
// Existing live entry points remain disabled. No provisioning occurs here.
export function createPrivateSupervisedWigglesRuntimeV1(configuration, dependencies) {
  const c = validateProductionWigglesConfigurationV1(configuration, dependencies.clock.unixSeconds());
  validateSupervisedPhaseBudgetsV1(c.budget);
  return createTrustedRuntime(c, dependencies, true);
}
export function createOfflineSupervisedWigglesRuntimeV1(configuration, dependencies) {
  const c = validateWigglesRuntimeConfigurationV1(configuration, dependencies.clock.unixSeconds());
  if (!isOfflineExecutorMandateV1(c.mandate)) reject('offline disposable wallet profile required');
  validateSupervisedPhaseBudgetsV1(c.budget);
  return createTrustedRuntime(c, dependencies, true);
}
function createTrustedRuntime(c, { transport, clock, submission, supervision }, integrated = false) {
  if (integrated && (!supervision || typeof supervision.retain !== 'function' || typeof supervision.claimPhase !== 'function')) reject('private supervision required');
  const authority = createCrashDurableDecisionAuthorityV1({ state_root: c.state_root });
  const episodeId = `bounded-agent-episode-${c.authorization.authorization_digest}`;
  let control, submitter;
  try {
    if (integrated) {
      if (Object.hasOwn(submission, 'finalization_source')) reject('source capability is supervisor-owned');
      const fixedSubmission = { ...submission, finalization_source: request => captureSupervisedFinalizedSourceV1({
        configuration: c, ordinal: request.ordinal, terminal: request, transport, clock, journal: supervision }) };
      submitter = createSupervisedTrustedSubmissionV1(c, { authority, clock, submission: fixedSubmission,
        retained_evidence_observer: record => supervision.retain({ kind: 'terminal_record', record }) });
    } else submitter = createOfflineTrustedSubmissionV1(c, { authority, clock, submission });
    const capture = createOrcaReadinessCaptureV1({ mandate: c.mandate, authorization: c.authorization,
      budget: integrated ? c.budget.capture : c.budget, deadline_unix_seconds: c.deadline_unix_seconds, transport, clock,
      retain_evidence: async record => {
        const digest = retainEvidence(c.state_root, record);
        if (integrated) await supervision.retain({ kind: 'readiness', record });
        return digest;
      }, durable_episode_authority: authority });
    control = createOfflineOrcaSigningCompositionV1({ mandate: c.mandate, authorization: c.authorization,
      executor_release_sha256: c.executor_release_sha256, state_root: c.state_root,
      durable_episode_authority: authority, acquisition_closure_port: {},
      readiness_challenge_port: capture, build_input_port: capture,
      authenticated_decision_observer: integrated ? record => supervision.retain({ kind: 'authenticated_decision_request', record }) : undefined,
      message_signer_port: { async signExactMessageV1(message, { challenge, admission }) {
        validateSetupAtDispatch();
        if (integrated) {
          await supervision.claimPhase('simulation', challenge.ordinal);
          const binding = await capture.captureSimulationBindingV1({ challenge });
          const rpc = createBoundedSupervisedRpcV1({ phase: 'simulation', budget: c.budget.simulation, transport, clock,
            deadline_unix_seconds: c.deadline_unix_seconds,
            assert_dispatch: () => capture.assertFreshAtDispatchV1({ challenge }),
            retain: record => supervision.retain({ kind: 'simulation_rpc', ordinal: challenge.ordinal, record }) });
          await simulateExactPreparedMessageV1({ message, expected_message_sha256: binding.message_sha256,
            minimum_context_slot: binding.minimum_context_slot, challenge, rpc, clock,
            assertFresh: () => capture.assertFreshBeforeSigningV1({ challenge }),
            retain: record => supervision.retain({ kind: 'simulation', ordinal: challenge.ordinal, record }) });
        }
        return signWithWallet(c.wallet_key_path, c.expected_wallet, message, async () => {
          validateSetupAtDispatch();
          const current = await authority.inspectEpisodeV1({ episode_id: episodeId });
          const row = current.ordinals.find(item => item.ordinal === admission.ordinal);
          if (current.revoked || row?.stage !== 'KEY_LOAD_STARTED_AMBIGUOUS'
              || row.admission_digest !== admission.admission_digest) reject('signing checkpoint revoked or changed');
          await capture.assertFreshBeforeSigningV1({ challenge });
        }, validateSetupAtDispatch);
      } },
    });
  } catch (error) { authority.closeV1(); throw error; }
  let closed = false;
  function now() { if (closed) reject('runtime closed'); return clock.unixSeconds(); }
  function validateSetupAtDispatch() {
    if (isRecoveredSetupExecutorMandateV2(c.mandate)) validateRecoveredSetupEvidenceV2({ mandate: c.mandate,
      authorization: c.authorization, evidence: c.setup_provenance, now: now(), mode: 'admission' });
  }
  return Object.freeze({
    agent: Object.freeze({ async submitDecisionBytesV1(decisionBytes) {
      validateSetupAtDispatch();
      const result = await control.executeAuthenticatedDecisionBytesV1({ decision_bytes: decisionBytes, now_unix_seconds: now() });
      if (integrated) await supervision.retain({ kind: 'decision', decision_bytes_base64: Buffer.from(decisionBytes).toString('base64'), result });
      return Object.freeze({ status: result.admission.status === 'REFUSED' ? 'REFUSED' : 'SIGNED_INTENT_DURABLE',
        episode_id: episodeId, signed_intent_digest: result.signed_transaction_intent_digest ?? null });
    } }),
    supervisor: Object.freeze({
      async issueReadinessChallengeV1(phase) {
        validateSetupAtDispatch();
        if (integrated) {
          if (!['ACQUISITION', 'DISPOSAL'].includes(phase)) reject('unsupported phase');
          await supervision.claimPhase('capture', phase === 'ACQUISITION' ? 1 : 2);
        }
        return control.issueReadinessChallengeV1({ phase, now_unix_seconds: now() });
      },
      async revokeAuthenticatedBytesV1(revocationBytes) {
        const result = await control.revokeAuthenticatedBytesV1({ revocation_bytes: revocationBytes, now_unix_seconds: now() });
        if (integrated) await supervision.retain({ kind: 'revocation', revocation_bytes_base64: Buffer.from(revocationBytes).toString('base64'), result });
        return result;
      },
    }),
    trusted: Object.freeze({ readRetainedWireV1(ordinal) {
      now(); return authority.readRetainedWireV1({ episode_id: episodeId, ordinal });
    }, submitRetainedIntentV1(ordinal) { now(); return submitter.submit(ordinal); },
    finalizeRetainedIntentV1(ordinal) { now(); return submitter.finalize(ordinal); },
    ...(integrated ? {
      async captureRetainedOutcomeSourceV1(ordinal) {
        now();
        if (![1, 2].includes(ordinal)) reject('unsupported ordinal');
        const retained = supervision.snapshot().records;
        if (retained.some(r => r.kind === 'economic_source' && r.ordinal === ordinal)) return;
        const capture = retained.find(r => r.kind === 'readiness' && r.record.challenge?.ordinal === ordinal)?.record;
        if (!capture) reject('original capture required');
        // Read-only outcome acquisition shares (and consumes) the same source
        // budget as successful closure. It cannot sign, send, or close authority.
        await captureSupervisedFinalizedSourceV1({ configuration: c, ordinal, terminal: { slot: capture.anchor.slot },
          transport, clock, journal: supervision, derive_projection: false });
      },
      inspectRetainedExportCandidatesV1(ordinal) {
        return inspectSupervisedExportCandidatesV1({ c, journal: supervision, ordinal });
      },
      exportRetainedEpisodeV1(request) {
        assertExactFields(request, ['ordinal', 'selection'], 'supervised_export_request');
        const owned = cloneAndFreeze(request);
        return exportSupervisedRetainedEpisodeV1({ c, journal: supervision, authority, ordinal: owned.ordinal, selection: owned.selection });
      },
    } : {}) }),
    closeV1() { if (!closed) { authority.closeV1(); closed = true; } },
  });
}
