
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Message, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { assertExactFields, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { OFFLINE_WALLET_PROFILE_V1, assertConfiguredExecutorMandateV1 } from './executor-mandate-profile-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { createCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { createOrcaReadinessCaptureV1 } from './orca-readiness-capture-v1.mjs';
import { createOfflineOrcaSigningCompositionV1 } from './orca-signing-composition-v1.mjs';
import { createOfflineTrustedSubmissionV1 } from './wiggles-submission-v1.mjs';

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
async function signWithWallet(path, expectedWallet, message, beforeSign) {
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
  assertExactFields(c, CONFIG_FIELDS, 'wiggles_runtime_configuration');
  assertConfiguredExecutorMandateV1(c.mandate);
  validateHumanEpisodeAuthorizationV1(c.authorization, { mandate: c.mandate });
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
  if (c.mandate.mandate_profile !== OFFLINE_WALLET_PROFILE_V1) reject('offline disposable wallet profile required');
  const authority = createCrashDurableDecisionAuthorityV1({ state_root: c.state_root });
  const episodeId = `bounded-agent-episode-${c.authorization.authorization_digest}`;
  let control, submitter;
  try {
    submitter = createOfflineTrustedSubmissionV1(c, { authority, clock, submission });
    const capture = createOrcaReadinessCaptureV1({ mandate: c.mandate, authorization: c.authorization,
      budget: c.budget, deadline_unix_seconds: c.deadline_unix_seconds, transport, clock,
      retain_evidence: async record => retainEvidence(c.state_root, record), durable_episode_authority: authority });
    control = createOfflineOrcaSigningCompositionV1({ mandate: c.mandate, authorization: c.authorization,
      executor_release_sha256: c.executor_release_sha256, state_root: c.state_root,
      durable_episode_authority: authority, acquisition_closure_port: {},
      readiness_challenge_port: capture, build_input_port: capture,
      message_signer_port: { async signExactMessageV1(message, { challenge, admission }) {
        return signWithWallet(c.wallet_key_path, c.expected_wallet, message, async () => {
          const current = await authority.inspectEpisodeV1({ episode_id: episodeId });
          const row = current.ordinals.find(item => item.ordinal === admission.ordinal);
          if (current.revoked || row?.stage !== 'KEY_LOAD_STARTED_AMBIGUOUS'
              || row.admission_digest !== admission.admission_digest) reject('signing checkpoint revoked or changed');
          await capture.assertFreshBeforeSigningV1({ challenge });
        });
      } },
    });
  } catch (error) { authority.closeV1(); throw error; }
  let closed = false;
  function now() { if (closed) reject('runtime closed'); return clock.unixSeconds(); }
  return Object.freeze({
    agent: Object.freeze({ async submitDecisionBytesV1(decisionBytes) {
      const result = await control.executeAuthenticatedDecisionBytesV1({ decision_bytes: decisionBytes, now_unix_seconds: now() });
      return Object.freeze({ status: result.admission.status === 'REFUSED' ? 'REFUSED' : 'SIGNED_INTENT_DURABLE',
        episode_id: episodeId, signed_intent_digest: result.signed_transaction_intent_digest ?? null });
    } }),
    supervisor: Object.freeze({
      issueReadinessChallengeV1(phase) { return control.issueReadinessChallengeV1({ phase, now_unix_seconds: now() }); },
      revokeAuthenticatedBytesV1(revocationBytes) {
        return control.revokeAuthenticatedBytesV1({ revocation_bytes: revocationBytes, now_unix_seconds: now() });
      },
    }),
    trusted: Object.freeze({ readRetainedWireV1(ordinal) {
      now(); return authority.readRetainedWireV1({ episode_id: episodeId, ordinal });
    }, submitRetainedIntentV1(ordinal) { now(); return submitter.submit(ordinal); },
    finalizeRetainedIntentV1(ordinal) { now(); return submitter.finalize(ordinal); } }),
    closeV1() { if (!closed) { authority.closeV1(); closed = true; } },
  });
}
