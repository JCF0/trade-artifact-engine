// SYNTHETIC ONLY. Public disposable identities; generated RPC observations are
// not onchain evidence. Signing is confined to fixture construction, never replay.
import { Keypair, Message, Transaction, PublicKey } from '@solana/web3.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256CanonicalJson as digest } from '../../contract.mjs';
import { buildOfflineWalletMandateV1 } from '../executor-mandate-profile-v1.mjs';
import { fixedTestMandateInputV1, buildFixedTestAuthorizationV1, buildFixedTestAgentDecisionV1 } from './fixed-test-identities-v1.mjs';
import { syntheticRuntimeCaptureV1 } from './trusted-runtime-offline-v1.mjs';
import { decodeFixedWhirlpoolV1, decodeFixedTickArrayV1 } from '../../../../orca-readiness-sdk/index.mjs';
import { createOrcaReadinessCaptureV1 } from '../orca-readiness-capture-v1.mjs';
import { buildOrcaMessageBoundaryV1 } from '../orca-message-boundary-v1.mjs';
import { createAuthorizedEpisodeStateV1, admitAgentDecisionStateV1, recordSignedIntentV1, closeFinalizedLegV1 } from '../episode-state-machine-v1.mjs';
import { createOfflineTrustedSubmissionV1 } from '../wiggles-submission-v1.mjs';
import { buildFinalizedLegEvidenceV1 } from '../episode-evidence-graph-v1.mjs';
import { validateHeliusFullTransactionV1 } from '../../../wallet-acquisition/helius-full-transaction-validator.mjs';
import { inspectSignedLegacyWire, encodeBase58 } from '../reused/bounded-rebroadcast-v1.mjs';
import { retainedEpisodeFixtureV1, writeRetainedEpisodeFixtureV1, hash, TOKEN, TOKEN2022 } from './retained-episode-offline-v1.mjs';

