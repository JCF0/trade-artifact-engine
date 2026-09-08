import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedTestMandateInputV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { validateBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { buildOfflineWalletMandateV1 } from './executor-mandate-profile-v1.mjs';
import { buildFixedTestAuthorizationV1, buildFixedTestAgentDecisionV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { syntheticRuntimeCaptureV1 } from './fixtures/trusted-runtime-offline-v1.mjs';
import { canonicalJson, sha256CanonicalJson } from '../contract.mjs';
import { createAuthorizedEpisodeStateV1 } from './episode-state-machine-v1.mjs';
import { provisionCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { Keypair } from '@solana/web3.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import nacl from 'tweetnacl';
import { createCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { createPrivateKey, sign } from 'node:crypto';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from './human-revocation-v1.mjs';
import { PassThrough } from 'node:stream';
import { serveSingleWigglesDecisionV1 } from './wiggles-decision-channel-v1.mjs';

function observeWallet(t, f, defect = '') {
  let loads = 0, signs = 0, wireReads = 0;
  const secrets = [];
  const originalOpen = fs.openSync, originalSign = nacl.sign.detached;
  t.mock.method(fs, 'openSync', (path, flags, ...rest) => {
    if (path === f.keyPath) {
      loads++;
      if (defect === 'expired-during-key-load') f.source.time.mono = 30000;
    }
    if (String(path).endsWith('orca-signed-wire-1.bin')) {
      if (defect === 'retention') throw Error('injected retention failure');
      if ((flags & fs.constants.O_WRONLY) === 0 && ++wireReads === 2 && defect === 'registration') {
        throw Error('injected durable registration read failure');
      }
    }
    return originalOpen(path, flags, ...rest);
  });
  syncBuiltinESMExports();
  const signing = (message, secret) => {
    signs++;
    secrets.push(secret);
    if (defect === 'uncertain') throw Error('injected uncertain signing');
    if (defect === 'message') message[message.length - 1] ^= 1;
    const result = originalSign(message, secret);
    if (defect === 'signature') result[0] ^= 1;
    return result;
  };
  signing.verify = originalSign.verify;
  nacl.sign.detached = signing;
  t.after(() => { nacl.sign.detached = originalSign; t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { counts: () => ({ loads, signs }), secrets };
}

function revocation(f) {
  const unsigned = { episode_id: f.state.episode_id, mandate_digest: f.mandate.mandate_digest,
    authorization_digest: f.authorization.authorization_digest, human_public_key: f.authorization.human_public_key,
    predecessor_state: f.state.state, predecessor_state_digest: f.state.state_digest,
    revoked_at_unix_seconds: f.source.time.wall, revocation_nonce: 'disposable-runtime-revocation-v1',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION' };
  const key = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
  ]) });
  return Buffer.from(canonicalJson(buildHumanRevocationV1({ ...unsigned,
    signature: sign(null, humanRevocationSigningBytesV1(unsigned), key).toString('hex') })));
}

function setup() {
  const input = fixedTestMandateInputV1();
  const source = syntheticRuntimeCaptureV1(buildOfflineWalletMandateV1(input));
  input.offline_identity.rpc_budget_table_sha256 = sha256CanonicalJson(source.budget);
  input.unresolved_live_readiness = { ...input.offline_identity, status: 'RESOLVED' };
  delete input.unresolved_live_readiness.profile;
  const mandate = buildOfflineWalletMandateV1(input);
  const authorization = buildFixedTestAuthorizationV1(mandate);
  const root = mkdtempSync(join(tmpdir(), 'artifact-trusted-test-'));
  const stateRoot = join(root, 'authority'); mkdirSync(stateRoot, { mode: 0o700 });
  const keyPath = join(root, 'disposable-key.json');
  const key = Keypair.fromSeed(Buffer.alloc(32, 7));
  writeFileSync(keyPath, JSON.stringify([...key.secretKey]), { mode: 0o600 });
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  provisionCrashDurableDecisionAuthorityV1({ state_root: stateRoot, initial_episode_state: state,
    executor_release_sha256: authorization.executor_release_sha256 });
  const configuration = { mandate, authorization, executor_release_sha256: authorization.executor_release_sha256,
    expected_wallet: mandate.wallet_scope.wallet, wallet_key_path: keyPath, state_root: stateRoot,
    budget: source.budget, deadline_unix_seconds: 2000000000 };
  return { root, keyPath, stateRoot, state, mandate, authorization, configuration, source,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('concrete runtime captures, authenticates, loads disposable key and returns only durable identity', async () => {
  const { createOfflineTrustedWigglesRuntimeV1 } = await import('./wiggles-trusted-runtime-v1.mjs');
  const f = setup(); let runtime;
  try {
    runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
    const challenge = await runtime.supervisor.issueReadinessChallengeV1('ACQUISITION');
    const decision = buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge);
    f.source.time.wall++;
    const input = new PassThrough(), output = new PassThrough(), chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    const served = serveSingleWigglesDecisionV1({ agent: runtime.agent, input, output, timeout_ms: 1000 });
    input.end(Buffer.from(canonicalJson(decision)));
    await served;
    const result = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(result.status, 'SIGNED_INTENT_DURABLE');
    assert.deepEqual(Object.keys(result).sort(), ['episode_id', 'signed_intent_digest', 'status']);
    assert.deepEqual(Object.keys(runtime.agent), ['submitDecisionBytesV1']);
    const retained = await runtime.trusted.readRetainedWireV1(1);
    assert.ok(Buffer.isBuffer(retained));
    runtime.closeV1(); runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
    assert.deepEqual(await runtime.trusted.readRetainedWireV1(1), retained);
    await assert.rejects(runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(decision))));
  } finally { runtime?.closeV1(); f.cleanup(); }
});

test('separate offline wallet mandate cannot pass frozen final-proof validation', async () => {
  const profiles = await import('./executor-mandate-profile-v1.mjs');
  const mandate = profiles.buildOfflineWalletMandateV1(fixedTestMandateInputV1());
  assert.equal(profiles.validateExecutorMandateV1(mandate), true);
  assert.equal(mandate.wallet_scope.wallet, 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB');
  assert.throws(() => validateBoundedAgentMandateV1(mandate));
  assert.throws(() => profiles.validateExecutorMandateV1({ ...mandate, wallet_scope: fixedTestMandateInputV1().wallet_scope }));
});

for (const defect of ['agent', 'stale', 'revoked', 'wrong-key', 'uncertain', 'message', 'signature', 'retention', 'registration', 'expired-during-key-load']) {
  test(`trusted runtime ${defect} refuses success and cannot replace signing on restart`, async t => {
    const { createOfflineTrustedWigglesRuntimeV1 } = await import('./wiggles-trusted-runtime-v1.mjs');
    const f = setup(); const observed = observeWallet(t, f, defect); let runtime;
    try {
      runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
      const challenge = await runtime.supervisor.issueReadinessChallengeV1('ACQUISITION');
      const decision = buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge);
      let bytes = Buffer.from(canonicalJson(decision)); f.source.time.wall++;
      if (defect === 'agent') bytes = Buffer.from(canonicalJson({ ...decision, signature: '0'.repeat(128) }));
      if (defect === 'stale') f.source.time.mono = 30000;
      if (defect === 'revoked') await runtime.supervisor.revokeAuthenticatedBytesV1(revocation(f));
      if (defect === 'wrong-key') writeFileSync(f.keyPath, JSON.stringify([...Keypair.fromSeed(Buffer.alloc(32, 8)).secretKey]));
      await assert.rejects(runtime.agent.submitDecisionBytesV1(bytes));
      const before = observed.counts();
      assert.equal(before.loads, ['agent', 'stale', 'revoked'].includes(defect) ? 0 : 1);
      assert.equal(before.signs, ['agent', 'stale', 'revoked', 'wrong-key', 'expired-during-key-load'].includes(defect) ? 0 : 1);
      assert.ok(observed.secrets.every(secret => secret.every(byte => byte === 0)));
      await assert.rejects(runtime.trusted.readRetainedWireV1(1));
      runtime.closeV1(); runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
      await assert.rejects(runtime.agent.submitDecisionBytesV1(bytes));
      assert.deepEqual(observed.counts(), before);
      runtime.closeV1(); runtime = null;
      const db = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
      try {
        const row = (await db.inspectEpisodeV1({ episode_id: f.state.episode_id })).ordinals[0];
        if (!['agent', 'revoked'].includes(defect)) assert.equal(row.stage, defect === 'stale' ? 'RESERVED' : 'KEY_LOAD_STARTED_AMBIGUOUS');
      } finally { db.closeV1(); }
    } finally { runtime?.closeV1(); f.cleanup(); }
  });
}

test('invalid human authorization rejected before any wallet open or capture', async t => {
  const { createOfflineTrustedWigglesRuntimeV1 } = await import('./wiggles-trusted-runtime-v1.mjs');
  const f = setup(), observed = observeWallet(t, f);
  try {
    assert.throws(() => createOfflineTrustedWigglesRuntimeV1({ ...f.configuration,
      authorization: { ...f.authorization, signature: '0'.repeat(128) } }, f.source));
    assert.deepEqual(observed.counts(), { loads: 0, signs: 0 });
    assert.equal(f.source.calls.length, 0);
  } finally { f.cleanup(); }
});

test('two runtime instances concurrently consume one decision and never obtain replacement signing', async t => {
  const { createOfflineTrustedWigglesRuntimeV1 } = await import('./wiggles-trusted-runtime-v1.mjs');
  const f = setup(), observed = observeWallet(t, f); let a, b;
  try {
    a = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
    b = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
    const challenge = await a.supervisor.issueReadinessChallengeV1('ACQUISITION');
    const bytes = Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge)));
    f.source.time.wall++;
    const results = await Promise.allSettled([a.agent.submitDecisionBytesV1(bytes), b.agent.submitDecisionBytesV1(bytes)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.deepEqual(observed.counts(), { loads: 1, signs: 1 });
    await assert.rejects(a.agent.submitDecisionBytesV1(bytes));
    await assert.rejects(b.agent.submitDecisionBytesV1(bytes));
    assert.deepEqual(observed.counts(), { loads: 1, signs: 1 });
  } finally { a?.closeV1(); b?.closeV1(); f.cleanup(); }
});

test('production configuration refuses test mandate and placeholders before runtime capability access', async () => {
  const production = await import('./wiggles-production-configuration-v1.mjs');
  const f = setup();
  try {
    assert.throws(() => production.validateProductionWigglesConfigurationV1(f.configuration, f.source.time.wall));
    assert.throws(() => production.validateProductionWigglesConfigurationV1({}, f.source.time.wall));
  } finally { f.cleanup(); }
});

test('agent capability injection rejects before key access; authenticated refusal remains durable', async t => {
  const { createOfflineTrustedWigglesRuntimeV1 } = await import('./wiggles-trusted-runtime-v1.mjs');
  const f = setup(), observed = observeWallet(t, f); let runtime;
  try {
    runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
    const challenge = await runtime.supervisor.issueReadinessChallengeV1('ACQUISITION');
    const decision = buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge, 'REFUSE_ACQUISITION');
    f.source.time.wall++;
    for (const field of ['signer', 'callback', 'wallet_key_path', 'state', 'quote', 'quantity', 'transaction_bytes', 'now_unix_seconds']) {
      await assert.rejects(runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson({ ...decision, [field]: 'forbidden' }))));
    }
    let getters = 0;
    await assert.rejects(runtime.agent.submitDecisionBytesV1({ get signer() { getters++; } }));
    assert.equal(getters, 0);
    const result = await runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(decision)));
    assert.equal(result.status, 'REFUSED'); assert.equal(result.signed_intent_digest, null);
    assert.deepEqual(observed.counts(), { loads: 0, signs: 0 });
    runtime.closeV1(); runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
    await assert.rejects(runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(decision))));
    assert.deepEqual(observed.counts(), { loads: 0, signs: 0 });
  } finally { runtime?.closeV1(); f.cleanup(); }
});

