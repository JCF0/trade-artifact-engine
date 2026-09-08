import test from 'node:test';
import assert from 'node:assert/strict';
import { Message, Transaction } from '@solana/web3.js';
import { buildFixedTestMandateV1 } from './fixtures/fixed-test-identities-v1.mjs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Orca acquisition mapping fixes the exact legacy instruction and rejects altered message bytes', async () => {
  const { buildOrcaMessageBoundaryV1, assertExactOrcaMessageV1 } = await import('./orca-message-boundary-v1.mjs');
  const mandate = buildFixedTestMandateV1();
  const input = {
    mandate, phase: 'ACQUISITION', ordinal: 1, input_raw_quantity: '5000000',
    retained_acquisition_jup_raw: null, blockhash: '11111111111111111111111111111111',
    tick_spacing: 64, tick_current_index: 0, quoted_output_raw: '10000000',
    minimum_output_raw: '9950000', fee_lamports: '5000',
  };
  const plan = buildOrcaMessageBoundaryV1(input);
  const bytes = Buffer.from(plan.message_base64, 'base64');
  const message = Message.from(bytes);
  assert.equal(message.header.numRequiredSignatures, 1);
  assert.equal(message.accountKeys[0].toBase58(), mandate.wallet_scope.wallet);
  assert.equal(message.instructions.length, 1);
  assert.equal(message.instructions[0].accounts.length, 11);
  const instruction = Transaction.populate(message).instructions[0];
  assert.equal(instruction.programId.toBase58(), mandate.route_scope.whirlpool_program);
  assert.equal(instruction.data.subarray(0, 8).toString('hex'), 'f8c69e91e17587c8');
  assert.equal(instruction.data.readBigUInt64LE(8), 5000000n);
  assert.equal(instruction.data.readBigUInt64LE(16), 9950000n);
  assert.equal(instruction.data.readBigUInt64LE(24) + (instruction.data.readBigUInt64LE(32) << 64n), 79226673515401279992447579055n);
  assert.deepEqual([...instruction.data.subarray(40)], [1, 0]);
  assert.deepEqual(instruction.keys.slice(0, 7).map(key => key.pubkey.toBase58()), [
    mandate.wallet_scope.token_program, mandate.wallet_scope.wallet, mandate.route_scope.pool,
    mandate.wallet_scope.jup_ata, mandate.route_scope.jup_vault, mandate.wallet_scope.usdc_ata, mandate.route_scope.usdc_vault,
  ]);
  assert.equal(assertExactOrcaMessageV1(plan, bytes), true);
  const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1;
  assert.throws(() => assertExactOrcaMessageV1(plan, altered), /message/);
});

test('strict slippage uses exact cross-products for divisible and non-divisible quotes', async () => {
  const { buildOrcaMessageBoundaryV1 } = await import('./orca-message-boundary-v1.mjs');
  const mandate = buildFixedTestMandateV1();
  assert.equal(mandate.economic_authority.maximum_slippage_bps, 50);
  for (const [quoted_output_raw, minimum_output_raw, allowed] of [
    ['10000001', '9950001', true], ['10000000', '9950000', true],
    ['10000000', '9949999', false], ['10000001', '9950000', false],
  ]) {
    const oracle = BigInt(minimum_output_raw) * 10000n
      >= BigInt(quoted_output_raw) * (10000n - BigInt(mandate.economic_authority.maximum_slippage_bps));
    assert.equal(oracle, allowed);
    const build = () => buildOrcaMessageBoundaryV1({
      mandate, phase: 'ACQUISITION', ordinal: 1, input_raw_quantity: '5000000',
      retained_acquisition_jup_raw: null, blockhash: '11111111111111111111111111111111',
      tick_spacing: 64, tick_current_index: 0, quoted_output_raw, minimum_output_raw, fee_lamports: '5000',
    });
    if (oracle) assert.equal(build().minimum_output_raw, minimum_output_raw);
    else assert.throws(build, {
      code: 'bounded_agent_orca_message_invalid', message: 'minimum output exceeds slippage authority',
    });
  }
});

