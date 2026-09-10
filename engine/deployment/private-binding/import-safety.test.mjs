import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