for (const defect of ['malformed', 'public-half', 'oversized', 'symlink', 'permissions']) {
  test(`wallet file ${defect} cannot sign or reset durable ambiguity`, async t => {
    const { createOfflineTrustedWigglesRuntimeV1 } = await import('./wiggles-trusted-runtime-v1.mjs');
    const f = setup(), observed = observeWallet(t, f); let runtime;
    try {
      if (defect === 'malformed') writeFileSync(f.keyPath, '[256]');
      if (defect === 'public-half') {
        const secret = [...Keypair.fromSeed(Buffer.alloc(32, 7)).secretKey]; secret[63] ^= 1;
        writeFileSync(f.keyPath, JSON.stringify(secret));
      }
      if (defect === 'oversized') fs.truncateSync(f.keyPath, 4097);
      if (defect === 'symlink') { fs.renameSync(f.keyPath, f.keyPath + '.original'); fs.symlinkSync(f.keyPath + '.original', f.keyPath); }
      if (defect === 'permissions') fs.chmodSync(f.keyPath, 0o644);
      runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
      const challenge = await runtime.supervisor.issueReadinessChallengeV1('ACQUISITION');
      const bytes = Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge)));
      f.source.time.wall++;
      await assert.rejects(runtime.agent.submitDecisionBytesV1(bytes));
      assert.equal(observed.counts().signs, 0);
      runtime.closeV1(); runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
      const before = observed.counts();
      await assert.rejects(runtime.agent.submitDecisionBytesV1(bytes));
      assert.deepEqual(observed.counts(), before);
    } finally { runtime?.closeV1(); f.cleanup(); }
  });
}

