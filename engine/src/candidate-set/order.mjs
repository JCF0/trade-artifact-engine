export function compareCodeUnits(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') throw new TypeError('code-unit comparison requires strings');
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortedCodeUnitCopy(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new TypeError('sortedCodeUnitCopy requires an array of strings');
  return [...values].sort(compareCodeUnits);
}

export function sortCodeUnitKeys(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('sortCodeUnitKeys requires an object');
  return Object.keys(value).sort(compareCodeUnits);
}
