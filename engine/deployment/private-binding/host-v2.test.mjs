import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const host = new URL('./host-launch-v2.py', import.meta.url);
test('literal host command refuses before any installed-path access, even with enable pollution', () => {
  assert.ok(existsSync(host), 'missing disabled fixed host launcher');
  for (const args of [[], ['--enable'], ['/tmp/wallet.json']]) {
    const p = spawnSync('/usr/bin/python3', [host.pathname, ...args], {env:{ARTIFACT_ENABLE:'1', HOME:'/no-such-home'}, encoding:'utf8'});
    assert.equal(p.status, 1); assert.equal(p.stdout, '');
    assert.equal(p.stderr, 'PRIVATE_HOST_V2_DISABLED_NO_EFFECTS\n');
  }
});
test('closed synthetic host exercises real FD separation and supervisor', () => {
  const fixture = new URL('./fixtures/host-v2-cases.py', import.meta.url);
  assert.ok(existsSync(fixture), 'missing actual host fixture');
  const p = spawnSync('/usr/bin/python3', [fixture.pathname], {encoding:'utf8', timeout:15000});
  assert.equal(p.status, 0, p.stderr + p.stdout);
  const rows = p.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.case), ['positive', 'eof', 'output-loss', 'revocation', 'escaped-deadline']);
  assert.ok(rows.every(r => r.closed && r.clean));
});
test('namespace stage cannot bypass the production refusal', () => {
  const stage = new URL('./host-namespace-v2.py', import.meta.url);
  assert.ok(existsSync(stage), 'missing fixed namespace topology stage');
  const p = spawnSync('/usr/bin/python3', [stage.pathname], {encoding:'utf8'});
  assert.equal(p.status, 1); assert.equal(p.stdout, '');
  assert.equal(p.stderr, 'PRIVATE_HOST_V2_DISABLED_NO_EFFECTS\n');
});
test('qualifier capabilities do not silently permit production UID transitions or nested namespace setup', () => {
  const p = spawnSync('/usr/bin/python3', ['-c', 'import os; os.setgroups([]); os.setresuid(62001,62001,62001)'], {encoding:'utf8'});
  assert.notEqual(p.status, 0); assert.match(p.stderr, /Operation not permitted/);
  const ns = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '--pid', '--fork', '/usr/bin/true'], {encoding:'utf8'});
  console.log('HOST_CROSS_UID_GATE', JSON.stringify({setuid:p.status, nested_namespace:ns.status, diagnostic:ns.stderr.trim()}));
});
