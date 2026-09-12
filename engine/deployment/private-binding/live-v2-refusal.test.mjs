import test from 'node:test';
import assert from 'node:assert/strict';
import { openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('both custody-side production mains refuse before public FD access even with production-shaped argv', () => {
  for (const [file, entry, marker] of [
    ['control-client-v2.mjs', 'controlMainV2', 'PRIVATE_CONTROL_V2_DISABLED_NO_EFFECTS'],
    ['human-client-v2.mjs', 'humanMainV2', 'PRIVATE_HUMAN_V2_DISABLED_NO_EFFECTS'],
  ]) {
    const fd = openSync('/dev/null', 'r');
    try {
      const url = new URL(file, import.meta.url).href;
      const script = `import { ${entry} as main } from ${JSON.stringify(url)};
        import {fstatSync} from 'node:fs';
        import assert from 'node:assert/strict';
        process.argv.splice(0,process.argv.length,'/usr/bin/node','/opt/artifact/release/engine/deployment/private-binding/${file}');
        process.execArgv.splice(0,process.execArgv.length,'--openssl-config=/opt/artifact/release/engine/deployment/private-binding/openssl.cnf');
        await assert.rejects(main(), /${marker}/);
        fstatSync(3);`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
        { stdio: ['ignore', 'pipe', 'pipe', fd], env: {}, encoding: 'utf8', timeout: 5000 });
      assert.equal(child.status, 0, child.stderr);
    } finally { closeSync(fd); }
  }
});
