#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  main,
  migrateRecoveredReceiptPackagesV1,
  ReceiptPackageMigrationError,
} from './migrate-recovered-packages.mjs';

const ARCHIVE_ROOT = resolve('engine/data/inventory/receipt-archive-v1');
const ECONOMICS_ROOT = resolve('engine/data/inventory/receipt-economics-v1');
const JUP = Object.freeze({
  path: '/root/artifact-recovery-evidence/jup-5fb5732d/jup-recovery-candidate.json',
  expectedSha256: 'dfbf7cdc0e3e1a6f96731cc4793e873766563a5c1003419b8d78e3cb3024e8f1',
  receiptHash: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
});
const RAY = Object.freeze({
  path: '/root/artifact-recovery-evidence/ray-4d33969c/ray-recovery-candidate.json',
  expectedSha256: 'bef36f12f360b15221032dbc90acd84f8e394329b8df2c5890f965ac49b7a999',
  receiptHash: '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
});
const files = [JUP, RAY].map(item => ({ path: item.path, expectedSha256: item.expectedSha256 }));
const throwsCode = code => error => error instanceof ReceiptPackageMigrationError && error.code === code;

async function snapshotTree(root, relative = '') {
  const result = {};
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshotTree(root, name));
    else result[name] = await readFile(join(root, name), 'utf8');
  }
  return result;
}

const archiveBefore = await snapshotTree(ARCHIVE_ROOT);
const economicsBefore = await snapshotTree(ECONOMICS_ROOT);

await assert.rejects(
  migrateRecoveredReceiptPackagesV1({ candidateFiles: files, economicsRoot: ECONOMICS_ROOT }),
  throwsCode('explicit_archive_root_required'),
);
await assert.rejects(
  migrateRecoveredReceiptPackagesV1({ candidateFiles: files, archiveRoot: ARCHIVE_ROOT }),
  throwsCode('explicit_economics_root_required'),
);
await assert.rejects(
  migrateRecoveredReceiptPackagesV1({ candidateFiles: files, archiveRoot: ARCHIVE_ROOT, economicsRoot: ECONOMICS_ROOT, write: true }),
  throwsCode('explicit_package_root_required'),
);

const dry = await migrateRecoveredReceiptPackagesV1({
  candidateFiles: files,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
});
assert.equal(dry.mode, 'dry-run');
assert.equal(dry.candidates_discovered, 2);
assert.equal(dry.eligible, 2);
assert.equal(dry.rejected, 0);
assert.equal(dry.would_write, 2);
assert.equal(dry.committed, 0);
assert.equal(dry.unchanged, 0);
assert.equal(dry.conflicts, 0);
assert.deepEqual(dry.receipt_hashes, [RAY.receiptHash, JUP.receiptHash]);
assert.deepEqual(Object.keys(dry.package_digests), dry.receipt_hashes);
assert.deepEqual(Object.keys(dry.member_hashes), dry.receipt_hashes);
for (const receiptHash of dry.receipt_hashes) {
  assert.match(dry.package_digests[receiptHash], /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(dry.member_hashes[receiptHash]).sort(), [
    'archive-record.json', 'canonical-receipt.json', 'economics.json', 'manifest.json', 'verification.json',
  ]);
  for (const digest of Object.values(dry.member_hashes[receiptHash])) assert.match(digest, /^[a-f0-9]{64}$/);
}
assert.deepEqual(dry.error_codes_by_candidate, {});

let cliStdout = '';
let cliStderr = '';
const cliExit = await main({
  argv: [
    '--candidates', JUP.path,
    '--archive-root', ARCHIVE_ROOT,
    '--economics-root', ECONOMICS_ROOT,
  ],
  stdout: { write(bytes) { cliStdout += bytes; } },
  stderr: { write(bytes) { cliStderr += bytes; } },
});
assert.equal(cliExit, 0);
assert.equal(cliStderr, '');
const cliReport = JSON.parse(cliStdout);
assert.equal(cliReport.mode, 'dry-run');
assert.equal(cliReport.candidates_discovered, 1);
assert.equal(cliReport.would_write, 1);
assert.equal(cliReport.committed, 0);

const packageRoot = await mkdtemp(join(tmpdir(), 'artifact-migration-test-'));
try {
  const written = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: files,
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
    packageRoot,
    write: true,
  });
  assert.equal(written.committed, 2);
  assert.equal(written.unchanged, 0);
  assert.equal(written.would_write, 0);
  assert.deepEqual((await readdir(packageRoot)).sort(), dry.receipt_hashes);

  const repeated = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: files,
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
    packageRoot,
    write: true,
  });
  assert.equal(repeated.committed, 0);
  assert.equal(repeated.unchanged, 2);
  assert.equal(repeated.conflicts, 0);
  assert.deepEqual(repeated.package_digests, dry.package_digests);
  assert.deepEqual(repeated.member_hashes, dry.member_hashes);
} finally {
  await rm(packageRoot, { recursive: true, force: true });
}

const interruptedRoot = await mkdtemp(join(tmpdir(), 'artifact-migration-interrupted-'));
try {
  const blockedHash = JUP.receiptHash;
  const lockName = `.${blockedHash}.lock`;
  await mkdir(join(interruptedRoot, lockName));
  const interrupted = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: files,
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
    packageRoot: interruptedRoot,
    write: true,
  });
  assert.equal(interrupted.committed, 1);
  assert.equal(interrupted.unchanged, 0);
  assert.deepEqual(interrupted.error_codes_by_candidate[blockedHash], ['package_store_locked']);
  assert.deepEqual((await readdir(interruptedRoot)).sort(), [lockName, RAY.receiptHash].sort());
  assert.equal((await readdir(interruptedRoot)).some(name => name.endsWith('.tmp')), false);
} finally {
  await rm(interruptedRoot, { recursive: true, force: true });
}

