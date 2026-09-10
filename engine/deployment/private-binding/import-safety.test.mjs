import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

test('candidate modules are import-safe, including inventory tooling and disabled worker', () => {
  const names = ['io', 'provision', 'exchange', 'binding', 'supervisor', 'custody', 'worker', 'resolve-runtime', 'verify'];
  const code = names.map(name => `await import(${JSON.stringify(new URL(`./${name}.mjs`, import.meta.url).href)});`).join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: {}, cwd: '/tmp', encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, '');
});
test('candidate worker has no enable flag or controller-selected command launch', () => {
  for (const args of [[], ['--enable'], ['some-controller-module.mjs']]) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), ...args],
      { env: {}, cwd: '/tmp', encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.match(child.stderr, /PRIVATE_WORKER_STOPPED_NO_REPLACEMENT/);
  }
});
test('fixed production composer remains private and valid preflight still stops before credential or authority', async () => {
  const binding = await import('./binding.mjs');
  for (const name of ['compose', 'loadCredential', 'credentialFor', 'composePrivateBindingV1']) assert.equal(binding[name], undefined);
  const source = readFileSync(new URL('./binding.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('export function openDisabledPrivateBindingV1'), source.indexOf('// Fixed composition kernel.')).replace('export function', 'function');
  let reads = [], privileged = 0;
  const open = new Function('validateDescriptorTableV1', 'validatePublicBindingV1', 'readBoundedFdV1', 'verifyReleaseInventoryV1', 'loadCredential', 'compose', 'REAL_CLOCK_V1',
    code + '; return openDisabledPrivateBindingV1;')(() => {}, () => ({ release_sha256: 'synthetic' }), fd => { reads.push(fd); return Buffer.from('{}'); },
    () => {}, () => { privileged++; }, () => { privileged++; }, {});
  assert.throws(open, /^Error: PRIVATE_DEPLOYMENT_ACTIVATION_NOT_AUTHORIZED$/);
  assert.deepEqual(reads, [3, 4]); assert.equal(privileged, 0);
  const exchange = readFileSync(new URL('./exchange.mjs', import.meta.url), 'utf8');
  assert.match(exchange, /const HELIUS_ENDPOINT = 'https:\/\/mainnet\.helius-rpc\.com\/'/);
  assert.match(source, /if \(c\.provider_capability_id !== HELIUS_CAPABILITY_V1\) throw blocked\(\)/);
});
