#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { readReceiptArchiveBundle, stableJson } from '../inventory/archive-store.mjs';
import { readReceiptEconomics } from '../inventory/receipt-economics-store.mjs';
import { verifyReceipt } from '../ledger/receipt-verifier.mjs';
import { buildReceiptPackageV1 } from './builder.mjs';
import { createReceiptPackageFsStore } from './fs-package-store.mjs';
import { migrateRecoveredReceiptPackagesV1 } from './migrate-recovered-packages.mjs';
import {
  RECEIPT_PACKAGE_FETCH_PROFILE_V1,
  RECEIPT_PACKAGE_NORMALIZATION_PROFILE_V1,
  RECEIPT_PACKAGE_RECONSTRUCTION_ENGINE_VERSION_V1,
} from './profiles.mjs';
import { serializeReceiptPackageV1 } from './serialize.mjs';

const ARCHIVE_ROOT = resolve('engine/data/inventory/receipt-archive-v1');
const ECONOMICS_ROOT = resolve('engine/data/inventory/receipt-economics-v1');
const FIXTURES = Object.freeze([
  {
    symbol: 'RAY',
    receiptHash: '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
    path: '/root/artifact-recovery-evidence/ray-4d33969c/ray-recovery-candidate.json',
    expectedSha256: 'bef36f12f360b15221032dbc90acd84f8e394329b8df2c5890f965ac49b7a999',
    packageDigest: '25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2',
    memberHashes: {
      'archive-record.json': '777987cf14a3e41034923a6acc0e87ce15ec7affef68b0e3fb32890ad24bd695',
      'canonical-receipt.json': '94717ca77018826e88bf39313c7b4b810ade1d42ed9f507809c649f1f6f3f2cb',
      'economics.json': '4664d29a151bba54051c4a8ef6044990a2ca474a4b45a421536106e9fa5d0ea8',
      'manifest.json': '9fffd0746b49b5e3b89dbf113675c76290c7ae10f99542a23b1c385e3c75b41e',
      'verification.json': '808c2d03cd54bb13ed418ea034075dc8b523cb01e6a9ce3359d2959498141e6d',
    },
  },
  {
    symbol: 'JUP',
    receiptHash: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
    path: '/root/artifact-recovery-evidence/jup-5fb5732d/jup-recovery-candidate.json',
    expectedSha256: 'dfbf7cdc0e3e1a6f96731cc4793e873766563a5c1003419b8d78e3cb3024e8f1',
    packageDigest: '5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278',
    memberHashes: {
      'archive-record.json': 'd28c5a58b920f526c5ed9e08e4e5b034d99285cd7182a1374f1eb9c10697c6ac',
      'canonical-receipt.json': 'c636cfda958eb87341d3225d33b53b7dc9dcf157def5cc3a054eb56cd4e9eb61',
      'economics.json': 'd8d716459707f3b8c7f95b2f6e64a3c1f1faf91e62629e0477213e4b4ed9ffbd',
      'manifest.json': '2ce234ccedcb52ac555f49129de7a3b6660506b04ed452c02503ec626646f1f6',
      'verification.json': '851c283e7e321bee61a939f1b39dbfb1f09ec038cdd078ceca50c8f7167c6ad0',
    },
  },
]);
const candidateFiles = FIXTURES.map(({ path, expectedSha256 }) => ({ path, expectedSha256 }));
const MEMBER_NAMES = Object.freeze([
  'manifest.json', 'canonical-receipt.json', 'verification.json', 'archive-record.json', 'economics.json',
]);
const OPERATIONAL_FIELDS = new Set(['candidate_hash', 'source', 'promoted_at', 'promoted_from']);

function withoutOperational(value) {
  return Object.fromEntries(Object.entries(value).filter(([field]) => !OPERATIONAL_FIELDS.has(field)));
}

