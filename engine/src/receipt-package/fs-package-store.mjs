import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  lstat, mkdir, open, readdir, rm, rmdir,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_MEMBER_NAMES, RECEIPT_HASH_PATTERN } from './schema.mjs';
import { serializeReceiptPackageV1 } from './serialize.mjs';
import { validateReceiptPackageV1 } from './validator.mjs';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_ATTEMPTS = 500;
const LOCK_DELAY_MS = 10;
const execFile = promisify(execFileCallback);
const NO_REPLACE_RENAME = '/usr/bin/mv';
const CAPABILITY_CODES = new Set(['EBADF', 'EISDIR', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

export class ReceiptPackageStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReceiptPackageStoreError';
    this.code = code;
    this.details = details;
    Object.assign(this, details);
  }
}

function storeError(code, message, details = {}, cause) {
  const error = new ReceiptPackageStoreError(code, message, details);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function assertReceiptHash(receiptHash) {
  if (typeof receiptHash !== 'string' || !RECEIPT_HASH_PATTERN.test(receiptHash)) {
    throw storeError('malformed_receipt_hash', 'receiptHash must be a 64-character lowercase SHA-256 hex digest');
  }
}

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function syncDirectory(path, details = {}) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await handle.sync();
  } catch (cause) {
    if (CAPABILITY_CODES.has(cause?.code)) {
      throw storeError('durability_unavailable', 'strict directory fsync is unavailable', details, cause);
    }
    throw cause;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function renameDirectoryNoReplace(source, destination, details) {
  try {
    await execFile(NO_REPLACE_RENAME, [
      '--no-clobber', '--no-copy', '--no-target-directory', '--', source, destination,
    ], { windowsHide: true });
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw storeError('durability_unavailable', 'Linux no-replace rename capability is unavailable', details, cause);
    }
    throw cause;
  }
  try {
    await lstat(source);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return;
    throw cause;
  }
  throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
}

function parsePackageBytes(bytesByName, errorCode, pathLabel) {
  const receiptPackage = {};
  try {
    for (const name of PACKAGE_MEMBER_NAMES) receiptPackage[name] = JSON.parse(bytesByName[name]);
    validateReceiptPackageV1(receiptPackage);
    const canonical = serializeReceiptPackageV1(receiptPackage);
    for (const name of PACKAGE_MEMBER_NAMES) {
      if (bytesByName[name] !== canonical[name]) {
        throw new Error(`${name} is not canonically serialized`);
      }
    }
  } catch (cause) {
    throw storeError(errorCode, `${pathLabel} does not contain a complete valid canonical receipt_package_v1`, {}, cause);
  }
  return receiptPackage;
}

