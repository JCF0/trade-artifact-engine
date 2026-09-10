import { canonicalJson, cloneAndFreeze } from '../contract.mjs';
import { createHash } from 'node:crypto';
import { deriveOldestAllowedTimestampV1 } from '../../wallet-acquisition/boundary-contract.mjs';
import { createFrozenControlledHeliusTargetAccountEnumerationPortV2 } from '../../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import { buildRetainedFinalizedSourceV1 } from './final-episode-release-v1.mjs';
import { createBoundedSupervisedRpcV1 } from './supervised-rpc-v1.mjs';
import { validateSupervisedSetupSourceV1 } from './supervised-setup-source-v1.mjs';
import { OFFLINE_WALLET_PROFILE_V1 } from './executor-mandate-profile-v1.mjs';
import { reviveSolanaRentEpochV1 } from '../../wallet-acquisition/solana-rent-epoch-v1.mjs';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
function stop() { throw Error('SUPERVISED_FINALIZED_SOURCE_INVALID'); }
const parse = bytes => JSON.parse(bytes, (key, value, context) => {
  if (key === 'rentEpoch') return reviveSolanaRentEpochV1(key, value, context);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) stop();
  return value;
});
function reader(files) { return { readMemberV1(name) { if (!files.has(name)) stop(); return Buffer.from(files.get(name)); },
  parseMemberV1(name) { return parse(this.readMemberV1(name)); } }; }
