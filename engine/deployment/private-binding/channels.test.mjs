import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, sign } from 'node:crypto';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { buildFixedTestAgentDecisionV1 } from '../../src/verification-scope-v1-3/final-proof-agent/fixtures/fixed-test-identities-v1.mjs';
import { buildHumanRevocationV1, humanRevocationSigningBytesV1 } from '../../src/verification-scope-v1-3/final-proof-agent/human-revocation-v1.mjs';

test('actual anonymous FD table and EOF/duplicate/conflict/overflow/output-loss cases', () => {
  const child = spawnSync('/usr/bin/python3', [fileURLToPath(new URL('./fixtures/fd-cases.py', import.meta.url))],
    { env: {}, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim().split('\n').length, 8);
});
for (const scenario of ['wait', 'simulation', 'submission']) {
  test(`actual independent human FD revokes during ${scenario} with durable acknowledgment and consumed-state reopen`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-channel-parent-')), fds = [];
    for (let i = 0; i < 3; i++) { const path = join(root, `synthetic-${i}`); writeFileSync(path, '{}', { mode: 0o600 }); fds.push(openSync(path, 'r')); }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/supervised-fd-worker.mjs', import.meta.url)), scenario],
      { env: {}, stdio: ['ignore', 'pipe', 'pipe', ...fds, ...Array(10).fill('pipe')] });
    fds.forEach(closeSync);
    let stderr = '', stdout = '', identity, context, challenge, inFlight = false, humanSent = false, decisionSent = false, ack = '';
    child.stderr.on('data', b => { stderr += b; });
    const key = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')]) });
    function progress() {
      if (!identity || !challenge || !context) return;
      if (scenario !== 'wait' && !decisionSent) {
        decisionSent = true;
        child.stdio[6].end(Buffer.from(canonicalJson(buildFixedTestAgentDecisionV1(identity.mandate, identity.authorization, challenge))));
      }
      if (humanSent || (scenario !== 'wait' && (!inFlight || context.predecessor_state === 'AUTHORIZED'))) return;
      // Read the separately delivered current predecessor, never controller state.
      if (scenario === 'simulation' && context.predecessor_state !== 'ACQUISITION_ADMITTED') return;
      if (scenario === 'submission' && context.predecessor_state !== 'ACQUISITION_SUBMISSION_RESOLVING') return;
      humanSent = true;
      const unsigned = { episode_id: context.episode_id, mandate_digest: identity.mandate.mandate_digest,
        authorization_digest: identity.authorization.authorization_digest, human_public_key: identity.authorization.human_public_key,
        predecessor_state: context.predecessor_state, predecessor_state_digest: context.predecessor_state_digest,
        revoked_at_unix_seconds: context.now, revocation_nonce: 'private-channel-disposable',
        revocation_statement: 'REVOKE_BOUNDED_AGENT_FINAL_PROOF_AUTHORIZATION' };
      child.stdio[12].end(Buffer.from(canonicalJson(buildHumanRevocationV1({ ...unsigned,
        signature: sign(null, humanRevocationSigningBytesV1(unsigned), key).toString('hex') }))));
    }
    let publicBuffer = '';
    child.stdout.on('data', b => {
      stdout += b; publicBuffer += b;
      for (;;) { const i = publicBuffer.indexOf('\n'); if (i < 0) break;
        const line = publicBuffer.slice(0, i); publicBuffer = publicBuffer.slice(i + 1);
        if (line === 'IN_FLIGHT') inFlight = true;
        else { const value = JSON.parse(line); if (value.mandate) identity = value; }
      }
      progress();
    });
    function frames(stream, consume) {
      let buffer = ''; stream.on('data', b => { buffer += b;
        for (;;) { const end = buffer.indexOf('\n\n'); if (end < 0) break;
          consume(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 2); progress(); }
      });
    }
    frames(child.stdio[7], value => { challenge = value; });
    frames(child.stdio[13], value => { context = value; });
    child.stdio[14].on('data', b => { ack += b; });
    for (const fd of [8, 10, 11, 15]) child.stdio[fd].resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    try {
      const code = await new Promise(resolve => child.once('close', resolve));
      assert.equal(code, 0, stderr + stdout);
      assert.equal(humanSent, true);
      assert.equal(JSON.parse(ack).status, 'REVOCATION_DURABLE');
      assert.match(stdout, /"revoked":true/);
      if (scenario === 'simulation') assert.match(stdout, /KEY_LOAD_STARTED_AMBIGUOUS/);
      if (scenario === 'submission') assert.match(stdout, /SUBMISSION_POSSIBLE/);
    } finally { clearTimeout(timer); child.kill('SIGKILL'); child.stdio.forEach(s => s?.destroy()); rmSync(root, { recursive: true, force: true }); }
  });
}
