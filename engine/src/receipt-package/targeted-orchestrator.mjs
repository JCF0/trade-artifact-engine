import { buildPositionLedger } from '../ledger/position-ledger.mjs';
import { generateReceiptCandidates } from '../ledger/receipt-candidates.mjs';
import { promoteReceiptCandidates } from '../ledger/receipt-promotion.mjs';
import { verifyReceipt } from '../ledger/receipt-verifier.mjs';
import { buildReceiptPackageV1 } from './builder.mjs';
import {
  ARCHIVE_FIELDS,
  ARCHIVE_RECORD_VERSION,
  CANONICAL_RECEIPT_FIELDS,
  ECONOMICS_FIELDS,
  ECONOMICS_VERSION,
  RECEIPT_HASH_PATTERN,
} from './schema.mjs';
import {
  RECEIPT_PACKAGE_PROFILES_V1,
} from './profiles.mjs';
import {
  serializeReceiptPackageV1,
  sha256Bytes,
} from './serialize.mjs';
import { validateReceiptPackageV1 } from './validator.mjs';
import {
  TargetedReceiptOrchestrationError,
  orchestrationFail,
} from './orchestration-errors.mjs';

export { TargetedReceiptOrchestrationError } from './orchestration-errors.mjs';

export const ORCHESTRATION_VERSION = 'targeted_receipt_orchestration_v1';
export const TARGETED_RECEIPT_PACKAGE_PROFILES_V1 = Object.freeze({
  ...RECEIPT_PACKAGE_PROFILES_V1,
  accounting_method_version: 'weighted_average_position_accounting_v1',
});

const TARGET_FIELDS = Object.freeze([
  'wallet',
  'token_mint',
  'receipt_type',
  'segment_index',
]);
const EVENT_FIELDS = Object.freeze([
  'wallet',
  'timestamp',
  'tx_hash',
  'source',
  'token_in_mint',
  'token_in_amount',
  'token_in_decimals',
  'token_out_mint',
  'token_out_amount',
  'token_out_decimals',
  'extraction_method',
  'raw_index',
]);
const REQUEST_FIELDS = Object.freeze([
  'normalizedEvents',
  'inputStatus',
  'target',
  'profiles',
  'mode',
]);
const STORE_METHODS = Object.freeze(['inspect', 'stage', 'validateStage', 'commit']);
const TARGET_TYPES = new Set(['closed_position', 'realized_partial', 'open_snapshot']);

