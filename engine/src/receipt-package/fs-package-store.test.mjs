#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { buildReceiptPackageV1 } from './builder.mjs';
import { makeFixture } from './fixtures.test-helper.mjs';
import { canonicalJson, serializeReceiptPackageV1 } from './serialize.mjs';
import { createReceiptPackageFsStore, ReceiptPackageStoreError } from './fs-package-store.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const MEMBER_NAMES = [
  'manifest.json', 'canonical-receipt.json', 'verification.json', 'archive-record.json', 'economics.json',
];
const buildPackage = variant => {
  const fixture = makeFixture('JUP');
  if (variant === 'different') fixture.inputCommitment.reconstruction_engine_version = 'position_ledger_v2';
  return buildReceiptPackageV1(fixture);
};
const thrownCode = code => error => error instanceof ReceiptPackageStoreError && error.code === code;

async function tempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-receipt-package-store-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function stagingPath(root, receiptHash) {
  const names = await readdir(root);
  const matches = names.filter(name => name.startsWith(`.${receiptHash}.`) && name.endsWith('.tmp'));
  assert.equal(matches.length, 1);
  return join(root, matches[0]);
}

async function assertVisibleState(store, receiptHash, expectedDigest) {
  const inspected = await store.inspect(receiptHash);
  if (inspected.status === 'absent') {
    assert.equal(await store.readCommitted(receiptHash), undefined);
    return 'absent';
  }
  assert.equal(inspected.package_digest, expectedDigest);
  const receiptPackage = await store.readCommitted(receiptHash);
  assert.equal(receiptPackage['manifest.json'].package_digest, expectedDigest);
  return 'committed';
}

async function runChildPublisher() {
  const [, , , root, variant, readyPath, goPath] = process.argv;
  const pkg = buildPackage(variant);
  const store = createReceiptPackageFsStore({ root });
  const staged = await store.stage(pkg);
  await writeFile(readyPath, 'ready', { mode: 0o600 });
  while (true) {
    try { await access(goPath); break; } catch { await delay(5); }
  }
  try {
    const result = await store.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code })}\n`);
  }
}

async function runThreadPublisher() {
  const pkg = buildPackage(workerData.variant);
  const store = createReceiptPackageFsStore({ root: workerData.root });
  const staged = await store.stage(pkg);
  const barrier = new Int32Array(workerData.barrier);
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 100);
  try {
    const result = await store.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest });
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error.code });
  }
}

async function spawnThreadPublisher(root, variant, barrier) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { root, variant, barrier } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`publisher worker exited ${code}`)); });
  });
}

async function spawnPublisher(root, variant, readyPath, goPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--publisher', root, variant, readyPath, goPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) reject(new Error(`publisher exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout.trim()));
    });
  });
}