test('signed-wire handoff verifies exact message and test signature, fsyncs retention and refuses replacement', async () => {
  const { retainExactSignedWireV1 } = await import('./orca-signed-wire-boundary-v1.mjs');
  const key = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' +
    '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', 'hex'), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  const message = Buffer.concat([Buffer.from([1, 0, 0, 1]), pub, Buffer.alloc(32, 7), Buffer.from([0])]);
  const wire = Buffer.concat([Buffer.from([1]), sign(null, message, key), message]);
  const root = mkdtempSync(join(tmpdir(), 'artifact-wire-boundary-'));
  try {
    const altered = Buffer.from(wire); altered[1] ^= 1;
    assert.throws(() => retainExactSignedWireV1({ root, ordinal: 1, message, wire: altered }), /signature/);
    assert.throws(() => retainExactSignedWireV1({ root, ordinal: 1, message: Buffer.alloc(1), wire }), /message/);
    const retained = retainExactSignedWireV1({ root, ordinal: 1, message, wire });
    assert.deepEqual(readFileSync(retained.signed_wire_path), wire);
    assert.throws(() => retainExactSignedWireV1({ root, ordinal: 1, message, wire }), /EEXIST/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('full disposal and all exact construction constraints reject substitutions', async () => {
  const { buildOrcaMessageBoundaryV1, assertExactOrcaMessageV1 } = await import('./orca-message-boundary-v1.mjs');
  const input = {
    mandate: buildFixedTestMandateV1(), phase: 'DISPOSAL', ordinal: 2, input_raw_quantity: '21437310',
    retained_acquisition_jup_raw: '21437310', blockhash: '11111111111111111111111111111111',
    tick_spacing: 64, tick_current_index: 0, quoted_output_raw: '5000000',
    minimum_output_raw: '4975000', fee_lamports: '5000',
  };
  const plan = buildOrcaMessageBoundaryV1(input);
  assert.equal(plan.input_raw_quantity, input.retained_acquisition_jup_raw);
  assert.equal(plan.input_mint, input.mandate.asset_scope.jup_mint);
  const disposal = Transaction.populate(Message.from(Buffer.from(plan.message_base64, 'base64'))).instructions[0];
  assert.equal(disposal.data.readBigUInt64LE(8), 21437310n);
  assert.equal(disposal.data.readBigUInt64LE(16), 4975000n);
  assert.equal(disposal.data.readBigUInt64LE(24) + (disposal.data.readBigUInt64LE(32) << 64n), 4295048016n);
  assert.deepEqual([...disposal.data.subarray(40)], [1, 1]);
  for (const change of [{ input_raw_quantity: '21437309' }, { ordinal: 1 },
    { minimum_output_raw: '4974999' }, { minimum_output_raw: '5000001' },
    { fee_lamports: '5001' }, { fee_lamports: null }, { quoted_output_raw: null },
    { tick_spacing: 0 }, { blockhash: 'x' }, { compute_budget: true }]) {
    assert.throws(() => buildOrcaMessageBoundaryV1({ ...input, ...change }));
  }
  const bytes = Buffer.from(plan.message_base64, 'base64');
  assert.throws(() => assertExactOrcaMessageV1({ ...plan }, bytes), /message/);
  // Every serialized byte is protected, not just the instruction discriminator.
  for (let i = 0; i < bytes.length; i += 1) {
    const changed = Buffer.from(bytes); changed[i] ^= 1;
    assert.throws(() => assertExactOrcaMessageV1(plan, changed), /message/);
  }
  for (const field of ['wallet_scope', 'route_scope', 'asset_scope', 'transaction_profile']) {
    const changed = structuredClone(input);
    changed.mandate[field][Object.keys(changed.mandate[field])[0]] = 'unauthorized';
    assert.throws(() => buildOrcaMessageBoundaryV1(changed));
  }
});