function normalized(raw) {
  const w = inspectSignedLegacyWire(raw.transaction[0]), m = Message.from(w.message);
  return validateHeliusFullTransactionV1({ ...raw, transaction: { signatures: [w.expectedSignature], message: {
    header: m.header, accountKeys: m.accountKeys.map(k => k.toBase58()), recentBlockhash: m.recentBlockhash, instructions: m.instructions } } }, w.expectedSignature);
}
function finalized(m, wire, phase, amount, output, slot, time) {
  const tx = Transaction.from(wire), message = tx.compileMessage(), keys = message.accountKeys.map(k => k.toBase58());
  const index = key => keys.indexOf(key);
  const acquisition = phase === 'ACQUISITION';
  const walletJupBefore = acquisition ? 0n : BigInt(amount), walletJupAfter = acquisition ? BigInt(output) : 0n;
  const walletQuoteBefore = acquisition ? 6000000n : 1000000n, walletQuoteAfter = acquisition ? 1000000n : 1000000n + BigInt(output);
  const balance = (account, mint, owner, n) => ({ accountIndex: index(account), mint, owner,
    uiTokenAmount: { amount: String(n), decimals: 6, uiAmount: null, uiAmountString: String(Number(n) / 1e6) }, programId: TOKEN });
  const rows = (jup, quote) => [balance(m.wallet_scope.jup_ata, m.asset_scope.jup_mint, m.wallet_scope.wallet, jup),
    balance(m.wallet_scope.usdc_ata, m.asset_scope.usdc_mint, m.wallet_scope.wallet, quote),
    balance(m.route_scope.jup_vault, m.asset_scope.jup_mint, m.route_scope.pool, 1000000000000n - jup),
    balance(m.route_scope.usdc_vault, m.asset_scope.usdc_mint, m.route_scope.pool, 1000000000000n - quote)];
  const transfer = (from, to, owner, n) => { const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(BigInt(n), 1);
    return { programIdIndex: index(TOKEN), accounts: [from, to, owner].map(index), data: encodeBase58(data), stackHeight: 2 }; };
  const transfers = acquisition ? [transfer(m.wallet_scope.usdc_ata, m.route_scope.usdc_vault, m.wallet_scope.wallet, amount),
    transfer(m.route_scope.jup_vault, m.wallet_scope.jup_ata, m.route_scope.pool, output)]
    : [transfer(m.wallet_scope.jup_ata, m.route_scope.jup_vault, m.wallet_scope.wallet, amount),
      transfer(m.route_scope.usdc_vault, m.wallet_scope.usdc_ata, m.route_scope.pool, output)];
  const preBalances = keys.map((_, i) => i === 0 ? (acquisition ? 820624 : 815624) : 0);
  const postBalances = [...preBalances]; postBalances[0] -= 5000;
  return { slot, blockTime: time, version: 'legacy', transaction: [wire.toString('base64'), 'base64'], meta: {
    err: null, fee: 5000, preBalances, postBalances,
    preTokenBalances: rows(walletJupBefore, walletQuoteBefore), postTokenBalances: rows(walletJupAfter, walletQuoteAfter),
    innerInstructions: [{ index: 0, instructions: transfers }], logMessages: [], rewards: [], loadedAddresses: { writable: [], readonly: [] }, computeUnitsConsumed: 1,
  } };
}
export async function retainedFinalEpisodeFixtureV1({ failed = false } = {}) {
  const mandate = buildOfflineWalletMandateV1(fixedTestMandateInputV1());
  const authorization = buildFixedTestAuthorizationV1(mandate, '-retained-final');
  const source = syntheticRuntimeCaptureV1(mandate); source.budget.fee_retry_count = 0;
  const files = new Map(), rawTransactions = [], legs = [], rows = [];
  const put = (name, v) => { files.set(name, Buffer.from(canonicalJson(v))); return name; };
  const rpc = result => ({ jsonrpc: '2.0', id: 1, result });
  const signer = Keypair.fromSeed(Buffer.alloc(32, 7));
  if (signer.publicKey.toBase58() !== mandate.wallet_scope.wallet) throw Error('disposable fixture identity mismatch');
  let state = createAuthorizedEpisodeStateV1({ mandate, authorization }), acquired = null;
  const root = mkdtempSync(join(tmpdir(), 'artifact-synthetic-generation-'));
  try {
    for (const ordinal of [1, 2]) {
      const phase = ordinal === 1 ? 'ACQUISITION' : 'DISPOSAL', slot = 900000000 + (ordinal - 1) * 20;
      source.time.wall = 1900000010 + (ordinal - 1) * 20; source.time.mono = 0;
      const records = [], captures = [];
      const authority = {
        async loadCurrentEpisodeStateV1() { return state; },
        async inspectEpisodeV1() { return { revoked: false, ordinals: rows }; },
      };
      const capture = createOrcaReadinessCaptureV1({ mandate, authorization, budget: source.budget,
        deadline_unix_seconds: 1900001000, clock: source.clock, durable_episode_authority: authority,
        async retain_evidence(v) {
          writeFileSync(join(root, `readiness-evidence-${digest(v)}.json`), canonicalJson(v), { mode: 0o600 });
          (v.request ? records : captures).push(v); return digest(v);
        },
        async transport(request) {
          const envelope = JSON.parse(await source.transport(request)), result = envelope.result;
          if (result?.context) result.context.slot = slot;
          if (request.body.method === 'getSlot') envelope.result = slot;
          if (ordinal === 2) {
            if (request.body.method === 'getMultipleAccounts' && request.body.params[0].length === 6) {
              const pool = decodeFixedWhirlpoolV1(Buffer.from(result.value[0].data[0], 'base64'));
              const width = pool.tickSpacing * 88, base = Math.floor(pool.tickCurrentIndex / width) * width;
              result.value.slice(1, 4).forEach((account, i) => {
                const b = Buffer.from(account.data[0], 'base64');
                if (b.readInt32LE(8) !== decodeFixedTickArrayV1(b).startTickIndex) throw Error('fixture tick layout');
                b.writeInt32LE(base - i * width, 8); account.data[0] = b.toString('base64');
              });
            }
            const update = a => { const b = Buffer.from(a.data[0], 'base64'); b.writeBigUInt64LE(new PublicKey(mandate.asset_scope.jup_mint).toBuffer().equals(b.subarray(0, 32)) ? BigInt(acquired) : 1000000n, 64); a.data[0] = b.toString('base64'); };
            if (request.body.method === 'getMultipleAccounts' && request.body.params[0].length === 3) {
              result.value[0].lamports = 815624; result.value.slice(1).forEach(update);
            }
            if (request.body.method === 'getTokenAccountsByOwner') result.value.forEach(row => update(row.account));
            if (request.body.method === 'getSignaturesForAddress' && !request.body.params[1].before) result.unshift({
              signature: rows[0].transaction_signature, slot: rawTransactions[0].slot, blockTime: rawTransactions[0].blockTime,
              err: null, memo: null, confirmationStatus: 'finalized' });
          }
          return JSON.stringify(envelope);
        },
      });
      const challenge = await capture.issueReadinessChallengeV1({ phase, state });
      const decision = buildFixedTestAgentDecisionV1(mandate, authorization, challenge);
      const admitted = admitAgentDecisionStateV1({ state, mandate, authorization, challenge, decision,
        executor_release_sha256: authorization.executor_release_sha256, now_unix_seconds: decision.signed_at_unix_seconds });
      state = admitted.state;
      const captured = captures[0], { fee_message_sha256, ...buildSource } = captured.source;
      const amount = ordinal === 1 ? '5000000' : acquired;
      const plan = buildOrcaMessageBoundaryV1({ ...buildSource, mandate, phase, ordinal, input_raw_quantity: amount,
        retained_acquisition_jup_raw: ordinal === 1 ? null : acquired });
      const tx = Transaction.populate(Message.from(Buffer.from(plan.message_base64, 'base64'))); tx.sign(signer);
      const wire = tx.serialize(), parsed = inspectSignedLegacyWire(wire.toString('base64'));
      const signed = { signed_transaction_intent_version: 'artifact_bounded_agent_signed_transaction_intent_v1', episode_id: state.episode_id,
        phase, admission_digest: admitted.admission.admission_digest, semantic_transaction_digest: digest(plan),
        message_sha256: hash(parsed.message), signed_wire_sha256: hash(wire), signature: parsed.expectedSignature, sign_count: 1 };
      const prepared = { prepared_transaction_version: 'artifact_bounded_agent_prepared_transaction_v1', episode_id: state.episode_id, phase,
        admission_digest: admitted.admission.admission_digest, wallet: mandate.wallet_scope.wallet, pool: mandate.route_scope.pool,
        input_mint: plan.input_mint, output_mint: plan.output_mint, input_raw_quantity: amount,
        maximum_slippage_bps: mandate.economic_authority.maximum_slippage_bps, transaction_profile: 'DIRECT_CLASSIC_ORCA_LEGACY_SWAP_V1',
        unsigned_transaction_digest: digest(plan), readiness_evidence_digest: challenge.readiness_evidence_digest };
      const row = { ordinal, phase, stage: 'SIGNED_INTENT_DURABLE', challenge_id: challenge.challenge_id,
        admission_digest: admitted.admission.admission_digest, message_sha256: signed.message_sha256, signed_wire_sha256: signed.signed_wire_sha256,
        transaction_signature: signed.signature, signed_intent_digest: digest(signed), prepared_transaction_digest: digest(prepared), semantic_transaction_digest: digest(plan) };
      rows.push(row); state = recordSignedIntentV1({ state, signed_intent_digest: digest(signed) });
      const raw = finalized(mandate, wire, phase, amount, buildSource.quoted_output_raw, slot + 10, source.time.wall + 5);
      if (failed) {
        raw.meta.err = { InstructionError: [0, { Custom: 1 }] };
        raw.meta.postTokenBalances = structuredClone(raw.meta.preTokenBalances); raw.meta.innerInstructions = [];
      }
      rawTransactions.push(raw); if (ordinal === 1) acquired = buildSource.quoted_output_raw;
      const submission = createOfflineTrustedSubmissionV1({ state_root: root, mandate, authorization,
        executor_release_sha256: authorization.executor_release_sha256, deadline_unix_seconds: 1900001000 }, {
        authority: { ...authority, async loadIssuedReadinessChallengeV1() { return challenge; }, async readRetainedWireV1() { return wire; },
          async recordSubmissionPossibleV1() { row.stage = 'SUBMISSION_POSSIBLE'; } }, clock: source.clock,
        submission: { profile: 'OFFLINE_INJECTED_SUBMISSION_V1', max_calls: 188, overall_timeout_ms: 190000, max_response_bytes: 1048576,
          async sleep(ms) { source.time.mono += ms; }, async transport(request) {
            const result = request.kind === 'send' ? signed.signature : request.kind === 'status'
              ? { context: { slot: raw.slot }, value: [{ slot: raw.slot, confirmations: null, err: raw.meta.err, confirmationStatus: 'finalized' }] }
              : request.kind === 'blockHeight' ? 900000001 : raw;
            return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })) };
          } },
      });
      const outcome = await submission.submit(ordinal);
      if (outcome.classification !== (failed ? 'FINALIZED_FAILURE' : 'FINALIZED_SUCCESS')) throw Error(`synthetic transmission failed: ${canonicalJson(outcome)}`);
      const members = [];
      function walk(directory, prefix = '') { for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = prefix + entry.name; if (entry.isDirectory()) walk(join(directory, entry.name), `${path}/`);
        else { const member = `send-${ordinal}-${members.length}.bin`; files.set(member, readFileSync(join(directory, entry.name))); members.push({ path, member }); }
      } }
      walk(join(root, `submission-${ordinal}`));
      const final = failed ? null : buildFinalizedLegEvidenceV1({ episode_id: state.episode_id, phase, signed_intent_digest: digest(signed),
        signed_wire_sha256: signed.signed_wire_sha256, message_sha256: signed.message_sha256, signature: signed.signature,
        finalized_transaction_digest: digest(normalized(raw)), slot: raw.slot, block_time: raw.blockTime, execution_status: 'SUCCEEDED',
        wallet: mandate.wallet_scope.wallet, input_mint: plan.input_mint, output_mint: plan.output_mint,
        input_raw_quantity: amount, chain_derived_target_raw_quantity: ordinal === 1 ? acquired : '0' });
      legs.push({ challenge, decision, admitted_at_unix_seconds: decision.signed_at_unix_seconds, admission: admitted.admission,
        signed_intent: signed, wire_member: put(`wire-${ordinal}.json`, { base64: wire.toString('base64') }),
        capture_member: put(`capture-${ordinal}.json`, captured), record_members: records.map((r, i) => put(`capture-${ordinal}-raw-${i}.json`, r)),
        submission_members: members, finalized: final });
      if (failed) break;
      state = closeFinalizedLegV1({ state, phase, finalized_evidence_digest: final.finalized_evidence_digest,
        chain_derived_acquired_jup_raw: ordinal === 1 ? acquired : null });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  const descriptor = retainedEpisodeFixtureV1().descriptor;
  descriptor.version = 'artifact_final_episode_replay_v2'; descriptor.evidence_kind = 'SYNTHETIC_FINAL_EPISODE';
  descriptor.scope.wallet = mandate.wallet_scope.wallet; descriptor.acquisition_request.wallet = mandate.wallet_scope.wallet;
  descriptor.history = { genesis: put('genesis.json', rpc(mandate.network.genesis_hash)), slot: put('slot.json', rpc(900000041)),
    block: put('block.json', rpc({ blockTime: 1900000051, blockhash: mandate.wallet_scope.wallet })), pages: [put('history.json', rpc([...rawTransactions].reverse().map(raw => ({
      signature: inspectSignedLegacyWire(raw.transaction[0]).expectedSignature, slot: raw.slot, blockTime: raw.blockTime, err: raw.meta.err, memo: null, confirmationStatus: 'finalized' }))))] };
  descriptor.transactions = rawTransactions.map((raw, i) => ({ signature: inspectSignedLegacyWire(raw.transaction[0]).expectedSignature, response: put(`transaction-${i + 1}.json`, rpc(raw)) }));
  for (const [name, slot] of [['opening', 900000000], ['ending', 900000040]]) {
    const data = Buffer.alloc(165); new PublicKey(mandate.asset_scope.jup_mint).toBuffer().copy(data); new PublicKey(mandate.wallet_scope.wallet).toBuffer().copy(data, 32); data[108] = 1;
    descriptor[name] = { minimum_context_slot: slot, classic: put(`${name}-classic.json`, rpc({ context: { slot }, value: [{ pubkey: mandate.wallet_scope.jup_ata,
      account: { data: [data.toString('base64'), 'base64'], owner: TOKEN, lamports: 2039280, rentEpoch: 0, space: 165, executable: false } }] })),
      token_2022: put(`${name}-2022.json`, rpc({ context: { slot }, value: [] })) };
  }
  const control = { version: 'artifact_retained_control_v1', mandate, authorization, configured_principals: {
    human_public_key: authorization.human_public_key, agent_public_key: authorization.agent_public_key,
    executor_release_sha256: authorization.executor_release_sha256 }, legs, revocation: null };
  descriptor.control = 'control.json';
  return { descriptor, files, control, write(root) { this.files.set('control.json', Buffer.from(canonicalJson(this.control))); return writeRetainedEpisodeFixtureV1(root, this); } };
}
