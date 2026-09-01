import { types as utilTypes } from 'node:util';

import { cloneAndFreeze, sha256CanonicalJson } from '../verification-scope-v1-3/contract.mjs';
import { isSolanaPublicKeyV1 } from './solana-identities.mjs';
import {
  CLASSIC_TOKEN_PROGRAM_V1,
  TOKEN_2022_PROGRAM_V1,
  decodeSolanaTokenAccountDataV1,
  decodeToken2022MintDataV1,
} from './solana-token-account-decoder-v1.mjs';
import { computeHeliusOwnerEnumerationAttemptIdentityV1 } from './target-account-enumeration-port-v1.mjs';

export const HELIUS_FINALIZED_OWNER_ENUMERATION_PROFILE_V1 = 'HELIUS_STANDARD_FINALIZED_OWNER_ENUMERATION_V1';
export const HELIUS_FINALIZED_ENUMERATION_TRUST_STATEMENT_V1 = 'Both enumerations were reported from the same finalized Helius account-indexed state, identified by equal context.slot values.';
export const HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1 = Object.freeze({
  max_pair_attempts: 8,
  capture_deadline_ms: 30_000,
  request_timeout_ms: 5_000,
  retry_delays_ms: Object.freeze([100, 200, 400, 800, 1000, 1000, 1000]),
  max_rows_per_lane: 10_000,
  max_response_bytes_per_lane: 16 * 1024 * 1024,
  max_account_bytes: 1024 * 1024,
  max_decoded_bytes_per_lane: 8 * 1024 * 1024,
});