await assert.rejects(
  migrateRecoveredReceiptPackagesV1({
    candidateFiles: [{ path: JUP.path, expectedSha256: '0'.repeat(64) }],
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
  }),
  throwsCode('candidate_sha256_mismatch'),
);

const duplicate = await migrateRecoveredReceiptPackagesV1({
  candidateFiles: [files[0], files[0]],
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
});
assert.equal(duplicate.eligible, 0);
assert.equal(duplicate.rejected, 2);
assert.deepEqual(duplicate.error_codes_by_candidate[JUP.receiptHash], ['duplicate_candidate']);

const compatibilityParent = await mkdtemp(join(tmpdir(), 'artifact-migration-compatibility-'));
try {
  const archiveCopy = join(compatibilityParent, 'archive');
  const economicsCopy = join(compatibilityParent, 'economics');
  await cp(ARCHIVE_ROOT, archiveCopy, { recursive: true });
  await cp(ECONOMICS_ROOT, economicsCopy, { recursive: true });
  const archivePath = join(archiveCopy, 'receipts', `${JUP.receiptHash}.json`);
  const economicsPath = join(economicsCopy, 'receipts', `${JUP.receiptHash}.json`);

  await rm(archivePath);
  const missingArchive = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: [files[0]], archiveRoot: archiveCopy, economicsRoot: economicsCopy,
  });
  assert.deepEqual(missingArchive.error_codes_by_candidate[JUP.receiptHash], ['missing_archive_record']);
  await cp(join(ARCHIVE_ROOT, 'receipts', `${JUP.receiptHash}.json`), archivePath);

  await rm(economicsPath);
  const missingEconomics = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: [files[0]], archiveRoot: archiveCopy, economicsRoot: economicsCopy,
  });
  assert.deepEqual(missingEconomics.error_codes_by_candidate[JUP.receiptHash], ['missing_economics_record']);
  await cp(join(ECONOMICS_ROOT, 'receipts', `${JUP.receiptHash}.json`), economicsPath);

  await writeFile(archivePath, '{not-json}\n');
  const corruptArchive = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: [files[0]], archiveRoot: archiveCopy, economicsRoot: economicsCopy,
  });
  assert.deepEqual(corruptArchive.error_codes_by_candidate[JUP.receiptHash], ['corrupt_archive_record']);
  await cp(join(ARCHIVE_ROOT, 'receipts', `${JUP.receiptHash}.json`), archivePath, { force: true });

  await writeFile(economicsPath, '{not-json}\n');
  const corruptEconomics = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: [files[0]], archiveRoot: archiveCopy, economicsRoot: economicsCopy,
  });
  assert.deepEqual(corruptEconomics.error_codes_by_candidate[JUP.receiptHash], ['corrupt_economics_record']);
} finally {
  await rm(compatibilityParent, { recursive: true, force: true });
}

const candidateParent = await mkdtemp(join(tmpdir(), 'artifact-migration-candidate-'));
try {
  const candidate = JSON.parse(await readFile(JUP.path, 'utf8'));
  delete candidate.verification_result;
  const incompletePath = join(candidateParent, 'incomplete.json');
  await writeFile(incompletePath, `${JSON.stringify(candidate)}\n`);
  const incomplete = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: [incompletePath], archiveRoot: ARCHIVE_ROOT, economicsRoot: ECONOMICS_ROOT,
  });
  assert.equal(incomplete.rejected, 1);
  assert.deepEqual(incomplete.error_codes_by_candidate[JUP.receiptHash], ['invalid_candidate']);

  const provenanceMismatch = JSON.parse(await readFile(JUP.path, 'utf8'));
  provenanceMismatch.recovery_method = 'retained_canonical_receipt';
  const provenanceMismatchPath = join(candidateParent, 'provenance-mismatch.json');
  await writeFile(provenanceMismatchPath, `${JSON.stringify(provenanceMismatch)}\n`);
  const mismatched = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: [provenanceMismatchPath], archiveRoot: ARCHIVE_ROOT, economicsRoot: ECONOMICS_ROOT,
  });
  assert.equal(mismatched.rejected, 1);
  assert.deepEqual(
    mismatched.error_codes_by_candidate[JUP.receiptHash],
    ['economics_recovery_method_mismatch'],
  );

  const symlinkPath = join(candidateParent, 'candidate-symlink.json');
  await symlink(JUP.path, symlinkPath);
  await assert.rejects(
    migrateRecoveredReceiptPackagesV1({
      candidateFiles: [symlinkPath], archiveRoot: ARCHIVE_ROOT, economicsRoot: ECONOMICS_ROOT,
    }),
    throwsCode('candidate_file_read_failed'),
  );
} finally {
  await rm(candidateParent, { recursive: true, force: true });
}

await assert.rejects(
  migrateRecoveredReceiptPackagesV1({
    candidateFiles: files,
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
    packageRoot: join(packageRoot, 'missing'),
    write: true,
  }),
  throwsCode('package_root_must_preexist'),
);
await assert.rejects(access(resolve('engine/data/receipt-packages-v1')));
assert.deepEqual(await snapshotTree(ARCHIVE_ROOT), archiveBefore);
assert.deepEqual(await snapshotTree(ECONOMICS_ROOT), economicsBefore);

console.log('receipt-package recovered migration: PASS');
