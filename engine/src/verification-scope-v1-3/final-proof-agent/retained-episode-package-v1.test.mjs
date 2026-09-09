import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, linkSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hash = b => createHash('sha256').update(b).digest('hex');
test('retained loader preserves exact bytes and requires an external package pin', async () => {
  const { loadRetainedEpisodePackageV1 } = await import('./retained-episode-package-v1.mjs');
  const root = mkdtempSync(join(tmpdir(), 'artifact-retained-'));
  try {
    const bytes = Buffer.from('{"rentEpoch":18446744073709551615}\n');
    writeFileSync(join(root, 'source.json'), bytes);
    const manifest = Buffer.from(JSON.stringify({ version: 'artifact_retained_episode_package_v1', members: [
      { path: 'source.json', bytes: bytes.length, sha256: hash(bytes) },
    ] }));
    writeFileSync(join(root, 'manifest.json'), manifest);
    const loaded = loadRetainedEpisodePackageV1({ root, expected_manifest_sha256: hash(manifest) });
    assert.deepEqual(loaded.readMemberV1('source.json'), bytes);
    const copy = loaded.readMemberV1('source.json'); copy.fill(0);
    assert.deepEqual(loaded.readMemberV1('source.json'), bytes);
    assert.equal(loaded.parseMemberV1('source.json').rentEpoch, '18446744073709551615');
    assert.throws(() => loadRetainedEpisodePackageV1({ root, expected_manifest_sha256: '0'.repeat(64) }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ['missing', 'truncated', 'tampered', 'extra', 'symlink', 'hardlink', 'traversal', 'duplicate', 'extra-directory', 'oversized']) {
  test(`retained loader rejects ${scenario} evidence without reading ambient files`, async () => {
    const { loadRetainedEpisodePackageV1 } = await import('./retained-episode-package-v1.mjs');
    const root = mkdtempSync(join(tmpdir(), 'artifact-retained-'));
    try {
      const bytes = Buffer.from('{}'); writeFileSync(join(root, 'source.json'), bytes);
      const members = [{ path: 'source.json', bytes: bytes.length, sha256: hash(bytes) }];
      if (scenario === 'missing') rmSync(join(root, 'source.json'));
      if (scenario === 'truncated') writeFileSync(join(root, 'source.json'), '{');
      if (scenario === 'tampered') writeFileSync(join(root, 'source.json'), '[]');
      if (scenario === 'extra') writeFileSync(join(root, 'extra'), 'canary');
      if (scenario === 'symlink') { rmSync(join(root, 'source.json')); symlinkSync('/does-not-exist', join(root, 'source.json')); }
      if (scenario === 'hardlink') linkSync(join(root, 'source.json'), join(root, 'alias'));
      if (scenario === 'traversal') members[0].path = '../source.json';
      if (scenario === 'duplicate') members.push({ ...members[0] });
      if (scenario === 'extra-directory') mkdirSync(join(root, 'extra'));
      if (scenario === 'oversized') members[0].bytes = 1000000000;
      const manifest = Buffer.from(JSON.stringify({ version: 'artifact_retained_episode_package_v1', members }));
      writeFileSync(join(root, 'manifest.json'), manifest);
      assert.throws(() => loadRetainedEpisodePackageV1({ root, expected_manifest_sha256: hash(manifest) }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const raw of ['{"x":1,"x":2}', '{"x":9007199254740993}', '{"rentEpoch":18446744073709551616}', '{"x":-0}', '{"x":1e999}', '{', '{"x":1}{}']) {
  test(`retained loader rejects malformed or lossy JSON ${raw}`, async () => {
    const { loadRetainedEpisodePackageV1 } = await import('./retained-episode-package-v1.mjs');
    const root = mkdtempSync(join(tmpdir(), 'artifact-retained-'));
    try {
      const bytes = Buffer.from(raw); writeFileSync(join(root, 'source.json'), bytes);
      const manifest = Buffer.from(JSON.stringify({ version: 'artifact_retained_episode_package_v1', members: [{ path: 'source.json', bytes: bytes.length, sha256: hash(bytes) }] }));
      writeFileSync(join(root, 'manifest.json'), manifest);
      const loaded = loadRetainedEpisodePackageV1({ root, expected_manifest_sha256: hash(manifest) });
      assert.throws(() => loaded.parseMemberV1('source.json'));
      assert.deepEqual(readFileSync(join(root, 'source.json')), bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
