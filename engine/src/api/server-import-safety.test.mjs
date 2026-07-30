#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const watchedRoots = [
  resolve('engine/data/cache'),
  resolve('engine/data/renders'),
];

async function snapshot(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const value = {
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    mtime_ms: stat.mtimeMs,
  };
  if (stat.isDirectory()) {
    value.entries = {};
    for (const name of (await readdir(path)).sort()) {
      value.entries[name] = await snapshot(resolve(path, name));
    }
  }
  return value;
}

const beforeFiles = await Promise.all(watchedRoots.map(snapshot));
const beforeListeners = process._getActiveHandles().filter(handle => handle?.constructor?.name === 'Server').length;
const serverModule = await import('./server.mjs');
const afterListeners = process._getActiveHandles().filter(handle => handle?.constructor?.name === 'Server').length;
const afterFiles = await Promise.all(watchedRoots.map(snapshot));

assert.equal(typeof serverModule.createApp, 'function');
assert.equal(afterListeners, beforeListeners);
assert.deepEqual(afterFiles, beforeFiles);

console.log('server app-builder import safety: PASS');
