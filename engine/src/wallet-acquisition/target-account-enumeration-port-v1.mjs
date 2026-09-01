import { types as utilTypes } from 'node:util';

import {
  assertExactFields,
  canonicalJson,
  cloneAndFreeze,
  fail,
  sha256CanonicalJson,
} from '../verification-scope-v1-3/contract.mjs';
import { isSolanaPublicKeyV1 } from './solana-identities.mjs';
import { decodeSolanaTokenAccountDataV1 } from './solana-token-account-decoder-v1.mjs';

export const TARGET_ACCOUNT_ENUMERATION_VERSION_V1 = 'artifact_target_account_enumeration_v1';
export const TARGET_ACCOUNT_ENUMERATION_PROFILE_V1 = 'ARTIFACT_TARGET_ACCOUNT_ENUMERATION_V1';
export const HELIUS_FINALIZED_OWNER_ENUMERATION_PROFILE_V1 = 'HELIUS_STANDARD_FINALIZED_OWNER_ENUMERATION_V1';
export const TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1 = Object.freeze([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

const PORTS = new WeakMap();
const CAPABILITY_FIELDS = ['enumerateTargetAccountsByProgramV1'];
const CAPTURE_FIELDS = ['port', 'wallet', 'target_mint', 'boundary_kind'];
const BOUNDARY_KINDS = new Set(['OPENING', 'ENDING_AS_OF']);
const LEGACY_RESPONSE_FIELDS = ['context', 'accounts'];
const PRODUCTION_RESPONSE_FIELDS = ['context', 'accounts', 'source_evidence'];
const CONTEXT_FIELDS = ['slot'];
const RESULT_FIELDS = [
  'target_account_enumeration_version', 'enumeration_profile', 'analyzed_wallet', 'target_mint',
  'required_token_programs', 'enumeration_context', 'program_results', 'enumeration_digest',
];
const LEGACY_PROGRAM_RESULT_FIELDS = ['token_program', 'response_status', 'context', 'accounts'];
const PRODUCTION_PROGRAM_RESULT_FIELDS = [...LEGACY_PROGRAM_RESULT_FIELDS, 'source_evidence'];
const SOURCE_EVIDENCE_FIELDS = [
  'source_profile', 'provider', 'method', 'commitment', 'encoding', 'minimum_context_slot',
  'accepted_attempt', 'attempt_identity', 'boundary_kind', 'token_program', 'context_semantics',
  'full_population_digest', 'full_account_count', 'full_decoded_bytes', 'bounds_profile',
];
const ACCOUNT_FIELDS = [
  'account', 'account_program', 'lamports', 'executable', 'rent_epoch', 'raw_account_data',
  'normalized_state_profile', 'token_state',
];
const RAW_DATA_FIELDS = ['encoding', 'bytes'];
const TOKEN_STATE_FIELDS = [
  'mint', 'token_authority', 'raw_amount', 'decimals', 'delegate_status', 'delegate',
  'delegated_raw_amount', 'close_authority_status', 'close_authority', 'lifecycle_state', 'account_state',
];
const RAW_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const LEGACY_STATE_PROFILE = 'CAPABILITY_ATTESTED_TOKEN_ACCOUNT_STATE_V1';
const LOCAL_STATE_PROFILE = 'LOCALLY_DECODED_SOLANA_TOKEN_ACCOUNT_STATE_V1';
const HELIUS_CONTEXT_SEMANTICS = 'Both enumerations were reported from the same finalized Helius account-indexed state, identified by equal context.slot values.';

function safeNonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function rawInteger(value, field) {
  if (typeof value !== 'string' || value.length > 20 || !RAW_INTEGER.test(value)) {
    fail('account_enumeration_response_invalid', `${field} is invalid`);
  }
  try {
    if (BigInt(value) > MAX_U64) fail('account_enumeration_response_invalid', `${field} exceeds u64`);
  } catch {
    fail('account_enumeration_response_invalid', `${field} is invalid`);
  }
}
function publicKey(value, field) {
  if (!isSolanaPublicKeyV1(value)) fail('account_enumeration_response_invalid', `${field} is invalid`);
}
function validateContext(value, context) {
  assertExactFields(value, CONTEXT_FIELDS, context);
  if (!safeNonnegative(value.slot)) fail('account_enumeration_response_invalid', `${context}.slot is invalid`);
}
function validateAuthority(status, authority, rawAmount, context) {
  if (!['NONE', 'PRESENT'].includes(status)) fail('account_enumeration_response_invalid', `${context} status is invalid`);
  if (status === 'NONE') {
    if (authority !== null || rawAmount !== '0') fail('account_enumeration_response_invalid', `${context} absent state is inconsistent`);
  } else {
    publicKey(authority, `${context}.authority`);
  }
}
function validateAccount(value, { wallet, targetMint, tokenProgram, production }, context) {
  assertExactFields(value, ACCOUNT_FIELDS, context);
  publicKey(value.account, `${context}.account`);
  if (value.account_program !== tokenProgram || value.executable !== false) {
    fail('account_enumeration_response_invalid', `${context} account program or executable state is invalid`);
  }
  rawInteger(value.lamports, `${context}.lamports`);
  rawInteger(value.rent_epoch, `${context}.rent_epoch`);
  assertExactFields(value.raw_account_data, RAW_DATA_FIELDS, `${context}.raw_account_data`);
  if (value.raw_account_data.encoding !== 'base64' || typeof value.raw_account_data.bytes !== 'string'
      || value.raw_account_data.bytes.length === 0 || value.raw_account_data.bytes.length > 1_048_576
      || !BASE64.test(value.raw_account_data.bytes)
      || Buffer.from(value.raw_account_data.bytes, 'base64').toString('base64') !== value.raw_account_data.bytes) {
    fail('account_enumeration_response_invalid', `${context} raw account bytes are invalid`);
  }
  if (![LEGACY_STATE_PROFILE, LOCAL_STATE_PROFILE].includes(value.normalized_state_profile)) {
    fail('account_enumeration_response_invalid', `${context} normalized state profile is invalid`);
  }
  if ((production && value.normalized_state_profile !== LOCAL_STATE_PROFILE)
      || (!production && value.normalized_state_profile !== LEGACY_STATE_PROFILE)) {
    fail('account_enumeration_response_invalid', `${context} normalized state profile is not source-bound`);
  }
  assertExactFields(value.token_state, TOKEN_STATE_FIELDS, `${context}.token_state`);
  const state = value.token_state;
  publicKey(state.mint, `${context}.token_state.mint`);
  publicKey(state.token_authority, `${context}.token_state.token_authority`);
  if (state.mint !== targetMint || state.token_authority !== wallet) {
    fail('account_enumeration_scope_mismatch', `${context} does not match the requested wallet and mint`);
  }
  rawInteger(state.raw_amount, `${context}.token_state.raw_amount`);
  const validLegacyDecimals = value.normalized_state_profile === LEGACY_STATE_PROFILE
    && safeNonnegative(state.decimals) && state.decimals <= 255;
  const validLocalDecimals = value.normalized_state_profile === LOCAL_STATE_PROFILE && state.decimals === null;
  if (!validLegacyDecimals && !validLocalDecimals) {
    fail('account_enumeration_response_invalid', `${context}.token_state.decimals is invalid`);
  }
  rawInteger(state.delegated_raw_amount, `${context}.token_state.delegated_raw_amount`);
  validateAuthority(
    state.delegate_status,
    state.delegate,
    state.delegated_raw_amount,
    `${context}.token_state.delegate`,
  );
  validateAuthority(
    state.close_authority_status,
    state.close_authority,
    '0',
    `${context}.token_state.close_authority`,
  );
  if (state.lifecycle_state !== 'EXISTS' || !['INITIALIZED', 'FROZEN'].includes(state.account_state)) {
    fail('account_enumeration_response_invalid', `${context} lifecycle or account state is invalid`);
  }
  if (production) {
    if (tokenProgram === TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1[1]) {
      fail('account_enumeration_response_invalid', `${context} nonempty production Token-2022 authority is disabled`);
    }
    let decoded;
    try {
      decoded = decodeSolanaTokenAccountDataV1({
        raw_base64: value.raw_account_data.bytes,
        token_program: tokenProgram,
        expected_wallet: wallet,
      });
    } catch {
      fail('account_enumeration_response_invalid', `${context} local raw account decoding failed`);
    }
    if (canonicalJson(decoded.token_state) !== canonicalJson(state)) {
      fail('account_enumeration_response_invalid', `${context} normalized state does not match raw account bytes`);
    }
  }
}
function validateSourceEvidence(value, tokenProgram, accounts, context) {
  assertExactFields(value, SOURCE_EVIDENCE_FIELDS, context);
  if (value.source_profile !== HELIUS_FINALIZED_OWNER_ENUMERATION_PROFILE_V1
      || value.provider !== 'HELIUS_STANDARD_MAINNET' || value.method !== 'getTokenAccountsByOwner'
      || value.commitment !== 'finalized' || value.encoding !== 'base64'
      || !safeNonnegative(value.minimum_context_slot) || !safeNonnegative(value.accepted_attempt)
      || value.accepted_attempt < 1 || value.accepted_attempt > 8 || !DIGEST.test(value.attempt_identity)
      || !BOUNDARY_KINDS.has(value.boundary_kind)
      || value.token_program !== tokenProgram
      || value.context_semantics !== HELIUS_CONTEXT_SEMANTICS
      || !DIGEST.test(value.full_population_digest)
      || !safeNonnegative(value.full_account_count) || value.full_account_count < accounts.length
      || !safeNonnegative(value.full_decoded_bytes)
      || value.bounds_profile !== 'HELIUS_OWNER_ENUMERATION_BOUNDS_V1') {
    fail('account_enumeration_response_invalid', `${context} is invalid`);
  }
  const retainedBytes = accounts.reduce(
    (total, account) => total + Buffer.from(account.raw_account_data.bytes, 'base64').length,
    0,
  );
  if (value.full_decoded_bytes < retainedBytes) {
    fail('account_enumeration_response_invalid', `${context} retained byte count exceeds full population`);
  }
}

export function computeHeliusOwnerEnumerationAttemptIdentityV1(input) {
  return sha256CanonicalJson({
    identity_profile: 'HELIUS_OWNER_ENUMERATION_PAIR_IDENTITY_V1',
    analyzed_wallet: input.analyzed_wallet,
    target_mint: input.target_mint,
    boundary_kind: input.boundary_kind,
    minimum_context_slot: input.minimum_context_slot,
    accepted_attempt: input.accepted_attempt,
    context_slot: input.context_slot,
    populations: input.populations,
  });
}
function validateCapability(capability) {
  try {
    if (capability === null || typeof capability !== 'object' || Array.isArray(capability)
        || utilTypes.isProxy(capability) || Object.getPrototypeOf(capability) !== Object.prototype
        || Object.getOwnPropertySymbols(capability).length !== 0) {
      fail('account_enumeration_capability_denied', 'account enumeration capability is unavailable');
    }
    const descriptors = Object.getOwnPropertyDescriptors(capability);
    if (Object.keys(descriptors).length !== CAPABILITY_FIELDS.length) {
      fail('account_enumeration_capability_denied', 'account enumeration capability shape is invalid');
    }
    const descriptor = descriptors.enumerateTargetAccountsByProgramV1;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      fail('account_enumeration_capability_denied', 'account enumeration capability method is invalid');
    }
    return descriptor.value.bind(capability);
  } catch (error) {
    if (error?.code === 'account_enumeration_capability_denied') throw error;
    fail('account_enumeration_capability_denied', 'account enumeration capability is unavailable');
  }
}

function validateCaptureInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length !== 0) {
    fail('account_enumeration_request_invalid', 'account enumeration input must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Object.keys(descriptors)) {
    if (!CAPTURE_FIELDS.includes(key)) fail('unknown_field', 'target_account_enumeration_input contains unknown field');
  }
  for (const field of CAPTURE_FIELDS) {
    if (!descriptors[field]?.enumerable || !Object.hasOwn(descriptors[field], 'value')) {
      fail('missing_field', `target_account_enumeration_input is missing ${field}`);
    }
  }
}

