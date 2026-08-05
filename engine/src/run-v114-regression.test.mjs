#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNNER_PATH = resolve(REPOSITORY_ROOT, 'engine/src/run-v114-regression.mjs');
const WALLET_ACQUISITION_ROOT = resolve(REPOSITORY_ROOT, 'engine/src/wallet-acquisition');
const DOCUMENTATION_PATHS = [
  'README.md',
  'engine/docs/v1.14-release-notes.md',
  'engine/docs/v1.14-wallet-wide-acquisition.md',
  'engine/docs/v1.14-operations.md',
  'engine/docs/v1.14-limitations.md',
  'engine/docs/wallet-candidate-set-v1.md',
  'engine/docs/wallet-candidate-set-v1-evidence.md',
  'engine/docs/wallet-candidate-set-v1-limitations.md',
  'engine/docs/wallet-candidate-set-v1-selection.md',
];

function read(relativePath) {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8');
}

test('v1.14 runner discovers the complete wallet-acquisition suite and names the retained and integration gates', () => {
  const runner = readFileSync(RUNNER_PATH, 'utf8');
  const testFiles = readdirSync(WALLET_ACQUISITION_ROOT)
    .filter(name => name.endsWith('.test.mjs'))
    .sort();
  assert.ok(testFiles.length > 0);
  assert.match(runner, /readdirSync\(WALLET_ACQUISITION_ROOT/);
  assert.match(runner, /endsWith\('\.test\.mjs'\)/);
  assert.ok(testFiles.includes('retained-provider-acceptance.test.mjs'));
  assert.ok(testFiles.includes('candidate-set-integration.test.mjs'));
  assert.match(runner, /retained-provider-acceptance\.test\.mjs/);
  assert.match(runner, /candidate-set-integration\.test\.mjs/);
});

test('v1.14 runner is direct-Node, safety-adapted, capability-minimal, and excludes live and commit-bearing paths', () => {
  const runner = readFileSync(RUNNER_PATH, 'utf8');
  assert.match(runner, /safety-adapted v1\.13 baseline gate/);
  assert.match(runner, /process\.execPath/);
  assert.match(runner, /run-v113-regression\.mjs/);
  assert.doesNotMatch(runner, /spawnSync\(\s*['"]npm['"]/);
  assert.doesNotMatch(runner, /run-live|live-validation|controlled-live/i);
  assert.doesNotMatch(runner, /process\.env|\.env\b|HELIUS_API_KEY/);
  assert.doesNotMatch(runner, /targeted-orchestrator\.test\.mjs|package-store|publication|upload|signing|minting|deployment/);
});

test('v1.14 documentation consistently distinguishes implemented acquisition, retained evidence, synthetic RPC, and future live validation', () => {
  const documents = Object.fromEntries(DOCUMENTATION_PATHS.map(path => [path, read(path)]));
  const combined = Object.values(documents).join('\n');
  for (const obsolete of [
    /does not implement (?:a )?live wallet-wide Helius adapter/i,
    /future live adapter must prove/i,
    /does not acquire live wallet history/i,
  ]) assert.doesNotMatch(combined, obsolete);
  assert.match(combined, /provider-attested/i);
  assert.match(combined, /not (?:a )?trustless cryptographic proof/i);
  assert.match(combined, /retained Solana RPC envelopes do not currently exist/i);
  assert.match(combined, /synthetic finalized RPC/i);
  assert.match(combined, /live validation (?:has not occurred|was not performed|remains separately authorized)/i);
  for (const name of ['jup_buy','jup_sell','ray_buy','ray_sell','jupiter_close_account_swap']) assert.match(combined, new RegExp(`\\b${name}\\b`));
  assert.match(documents['engine/docs/v1.14-operations.md'], /node engine\/src\/run-v114-regression\.mjs/);
});

test('v1.14 documentation pins both retained package identities and all ten member hashes', () => {
  const releaseNotes = read('engine/docs/v1.14-release-notes.md');
  for (const digest of [
    '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
    '5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278',
    'd28c5a58b920f526c5ed9e08e4e5b034d99285cd7182a1374f1eb9c10697c6ac',
    'c636cfda958eb87341d3225d33b53b7dc9dcf157def5cc3a054eb56cd4e9eb61',
    'd8d716459707f3b8c7f95b2f6e64a3c1f1faf91e62629e0477213e4b4ed9ffbd',
    '2ce234ccedcb52ac555f49129de7a3b6660506b04ed452c02503ec626646f1f6',
    '851c283e7e321bee61a939f1b39dbfb1f09ec038cdd078ceca50c8f7167c6ad0',
    '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
    '25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2',
    '777987cf14a3e41034923a6acc0e87ce15ec7affef68b0e3fb32890ad24bd695',
    '94717ca77018826e88bf39313c7b4b810ade1d42ed9f507809c649f1f6f3f2cb',
    '4664d29a151bba54051c4a8ef6044990a2ca474a4b45a421536106e9fa5d0ea8',
    '9fffd0746b49b5e3b89dbf113675c76290c7ae10f99542a23b1c385e3c75b41e',
    '808c2d03cd54bb13ed418ea034075dc8b523cb01e6a9ce3359d2959498141e6d',
  ]) assert.match(releaseNotes, new RegExp(digest));
});

assert.equal(basename(import.meta.filename), 'run-v114-regression.test.mjs');
