import {
  assertExactFields, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson,
} from './contract.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from '../wallet-acquisition/solana-identities.mjs';
import { validateSolanaFullTransactionEffectV13 } from './solana-full-transaction-effect-projector.mjs';
import { validateCanonicalTransactionOrderStructureV13 } from './canonical-order.mjs';

export const TARGET_ACCOUNT_BOUNDARY_VERSION_V1_3 = 'artifact_target_account_boundary_v1_3';
export const TARGET_ACCOUNT_BOUNDARY_PROFILE_V1_3 = 'ARTIFACT_POSITION_BOUNDARY_V1';

const INPUT_FIELDS = ['wallet', 'target_mint', 'canonical_order', 'transaction_records'];
const RECORD_FIELDS = ['transaction', 'effect'];
const TOP_FIELDS = [
  'target_account_boundary_version', 'boundary_authority_profile', 'analyzed_wallet', 'target_mint',
  'canonical_order_evidence_identity', 'account_coverage_status', 'account_coverage_evidence_identity',
  'reason_codes', 'findings', 'accounts', 'transaction_boundaries', 'opening_boundary', 'ending_boundary',
];
const ACCOUNT_FIELDS = [
  'account', 'owner', 'owner_status', 'authority', 'authority_status', 'delegate', 'delegate_status',
  'token_program', 'token_program_status', 'creation_status', 'closure_status',
  'creation_effect_ids', 'closure_authority', 'closure_effect_ids', 'observations',
];
const OBSERVATION_FIELDS = [
  'canonical_transaction_coordinate', 'transaction_identity', 'pre_raw_amount', 'post_raw_amount',
  'pre_evidence_status', 'post_evidence_status', 'source_effect_ids',
];
const TRANSACTION_IDENTITY_FIELDS = ['signature', 'slot', 'block_time', 'transaction_version'];
const TRANSACTION_BOUNDARY_FIELDS = [
  'canonical_transaction_coordinate', 'transaction_identity', 'pre_boundary', 'post_boundary',
];
const BOUNDARY_FIELDS = [
  'boundary_kind', 'canonical_transaction_coordinate', 'transaction_identity',
  'observed_wallet_owned_account_count', 'observed_wallet_owned_raw_quantity', 'observed_quantity_status',
  'aggregate_raw_quantity', 'aggregate_inventory_status', 'zero_status', 'economic_continuity_status',
  'basis_reference_identity', 'opening_state', 'valid_for_closed', 'valid_for_open',
  'valid_for_open_realized_partial',
];
const FINDING_FIELDS = ['finding_id', 'finding_code', 'transaction_identity', 'account', 'source_effect_ids'];
const FINDING_CODES = new Set([
  'TARGET_ACCOUNT_COVERAGE_NOT_ATTESTED',
  'TARGET_ACCOUNT_OWNER_UNRESOLVED',
  'TARGET_ACCOUNT_BALANCE_SIDE_MISSING',
  'TARGET_ACCOUNT_IDENTITY_CONTRADICTORY',
  'TARGET_ACCOUNT_AUTHORITY_NOT_ESTABLISHED',
  'TARGET_EFFECT_CAUSAL_SEMANTICS_UNRESOLVED',
]);
const REASON_CODES = [
  'OPENING_INVENTORY_UNRESOLVED',
  'ENDING_INVENTORY_UNRESOLVED',
  'TARGET_ACCOUNT_COVERAGE_INCOMPLETE',
  'ACCOUNT_AUTHORITY_UNRESOLVED',
];
const RAW_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

function safeNonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function publicKey(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (!isSolanaPublicKeyV1(value)) fail('invalid_solana_identity', `${field} is invalid`);
}
function exactRaw(value, field, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > 20 || !RAW_AMOUNT.test(value)) fail('invalid_raw_quantity', `${field} is invalid`);
  if (BigInt(value) > MAX_U64) fail('invalid_raw_quantity', `${field} exceeds u64`);
}
function transactionIdentity(transaction) {
  return {
    signature: transaction.signature,
    slot: transaction.slot,
    block_time: transaction.block_time,
    transaction_version: transaction.transaction_version,
  };
}
function sameIdentity(left, right) { return canonicalJson(left) === canonicalJson(right); }
function compareIdentity(left, right) {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
function findingPreimage(finding) {
  return {
    identity_profile: 'ARTIFACT_TARGET_ACCOUNT_BOUNDARY_FINDING_ID_V1',
    finding_code: finding.finding_code,
    transaction_identity: finding.transaction_identity,
    account: finding.account,
    source_effect_ids: finding.source_effect_ids,
  };
}
function findingId(finding) { return `boundary-finding-${sha256CanonicalJson(findingPreimage(finding))}`; }
function compareFindings(left, right) {
  const a = canonicalJson(findingPreimage(left));
  const b = canonicalJson(findingPreimage(right));
  return a < b ? -1 : a > b ? 1 : 0;
}
function effectIdsForAccount(effect, account) {
  return [...effect.established_effects.filter(item => item.account === account).map(item => item.effect_id),
    ...effect.residual_unresolved_effects.filter(item => item.account === account).map(item => item.residual_id)].sort();
}
function hasLifecycleEffect(effect, account, effectKind) {
  return effect.established_effects.some(item => item.account === account && item.effect_kind === effectKind);
}
function addFinding(findings, finding_code, transaction_identity = null, account = null, source_effect_ids = []) {
  const finding = { finding_id: null, finding_code, transaction_identity, account, source_effect_ids: [...new Set(source_effect_ids)].sort() };
  finding.finding_id = findingId(finding);
  findings.set(finding.finding_id, finding);
}
function rowMap(transaction, side) {
  return new Map(transaction[`${side}_token_balances`]
    .filter(row => row.mint !== undefined)
    .map(row => [row.account, row]));
}
function boundary({ kind, coordinate, identity, observed }) {
  return {
    boundary_kind: kind,
    canonical_transaction_coordinate: coordinate,
    transaction_identity: identity,
    observed_wallet_owned_account_count: observed.count,
    observed_wallet_owned_raw_quantity: observed.raw,
    observed_quantity_status: observed.raw === null ? 'UNAVAILABLE' : 'EXACT_PARTIAL_OBSERVATION',
    aggregate_raw_quantity: null,
    aggregate_inventory_status: 'UNRESOLVED_ACCOUNT_COVERAGE',
    zero_status: 'UNRESOLVED',
    economic_continuity_status: 'UNRESOLVED',
    basis_reference_identity: null,
    opening_state: kind === 'OPENING_PRE' ? 'UNRESOLVED' : null,
    valid_for_closed: false,
    valid_for_open: false,
    valid_for_open_realized_partial: false,
  };
}

export function buildTargetAccountBoundaryV13(input) {
  assertExactFields(input, INPUT_FIELDS, 'target_account_boundary_input');
  publicKey(input.wallet, 'target_account_boundary_input.wallet');
  publicKey(input.target_mint, 'target_account_boundary_input.target_mint');
  validateCanonicalTransactionOrderStructureV13(input.canonical_order);
  if (input.canonical_order.analyzed_wallet !== input.wallet) fail('order_scope_mismatch', 'canonical order wallet does not match');
  if (!Array.isArray(input.transaction_records)) fail('invalid_transaction_collection', 'transaction_records must be an array');
  const recordsBySignature = new Map();
  for (const [index, record] of input.transaction_records.entries()) {
    assertExactFields(record, RECORD_FIELDS, `transaction_records.${index}`);
    validateSolanaFullTransactionEffectV13({ wallet: input.wallet, transaction: record.transaction, effect: record.effect });
    if (recordsBySignature.has(record.transaction.signature)) fail('duplicate_transaction_identity', 'transaction records must be unique');
    recordsBySignature.set(record.transaction.signature, record);
  }
  if (input.canonical_order.order_status !== 'UNRESOLVED'
      || input.canonical_order.transactions.length !== recordsBySignature.size
      || input.canonical_order.transactions.some(item => !recordsBySignature.has(item.transaction_identity.signature))) {
    fail('canonical_order_source_mismatch', 'unresolved canonical-order records do not match source evidence');
  }
  const ordered = input.canonical_order.transactions.map(item => ({
    coordinate: null,
    orderIdentity: item.transaction_identity,
    record: recordsBySignature.get(item.transaction_identity.signature),
  }));
  for (const item of ordered) if (!sameIdentity(item.orderIdentity, item.record.effect.transaction_identity)) {
    fail('order_source_mismatch', 'canonical order transaction identity does not match source evidence');
  }

  const findings = new Map();
  addFinding(findings, 'TARGET_ACCOUNT_COVERAGE_NOT_ATTESTED');
  addFinding(findings, 'TARGET_ACCOUNT_AUTHORITY_NOT_ESTABLISHED');
  const candidates = new Map();
  for (const item of ordered) {
    const { transaction, effect } = item.record;
    const identity = transactionIdentity(transaction);
    const pre = rowMap(transaction, 'pre');
    const post = rowMap(transaction, 'post');
    const targetAccounts = [...new Set([...pre.values(), ...post.values()]
      .filter(row => row.mint === input.target_mint).map(row => row.account))];
    for (const account of targetAccounts) {
      const before = pre.get(account);
      const after = post.get(account);
      const owners = [before?.owner, after?.owner].filter(owner => owner !== undefined);
      const state = candidates.get(account) ?? { owners: new Set(), programs: new Set(), rows: [] };
      owners.forEach(owner => state.owners.add(owner));
      for (const row of [before, after].filter(Boolean)) state.programs.add(row.token_program);
      state.rows.push({ item, before, after });
      candidates.set(account, state);
      const sourceIds = effectIdsForAccount(effect, account);
      if (owners.includes(null)) addFinding(findings, 'TARGET_ACCOUNT_OWNER_UNRESOLVED', identity, account, sourceIds);
      if ((before === undefined && !hasLifecycleEffect(effect, account, 'account_creation'))
          || (after === undefined && !hasLifecycleEffect(effect, account, 'account_closure'))) {
        addFinding(findings, 'TARGET_ACCOUNT_BALANCE_SIDE_MISSING', identity, account, sourceIds);
      }
    }
    const targetQuantityEffects = effect.established_effects.filter(entry => entry.mint === input.target_mint
      && entry.signed_raw_quantity !== null && entry.signed_raw_quantity !== '0');
    if (targetQuantityEffects.length !== 0) addFinding(findings, 'TARGET_EFFECT_CAUSAL_SEMANTICS_UNRESOLVED', identity, null,
      targetQuantityEffects.map(entry => entry.effect_id));
  }

  const accounts = [];
  for (const account of [...candidates.keys()].sort()) {
    const state = candidates.get(account);
    const knownOwners = [...state.owners].filter(owner => owner !== null);
    const walletOwned = state.owners.size === 1 && knownOwners.length === 1 && knownOwners[0] === input.wallet;
    if (!walletOwned) {
      if (state.owners.has(input.wallet)) addFinding(findings, 'TARGET_ACCOUNT_IDENTITY_CONTRADICTORY', null, account);
      continue;
    }
    if (state.programs.size !== 1) {
      addFinding(findings, 'TARGET_ACCOUNT_IDENTITY_CONTRADICTORY', null, account);
      continue;
    }
    const observations = state.rows.map(({ item, before, after }) => {
      const creationZero = before === undefined
        && hasLifecycleEffect(item.record.effect, account, 'account_creation');
      const closureZero = after === undefined
        && hasLifecycleEffect(item.record.effect, account, 'account_closure');
      return {
        canonical_transaction_coordinate: item.coordinate,
        transaction_identity: item.orderIdentity,
        pre_raw_amount: creationZero ? '0' : before?.raw_amount ?? null,
        post_raw_amount: closureZero ? '0' : after?.raw_amount ?? null,
        pre_evidence_status: creationZero ? 'EXACT_LIFECYCLE_ZERO' : before === undefined ? 'MISSING' : 'EXACT',
        post_evidence_status: closureZero ? 'EXACT_LIFECYCLE_ZERO' : after === undefined ? 'MISSING' : 'EXACT',
        source_effect_ids: effectIdsForAccount(item.record.effect, account),
      };
    });
    const lifecycleEffects = state.rows.flatMap(({ item }) => item.record.effect.established_effects
      .filter(effect => effect.account === account && ['account_creation', 'account_closure'].includes(effect.effect_kind)));
    const creations = lifecycleEffects.filter(effect => effect.effect_kind === 'account_creation');
    const closures = lifecycleEffects.filter(effect => effect.effect_kind === 'account_closure');
    const closureAuthorities = [...new Set(closures.map(effect => effect.authority))];
    accounts.push({
      account,
      owner: input.wallet,
      owner_status: 'WALLET_OWNED',
      authority: closureAuthorities.length === 1 ? closureAuthorities[0] : null,
      authority_status: closureAuthorities.length === 1 ? 'ESTABLISHED_FOR_CLOSURE_ONLY' : 'UNKNOWN',
      delegate: null,
      delegate_status: 'UNKNOWN',
      token_program: [...state.programs][0],
      token_program_status: 'ESTABLISHED',
      creation_status: creations.length === 0 ? 'UNKNOWN' : 'ESTABLISHED',
      closure_status: closures.length === 0 ? 'UNKNOWN' : 'ESTABLISHED',
      creation_effect_ids: creations.map(effect => effect.effect_id).sort(),
      closure_authority: closureAuthorities.length === 1 ? closureAuthorities[0] : null,
      closure_effect_ids: closures.map(effect => effect.effect_id).sort(),
      observations,
    });
  }

  const transactionBoundaries = [];
  const openingBoundary = boundary({
    kind: 'OPENING_PRE', coordinate: null, identity: null, observed: { count: 0, raw: null },
  });
  const endingBoundary = boundary({
    kind: 'ENDING_POST', coordinate: null, identity: null, observed: { count: 0, raw: null },
  });

  const result = cloneAndFreeze({
    target_account_boundary_version: TARGET_ACCOUNT_BOUNDARY_VERSION_V1_3,
    boundary_authority_profile: TARGET_ACCOUNT_BOUNDARY_PROFILE_V1_3,
    analyzed_wallet: input.wallet,
    target_mint: input.target_mint,
    canonical_order_evidence_identity: null,
    account_coverage_status: 'UNRESOLVED',
    account_coverage_evidence_identity: null,
    reason_codes: REASON_CODES,
    findings: [...findings.values()].sort(compareFindings),
    accounts,
    transaction_boundaries: transactionBoundaries,
    opening_boundary: openingBoundary,
    ending_boundary: endingBoundary,
  });
  validateTargetAccountBoundaryStructureV13(result);
  return result;
}

function validateTransactionIdentity(value, context, nullable = false) {
  if (nullable && value === null) return;
  assertExactFields(value, TRANSACTION_IDENTITY_FIELDS, context);
  if (!isSolanaSignatureV1(value.signature) || !safeNonnegative(value.slot) || !safeNonnegative(value.block_time)
      || !['legacy', 0].includes(value.transaction_version)) fail('invalid_transaction_identity', `${context} is invalid`);
}
function validateIds(value, field) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string'
      || !/^(?:effect|residual)-[0-9a-f]{64}$/.test(id))) fail('invalid_effect_reference', `${field} is invalid`);
  if (new Set(value).size !== value.length || value.some((id, index) => index > 0 && value[index - 1] >= id)) {
    fail('invalid_effect_reference', `${field} must be sorted and unique`);
  }
}
function validateBoundary(value, context) {
  assertExactFields(value, BOUNDARY_FIELDS, context);
  if (!['OPENING_PRE', 'ENDING_POST', 'TRANSACTION_PRE', 'TRANSACTION_POST'].includes(value.boundary_kind)
      || (value.canonical_transaction_coordinate !== null && !safeNonnegative(value.canonical_transaction_coordinate))) {
    fail('invalid_boundary', `${context} coordinate is invalid`);
  }
  validateTransactionIdentity(value.transaction_identity, `${context}.transaction_identity`, true);
  if (!safeNonnegative(value.observed_wallet_owned_account_count)) fail('invalid_boundary', `${context} count is invalid`);
  exactRaw(value.observed_wallet_owned_raw_quantity, `${context}.observed_wallet_owned_raw_quantity`, true);
  if (value.observed_quantity_status !== (value.observed_wallet_owned_raw_quantity === null ? 'UNAVAILABLE' : 'EXACT_PARTIAL_OBSERVATION')
      || value.aggregate_raw_quantity !== null || value.aggregate_inventory_status !== 'UNRESOLVED_ACCOUNT_COVERAGE'
      || value.zero_status !== 'UNRESOLVED' || value.economic_continuity_status !== 'UNRESOLVED'
      || value.basis_reference_identity !== null
      || value.opening_state !== (value.boundary_kind === 'OPENING_PRE' ? 'UNRESOLVED' : null)
      || value.valid_for_closed !== false || value.valid_for_open !== false
      || value.valid_for_open_realized_partial !== false) {
    fail('unsupported_boundary_authority', `${context} fabricates completeness or state authority`);
  }
}