function registerTargetAccountEnumerationPortV1(capability, productionAllowed) {
  const enumerate = validateCapability(capability);
  const port = Object.freeze({
    async enumerateTargetAccountsByProgramV1(request) {
      let response;
      try {
        response = await enumerate(cloneAndFreeze(request));
      } catch {
        fail('account_enumeration_capability_failed', 'account enumeration capability failed');
      }
      try {
        return cloneAndFreeze(response);
      } catch {
        fail('account_enumeration_response_invalid', 'account enumeration response is unsafe');
      }
    },
  });
  PORTS.set(port, productionAllowed);
  return port;
}

export function createTargetAccountEnumerationPortV1(capability) {
  return registerTargetAccountEnumerationPortV1(capability, false);
}

export async function createFrozenHeliusTargetAccountEnumerationPortV1(input, dependencies) {
  const { captureFrozenHeliusTargetAccountEnumerationCapabilityV1 } = await import(
    './helius-target-account-snapshot-adapter-v1.mjs'
  );
  const capability = await captureFrozenHeliusTargetAccountEnumerationCapabilityV1(input, dependencies);
  return registerTargetAccountEnumerationPortV1(capability, true);
}

function digestPreimage(value) {
  const preimage = {};
  for (const key of RESULT_FIELDS) if (key !== 'enumeration_digest') {
    Object.defineProperty(preimage, key, { value: value[key], enumerable: true });
  }
  return preimage;
}

