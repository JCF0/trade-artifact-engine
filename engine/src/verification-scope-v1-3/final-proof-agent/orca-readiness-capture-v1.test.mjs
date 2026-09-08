import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrcaReadinessCaptureV1 } from './orca-readiness-capture-v1.mjs';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { buildFixedTestMandateV1, buildFixedTestAuthorizationV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { sha256CanonicalJson } from '../contract.mjs';
import { canonicalJson } from '../contract.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedTestMandateInputV1, buildFixedTestAgentDecisionV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { buildBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { createAuthorizedEpisodeStateV1 } from './episode-state-machine-v1.mjs';
import { createCrashDurableDecisionAuthorityV1, provisionCrashDurableDecisionAuthorityV1 } from './sqlite-decision-authority-v1.mjs';
import { createOfflineOrcaSigningCompositionV1 } from './orca-signing-composition-v1.mjs';
const routeFixture = JSON.parse(readFileSync(new URL('../../../orca-readiness-sdk/fixtures/raw-rpc-3107-getMultipleAccounts.json', import.meta.url))).result;
// Synthetic account envelope; raw calibration replay remains byte-exact in the separate replay test.
for (const account of routeFixture.value) account.rentEpoch = 0;
const SIG = '1'.repeat(64);
const ACQUISITION_SIG = '1'.repeat(63) + '2';
function fixture({ disposal = false, change = () => {}, overrides = {} } = {}) {
  const mandate = buildFixedTestMandateV1(), authorization = buildFixedTestAuthorizationV1(mandate);
  const time = { value: 1900000010, mono: 0 };
  const state = { episode_id: `bounded-agent-episode-${authorization.authorization_digest}`,
    mandate_digest: mandate.mandate_digest, authorization_digest: authorization.authorization_digest,
    state: disposal ? 'ACQUISITION_EVIDENCE_CLOSED' : 'AUTHORIZED_DORMANT', state_digest: 'a'.repeat(64),
    acquisition_evidence_digest: disposal ? 'b'.repeat(64) : null,
    chain_derived_acquired_jup_raw: disposal ? '21454691' : null };
  const calls = [], retained = [];
  const budget = { total_calls: 64, call_timeout_ms: 1000, overall_timeout_ms: 60000, freshness_seconds: 30,
    history_pages: 4, max_response_bytes: 1048576, fee_retry_count: 1, fee_retry_delay_ms: 0,
    methods: { getGenesisHash: 1, getSlot: 1, getBlock: 1, getMultipleAccounts: 2, getAccountInfo: 1,
      getTokenAccountsByOwner: 2, getSignaturesForAddress: 12, getLatestBlockhash: 1, getFeeForMessage: 2, getBlockHeight: 1 } };
  function account(mint, raw) {
    const a = structuredClone(routeFixture.value[mint === mandate.asset_scope.jup_mint ? 4 : 5]);
    const b = Buffer.from(a.data[0], 'base64');
    new PublicKey(mandate.wallet_scope.wallet).toBuffer().copy(b, 32);
    b.writeBigUInt64LE(BigInt(raw), 64); a.data[0] = b.toString('base64'); return a;
  }
  const opening = [{ owner: '11111111111111111111111111111111', executable: false, data: ['', 'base64'],
    lamports: disposal ? 815624 : 820624, rentEpoch: 0 },
  account(mandate.asset_scope.jup_mint, disposal ? '21454691' : '0'),
  account(mandate.asset_scope.usdc_mint, disposal ? '1000000' : '6000000')];
  const context = value => ({ context: { slot: 900000000 }, value });
  const transport = async ({ body, signal }) => {
    calls.push(body); assert.equal(signal.aborted, false);
    let result;
    switch (body.method) {
      case 'getGenesisHash': result = mandate.network.genesis_hash; break;
      case 'getSlot': result = 900000000; break;
      case 'getBlock': result = { blockTime: time.value, blockhash: mandate.wallet_scope.wallet }; break;
      case 'getMultipleAccounts': {
        if (body.params[0].length === 3) result = context(structuredClone(opening));
        else {
          const route = structuredClone(routeFixture.value);
          if (disposal) for (let i = 1; i <= 3; i++) {
            const b = Buffer.from(route[i].data[0], 'base64'); b.writeInt32LE(-14784 - (i - 1) * 352, 8);
            route[i].data[0] = b.toString('base64');
          }
          result = context(route);
        }
        break;
      }
      case 'getTokenAccountsByOwner': result = context(body.params[1].programId === mandate.wallet_scope.token_program
        ? [1, 2].map(i => ({ pubkey: [null, mandate.wallet_scope.jup_ata, mandate.wallet_scope.usdc_ata][i], account: structuredClone(opening[i]) })) : []); break;
      case 'getSignaturesForAddress': result = body.params[1].before ? [] : [
        ...(disposal ? [{ signature: ACQUISITION_SIG, slot: 899999999, blockTime: time.value - 10, err: null, memo: null, confirmationStatus: 'finalized' }] : []),
        { signature: SIG, slot: 1, blockTime: mandate.setup_authority.latest_setup_block_time, err: null, memo: null, confirmationStatus: 'finalized' }]; break;
      case 'getAccountInfo': result = context(structuredClone(routeFixture.value[0])); break;
      case 'getLatestBlockhash': result = context({ blockhash: mandate.wallet_scope.wallet, lastValidBlockHeight: 900000100 }); break;
      case 'getFeeForMessage': result = context(5000); break;
      case 'getBlockHeight': result = 900000000; break;
      default: throw new Error('unexpected method');
    }
    const envelope = { jsonrpc: '2.0', id: body.id, result };
    await change({ body, envelope, time, calls });
    return JSON.stringify(envelope);
  };
  const options = { mandate, authorization, budget, deadline_unix_seconds: 2000000000,
    clock: { unixSeconds: () => time.value, monotonicMs: () => time.mono }, transport,
    retain_evidence: async value => { retained.push(value); return sha256CanonicalJson(value); },
    durable_episode_authority: { loadCurrentEpisodeStateV1: async () => state,
      inspectEpisodeV1: async () => ({ revoked: false, ordinals: disposal ? [{ ordinal: 1, transaction_signature: ACQUISITION_SIG }] : [] }) }, ...overrides };
  const port = createOrcaReadinessCaptureV1(options);
  return { port, calls, retained, time, state, options,
    issue: () => port.issueReadinessChallengeV1({ phase: disposal ? 'DISPOSAL' : 'ACQUISITION', state }) };
}
test('synthetic acquisition capture issues a byte-bound challenge from real route decoding and quote', async () => {
  const f = fixture(); const challenge = await f.issue();
  const source = await f.port.captureBuildInputV1({ challenge });
  assert.equal(source.minimum_output_raw, '21347418');
  assert.equal(challenge.readiness_evidence_digest, sha256CanonicalJson({ episode_id: f.state.episode_id, ordinal: 1, source }));
  assert.ok(f.retained.at(-1).raw_evidence_digests.length > 0);
});
test('synthetic disposal capture reconciles retained quantity without zero-JUP opening', async () => {
  const f = fixture({ disposal: true }); const challenge = await f.issue();
  assert.equal(challenge.chain_derived_disposal_jup_raw, '21454691');
  assert.equal(challenge.finalized_acquisition_evidence_digest, f.state.acquisition_evidence_digest);
});
test('capture refuses absent explicit budget/deadline before transport', () => {
  let calls = 0;
  assert.throws(() => createOrcaReadinessCaptureV1({ transport: () => { calls++; } }));
  assert.equal(calls, 0);
});

for (const [name, mutate, expected] of [
  ['wrong owner', ({ body, envelope }) => { if (body.method === 'getAccountInfo') envelope.result.value.owner = SIG; }, /account envelope/],
  ['wrong enumerated account', ({ body, envelope }) => { if (body.method === 'getTokenAccountsByOwner' && envelope.result.value.length) envelope.result.value[0].pubkey = envelope.result.value[1].pubkey; }, /owner source authority/],
  ['unsafe wallet balance', ({ body, envelope }) => { if (body.method === 'getMultipleAccounts' && body.params[0].length === 3) envelope.result.value[0].lamports = Number.MAX_SAFE_INTEGER + 1; }, /unsafe RPC numeric field/],
  ['wrong raw token amount', ({ body, envelope }) => { if (body.method === 'getMultipleAccounts' && body.params[0].length === 3) {
    const b = Buffer.from(envelope.result.value[1].data[0], 'base64'); b.writeBigUInt64LE(1n, 64); envelope.result.value[1].data[0] = b.toString('base64');
  } }, /opening\/disposal balance/],
  ['wrong vault owner', ({ body, envelope }) => { if (body.method === 'getMultipleAccounts' && body.params[0].length === 6) {
    const b = Buffer.from(envelope.result.value[4].data[0], 'base64'); b.fill(0, 32, 64); envelope.result.value[4].data[0] = b.toString('base64');
  } }, { code: 'token_account_authority_mismatch' }],
  ['wrong pool mint', ({ body, envelope }) => { if (body.method === 'getMultipleAccounts' && body.params[0].length === 6) {
    const b = Buffer.from(envelope.result.value[0].data[0], 'base64'); b.fill(0, 101, 133); envelope.result.value[0].data[0] = b.toString('base64');
  } }, /route identity/],
  ['wrong tick relationship', ({ body, envelope }) => { if (body.method === 'getMultipleAccounts' && body.params[0].length === 6) {
    const b = Buffer.from(envelope.result.value[1].data[0], 'base64'); b.writeInt32LE(0, 8); envelope.result.value[1].data[0] = b.toString('base64');
  } }, /tick relationship/],
  ['incomplete enumeration', ({ body, envelope }) => { if (body.method === 'getTokenAccountsByOwner') envelope.result.value = []; }, /population/],
  ['conflicting context', ({ body, envelope }) => { if (body.method === 'getTokenAccountsByOwner') envelope.result.context.slot--; }, /owner source authority/],
  ['incomplete history', ({ body, envelope }) => { if (body.method === 'getSignaturesForAddress') envelope.result = []; }, /history completeness/],
  ['stale anchor', ({ body, envelope }) => { if (body.method === 'getBlock') envelope.result.blockTime -= 31; }, /anchor freshness/],
  ['wrong fee', ({ body, envelope }) => { if (body.method === 'getFeeForMessage') envelope.result.value = 5001; }, /exact message fee/],
  ['fee correlation mismatch', ({ body, envelope }) => { if (body.method === 'getFeeForMessage') envelope.id = 'different-request'; }, /correlation/],
  ['blockhash expiry', ({ body, envelope }) => { if (body.method === 'getBlockHeight') envelope.result = 900000100; }, /blockhash expired/],
  ['overall deadline', ({ body, time }) => { if (body.method === 'getSlot') time.mono = 60000; }, /overall deadline/],
  ['stale capture', ({ body, time }) => { if (body.method === 'getFeeForMessage') time.value += 31; }, /capture stale/],
]) test(`capture refuses ${name} without a readiness manifest`, async () => {
  const f = fixture({ change: mutate });
  await assert.rejects(f.issue(), expected);
  assert.ok(!f.retained.some(record => record.challenge));
});
for (const target of ['initial pool', 'route pool', 'fixed tick']) for (const defect of ['discriminator', 'truncated', 'trailing']) {
  test(`RC3 ${target} rejects ${defect} without readiness`, async () => {
    const f = fixture({ change: ({ body, envelope }) => {
      let account;
      if (target === 'initial pool' && body.method === 'getAccountInfo') account = envelope.result.value;
      if (target !== 'initial pool' && body.method === 'getMultipleAccounts' && body.params[0].length === 6) {
        account = envelope.result.value[target === 'route pool' ? 0 : 1];
      }
      if (!account) return;
      let raw = Buffer.from(account.data[0], 'base64');
      if (defect === 'discriminator') raw[0] ^= 1;
      if (defect === 'truncated') raw = raw.subarray(0, raw.length - 1);
      if (defect === 'trailing') raw = Buffer.concat([raw, Buffer.from([0])]);
      account.data[0] = raw.toString('base64'); account.space = raw.length;
    } });
    await assert.rejects(f.issue());
    assert.ok(!f.retained.some(record => record.challenge));
    assert.equal(f.calls.some(body => body.method === 'getFeeForMessage'), false);
  });
}
test('strict seven-day equality fails; next integer second succeeds with exhaustive synthetic histories', async () => {
  const equal = fixture(); equal.time.value = 1789216028;
  await assert.rejects(equal.issue(), /strict age/);
  const eligible = fixture(); eligible.time.value = 1789216029;
  assert.equal((await eligible.issue()).issued_at_unix_seconds, 1789216029);
});
for (const staleCall of [1, 2, 3]) test(`RC4 stale consistent history refuses at observation ${staleCall}`, async () => {
  let historyCalls = 0;
  const f = fixture({ change: ({ body, envelope }) => {
    if (body.method !== 'getSignaturesForAddress') return;
    historyCalls++;
    // Model the existing provider's minContextSlot contract, not a fabricated
    // result.context. Without a floor these old pages and repeated heads agree.
    if (historyCalls === staleCall && body.params[1].minContextSlot > 899999999) {
      delete envelope.result; envelope.error = { code: -32016, message: 'Minimum context slot has not been reached' };
    }
  } });
  await assert.rejects(f.issue(), /RPC refused/);
  assert.equal(historyCalls, staleCall);
  assert.ok(!f.retained.some(record => record.challenge));
});
test('RC4 valid history binds every page and repeated head to opening above anchor', async () => {
  const f = fixture({ change: ({ body, envelope }) => {
    if (body.method === 'getMultipleAccounts' && body.params[0].length === 3
        || body.method === 'getTokenAccountsByOwner') envelope.result.context.slot++;
  } });
  await f.issue();
  const history = f.calls.filter(body => body.method === 'getSignaturesForAddress');
  assert.equal(history.length, 9);
  assert.ok(history.every(body => body.params[1].minContextSlot === 900000001));
  assert.ok(history.some(body => body.params[1].before));
});
test('fee retry uses identical bytes and counts against shared budget', async () => {
  let fees = 0;
  const f = fixture({ change: ({ body, envelope }) => {
    if (body.method === 'getFeeForMessage' && ++fees === 1) { delete envelope.result; envelope.error = { code: -32016 }; }
  } });
  await f.issue();
  const requests = f.calls.filter(body => body.method === 'getFeeForMessage');
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  const fail = fixture({ change: ({ body, envelope }) => {
    if (body.method === 'getFeeForMessage') { delete envelope.result; envelope.error = { code: -32016 }; }
  } });
  await assert.rejects(fail.issue(), /RPC refused/);
  assert.equal(fail.calls.filter(body => body.method === 'getFeeForMessage').length, 2);
});
test('per-call timeout and whole-capture timeout bound hung transport and evidence sink', async () => {
  const base = fixture();
  for (const kind of ['transport', 'retain_evidence']) {
    const f = fixture({ overrides: { budget: { ...base.options.budget, overall_timeout_ms: 30, call_timeout_ms: 10 },
      [kind]: () => new Promise(() => {}) } });
    await assert.rejects(f.issue(), /timeout/);
  }
});
test('RC1 overdue successful transport refuses before delayed timer delivery', async () => {
  const f = fixture({ change: ({ body, time }) => {
    if (body.method === 'getGenesisHash') time.mono = 1000;
  } });
  await assert.rejects(f.issue(), /RPC timeout/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.retained.length, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  assert.equal(f.retained.length, 0);
});
test('RC1 initial authority work consumes the overall monotonic budget', async () => {
  const f = fixture();
  const port = createOrcaReadinessCaptureV1({ ...f.options, durable_episode_authority: {
    ...f.options.durable_episode_authority,
    async loadCurrentEpisodeStateV1() { f.time.mono = 60000; return f.state; },
  } });
  await assert.rejects(port.issueReadinessChallengeV1({ phase: 'ACQUISITION', state: f.state }), /overall deadline/);
  assert.equal(f.calls.length, 0);
});
test('RC1 overdue fee error cannot initiate its otherwise allowed retry', async () => {
  const f = fixture({ change: ({ body, envelope, time }) => {
    if (body.method === 'getFeeForMessage') {
      time.mono += 1000; delete envelope.result; envelope.error = { code: -32016 };
    }
  } });
  await assert.rejects(f.issue(), /RPC timeout/);
  assert.equal(f.calls.filter(body => body.method === 'getFeeForMessage').length, 1);
  assert.ok(!f.retained.some(record => record.challenge));
});
test('RC1 abort-ignoring late settlement cannot retry or retain evidence', async () => {
  const f = fixture(); let settle, calls = 0;
  const port = createOrcaReadinessCaptureV1({ ...f.options,
    budget: { ...f.options.budget, call_timeout_ms: 5 },
    transport: () => { calls++; return new Promise(resolve => { settle = resolve; }); },
  });
  await assert.rejects(port.issueReadinessChallengeV1({ phase: 'ACQUISITION', state: f.state }), /timeout/);
  settle(JSON.stringify({ jsonrpc: '2.0', id: 'wallet-acquisition-v1', result: f.options.mandate.network.genesis_hash }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(f.retained.length, 0);
});
test('shared total and pagination caps refuse before readiness', async () => {
  const base = fixture();
  const capped = fixture({ overrides: { budget: { ...base.options.budget, total_calls: 2 } } });
  await assert.rejects(capped.issue(), /budget exhausted/); assert.equal(capped.calls.length, 2);
  const pages = fixture({ overrides: { budget: { ...base.options.budget, history_pages: 1 } } });
  await assert.rejects(pages.issue(), /history completeness/);
});
test('disposal refuses retained quantity and evidence absence', async () => {
  const f = fixture({ disposal: true }); f.state.chain_derived_acquired_jup_raw = '1';
  await assert.rejects(f.issue(), /balance/);
  const missing = fixture({ disposal: true }); missing.state.acquisition_evidence_digest = null;
  await assert.rejects(missing.issue(), /retained acquisition missing/);
});
test('issued source cannot be reused at expiry or under another challenge', async () => {
  const f = fixture(); const challenge = await f.issue();
  await assert.rejects(f.port.captureBuildInputV1({ challenge: { ...challenge, challenge_digest: 'c'.repeat(64) } }), /unknown capture/);
  f.time.value = challenge.expires_at_unix_seconds;
  await assert.rejects(f.port.captureBuildInputV1({ challenge }), /stale readiness/);
  await assert.rejects(f.port.assertFreshBeforeSigningV1({ challenge }), /stale readiness/);
});
for (const method of ['captureBuildInputV1', 'assertFreshBeforeSigningV1']) test(`RC2 ${method} refuses elapsed freshness despite wall rollback`, async () => {
  const f = fixture(); const challenge = await f.issue();
  f.time.mono = 30000; f.time.value--;
  await assert.rejects(f.port[method]({ challenge }), /stale readiness/);
});
test('RC2 clock regression is terminal and a fresh capture instance cannot adopt old freshness', async () => {
  const f = fixture(); f.time.mono = 10;
  const challenge = await f.issue();
  f.time.mono = 9;
  await assert.rejects(f.port.captureBuildInputV1({ challenge }), /clock|freshness/);
  f.time.mono = 10;
  await assert.rejects(f.port.assertFreshBeforeSigningV1({ challenge }));
  const reopened = createOrcaReadinessCaptureV1(f.options);
  await assert.rejects(reopened.captureBuildInputV1({ challenge }), /unknown capture/);
  await assert.rejects(reopened.assertFreshBeforeSigningV1({ challenge }));
});
test('precision-losing fractional rentEpoch wire tokens refuse capture even when Number rounds to a safe integer', async () => {
  const f = fixture();
  const port = createOrcaReadinessCaptureV1({ ...f.options,
    transport: async request => (await f.options.transport(request)).replaceAll('"rentEpoch":0', '"rentEpoch":1.00000000000000000001'),
  });
  await assert.rejects(port.issueReadinessChallengeV1({ phase: 'ACQUISITION', state: f.state }), /rentEpoch/);
  assert.ok(!f.retained.some(record => record.challenge));
});
test('different rentEpoch identities between opening and enumeration remain rejected', async () => {
  const f = fixture({ change: ({ body, envelope }) => {
    if (body.method === 'getTokenAccountsByOwner') for (const row of envelope.result.value) {
      row.account.rentEpoch = '18446744073709551615';
    }
  } });
  await assert.rejects(f.issue(), /enumeration account conflict/);
  assert.ok(!f.retained.some(record => record.challenge));
});
for (const disposal of [false, true]) test(`synthetic eligible ${disposal ? 'disposal' : 'acquisition'} accepts exact u64 wire metadata`, async () => {
  const f = fixture({ disposal });
  const port = createOrcaReadinessCaptureV1({ ...f.options,
    transport: async request => (await f.options.transport(request)).replaceAll('"rentEpoch":0', '"rentEpoch":18446744073709551615'),
  });
  const challenge = await port.issueReadinessChallengeV1({ phase: disposal ? 'DISPOSAL' : 'ACQUISITION', state: f.state });
  assert.equal(challenge.ordinal, disposal ? 2 : 1);
  assert.ok(f.retained.some(record => record.challenge));
  assert.ok(f.retained.some(record => record.raw_response?.includes('"rentEpoch":18446744073709551615')));
});
for (const outcome of ['REFUSED', 'RC1_REFUSED', 'RC3_REFUSED', 'RC4_REFUSED', 'INERT_SIGNER', 'EXPIRED_AT_SIGNING', 'RC2_MONOTONIC_EXPIRED_AT_SIGNING', 'RC2_CLOCK_DOMAIN_AT_SIGNING', 'RC2_RESTART']) test(`captured readiness with authenticated SQLite composition: ${outcome}`, async () => {
  const input = fixedTestMandateInputV1();
  input.unresolved_live_readiness = {
    human_authorization_public_key: input.offline_identity.human_authorization_public_key,
    agent_control_public_key: input.offline_identity.agent_control_public_key,
    acquisition_not_after_unix_seconds: input.offline_identity.acquisition_not_after_unix_seconds,
    rpc_budget_table_sha256: input.offline_identity.rpc_budget_table_sha256,
    executor_release_sha256: input.offline_identity.executor_release_sha256, status: 'RESOLVED',
  }; // Fixed test identities only, never a live configuration.
  const mandate = buildBoundedAgentMandateV1(input), authorization = buildFixedTestAuthorizationV1(mandate);
  const state = createAuthorizedEpisodeStateV1({ mandate, authorization });
  const root = mkdtempSync(join(tmpdir(), 'artifact-readiness-capture-'));
  provisionCrashDurableDecisionAuthorityV1({ state_root: root, initial_episode_state: state,
    executor_release_sha256: authorization.executor_release_sha256 });
  let db = createCrashDurableDecisionAuthorityV1({ state_root: root });
  const f = fixture({ change: ({ body, envelope, time }) => {
    if (outcome === 'REFUSED' && body.method === 'getTokenAccountsByOwner') {
      for (const row of envelope.result.value) row.account.rentEpoch = '18446744073709551616';
    }
    if (outcome === 'RC1_REFUSED' && body.method === 'getGenesisHash') time.mono = 1000;
    if (outcome === 'RC3_REFUSED' && body.method === 'getAccountInfo') {
      const raw = Buffer.from(envelope.result.value.data[0], 'base64'); raw[0] ^= 1;
      envelope.result.value.data[0] = raw.toString('base64');
    }
    if (outcome === 'RC4_REFUSED' && body.method === 'getSignaturesForAddress'
        && body.params[1].minContextSlot > 899999999) {
      delete envelope.result; envelope.error = { code: -32016 };
    }
  } });
  let authority = { ...db, async recordKeyLoadStartedV1(request) {
    const result = await db.recordKeyLoadStartedV1(request);
    if (outcome === 'EXPIRED_AT_SIGNING') f.time.value += 30;
    if (outcome === 'RC2_MONOTONIC_EXPIRED_AT_SIGNING') { f.time.mono += 30000; f.time.value--; }
    if (outcome === 'RC2_CLOCK_DOMAIN_AT_SIGNING') f.options.clock.monotonicMs = () => 0;
    return result;
  } };
  const port = createOrcaReadinessCaptureV1({ ...f.options, mandate, authorization, durable_episode_authority: authority });
  let signs = 0;
  const composition = buildPort => createOfflineOrcaSigningCompositionV1({ mandate, authorization, state_root: root,
    executor_release_sha256: authorization.executor_release_sha256, durable_episode_authority: authority,
    acquisition_closure_port: {}, readiness_challenge_port: port, build_input_port: buildPort,
    message_signer_port: { async signExactMessageV1() { signs++; throw Error('INERT_SIGNER'); } } });
  let control = composition(port);
  try {
    if (outcome.endsWith('REFUSED')) {
      const reason = { REFUSED: /owner source authority/, RC1_REFUSED: /RPC timeout/,
        RC3_REFUSED: /layout\/discriminator/, RC4_REFUSED: /RPC refused/ }[outcome];
      await assert.rejects(control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: f.time.value }), reason);
      assert.equal(signs, 0);
    } else {
      const challenge = await control.issueReadinessChallengeV1({ phase: 'ACQUISITION', now_unix_seconds: f.time.value });
      const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
      if (outcome === 'RC2_RESTART') {
        db.closeV1(); db = createCrashDurableDecisionAuthorityV1({ state_root: root }); authority = db;
        control = composition(createOrcaReadinessCaptureV1({
          ...f.options, mandate, authorization, durable_episode_authority: authority,
        }));
      }
      await assert.rejects(control.executeAuthenticatedDecisionBytesV1({
        decision_bytes: Buffer.from(canonicalJson(decision)), now_unix_seconds: f.time.value + 1,
      }), outcome === 'INERT_SIGNER' ? /INERT_SIGNER/ : outcome === 'RC2_RESTART' ? /unknown capture/
        : outcome === 'RC2_CLOCK_DOMAIN_AT_SIGNING' ? /clock/ : /stale readiness before signer/);
      assert.equal(signs, outcome === 'INERT_SIGNER' ? 1 : 0);
      if (outcome.startsWith('RC2_')) {
        assert.equal((await db.inspectEpisodeV1({ episode_id: state.episode_id })).ordinals[0].stage,
          outcome === 'RC2_RESTART' ? 'RESERVED' : 'KEY_LOAD_STARTED_AMBIGUOUS');
        await assert.rejects(control.executeAuthenticatedDecisionBytesV1({
          decision_bytes: Buffer.from(canonicalJson(decision)), now_unix_seconds: f.time.value + 1,
        }));
        assert.equal(signs, 0);
      }
    }
  } finally { db.closeV1(); rmSync(root, { recursive: true, force: true }); }
});
