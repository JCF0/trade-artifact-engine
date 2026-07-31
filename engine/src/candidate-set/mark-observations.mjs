import { assertPlainJsonValue, cloneAndFreeze, clonePlainData } from './plain-data.mjs';
import { compareCodeUnits } from './order.mjs';
import { fail } from './errors.mjs';
import { validateMarkObservationV1 as validateMarkObservationSchemaV1 } from './schema.mjs';
import { buildMarkObservationV1 as buildMarkObservationIdentityV1, computeMarkObservationDigest } from './identity.mjs';

export const MARK_UNAVAILABLE_REASON_CODES_V1 = Object.freeze([
  'mark_source_unavailable',
  'mark_stale',
  'mark_quote_mismatch',
  'mark_after_snapshot_boundary',
  'snapshot_boundary_unavailable',
]);

function compareNullableNumbers(left, right) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function validateSemantics(mark, markProfile) {
  if (typeof markProfile !== 'string' || markProfile.length === 0 || mark.source_profile !== markProfile) fail('mark_observation_invalid', 'mark source profile does not match the frozen profile');
  if (mark.observation_status === 'unavailable' && !MARK_UNAVAILABLE_REASON_CODES_V1.includes(mark.reason_code)) fail('mark_observation_invalid', 'unavailable mark reason code is unsupported');
  return true;
}

function observationKey(mark) {
  return `${mark.token_mint.length}:${mark.token_mint}${mark.quote_mint.length}:${mark.quote_mint}`;
}

export function compareMarkObservationsV1(left, right) {
  return compareCodeUnits(left.token_mint, right.token_mint)
    || compareCodeUnits(left.quote_mint, right.quote_mint)
    || compareNullableNumbers(left.source_slot, right.source_slot)
    || compareNullableNumbers(left.observed_at, right.observed_at)
    || compareCodeUnits(left.mark_observation_digest, right.mark_observation_digest);
}

export function buildMarkObservationV1(input) {
  const mark = buildMarkObservationIdentityV1(input);
  validateSemantics(mark, mark.source_profile);
  return mark;
}

export function canonicalizeMarkObservationsV1(markObservations, options = {}) {
  assertPlainJsonValue({ markObservations, options });
  if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'markProfile') || !Object.hasOwn(options, 'markProfile')) fail('mark_observation_invalid', 'mark observation options are invalid');
  const markProfile = options.markProfile;
  if (!Array.isArray(markObservations)) fail('mark_observation_invalid', 'mark observations must be an array');
  if (markObservations.length === 0) {
    if (markProfile !== null) fail('mark_observation_invalid', 'empty mark observations require a null mark profile');
    return cloneAndFreeze([]);
  }
  const detached = markObservations.map(mark => {
    validateMarkObservationSchemaV1(mark);
    validateSemantics(mark, markProfile);
    return clonePlainData(mark);
  });
  const digests = detached.map(item => item.mark_observation_digest);
  const ids = detached.map(item => item.mark_observation_id);
  const observationKeys = detached.map(observationKey);
  if (new Set(digests).size !== digests.length || new Set(ids).size !== ids.length || new Set(observationKeys).size !== observationKeys.length) fail('duplicate_mark_observation', 'mark observations must be unique by identity and token/quote pair');
  detached.sort(compareMarkObservationsV1);
  return cloneAndFreeze(detached);
}

export function validateMarkObservationsV1(markObservations, options = {}) {
  assertPlainJsonValue({ markObservations, options });
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('mark_observation_invalid', 'mark observation validation options are invalid');
  const expectedFields = ['markProfile','anchorSlot','anchorBlockTime'];
  const keys = Object.keys(options);
  if (keys.some(key => !expectedFields.includes(key)) || expectedFields.some(key => !Object.hasOwn(options, key))) fail('mark_observation_invalid', 'mark observation validation options are invalid');
  const markProfile = options.markProfile;
  const anchorSlot = options.anchorSlot;
  const anchorBlockTime = options.anchorBlockTime;
  if (!Array.isArray(markObservations) || !Number.isSafeInteger(anchorSlot) || anchorSlot < 0 || !Number.isSafeInteger(anchorBlockTime) || anchorBlockTime < 0) fail('mark_observation_invalid', 'mark observation validation input is invalid');
  if (markObservations.length === 0 && markProfile !== null) fail('mark_observation_invalid', 'empty mark observations require a null mark profile');
  const digests = new Set();
  const ids = new Set();
  const observationKeys = new Set();
  for (let index = 0; index < markObservations.length; index += 1) {
    const mark = markObservations[index];
    validateMarkObservationSchemaV1(mark, { verifyDigest: false });
    validateSemantics(mark, markProfile);
    if (computeMarkObservationDigest(mark) !== mark.mark_observation_digest) fail('mark_observation_digest_mismatch', 'mark observation digest mismatch');
    const key = observationKey(mark);
    if (digests.has(mark.mark_observation_digest) || ids.has(mark.mark_observation_id) || observationKeys.has(key)) fail('duplicate_mark_observation', 'mark observations must be unique by identity and token/quote pair');
    digests.add(mark.mark_observation_digest); ids.add(mark.mark_observation_id); observationKeys.add(key);
    if (index > 0 && compareMarkObservationsV1(markObservations[index - 1], mark) >= 0) fail('order_invalid', 'mark observations are not canonically ordered');
  }
  return true;
}
