import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { createBoundedAgentOfflineEpisodeFixtureV1 } from './fixtures/bounded-agent-offline-v1.mjs';
import { closeTrustedTerminalSourceV1 } from './wiggles-terminal-closure-v1.mjs';
import { createFrozenControlledHeliusTargetAccountEnumerationPortV2 } from '../../wallet-acquisition/target-account-enumeration-port-v1.mjs';

async function setup() {
  const f = await createBoundedAgentOfflineEpisodeFixtureV1();
  const txs = f.context.transaction_population.transactions.map(r => r.full_transaction).sort((a, b) => a.slot - b.slot);
  const m = f.mandate, a = f.evidence_graph.acquisition.finalized, d = f.evidence_graph.disposal;
  const data = Buffer.alloc(165);
  new PublicKey(m.asset_scope.jup_mint).toBuffer().copy(data);
  new PublicKey(m.wallet_scope.wallet).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(BigInt(a.chain_derived_target_raw_quantity), 64); data[108] = 1;
  async function enumeration(slot = txs[0].slot, amount = a.chain_derived_target_raw_quantity) {
    const bytes = Buffer.from(data); bytes.writeBigUInt64LE(BigInt(amount), 64);
    return createFrozenControlledHeliusTargetAccountEnumerationPortV2({ wallet: m.wallet_scope.wallet,
      target_mint: m.asset_scope.jup_mint, boundary_kind: 'OPENING', minimum_context_slot: slot }, {
      clock: () => 0, sleep: async () => {}, async request({ body }) {
        const result = { jsonrpc: '2.0', id: body.id, result: { context: { slot }, value: body.params[1].programId === m.wallet_scope.token_program ? [{
          pubkey: m.wallet_scope.jup_ata, account: { data: [bytes.toString('base64'), 'base64'], executable: false,
            lamports: 2039280, owner: m.wallet_scope.token_program, rentEpoch: 0, space: 165 } }] : [] } };
        return { status: 200, data: result, raw_body_sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
      } });
  }
  const records = [], calls = [];
  const state = { ...f.terminal_state, disposal_evidence_digest: null };
  const source = { context: f.context, context_authority: f.context_authority, exact_quote_mint: m.asset_scope.usdc_mint,
    terminal_projection: { version: 'artifact_terminal_leg_projection_v1', acquisition_finalized: a, opening_enumeration_port: await enumeration() } };
  const input = { c: { mandate: m, authorization: f.authorization }, authority: {
    async loadCurrentEpisodeStateV1() { return state; }, async recordFinalizedV1(v) { calls.push(v); } },
    x: { episode_id: state.episode_id, row: { ordinal: 2, phase: 'DISPOSAL', transaction_signature: txs[1].signature,
      signed_intent_digest: d.signed_transaction_intent_digest, signed_wire_sha256: d.signed_transaction_intent.signed_wire_sha256,
      message_sha256: d.signed_transaction_intent.message_sha256, stage: 'SIGNED_INTENT_DURABLE' } },
    terminal: { meta: { err: null }, slot: txs[1].slot, blockTime: txs[1].block_time },
    capture: async () => source, retain: async r => { records.push(r); } };
  const durable = structuredClone(input.x.row);
  input.authority.inspectEpisodeV1 = async () => ({ ordinals: [durable] });
  return { f, txs, input, source, records, calls, enumeration };
}

test('terminal disposal closes from the complete two-row source and independently captured intermediate inventory', async () => {
  const f = await setup();
  await closeTrustedTerminalSourceV1(f.input);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].finalized_evidence_digest, f.f.evidence_graph.disposal.finalized.finalized_evidence_digest);
  assert.equal(f.records[0].context.transaction_population.transactions.length, 2);
  assert.equal(f.records[0].projection.opening_quantity, '21437310');
  assert.equal(f.records[0].projection.whole_source_digest, f.source.context.evidence_context_digest);
});

test('projection rejects ordinal/intent/basis/boundary and missing-source substitutions without closure', async t => {
  const cases = {
    'wrong ordinal': f => { f.input.x.row.ordinal = 1; },
    'wrong phase': f => { f.input.x.row.phase = 'ACQUISITION'; },
    'wrong signature': f => { f.input.x.row.transaction_signature = f.txs[0].signature; },
    'wrong signed intent': f => { f.input.x.row.signed_intent_digest = 'a'.repeat(64); },
    'wrong basis': f => { f.source.terminal_projection.acquisition_finalized = f.f.evidence_graph.disposal.finalized; },
    'missing basis': f => { delete f.source.terminal_projection.acquisition_finalized; },
    'enumeration before acquisition': async f => { f.source.terminal_projection.opening_enumeration_port = await f.enumeration(f.txs[0].slot - 1); },
    'enumeration after disposal': async f => { f.source.terminal_projection.opening_enumeration_port = await f.enumeration(f.txs[1].slot); },
    'wrong observed quantity': async f => { f.source.terminal_projection.opening_enumeration_port = await f.enumeration(f.txs[0].slot, '1'); },
    'missing enumeration provenance': f => { f.source.terminal_projection.opening_enumeration_port = {}; },
    'missing required source row': f => { f.source.context = structuredClone(f.source.context); f.source.context.transaction_population.transactions.pop(); },
    'unaccounted source activity': f => { f.source.context = structuredClone(f.source.context); f.source.context.transaction_population.transactions.push(f.source.context.transaction_population.transactions[0]); },
    'failed execution cannot become closure': f => { f.input.terminal.meta.err = { InstructionError: [0, 'InvalidArgument'] }; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const f = await setup(); await mutate(f);
    await assert.rejects(closeTrustedTerminalSourceV1(f.input));
    assert.equal(f.calls.length, 0); assert.equal(f.records.length, 0);
  });
});