async function bytesByReceipt(root) {
  const result = {};
  for (const fixture of FIXTURES) {
    result[fixture.receiptHash] = {};
    for (const member of MEMBER_NAMES) {
      result[fixture.receiptHash][member] = await readFile(join(root, fixture.receiptHash, member), 'utf8');
    }
  }
  return result;
}

const dry = await migrateRecoveredReceiptPackagesV1({
  candidateFiles,
  archiveRoot: ARCHIVE_ROOT,
  economicsRoot: ECONOMICS_ROOT,
});
assert.deepEqual(dry.receipt_hashes, FIXTURES.map(item => item.receiptHash));
for (const fixture of FIXTURES) {
  assert.equal(dry.package_digests[fixture.receiptHash], fixture.packageDigest, `${fixture.symbol} package digest changed`);
  assert.deepEqual(dry.member_hashes[fixture.receiptHash], fixture.memberHashes, `${fixture.symbol} member bytes changed`);
}

const rootA = await mkdtemp(join(tmpdir(), 'artifact-v112-golden-a-'));
const rootB = await mkdtemp(join(tmpdir(), 'artifact-v112-golden-b-'));
const conflictRoot = await mkdtemp(join(tmpdir(), 'artifact-v112-golden-conflict-'));
try {
  const firstA = await migrateRecoveredReceiptPackagesV1({
    candidateFiles, archiveRoot: ARCHIVE_ROOT, economicsRoot: ECONOMICS_ROOT, packageRoot: rootA, write: true,
  });
  assert.equal(firstA.committed, 2);
  assert.equal(firstA.unchanged, 0);
  const storeA = createReceiptPackageFsStore({ root: rootA });

  for (const fixture of FIXTURES) {
    const candidate = JSON.parse(readFileSync(fixture.path, 'utf8'));
    const receiptPackage = await storeA.readCommitted(fixture.receiptHash);
    const serialized = serializeReceiptPackageV1(receiptPackage);
    assert.equal(receiptPackage['manifest.json'].package_digest, fixture.packageDigest);
    assert.deepEqual(receiptPackage['canonical-receipt.json'], withoutOperational(candidate.canonical_receipt));
    assert.deepEqual(receiptPackage['canonical-receipt.json'].entry_tx_hashes, candidate.canonical_receipt.entry_tx_hashes);
    assert.deepEqual(receiptPackage['canonical-receipt.json'].exit_tx_hashes, candidate.canonical_receipt.exit_tx_hashes);
    assert.deepEqual(receiptPackage['verification.json'], candidate.verification_result);
    assert.deepEqual(verifyReceipt(receiptPackage['canonical-receipt.json']), candidate.verification_result);

    const archive = readReceiptArchiveBundle(fixture.receiptHash, { archiveRoot: ARCHIVE_ROOT });
    for (const [field, value] of Object.entries(archive.canonical_receipt_record)) {
      if (!Object.hasOwn(receiptPackage['canonical-receipt.json'], field)) continue;
      assert.deepEqual(receiptPackage['canonical-receipt.json'][field], value, `${fixture.symbol} archive overlap ${field}`);
    }
    const economics = readReceiptEconomics(fixture.receiptHash, {
      archiveRoot: ARCHIVE_ROOT,
      economicsRoot: ECONOMICS_ROOT,
    });
    for (const [field, value] of Object.entries(economics.economics)) {
      assert.deepEqual(receiptPackage['economics.json'][field], value, `${fixture.symbol} economics ${field}`);
    }
    assert.equal(receiptPackage['manifest.json'].input_commitment.fetch_profile, RECEIPT_PACKAGE_FETCH_PROFILE_V1);
    assert.equal(receiptPackage['manifest.json'].input_commitment.normalization_profile, RECEIPT_PACKAGE_NORMALIZATION_PROFILE_V1);
    assert.equal(receiptPackage['manifest.json'].input_commitment.reconstruction_engine_version, RECEIPT_PACKAGE_RECONSTRUCTION_ENGINE_VERSION_V1);
    assert.equal(
      receiptPackage['manifest.json'].input_commitment.accounting_method_version,
      receiptPackage['canonical-receipt.json'].accounting_method,
    );
    for (const [member, bytes] of Object.entries(serialized)) {
      assert.equal(await readFile(join(rootA, fixture.receiptHash, member), 'utf8'), bytes);
    }
    const allBytes = Object.values(serialized).join('');
    for (const forbiddenField of [
      'recovery_method', 'promoted_at', 'promoted_from', 'source', 'candidate_hash',
      'provider_url', 'api_key', 'secret', 'password', 'raw_transaction',
      'transactions_sha256', 'receipt_evidence_sha256', 'upload', 'mint', 'signing',
    ]) assert.equal(allBytes.includes(`\"${forbiddenField}\"`), false, `forbidden package field: ${forbiddenField}`);
    for (const forbiddenValue of ['helius', fixture.path, rootA, rootB]) {
      assert.equal(allBytes.toLowerCase().includes(forbiddenValue.toLowerCase()), false, `forbidden package value: ${forbiddenValue}`);
    }
  }

  const repeatedA = await migrateRecoveredReceiptPackagesV1({
    candidateFiles, archiveRoot: ARCHIVE_ROOT, economicsRoot: ECONOMICS_ROOT, packageRoot: rootA, write: true,
  });
  assert.equal(repeatedA.committed, 0);
  assert.equal(repeatedA.unchanged, 2);

  const firstB = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: [...candidateFiles].reverse(),
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
    packageRoot: rootB,
    write: true,
  });
  assert.equal(firstB.committed, 2);
  assert.deepEqual(firstB.package_digests, firstA.package_digests);
  assert.deepEqual(firstB.member_hashes, firstA.member_hashes);
  assert.deepEqual(await bytesByReceipt(rootB), await bytesByReceipt(rootA));

  for (const root of [rootA, rootB]) {
    const entries = (await readdir(root)).sort();
    assert.deepEqual(entries, FIXTURES.map(item => item.receiptHash));
    assert.equal(entries.some(name => name.startsWith('.')), false);
    for (const fixture of FIXTURES) assert.deepEqual((await readdir(join(root, fixture.receiptHash))).sort(), [...MEMBER_NAMES].sort());
  }

  const base = await storeA.readCommitted(FIXTURES[0].receiptHash);
  const conflicting = buildReceiptPackageV1({
    canonicalReceipt: base['canonical-receipt.json'],
    verificationResult: base['verification.json'],
    archiveRecord: base['archive-record.json'],
    economicsRecord: base['economics.json'],
    inputCommitment: {
      ...base['manifest.json'].input_commitment,
      reconstruction_engine_version: 'artifact_position_ledger_receipt_v2',
    },
  });
  assert.notEqual(conflicting['manifest.json'].package_digest, base['manifest.json'].package_digest);
  const conflictStore = createReceiptPackageFsStore({ root: conflictRoot });
  const staged = await conflictStore.stage(conflicting);
  await conflictStore.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest });
  const conflict = await migrateRecoveredReceiptPackagesV1({
    candidateFiles: [candidateFiles[0]],
    archiveRoot: ARCHIVE_ROOT,
    economicsRoot: ECONOMICS_ROOT,
    packageRoot: conflictRoot,
    write: true,
  });
  assert.equal(conflict.committed, 0);
  assert.equal(conflict.conflicts, 1);
  assert.deepEqual(conflict.error_codes_by_candidate[FIXTURES[0].receiptHash], ['package_store_conflict']);
  assert.equal((await conflictStore.inspect(FIXTURES[0].receiptHash)).package_digest, conflicting['manifest.json'].package_digest);

  assert.equal(stableJson(firstA.package_digests), stableJson(firstB.package_digests));
} finally {
  await Promise.all([rootA, rootB, conflictRoot].map(root => rm(root, { recursive: true, force: true })));
}

console.log('receipt-package JUP/RAY golden packages: PASS');