async function waitFor(path) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try { await access(path); return; } catch { await delay(5); }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function runTests() {
  assert.throws(() => createReceiptPackageFsStore({}), thrownCode('explicit_package_root_required'));
  assert.throws(() => createReceiptPackageFsStore({ root: '' }), thrownCode('explicit_package_root_required'));
  await tempRoot(async parent => {
    const missingRoot = join(parent, 'missing-store-root');
    const store = createReceiptPackageFsStore({ root: missingRoot });
    await assert.rejects(store.stage(buildPackage('base')), thrownCode('staging_create_failed'));
    await assert.rejects(access(missingRoot));
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base');
    const before = canonicalJson(pkg);
    const hash = pkg['manifest.json'].receipt_hash;
    const digest = pkg['manifest.json'].package_digest;
    const store = createReceiptPackageFsStore({ root });
    assert.deepEqual(await store.inspect(hash), { status: 'absent' });
    await assert.rejects(store.inspect('../escape'), thrownCode('malformed_receipt_hash'));
    await assert.rejects(store.inspect('A'.repeat(64)), thrownCode('malformed_receipt_hash'));
    const invalidPackage = structuredClone(pkg);
    invalidPackage['manifest.json'].package_digest = '0'.repeat(64);
    await assert.rejects(store.stage(invalidPackage), thrownCode('invalid_receipt_package'));

    const staged = await store.stage(pkg);
    assert.equal(staged.receipt_hash, hash);
    assert.equal(staged.package_digest, digest);
    assert.deepEqual(await store.validateStage(staged.stagingHandle), { receipt_hash: hash, package_digest: digest });
    const stageStat = await lstat(await stagingPath(root, hash));
    assert.equal(stageStat.mode & 0o777, 0o700);
    const committed = await store.commit(staged.stagingHandle, { expectedPackageDigest: digest });
    assert.deepEqual(committed, { status: 'committed', receipt_hash: hash, package_digest: digest, location: join(root, hash) });
    assert.deepEqual(await store.inspect(hash), committed);
    assert.deepEqual(await store.readCommitted(hash), pkg);
    assert.equal(canonicalJson(pkg), before);
    assert.deepEqual(await store.abort(staged.stagingHandle), { status: 'already_absent' });
    assert.equal((await readdir(root)).filter(name => name.startsWith('.')).length, 0);

    const serialized = serializeReceiptPackageV1(pkg);
    assert.deepEqual((await readdir(join(root, hash))).sort(), Object.keys(serialized).sort());
    for (const [name, bytes] of Object.entries(serialized)) {
      const path = join(root, hash, name);
      assert.equal(await readFile(path, 'utf8'), bytes);
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
    }
    const diskText = (await Promise.all(Object.keys(serialized).map(name => readFile(join(root, hash, name), 'utf8')))).join('');
    assert.ok(!diskText.includes(root));
    assert.doesNotMatch(diskText, /[0-9a-f]{8}-[0-9a-f-]{27}/i);
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base');
    const hash = pkg['manifest.json'].receipt_hash;
    const digest = pkg['manifest.json'].package_digest;
    const store = createReceiptPackageFsStore({ root });
    const first = await store.stage(pkg);
    await store.commit(first.stagingHandle, { expectedPackageDigest: digest });
    const second = await store.stage(pkg);
    const unchanged = await store.commit(second.stagingHandle, { expectedPackageDigest: digest });
    assert.equal(unchanged.status, 'unchanged');
    assert.deepEqual(await store.abort(second.stagingHandle), { status: 'already_absent' });
    assert.equal(await assertVisibleState(store, hash, digest), 'committed');
  });

  await tempRoot(async root => {
    const base = buildPackage('base'); const different = buildPackage('different');
    const hash = base['manifest.json'].receipt_hash;
    assert.equal(different['manifest.json'].receipt_hash, hash);
    assert.notEqual(different['manifest.json'].package_digest, base['manifest.json'].package_digest);
    const store = createReceiptPackageFsStore({ root });
    const first = await store.stage(base); const second = await store.stage(different);
    await store.commit(first.stagingHandle, { expectedPackageDigest: first.package_digest });
    await assert.rejects(store.commit(second.stagingHandle, { expectedPackageDigest: second.package_digest }), thrownCode('package_store_conflict'));
    assert.equal((await store.inspect(hash)).package_digest, first.package_digest);
    assert.deepEqual(await store.abort(second.stagingHandle), { status: 'aborted' });
  });

  const stageFaults = [
    ['before_staging_directory_create'],
    ...MEMBER_NAMES.flatMap(member => [
      ['after_member_write', member], ['after_member_fsync', member],
    ]),
    ['before_staging_directory_fsync'], ['after_staging_directory_fsync'],
    ['before_staged_readback'],
    ...MEMBER_NAMES.map(member => ['during_staged_readback', member]),
    ['after_staged_validation'],
  ];
  for (const [targetPoint, targetMember] of stageFaults) {
    await tempRoot(async root => {
      const pkg = buildPackage('base'); let fired = false;
      const store = createReceiptPackageFsStore({ root, faultInjector(point, context) {
        if (!fired && point === targetPoint && (targetMember === undefined || context.member === targetMember)) {
          fired = true; throw new Error(`injected ${targetPoint} ${targetMember ?? ''}`);
        }
      } });
      await assert.rejects(store.stage(pkg));
      assert.equal(fired, true);
      assert.equal(await assertVisibleState(store, pkg['manifest.json'].receipt_hash, pkg['manifest.json'].package_digest), 'absent');
    });
  }

  await tempRoot(async root => {
    const pkg = buildPackage('base');
    const unavailable = Object.assign(new Error('directory fsync unsupported'), { code: 'ENOTSUP' });
    const store = createReceiptPackageFsStore({ root, faultInjector(point) {
      if (point === 'before_staging_directory_fsync') throw unavailable;
    } });
    await assert.rejects(store.stage(pkg), thrownCode('durability_unavailable'));
  });

  const preRenameFaults = ['before_lock_acquisition', 'after_lock_acquisition', 'before_rename'];
  for (const targetPoint of preRenameFaults) {
    await tempRoot(async root => {
      const pkg = buildPackage('base'); let fired = false;
      const store = createReceiptPackageFsStore({ root, faultInjector(point) {
        if (!fired && point === targetPoint) { fired = true; throw new Error(`injected ${point}`); }
      } });
      const staged = await store.stage(pkg);
      await assert.rejects(store.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest }));
      assert.equal(fired, true);
      assert.equal(await assertVisibleState(store, staged.receipt_hash, staged.package_digest), 'absent');
      assert.deepEqual(await store.abort(staged.stagingHandle), { status: 'aborted' });
      const retry = await store.stage(pkg);
      assert.equal((await store.commit(retry.stagingHandle, { expectedPackageDigest: retry.package_digest })).status, 'committed');
    });
  }

  const postRenameFaults = ['after_rename', 'before_parent_directory_fsync', 'after_parent_directory_fsync_before_response'];
  for (const targetPoint of postRenameFaults) {
    await tempRoot(async root => {
      const pkg = buildPackage('base'); let fired = false;
      const store = createReceiptPackageFsStore({ root, faultInjector(point) {
        if (!fired && point === targetPoint) { fired = true; throw new Error(`injected ${point}`); }
      } });
      const staged = await store.stage(pkg);
      const error = await store.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest }).then(
        () => assert.fail('commit should be unknown'), value => value,
      );
      assert.equal(error.code, 'commit_unknown');
      assert.equal(error.receipt_hash, staged.receipt_hash);
      assert.equal(error.expected_package_digest, staged.package_digest);
      assert.equal(await assertVisibleState(store, staged.receipt_hash, staged.package_digest), 'committed');
      const retryStage = await store.stage(pkg);
      const reconciled = await store.commit(retryStage.stagingHandle, { expectedPackageDigest: staged.package_digest });
      assert.equal(reconciled.status, 'unchanged');
    });
  }

  await tempRoot(async root => {
    const pkg = buildPackage('base'); let cleanupFault = true;
    const store = createReceiptPackageFsStore({ root, faultInjector(point) {
      if (cleanupFault && point === 'during_staging_cleanup') { cleanupFault = false; throw new Error('cleanup fault'); }
    } });
    const first = await store.stage(pkg);
    await store.commit(first.stagingHandle, { expectedPackageDigest: first.package_digest });
    const second = await store.stage(pkg);
    await assert.rejects(store.commit(second.stagingHandle, { expectedPackageDigest: second.package_digest }), thrownCode('abort_failed'));
    assert.equal(await assertVisibleState(store, second.receipt_hash, second.package_digest), 'committed');
    assert.deepEqual(await store.abort(second.stagingHandle), { status: 'aborted' });
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base'); let abortFault = true;
    const store = createReceiptPackageFsStore({ root, faultInjector(point) {
      if (abortFault && point === 'during_abort_cleanup') { abortFault = false; throw new Error('abort fault'); }
    } });
    const staged = await store.stage(pkg);
    await assert.rejects(store.abort(staged.stagingHandle), thrownCode('abort_failed'));
    assert.equal(await assertVisibleState(store, staged.receipt_hash, staged.package_digest), 'absent');
    assert.deepEqual(await store.abort(staged.stagingHandle), { status: 'aborted' });
    await assert.rejects(store.abort(Object.freeze({})), thrownCode('staging_handle_invalid'));
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base'); const hash = pkg['manifest.json'].receipt_hash;
    const store = createReceiptPackageFsStore({ root });
    const staged = await store.stage(pkg); const path = await stagingPath(root, hash);
    await writeFile(join(path, 'unexpected.json'), '{}\n', { mode: 0o600 });
    await assert.rejects(store.validateStage(staged.stagingHandle), thrownCode('staging_validation_failed'));
    await rm(join(path, 'unexpected.json'));
    await rm(join(path, 'economics.json'));
    await symlink('manifest.json', join(path, 'economics.json'));
    await assert.rejects(store.validateStage(staged.stagingHandle), thrownCode('staging_validation_failed'));
    await rm(path, { recursive: true });
    assert.deepEqual(await store.abort(staged.stagingHandle), { status: 'already_absent' });
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base'); const hash = pkg['manifest.json'].receipt_hash;
    const store = createReceiptPackageFsStore({ root });
    const staged = await store.stage(pkg); const path = await stagingPath(root, hash);
    await rm(path, { recursive: true });
    await mkdir(path, { mode: 0o700 });
    await assert.rejects(store.abort(staged.stagingHandle), thrownCode('staging_ownership_lost'));
    assert.equal((await lstat(path)).isDirectory(), true);
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base'); const hash = pkg['manifest.json'].receipt_hash;
    const store = createReceiptPackageFsStore({ root });
    await mkdir(join(root, hash), { mode: 0o700 });
    await writeFile(join(root, hash, 'manifest.json'), '{}\n', { mode: 0o600 });
    await assert.rejects(store.inspect(hash), thrownCode('committed_package_invalid'));
    await assert.rejects(store.readCommitted(hash), thrownCode('committed_package_invalid'));
    const staged = await store.stage(pkg);
    await assert.rejects(store.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest }), thrownCode('committed_package_invalid'));
    assert.equal((await readFile(join(root, hash, 'manifest.json'), 'utf8')), '{}\n');
    await store.abort(staged.stagingHandle);
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base'); const hash = pkg['manifest.json'].receipt_hash;
    const store = createReceiptPackageFsStore({ root });
    const staged = await store.stage(pkg);
    await store.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest });
    const committedPath = join(root, hash);
    await writeFile(join(committedPath, 'unexpected.json'), '{}\n', { mode: 0o600 });
    await assert.rejects(store.inspect(hash), thrownCode('committed_package_invalid'));
    await rm(join(committedPath, 'unexpected.json'));
    const serialized = serializeReceiptPackageV1(pkg);
    await writeFile(join(committedPath, 'manifest.json'), JSON.stringify(pkg['manifest.json']), { mode: 0o600 });
    await assert.rejects(store.inspect(hash), thrownCode('committed_package_invalid'));
    await writeFile(join(committedPath, 'manifest.json'), serialized['manifest.json'], { mode: 0o600 });
    await rm(join(committedPath, 'economics.json'));
    await symlink('manifest.json', join(committedPath, 'economics.json'));
    await assert.rejects(store.inspect(hash), thrownCode('committed_package_invalid'));
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base'); const hash = pkg['manifest.json'].receipt_hash;
    let raced = false;
    const store = createReceiptPackageFsStore({ root, async faultInjector(point) {
      if (!raced && point === 'before_rename') {
        raced = true;
        await mkdir(join(root, hash), { mode: 0o700 });
      }
    } });
    const staged = await store.stage(pkg);
    await assert.rejects(
      store.commit(staged.stagingHandle, { expectedPackageDigest: staged.package_digest }),
      thrownCode('committed_package_invalid'),
    );
    assert.equal(raced, true);
    assert.deepEqual(await readdir(join(root, hash)), []);
    assert.deepEqual(await store.abort(staged.stagingHandle), { status: 'aborted' });
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base'); const hash = pkg['manifest.json'].receipt_hash;
    const external = await mkdtemp(join(tmpdir(), 'artifact-receipt-package-external-'));
    try {
      await symlink(external, join(root, hash), 'dir');
      const store = createReceiptPackageFsStore({ root });
      await assert.rejects(store.inspect(hash), thrownCode('committed_package_invalid'));
    } finally { await rm(external, { recursive: true, force: true }); }
  });

  await tempRoot(async root => {
    const pkg = buildPackage('base'); const hash = pkg['manifest.json'].receipt_hash;
    const store = createReceiptPackageFsStore({ root });
    const a = await store.stage(pkg); const b = await store.stage(pkg);
    const results = await Promise.all([
      store.commit(a.stagingHandle, { expectedPackageDigest: a.package_digest }),
      store.commit(b.stagingHandle, { expectedPackageDigest: b.package_digest }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), ['committed', 'unchanged']);
    assert.equal(await assertVisibleState(store, hash, a.package_digest), 'committed');
  });

  await tempRoot(async root => {
    const base = buildPackage('base'); const different = buildPackage('different');
    const store = createReceiptPackageFsStore({ root });
    const a = await store.stage(base); const b = await store.stage(different);
    const results = await Promise.allSettled([
      store.commit(a.stagingHandle, { expectedPackageDigest: a.package_digest }),
      store.commit(b.stagingHandle, { expectedPackageDigest: b.package_digest }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'package_store_conflict');
    const winner = results.find(result => result.status === 'fulfilled').value;
    assert.equal((await store.inspect(a.receipt_hash)).package_digest, winner.package_digest);
    const loser = winner.package_digest === a.package_digest ? b : a;
    assert.deepEqual(await store.abort(loser.stagingHandle), { status: 'aborted' });
  });

  await tempRoot(async root => {
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const results = await Promise.all([
      spawnThreadPublisher(root, 'base', barrier),
      spawnThreadPublisher(root, 'different', barrier),
    ]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.find(result => !result.ok).code, 'package_store_conflict');
    const winner = results.find(result => result.ok).result;
    const store = createReceiptPackageFsStore({ root });
    assert.equal((await store.inspect(winner.receipt_hash)).package_digest, winner.package_digest);
  });

  await tempRoot(async root => {
    const goPath = join(root, '.go');
    const readyA = join(root, '.ready-a'); const readyB = join(root, '.ready-b');
    const childA = spawnPublisher(root, 'base', readyA, goPath);
    const childB = spawnPublisher(root, 'base', readyB, goPath);
    await Promise.all([waitFor(readyA), waitFor(readyB)]);
    await writeFile(goPath, 'go', { mode: 0o600 });
    const results = await Promise.all([childA, childB]);
    assert.equal(results.every(result => result.ok), true);
    assert.deepEqual(results.map(result => result.result.status).sort(), ['committed', 'unchanged']);
    assert.equal(results[0].result.package_digest, results[1].result.package_digest);
  });

  await tempRoot(async root => {
    const goPath = join(root, '.go');
    const readyA = join(root, '.ready-a'); const readyB = join(root, '.ready-b');
    const childA = spawnPublisher(root, 'base', readyA, goPath);
    const childB = spawnPublisher(root, 'different', readyB, goPath);
    await Promise.all([waitFor(readyA), waitFor(readyB)]);
    await writeFile(goPath, 'go', { mode: 0o600 });
    const results = await Promise.all([childA, childB]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.find(result => !result.ok).code, 'package_store_conflict');
    const winner = results.find(result => result.ok).result;
    const store = createReceiptPackageFsStore({ root });
    assert.equal((await store.inspect(winner.receipt_hash)).package_digest, winner.package_digest);
  });

  const source = readFileSync(new URL('./fs-package-store.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"](?:node:)?(?:http|https|net)(?:['"/])/i);
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:provider|helius|uploader|upload-package|mint|sign)[^'"]*['"]/i);
  assert.ok(!source.includes('engine/data'));
  console.log(`receipt-package fs store: PASS (${stageFaults.length} staging faults, ${preRenameFaults.length} pre-rename faults, ${postRenameFaults.length} commit-unknown faults, in-process, worker-thread, and separate-process concurrency)`);
}

if (!isMainThread) await runThreadPublisher();
else if (process.argv[2] === '--publisher') await runChildPublisher();
else await runTests();