function expectedBoundaryObservation(accounts, coordinate, side) {
  const observations = accounts.flatMap(account => account.observations
    .filter(observation => observation.canonical_transaction_coordinate === coordinate));
  if (observations.length === 0) return { count: 0, raw: null };
  const field = side === 'pre' ? 'pre_raw_amount' : 'post_raw_amount';
  if (observations.some(observation => observation[field] === null)) {
    return { count: observations.length, raw: null };
  }
  return {
    count: observations.length,
    raw: observations.reduce((sum, observation) => sum + BigInt(observation[field]), 0n).toString(),
  };
}

function validateBoundaryObservation(value, expected, context) {
  if (value.observed_wallet_owned_account_count !== expected.count
      || value.observed_wallet_owned_raw_quantity !== expected.raw) {
    fail('boundary_observation_mismatch', `${context} does not match admitted account observations`);
  }
}

export function validateTargetAccountBoundaryStructureV13(value) {
  assertExactFields(value, TOP_FIELDS, 'target_account_boundary');
  if (value.target_account_boundary_version !== TARGET_ACCOUNT_BOUNDARY_VERSION_V1_3
      || value.boundary_authority_profile !== TARGET_ACCOUNT_BOUNDARY_PROFILE_V1_3) {
    fail('unsupported_boundary_version', 'target account boundary version is unsupported');
  }
  publicKey(value.analyzed_wallet, 'analyzed_wallet');
  publicKey(value.target_mint, 'target_mint');
  if (value.canonical_order_evidence_identity !== null
      || value.account_coverage_status !== 'UNRESOLVED' || value.account_coverage_evidence_identity !== null
      || canonicalJson(value.reason_codes) !== canonicalJson(REASON_CODES)
      || !Array.isArray(value.findings) || !Array.isArray(value.accounts)
      || !Array.isArray(value.transaction_boundaries)) {
    fail('unsupported_boundary_authority', 'Slice 3A cannot assert complete account coverage');
  }
  value.findings.forEach((finding, index) => {
    assertExactFields(finding, FINDING_FIELDS, `findings.${index}`);
    if (!FINDING_CODES.has(finding.finding_code)) fail('invalid_boundary_finding', 'finding code is unsupported');
    validateTransactionIdentity(finding.transaction_identity, `findings.${index}.transaction_identity`, true);
    publicKey(finding.account, `findings.${index}.account`, true);
    validateIds(finding.source_effect_ids, `findings.${index}.source_effect_ids`);
    if (finding.finding_id !== findingId(finding)) fail('invalid_boundary_finding', 'finding identity is invalid');
    if (index > 0 && compareFindings(value.findings[index - 1], finding) >= 0) fail('invalid_boundary_finding', 'findings are not canonical');
  });
  if (!value.findings.some(finding => finding.finding_code === 'TARGET_ACCOUNT_COVERAGE_NOT_ATTESTED')) {
    fail('unsupported_boundary_authority', 'missing account-coverage finding');
  }
  value.accounts.forEach((account, index) => {
    assertExactFields(account, ACCOUNT_FIELDS, `accounts.${index}`);
    publicKey(account.account, `accounts.${index}.account`);
    if (account.owner !== value.analyzed_wallet || account.owner_status !== 'WALLET_OWNED') fail('invalid_account_owner', 'admitted account is not explicitly wallet-owned');
    publicKey(account.authority, `accounts.${index}.authority`, true);
    if (!['UNKNOWN', 'ESTABLISHED_FOR_CLOSURE_ONLY'].includes(account.authority_status)
        || (account.authority_status === 'UNKNOWN') !== (account.authority === null)
        || account.delegate !== null || account.delegate_status !== 'UNKNOWN') {
      fail('invalid_account_authority', 'account authority/delegate state is invalid');
    }
    publicKey(account.token_program, `accounts.${index}.token_program`);
    if (account.token_program_status !== 'ESTABLISHED'
        || !['UNKNOWN', 'ESTABLISHED'].includes(account.creation_status)
        || !['UNKNOWN', 'ESTABLISHED'].includes(account.closure_status)) fail('invalid_account_lifecycle', 'account lifecycle is invalid');
    validateIds(account.creation_effect_ids, `accounts.${index}.creation_effect_ids`);
    publicKey(account.closure_authority, `accounts.${index}.closure_authority`, true);
    validateIds(account.closure_effect_ids, `accounts.${index}.closure_effect_ids`);
    if ((account.creation_status === 'ESTABLISHED') !== (account.creation_effect_ids.length !== 0)
        || (account.closure_status === 'ESTABLISHED') !== (account.closure_effect_ids.length !== 0)
        || (account.authority_status === 'ESTABLISHED_FOR_CLOSURE_ONLY') !== (account.closure_authority !== null)
        || account.authority !== account.closure_authority) fail('invalid_account_lifecycle', 'closure authority is inconsistent');
    if (!Array.isArray(account.observations)) fail('invalid_account_observation', 'observations must be an array');
    account.observations.forEach((observation, observationIndex) => {
      assertExactFields(observation, OBSERVATION_FIELDS, `accounts.${index}.observations.${observationIndex}`);
      if (observation.canonical_transaction_coordinate !== null) {
        fail('invalid_account_observation', 'unresolved chronology cannot carry transaction coordinates');
      }
      validateTransactionIdentity(observation.transaction_identity, `accounts.${index}.observations.${observationIndex}.transaction_identity`);
      exactRaw(observation.pre_raw_amount, 'pre_raw_amount', true);
      exactRaw(observation.post_raw_amount, 'post_raw_amount', true);
      const validSide = (rawAmount, evidenceStatus, lifecycleEffectIds) => {
        if (evidenceStatus === (rawAmount === null ? 'MISSING' : 'EXACT')) return true;
        return rawAmount === '0' && evidenceStatus === 'EXACT_LIFECYCLE_ZERO'
          && lifecycleEffectIds.some(effectId => observation.source_effect_ids.includes(effectId));
      };
      if (!validSide(observation.pre_raw_amount, observation.pre_evidence_status, account.creation_effect_ids)
          || !validSide(observation.post_raw_amount, observation.post_evidence_status, account.closure_effect_ids)) {
        fail('invalid_account_observation', 'balance-side status is invalid');
      }
      validateIds(observation.source_effect_ids, 'source_effect_ids');
      if (observationIndex > 0 && compareIdentity(
        account.observations[observationIndex - 1].transaction_identity,
        observation.transaction_identity,
      ) >= 0) fail('invalid_account_observation', 'observations are not in deterministic unresolved storage order');
    });
    if (index > 0 && value.accounts[index - 1].account >= account.account) fail('noncanonical_account_order', 'accounts are not canonical');
  });
  value.transaction_boundaries.forEach((item, index) => {
    assertExactFields(item, TRANSACTION_BOUNDARY_FIELDS, `transaction_boundaries.${index}`);
    if (item.canonical_transaction_coordinate !== index) fail('invalid_boundary', 'transaction boundary coordinates must be dense');
    validateTransactionIdentity(item.transaction_identity, `transaction_boundaries.${index}.transaction_identity`);
    validateBoundary(item.pre_boundary, `transaction_boundaries.${index}.pre_boundary`);
    validateBoundary(item.post_boundary, `transaction_boundaries.${index}.post_boundary`);
    if (item.pre_boundary.boundary_kind !== 'TRANSACTION_PRE' || item.post_boundary.boundary_kind !== 'TRANSACTION_POST'
        || item.pre_boundary.canonical_transaction_coordinate !== index
        || item.post_boundary.canonical_transaction_coordinate !== index
        || !sameIdentity(item.pre_boundary.transaction_identity, item.transaction_identity)
        || !sameIdentity(item.post_boundary.transaction_identity, item.transaction_identity)) fail('invalid_boundary', 'transaction boundary identity is inconsistent');
    validateBoundaryObservation(
      item.pre_boundary,
      expectedBoundaryObservation(value.accounts, index, 'pre'),
      `transaction_boundaries.${index}.pre_boundary`,
    );
    validateBoundaryObservation(
      item.post_boundary,
      expectedBoundaryObservation(value.accounts, index, 'post'),
      `transaction_boundaries.${index}.post_boundary`,
    );
  });
  if (value.transaction_boundaries.length !== 0) {
    fail('unsupported_boundary_authority', 'Slice 3A cannot issue chronology-bound transaction boundaries');
  }
  validateBoundary(value.opening_boundary, 'opening_boundary');
  validateBoundary(value.ending_boundary, 'ending_boundary');
  if (value.opening_boundary.boundary_kind !== 'OPENING_PRE' || value.ending_boundary.boundary_kind !== 'ENDING_POST') {
    fail('invalid_boundary', 'opening/ending boundary kinds are invalid');
  }
  if (value.opening_boundary.canonical_transaction_coordinate !== null
      || value.opening_boundary.transaction_identity !== null
      || value.ending_boundary.canonical_transaction_coordinate !== null
      || value.ending_boundary.transaction_identity !== null) {
    fail('unsupported_boundary_authority', 'Slice 3A endpoints cannot carry chronology identity');
  }
  const first = value.transaction_boundaries[0];
  const last = value.transaction_boundaries.at(-1);
  if (first !== undefined && (!sameIdentity(value.opening_boundary.transaction_identity, first.transaction_identity)
      || value.opening_boundary.canonical_transaction_coordinate !== 0)) fail('invalid_boundary', 'opening boundary is not the first pre-state');
  if (last !== undefined && (!sameIdentity(value.ending_boundary.transaction_identity, last.transaction_identity)
      || value.ending_boundary.canonical_transaction_coordinate !== last.canonical_transaction_coordinate)) fail('invalid_boundary', 'ending boundary is not the last post-state');
  validateBoundaryObservation(
    value.opening_boundary,
    first === undefined ? { count: 0, raw: null } : expectedBoundaryObservation(value.accounts, 0, 'pre'),
    'opening_boundary',
  );
  validateBoundaryObservation(
    value.ending_boundary,
    last === undefined ? { count: 0, raw: null }
      : expectedBoundaryObservation(value.accounts, last.canonical_transaction_coordinate, 'post'),
    'ending_boundary',
  );
  return true;
}

export function validateSourceBoundTargetAccountBoundaryV13(input) {
  assertExactFields(input, ['wallet', 'target_mint', 'canonical_order', 'transaction_records', 'boundary'],
    'source_bound_target_account_boundary_input');
  const expected = buildTargetAccountBoundaryV13({
    wallet: input.wallet,
    target_mint: input.target_mint,
    canonical_order: input.canonical_order,
    transaction_records: input.transaction_records,
  });
  if (canonicalJson(input.boundary) !== canonicalJson(expected)) {
    fail('target_account_boundary_source_mismatch', 'target account boundary does not match its bound evidence');
  }
  return true;
}
