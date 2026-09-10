import { join, dirname, basename } from 'node:path';
import { constants, mkdirSync, openSync, closeSync, writeSync, fsyncSync } from 'node:fs';
import { loadRetainedEpisodePackageV1 } from '../../src/verification-scope-v1-3/final-proof-agent/retained-episode-package-v1.mjs';
import { sha256CanonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
import { blocked, privateDirectoryV1, fsyncDirectoryV1, readBoundedFdV1 } from './io.mjs';
// Narrow additive durability fix around the unchanged reviewed exporter. Failure
// leaves its exclusive child intact and returns no durable acknowledgment.
export async function publishRetainedPackageV1(runtime, state_root, ordinal, selection = null) {
  const before = privateDirectoryV1(state_root);
  const descriptor = await runtime.trusted.exportRetainedEpisodeV1({ ordinal, selection });
  const expected = join(state_root, `retained-export-${ordinal}${selection === null ? '' : `-selected-${sha256CanonicalJson(selection)}`}`);
  if (descriptor.root !== expected || descriptor.source_ordinal !== ordinal) throw blocked();
  loadRetainedEpisodePackageV1({ root: descriptor.root, expected_manifest_sha256: descriptor.expected_manifest_sha256 });
  fsyncDirectoryV1(state_root, before);
  // Revalidate exact package following publication barrier, not just mkdir.
  loadRetainedEpisodePackageV1({ root: descriptor.root, expected_manifest_sha256: descriptor.expected_manifest_sha256 });
  return descriptor;
}
// Separate custodian interface: never reachable through the controller ports.
export function copyPublishedPackageV1(descriptor, destination) {
  const loaded = loadRetainedEpisodePackageV1({ root: descriptor.root, expected_manifest_sha256: descriptor.expected_manifest_sha256 });
  const parent = dirname(destination), before = privateDirectoryV1(parent);
  if (join(parent, basename(destination)) !== destination || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(basename(destination))) throw blocked();
  mkdirSync(destination, { mode: 0o700 }); // Exclusive; partial failures are NEVER removed.
  const directory = privateDirectoryV1(destination);
  const rootFd = openSync(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const source = openSync(join(descriptor.root, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let manifest;
    try { manifest = readBoundedFdV1(source, 262144, process.getuid()); } finally { closeSync(source); }
    for (const [name, bytes] of [...loaded.inventory.map(m => [m.path, loaded.readMemberV1(m.path)]), ['manifest.json', manifest]]) {
      const fd = openSync(`/proc/self/fd/${rootFd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset); if (!n) throw blocked(); offset += n; }
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    fsyncDirectoryV1(destination, directory);
    fsyncDirectoryV1(parent, before);
    loadRetainedEpisodePackageV1({ root: destination, expected_manifest_sha256: descriptor.expected_manifest_sha256 });
    loadRetainedEpisodePackageV1({ root: descriptor.root, expected_manifest_sha256: descriptor.expected_manifest_sha256 });
    return Object.freeze({ ...descriptor, root: destination });
  } catch { throw blocked(); }
  finally { closeSync(rootFd); }
}
