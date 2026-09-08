import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { submissionRuntimeFixtureV1 } from './fixtures/submission-runtime-offline-v1.mjs';
import { validateRetainedSubmissionEvidenceV1 } from './wiggles-submission-v1.mjs';
import { createSyntheticAcquisitionAuthorityFixtureV1, createSyntheticDisposalAuthorityFixtureV1 } from './fixtures/bounded-agent-offline-v1.mjs';
import { createCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { createOfflineTrustedWigglesRuntimeV1 } from './wiggles-trusted-runtime-v1.mjs';
import { canonicalJson, sha256CanonicalJson } from '../contract.mjs';
import { createPrivateKey, sign } from 'node:crypto';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from './human-revocation-v1.mjs';
import { inspectSignedLegacyWire } from './reused/bounded-rebroadcast-v1.mjs';

async function revoke(f) {
  const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
  let state;
  try { state = await a.loadCurrentEpisodeStateV1({ episode_id: f.state.episode_id }); } finally { a.closeV1(); }
  const unsigned = { episode_id: state.episode_id, mandate_digest: f.mandate.mandate_digest,
    authorization_digest: f.authorization.authorization_digest, human_public_key: f.authorization.human_public_key,
    predecessor_state: state.state, predecessor_state_digest: state.state_digest,
    revoked_at_unix_seconds: f.source.time.wall, revocation_nonce: 'disposable-submission-revocation-v1',
    revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION' };
  const key = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')]) });
  return f.runtime.supervisor.revokeAuthenticatedBytesV1(Buffer.from(canonicalJson(buildHumanRevocationV1({ ...unsigned,
    signature: sign(null, humanRevocationSigningBytesV1(unsigned), key).toString('hex') }))));
}

test('revocation before first transmission keeps durable signed bytes but permits no calls', async () => {
  const f = submissionRuntimeFixtureV1();
  try {
    f.open(); await f.sign(); await revoke(f);
    assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'UNRESOLVED');
    assert.equal(f.calls.length, 0);
    f.close(); f.open();
    assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'UNRESOLVED');
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

for (const mode of ['revoked-acquisition', 'inflight-acquisition', 'disposal', 'revoked-disposal']) {
  test(`source-authoritative runtime transition: ${mode}`, async () => {
    const f = submissionRuntimeFixtureV1(); let source;
    f.submission.finalization_source = async () => ({ context: source.context, context_authority: source.context_authority,
      exact_quote_mint: source.exact_quote_mint });
    try {
      f.open(); await f.sign();
      const acquisitionSignature = inspectSignedLegacyWire(f.wire.toString('base64')).expectedSignature;
      source = await createSyntheticAcquisitionAuthorityFixtureV1(f.mandate, { signature: acquisitionSignature });
      let revoked = false;
      f.setHandler(async r => {
        if (mode === 'inflight-acquisition' && r.kind === 'send' && !revoked) { revoked = true; await revoke(f); }
        const tx = source.transactions[0];
        if (r.kind === 'status' && r.ordinal >= 1000) return f.rpc(r, { context: { slot: tx.slot }, value: [{
          slot: tx.slot, confirmations: null, err: null, confirmationStatus: 'finalized' }] });
        if (r.kind === 'transaction') return f.rpc(r, { slot: tx.slot, blockTime: tx.block_time,
          transaction: [f.wire.toString('base64'), 'base64'], meta: { err: null } });
        return f.defaultHandler(r);
      });
      await f.runtime.trusted.submitRetainedIntentV1(1);
      if (mode === 'revoked-acquisition') await revoke(f);
      const acquisition = await f.runtime.trusted.finalizeRetainedIntentV1(1);
      assert.equal(acquisition.chain_derived_acquired_jup_raw, '21437310');
      if (['revoked-acquisition', 'inflight-acquisition'].includes(mode)) {
        assert.equal(acquisition.state, 'REVOKED_AFTER_ACQUISITION');
        f.close(); f.open();
        assert.deepEqual(await f.runtime.trusted.finalizeRetainedIntentV1(1), acquisition);
        return;
      }
      f.close();
      const original = f.source.transport;
      f.source.time.wall = 1900001200;
      f.source.transport = async request => {
        const envelope = JSON.parse(await original(request));
        const { method, params } = request.body;
        const mutateAccount = (a, amount) => { const b = Buffer.from(a.data[0], 'base64'); b.writeBigUInt64LE(BigInt(amount), 64); a.data[0] = b.toString('base64'); };
        if (method === 'getMultipleAccounts' && params[0].length === 3) {
          envelope.result.value[0].lamports = 815624;
          mutateAccount(envelope.result.value[1], acquisition.chain_derived_acquired_jup_raw);
          mutateAccount(envelope.result.value[2], '1000000');
        }
        if (method === 'getMultipleAccounts' && params[0].length === 6) for (let i = 1; i <= 3; i++) {
          const b = Buffer.from(envelope.result.value[i].data[0], 'base64'); b.writeInt32LE(-14784 - (i - 1) * 352, 8);
          envelope.result.value[i].data[0] = b.toString('base64');
        }
        if (method === 'getTokenAccountsByOwner' && envelope.result.value.length) {
          mutateAccount(envelope.result.value[0].account, acquisition.chain_derived_acquired_jup_raw);
          mutateAccount(envelope.result.value[1].account, '1000000');
        }
        if (method === 'getSignaturesForAddress' && !params[1].before) envelope.result.unshift({ signature: acquisitionSignature,
          slot: 899999999, blockTime: 1900000100, err: null, memo: null, confirmationStatus: 'finalized' });
        return JSON.stringify(envelope);
      };
      f.open(); const challenge = await f.sign('DISPOSAL');
      assert.equal(challenge.chain_derived_disposal_jup_raw, acquisition.chain_derived_acquired_jup_raw);
      assert.equal(challenge.finalized_acquisition_evidence_digest, acquisition.acquisition_evidence_digest);
      source = await createSyntheticDisposalAuthorityFixtureV1(f.mandate, { signature: inspectSignedLegacyWire(f.wire.toString('base64')).expectedSignature });
      assert.equal((await f.runtime.trusted.submitRetainedIntentV1(2)).classification, 'FINALIZED_SUCCESS');
      if (mode === 'revoked-disposal') await revoke(f);
      await assert.rejects(f.runtime.trusted.finalizeRetainedIntentV1(2));
      source = await createSyntheticDisposalAuthorityFixtureV1(f.mandate, {
        signature: inspectSignedLegacyWire(f.wire.toString('base64')).expectedSignature,
        acquisition_evidence_digest: acquisition.acquisition_evidence_digest });
      const disposed = await f.runtime.trusted.finalizeRetainedIntentV1(2);
      assert.equal(disposed.state, mode === 'disposal' ? 'DISPOSAL_EVIDENCE_CLOSED' : 'REVOKED_AFTER_DISPOSAL');
      assert.equal(disposed.chain_derived_acquired_jup_raw, acquisition.chain_derived_acquired_jup_raw);
      assert.equal(disposed.acquisition_evidence_digest, acquisition.acquisition_evidence_digest);
      f.close(); f.open();
      assert.deepEqual(await f.runtime.trusted.finalizeRetainedIntentV1(2), disposed);
      assert.equal(f.calls.filter(r => r.kind === 'send').length, 6);
    } finally { f.cleanup(); }
  });
}

for (const variant of ['failure', 'lost-ack', 'ambiguous', 'expired-adequate', 'expired-insufficient', 'mismatch', 'incomplete', 'call-budget', 'deadline', 'late-response']) {
  test(`trusted submission integration: ${variant}`, async () => {
    const f = submissionRuntimeFixtureV1();
    if (variant === 'call-budget') f.submission.max_calls = 1;
    if (variant === 'deadline') f.submission.overall_timeout_ms = 1;
    try {
      f.open(); await f.sign();
      f.setHandler(r => {
        if (r.kind === 'send' && ['lost-ack', 'ambiguous'].includes(variant)) throw Error('ACK_LOST');
        if (variant === 'late-response' && r.kind === 'send') f.source.time.mono += 2000;
        if (r.kind === 'status' && (variant.startsWith('expired') || variant === 'ambiguous')) return f.rpc(r, { context: { slot: 900000200 }, value: [null] });
        if (r.kind === 'blockHeight' && variant.startsWith('expired')) return f.rpc(r, 900000101);
        if (r.kind === 'transaction' && variant.startsWith('expired')) {
          if (variant === 'expired-insufficient') throw Error('NO_TRANSACTION_EVIDENCE');
          return f.rpc(r, null);
        }
        if (variant === 'failure' && r.kind === 'status' && r.ordinal >= 1000) return f.rpc(r, { context: { slot: 900000010 },
          value: [{ slot: 900000010, confirmations: null, err: { InstructionError: [0, 'GenericError'] }, confirmationStatus: 'finalized' }] });
        if (r.kind === 'transaction' && ['failure', 'mismatch', 'incomplete'].includes(variant)) return f.rpc(r, {
          slot: 900000010, transaction: [variant === 'mismatch' ? Buffer.from('other wire').toString('base64') : f.wire.toString('base64'), 'base64'],
          meta: variant === 'incomplete' ? {} : { err: variant === 'failure' ? { InstructionError: [0, 'GenericError'] } : null } });
        return f.defaultHandler(r);
      });
      const result = await f.runtime.trusted.submitRetainedIntentV1(1);
      const expected = { failure: 'FINALIZED_FAILURE', 'lost-ack': 'FINALIZED_SUCCESS', ambiguous: 'AMBIGUOUS',
        'expired-adequate': 'EXPIRED_ABSENT', 'expired-insufficient': 'AMBIGUOUS', mismatch: 'AMBIGUOUS', incomplete: 'AMBIGUOUS',
        'call-budget': 'UNRESOLVED', deadline: 'UNRESOLVED', 'late-response': 'FINALIZED_SUCCESS' }[variant];
      assert.equal(result.classification, expected);
      const count = f.calls.length, sends = f.calls.filter(r => r.kind === 'send');
      assert.ok(sends.length <= 3);
      assert.ok(sends.every(r => r.params[0] === f.wire.toString('base64') && r.params[1].maxRetries === 0));
      if (['lost-ack', 'ambiguous', 'late-response', 'call-budget'].includes(variant)) assert.equal(sends.length, 1);
      if (variant === 'deadline') assert.equal(sends.length, 0);
      await assert.rejects(f.runtime.trusted.finalizeRetainedIntentV1(1));
      f.close(); f.open();
      assert.deepEqual(await f.runtime.trusted.submitRetainedIntentV1(1), result);
      assert.equal(f.calls.length, count);
    } finally { f.cleanup(); }
  });
}

test('trusted submission concurrency has one SQLite owner, repeat and restart never replenish calls', async () => {
  const f = submissionRuntimeFixtureV1(); let second;
  try {
    f.open(); await f.sign();
    second = createOfflineTrustedWigglesRuntimeV1(f.configuration, { ...f.source, submission: f.submission });
    const results = await Promise.all([f.runtime.trusted.submitRetainedIntentV1(1), second.trusted.submitRetainedIntentV1(1)]);
    assert.deepEqual(results.map(r => r.classification).sort(), ['FINALIZED_SUCCESS', 'UNRESOLVED']);
    assert.equal(f.calls.filter(r => r.kind === 'send').length, 3);
    second.closeV1(); second = undefined;
    f.close(); f.open();
    assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'FINALIZED_SUCCESS');
    assert.equal(f.calls.filter(r => r.kind === 'send').length, 3);
  } finally { second?.closeV1(); f.cleanup(); }
});

test('trusted submission rejects retained wire tampering before any external call', async () => {
  const f = submissionRuntimeFixtureV1();
  try {
    f.open(); await f.sign();
    const wire = Buffer.from(f.wire); wire[1] ^= 1;
    writeFileSync(join(f.stateRoot, 'orca-signed-wire-1.bin'), wire);
    await assert.rejects(f.runtime.trusted.submitRetainedIntentV1(1));
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('trusted retained validator rejects missing, altered and self-rehashed inconsistent journal records', async () => {
  const f = submissionRuntimeFixtureV1();
  try {
    f.open(); await f.sign(); await f.runtime.trusted.submitRetainedIntentV1(1);
    const root = join(f.stateRoot, 'submission-1');
    const binding = JSON.parse(readFileSync(join(root, 'binding.json')));
    const check = () => validateRetainedSubmissionEvidenceV1({ root, expected_binding: binding });
    assert.equal(check().classification, 'FINALIZED_SUCCESS');
    const path = join(root, 'call-0001.json'), original = readFileSync(path);
    const completionPath = join(root, 'completion.json'), completionBytes = readFileSync(completionPath);
    const completion = JSON.parse(completionBytes);
    const invalidTimeout = JSON.parse(original); invalidTimeout.timeout_ms = 0;
    completion.call_record_hashes[0] = sha256CanonicalJson(invalidTimeout);
    writeFileSync(completionPath, canonicalJson(completion));
    writeFileSync(path, canonicalJson(invalidTimeout)); assert.throws(check);
    writeFileSync(completionPath, completionBytes);
    writeFileSync(path, original);
    const record = JSON.parse(original); record.send_index = 2;
    writeFileSync(path, canonicalJson(record)); assert.throws(check);
    unlinkSync(path); assert.throws(check);
    writeFileSync(path, original, { mode: 0o600 });
    const terminal = join(root, 'terminal', 'finalized-transaction-raw-response.json');
    unlinkSync(terminal); assert.throws(check);
    assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'UNRESOLVED');
    assert.equal(f.calls.filter(r => r.kind === 'send').length, 3);
  } finally { f.cleanup(); }
});

test('missing submission configuration refuses; no caller bytes/options or production enable flag', async () => {
  const f = submissionRuntimeFixtureV1(); let runtime;
  try {
    runtime = createOfflineTrustedWigglesRuntimeV1(f.configuration, f.source);
    await assert.rejects(runtime.trusted.submitRetainedIntentV1(1), /SUBMISSION_CONFIGURATION_NOT_APPROVED/);
    runtime.closeV1(); runtime = undefined;
    f.open(); await f.sign();
    await assert.rejects(f.runtime.trusted.submitRetainedIntentV1({ ordinal: 1, bytes: f.wire, maxRetries: 100 }));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(Object.keys(f.runtime.agent), ['submitDecisionBytesV1']);
  } finally { runtime?.closeV1(); f.cleanup(); }
});

test('trusted finalized acquisition closes only through recaptured source authority', async () => {
  const f = submissionRuntimeFixtureV1(); let source;
  f.submission.finalization_source = async () => ({ context: source.context,
    context_authority: source.context_authority, exact_quote_mint: source.exact_quote_mint });
  try {
    f.open(); await f.sign();
    const { inspectSignedLegacyWire } = await import('./reused/bounded-rebroadcast-v1.mjs');
    source = await createSyntheticAcquisitionAuthorityFixtureV1(f.mandate, { signature: inspectSignedLegacyWire(f.wire.toString('base64')).expectedSignature });
    const tx = source.transactions[0];
    f.setHandler(r => {
      if (r.kind === 'status' && r.ordinal >= 1000) return f.rpc(r, { context: { slot: tx.slot }, value: [{
        slot: tx.slot, confirmations: null, err: null, confirmationStatus: 'finalized' }] });
      if (r.kind === 'transaction') return f.rpc(r, { slot: tx.slot, blockTime: tx.block_time,
        transaction: [f.wire.toString('base64'), 'base64'], meta: { err: null } });
      return f.defaultHandler(r);
    });
    assert.equal((await f.runtime.trusted.submitRetainedIntentV1(1)).classification, 'FINALIZED_SUCCESS');
    assert.equal(typeof f.runtime.trusted.finalizeRetainedIntentV1, 'function');
    const state = await f.runtime.trusted.finalizeRetainedIntentV1(1);
    assert.equal(state.state, 'ACQUISITION_EVIDENCE_CLOSED');
    assert.equal(state.chain_derived_acquired_jup_raw, '21437310');
    f.close(); f.open();
    assert.deepEqual(await f.runtime.trusted.finalizeRetainedIntentV1(1), state);
    const a = createCrashDurableDecisionAuthorityV1({ state_root: f.stateRoot });
    try { assert.equal((await a.inspectEpisodeV1({ episode_id: state.episode_id })).ordinals[0].stage, 'FINALIZED'); }
    finally { a.closeV1(); }
    source.context = { ...source.context, evidence_context_digest: 'f'.repeat(64) };
    await assert.rejects(f.runtime.trusted.finalizeRetainedIntentV1(1));
  } finally { f.cleanup(); }
});

for (const defect of ['nonfinalized-error', 'contradictory-error']) {
  test(`trusted terminal rejects ${defect} instead of promoting provider error`, async () => {
    const f = submissionRuntimeFixtureV1();
    try {
      f.open(); await f.sign();
      f.setHandler(r => {
        if (r.kind === 'status' && r.ordinal >= 1000) return f.rpc(r, { context: { slot: 900000010 }, value: [{
          slot: 900000010, confirmations: null, err: { InstructionError: [0, 'GenericError'] },
          confirmationStatus: defect === 'nonfinalized-error' ? 'confirmed' : 'finalized' }] });
        if (r.kind === 'transaction') return f.rpc(r, { slot: 900000010, transaction: [f.wire.toString('base64'), 'base64'],
          meta: { err: { InstructionError: [0, defect === 'contradictory-error' ? 'InvalidArgument' : 'GenericError'] } } });
        return f.defaultHandler(r);
      });
      const result = await f.runtime.trusted.submitRetainedIntentV1(1);
      assert.equal(result.classification, 'UNRESOLVED');
    } finally { f.cleanup(); }
  });
}
