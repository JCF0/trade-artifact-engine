import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { cloneAndFreeze, sha256CanonicalJson, fail } from '../contract.mjs';
import { validateBoundedAgentMandateV1 } from './mandate-v1.mjs';
import { buildOrcaMessageBoundaryV1 } from './orca-message-boundary-v1.mjs';
import { buildReadinessChallengeV1 } from './readiness-challenge-v1.mjs';
import { decodeFixedWhirlpoolV1, decodeFixedTickArrayV1, swapQuoteByInputToken } from '../../../orca-readiness-sdk/index.mjs';
import { validateHeliusRpcSignaturePageResponseV1, validateHeliusRpcBlockResponseV1 } from '../../wallet-acquisition/helius-rpc-validator.mjs';
import { deriveOldestAllowedTimestampV1 } from '../../wallet-acquisition/boundary-contract.mjs';
import { decodeSolanaTokenAccountDataV1 } from '../../wallet-acquisition/solana-token-account-decoder-v1.mjs';
import { isSolanaRentEpochV1, reviveSolanaRentEpochV1 } from '../../wallet-acquisition/solana-rent-epoch-v1.mjs';
import { createFrozenControlledHeliusTargetAccountEnumerationPortV2, captureTargetAccountEnumerationV1 } from '../../wallet-acquisition/target-account-enumeration-port-v1.mjs';

const METHODS = ['getGenesisHash', 'getSlot', 'getBlock', 'getMultipleAccounts', 'getAccountInfo',
  'getTokenAccountsByOwner', 'getSignaturesForAddress', 'getLatestBlockhash', 'getFeeForMessage', 'getBlockHeight'];
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM = '11111111111111111111111111111111';
function reject(reason) { fail('bounded_agent_readiness_capture_blocked', reason); }
const integer = n => Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
function required(condition, reason) { if (!condition) reject(reason); }
function bytes(account, owner, size) {
  required(account && account.owner === owner && account.executable === false
    && integer(account.lamports) && isSolanaRentEpochV1(account.rentEpoch)
    && Array.isArray(account.data) && account.data.length === 2 && account.data[1] === 'base64'
    && typeof account.data[0] === 'string', 'account envelope');
  const b = Buffer.from(account.data[0], 'base64');
  required(b.toString('base64') === account.data[0] && (size === undefined || b.length === size), 'account data');
  return b;
}
function token(account, program, mint, owner) {
  bytes(account, program, 165);
  const { token_state: decoded } = decodeSolanaTokenAccountDataV1({ raw_base64: account.data[0], token_program: program, expected_wallet: owner });
  required(decoded.mint === mint && decoded.delegate_status === 'NONE'
    && decoded.close_authority_status === 'NONE' && decoded.account_state === 'INITIALIZED', 'token authority/state');
  return decoded.raw_amount;
}
function starts(pool, acquisition) {
  const width = pool.tickSpacing * 88;
  required(integer(pool.tickSpacing) && pool.tickSpacing > 0 && pool.tickSpacing <= 65535
    && Number.isSafeInteger(pool.tickCurrentIndex) && Math.abs(pool.tickCurrentIndex) <= 443636, 'pool tick range');
  const base = Math.floor(pool.tickCurrentIndex / width) * width;
  const offsets = acquisition ? (pool.tickCurrentIndex + pool.tickSpacing >= base + width ? [1, 2, 3] : [0, 1, 2]) : [0, -1, -2];
  return offsets.map(offset => base + offset * width);
}

