import { createHash } from 'node:crypto';

import { cloneAndFreeze } from '../verification-scope-v1-3/contract.mjs';
import { isSolanaPublicKeyV1 } from './solana-identities.mjs';

export const HELIUS_OWNER_ENUMERATION_COMPATIBILITY_PROBE_VERSION_V0 = 'helius_owner_enumeration_compatibility_probe_v0';
export const CLASSIC_TOKEN_PROGRAM_V0 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_V0 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const HELIUS_OWNER_ENUMERATION_PROGRAMS_V0 = Object.freeze([
  CLASSIC_TOKEN_PROGRAM_V0,
  TOKEN_2022_PROGRAM_V0,
]);
export const HELIUS_OWNER_ENUMERATION_BOUNDS_V0 = Object.freeze({
  max_pair_attempts: 8,
  pair_deadline_ms: 30_000,
  request_timeout_ms: 5_000,
  retry_delays_ms: Object.freeze([100, 200, 400, 800, 1000, 1000, 1000]),
  known_control_repetitions_max: 10,
  v2_page_limit: 10_000,
  v2_max_pages_per_lane: 8,
});

const FUTURE_MIN_CONTEXT_SLOT = Number.MAX_SAFE_INTEGER;
const HELIUS_PLAN_PROFILES = new Set(['FREE','AGENT','DEVELOPER','BUSINESS','PROFESSIONAL']);
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DIGEST = /^[0-9a-f]{64}$/;