export function validateTargetAccountEnumerationStructureV1(value) {
  assertExactFields(value, RESULT_FIELDS, 'target_account_enumeration');
  if (value.target_account_enumeration_version !== TARGET_ACCOUNT_ENUMERATION_VERSION_V1
      || ![TARGET_ACCOUNT_ENUMERATION_PROFILE_V1, HELIUS_FINALIZED_OWNER_ENUMERATION_PROFILE_V1]
        .includes(value.enumeration_profile)) {
    fail('unsupported_enumeration_version', 'target account enumeration version is unsupported');
  }
  publicKey(value.analyzed_wallet, 'analyzed_wallet');
  publicKey(value.target_mint, 'target_mint');
  if (canonicalJson(value.required_token_programs)
      !== canonicalJson(TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1)) {
    fail('required_program_coverage_missing', 'canonical Token and Token-2022 coverage is required');
  }
  validateContext(value.enumeration_context, 'enumeration_context');
  if (!Array.isArray(value.program_results) || value.program_results.length !== 2) {
    fail('required_program_coverage_missing', 'every required token program needs one result');
  }
  const seenAccounts = new Set();
  const production = value.enumeration_profile === HELIUS_FINALIZED_OWNER_ENUMERATION_PROFILE_V1;
  let attemptIdentity = null;
  let acceptedAttempt = null;
  let minimumContextSlot = null;
  let boundaryKind = null;
  value.program_results.forEach((result, index) => {
    assertExactFields(result, production ? PRODUCTION_PROGRAM_RESULT_FIELDS : LEGACY_PROGRAM_RESULT_FIELDS,
      `program_results.${index}`);
    const expectedProgram = TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1[index];
    if (result.token_program !== expectedProgram || result.response_status !== 'SUCCESS') {
      fail('required_program_coverage_missing', 'required token program response is missing or unsuccessful');
    }
    validateContext(result.context, `program_results.${index}.context`);
    if (result.context.slot !== value.enumeration_context.slot) {
      fail('enumeration_context_mismatch', 'program results do not share one response-derived context');
    }
    if (!Array.isArray(result.accounts)) fail('account_enumeration_response_invalid', 'accounts must be an array');
    result.accounts.forEach((account, accountIndex) => {
      validateAccount(account, {
        wallet: value.analyzed_wallet,
        targetMint: value.target_mint,
        tokenProgram: expectedProgram,
        production,
      }, `program_results.${index}.accounts.${accountIndex}`);
      if (seenAccounts.has(account.account)) fail('duplicate_enumerated_account', 'enumerated accounts must be globally unique');
      seenAccounts.add(account.account);
      if (accountIndex > 0 && result.accounts[accountIndex - 1].account >= account.account) {
        fail('noncanonical_enumerated_account_order', 'enumerated accounts must be ordered by address');
      }
    });
    if (production) {
      validateSourceEvidence(
        result.source_evidence,
        expectedProgram,
        result.accounts,
        `program_results.${index}.source_evidence`,
      );
      if (result.source_evidence.minimum_context_slot > result.context.slot) {
        fail('enumeration_context_mismatch', 'production context does not satisfy its retained freshness floor');
      }
      if (attemptIdentity === null) attemptIdentity = result.source_evidence.attempt_identity;
      else if (attemptIdentity !== result.source_evidence.attempt_identity) {
        fail('enumeration_context_mismatch', 'production program results do not share one acquisition attempt');
      }
      if (acceptedAttempt === null) acceptedAttempt = result.source_evidence.accepted_attempt;
      else if (acceptedAttempt !== result.source_evidence.accepted_attempt) {
        fail('enumeration_context_mismatch', 'production program results do not share one attempt ordinal');
      }
      if (minimumContextSlot === null) minimumContextSlot = result.source_evidence.minimum_context_slot;
      else if (minimumContextSlot !== result.source_evidence.minimum_context_slot) {
        fail('enumeration_context_mismatch', 'production program results do not share one freshness floor');
      }
      if (boundaryKind === null) boundaryKind = result.source_evidence.boundary_kind;
      else if (boundaryKind !== result.source_evidence.boundary_kind) {
        fail('enumeration_context_mismatch', 'production program results do not share one boundary');
      }
    }
  });
  if (production) {
    const source = value.program_results[0].source_evidence;
    const expectedAttemptIdentity = computeHeliusOwnerEnumerationAttemptIdentityV1({
      analyzed_wallet: value.analyzed_wallet,
      target_mint: value.target_mint,
      boundary_kind: source.boundary_kind,
      minimum_context_slot: source.minimum_context_slot,
      accepted_attempt: source.accepted_attempt,
      context_slot: value.enumeration_context.slot,
      populations: value.program_results.map(result => ({
        token_program: result.token_program,
        full_population_digest: result.source_evidence.full_population_digest,
        full_account_count: result.source_evidence.full_account_count,
        full_decoded_bytes: result.source_evidence.full_decoded_bytes,
        bounds_profile: result.source_evidence.bounds_profile,
      })),
    });
    if (attemptIdentity !== expectedAttemptIdentity) {
      fail('enumeration_context_mismatch', 'production pair identity does not bind its full population evidence');
    }
  }
  if (!/^[0-9a-f]{64}$/.test(value.enumeration_digest)
      || value.enumeration_digest !== sha256CanonicalJson(digestPreimage(value))) {
    fail('enumeration_digest_mismatch', 'target account enumeration digest is invalid');
  }
  return true;
}

