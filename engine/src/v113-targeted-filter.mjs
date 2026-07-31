const FILTER_SKIP_REASON = 'test name does not match pattern';

export const TARGETED_ORCHESTRATOR_TEST_NAMES_V113 = Object.freeze([
  'JUP-like closed position builds the pinned deterministic package without mutating input',
  'RAY-like evidence reproduces pinned receipt and package bytes',
  'dry-run never touches an injected package store',
]);

function escapeCodeUnits(value) {
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    escaped += `\\u${value.charCodeAt(index).toString(16).padStart(4, '0')}`;
  }
  return escaped;
}

export const TARGETED_ORCHESTRATOR_TEST_PATTERN_V113 = `^(?:${TARGETED_ORCHESTRATOR_TEST_NAMES_V113.map(escapeCodeUnits).join('|')})$`;

function parseSummaryCount(output, label) {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
  if (matches.length !== 1) throw new Error(`Unable to parse targeted TAP summary field: ${label}`);
  return Number(matches[0][1]);
}

export function parseExactTargetedTapV113(output) {
  if (typeof output !== 'string') throw new Error('Unable to parse targeted TAP output');
  const normalized = output.replace(/\r/g, '');
  const records = [];
  const resultPattern = /^(ok|not ok) (\d+) - (.*?)(?: # SKIP(?: (.*))?)?$/gm;
  for (const match of normalized.matchAll(resultPattern)) {
    records.push({
      ok: match[1] === 'ok',
      ordinal: Number(match[2]),
      name: match[3],
      skipped: match[0].includes(' # SKIP'),
      skipReason: match[4] ?? null,
    });
  }
  if (records.length === 0) throw new Error('Unable to parse targeted TAP test results');

  const plans = [...normalized.matchAll(/^1\.\.(\d+)$/gm)];
  if (plans.length !== 1 || Number(plans[0][1]) !== records.length) throw new Error('Targeted TAP plan does not reconcile with parsed results');
  if (records.some((record, index) => record.ordinal !== index + 1)) throw new Error('Targeted TAP ordinal sequence is invalid');
  const total = parseSummaryCount(normalized, 'tests');
  const tapPassed = parseSummaryCount(normalized, 'pass');
  const tapFailed = parseSummaryCount(normalized, 'fail');
  const tapSkipped = parseSummaryCount(normalized, 'skipped');
  if (records.length !== total) throw new Error('Targeted TAP summary does not reconcile with parsed results');

  const expected = new Set(TARGETED_ORCHESTRATOR_TEST_NAMES_V113);
  const selected = [];
  let excludedByFilter = 0;
  for (const record of records) {
    if (record.skipped) {
      if (expected.has(record.name)) throw new Error(`Targeted test was skipped: ${record.name}`);
      if (record.skipReason !== FILTER_SKIP_REASON) throw new Error(`Unexpected skipped test in targeted TAP: ${record.name}`);
      excludedByFilter += 1;
      continue;
    }
    if (!expected.has(record.name)) throw new Error(`Unexpected selected targeted-orchestrator test: ${record.name}`);
    selected.push(record);
  }

  if (selected.length !== TARGETED_ORCHESTRATOR_TEST_NAMES_V113.length) throw new Error(`Expected exactly three targeted tests, selected ${selected.length}`);
  if (new Set(selected.map(record => record.name)).size !== TARGETED_ORCHESTRATOR_TEST_NAMES_V113.length) throw new Error('Targeted TAP contains duplicate or missing selected test names');
  const failed = selected.filter(record => !record.ok).length;
  const passed = selected.filter(record => record.ok).length;
  if (failed !== 0 || passed !== TARGETED_ORCHESTRATOR_TEST_NAMES_V113.length) throw new Error(`Targeted tests did not all pass: ${passed} passed, ${failed} failed`);
  if (tapPassed !== passed || tapFailed !== failed || tapSkipped !== excludedByFilter || tapPassed + tapFailed + tapSkipped !== total) throw new Error('Targeted TAP summary counts are inconsistent');

  return { selected: selected.length, passed, failed, skipped: 0, excluded_by_filter: excludedByFilter, total };
}