class ProbeInputError extends Error {
  constructor() {
    super('invalid compatibility probe input');
    this.name = 'ProbeInputError';
    this.code = 'invalid_probe_input';
    delete this.stack;
  }
}
function invalid() { throw new ProbeInputError(); }
function safeSlot(value) { return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0); }
function digestText(value) { return createHash('sha256').update(value).digest('hex'); }
function digestBase64(value) { return digestText(Buffer.from(value, 'base64')); }
function sortedUniquePublicKeys(value) {
  if (!Array.isArray(value) || value.some(item => !isSolanaPublicKeyV1(item))) invalid();
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) invalid();
  return sorted;
}
function validateInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.getOwnPropertySymbols(input).length !== 0) invalid();
  const fields = ['empty_control_wallet','known_control_wallet','expected_accounts','known_control_repetitions','helius_plan_profile'];
  if (Object.keys(input).sort().join('\0') !== [...fields].sort().join('\0')) invalid();
  if (!isSolanaPublicKeyV1(input.empty_control_wallet)
      || !isSolanaPublicKeyV1(input.known_control_wallet)
      || input.empty_control_wallet === input.known_control_wallet) invalid();
  if (!HELIUS_PLAN_PROFILES.has(input.helius_plan_profile)) invalid();
  if (input.expected_accounts === null || typeof input.expected_accounts !== 'object'
      || Array.isArray(input.expected_accounts) || Object.getPrototypeOf(input.expected_accounts) !== Object.prototype
      || Object.keys(input.expected_accounts).sort().join('\0') !== [...HELIUS_OWNER_ENUMERATION_PROGRAMS_V0].sort().join('\0')) invalid();
  if (!Number.isSafeInteger(input.known_control_repetitions) || input.known_control_repetitions < 1
      || input.known_control_repetitions > HELIUS_OWNER_ENUMERATION_BOUNDS_V0.known_control_repetitions_max) invalid();
  return {
    empty_control_wallet: input.empty_control_wallet,
    known_control_wallet: input.known_control_wallet,
    expected_accounts: Object.fromEntries(HELIUS_OWNER_ENUMERATION_PROGRAMS_V0.map(program => [
      program, sortedUniquePublicKeys(input.expected_accounts[program]),
    ])),
    known_control_repetitions: input.known_control_repetitions,
    helius_plan_profile: input.helius_plan_profile,
  };
}
function validateDependencies(dependencies) {
  if (dependencies === null || typeof dependencies !== 'object' || typeof dependencies.request !== 'function'
      || typeof dependencies.clock !== 'function' || typeof dependencies.sleep !== 'function') invalid();
  return dependencies;
}
function standardBody(wallet, program, id, minContextSlot = null) {
  const config = { commitment: 'finalized', encoding: 'base64' };
  if (minContextSlot !== null) config.minContextSlot = minContextSlot;
  return { jsonrpc: '2.0', id, method: 'getTokenAccountsByOwner', params: [wallet, { programId: program }, config] };
}
function v2Body(wallet, program, id, paginationKey) {
  const config = {
    commitment: 'finalized', encoding: 'base64', limit: HELIUS_OWNER_ENUMERATION_BOUNDS_V0.v2_page_limit,
    withContext: true,
  };
  if (paginationKey !== null) config.paginationKey = paginationKey;
  return { jsonrpc: '2.0', id, method: 'getTokenAccountsByOwnerV2', params: [wallet, { programId: program }, config] };
}
function sanitizeHash(response) {
  return typeof response?.raw_body_sha256 === 'string' && DIGEST.test(response.raw_body_sha256)
    ? response.raw_body_sha256 : null;
}
async function invoke(request, body, timeoutMs) {
  try {
    const response = await request({ body, timeout_ms: timeoutMs });
    if (response === null || typeof response !== 'object') return { kind: 'schema', reason: 'transport_response_invalid' };
    if (!Number.isInteger(response.status)) return { kind: 'schema', reason: 'http_status_invalid' };
    if (response.status !== 200) return {
      kind: TRANSIENT_HTTP.has(response.status) ? 'transient' : 'semantic',
      reason: TRANSIENT_HTTP.has(response.status) ? 'http_transient_status' : 'http_non_success_status',
      response_hash: sanitizeHash(response),
    };
    return { kind: 'success', data: response.data, response_hash: sanitizeHash(response) };
  } catch (error) {
    return error?.code === 'request_timeout'
      ? { kind: 'semantic', reason: 'request_timeout', response_hash: null }
      : { kind: 'transient', reason: 'transport_failed', response_hash: null };
  }
}
function parseAccountRow(row, expectedProgram) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)
      || !isSolanaPublicKeyV1(row.pubkey) || row.account === null || typeof row.account !== 'object'
      || Array.isArray(row.account)) return { ok: false, reason: 'account_row_schema_invalid' };
  const account = row.account;
  if (account.owner !== expectedProgram) return { ok: false, reason: 'account_owner_program_mismatch' };
  if (account.executable !== false) return { ok: false, reason: 'account_executable_invalid' };
  if (!Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== 'base64'
      || typeof account.data[0] !== 'string' || account.data[0].length === 0 || !BASE64.test(account.data[0])
      || Buffer.from(account.data[0], 'base64').toString('base64') !== account.data[0]) {
    return { ok: false, reason: 'account_base64_invalid' };
  }
  return { ok: true, value: { pubkey: row.pubkey, data_sha256: digestBase64(account.data[0]) } };
}
function parseRows(rows, expectedProgram) {
  if (!Array.isArray(rows)) return { ok: false, reason: 'account_population_schema_invalid' };
  const parsed = [];
  for (const row of rows) {
    const item = parseAccountRow(row, expectedProgram);
    if (!item.ok) return item;
    parsed.push(item.value);
  }
  parsed.sort((left, right) => left.pubkey.localeCompare(right.pubkey));
  if (new Set(parsed.map(item => item.pubkey)).size !== parsed.length) return { ok: false, reason: 'duplicate_account_key' };
  return { ok: true, rows: parsed };
}
function parseStandardRpc(value, id, program) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.jsonrpc !== '2.0' || value.id !== id) return { ok: false, kind: 'schema', reason: 'rpc_envelope_invalid' };
  if (value.error !== undefined) return { ok: false, kind: 'semantic', reason: 'rpc_error' };
  const result = value.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)
      || result.context === null || typeof result.context !== 'object' || !safeSlot(result.context.slot)) {
    return { ok: false, kind: 'schema', reason: 'standard_result_schema_invalid' };
  }
  const rows = parseRows(result.value, program);
  if (!rows.ok) return { ok: false, kind: rows.reason === 'account_owner_program_mismatch' ? 'contradiction' : 'schema', reason: rows.reason };
  return {
    ok: true,
    value: {
      context_slot: result.context.slot,
      account_keys: rows.rows.map(row => row.pubkey),
      row_evidence: rows.rows,
    },
  };
}
function pairIds(label, attempt) {
  return HELIUS_OWNER_ENUMERATION_PROGRAMS_V0.map((program, index) => `${label}-a${attempt}-${index === 0 ? 'classic' : 'token2022'}`);
}
function unresolvedPair(reason, attempts, requestCount, responseHashes) {
  return { status: 'UNRESOLVED', reason, attempts, rpc_request_count: requestCount, response_hashes: responseHashes };
}
async function capturePair(wallet, label, dependencies) {
  const started = dependencies.clock();
  if (!Number.isFinite(started) || Object.is(started, -0)) return unresolvedPair('clock_invalid', 0, 0, []);
  const deadline = started + HELIUS_OWNER_ENUMERATION_BOUNDS_V0.pair_deadline_ms;
  let requestCount = 0;
  const responseHashes = [];
  for (let attempt = 1; attempt <= HELIUS_OWNER_ENUMERATION_BOUNDS_V0.max_pair_attempts; attempt += 1) {
    const before = dependencies.clock();
    const remaining = deadline - before;
    if (!(remaining > 0)) return unresolvedPair('pair_deadline_exhausted', attempt - 1, requestCount, responseHashes);
    const ids = pairIds(label, attempt);
    const bodies = HELIUS_OWNER_ENUMERATION_PROGRAMS_V0.map((program, index) => standardBody(wallet, program, ids[index]));
    requestCount += 2;
    const transports = await Promise.all(bodies.map(body => invoke(
      dependencies.request, body, Math.min(HELIUS_OWNER_ENUMERATION_BOUNDS_V0.request_timeout_ms, remaining),
    )));
    for (const transport of transports) {
      if (transport.response_hash !== null) responseHashes.push(transport.response_hash);
    }
    const after = dependencies.clock();
    if (!(after <= deadline)) return unresolvedPair('pair_deadline_exhausted', attempt, requestCount, responseHashes);
    const unsuccessful = transports.filter(transport => transport.kind !== 'success');
    if (unsuccessful.length !== 0) {
      const terminal = unsuccessful.find(transport => transport.kind !== 'transient');
      if (terminal !== undefined) return unresolvedPair(terminal.reason, attempt, requestCount, responseHashes);
    } else {
      const parsed = HELIUS_OWNER_ENUMERATION_PROGRAMS_V0.map((program, index) => parseStandardRpc(
        transports[index].data, ids[index], program,
      ));
      if (parsed.some(item => !item.ok)) {
        const failed = parsed.find(item => !item.ok);
        return failed.kind === 'contradiction'
          ? { status: 'FAIL', reason: failed.reason, attempts: attempt, rpc_request_count: requestCount, response_hashes: responseHashes }
          : unresolvedPair(failed.reason, attempt, requestCount, responseHashes);
      }
      if (parsed[0].value.context_slot === parsed[1].value.context_slot) {
        return {
          status: 'PASS', reason: null, attempts: attempt, rpc_request_count: requestCount,
          response_hashes: responseHashes, shared_context_slot: parsed[0].value.context_slot,
          lanes: HELIUS_OWNER_ENUMERATION_PROGRAMS_V0.map((program, index) => ({ token_program: program, ...parsed[index].value })),
        };
      }
    }
    if (attempt < HELIUS_OWNER_ENUMERATION_BOUNDS_V0.max_pair_attempts) {
      const delay = HELIUS_OWNER_ENUMERATION_BOUNDS_V0.retry_delays_ms[attempt - 1];
      if (dependencies.clock() + delay >= deadline) return unresolvedPair('pair_deadline_exhausted', attempt, requestCount, responseHashes);
      try { await dependencies.sleep(delay); } catch { return unresolvedPair('retry_sleep_failed', attempt, requestCount, responseHashes); }
    }
  }
  return unresolvedPair('pair_attempts_exhausted', HELIUS_OWNER_ENUMERATION_BOUNDS_V0.max_pair_attempts, requestCount, responseHashes);
}
function laneSummary(program, runs) {
  const first = runs[0].lanes.find(lane => lane.token_program === program);
  return {
    token_program: program,
    account_keys: first.account_keys,
    account_count: first.account_keys.length,
    owner_program_validation: 'PASS',
    base64_validation: 'PASS',
    row_evidence: first.row_evidence,
  };
}
async function futureFloorProbe(wallet, dependencies) {
  const ids = ['future-classic', 'future-token2022'];
  const body = HELIUS_OWNER_ENUMERATION_PROGRAMS_V0.map((program, index) => standardBody(
    wallet, program, ids[index], FUTURE_MIN_CONTEXT_SLOT,
  ));
  const results = await Promise.all(body.map(item => invoke(
    dependencies.request, item, HELIUS_OWNER_ENUMERATION_BOUNDS_V0.request_timeout_ms,
  )));
  const responseHashes = results.map(result => result.response_hash).filter(hash => hash !== null);
  const unavailable = results.find(result => result.kind !== 'success');
  if (unavailable !== undefined) {
    return { status: 'UNRESOLVED', reason: unavailable.reason, rpc_request_count: 2, response_hashes: responseHashes };
  }
  let explicitFailures = 0;
  let successes = 0;
  for (const [index, id] of ids.entries()) {
    const item = results[index].data;
    if (item === null || typeof item !== 'object' || Array.isArray(item)
        || item.jsonrpc !== '2.0' || item.id !== id) {
      return { status: 'UNRESOLVED', reason: 'rpc_envelope_invalid', rpc_request_count: 2, response_hashes: responseHashes };
    }
    if (item?.jsonrpc === '2.0' && item.id === id && item.error !== undefined && item.result === undefined
        && item.error !== null && typeof item.error === 'object' && item.error.code === -32016) {
      explicitFailures += 1;
    } else if (item?.jsonrpc === '2.0' && item.id === id && item.error === undefined && item.result !== undefined) {
      successes += 1;
    }
  }
  if (explicitFailures === 2) return { status: 'PASS', reason: null, rpc_request_count: 2, response_hashes: responseHashes };
  if (successes === 2) return { status: 'FAIL', reason: 'future_min_context_slot_succeeded', rpc_request_count: 2, response_hashes: responseHashes };
  return { status: 'UNRESOLVED', reason: 'future_min_context_slot_failure_unconfirmed', rpc_request_count: 2, response_hashes: responseHashes };
}
function parseV2(value, id, program) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.jsonrpc !== '2.0' || value.id !== id || value.error !== undefined) {
    return { ok: false, reason: 'rpc_envelope_invalid' };
  }
  const result = value.result;
  const wrapped = result?.value;
  if (result === null || typeof result !== 'object' || result.context === null || typeof result.context !== 'object'
      || !safeSlot(result.context.slot) || wrapped === null || typeof wrapped !== 'object' || Array.isArray(wrapped)
      || !Object.hasOwn(wrapped, 'accounts') || !Object.hasOwn(wrapped, 'paginationKey')) {
    return { ok: false, reason: 'v2_result_schema_invalid' };
  }
  if (wrapped.paginationKey !== null && (typeof wrapped.paginationKey !== 'string' || wrapped.paginationKey.length === 0 || wrapped.paginationKey.length > 512)) {
    return { ok: false, reason: 'v2_pagination_key_invalid' };
  }
  const rows = parseRows(wrapped.accounts, program);
  if (!rows.ok) return { ok: false, reason: rows.reason };
  return {
    ok: true,
    value: {
      context_slot: result.context.slot,
      pagination_key: wrapped.paginationKey,
      rows: rows.rows,
    },
  };
}
async function exhaustV2(wallet, program, label, dependencies) {
  let paginationKey = null;
  const seenKeys = new Set();
  const rows = [];
  const contexts = [];
  const responseHashes = [];
  for (let page = 1; page <= HELIUS_OWNER_ENUMERATION_BOUNDS_V0.v2_max_pages_per_lane; page += 1) {
    const id = `v2-${label}-p${page}`;
    const transport = await invoke(dependencies.request, v2Body(wallet, program, id, paginationKey), HELIUS_OWNER_ENUMERATION_BOUNDS_V0.request_timeout_ms);
    if (transport.response_hash !== null) responseHashes.push(transport.response_hash);
    if (transport.kind !== 'success') return { status: 'UNRESOLVED', reason: transport.reason, pages: page, rpc_request_count: page, response_hashes: responseHashes };
    const parsed = parseV2(transport.data, id, program);
    if (!parsed.ok) return { status: 'UNRESOLVED', reason: parsed.reason, pages: page, rpc_request_count: page, response_hashes: responseHashes };
    contexts.push(parsed.value.context_slot);
    rows.push(...parsed.value.rows);
    paginationKey = parsed.value.pagination_key;
    if (paginationKey === null) {
      rows.sort((left, right) => left.pubkey.localeCompare(right.pubkey));
      if (new Set(rows.map(row => row.pubkey)).size !== rows.length) return { status: 'FAIL', reason: 'v2_duplicate_account_key', pages: page, rpc_request_count: page, response_hashes: responseHashes };
      return {
        status: 'PASS', reason: null, pages: page, rpc_request_count: page, response_hashes: responseHashes,
        context_slots: contexts, account_keys: rows.map(row => row.pubkey), row_evidence: rows,
      };
    }
    if (seenKeys.has(paginationKey)) return { status: 'UNRESOLVED', reason: 'v2_pagination_key_repeated', pages: page, rpc_request_count: page, response_hashes: responseHashes };
    seenKeys.add(paginationKey);
  }
  return {
    status: 'UNRESOLVED', reason: 'v2_page_cap_exhausted', pages: HELIUS_OWNER_ENUMERATION_BOUNDS_V0.v2_max_pages_per_lane,
    rpc_request_count: HELIUS_OWNER_ENUMERATION_BOUNDS_V0.v2_max_pages_per_lane, response_hashes: responseHashes,
  };
}
function sameKeys(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function fixedConfirmationBoundary() {
  return {
    status: 'REQUIRED_NOT_PROVIDED',
    required_claims: [
      'successful standard responses are exhaustive and never successful partial populations',
      'gateway response limits and backend scan limits fail explicitly',
      'index unavailability and exclusions fail explicitly',
      'classic Token and Token-2022 preserve equivalent completeness and error semantics',
      'returned context.slot identifies the finalized bank actually enumerated',
      'V2 pagination cursors bind every exhausted page to one complete immutable scan',
    ],
  };
}
function observedVerdict(reasons) {
  if (reasons.some(reason => reason.classification === 'FAIL')) return 'FAIL';
  if (reasons.some(reason => reason.classification === 'UNRESOLVED')) return 'UNRESOLVED';
  return 'PASS';
}

export async function runHeliusOwnerEnumerationCompatibilityProbeV0(input, dependencyInput) {
  const options = validateInput(input);
  const dependencies = validateDependencies(dependencyInput);
  const reasons = [];
  let rpcRequestCount = 0;
  let httpRequestCount = 0;

  const emptyRun = await capturePair(options.empty_control_wallet, 'empty-r1', dependencies);
  rpcRequestCount += emptyRun.rpc_request_count; httpRequestCount += emptyRun.rpc_request_count;
  if (emptyRun.status !== 'PASS') reasons.push({ classification: emptyRun.status, code: emptyRun.reason });
  else if (emptyRun.lanes.some(lane => lane.account_keys.length !== 0)) reasons.push({ classification: 'FAIL', code: 'empty_control_not_empty' });
  const emptyPopulationResolved = emptyRun.status === 'PASS'
    && emptyRun.lanes.every(lane => lane.account_keys.length === 0);

  const knownRuns = [];
  for (let run = 1; run <= options.known_control_repetitions; run += 1) {
    const result = await capturePair(options.known_control_wallet, `known-r${run}`, dependencies);
    rpcRequestCount += result.rpc_request_count; httpRequestCount += result.rpc_request_count;
    knownRuns.push(result);
    if (result.status !== 'PASS') { reasons.push({ classification: result.status, code: result.reason }); continue; }
    for (const lane of result.lanes) {
      if (!sameKeys(lane.account_keys, options.expected_accounts[lane.token_program])) {
        reasons.push({ classification: 'FAIL', code: 'known_account_set_mismatch' });
      }
    }
  }
  if (knownRuns.length > 1 && knownRuns.every(run => run.status === 'PASS')) {
    for (const program of HELIUS_OWNER_ENUMERATION_PROGRAMS_V0) {
      const populations = knownRuns.map(run => run.lanes.find(lane => lane.token_program === program).account_keys);
      if (populations.some(keys => !sameKeys(keys, populations[0]))) reasons.push({ classification: 'FAIL', code: 'same_profile_population_contradiction' });
    }
  }
  const knownPopulationResolved = knownRuns.length === options.known_control_repetitions
    && knownRuns.every(run => run.status === 'PASS' && run.lanes.every(lane =>
      sameKeys(lane.account_keys, options.expected_accounts[lane.token_program])));

  const future = await futureFloorProbe(options.known_control_wallet, dependencies);
  rpcRequestCount += future.rpc_request_count; httpRequestCount += future.rpc_request_count;
  if (future.status !== 'PASS') reasons.push({ classification: future.status, code: future.reason });

  const v2 = [];
  for (const [walletLabel, wallet] of [['empty', options.empty_control_wallet], ['known', options.known_control_wallet]]) {
    for (const [programIndex, program] of HELIUS_OWNER_ENUMERATION_PROGRAMS_V0.entries()) {
      const result = await exhaustV2(wallet, program, `${walletLabel}-${programIndex}`, dependencies);
      rpcRequestCount += result.rpc_request_count; httpRequestCount += result.rpc_request_count;
      v2.push({ wallet_profile: walletLabel, token_program: program, ...result });
      if (result.status !== 'PASS') reasons.push({ classification: result.status, code: result.reason });
    }
  }
  if (emptyPopulationResolved) {
    for (const lane of emptyRun.lanes) {
      const diagnostic = v2.find(item => item.wallet_profile === 'empty' && item.token_program === lane.token_program);
      if (diagnostic?.status === 'PASS' && !sameKeys(lane.account_keys, diagnostic.account_keys)) reasons.push({ classification: 'FAIL', code: 'standard_v2_population_mismatch' });
    }
  }
  if (knownPopulationResolved) {
    for (const lane of knownRuns[0].lanes) {
      const diagnostic = v2.find(item => item.wallet_profile === 'known' && item.token_program === lane.token_program);
      if (diagnostic?.status === 'PASS' && !sameKeys(lane.account_keys, diagnostic.account_keys)) reasons.push({ classification: 'FAIL', code: 'standard_v2_population_mismatch' });
    }
  }

  const observationVerdict = observedVerdict(reasons);
  const report = {
    probe_version: HELIUS_OWNER_ENUMERATION_COMPATIBILITY_PROBE_VERSION_V0,
    profile: {
      provider: 'HELIUS_STANDARD_MAINNET',
      helius_plan_profile: options.helius_plan_profile,
      rpc_origin: 'https://mainnet.helius-rpc.com/',
      standard_method: 'getTokenAccountsByOwner',
      diagnostic_method: 'getTokenAccountsByOwnerV2',
      commitment: 'finalized',
      encoding: 'base64',
      token_programs: [...HELIUS_OWNER_ENUMERATION_PROGRAMS_V0],
    },
    verdict: observationVerdict === 'FAIL' ? 'FAIL' : 'UNRESOLVED',
    observed_compatibility: { verdict: observationVerdict, reasons },
    helius_confirmation: fixedConfirmationBoundary(),
    configured_bounds: {
      max_pair_attempts: HELIUS_OWNER_ENUMERATION_BOUNDS_V0.max_pair_attempts,
      pair_deadline_ms: HELIUS_OWNER_ENUMERATION_BOUNDS_V0.pair_deadline_ms,
      request_timeout_ms: HELIUS_OWNER_ENUMERATION_BOUNDS_V0.request_timeout_ms,
      retry_delays_ms: [...HELIUS_OWNER_ENUMERATION_BOUNDS_V0.retry_delays_ms],
      known_control_repetitions: options.known_control_repetitions,
      v2_page_limit: HELIUS_OWNER_ENUMERATION_BOUNDS_V0.v2_page_limit,
      v2_max_pages_per_lane: HELIUS_OWNER_ENUMERATION_BOUNDS_V0.v2_max_pages_per_lane,
    },
    request_accounting: {
      rpc_requests_made: rpcRequestCount,
      http_requests_made: httpRequestCount,
      documented_credits_per_rpc_request: 1,
      estimated_credits_consumed: rpcRequestCount,
    },
    observations: {
      empty_control: {
        wallet: options.empty_control_wallet,
        standard_runs: [emptyRun],
        lanes: emptyPopulationResolved ? HELIUS_OWNER_ENUMERATION_PROGRAMS_V0.map(program => laneSummary(program, [emptyRun])) : [],
      },
      known_control: {
        wallet: options.known_control_wallet,
        expected_account_keys: options.expected_accounts,
        standard_runs: knownRuns,
        lanes: knownPopulationResolved ? HELIUS_OWNER_ENUMERATION_PROGRAMS_V0.map(program => laneSummary(program, knownRuns)) : [],
      },
      future_min_context_slot: { requested_floor: String(FUTURE_MIN_CONTEXT_SLOT), ...future },
      standard_vs_fully_exhausted_v2: v2,
    },
  };
  return cloneAndFreeze(report);
}
