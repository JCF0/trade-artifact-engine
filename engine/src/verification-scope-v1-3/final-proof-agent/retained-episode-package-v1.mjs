import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertExactFields, cloneAndFreeze } from '../contract.mjs';

const MAX_MEMBER = 8 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_MEMBERS = 512;
const DIGEST = /^[0-9a-f]{64}$/;
const LOADED = new WeakSet();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export class RetainedEpisodePackageError extends Error {
  constructor(code) { super(code); this.name = 'RetainedEpisodePackageError'; this.code = code; }
}
function stop(code) { throw new RetainedEpisodePackageError(code); }
function pathName(name) {
  if (typeof name !== 'string' || name.length > 240 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    stop('RETAINED_PATH_INVALID');
  }
  return name;
}
// Reject duplicate keys before they can disappear in JSON.parse. Only the existing
// rentEpoch u64 contract admits an unsafe integer token as an exact decimal string.
function parse(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { stop('RETAINED_JSON_INVALID'); }
  let i = 0, nodes = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? 'x')) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    stop('RETAINED_JSON_INVALID');
  }
  function value(depth, key) {
    if (++nodes > 200000 || depth > 64) stop('RETAINED_JSON_BOUNDS');
    ws(); const c = text[i];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      i++; ws(); const object = c === '{', result = object ? {} : [], keys = new Set(), end = object ? '}' : ']';
      if (text[i] === end) { i++; return result; }
      while (true) {
        ws(); let field = '';
        if (object) {
          if (text[i] !== '"') stop('RETAINED_JSON_INVALID');
          field = string();
          if (keys.has(field)) stop('RETAINED_JSON_DUPLICATE_KEY');
          keys.add(field); ws(); if (text[i++] !== ':') stop('RETAINED_JSON_INVALID');
        }
        const child = value(depth + 1, field);
        if (object) Object.defineProperty(result, field, { value: child, enumerable: true, writable: true, configurable: true });
        else result.push(child);
        ws(); if (text[i] === end) { i++; return result; }
        if (text[i++] !== ',') stop('RETAINED_JSON_INVALID');
      }
    }
    for (const [token, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(token, i)) { i += token.length; return v; }
    }
    const token = text.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0];
    if (!token) stop('RETAINED_JSON_INVALID');
    i += token.length; const n = Number(token);
    if (!Number.isFinite(n) || Object.is(n, -0)) stop('RETAINED_JSON_NUMBER_INVALID');
    if (Number.isInteger(n) && !Number.isSafeInteger(n)) {
      if (key !== 'rentEpoch' || !/^(?:0|[1-9][0-9]*)$/.test(token) || BigInt(token) > 18446744073709551615n) {
        stop('RETAINED_JSON_NUMBER_INVALID');
      }
      return token;
    }
    return n;
  }
  try { const result = value(0, ''); ws(); if (i !== text.length) stop('RETAINED_JSON_INVALID'); return result; }
  catch (error) { if (error instanceof RetainedEpisodePackageError) throw error; stop('RETAINED_JSON_INVALID'); }
}
function read(root, name, maximum) {
  const path = join(root, pathName(name));
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) stop('RETAINED_FILE_INVALID');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) stop('RETAINED_FILE_CHANGED');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0, count;
    while (offset < bytes.length && (count = readSync(fd, bytes, offset, bytes.length - offset, null)) !== 0) offset += count;
    const after = fstatSync(fd), pathAfter = lstatSync(path);
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
        || pathAfter.dev !== stat.dev || pathAfter.ino !== stat.ino || pathAfter.nlink !== 1) stop('RETAINED_FILE_CHANGED');
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}
export function isLoadedRetainedEpisodePackageV1(value) { return LOADED.has(value); }
export function loadRetainedEpisodePackageV1(input) {
  assertExactFields(input, ['root', 'expected_manifest_sha256'], 'retained_episode_load');
  const { root, expected_manifest_sha256: expected } = input;
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || !DIGEST.test(expected)) stop('RETAINED_INPUT_INVALID');
  let rootFd;
  try {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) stop('RETAINED_ROOT_INVALID');
    rootFd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const rootStat = fstatSync(rootFd), namedRoot = lstatSync(root);
    if (rootStat.dev !== namedRoot.dev || rootStat.ino !== namedRoot.ino) stop('RETAINED_ROOT_INVALID');
    // Linux descriptor-relative flat members: replacing the named root cannot
    // redirect any subsequent member read to an ambient directory.
    const anchoredRoot = `/proc/self/fd/${rootFd}`;
    const inventory = [];
    function walk(relative = '', depth = 0) {
      if (depth > 8) stop('RETAINED_INVENTORY_BOUNDS');
      const entries = readdirSync(join(anchoredRoot, relative));
      if (entries.length > MAX_MEMBERS) stop('RETAINED_INVENTORY_BOUNDS');
      for (const entry of entries) {
        const name = relative ? `${relative}/${entry}` : entry; pathName(name);
        const stat = lstatSync(join(anchoredRoot, name));
        if (stat.isSymbolicLink()) stop('RETAINED_FILE_INVALID');
        if (stat.isDirectory()) stop('RETAINED_INVENTORY_MISMATCH');
        else if (stat.isFile() && stat.nlink === 1) inventory.push(name);
        else stop('RETAINED_FILE_INVALID');
        if (inventory.length > MAX_MEMBERS + 1) stop('RETAINED_INVENTORY_BOUNDS');
      }
    }
    walk();
    const manifestBytes = read(anchoredRoot, 'manifest.json', 256 * 1024);
    if (hash(manifestBytes) !== expected) stop('RETAINED_MANIFEST_MISMATCH');
    const manifest = parse(manifestBytes);
    assertExactFields(manifest, ['version', 'members'], 'retained_episode_manifest');
    if (manifest.version !== 'artifact_retained_episode_package_v1' || !Array.isArray(manifest.members)
        || !manifest.members.length || manifest.members.length > MAX_MEMBERS) stop('RETAINED_MANIFEST_INVALID');
    const files = new Map(); let total = 0, previous = '';
    for (const member of manifest.members) {
      assertExactFields(member, ['path', 'bytes', 'sha256'], 'retained_member');
      pathName(member.path);
      if (member.path === 'manifest.json' || member.path <= previous || !DIGEST.test(member.sha256)
          || !Number.isSafeInteger(member.bytes) || member.bytes < 1 || member.bytes > MAX_MEMBER) stop('RETAINED_MEMBER_INVALID');
      previous = member.path; total += member.bytes;
      if (total > MAX_TOTAL) stop('RETAINED_INVENTORY_BOUNDS');
      const bytes = read(anchoredRoot, member.path, member.bytes);
      if (bytes.length !== member.bytes || hash(bytes) !== member.sha256) stop('RETAINED_MEMBER_MISMATCH');
      files.set(member.path, bytes);
    }
    if (JSON.stringify(inventory.sort()) !== JSON.stringify(['manifest.json', ...files.keys()].sort())) stop('RETAINED_INVENTORY_MISMATCH');
    const loaded = Object.freeze({
      manifest_sha256: expected, inventory: cloneAndFreeze(manifest.members),
      readMemberV1(name) { if (!files.has(name)) stop('RETAINED_MEMBER_MISSING'); return Buffer.from(files.get(name)); },
      parseMemberV1(name) { if (!files.has(name)) stop('RETAINED_MEMBER_MISSING'); return parse(files.get(name)); },
    });
    LOADED.add(loaded); return loaded;
  } catch (error) {
    if (error instanceof RetainedEpisodePackageError) throw error;
    stop('RETAINED_LOAD_UNAVAILABLE');
  } finally {
    if (rootFd !== undefined) closeSync(rootFd);
  }
}