async function readPackageDirectory(path, { errorCode, pathLabel, fault }) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (cause) {
    throw storeError(errorCode, `${pathLabel} cannot be read`, {}, cause);
  }
  const expected = new Set(PACKAGE_MEMBER_NAMES);
  if (entries.length !== PACKAGE_MEMBER_NAMES.length) {
    throw storeError(errorCode, `${pathLabel} has a missing or unexpected entry`);
  }
  for (const entry of entries) {
    if (!expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw storeError(errorCode, `${pathLabel} has a symlink, special file, directory, or unexpected member`, { entry: entry.name });
    }
  }
  const bytesByName = {};
  for (const name of PACKAGE_MEMBER_NAMES) {
    await fault?.('during_staged_readback', { member: name });
    let handle;
    try {
      handle = await open(join(path, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`${name} is not a regular file`);
      bytesByName[name] = await handle.readFile({ encoding: 'utf8' });
    } catch (cause) {
      throw storeError(errorCode, `${pathLabel} member cannot be read safely`, { member: name }, cause);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return parsePackageBytes(bytesByName, errorCode, pathLabel);
}

export function createReceiptPackageFsStore({ root, faultInjector } = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw storeError('explicit_package_root_required', 'an explicit package-store root is required');
  }
  if (faultInjector !== undefined && typeof faultInjector !== 'function') {
    throw new TypeError('faultInjector must be a function');
  }
  if (!Number.isInteger(fsConstants.O_DIRECTORY) || !Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw storeError('durability_unavailable', 'required directory and no-follow filesystem semantics are unavailable');
  }

  const packageRoot = resolve(root);
  const handles = new WeakMap();

  async function fault(point, context = {}) {
    if (faultInjector) await faultInjector(point, context);
  }

  async function ensureRoot() {
    try {
      const stat = await lstat(packageRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('root is not a real directory');
    } catch (cause) {
      throw storeError('staging_create_failed', 'package-store root cannot be prepared', {}, cause);
    }
  }

  function committedPath(receiptHash) {
    return join(packageRoot, receiptHash);
  }

  async function inspectInternal(receiptHash) {
    const path = committedPath(receiptHash);
    let stat;
    try {
      stat = await lstat(path);
    } catch (cause) {
      if (cause?.code === 'ENOENT') return { status: 'absent' };
      throw storeError('committed_package_invalid', 'committed package cannot be inspected', { receipt_hash: receiptHash }, cause);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storeError('committed_package_invalid', 'committed package entry is not a real directory', { receipt_hash: receiptHash });
    }
    const pkg = await readPackageDirectory(path, {
      errorCode: 'committed_package_invalid', pathLabel: 'committed package',
    });
    if (pkg['manifest.json'].receipt_hash !== receiptHash) {
      throw storeError('committed_package_invalid', 'committed directory identity does not match its package', { receipt_hash: receiptHash });
    }
    return {
      status: 'committed', receipt_hash: receiptHash,
      package_digest: pkg['manifest.json'].package_digest, location: path,
    };
  }

  async function inspect(receiptHash) {
    assertReceiptHash(receiptHash);
    await ensureRoot();
    return inspectInternal(receiptHash);
  }

  function requireHandle(stagingHandle) {
    if ((typeof stagingHandle !== 'object' && typeof stagingHandle !== 'function') || stagingHandle === null) {
      throw storeError('staging_handle_invalid', 'staging handle is invalid');
    }
    const metadata = handles.get(stagingHandle);
    if (!metadata) throw storeError('staging_handle_invalid', 'staging handle was not issued by this store');
    return metadata;
  }

  async function assertOwned(metadata) {
    let stat;
    try {
      stat = await lstat(metadata.path);
    } catch (cause) {
      throw storeError('staging_ownership_lost', 'owned staging directory is absent', { receipt_hash: metadata.receiptHash }, cause);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== metadata.dev || stat.ino !== metadata.ino) {
      throw storeError('staging_ownership_lost', 'staging directory identity changed', { receipt_hash: metadata.receiptHash });
    }
  }

  async function stage(receiptPackage) {
    let serialized;
    let receiptHash;
    let packageDigest;
    try {
      validateReceiptPackageV1(receiptPackage);
      serialized = serializeReceiptPackageV1(receiptPackage);
      receiptHash = receiptPackage['manifest.json'].receipt_hash;
      packageDigest = receiptPackage['manifest.json'].package_digest;
    } catch (cause) {
      throw storeError('invalid_receipt_package', 'stage accepts only a complete valid receipt_package_v1', {}, cause);
    }
    await ensureRoot();
    const path = join(packageRoot, `.${receiptHash}.${randomUUID()}.tmp`);
    try {
      await fault('before_staging_directory_create', { receipt_hash: receiptHash });
      await mkdir(path, { mode: DIRECTORY_MODE });
    } catch (cause) {
      throw storeError('staging_create_failed', 'exclusive staging-directory creation failed', { receipt_hash: receiptHash }, cause);
    }
    const initialStat = await lstat(path);
    const metadata = { path, receiptHash, packageDigest, dev: initialStat.dev, ino: initialStat.ino, state: 'staged' };
    const stagingHandle = Object.freeze(Object.create(null));
    handles.set(stagingHandle, metadata);
    try {
      for (const name of PACKAGE_MEMBER_NAMES) {
        let handle;
        try {
          handle = await open(join(path, name), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, FILE_MODE);
          await handle.writeFile(serialized[name], { encoding: 'utf8' });
          await fault('after_member_write', { member: name, receipt_hash: receiptHash });
          await handle.sync();
          await fault('after_member_fsync', { member: name, receipt_hash: receiptHash });
        } finally {
          await handle?.close();
        }
      }
    } catch (cause) {
      throw storeError('staging_write_failed', 'staging member write or fsync failed', { receipt_hash: receiptHash }, cause);
    }
    try {
      await fault('before_staging_directory_fsync', { receipt_hash: receiptHash });
      await syncDirectory(path, { receipt_hash: receiptHash });
      await fault('after_staging_directory_fsync', { receipt_hash: receiptHash });
      await fault('before_staged_readback', { receipt_hash: receiptHash });
      const stagedPackage = await readPackageDirectory(path, {
        errorCode: 'staging_validation_failed', pathLabel: 'staged package', fault,
      });
      if (stagedPackage['manifest.json'].receipt_hash !== receiptHash
          || stagedPackage['manifest.json'].package_digest !== packageDigest) {
        throw storeError('staging_ownership_lost', 'staged package identity changed', { receipt_hash: receiptHash });
      }
      metadata.memberIdentities = new Map();
      for (const name of PACKAGE_MEMBER_NAMES) {
        const stat = await lstat(join(path, name));
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw storeError('staging_ownership_lost', 'staged member identity changed', { receipt_hash: receiptHash, member: name });
        }
        metadata.memberIdentities.set(name, { dev: stat.dev, ino: stat.ino });
      }
      await fault('after_staged_validation', { receipt_hash: receiptHash });
    } catch (cause) {
      if (cause instanceof ReceiptPackageStoreError) throw cause;
      if (CAPABILITY_CODES.has(cause?.code)) throw storeError('durability_unavailable', 'strict staging durability is unavailable', { receipt_hash: receiptHash }, cause);
      throw storeError('staging_validation_failed', 'staged package durability/readback validation failed', { receipt_hash: receiptHash }, cause);
    }
    return { stagingHandle, receipt_hash: receiptHash, package_digest: packageDigest };
  }

  async function validateStage(stagingHandle) {
    const metadata = requireHandle(stagingHandle);
    if (metadata.state !== 'staged') throw storeError('staging_ownership_lost', 'staging handle is no longer active', { receipt_hash: metadata.receiptHash });
    await assertOwned(metadata);
    const pkg = await readPackageDirectory(metadata.path, {
      errorCode: 'staging_validation_failed', pathLabel: 'staged package', fault,
    });
    if (pkg['manifest.json'].receipt_hash !== metadata.receiptHash
        || pkg['manifest.json'].package_digest !== metadata.packageDigest) {
      throw storeError('staging_ownership_lost', 'staged package identity changed', { receipt_hash: metadata.receiptHash });
    }
    return { receipt_hash: metadata.receiptHash, package_digest: metadata.packageDigest };
  }

  async function acquireLock(receiptHash) {
    const path = join(packageRoot, `.${receiptHash}.lock`);
    await fault('before_lock_acquisition', { receipt_hash: receiptHash });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(path, { mode: DIRECTORY_MODE });
        await fault('after_lock_acquisition', { receipt_hash: receiptHash });
        return path;
      } catch (cause) {
        if (cause?.code !== 'EEXIST') {
          await rm(path, { recursive: true, force: true }).catch(() => {});
          if (cause instanceof ReceiptPackageStoreError) throw cause;
          throw storeError('package_store_locked', 'per-receipt package-store lock acquisition failed', { receipt_hash: receiptHash }, cause);
        }
        if (attempt + 1 < LOCK_ATTEMPTS) await sleep(LOCK_DELAY_MS);
      }
    }
    throw storeError('package_store_locked', 'per-receipt package-store lock remained held', { receipt_hash: receiptHash });
  }

  async function releaseLock(path, metadata, renamed) {
    try {
      await rm(path, { recursive: true });
      await syncDirectory(packageRoot, { receipt_hash: metadata.receiptHash });
    } catch (cause) {
      if (renamed) {
        throw storeError('commit_unknown', 'atomic rename occurred but lock-release durability was not confirmed', {
          receipt_hash: metadata.receiptHash,
          expected_package_digest: metadata.packageDigest,
        }, cause);
      }
      if (cause instanceof ReceiptPackageStoreError) throw cause;
      throw storeError('package_store_locked', 'per-receipt lock cleanup failed', { receipt_hash: metadata.receiptHash }, cause);
    }
  }

  async function assertOwnedMember(metadata, name) {
    const expected = metadata.memberIdentities?.get(name);
    let stat;
    try {
      stat = await lstat(join(metadata.path, name));
    } catch (cause) {
      throw storeError('staging_ownership_lost', 'owned staging member is absent', {
        receipt_hash: metadata.receiptHash, member: name,
      }, cause);
    }
    if (!expected || !stat.isFile() || stat.isSymbolicLink()
        || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw storeError('staging_ownership_lost', 'staging member identity changed', {
        receipt_hash: metadata.receiptHash, member: name,
      });
    }
  }

  async function removeOwnedStage(metadata) {
    await assertOwned(metadata);
    for (const name of PACKAGE_MEMBER_NAMES) {
      await assertOwned(metadata);
      await assertOwnedMember(metadata, name);
      await rm(join(metadata.path, name));
    }
    await assertOwned(metadata);
    await rmdir(metadata.path);
    metadata.state = 'removed';
  }

  async function cleanupStage(metadata, operation) {
    try {
      await fault('during_staging_cleanup', { receipt_hash: metadata.receiptHash, operation });
      await removeOwnedStage(metadata);
    } catch (cause) {
      throw storeError('abort_failed', 'owned staging-directory cleanup failed', { receipt_hash: metadata.receiptHash, operation }, cause);
    }
  }

  async function commit(stagingHandle, { expectedPackageDigest } = {}) {
    const metadata = requireHandle(stagingHandle);
    if (metadata.state !== 'staged') throw storeError('staging_ownership_lost', 'staging handle is no longer active', { receipt_hash: metadata.receiptHash });
    if (expectedPackageDigest !== metadata.packageDigest) {
      throw storeError('package_store_conflict', 'expected package digest does not match staged package', {
        receipt_hash: metadata.receiptHash, expected_package_digest: expectedPackageDigest,
        actual_package_digest: metadata.packageDigest,
      });
    }
    await ensureRoot();
    let lockPath;
    let renamed = false;
    try {
      lockPath = await acquireLock(metadata.receiptHash);
      await assertOwned(metadata);
      await validateStage(stagingHandle);
      const destination = await inspectInternal(metadata.receiptHash);
      if (destination.status === 'committed') {
        if (destination.package_digest !== metadata.packageDigest) {
          throw storeError('package_store_conflict', 'a different package is already committed for this receipt hash', {
            receipt_hash: metadata.receiptHash, expected_package_digest: metadata.packageDigest,
            actual_package_digest: destination.package_digest,
          });
        }
        await cleanupStage(metadata, 'unchanged_commit');
        return { ...destination, status: 'unchanged' };
      }
      await fault('before_rename', { receipt_hash: metadata.receiptHash });
      await assertOwned(metadata);
      for (const name of PACKAGE_MEMBER_NAMES) await assertOwnedMember(metadata, name);
      try {
        await renameDirectoryNoReplace(metadata.path, committedPath(metadata.receiptHash), {
          receipt_hash: metadata.receiptHash,
        });
      } catch (cause) {
        const reconciliation = await inspectInternal(metadata.receiptHash);
        if (reconciliation.status === 'committed') {
          if (reconciliation.package_digest === metadata.packageDigest) {
            await cleanupStage(metadata, 'rename_race');
            return { ...reconciliation, status: 'unchanged' };
          }
          throw storeError('package_store_conflict', 'a different package won the destination race', {
            receipt_hash: metadata.receiptHash, expected_package_digest: metadata.packageDigest,
            actual_package_digest: reconciliation.package_digest,
          }, cause);
        }
        throw storeError('unexpected_store_entry', 'atomic staging-directory rename failed without a committed destination', { receipt_hash: metadata.receiptHash }, cause);
      }
      renamed = true;
      metadata.state = 'committed';
      await fault('after_rename', { receipt_hash: metadata.receiptHash });
      await fault('before_parent_directory_fsync', { receipt_hash: metadata.receiptHash });
      await syncDirectory(packageRoot, { receipt_hash: metadata.receiptHash });
      await fault('after_parent_directory_fsync_before_response', { receipt_hash: metadata.receiptHash });
      const final = await inspectInternal(metadata.receiptHash);
      if (final.status !== 'committed' || final.package_digest !== metadata.packageDigest) {
        throw new Error('final committed package reconciliation failed');
      }
      return { ...final, status: 'committed' };
    } catch (cause) {
      if (renamed) {
        throw storeError('commit_unknown', 'atomic rename occurred but durable commit response was not confirmed', {
          receipt_hash: metadata.receiptHash, expected_package_digest: metadata.packageDigest,
        }, cause);
      }
      if (cause instanceof ReceiptPackageStoreError) throw cause;
      throw storeError('unexpected_store_entry', 'package commit failed before atomic publication', { receipt_hash: metadata.receiptHash }, cause);
    } finally {
      if (lockPath) await releaseLock(lockPath, metadata, renamed);
    }
  }

  async function abort(stagingHandle) {
    const metadata = requireHandle(stagingHandle);
    if (metadata.state === 'removed') return { status: 'already_absent' };
    if (metadata.state === 'committed') return { status: 'already_absent' };
    try {
      await fault('during_abort_cleanup', { receipt_hash: metadata.receiptHash });
      await removeOwnedStage(metadata);
      return { status: 'aborted' };
    } catch (cause) {
      if (cause instanceof ReceiptPackageStoreError
          && cause.code === 'staging_ownership_lost' && cause.cause?.code === 'ENOENT'
          && cause.member === undefined) {
        metadata.state = 'removed';
        return { status: 'already_absent' };
      }
      if (cause instanceof ReceiptPackageStoreError && cause.code === 'staging_ownership_lost') throw cause;
      throw storeError('abort_failed', 'owned staging-directory abort cleanup failed', { receipt_hash: metadata.receiptHash }, cause);
    }
  }

  async function readCommitted(receiptHash) {
    assertReceiptHash(receiptHash);
    await ensureRoot();
    const inspected = await inspectInternal(receiptHash);
    if (inspected.status === 'absent') return undefined;
    return readPackageDirectory(committedPath(receiptHash), {
      errorCode: 'committed_package_invalid', pathLabel: 'committed package',
    });
  }

  return Object.freeze({ inspect, stage, validateStage, commit, abort, readCommitted });
}
