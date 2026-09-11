// Pure qualification boundary. No mandate, authority, signer, transport or state-store imports.
import { createHash } from 'node:crypto';
import { PublicKey, Transaction, TransactionInstruction } from '/accepted/engine/node_modules/@solana/web3.js/lib/index.cjs.js';
import { getSwapInstructionDataEncoder } from '/accepted/engine/orca-readiness-sdk/node_modules/@orca-so/whirlpools-client/dist/index.js';
import { assertExactFields, cloneAndFreeze, sha256CanonicalJson } from '/accepted/engine/src/verification-scope-v1-3/contract.mjs';
import { QUALIFICATION_SCOPE_V1 as scope } from './qualification-scope-v1.mjs';
const PROVENANCE = 'ddf6f419d83227806f0b64e02cd334709ded5d56888a82437b01cf08cc9dc58d';
const contexts = new WeakSet();
const hash = b => createHash('sha256').update(b).digest('hex');
const check = x => { if (!x) throw Error('QUALIFICATION_CONTRACT_STOP'); };
const equal = (a, b) => sha256CanonicalJson(a) === sha256CanonicalJson(b);
function bytes(s) {
  check(typeof s === 'string' && s.length <= 2097152);
  const b = Buffer.from(s, 'base64'); check(b.toString('base64') === s); return b;
}
export function admitQualificationInputV1(value) {
  const v = cloneAndFreeze(value);
  assertExactFields(v, ['version', 'qualification_provenance_sha256', 'provenance_base64', 'validation_base64', 'members'], 'qualification_input');
  check(v.version === 'ARTIFACT_QUALIFICATION_INPUT_V1');
  const raw = bytes(v.provenance_base64), p = JSON.parse(raw.toString('utf8'));
  check(p.schema === 'ARTIFACT_QUALIFICATION_RECOVERED_PUBLIC_PROVENANCE_V1');
  check(v.qualification_provenance_sha256 === PROVENANCE && hash(raw) === PROVENANCE);
  // The fixed exact-byte identity closes every nested provenance field and binds
  // its explicit UNKNOWN historical archive, location-only attestation and purpose.
  check(equal(p.original_execution_archive, { status: 'UNKNOWN', sha256: null, filename: null, location: null }));
  check(p.purpose === 'PROVIDER_QUALIFICATION_ONLY_NO_TRADING_AUTHORITY_OR_ELIGIBILITY_APPROVAL');
  const validation = bytes(v.validation_base64);
  check(hash(validation) === p.recovered_public.retained_internal_validation.sha256);
  const report = JSON.parse(validation.toString('utf8'));
  check(report.classification === 'RECOVERED_PUBLIC_RECORDS_INTERNAL_CONSISTENCY_NOT_HISTORICAL_ARCHIVE_AUTHENTICATION');
  check(Array.isArray(v.members) && v.members.length === p.recovered_public.members.length);
  const files = new Map(); let total = 0;
  for (const [i, member] of v.members.entries()) {
    assertExactFields(member, ['path', 'base64'], 'qualification_member');
    const expected = p.recovered_public.members[i], b = bytes(member.base64);
    total += b.length; check(total <= 16777216);
    check(member.path === expected.path && !files.has(member.path));
    check(b.length === expected.bytes && hash(b) === expected.sha256); files.set(member.path, b);
  }
  const read = n => { check(files.has(n)); return JSON.parse(files.get(n).toString('utf8')); };
  const f = read('setup-freeze.json'), pre = read('setup-preflight.json');
  for (const name of ['wallet.json', 'setup-preflight.json', 'ata-creation-finalized.json', 'funding-finalized.json', 'setup-freeze.json']) {
    const r = read(name); for (const k of ['wallet', 'jup_ata', 'usdc_ata']) check(r[k] === scope.wallet_scope[k]);
  }
  const signatures = [];
  for (const [role, name] of [['ata_creation', 'ata-creation-finalized.json'], ['funding', 'funding-finalized.json']]) {
    const r = read(name), stored = f[role];
    for (const k of ['signature', 'slot', 'block_time', 'signed_bytes_sha256', 'effects_digest', 'fee_lamports', 'evidence_directory', 'evidence_manifest_sha256']) check(r[k] === stored[k]);
    check(r.proof_wallet_signed === false); signatures.push(r.signature);
  }
  check(equal(signatures, report.setup_signatures));
  check(f.latest_setup_or_funding_block_time === scope.age_gate.latest_setup_block_time
    && f.earliest_integer_proof_opening_unix === scope.age_gate.earliest_opening_candidate_unix_seconds);
  check(equal(pre.opening_contract, f.opening.contract));
  for (const k of ['jup_raw', 'usdc_raw', 'sol_lamports']) check(f.opening[k] === scope.opening_contract[k] && pre.exact_opening[k] === f.opening[k]);
  const context = cloneAndFreeze({ version: 'ARTIFACT_QUALIFICATION_CONTEXT_V1', qualification_provenance_sha256: PROVENANCE,
    scope, setup_signatures: signatures, latest_setup_block_time: f.latest_setup_or_funding_block_time });
  contexts.add(context); return context;
}
function raw(v) {
  check(typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v));
  const n = BigInt(v); check(n <= 18446744073709551615n); return n;
}
export function assertQualificationContextV1(context) {
  check(contexts.has(context));
}
export function buildQualificationMessageV1(context, value) {
  assertQualificationContextV1(context);
  const v = cloneAndFreeze(value);
  assertExactFields(v, ['version', 'qualification_provenance_sha256', 'scope', 'phase', 'ordinal', 'input_raw_quantity',
    'blockhash', 'tick_spacing', 'tick_current_index', 'quoted_output_raw', 'minimum_output_raw', 'fee_lamports'], 'qualification_construction');
  check(v.version === 'ARTIFACT_QUALIFICATION_CONSTRUCTION_INPUT_V1' && v.qualification_provenance_sha256 === context.qualification_provenance_sha256);
  check(equal(v.scope, scope) && v.phase === 'ACQUISITION' && v.ordinal === 1);
  check(v.input_raw_quantity === scope.economic_authority.acquisition_input_usdc_raw && v.fee_lamports === scope.opening_contract.acquisition_fee_lamports);
  const amount = raw(v.input_raw_quantity), quote = raw(v.quoted_output_raw), minimum = raw(v.minimum_output_raw);
  check(minimum <= quote && minimum * 10000n >= quote * (10000n - BigInt(scope.economic_authority.maximum_slippage_bps)));
  check(Number.isSafeInteger(v.tick_spacing) && v.tick_spacing > 0 && v.tick_spacing <= 65535);
  check(Number.isSafeInteger(v.tick_current_index) && !Object.is(v.tick_current_index, -0) && Math.abs(v.tick_current_index) <= 443636);
  check(typeof v.blockhash === 'string' && new PublicKey(v.blockhash).toBase58() === v.blockhash);
  const route = scope.route_scope, wallet = scope.wallet_scope;
  const width = v.tick_spacing * 88, base = Math.floor(v.tick_current_index / width) * width;
  const offsets = v.tick_current_index + v.tick_spacing >= base + width ? [1, 2, 3] : [0, 1, 2];
  const program = new PublicKey(route.whirlpool_program), pool = new PublicKey(route.pool);
  const ticks = offsets.map(i => PublicKey.findProgramAddressSync([Buffer.from('tick_array'), pool.toBuffer(), Buffer.from(String(base + i * width))], program)[0]);
  // Fixed classic Whirlpool acquisition account topology; not a general builder.
  const keys = [[wallet.token_program, false, false], [wallet.wallet, true, false], [route.pool, false, true],
    [wallet.jup_ata, false, true], [route.jup_vault, false, true], [wallet.usdc_ata, false, true], [route.usdc_vault, false, true],
    ...ticks.map(k => [k, false, true]), [route.oracle, false, false]]
    .map(([pubkey, isSigner, isWritable]) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable }));
  // Reuse installed/pinned Orca encoder; no swap algorithm, discriminator or data codec duplication.
  const data = Buffer.from(getSwapInstructionDataEncoder().encode({ amount, otherAmountThreshold: minimum,
    sqrtPriceLimit: 79226673515401279992447579055n, amountSpecifiedIsInput: true, aToB: false }));
  const tx = new Transaction({ feePayer: new PublicKey(wallet.wallet), recentBlockhash: v.blockhash });
  tx.add(new TransactionInstruction({ programId: program, keys, data }));
  const message = tx.serializeMessage();
  const plan = { version: 'ARTIFACT_QUALIFICATION_UNSIGNED_PLAN_V1', purpose: 'PROVIDER_BEHAVIOR_ONLY_NO_AUTHORITY',
    qualification_provenance_sha256: context.qualification_provenance_sha256, qualification_input_sha256: sha256CanonicalJson(v),
    phase: v.phase, ordinal: v.ordinal, input_raw_quantity: v.input_raw_quantity, minimum_output_raw: v.minimum_output_raw,
    fee_lamports: v.fee_lamports, message_base64: message.toString('base64'), message_sha256: hash(message) };
  return cloneAndFreeze({ ...plan, qualification_plan_sha256: sha256CanonicalJson(plan) });
}
