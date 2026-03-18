import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const lines = readFileSync(resolve(ROOT, 'data/raw/helius_transactions.jsonl'), 'utf-8').trim().split('\n');

console.log('Total txns:', lines.length);

const types = {};
const sources = {};
let swapCount = 0;

for (const l of lines) {
  const t = JSON.parse(l);
  types[t.type] = (types[t.type] || 0) + 1;
  sources[t.source] = (sources[t.source] || 0) + 1;
  if (t.type === 'SWAP') swapCount++;
}

console.log('\nTransaction types:');
for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}

console.log('\nSources:');
for (const [k, v] of Object.entries(sources).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}

const first = JSON.parse(lines[0]);
const last = JSON.parse(lines[lines.length - 1]);
console.log('\nTime range:');
console.log('  Newest:', new Date(first.timestamp * 1000).toISOString());
console.log('  Oldest:', new Date(last.timestamp * 1000).toISOString());
console.log('\nSWAP transactions:', swapCount, `(${(swapCount/lines.length*100).toFixed(1)}%)`);