for (const defect of ['read', 'post-fstat', 'post-lstat', 'close', 'read-close',
  'short-read-cleanup', 'metadata-mismatch-cleanup', 'signer-error-cleanup', 'success-cleanup']) {
  test(`key buffer exception ${defect} zeroizes exact allocations without replacement`, async t => {
    const { createOfflineTrustedWigglesRuntimeV1 } = await import('./wiggles-trusted-runtime-v1.mjs');
    const f = setup(); let runtime, keyFd, reads = 0, loads = 0, signs = 0, closes = 0;
    const buffers = new Set(), parsedArrays = [], secrets = [], derivedSecrets = [];
    const originalOpen = fs.openSync, originalRead = fs.readSync, originalClose = fs.closeSync;
    const originalFstat = fs.fstatSync, originalLstat = fs.lstatSync, originalParse = JSON.parse;
    const originalDerive = nacl.sign.keyPair.fromSeed, originalSign = nacl.sign.detached;
    const poisonCleanup = array => {
      if (defect.endsWith('-cleanup')) Object.defineProperty(array, 'fill', {
        configurable: true, value() { throw Error('injected cleanup method failure'); },
      });
    };
    t.mock.method(fs, 'openSync', (path, flags, ...rest) => {
      const fd = originalOpen(path, flags, ...rest);
      if (path === f.keyPath) { keyFd = fd; loads++; }
      return fd;
    });
    t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
      if (fd !== keyFd) return originalRead(fd, buffer, offset, length, position);
      buffers.add(buffer); poisonCleanup(buffer); reads++;
      if (['read', 'read-close', 'short-read-cleanup'].includes(defect)) {
        if (reads === 1) return originalRead(fd, buffer, offset, Math.min(16, length), position);
        if (defect === 'short-read-cleanup') return 0;
        throw Error('injected key read failure');
      }
      return originalRead(fd, buffer, offset, length, position);
    });
    t.mock.method(fs, 'fstatSync', fd => {
      const result = originalFstat(fd);
      if (fd === keyFd && reads > 0) {
        if (defect === 'post-fstat') throw Error('injected post-read fstat failure');
        if (defect === 'metadata-mismatch-cleanup') return { ...result, size: result.size + 1 };
      }
      return result;
    });
    t.mock.method(fs, 'lstatSync', (path, ...rest) => {
      if (path === f.keyPath && reads > 0 && defect === 'post-lstat') throw Error('injected post-read lstat failure');
      return originalLstat(path, ...rest);
    });
    t.mock.method(fs, 'closeSync', fd => {
      const isKey = fd === keyFd;
      const result = originalClose(fd);
      if (isKey) {
        keyFd = undefined; closes++;
        if (['close', 'read-close'].includes(defect)) throw Error('injected key close failure');
      }
      return result;
    });
    t.mock.method(JSON, 'parse', (...args) => {
      const result = originalParse(...args);
      if (Array.isArray(result) && result.length === 64 && result.every(Number.isInteger)) {
        parsedArrays.push(result); poisonCleanup(result);
      }
      return result;
    });
    t.mock.method(nacl.sign.keyPair, 'fromSeed', seed => {
      const result = originalDerive(seed);
      derivedSecrets.push(result.secretKey); poisonCleanup(result.secretKey);
      return result;
    });
    const signing = (message, secret) => {
      signs++; secrets.push(secret); poisonCleanup(secret);
      if (defect === 'signer-error-cleanup') throw Error('injected signer failure');
      return originalSign(message, secret);
    };
    signing.verify = originalSign.verify;
    nacl.sign.detached = signing;
    syncBuiltinESMExports();
    try {
      runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
      const challenge = await runtime.supervisor.issueReadinessChallengeV1('ACQUISITION');
      const bytes = Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge)));
      f.source.time.wall++;
      if (defect === 'success-cleanup') {
        assert.equal((await runtime.agent.submitDecisionBytesV1(bytes)).status, 'SIGNED_INTENT_DURABLE');
      } else {
        await assert.rejects(runtime.agent.submitDecisionBytesV1(bytes));
        await assert.rejects(runtime.trusted.readRetainedWireV1(1));
      }
      assert.equal(loads, 1); assert.equal(closes, 1);
      assert.equal(buffers.size, 1, 'must observe the actual key-read allocation');
      for (const buffer of buffers) assert.ok(buffer.every(byte => byte === 0), 'key-read allocation must be zeroized');
      const reachedSigner = ['signer-error-cleanup', 'success-cleanup'].includes(defect);
      assert.equal(signs, reachedSigner ? 1 : 0);
      for (const arrays of [parsedArrays, secrets, derivedSecrets]) {
        assert.equal(arrays.length, reachedSigner ? 1 : 0, 'cleanup coverage must not be vacuous');
        assert.ok(arrays.every(array => array.every(byte => byte === 0)), 'all retained secret arrays must be zeroized');
      }
      runtime.closeV1(); runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
      await assert.rejects(runtime.agent.submitDecisionBytesV1(bytes));
      assert.equal(loads, 1); assert.equal(signs, reachedSigner ? 1 : 0);
      const authority = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
      try {
        const row = (await authority.inspectEpisodeV1({ episode_id: f.state.episode_id })).ordinals[0];
        assert.equal(row.stage, defect === 'success-cleanup' ? 'SIGNED_INTENT_DURABLE' : 'KEY_LOAD_STARTED_AMBIGUOUS');
      } finally { authority.closeV1(); }
    } finally {
      runtime?.closeV1(); nacl.sign.detached = originalSign;
      t.mock.restoreAll(); syncBuiltinESMExports(); f.cleanup();
    }
  });
}