export async function openingPortFromReadinessV1(m, records) {
  const rows = records.filter(r => r.request?.method === 'getTokenAccountsByOwner');
  if (rows.length !== 2) stop();
  const floor = Math.min(...rows.map(r => parse(r.raw_response).result.context.slot));
  return createFrozenControlledHeliusTargetAccountEnumerationPortV2({ wallet: m.wallet_scope.wallet, target_mint: m.asset_scope.jup_mint,
    boundary_kind: 'OPENING', minimum_context_slot: floor }, { clock: () => 0, sleep: async () => stop(), async request({ body }) {
      const row = rows.find(v => v.request.params[1].programId === body.params[1].programId);
      if (!row || row.request.params[0] !== body.params[0] || row.request.params[2].commitment !== 'finalized') stop();
      return { status: 200, data: { ...parse(row.raw_response), id: body.id },
        raw_body_sha256: createHash('sha256').update(row.raw_response).digest('hex') };
    } });
}
// Original evidence is acquired once. Every later terminal/replay check operates
// on these immutable members; no caller-selected row filtering or network replay.
export async function captureSupervisedFinalizedSourceV1({ configuration: c, ordinal, terminal, transport, clock, journal, derive_projection = true }) {
  await journal.claimPhase('economic_source', ordinal);
  const rpc = createBoundedSupervisedRpcV1({ phase: 'economic_source', budget: c.budget.economic_source, transport, clock,
    deadline_unix_seconds: c.deadline_unix_seconds,
    retain: record => journal.retain({ kind: 'economic_rpc', ordinal, record }) });
  const m = c.mandate, files = new Map(); let sequence = 0;
  function put(name, bytes) { if (files.has(name)) stop(); files.set(name, Buffer.from(bytes)); return name; }
  async function call(method, params) {
    const body = { jsonrpc: '2.0', id: `economic-${ordinal}-${++sequence}`, method, params };
    const request = put(`economic-${ordinal}-${sequence}-request.json`, canonicalJson(body));
    const raw = await rpc({ body }), response = put(`economic-${ordinal}-${sequence}-response.json`, raw);
    const parsed = parse(raw);
    if (parsed.jsonrpc !== '2.0' || parsed.id !== body.id || !Object.hasOwn(parsed, 'result') || Object.hasOwn(parsed, 'error')) stop();
    return { request, response, result: parsed.result };
  }
  const retained = journal.snapshot().records.filter(r => r.kind === 'readiness').map(r => r.record);
  const captures = retained.filter(r => r.classification === 'EXECUTOR_CAPTURE_PROVIDER_ATTESTED_NOT_ATOMIC');
  const first = captures.find(r => r.challenge.ordinal === 1);
  if (!first) stop();
  // Capture records are contiguous and terminated by their own capture manifest.
  const firstIndex = retained.indexOf(first), openingRows = retained.slice(0, firstIndex).filter(r => r.request?.method === 'getTokenAccountsByOwner');
  if (openingRows.length !== 2) stop();
  const opening = { minimum_context_slot: Math.min(...openingRows.map(r => parse(r.raw_response).result.context.slot)) };
  for (const [program, field] of [[TOKEN, 'classic'], [TOKEN2022, 'token_2022']]) {
    const row = openingRows.find(r => r.request.params[1].programId === program);
    if (!row || row.request.params[0] !== m.wallet_scope.wallet || row.request.params[2].commitment !== 'finalized') stop();
    opening[field] = put(`economic-opening-${field}.json`, row.raw_response);
  }
  const ending = { minimum_context_slot: terminal.slot };
  for (const [program, field] of [[TOKEN, 'classic'], [TOKEN2022, 'token_2022']]) {
    ending[field] = (await call('getTokenAccountsByOwner', [m.wallet_scope.wallet, { programId: program },
      { encoding: 'base64', commitment: 'finalized', minContextSlot: terminal.slot }])).response;
  }
  const genesis = await call('getGenesisHash', []), anchor = await call('getSlot', [{ commitment: 'finalized' }]);
  const block = await call('getBlock', [anchor.result, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
  if (!Number.isSafeInteger(anchor.result) || anchor.result < terminal.slot || !Number.isSafeInteger(block.result?.blockTime)) stop();
  const oldest = deriveOldestAllowedTimestampV1({ anchor_block_time: block.result.blockTime, requested_lookback_seconds: 2592000 });
  const lanes = [], required = new Map(), setup = new Map();
  for (const address of [m.wallet_scope.wallet, m.wallet_scope.jup_ata, m.wallet_scope.usdc_ata]) {
    const pages = []; let before = null;
    for (let page = 0; page < 32; page++) {
      const p = await call('getSignaturesForAddress', [address, { commitment: 'finalized', limit: 100, minContextSlot: anchor.result,
        ...(before === null ? {} : { before }) }]);
      pages.push({ request: p.request, response: p.response });
      if (!Array.isArray(p.result)) stop();
      for (const row of p.result) {
        if (!Number.isSafeInteger(row.blockTime) || !Number.isSafeInteger(row.slot)) stop();
        if (row.blockTime > m.setup_authority.latest_setup_block_time && row.blockTime < oldest) stop();
        const population = row.blockTime <= m.setup_authority.latest_setup_block_time ? setup : required;
        if (population.has(row.signature) && canonicalJson(population.get(row.signature)) !== canonicalJson(row)) stop();
        population.set(row.signature, row);
      }
      if (!p.result.length) break;
      before = p.result.at(-1).signature;
      if (page === 31) stop();
    }
    const repeat = await call('getSignaturesForAddress', [address, { commitment: 'finalized', limit: 100, minContextSlot: anchor.result }]);
    lanes.push({ address, pages, repeated_head: { request: repeat.request, response: repeat.response } });
  }
  if (required.size + setup.size > 32) stop();
  const setup_transactions = [];
  for (const row of [...setup.values()].sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature))) {
    const tx = await call('getTransaction', [row.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
    if (tx.result === null || tx.result.slot !== row.slot || tx.result.blockTime !== row.blockTime) stop();
    setup_transactions.push({ signature: row.signature, response: tx.response });
  }
  const transactions = [];
  for (const row of [...required.values()].sort((a, b) => a.slot - b.slot || a.blockTime - b.blockTime)) {
    const response = await call('getTransaction', [row.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
    transactions.push({ signature: row.signature, response: response.response });
  }
  const admission = put('economic-history-admission.json', canonicalJson({ version: 'artifact_supervised_history_v1', lanes }));
  const descriptor = { version: 'artifact_final_episode_replay_v3', evidence_kind: m.mandate_profile === OFFLINE_WALLET_PROFILE_V1 ? 'SYNTHETIC_FINAL_EPISODE' : 'SUPERVISED_RETAINED_FINAL_EPISODE',
    scope: { wallet: m.wallet_scope.wallet, target_mint: m.asset_scope.jup_mint, exact_quote_mint: m.asset_scope.usdc_mint,
      route_program: m.route_scope.whirlpool_program, route_pool: m.route_scope.pool },
    acquisition_request: { request_version: 'wallet_wide_acquisition_request_v2', chain: 'solana', network: 'mainnet-beta', genesis_hash: genesis.result,
      wallet: m.wallet_scope.wallet, window: { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1', requested_lookback_seconds: 2592000, initial_before_signature: null },
      finality: { commitment: 'finalized', boundary_profile: 'solana_finalized_anchor_v1', max_anchor_search_slots: 32 },
      budgets: { pagination_profile: 'solana_full_transaction_page_100_v1', page_size: 100, max_pages: 32, max_transactions: 32,
        retry_profile: 'bounded_exponential_retry_v1', max_attempts_per_operation: 1, timeout_profile: 'bounded_provider_timeout_v1',
        request_timeout_ms: c.budget.economic_source.call_timeout_ms, overall_timeout_ms: c.budget.economic_source.overall_timeout_ms,
        exact_fallback_profile: 'finalized_get_transaction_missing_only_v1', max_exact_fallback_transactions: 0 },
      profiles: { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1' } },
    history: { genesis: genesis.response, slot: anchor.response, block: block.response, pages: lanes[0].pages.map(p => p.response), admission },
    transactions, opening, ending, selection: null, control: 'control.json' };
  const whole = await buildRetainedFinalizedSourceV1(reader(files), descriptor, { mandate: m, authorization: c.authorization });
  const retainedSource = { kind: 'economic_source', ordinal, descriptor, setup_transactions,
    members: [...files].map(([path, bytes]) => ({ path, base64: bytes.toString('base64') })) };
  validateSupervisedSetupSourceV1({ source: retainedSource, loaded: reader(files), mandate: m,
    rpc_pairs: [...files].filter(([name]) => name.endsWith('-request.json')).map(([, bytes]) => ({ body: parse(bytes) })) });
  journal.retain(retainedSource);
  const shell = { context: whole.context, context_authority: whole.authority, exact_quote_mint: m.asset_scope.usdc_mint };
  if (ordinal === 2 && derive_projection) {
    const last = captures.find(r => r.challenge.ordinal === 2), prior = retained.indexOf(first), end = retained.indexOf(last);
    const records = retained.slice(prior + 1, end).filter(r => r.request);
    const acquisition = journal.snapshot().records.find(r => r.kind === 'terminal_record' && r.record.finalized?.phase === 'ACQUISITION');
    if (!last || end < 0 || !acquisition) stop();
    shell.terminal_projection = { version: 'artifact_terminal_leg_projection_v1', acquisition_finalized: acquisition.record.finalized,
      opening_enumeration_port: await openingPortFromReadinessV1(m, records) };
  }
  return shell;
}
