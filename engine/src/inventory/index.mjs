#!/usr/bin/env node
import { resolve } from 'path';

import { buildInventorySnapshot } from './inventory.mjs';

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function getFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const engineRoot = getFlagValue('--engine-root')
  ? resolve(getFlagValue('--engine-root'))
  : undefined;

const snapshot = buildInventorySnapshot({
  engineRoot,
  includeLegacy: hasFlag('--include-legacy'),
  includeExcluded: hasFlag('--include-excluded'),
  limit: getFlagValue('--limit'),
  offset: getFlagValue('--offset'),
});

console.log(JSON.stringify(snapshot, null, 2));
