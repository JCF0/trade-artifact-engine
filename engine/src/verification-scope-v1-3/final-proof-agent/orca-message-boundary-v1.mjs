import { createHash } from 'node:crypto';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { validateExecutorMandateV1 as validateBoundedAgentMandateV1 } from './executor-mandate-profile-v1.mjs';

// Pure mapping only: these inputs must come from executor-owned readiness authority.
// This module cannot attest a quote, finalized pool state, message fee, or chain time.
const plans = new WeakSet();
const FIELDS = ['mandate', 'phase', 'ordinal', 'input_raw_quantity',
  'retained_acquisition_jup_raw', 'blockhash', 'tick_spacing', 'tick_current_index',
  'quoted_output_raw', 'minimum_output_raw', 'fee_lamports'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function reject(message) { fail('bounded_agent_orca_message_invalid', message); }
function raw(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)
      || BigInt(value) > 18446744073709551615n) reject('raw quantity is outside u64');
  return BigInt(value);
}
export function buildOrcaMessageBoundaryV1(input) {
  assertExactFields(input, FIELDS, 'orca_message_input');
  // Snapshot plain data before construction; canonical contract rejects hostile graphs.
  const v = cloneAndFreeze(input);
  const m = v.mandate;
  validateBoundedAgentMandateV1(m);
  const acquisition = v.phase === 'ACQUISITION' && v.ordinal === 1;
  if (!acquisition && !(v.phase === 'DISPOSAL' && v.ordinal === 2)) reject('phase/ordinal mismatch');
  const amount = raw(v.input_raw_quantity);
  if (acquisition ? v.input_raw_quantity !== m.economic_authority.acquisition_input_usdc_raw
      || v.retained_acquisition_jup_raw !== null
    : v.input_raw_quantity !== v.retained_acquisition_jup_raw) reject('quantity does not match authority');
  const quote = raw(v.quoted_output_raw), minimum = raw(v.minimum_output_raw);
  if (minimum > quote || minimum * 10000n < quote * (10000n - BigInt(m.economic_authority.maximum_slippage_bps))) {
    reject('minimum output exceeds slippage authority');
  }
  if (v.fee_lamports !== m.opening_contract[acquisition ? 'acquisition_fee_lamports' : 'disposal_fee_lamports']) {
    reject('exact message fee does not match mandate');
  }
  if (!Number.isSafeInteger(v.tick_spacing) || v.tick_spacing <= 0 || v.tick_spacing > 65535
      || !Number.isSafeInteger(v.tick_current_index) || Object.is(v.tick_current_index, -0)
      || v.tick_current_index < -443636 || v.tick_current_index > 443636) reject('tick derivation input invalid');
  const width = v.tick_spacing * 88;
  const base = Math.floor(v.tick_current_index / width) * width;
  const shifted = acquisition && v.tick_current_index + v.tick_spacing >= base + width;
  const offsets = acquisition ? (shifted ? [1, 2, 3] : [0, 1, 2]) : [0, -1, -2];
  const program = new PublicKey(m.route_scope.whirlpool_program), pool = new PublicKey(m.route_scope.pool);
  const ticks = offsets.map(offset => PublicKey.findProgramAddressSync([
    Buffer.from('tick_array'), pool.toBuffer(), Buffer.from(String(base + offset * width)),
  ], program)[0]);
  let blockhash;
  try { blockhash = new PublicKey(v.blockhash).toBase58(); } catch { reject('blockhash invalid'); }
  if (blockhash !== v.blockhash) reject('blockhash noncanonical');
  const keys = [
    [m.wallet_scope.token_program, false, false], [m.wallet_scope.wallet, true, false],
    [m.route_scope.pool, false, true], [m.wallet_scope.jup_ata, false, true],
    [m.route_scope.jup_vault, false, true], [m.wallet_scope.usdc_ata, false, true],
    [m.route_scope.usdc_vault, false, true], ...ticks.map(key => [key, false, true]),
    [m.route_scope.oracle, false, false],
  ].map(([pubkey, isSigner, isWritable]) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable }));
  const data = Buffer.alloc(42);
  Buffer.from('f8c69e91e17587c8', 'hex').copy(data);
  data.writeBigUInt64LE(amount, 8); data.writeBigUInt64LE(minimum, 16);
  const price = acquisition ? 79226673515401279992447579055n : 4295048016n;
  data.writeBigUInt64LE(price & ((1n << 64n) - 1n), 24); data.writeBigUInt64LE(price >> 64n, 32);
  data[40] = 1; data[41] = acquisition ? 0 : 1;
  const tx = new Transaction({ feePayer: new PublicKey(m.wallet_scope.wallet), recentBlockhash: blockhash });
  tx.add(new TransactionInstruction({ programId: program, keys, data }));
  const bytes = tx.serializeMessage();
  const plan = cloneAndFreeze({
    version: 'artifact_orca_exact_message_v1', phase: v.phase, ordinal: v.ordinal,
    mandate_digest: m.mandate_digest, input_mint: acquisition ? m.asset_scope.usdc_mint : m.asset_scope.jup_mint,
    output_mint: acquisition ? m.asset_scope.jup_mint : m.asset_scope.usdc_mint,
    input_raw_quantity: v.input_raw_quantity, minimum_output_raw: v.minimum_output_raw,
    fee_lamports: v.fee_lamports, input_digest: sha256CanonicalJson(v),
    message_base64: bytes.toString('base64'), message_sha256: hash(bytes),
  });
  plans.add(plan);
  return plan;
}
export function assertExactOrcaMessageV1(plan, bytes) {
  if (!plans.has(plan) || !Buffer.isBuffer(bytes)
      || !bytes.equals(Buffer.from(plan.message_base64, 'base64'))) reject('message does not match constructed plan');
  return true;
}