for (const recovery of ['recover', 'repeat-fsync-failure', 'mismatch']) {
  test(`readiness evidence EEXIST recovery ${recovery} requires durable matching file bytes`, async t => {
    const { createOfflineTrustedWigglesRuntimeV1 } = await import('./wiggles-trusted-runtime-v1.mjs');
    const f = setup(); let runtime, evidencePath, fileSyncs = 0, keyLoads = 0;
    const descriptors = new Map(), events = [];
    const originalOpen = fs.openSync, originalClose = fs.closeSync, originalSync = fs.fsyncSync;
    t.mock.method(fs, 'openSync', (path, flags, ...rest) => {
      if (path === f.keyPath) keyLoads++;
      const fd = originalOpen(path, flags, ...rest);
      descriptors.set(fd, path);
      if (String(path).includes('/readiness-evidence-') && (flags & fs.constants.O_WRONLY)) evidencePath ??= path;
      return fd;
    });
    t.mock.method(fs, 'closeSync', fd => {
      try { return originalClose(fd); } finally { descriptors.delete(fd); }
    });
    t.mock.method(fs, 'fsyncSync', fd => {
      if (descriptors.get(fd) === evidencePath) {
        fileSyncs++;
        if (fileSyncs === 1 || (recovery === 'repeat-fsync-failure' && fileSyncs === 2)) {
          throw Error('injected evidence file fsync failure');
        }
        const result = originalSync(fd); events.push('file-durable'); return result;
      }
      const result = originalSync(fd);
      if (descriptors.get(fd) === f.stateRoot) events.push('directory-durable');
      return result;
    });
    syncBuiltinESMExports();
    try {
      runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
      await assert.rejects(runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'), /injected evidence file fsync failure/);
      assert.equal(fileSyncs, 1);
      const retained = fs.readFileSync(evidencePath);
      assert.ok(retained.length > 0); // Complete bytes remain despite failed durability.
      runtime.closeV1(); runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
      if (recovery === 'mismatch') {
        const changed = Buffer.from(retained); changed[changed.length - 1] ^= 1;
        writeFileSync(evidencePath, changed);
        await assert.rejects(runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'), /evidence readback mismatch/);
      } else {
        if (recovery === 'repeat-fsync-failure') {
          await assert.rejects(runtime.supervisor.issueReadinessChallengeV1('ACQUISITION'), /injected evidence file fsync failure/);
          assert.equal(fileSyncs, 2);
          runtime.closeV1(); runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
        }
        events.length = 0;
        const challenge = await runtime.supervisor.issueReadinessChallengeV1('ACQUISITION');
        assert.equal(challenge.readiness_status, 'READY');
        assert.equal(fileSyncs, recovery === 'recover' ? 2 : 3, 'existing evidence must be file-fsynced before acceptance');
        assert.deepEqual(events.slice(0, 2), ['file-durable', 'directory-durable']);
        assert.deepEqual(fs.readFileSync(evidencePath), retained);
      }
      assert.equal(keyLoads, 0);
      const authority = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
      try {
        assert.deepEqual((await authority.inspectEpisodeV1({ episode_id: f.state.episode_id })).ordinals, []);
      } finally { authority.closeV1(); }
    } finally {
      runtime?.closeV1(); t.mock.restoreAll(); syncBuiltinESMExports(); f.cleanup();
    }
  });
}

test('executor-only wire read revalidates bytes after success; mutation blocks current access and reopen', async () => {
  const { createOfflineTrustedWigglesRuntimeV1 } = await import('./wiggles-trusted-runtime-v1.mjs');
  const f = setup(); let runtime;
  try {
    runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
    const challenge = await runtime.supervisor.issueReadinessChallengeV1('ACQUISITION');
    f.source.time.wall++;
    await runtime.agent.submitDecisionBytesV1(Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(f.mandate, f.authorization, challenge))));
    const bytes = await runtime.trusted.readRetainedWireV1(1); bytes[10] ^= 1;
    writeFileSync(join(f.stateRoot, 'orca-signed-wire-1.bin'), bytes);
    await assert.rejects(runtime.trusted.readRetainedWireV1(1));
    runtime.closeV1(); runtime = null;
    assert.throws(() => createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source));
  } finally { runtime?.closeV1(); f.cleanup(); }
});