function descriptors(value, code, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    orchestrationFail(code, `${context} must be an ordinary object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    orchestrationFail(code, `${context} must not contain symbol keys`);
  }
  const result = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(result)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      orchestrationFail(code, `${context} must contain only enumerable data properties`, { field: key });
    }
  }
  return result;
}

function dataObject(value, fields, code, context, optional = []) {
  const result = descriptors(value, code, context);
  const allowed = new Set([...fields, ...optional]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) orchestrationFail(code, `${context} contains an unknown field`, { field: key });
  }
  for (const key of fields) {
    if (!Object.hasOwn(result, key)) orchestrationFail(code, `${context} is missing a required field`, { field: key });
  }
  return Object.fromEntries(Object.entries(result).map(([key, descriptor]) => [key, descriptor.value]));
}

function nonemptyString(value, code, field) {
  if (typeof value !== 'string' || value.length === 0) {
    orchestrationFail(code, `${field} must be a non-empty string`, { field });
  }
}

function validateTarget(value) {
  const target = dataObject(
    value,
    TARGET_FIELDS,
    'invalid_orchestration_request',
    'target',
    ['expected_receipt_hash'],
  );
  nonemptyString(target.wallet, 'invalid_orchestration_request', 'target.wallet');
  nonemptyString(target.token_mint, 'invalid_orchestration_request', 'target.token_mint');
  if (!TARGET_TYPES.has(target.receipt_type)) {
    orchestrationFail('invalid_orchestration_request', 'target.receipt_type is unsupported');
  }
  if (!Number.isSafeInteger(target.segment_index) || target.segment_index < 0) {
    orchestrationFail('invalid_orchestration_request', 'target.segment_index must be a non-negative integer');
  }
  if (Object.hasOwn(target, 'expected_receipt_hash')
      && (typeof target.expected_receipt_hash !== 'string'
        || !RECEIPT_HASH_PATTERN.test(target.expected_receipt_hash))) {
    orchestrationFail('invalid_orchestration_request', 'target.expected_receipt_hash must be a lowercase SHA-256 digest');
  }
  return target;
}

function statusBoundary(value) {
  const status = descriptors(value, 'invalid_orchestration_request', 'inputStatus');
  for (const required of ['acquisition_complete', 'normalization_complete']) {
    if (!Object.hasOwn(status, required) || typeof status[required].value !== 'boolean') {
      orchestrationFail('invalid_orchestration_request', `inputStatus.${required} must be boolean`);
    }
  }
  if (!status.acquisition_complete.value) {
    orchestrationFail('incomplete_acquisition_input', 'acquisition input is not complete');
  }
  if (!status.normalization_complete.value) {
    orchestrationFail('incomplete_normalization_input', 'normalization input is not complete');
  }
  for (const [key, descriptor] of Object.entries(status)) {
    if (key === 'acquisition_complete' || key === 'normalization_complete') continue;
    if (typeof descriptor.value !== 'boolean') {
      orchestrationFail('invalid_orchestration_request', 'input completeness flags must be boolean', { field: key });
    }
    const normalized = key.toLowerCase();
    const incompleteWhenTrue = /(truncat|capp|(?:^|_)cap(?:ped|_reached)?(?:_|$)|partial|uncertain|has_more|limit_reached|max(?:imum)?_.*reached|incomplete|unexhausted|not_(?:complete|exhausted|certain))/.test(normalized);
    const incompleteWhenFalse = /(?:^|_)(?:complete|exhausted|certain)$/.test(normalized);
    if (incompleteWhenTrue) {
      if (descriptor.value) {
        const code = normalized.includes('normalization')
          ? 'incomplete_normalization_input'
          : 'incomplete_acquisition_input';
        orchestrationFail(code, 'input status marks the supplied evidence as incomplete', { field: key });
      }
      continue;
    }
    if (!incompleteWhenFalse) {
      orchestrationFail('invalid_orchestration_request', 'inputStatus contains an unknown field', { field: key });
    }
    if (!descriptor.value) {
      const code = normalized.includes('normalization')
        ? 'incomplete_normalization_input'
        : 'incomplete_acquisition_input';
      orchestrationFail(code, 'input status marks the supplied evidence as incomplete', { field: key });
    }
  }
}

function validateProfiles(value) {
  const profiles = dataObject(
    value,
    Object.keys(TARGETED_RECEIPT_PACKAGE_PROFILES_V1),
    'invalid_orchestration_request',
    'profiles',
  );
  for (const [field, expected] of Object.entries(TARGETED_RECEIPT_PACKAGE_PROFILES_V1)) {
    if (profiles[field] !== expected) {
      orchestrationFail('invalid_orchestration_request', 'profiles must use the frozen package identifiers', { field });
    }
  }
  return profiles;
}

function validateEvent(value, index, target, previous, seenTxHashes, seenRawIndexes) {
  const event = dataObject(value, EVENT_FIELDS, 'invalid_normalized_event', 'normalized event');
  for (const field of ['wallet', 'tx_hash', 'source', 'token_in_mint', 'token_out_mint', 'extraction_method']) {
    nonemptyString(event[field], 'invalid_normalized_event', `normalizedEvents[${index}].${field}`);
  }
  if (event.wallet !== target.wallet) {
    orchestrationFail('invalid_normalized_event', 'normalized event wallet does not match the target wallet', { event_index: index });
  }
  if (event.token_in_mint === event.token_out_mint) {
    orchestrationFail('invalid_normalized_event', 'normalized event token mints must differ', { event_index: index });
  }
  for (const field of ['timestamp', 'raw_index', 'token_in_decimals', 'token_out_decimals']) {
    if (!Number.isSafeInteger(event[field]) || event[field] < 0) {
      orchestrationFail('invalid_normalized_event', 'normalized event integer field is invalid', { event_index: index, field });
    }
  }
  for (const field of ['token_in_amount', 'token_out_amount']) {
    if (typeof event[field] !== 'number' || !Number.isFinite(event[field])
        || event[field] <= 0 || Object.is(event[field], -0)) {
      orchestrationFail('invalid_normalized_event', 'normalized event amount must be finite and positive', { event_index: index, field });
    }
  }
  if (event.token_in_decimals > 255 || event.token_out_decimals > 255) {
    orchestrationFail('invalid_normalized_event', 'normalized event decimals are out of range', { event_index: index });
  }
  if (seenTxHashes.has(event.tx_hash) || seenRawIndexes.has(event.raw_index)) {
    orchestrationFail('invalid_normalized_event', 'normalized events contain a duplicate transaction or raw index', { event_index: index });
  }
  if (previous && (event.timestamp < previous.timestamp
      || (event.timestamp === previous.timestamp && event.raw_index <= previous.raw_index))) {
    orchestrationFail('invalid_normalized_event', 'normalized events must be in timestamp/raw-index order', { event_index: index });
  }
  seenTxHashes.add(event.tx_hash);
  seenRawIndexes.add(event.raw_index);
  return event;
}

function validateEvents(value, target) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    orchestrationFail('invalid_normalized_event', 'normalizedEvents must be an array');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    orchestrationFail('invalid_normalized_event', 'normalizedEvents must not contain symbol fields');
  }
  const arrayDescriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(arrayDescriptors).filter(([key]) => key !== 'length');
  if (entries.length !== value.length
      || entries.some(([key, descriptor], index) => key !== String(index)
        || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    orchestrationFail('invalid_normalized_event', 'normalizedEvents must be a dense data-property array');
  }
  const events = [];
  const seenTxHashes = new Set();
  const seenRawIndexes = new Set();
  for (const [indexText, descriptor] of entries) {
    const index = Number(indexText);
    events.push(validateEvent(
      descriptor.value,
      index,
      target,
      events.at(-1),
      seenTxHashes,
      seenRawIndexes,
    ));
  }
  return structuredClone(events);
}

function validateRequest(value) {
  const request = dataObject(
    value,
    REQUEST_FIELDS.slice(0, -1),
    'invalid_orchestration_request',
    'orchestration request',
    ['mode'],
  );
  const mode = Object.hasOwn(request, 'mode') ? request.mode : 'dry_run';
  if (mode !== 'dry_run' && mode !== 'commit') {
    orchestrationFail('invalid_orchestration_request', 'mode must be dry_run or commit');
  }
  const target = validateTarget(request.target);
  statusBoundary(request.inputStatus);
  const profiles = validateProfiles(request.profiles);
  const normalizedEvents = validateEvents(request.normalizedEvents, target);
  return { mode, target, profiles, normalizedEvents };
}

function selectedTarget(target) {
  return Object.fromEntries(TARGET_FIELDS.map(field => [field, target[field]]));
}

export function selectTargetedReceiptCandidateV1(candidates, target) {
  if (target.receipt_type !== 'closed_position') {
    orchestrationFail('target_not_eligible', 'the initial orchestration contract accepts only closed-position targets');
  }
  const matches = candidates.filter(candidate => (
    candidate.wallet === target.wallet
    && candidate.token_mint === target.token_mint
    && candidate.candidate_type === target.receipt_type
    && candidate.segment_index === target.segment_index
  ));
  if (matches.length === 0) orchestrationFail('target_not_found', 'no receipt candidate matches the explicit target');
  if (matches.length !== 1) orchestrationFail('target_ambiguous', 'more than one receipt candidate matches the explicit target');
  const candidate = matches[0];
  if (candidate.candidate_type !== 'closed_position'
      || candidate.status !== 'closed'
      || !candidate.eligible_for_verified_receipt
      || !candidate.eligible_for_closed_position_receipt) {
    orchestrationFail('target_not_eligible', 'the selected candidate is not eligible for a verified closed-position receipt');
  }
  return candidate;
}

function promoteSelected(candidate) {
  try {
    const receipts = promoteReceiptCandidates([candidate]);
    if (receipts.length !== 1) throw new Error('promotion cardinality mismatch');
    return receipts[0];
  } catch {
    orchestrationFail('canonical_promotion_failed', 'selected candidate promotion failed');
  }
}

function verifySelected(receipt) {
  let result;
  try {
    result = verifyReceipt(receipt);
  } catch {
    orchestrationFail('verification_failed', 'selected canonical receipt verification failed');
  }
  if (receipt.receipt_type !== 'closed_position'
      || receipt.position_status !== 'closed'
      || receipt.verification_status !== 'verified'
      || result.hash_valid !== true
      || result.schema_valid !== true
      || result.consistency_valid !== true
      || result.pass !== true
      || !Array.isArray(result.rule_violations)
      || result.rule_violations.length !== 0) {
    orchestrationFail('verification_failed', 'selected canonical receipt failed a deterministic verification gate');
  }
  return result;
}

function project(value, fields) {
  return Object.fromEntries(fields.map(field => [field, structuredClone(value[field])]));
}

function buildPackage(receipt, verification, profiles) {
  const canonical = project(receipt, CANONICAL_RECEIPT_FIELDS);
  const archiveRecord = {
    archive_record_version: ARCHIVE_RECORD_VERSION,
    ...project(canonical, ARCHIVE_FIELDS),
  };
  const economicsRecord = {
    economics_version: ECONOMICS_VERSION,
    receipt_hash: canonical.receipt_hash,
    receipt_version: canonical.receipt_version,
    receipt_type: canonical.receipt_type,
    ...project(canonical, ECONOMICS_FIELDS),
  };
  let receiptPackage;
  try {
    receiptPackage = buildReceiptPackageV1({
      canonicalReceipt: canonical,
      verificationResult: verification,
      archiveRecord,
      economicsRecord,
      inputCommitment: profiles,
    });
  } catch {
    orchestrationFail('package_build_failed', 'receipt package construction failed');
  }
  try {
    validateReceiptPackageV1(receiptPackage);
  } catch {
    orchestrationFail('package_validation_failed', 'completed receipt package validation failed');
  }
  return receiptPackage;
}

function packageIdentity(receiptPackage) {
  const serialized = serializeReceiptPackageV1(receiptPackage);
  const memberHashes = Object.fromEntries(
    Object.entries(serialized)
      .map(([name, bytes]) => [name, sha256Bytes(bytes)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    packageDigest: receiptPackage['manifest.json'].package_digest,
    memberHashes,
  };
}

function resultFor(status, target, receipt, verification, identity) {
  return Object.freeze({
    orchestration_version: ORCHESTRATION_VERSION,
    status,
    target: Object.freeze(selectedTarget(target)),
    receipt_hash: receipt.receipt_hash,
    receipt_id: receipt.receipt_id,
    package_digest: identity.packageDigest,
    member_hashes: Object.freeze({ ...identity.memberHashes }),
    verification: Object.freeze({
      hash_valid: verification.hash_valid,
      schema_valid: verification.schema_valid,
      consistency_valid: verification.consistency_valid,
      pass: verification.pass,
      rule_violation_count: verification.rule_violations.length,
    }),
  });
}

function validateStore(packageStore) {
  if (packageStore === undefined) {
    orchestrationFail('package_store_required', 'commit mode requires an injected package store');
  }
  const store = descriptors(packageStore, 'package_store_required', 'packageStore');
  for (const method of STORE_METHODS) {
    if (!Object.hasOwn(store, method) || typeof store[method].value !== 'function') {
      orchestrationFail('package_store_required', 'packageStore does not implement the Slice 2 interface', { method });
    }
  }
  return Object.fromEntries(STORE_METHODS.map(method => [method, store[method].value.bind(packageStore)]));
}

function mapStoreFailure(error, fallback = 'capability_denied') {
  if (error instanceof TargetedReceiptOrchestrationError) throw error;
  if (error?.code === 'package_store_conflict') {
    orchestrationFail('package_store_conflict', 'a different package is committed for the selected receipt hash');
  }
  if (error?.code === 'invalid_receipt_package' || error?.code === 'staging_validation_failed') {
    orchestrationFail('package_validation_failed', 'the package store rejected staged package validation');
  }
  orchestrationFail(fallback, 'the injected package-store capability denied the requested operation', {
    store_error_code: typeof error?.code === 'string' ? error.code : 'unknown_store_error',
  });
}

async function commitPackage(packageStore, receiptPackage, identity) {
  const store = validateStore(packageStore);
  let staged;
  try {
    staged = await store.stage(receiptPackage);
    await store.validateStage(staged.stagingHandle);
  } catch (error) {
    mapStoreFailure(error);
  }
  try {
    const committed = await store.commit(staged.stagingHandle, {
      expectedPackageDigest: identity.packageDigest,
    });
    if (committed?.status !== 'committed' && committed?.status !== 'unchanged') {
      orchestrationFail('capability_denied', 'packageStore.commit returned an unsupported status');
    }
    return committed.status;
  } catch (error) {
    if (error?.code !== 'commit_unknown') mapStoreFailure(error);
    let inspection;
    try {
      inspection = await store.inspect(receiptPackage['manifest.json'].receipt_hash);
    } catch {
      orchestrationFail('commit_unknown', 'package commit could not be reconciled by inspection');
    }
    if (inspection?.status === 'committed'
        && inspection.package_digest === identity.packageDigest) return 'committed';
    if (inspection?.status === 'committed') {
      orchestrationFail('package_store_conflict', 'commit reconciliation found a different package digest');
    }
    orchestrationFail('commit_unknown', 'package commit remains unknown after inspection');
  }
}

function validateLogger(logger) {
  if (logger === undefined) return undefined;
  const value = descriptors(logger, 'capability_denied', 'logger');
  if (!Object.hasOwn(value, 'info') || typeof value.info.value !== 'function') {
    orchestrationFail('capability_denied', 'logger must expose an info data-property function');
  }
  return value.info.value.bind(logger);
}

function bestEffortLog(logger, result) {
  if (logger === undefined) return;
  try {
    const logging = logger('targeted_receipt_orchestration_completed', {
      orchestration_version: result.orchestration_version,
      status: result.status,
      receipt_hash: result.receipt_hash,
      package_digest: result.package_digest,
    });
    void Promise.resolve(logging).catch(() => {});
  } catch {}
}

export async function orchestrateTargetedReceiptPackageV1(request, ports = {}) {
  const validated = validateRequest(request);
  const portValues = dataObject(
    ports,
    [],
    'invalid_orchestration_request',
    'orchestration ports',
    ['packageStore', 'logger'],
  );
  const logger = validated.mode === 'commit' ? validateLogger(portValues.logger) : undefined;
  const ledger = buildPositionLedger(validated.normalizedEvents, {
    accountingMethodVersion: validated.profiles.accounting_method_version,
  });
  const candidates = generateReceiptCandidates(ledger, validated.target.wallet);
  const selected = selectTargetedReceiptCandidateV1(candidates, validated.target);
  const receipt = promoteSelected(selected);
  const verification = verifySelected(receipt);
  if (validated.target.expected_receipt_hash !== undefined
      && receipt.receipt_hash !== validated.target.expected_receipt_hash) {
    orchestrationFail('expected_receipt_hash_mismatch', 'selected receipt hash does not match the expected receipt hash', {
      expected_receipt_hash: validated.target.expected_receipt_hash,
      actual_receipt_hash: receipt.receipt_hash,
    });
  }
  const receiptPackage = buildPackage(receipt, verification, validated.profiles);
  const identity = packageIdentity(receiptPackage);
  const status = validated.mode === 'commit'
    ? await commitPackage(portValues.packageStore, receiptPackage, identity)
    : 'dry_run';
  const result = resultFor(status, validated.target, receipt, verification, identity);
  if (validated.mode === 'commit') bestEffortLog(logger, result);
  return result;
}