const PROGRAMS = [CLASSIC_TOKEN_PROGRAM_V1, TOKEN_2022_PROGRAM_V1];
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const BOUNDED_TIMEOUT = Symbol('bounded_timeout');
const INPUT_FIELDS = ['wallet', 'target_mint', 'boundary_kind', 'minimum_context_slot'];
const DEPENDENCY_FIELDS = ['request', 'clock', 'sleep'];
const BOUNDARIES = new Set(['OPENING', 'ENDING_AS_OF']);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class HeliusTargetAccountSnapshotError extends Error {
  constructor(code) {
    super('Helius target-account snapshot acquisition failed');
    this.name = 'HeliusTargetAccountSnapshotError';
    this.code = code;
    delete this.stack;
  }
}
function fail(code) { throw new HeliusTargetAccountSnapshotError(code); }
function safeSlot(value) { return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0); }
function plainExact(value, fields, code) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).sort().join('\0') !== [...fields].sort().join('\0')
        || Object.values(descriptors).some(descriptor => !descriptor.enumerable
          || !Object.hasOwn(descriptor, 'value'))) fail(code);
  } catch (error) {
    if (error instanceof HeliusTargetAccountSnapshotError) throw error;
    fail(code);
  }
}
function descriptorSafeTransportGraph(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return true;
  try {
    if (utilTypes.isProxy(value) || seen.has(value)) return false;
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)
        || Object.getOwnPropertySymbols(value).length !== 0) return false;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!Object.hasOwn(descriptor, 'value') || (key !== 'length' && !descriptor.enumerable)
          || !descriptorSafeTransportGraph(descriptor.value, seen)) return false;
    }
    seen.delete(value);
    return true;
  } catch { return false; }
}
function validateInput(input) {
  plainExact(input, INPUT_FIELDS, 'helius_snapshot_input_invalid');
  if (!isSolanaPublicKeyV1(input.wallet) || !isSolanaPublicKeyV1(input.target_mint)
      || !BOUNDARIES.has(input.boundary_kind) || !safeSlot(input.minimum_context_slot)) {
    fail('helius_snapshot_input_invalid');
  }
  return { ...input };
}
function validateDependencies(value) {
  plainExact(value, DEPENDENCY_FIELDS, 'helius_snapshot_capability_invalid');
  if (typeof value.request !== 'function' || typeof value.clock !== 'function' || typeof value.sleep !== 'function') {
    fail('helius_snapshot_capability_invalid');
  }
  return value;
}
function ownerBody(scope, program, attempt) {
  return {
    jsonrpc: '2.0',
    id: `owner-snapshot-${scope.boundary_kind.toLowerCase()}-a${attempt}-${program === CLASSIC_TOKEN_PROGRAM_V1 ? 'classic' : 'token2022'}`,
    method: 'getTokenAccountsByOwner',
    params: [scope.wallet, { programId: program }, {
      commitment: 'finalized', encoding: 'base64', minContextSlot: scope.minimum_context_slot,
    }],
  };
}
function mintBody(scope, attempt) {
  return {
    jsonrpc: '2.0', id: `owner-snapshot-${scope.boundary_kind.toLowerCase()}-a${attempt}-mint`,
    method: 'getAccountInfo', params: [scope.target_mint, {
      commitment: 'finalized', encoding: 'base64', minContextSlot: scope.minimum_context_slot,
    }],
  };
}
function ownCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor?.value === 'request_timeout' ? 'request_timeout' : null;
  } catch { return null; }
}
async function boundedAwait(value, timeoutMs) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(resolve, Math.max(1, Math.ceil(timeoutMs)), BOUNDED_TIMEOUT);
  });
  try { return await Promise.race([Promise.resolve(value), timeout]); }
  finally { clearTimeout(timer); }
}
async function invoke(request, body, timeoutMs) {
  try {
    const raw = await boundedAwait(
      Promise.resolve().then(() => request({ body: cloneAndFreeze(body), timeout_ms: timeoutMs })),
      timeoutMs,
    );
    if (raw === BOUNDED_TIMEOUT) return { kind: 'terminal', code: 'helius_request_timeout' };
    if (!descriptorSafeTransportGraph(raw)) {
      return { kind: 'terminal', code: 'helius_transport_response_invalid' };
    }
    let response;
    try { response = structuredClone(raw); } catch { return { kind: 'terminal', code: 'helius_transport_response_invalid' }; }
    if (response === null || typeof response !== 'object' || Array.isArray(response)
        || !Number.isInteger(response.status)) return { kind: 'terminal', code: 'helius_transport_response_invalid' };
    if (response.status !== 200) return {
      kind: TRANSIENT_HTTP.has(response.status) ? 'transient' : 'terminal',
      code: TRANSIENT_HTTP.has(response.status) ? 'helius_http_transient' : 'helius_http_non_success',
    };
    let size;
    try { size = Buffer.byteLength(JSON.stringify(response.data), 'utf8'); } catch { return { kind: 'terminal', code: 'helius_rpc_schema_invalid' }; }
    if (size > HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1.max_response_bytes_per_lane) {
      return { kind: 'terminal', code: 'helius_response_cap_exceeded' };
    }
    return { kind: 'success', data: response.data };
  } catch (error) {
    return ownCode(error) === 'request_timeout'
      ? { kind: 'terminal', code: 'helius_request_timeout' }
      : { kind: 'transient', code: 'helius_transport_failed' };
  }
}
function parseCanonicalBase64(value) {
  if (!Array.isArray(value) || value.length !== 2 || value[1] !== 'base64'
      || typeof value[0] !== 'string' || value[0].length === 0 || !BASE64.test(value[0])) {
    fail('helius_owner_population_invalid');
  }
  const bytes = Buffer.from(value[0], 'base64');
  if (bytes.toString('base64') !== value[0] || bytes.length > HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1.max_account_bytes) {
    fail('helius_owner_population_invalid');
  }
  return { base64: value[0], bytes };
}
function parseRow(row, program, wallet) {
  plainExact(row, ['pubkey', 'account'], 'helius_owner_population_invalid');
  plainExact(row.account, ['data', 'executable', 'lamports', 'owner', 'rentEpoch', 'space'], 'helius_owner_population_invalid');
  const account = row.account;
  if (!isSolanaPublicKeyV1(row.pubkey) || account.owner !== program || account.executable !== false
      || !Number.isSafeInteger(account.lamports) || account.lamports < 0 || Object.is(account.lamports, -0)
      || !Number.isSafeInteger(account.rentEpoch) || account.rentEpoch < 0 || Object.is(account.rentEpoch, -0)
      || !Number.isSafeInteger(account.space) || account.space < 0 || Object.is(account.space, -0)) {
    fail('helius_owner_population_invalid');
  }
  const raw = parseCanonicalBase64(account.data);
  if (account.space !== raw.bytes.length) fail('helius_owner_population_invalid');
  let decoded;
  try {
    decoded = decodeSolanaTokenAccountDataV1({
      raw_base64: raw.base64, token_program: program, expected_wallet: wallet,
    });
  } catch { fail('helius_owner_population_invalid'); }
  return {
    account: row.pubkey,
    account_program: program,
    lamports: String(account.lamports),
    executable: false,
    rent_epoch: String(account.rentEpoch),
    raw_account_data: { encoding: 'base64', bytes: raw.base64 },
    normalized_state_profile: decoded.normalized_state_profile,
    token_state: decoded.token_state,
  };
}
function parseOwnerRpc(value, id, program, scope) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.jsonrpc !== '2.0' || value.id !== id || Object.hasOwn(value, 'error')
      || value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
      || value.result.context === null || typeof value.result.context !== 'object'
      || !safeSlot(value.result.context.slot) || !Array.isArray(value.result.value)) {
    fail('helius_rpc_schema_invalid');
  }
  if (value.result.context.slot < scope.minimum_context_slot) fail('helius_context_floor_not_satisfied');
  if (value.result.value.length > HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1.max_rows_per_lane) {
    fail('helius_population_cap_exceeded');
  }
  const all = [];
  let byteCount = 0;
  const keys = new Set();
  for (const row of value.result.value) {
    const parsed = parseRow(row, program, scope.wallet);
    if (keys.has(parsed.account)) fail('helius_owner_population_invalid');
    keys.add(parsed.account);
    byteCount += Buffer.from(parsed.raw_account_data.bytes, 'base64').length;
    if (byteCount > HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1.max_decoded_bytes_per_lane) {
      fail('helius_population_cap_exceeded');
    }
    all.push(parsed);
  }
  return {
    slot: value.result.context.slot,
    all,
    target: all.filter(item => item.token_state.mint === scope.target_mint),
  };
}
function parseMintRpc(value, id, slot, scope) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.jsonrpc !== '2.0' || value.id !== id || Object.hasOwn(value, 'error')
      || value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
      || value.result.context === null || typeof value.result.context !== 'object'
      || !safeSlot(value.result.context.slot)) {
    fail('helius_mint_evidence_invalid');
  }
  if (value.result.context.slot !== slot) return false;
  if (value.result.value === null || typeof value.result.value !== 'object') fail('helius_mint_evidence_invalid');
  const account = value.result.value;
  plainExact(account, ['data', 'executable', 'lamports', 'owner', 'rentEpoch', 'space'], 'helius_mint_evidence_invalid');
  if (account.owner !== TOKEN_2022_PROGRAM_V1 || account.executable !== false) fail('helius_mint_evidence_invalid');
  const raw = parseCanonicalBase64(account.data);
  if (account.space !== raw.bytes.length) fail('helius_mint_evidence_invalid');
  try { decodeToken2022MintDataV1({ raw_base64: raw.base64, expected_mint: scope.target_mint }); }
  catch { fail('helius_mint_evidence_invalid'); }
  return true;
}
function frozenReplayCapability(scope, slot, lanes, acceptedAttempt) {
  const byProgram = new Map(PROGRAMS.map((program, index) => [program, lanes[index].target]));
  const summaries = PROGRAMS.map((program, index) => {
    const accounts = [...lanes[index].all].sort((left, right) => left.account.localeCompare(right.account));
    return {
      token_program: program,
      full_population_digest: sha256CanonicalJson({ token_program: program, accounts }),
      full_account_count: accounts.length,
      full_decoded_bytes: accounts.reduce(
        (total, account) => total + Buffer.from(account.raw_account_data.bytes, 'base64').length,
        0,
      ),
      bounds_profile: 'HELIUS_OWNER_ENUMERATION_BOUNDS_V1',
    };
  });
  const attemptIdentity = computeHeliusOwnerEnumerationAttemptIdentityV1({
    analyzed_wallet: scope.wallet,
    target_mint: scope.target_mint,
    boundary_kind: scope.boundary_kind,
    minimum_context_slot: scope.minimum_context_slot,
    accepted_attempt: acceptedAttempt,
    context_slot: slot,
    populations: summaries,
  });
  return Object.freeze({
    async enumerateTargetAccountsByProgramV1(request) {
      const expected = {
        wallet: scope.wallet, target_mint: scope.target_mint, token_program: request?.token_program,
        boundary_kind: scope.boundary_kind, commitment: 'finalized', data_encoding: 'base64',
      };
      if (!PROGRAMS.includes(request?.token_program)
          || JSON.stringify(request) !== JSON.stringify(expected)) fail('helius_frozen_replay_scope_mismatch');
      return cloneAndFreeze({
        context: { slot },
        accounts: byProgram.get(request.token_program),
        source_evidence: {
          source_profile: HELIUS_FINALIZED_OWNER_ENUMERATION_PROFILE_V1,
          provider: 'HELIUS_STANDARD_MAINNET',
          method: 'getTokenAccountsByOwner',
          commitment: 'finalized',
          encoding: 'base64',
          minimum_context_slot: scope.minimum_context_slot,
          accepted_attempt: acceptedAttempt,
          attempt_identity: attemptIdentity,
          boundary_kind: scope.boundary_kind,
          token_program: request.token_program,
          context_semantics: HELIUS_FINALIZED_ENUMERATION_TRUST_STATEMENT_V1,
          ...summaries[PROGRAMS.indexOf(request.token_program)],
        },
      });
    },
  });
}