// Trusted executor wiring only. No transport, deadline, budget, clock or evidence
// authority is accepted from a decision. This module never constructs network IO.
export function createOrcaReadinessCaptureV1(options) {
  required(options && options.budget && integer(options.deadline_unix_seconds), 'explicit budget/deadline required');
  const { transport, clock, retain_evidence, durable_episode_authority: authority } = options;
  required(typeof transport === 'function' && typeof retain_evidence === 'function'
    && typeof clock?.unixSeconds === 'function' && typeof clock?.monotonicMs === 'function'
    && typeof authority?.loadCurrentEpisodeStateV1 === 'function' && typeof authority?.inspectEpisodeV1 === 'function', 'trusted capabilities required');
  const m = cloneAndFreeze(options.mandate), authorization = cloneAndFreeze(options.authorization);
  validateBoundedAgentMandateV1(m);
  const budget = cloneAndFreeze(options.budget);
  for (const field of ['total_calls', 'call_timeout_ms', 'overall_timeout_ms', 'freshness_seconds', 'history_pages', 'max_response_bytes']) {
    required(integer(budget[field]) && budget[field] > 0, `budget ${field}`);
  }
  required(budget.freshness_seconds <= 300 && budget.call_timeout_ms <= budget.overall_timeout_ms
    && budget.history_pages <= 4 && budget.total_calls <= 64 && budget.max_response_bytes <= 1048576
    && budget.overall_timeout_ms <= 60000 && budget.call_timeout_ms <= 5000, 'budget bounds');
  required(budget.methods && Object.keys(budget.methods).length === METHODS.length, 'method budget inventory');
  for (const method of METHODS) required(integer(budget.methods[method]) && budget.methods[method] > 0, 'method budget');
  required(budget.fee_retry_count === 0 || budget.fee_retry_count === 1, 'retry budget');
  required(integer(budget.fee_retry_delay_ms), 'retry delay');
  const episodeId = `bounded-agent-episode-${authorization.authorization_digest}`;
  const cached = new Map();
  const monotonicMethod = clock.monotonicMs, unixMethod = clock.unixSeconds;
  let previousMonotonic = 0, clockValid = true;
  function monotonic() {
    try {
      required(clockValid && clock.monotonicMs === monotonicMethod && clock.unixSeconds === unixMethod, 'clock domain changed');
      const value = monotonicMethod.call(clock);
      required(Number.isFinite(value) && !Object.is(value, -0) && value >= previousMonotonic, 'monotonic clock regressed');
      previousMonotonic = value;
      return value;
    } catch (error) { clockValid = false; cached.clear(); throw error; }
  }
  let busy = false;
  function now() {
    const value = clock.unixSeconds();
    required(integer(value) && value < options.deadline_unix_seconds, 'capture deadline');
    return value;
  }
  now();
  function fresh(challenge, reason) {
    const retained = cached.get(challenge.challenge_digest);
    required(retained && sha256CanonicalJson(retained.challenge) === sha256CanonicalJson(challenge), `${reason}: unknown capture challenge`);
    const current = monotonic(), wall = now();
    if (current >= retained.expiresMonotonic || wall < retained.challenge.issued_at_unix_seconds
        || wall >= retained.challenge.expires_at_unix_seconds) {
      cached.delete(challenge.challenge_digest);
      reject(reason);
    }
    return retained.source;
  }
  return Object.freeze({
    async issueReadinessChallengeV1(request) {
      required(!busy, 'capture already in progress');
      busy = true;
      let expired = false, overallTimer;
      // Arm the overall timer before entering capabilities; include authority work.
      const work = Promise.resolve().then(async () => { try {
        const startUnix = now(), start = monotonic();
        required(Number.isFinite(start) && start >= 0 && !Object.is(start, -0), 'monotonic clock');
        const state = cloneAndFreeze(await authority.loadCurrentEpisodeStateV1({ episode_id: episodeId }));
        const acquisition = state.state === 'AUTHORIZED_DORMANT';
        required(acquisition || state.state === 'ACQUISITION_EVIDENCE_CLOSED', 'episode phase');
        const phase = acquisition ? 'ACQUISITION' : 'DISPOSAL', ordinal = acquisition ? 1 : 2;
        required(request.phase === phase && request.state.state_digest === state.state_digest
          && state.mandate_digest === m.mandate_digest && state.authorization_digest === authorization.authorization_digest,
        'reopened authority mismatch');
        required(!acquisition || startUnix < authorization.acquisition_not_after_unix_seconds, 'acquisition expiry');
        const evidence = [], counts = Object.fromEntries(METHODS.map(method => [method, 0]));
        let total = 0, lastClock = start;
        const active = new Set();
        function remaining() {
          required(!expired, 'overall deadline');
          now();
          const current = monotonic();
          required(Number.isFinite(current) && current >= lastClock, 'monotonic clock regressed');
          lastClock = current;
          const left = budget.overall_timeout_ms - (current - start);
          required(left > 0, 'overall deadline');
          return left;
        }
        async function rpc(method, params, id = 'wallet-acquisition-v1') {
          const left = remaining();
          const callDeadline = lastClock + Math.min(left, budget.call_timeout_ms);
          const inTime = () => {
            remaining();
            required(lastClock < callDeadline, 'capture RPC timeout');
          };
          required(METHODS.includes(method) && ++counts[method] <= budget.methods[method]
            && ++total <= budget.total_calls, 'RPC budget exhausted');
          const body = cloneAndFreeze({ jsonrpc: '2.0', id, method, params });
          const controller = new AbortController(); active.add(controller);
          let timer;
          try {
            const raw = await Promise.race([
              Promise.resolve().then(() => transport({ body, signal: controller.signal })),
              new Promise((_, rejectTimeout) => {
                timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error('capture RPC timeout')); }, Math.min(left, budget.call_timeout_ms));
              }),
            ]);
            inTime();
            required(typeof raw === 'string' && Buffer.byteLength(raw) <= budget.max_response_bytes, 'raw response bound');
            const record = { request: body, raw_response: raw, started_unix_seconds: startUnix,
              observed_unix_seconds: now(), elapsed_ms: monotonic() - start };
            // Caller supplies only a trusted durable evidence sink, never a claim.
            const digest = sha256CanonicalJson(record);
            required(await retain_evidence(cloneAndFreeze(record)) === digest, 'raw evidence retention');
            inTime();
            evidence.push(digest);
            const envelope = JSON.parse(raw, (key, value, context) => {
              if (key === 'rentEpoch') return reviveSolanaRentEpochV1(key, value, context);
              if (typeof value === 'number' && !Number.isSafeInteger(value)) {
                reject('unsafe RPC numeric field');
              }
              return value;
            });
            required(envelope.jsonrpc === '2.0' && envelope.id === body.id
              && Object.keys(envelope).every(key => ['jsonrpc', 'id', 'result', 'error'].includes(key)), 'RPC correlation');
            if (envelope.error) {
              const error = new Error('RPC refused'); error.rpc_code = envelope.error.code; throw error;
            }
            required(Object.hasOwn(envelope, 'result'), 'RPC result absent');
            inTime();
            return envelope;
          } finally { clearTimeout(timer); active.delete(controller); controller.abort(); }
        }
        try {
          required((await rpc('getGenesisHash', [])).result === m.network.genesis_hash, 'chain identity');
          const anchorSlot = (await rpc('getSlot', [{ commitment: 'finalized' }])).result;
          required(integer(anchorSlot), 'anchor slot');
          const anchor = validateHeliusRpcBlockResponseV1(await rpc('getBlock', [anchorSlot,
            { commitment: 'finalized', transactionDetails: 'none', rewards: false }]), anchorSlot);
          required(anchor !== null && anchor.block_time <= now()
            && now() - anchor.block_time <= budget.freshness_seconds, 'anchor freshness');
          const minimum = anchorSlot;
          const context = result => {
            required(result && integer(result.context?.slot) && result.context.slot >= minimum, 'context floor');
            return result;
          };
          const addresses = [m.wallet_scope.wallet, m.wallet_scope.jup_ata, m.wallet_scope.usdc_ata];
          const opening = context((await rpc('getMultipleAccounts', [addresses,
            { commitment: 'finalized', encoding: 'base64', minContextSlot: minimum }])).result);
          required(Array.isArray(opening.value) && opening.value.length === 3, 'opening inventory');
          bytes(opening.value[0], SYSTEM, 0);
          const jup = token(opening.value[1], m.wallet_scope.token_program, m.asset_scope.jup_mint, m.wallet_scope.wallet);
          const usdc = token(opening.value[2], m.wallet_scope.token_program, m.asset_scope.usdc_mint, m.wallet_scope.wallet);
          const inspected = await authority.inspectEpisodeV1({ episode_id: episodeId });
          required(!inspected.revoked, 'episode revoked');
          const acquisitionRow = inspected.ordinals.find(row => row.ordinal === 1);
          const allowedSignature = acquisition ? null : acquisitionRow?.transaction_signature;
          required(acquisition || (typeof allowedSignature === 'string' && state.acquisition_evidence_digest
            && /^[1-9][0-9]*$/.test(state.chain_derived_acquired_jup_raw)), 'retained acquisition missing');
          required(jup === (acquisition ? m.opening_contract.jup_raw : state.chain_derived_acquired_jup_raw)
            && usdc === (acquisition ? m.opening_contract.usdc_raw : m.opening_contract.post_acquisition_usdc_raw)
            && String(opening.value[0].lamports) === String(BigInt(m.opening_contract.sol_lamports)
              - (acquisition ? 0n : BigInt(m.opening_contract.acquisition_fee_lamports))), 'opening/disposal balance');
          const pair = [];
          const boundaryKind = acquisition ? 'OPENING' : 'ENDING_AS_OF';
          let enumeration;
          try {
            const enumerationPort = await createFrozenControlledHeliusTargetAccountEnumerationPortV2({
              wallet: addresses[0], target_mint: m.asset_scope.jup_mint,
              boundary_kind: boundaryKind, minimum_context_slot: opening.context.slot,
            }, {
              clock: monotonic,
              sleep: async () => reject('owner pair retry not authorized by capture profile'),
              request: async ({ body }) => {
                required(body.method === 'getTokenAccountsByOwner', 'unexpected owner helper RPC');
                const envelope = await rpc(body.method, body.params, body.id);
                pair[body.params[1].programId === m.wallet_scope.token_program ? 0 : 1] = envelope;
                return { status: 200, data: envelope };
              },
            });
            enumeration = await captureTargetAccountEnumerationV1({ port: enumerationPort,
              wallet: addresses[0], target_mint: m.asset_scope.jup_mint, boundary_kind: boundaryKind });
          } catch (error) { reject(`owner source authority: ${error.code ?? 'unavailable'}`); }
          const lanes = pair.map(envelope => context(envelope.result));
          required(lanes.every(lane => lane.context.slot === opening.context.slot && Array.isArray(lane.value))
            && lanes[0].value.length === 2 && lanes[1].value.length === 0, 'complete equal-watermark population');
          for (const [index, address] of addresses.slice(1).entries()) {
            const rows = lanes[0].value.filter(row => row.pubkey === address);
            required(rows.length === 1 && sha256CanonicalJson(rows[0].account) === sha256CanonicalJson(opening.value[index + 1]), 'enumeration account conflict');
          }
          let latestSetup = 0;
          const recent = new Set();
          // Standard getSignaturesForAddress supports minContextSlot. Success
          // attests this provider-enforced floor, not an atomic history snapshot.
          // Never retry without the floor or infer freshness from matching heads.
          const historyConfig = { commitment: 'finalized', limit: 100, minContextSlot: opening.context.slot };
          for (const address of addresses) {
            let before, exhausted = false, previousSlot = anchorSlot, head;
            const seen = new Set();
            for (let page = 0; page < budget.history_pages; page++) {
              const params = { ...historyConfig, ...(before ? { before } : {}) };
              const rows = validateHeliusRpcSignaturePageResponseV1(await rpc('getSignaturesForAddress', [address, params]));
              if (page === 0) head = rows;
              if (rows.length === 0) { exhausted = true; break; }
              for (const row of rows) {
                required(!seen.has(row.signature) && row.slot <= previousSlot && row.block_time <= anchor.block_time, 'history ordering/context');
                seen.add(row.signature); previousSlot = row.slot;
                if (row.block_time > m.setup_authority.latest_setup_block_time) {
                  required(!acquisition && row.signature === allowedSignature && row.execution_state === 'succeeded', 'unexpected post-setup history');
                  recent.add(row.signature);
                } else latestSetup = Math.max(latestSetup, row.block_time);
              }
              before = rows.at(-1).signature;
            }
            required(exhausted && seen.size > 0, 'history completeness');
            const repeated = validateHeliusRpcSignaturePageResponseV1(await rpc('getSignaturesForAddress', [address, historyConfig]));
            required(sha256CanonicalJson(repeated) === sha256CanonicalJson(head), 'history head changed');
          }
          required(latestSetup === m.setup_authority.latest_setup_block_time, 'frozen setup time not corroborated');
          if (acquisition) required(deriveOldestAllowedTimestampV1({ anchor_block_time: anchor.block_time,
            requested_lookback_seconds: m.age_gate.lookback_seconds }) > latestSetup, 'strict age equality/ineligibility');
          else required(recent.has(allowedSignature), 'acquisition history absent');
          const first = context((await rpc('getAccountInfo', [m.route_scope.pool,
            { commitment: 'finalized', encoding: 'base64', minContextSlot: minimum }])).result);
          const firstPool = decodeFixedWhirlpoolV1(bytes(first.value, m.route_scope.whirlpool_program));
          const tickStarts = starts(firstPool, acquisition);
          const tickAddresses = tickStarts.map(startIndex => PublicKey.findProgramAddressSync([
            Buffer.from('tick_array'), new PublicKey(m.route_scope.pool).toBuffer(), Buffer.from(String(startIndex)),
          ], new PublicKey(m.route_scope.whirlpool_program))[0].toBase58());
          const route = context((await rpc('getMultipleAccounts', [[m.route_scope.pool, ...tickAddresses,
            m.route_scope.jup_vault, m.route_scope.usdc_vault], { commitment: 'finalized', encoding: 'base64', minContextSlot: first.context.slot }])).result);
          required(route.context.slot >= first.context.slot && route.value?.length === 6, 'route context');
          const pool = decodeFixedWhirlpoolV1(bytes(route.value[0], m.route_scope.whirlpool_program));
          required(String(pool.tokenMintA) === m.asset_scope.jup_mint && String(pool.tokenMintB) === m.asset_scope.usdc_mint
            && String(pool.tokenVaultA) === m.route_scope.jup_vault && String(pool.tokenVaultB) === m.route_scope.usdc_vault
            && pool.feeTierIndexSeed[0] + 256 * pool.feeTierIndexSeed[1] === pool.tickSpacing
            && sha256CanonicalJson(starts(pool, acquisition)) === sha256CanonicalJson(tickStarts), 'route identity');
          const ticks = route.value.slice(1, 4).map((account, index) => {
            // Absent arrays are refused in this capture profile rather than asserted empty.
            const decoded = decodeFixedTickArrayV1(bytes(account, m.route_scope.whirlpool_program));
            required(decoded.startTickIndex === tickStarts[index] && String(decoded.whirlpool) === m.route_scope.pool, 'tick relationship');
            return decoded;
          });
          token(route.value[4], m.wallet_scope.token_program, m.asset_scope.jup_mint, m.route_scope.pool);
          token(route.value[5], m.wallet_scope.token_program, m.asset_scope.usdc_mint, m.route_scope.pool);
          const amount = acquisition ? m.economic_authority.acquisition_input_usdc_raw : state.chain_derived_acquired_jup_raw;
          const q = swapQuoteByInputToken(BigInt(amount), !acquisition, m.economic_authority.maximum_slippage_bps,
            pool, undefined, ticks, BigInt(now()));
          required(q.tokenIn === BigInt(amount) && q.tokenEstOut > 0n, 'exact input quote');
          const strictMinimum = (q.tokenEstOut * (10000n - BigInt(m.economic_authority.maximum_slippage_bps)) + 9999n) / 10000n;
          const latest = context((await rpc('getLatestBlockhash', [{ commitment: 'finalized', minContextSlot: route.context.slot }])).result);
          required(latest.context.slot >= route.context.slot && integer(latest.value?.lastValidBlockHeight), 'blockhash context');
          const source = { blockhash: latest.value.blockhash, tick_spacing: pool.tickSpacing,
            tick_current_index: pool.tickCurrentIndex, quoted_output_raw: String(q.tokenEstOut), minimum_output_raw: String(strictMinimum),
            fee_lamports: m.opening_contract[acquisition ? 'acquisition_fee_lamports' : 'disposal_fee_lamports'] };
          const plan = buildOrcaMessageBoundaryV1({ ...source, mandate: m, phase, ordinal, input_raw_quantity: amount,
            retained_acquisition_jup_raw: acquisition ? null : amount });
          let fee;
          for (let attempt = 0; ; attempt++) {
            try { fee = context((await rpc('getFeeForMessage', [plan.message_base64,
              { commitment: 'finalized', minContextSlot: latest.context.slot }])).result); break; }
            catch (error) {
              if (error.rpc_code !== -32016 || attempt >= budget.fee_retry_count) throw error;
              required(remaining() > budget.fee_retry_delay_ms, 'retry deadline');
              await new Promise(resolve => setTimeout(resolve, budget.fee_retry_delay_ms));
            }
          }
          required(fee.context.slot >= latest.context.slot && integer(fee.value)
            && String(fee.value) === source.fee_lamports, 'exact message fee');
          const height = (await rpc('getBlockHeight', [{ commitment: 'finalized', minContextSlot: fee.context.slot }])).result;
          required(integer(height) && height < latest.value.lastValidBlockHeight, 'blockhash expired');
          source.fee_message_sha256 = plan.message_sha256;
          remaining();
          const issued = now();
          required(issued - startUnix < budget.freshness_seconds, 'capture stale');
          const finalState = await authority.loadCurrentEpisodeStateV1({ episode_id: episodeId });
          required(finalState.state_digest === state.state_digest, 'state changed during capture');
          const challenge = buildReadinessChallengeV1({ episode_id: episodeId, phase, ordinal,
            mandate_digest: m.mandate_digest, authorization_digest: authorization.authorization_digest,
            predecessor_state: state.state, predecessor_state_digest: state.state_digest,
            executor_release_sha256: authorization.executor_release_sha256, challenge_nonce: `capture-${randomUUID()}`,
            readiness_evidence_digest: sha256CanonicalJson({ episode_id: episodeId, ordinal, source }),
            issued_at_unix_seconds: issued, expires_at_unix_seconds: Math.min(startUnix + budget.freshness_seconds,
              options.deadline_unix_seconds, acquisition ? authorization.acquisition_not_after_unix_seconds : options.deadline_unix_seconds),
            readiness_status: 'READY', finalized_acquisition_evidence_digest: acquisition ? null : state.acquisition_evidence_digest,
            chain_derived_disposal_jup_raw: acquisition ? null : amount,
            disposal_quantity_rule: m.economic_authority.disposal_quantity_rule });
          const manifest = { classification: 'EXECUTOR_CAPTURE_PROVIDER_ATTESTED_NOT_ATOMIC', source, challenge,
            raw_evidence_digests: evidence, counts, budget, anchor, enumeration,
            acquisition_evidence_digest: state.acquisition_evidence_digest };
          required(await retain_evidence(cloneAndFreeze(manifest)) === sha256CanonicalJson(manifest), 'capture manifest retention');
          remaining();
          required(now() < challenge.expires_at_unix_seconds, 'stale readiness');
          // Private clock-domain state, never serialized or adopted after restart.
          const expiresMonotonic = start + (challenge.expires_at_unix_seconds - startUnix) * 1000;
          required(monotonic() < expiresMonotonic, 'stale readiness');
          cached.set(challenge.challenge_digest, { source: cloneAndFreeze(source), challenge, expiresMonotonic });
          return challenge;
        } finally { for (const controller of active) controller.abort(); }
      } finally { expired = true; busy = false; } });
      try {
        return await Promise.race([work, new Promise((_, rejectTimeout) => {
          overallTimer = setTimeout(() => { expired = true; rejectTimeout(new Error('capture overall timeout')); }, budget.overall_timeout_ms);
        })]);
      } finally { clearTimeout(overallTimer); }
    },
    async captureBuildInputV1({ challenge }) {
      return fresh(challenge, 'stale readiness');
    },
    async assertFreshBeforeSigningV1({ challenge }) {
      fresh(challenge, 'stale readiness before signer');
    },
  });
}
