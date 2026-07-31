#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TARGETED_ORCHESTRATOR_TEST_NAMES_V113,
  TARGETED_ORCHESTRATOR_TEST_PATTERN_V113,
  parseExactTargetedTapV113,
} from './v113-targeted-filter.mjs';

const EXPECTED_NAMES = [
  'JUP-like closed position builds the pinned deterministic package without mutating input',
  'RAY-like evidence reproduces pinned receipt and package bytes',
  'dry-run never touches an injected package store',
];

test('targeted v1.13 filter is anchored to exactly the three frozen full test names', () => {
  assert.deepEqual(TARGETED_ORCHESTRATOR_TEST_NAMES_V113, EXPECTED_NAMES);
  const pattern = new RegExp(TARGETED_ORCHESTRATOR_TEST_PATTERN_V113);
  for (const name of EXPECTED_NAMES) assert.equal(pattern.test(name), true, name);
  for (const nearMiss of [
    `${EXPECTED_NAMES[0]} future commit test`,
    `prefix ${EXPECTED_NAMES[1]}`,
    EXPECTED_NAMES[2].replace('never', 'never-ever'),
    'JUP-like',
    'RAY-like',
    'dry-run never',
  ]) assert.equal(pattern.test(nearMiss), false, nearMiss);
});

test('targeted TAP audit counts only exact selected tests and rejects malformed or unsafe results', () => {
  const filteredSkip = 'test name does not match pattern';
  const tap = [
    'TAP version 13',
    `# Subtest: ${EXPECTED_NAMES[0]}`,
    `ok 1 - ${EXPECTED_NAMES[0]}`,
    '# Subtest: unrelated future test',
    `ok 2 - unrelated future test # SKIP ${filteredSkip}`,
    `# Subtest: ${EXPECTED_NAMES[1]}`,
    `ok 3 - ${EXPECTED_NAMES[1]}`,
    `# Subtest: ${EXPECTED_NAMES[2]}`,
    `ok 4 - ${EXPECTED_NAMES[2]}`,
    '1..4',
    '# tests 4',
    '# pass 3',
    '# fail 0',
    '# skipped 1',
  ].join('\n');
  const summary = parseExactTargetedTapV113(tap);
  assert.deepEqual(summary, { selected: 3, passed: 3, failed: 0, skipped: 0, excluded_by_filter: 1, total: 4 });
  assert.throws(() => parseExactTargetedTapV113(tap.replace(`# pass 3`, '# pass 2')), /TAP summary/i);
  assert.throws(() => parseExactTargetedTapV113(tap.replace(`ok 3 - ${EXPECTED_NAMES[1]}`, `not ok 3 - ${EXPECTED_NAMES[1]}`)), /targeted/i);
  assert.throws(() => parseExactTargetedTapV113(tap.replace(`ok 2 - unrelated future test # SKIP ${filteredSkip}`, 'ok 2 - unrelated future test')), /unexpected selected/i);
  assert.throws(() => parseExactTargetedTapV113(tap.replace(`ok 3 - ${EXPECTED_NAMES[1]}`, `ok 2 - ${EXPECTED_NAMES[1]}`)), /ordinal sequence/i);
  assert.throws(() => parseExactTargetedTapV113(tap.replace('1..4', '1..5')), /TAP plan/i);
  assert.throws(() => parseExactTargetedTapV113('TAP version 13\n1..0'), /parse/i);
});