export async function captureTargetAccountEnumerationV1(input) {
  validateCaptureInput(input);
  if (!PORTS.has(input.port)) fail('account_enumeration_capability_denied', 'validated account enumeration port is required');
  const productionAllowed = PORTS.get(input.port);
  if (!isSolanaPublicKeyV1(input.wallet) || !isSolanaPublicKeyV1(input.target_mint)) {
    fail('account_enumeration_request_invalid', 'wallet and target mint must be Solana public keys');
  }
  if (!BOUNDARY_KINDS.has(input.boundary_kind)) {
    fail('account_enumeration_request_invalid', 'boundary kind is invalid');
  }
  const programResults = [];
  let production = null;
  for (const tokenProgram of TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1) {
    const response = await input.port.enumerateTargetAccountsByProgramV1({
      wallet: input.wallet,
      target_mint: input.target_mint,
      token_program: tokenProgram,
      boundary_kind: input.boundary_kind,
      commitment: 'finalized',
      data_encoding: 'base64',
    });
    try {
      const responseProduction = response !== null && typeof response === 'object'
        && Object.hasOwn(response, 'source_evidence');
      if (responseProduction && !productionAllowed) {
        fail('account_enumeration_response_invalid', 'generic enumeration capabilities cannot issue production evidence');
      }
      assertExactFields(response, responseProduction ? PRODUCTION_RESPONSE_FIELDS : LEGACY_RESPONSE_FIELDS,
        'account_enumeration_response');
      if (production === null) production = responseProduction;
      else if (production !== responseProduction) {
        fail('account_enumeration_response_invalid', 'enumeration response profiles cannot be mixed');
      }
      validateContext(response.context, 'account_enumeration_response.context');
      if (!Array.isArray(response.accounts)) fail('account_enumeration_response_invalid', 'accounts must be an array');
      const accounts = response.accounts.map((account, index) => {
        validateAccount(account, {
          wallet: input.wallet, targetMint: input.target_mint, tokenProgram, production: responseProduction,
        }, `account_enumeration_response.accounts.${index}`);
        return account;
      }).sort((left, right) => left.account < right.account ? -1 : left.account > right.account ? 1 : 0);
      if (responseProduction) {
        validateSourceEvidence(
          response.source_evidence,
          tokenProgram,
          accounts,
          'account_enumeration_response.source_evidence',
        );
        if (response.source_evidence.boundary_kind !== input.boundary_kind) {
          fail('account_enumeration_response_invalid', 'production evidence boundary is not request-bound');
        }
      }
      if (new Set(accounts.map(account => account.account)).size !== accounts.length) {
        fail('duplicate_enumerated_account', 'enumerated accounts must be unique');
      }
      programResults.push({
        token_program: tokenProgram,
        response_status: 'SUCCESS',
        context: response.context,
        accounts,
        ...(responseProduction ? { source_evidence: response.source_evidence } : {}),
      });
    } catch (error) {
      if (typeof error?.code === 'string') throw error;
      fail('account_enumeration_response_invalid', 'account enumeration response is invalid');
    }
  }
  const slots = new Set(programResults.map(result => result.context.slot));
  if (slots.size !== 1) fail('enumeration_context_mismatch', 'required token program results have different contexts');
  const result = {
    target_account_enumeration_version: TARGET_ACCOUNT_ENUMERATION_VERSION_V1,
    enumeration_profile: production
      ? HELIUS_FINALIZED_OWNER_ENUMERATION_PROFILE_V1 : TARGET_ACCOUNT_ENUMERATION_PROFILE_V1,
    analyzed_wallet: input.wallet,
    target_mint: input.target_mint,
    required_token_programs: [...TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1],
    enumeration_context: { slot: programResults[0].context.slot },
    program_results: programResults,
    enumeration_digest: null,
  };
  result.enumeration_digest = sha256CanonicalJson(digestPreimage(result));
  const frozen = cloneAndFreeze(result);
  validateTargetAccountEnumerationStructureV1(frozen);
  return frozen;
}
