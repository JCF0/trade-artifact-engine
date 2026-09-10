import { constants, openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson } from '../../src/verification-scope-v1-3/contract.mjs';
export const blocked = () => Error('PRIVATE_BINDING_STOPPED');
export function privateDirectoryV1(path) {
  const st = lstatSync(path);
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !st.isDirectory()
    || st.uid !== process.getuid() || (st.mode & 0o077)) throw blocked();
  return st;
}
export function fsyncDirectoryV1(path, expected = privateDirectoryV1(path)) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (st.dev !== expected.dev || st.ino !== expected.ino || st.uid !== expected.uid || (st.mode & 0o077)) throw blocked();
    fsyncSync(fd);
    const current = lstatSync(path);
    if (current.dev !== st.dev || current.ino !== st.ino || realpathSync(path) !== path) throw blocked();
  } finally { closeSync(fd); }
}
export function readBoundedFdV1(fd, maximum, owner, privateMode = true) {
  const st = fstatSync(fd);
  if (!st.isFile() || st.nlink !== 1 || st.uid !== owner || (st.mode & (privateMode ? 0o077 : 0o022))
    || st.size < 1 || st.size > maximum) throw blocked();
  const bytes = Buffer.alloc(st.size);
  let n = 0;
  try {
    while (n < bytes.length) { const k = readSync(fd, bytes, n, bytes.length-n, n); if (!k) throw blocked(); n += k; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, n)) throw blocked();
    const after = fstatSync(fd);
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw blocked();
    return bytes;
  } catch { bytes.fill(0); throw blocked(); }
}
export function parseCanonicalV1(bytes) {
  try { const value = JSON.parse(bytes.toString('utf8'));
    if (!Buffer.from(canonicalJson(value)).equals(bytes)) throw blocked(); return value;
  } catch { throw blocked(); }
}
export function readPrivateRecordV1(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return parseCanonicalV1(readBoundedFdV1(fd, 262144, process.getuid())); }
  finally { closeSync(fd); }
}
export function exclusiveRecordV1(path, value) {
  const bytes = Buffer.from(canonicalJson(value));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let n = 0; while (n < bytes.length) { const k = writeSync(fd, bytes, n); if (!k) throw blocked(); n += k; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
