// Qualification-only orchestration of accepted pure quote/builder functions.
// No readiness admission, authorization, signer, episode or state-store imports.
import { PublicKey, Message, Transaction } from '/accepted/engine/node_modules/@solana/web3.js/lib/index.cjs.js';
import { decodeFixedWhirlpoolV1, decodeFixedTickArrayV1, swapQuoteByInputToken } from '/accepted/engine/orca-readiness-sdk/index.mjs';
import { assertQualificationContextV1, buildQualificationMessageV1 } from './qualification-contract-v1.mjs';
import { decodeSolanaTokenAccountDataV1 } from '/accepted/engine/src/wallet-acquisition/solana-token-account-decoder-v1.mjs';
import { put } from './bounded-successor.mjs';
export const check = x => { if (!x) throw Error('QUALIFICATION_PUBLIC_INPUT_STOP'); };
const integer = x => Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0);
const cfg = minContextSlot => ({ commitment: 'finalized', encoding: 'base64', minContextSlot });
function floor(r, n) { check(integer(r?.context?.slot) && r.context.slot >= n); return r; }
function bytes(a, owner, size) {
  check(a?.owner === owner && a.executable === false && integer(a.lamports)
    && Array.isArray(a.data) && a.data.length === 2 && a.data[1] === 'base64' && typeof a.data[0] === 'string');
  const b = Buffer.from(a.data[0], 'base64');
  check(b.toString('base64') === a.data[0] && (size === undefined || b.length === size)); return b;
}
function starts(p) {
  check(integer(p.tickSpacing) && p.tickSpacing > 0 && p.tickSpacing <= 65535
    && Number.isSafeInteger(p.tickCurrentIndex) && Math.abs(p.tickCurrentIndex) <= 443636);
  const width = p.tickSpacing * 88, base = Math.floor(p.tickCurrentIndex / width) * width;
  return (p.tickCurrentIndex + p.tickSpacing >= base + width ? [1, 2, 3] : [0, 1, 2]).map(i => base + i * width);
}
export function unsignedWire(plan) {
  const message = Buffer.from(plan.message_base64, 'base64'), parsed = Message.from(message);
  check(parsed.serialize().equals(message) && parsed.header.numRequiredSignatures === 1);
  const tx = Transaction.populate(parsed), wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  check(tx.serializeMessage().equals(message) && wire[0] === 1 && wire.subarray(1, 65).every(b => b === 0));
  return wire;
}
export async function constructAndSimulate(session, context, minimum, root) {
  assertQualificationContextV1(context);
  const m = context.scope;
  const first = floor(await session.call('getAccountInfo', [m.route_scope.pool, cfg(minimum)]), minimum);
  const initial = decodeFixedWhirlpoolV1(bytes(first.value, m.route_scope.whirlpool_program));
  const indices = starts(initial), program = new PublicKey(m.route_scope.whirlpool_program), poolKey = new PublicKey(m.route_scope.pool);
  const ticks = indices.map(i => PublicKey.findProgramAddressSync([Buffer.from('tick_array'), poolKey.toBuffer(), Buffer.from(String(i))], program)[0].toBase58());
  const addresses = [m.route_scope.pool, ...ticks, m.route_scope.jup_vault, m.route_scope.usdc_vault,
    m.route_scope.oracle, m.asset_scope.jup_mint, m.asset_scope.usdc_mint];
  const route = floor(await session.call('getMultipleAccounts', [addresses, cfg(first.context.slot)]), first.context.slot);
  check(Array.isArray(route.value) && route.value.length === addresses.length);
  const p = decodeFixedWhirlpoolV1(bytes(route.value[0], m.route_scope.whirlpool_program));
  check(String(p.tokenMintA) === m.asset_scope.jup_mint && String(p.tokenMintB) === m.asset_scope.usdc_mint
    && String(p.tokenVaultA) === m.route_scope.jup_vault && String(p.tokenVaultB) === m.route_scope.usdc_vault
    && p.feeTierIndexSeed[0] + 256 * p.feeTierIndexSeed[1] === p.tickSpacing && JSON.stringify(starts(p)) === JSON.stringify(indices));
  const arrays = route.value.slice(1, 4).map((a, i) => {
    const t = decodeFixedTickArrayV1(bytes(a, m.route_scope.whirlpool_program));
    check(t.startTickIndex === indices[i] && String(t.whirlpool) === m.route_scope.pool); return t;
  });
  for (const [i, mint] of [[4, m.asset_scope.jup_mint], [5, m.asset_scope.usdc_mint]]) {
    bytes(route.value[i], m.wallet_scope.token_program, 165);
    const { token_state: t } = decodeSolanaTokenAccountDataV1({ raw_base64: route.value[i].data[0], token_program: m.wallet_scope.token_program, expected_wallet: m.route_scope.pool });
    check(t.mint === mint && t.delegate_status === 'NONE' && t.close_authority_status === 'NONE' && t.account_state === 'INITIALIZED');
  }
  bytes(route.value[6], m.route_scope.whirlpool_program);
  for (const i of [7, 8]) bytes(route.value[i], m.wallet_scope.token_program, 82);
  const quoteTime = Math.floor(Date.now() / 1000), amount = m.economic_authority.acquisition_input_usdc_raw;
  const q = swapQuoteByInputToken(BigInt(amount), false, m.economic_authority.maximum_slippage_bps, p, undefined, arrays, BigInt(quoteTime));
  check(q.tokenIn === BigInt(amount) && q.tokenEstOut > 0n);
  const minimumOut = (q.tokenEstOut * (10000n - BigInt(m.economic_authority.maximum_slippage_bps)) + 9999n) / 10000n;
  const latest = floor(await session.call('getLatestBlockhash', [{ commitment: 'finalized', minContextSlot: route.context.slot }]), route.context.slot);
  check(integer(latest.value?.lastValidBlockHeight));
  const input = { version: 'ARTIFACT_QUALIFICATION_CONSTRUCTION_INPUT_V1',
    qualification_provenance_sha256: context.qualification_provenance_sha256, scope: m,
    phase: 'ACQUISITION', ordinal: 1, input_raw_quantity: amount,
    blockhash: latest.value.blockhash, tick_spacing: p.tickSpacing, tick_current_index: p.tickCurrentIndex,
    quoted_output_raw: String(q.tokenEstOut), minimum_output_raw: String(minimumOut), fee_lamports: m.opening_contract.acquisition_fee_lamports };
  const plan = buildQualificationMessageV1(context, input);
  put(root, 'construction.json', { classification: 'QUALIFICATION_ONLY_NO_AUTHORIZATION_OR_ELIGIBILITY', input, quote_time: quoteTime, route_context: route.context.slot, plan });
  const wire = unsignedWire(plan); put(root, 'unsigned-wire.bin', wire);
  const fee = floor(await session.call('getFeeForMessage', [plan.message_base64, { commitment: 'finalized', minContextSlot: latest.context.slot }]), latest.context.slot);
  check(integer(fee.value) && String(fee.value) === input.fee_lamports);
  const height = await session.call('getBlockHeight', [{ commitment: 'finalized', minContextSlot: fee.context.slot }]);
  check(integer(height) && height < latest.value.lastValidBlockHeight);
  const result = floor(await session.call('simulateTransaction', [wire.toString('base64'),
    { encoding: 'base64', commitment: 'finalized', sigVerify: false, replaceRecentBlockhash: false, minContextSlot: fee.context.slot }]), fee.context.slot);
  const v = result.value;
  check(v && Object.hasOwn(v, 'err') && (v.replacementBlockhash === undefined || v.replacementBlockhash === null));
  const outcome = v.err === null ? 'OBSERVED_UNSIGNED_EXECUTION_SUCCESS' : 'OBSERVED_UNSIGNED_PROGRAM_REFUSAL';
  put(root, 'simulation-disposition.json', { outcome, context_slot: result.context.slot, minimum_context_slot: fee.context.slot,
    message_sha256: plan.message_sha256, all_signatures_zero: true, replacement: false, finalized_occurrence: 'NOT_ESTABLISHED' });
  check(v.err === null && integer(v.unitsConsumed) && Array.isArray(v.logs) && v.logs.every(s => typeof s === 'string'));
  return outcome;
}