export async function captureFrozenHeliusTargetAccountEnumerationCapabilityV1(input, dependencyInput) {
  const scope = validateInput(input);
  const dependencies = validateDependencies(dependencyInput);
  const started = dependencies.clock();
  if (!Number.isFinite(started) || Object.is(started, -0)) fail('helius_snapshot_clock_invalid');
  const deadline = started + HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1.capture_deadline_ms;
  let mintRequired = false;
  for (let attempt = 1; attempt <= HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1.max_pair_attempts; attempt += 1) {
    const now = dependencies.clock();
    const remaining = deadline - now;
    if (!(remaining > 0)) fail('helius_snapshot_deadline_exhausted');
    const ownerBodies = PROGRAMS.map(program => ownerBody(scope, program, attempt));
    const bodies = mintRequired ? [...ownerBodies, mintBody(scope, attempt)] : ownerBodies;
    const results = await Promise.all(bodies.map(body => invoke(
      dependencies.request, body, Math.min(remaining, HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1.request_timeout_ms),
    )));
    if (!(dependencies.clock() <= deadline)) fail('helius_snapshot_deadline_exhausted');
    const terminal = results.find(item => item.kind === 'terminal');
    if (terminal !== undefined) fail(terminal.code);
    if (results.every(item => item.kind === 'success')) {
      const lanes = PROGRAMS.map((program, index) => parseOwnerRpc(results[index].data, ownerBodies[index].id, program, scope));
      const globalKeys = new Set();
      for (const lane of lanes) for (const row of lane.all) {
        if (globalKeys.has(row.account)) fail('helius_owner_population_invalid');
        globalKeys.add(row.account);
      }
      const ownerSlot = lanes[0].slot;
      if (lanes[1].slot === ownerSlot) {
        if (mintRequired) {
          if (parseMintRpc(results[2].data, bodies[2].id, ownerSlot, scope)) {
            fail('token_2022_cross_method_context_unconfirmed');
          }
        }
        if (lanes[1].target.length > 0) {
          mintRequired = true;
        } else {
          return frozenReplayCapability(scope, ownerSlot, lanes, attempt);
        }
      }
    }
    if (attempt === HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1.max_pair_attempts) break;
    const delay = HELIUS_TARGET_ACCOUNT_SNAPSHOT_BOUNDS_V1.retry_delays_ms[attempt - 1];
    const beforeSleep = dependencies.clock();
    if (!(beforeSleep + delay < deadline)) fail('helius_snapshot_deadline_exhausted');
    try {
      const sleepOutcome = await boundedAwait(
        Promise.resolve().then(() => dependencies.sleep(delay)),
        deadline - beforeSleep,
      );
      if (sleepOutcome === BOUNDED_TIMEOUT) fail('helius_snapshot_deadline_exhausted');
    } catch (error) {
      if (error instanceof HeliusTargetAccountSnapshotError) throw error;
      fail('helius_snapshot_retry_failed');
    }
  }
  fail('helius_snapshot_attempts_exhausted');
}
