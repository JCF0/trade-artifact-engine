import assert from 'assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { runCli } from './cli.mjs';

let pass = 0;
let fail = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  PASS ${name}`);
    })
    .catch(error => {
      fail += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error.message}`);
    });
}

function createBufferStream() {
  const chunks = [];
  return {
    write(value) {
      chunks.push(String(value));
    },
    toString() {
      return chunks.join('');
    },
  };
}

function listFilesRecursive(root) {
  if (!existsSync(root)) return [];
  const names = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel ? join(root, rel) : root;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const nextRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) stack.push(nextRel);
      else names.push(nextRel.replace(/\\/g, '/'));
    }
  }
  return names.sort();
}

function extractSlug(output) {
  const match = output.match(/slug: (p-[a-f0-9]{24})/);
  assert.ok(match, 'expected dry-run output to include slug');
  return match[1];
}

const fixture = createInventoryFixture();

try {
  await test('default CLI invocation is dry-run and writes nothing', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const outRoot = mkdtempSync(join(tmpdir(), 'trade-artifact-cli-default-'));
    try {
      const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--out', outRoot], {
        stdout,
        stderr,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(code, 0);
      assert.ok(stdout.toString().includes('Publish dry run'));
      assert.deepEqual(listFilesRecursive(outRoot), []);
      assert.equal(stderr.toString(), '');
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  await test('--write writes exactly 3 files', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const outRoot = mkdtempSync(join(tmpdir(), 'trade-artifact-cli-write-'));
    try {
      const dryRunCode = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--out', outRoot], {
        stdout,
        stderr,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(dryRunCode, 0);
      const slug = extractSlug(stdout.toString());

      const writeStdout = createBufferStream();
      const writeStderr = createBufferStream();
      const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--write', '--out', outRoot], {
        stdout: writeStdout,
        stderr: writeStderr,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(code, 0);
      assert.deepEqual(listFilesRecursive(outRoot), [
        `p/${slug}/index.html`,
        `p/${slug}/manifest.json`,
        `p/${slug}/proof.json`,
      ]);
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  await test('private writes to drafts root', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    try {
      const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--write', '--visibility', 'private'], {
        stdout,
        stderr,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(code, 0);
      assert.ok(stderr.toString().includes(join(fixture.root, 'data', 'drafts', 'p')));
      assert.ok(!stderr.toString().includes(join(fixture.root, 'data', 'published', 'p')));
    } finally {
      rmSync(join(fixture.root, 'data', 'drafts'), { recursive: true, force: true });
      rmSync(join(fixture.root, 'data', 'published'), { recursive: true, force: true });
    }
  });

  await test('unlisted and public write to published root', async () => {
    try {
      const stdoutA = createBufferStream();
      const stderrA = createBufferStream();
      const codeA = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--write', '--visibility', 'unlisted'], {
        stdout: stdoutA,
        stderr: stderrA,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(codeA, 0);
      assert.ok(stderrA.toString().includes(join(fixture.root, 'data', 'published', 'p')));
      rmSync(join(fixture.root, 'data', 'published'), { recursive: true, force: true });

      const stdoutB = createBufferStream();
      const stderrB = createBufferStream();
      const codeB = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--write', '--visibility', 'public'], {
        stdout: stdoutB,
        stderr: stderrB,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(codeB, 0);
      assert.ok(stderrB.toString().includes(join(fixture.root, 'data', 'published', 'p')));
    } finally {
      rmSync(join(fixture.root, 'data', 'published'), { recursive: true, force: true });
      rmSync(join(fixture.root, 'data', 'drafts'), { recursive: true, force: true });
    }
  });

  await test('--out changes root but preserves p/<slug> layout', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const outRoot = mkdtempSync(join(tmpdir(), 'trade-artifact-cli-out-'));
    try {
      const dryRunCode = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--out', outRoot], {
        stdout,
        stderr,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(dryRunCode, 0);
      const slug = extractSlug(stdout.toString());

      const writeCode = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--write', '--out', outRoot], {
        stdout: createBufferStream(),
        stderr: createBufferStream(),
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(writeCode, 0);
      assert.deepEqual(listFilesRecursive(outRoot), [
        `p/${slug}/index.html`,
        `p/${slug}/manifest.json`,
        `p/${slug}/proof.json`,
      ]);
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  await test('existing target fails without --force', async () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'trade-artifact-cli-force-'));
    try {
      const firstCode = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--write', '--out', outRoot], {
        stdout: createBufferStream(),
        stderr: createBufferStream(),
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(firstCode, 0);

      const stdout = createBufferStream();
      const stderr = createBufferStream();
      const secondCode = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--write', '--out', outRoot], {
        stdout,
        stderr,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.notEqual(secondCode, 0);
      assert.ok(stderr.toString().includes('--force'));
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  await test('invalid visibility fails non-zero', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--visibility', 'secret'], {
      stdout,
      stderr,
      env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
    });
    assert.notEqual(code, 0);
    assert.ok(stderr.toString().includes('Unsupported visibility'));
  });

  await test('invalid wallet display fails non-zero', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--wallet-display', 'masked'], {
      stdout,
      stderr,
      env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
    });
    assert.notEqual(code, 0);
    assert.ok(stderr.toString().includes('Unsupported wallet display mode'));
  });

  await test('invalid base_url fails non-zero', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--base-url', 'example.com'], {
      stdout,
      stderr,
      env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
    });
    assert.notEqual(code, 0);
    assert.ok(stderr.toString().includes('--base-url must start with http:// or https://'));
  });

  await test('unknown receipt hash fails non-zero', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const code = runCli(['--receipt-hash', '9'.repeat(64)], {
      stdout,
      stderr,
      env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
    });
    assert.notEqual(code, 0);
    assert.ok(stderr.toString().includes('No proof detail found for receipt_hash'));
  });

  await test('dry-run output includes slug, visibility, wallet display mode, target path, hosted_url, and file list', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const outRoot = mkdtempSync(join(tmpdir(), 'trade-artifact-cli-dryrun-'));
    try {
      const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--wallet-display', 'redacted', '--out', outRoot], {
        stdout,
        stderr,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(code, 0);
      const output = stdout.toString();
      assert.ok(output.includes(`receipt_hash: ${fixture.hashes.receiptAHash}`));
      assert.ok(output.includes('slug: p-'));
      assert.ok(output.includes('visibility: unlisted'));
      assert.ok(output.includes('wallet_display_mode: redacted'));
      assert.ok(output.includes('target_dir:'));
      assert.ok(output.includes('hosted_url: ./index.html'));
      assert.ok(output.includes('- index.html'));
      assert.ok(output.includes('- proof.json'));
      assert.ok(output.includes('- manifest.json'));
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  await test('generated files contain hosted disclosures and transformed wallet display', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const outRoot = mkdtempSync(join(tmpdir(), 'trade-artifact-cli-content-'));
    try {
      const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--write', '--wallet-display', 'redacted', '--out', outRoot], {
        stdout,
        stderr,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(code, 0);
      const files = listFilesRecursive(outRoot);
      const htmlPath = join(outRoot, ...files.find(file => file.endsWith('/index.html')).split('/'));
      const proofPath = join(outRoot, ...files.find(file => file.endsWith('/proof.json')).split('/'));
      const html = readFileSync(htmlPath, 'utf8');
      const proof = readFileSync(proofPath, 'utf8');
      assert.ok(html.includes('Hosted proof page.'));
      assert.ok(html.includes('Unlisted does not mean private. Anyone with the link can view.'));
      assert.ok(proof.includes('[redacted]'));
      assert.ok(!proof.includes('TEST_WALLET'));
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  await test('no filesystem writes occur without --write', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const outRoot = mkdtempSync(join(tmpdir(), 'trade-artifact-cli-nowrite-'));
    try {
      const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--dry-run', '--out', outRoot], {
        stdout,
        stderr,
        env: { ...process.env, TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root },
      });
      assert.equal(code, 0);
      assert.deepEqual(listFilesRecursive(outRoot), []);
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
