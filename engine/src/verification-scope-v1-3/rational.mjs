import { assertExactFields, fail } from './contract.mjs';

const INTEGER_INPUT = /^-?(?:0|[1-9][0-9]*)$/;
const CANONICAL_NUMERATOR = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const CANONICAL_DENOMINATOR = /^[1-9][0-9]*$/;

function integer(value, field) {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !INTEGER_INPUT.test(value)) fail('invalid_rational_integer', `${field} must be an exact integer string or bigint`, { field });
  return BigInt(value);
}
function gcd(left, right) {
  left = left < 0n ? -left : left;
  right = right < 0n ? -right : right;
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}
function fromBigInts(numerator, denominator) {
  if (denominator === 0n) fail('rational_zero_denominator', 'rational denominator must not be zero');
  if (numerator === 0n) return Object.freeze({ numerator: '0', denominator: '1' });
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = gcd(numerator, denominator);
  return Object.freeze({ numerator: String(numerator / divisor), denominator: String(denominator / divisor) });
}
function parts(value) {
  validateRational(value);
  return [BigInt(value.numerator), BigInt(value.denominator)];
}

export function makeRational(numerator, denominator = '1') {
  return fromBigInts(integer(numerator, 'numerator'), integer(denominator, 'denominator'));
}

export function validateRational(value) {
  const descriptors = assertExactFields(value, ['numerator', 'denominator'], 'rational');
  const numerator = descriptors.numerator.value;
  const denominator = descriptors.denominator.value;
  if (typeof numerator !== 'string' || !CANONICAL_NUMERATOR.test(numerator)
      || typeof denominator !== 'string' || !CANONICAL_DENOMINATOR.test(denominator)) {
    fail('invalid_rational', 'rational integer strings are not canonical');
  }
  const normalized = fromBigInts(BigInt(numerator), BigInt(denominator));
  if (normalized.numerator !== numerator || normalized.denominator !== denominator) fail('noncanonical_rational', 'rational must be reduced with canonical sign and zero');
  return true;
}

export function addRational(left, right) {
  const [ln, ld] = parts(left); const [rn, rd] = parts(right);
  return fromBigInts(ln * rd + rn * ld, ld * rd);
}
export function subtractRational(left, right) {
  const [ln, ld] = parts(left); const [rn, rd] = parts(right);
  return fromBigInts(ln * rd - rn * ld, ld * rd);
}
export function multiplyRational(left, right) {
  const [ln, ld] = parts(left); const [rn, rd] = parts(right);
  return fromBigInts(ln * rn, ld * rd);
}
export function divideRational(left, right) {
  const [ln, ld] = parts(left); const [rn, rd] = parts(right);
  if (rn === 0n) fail('rational_division_by_zero', 'cannot divide an exact rational by zero');
  return fromBigInts(ln * rd, ld * rn);
}
export function compareRational(left, right) {
  const [ln, ld] = parts(left); const [rn, rd] = parts(right);
  const difference = ln * rd - rn * ld;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function isZeroRational(value) { return parts(value)[0] === 0n; }
