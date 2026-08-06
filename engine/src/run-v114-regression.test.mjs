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
  'engine/docs/verifier_flow.md',
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

test('v1.14 documentation distinguishes historical live runs and requires a fresh post-remediation gate', () => {
  const documents = Object.fromEntries(DOCUMENTATION_PATHS.map(path => [path, read(path)]));
  const combined = Object.values(documents).join('\n');
  for (const obsolete of [
    /does not implement (?:a )?live wallet-wide Helius adapter/i,
    /future live adapter must prove/i,
    /does not acquire live wallet history/i,
    /live validation (?:has not occurred|was not performed)/i,
    /no further live (?:rerun|re-run) is required before tagging/i,
    /post-hardening live release gate is complete/i,
  ]) assert.doesNotMatch(combined, obsolete);
  assert.match(combined, /provider-attested/i);
  assert.match(combined, /not (?:a )?trustless cryptographic proof/i);
  assert.match(combined, /no exact retained finalized RPC transcript exists/i);
  assert.match(combined, /synthetic finalized RPC/i);
  assert.match(combined, /first pre-hardening/i);
  assert.match(combined, /distinct later post-hardening/i);
  assert.match(combined, /post-hardening[^\n]*PASS/i);
  assert.match(combined, /one approved public Solana mainnet-beta wallet/i);
  assert.match(combined, /lookback_7d_v1/);
  assert.match(combined, /two pages/i);
  assert.match(combined, /historical bound reached/i);
  assert.match(combined, /76 canonical signatures/i);
  assert.match(combined, /five in-window/i);
  assert.match(combined, /five Enhanced/i);
  assert.match(combined, /1 supported, 0 unsupported, 1 ambiguous, 3 unrelated, (?:and )?0 failed/i);
  assert.match(combined, /one normalized event/i);
  assert.match(combined, /one localized finding/i);
  assert.match(combined, /one blocked summary/i);
  assert.match(combined, /zero candidates(?: and|\/selectable candidates|, and) zero selectable candidates/i);
  assert.match(combined, /zero retries and zero timeouts/i);
  assert.match(combined, /acquisition, normalization, classification, pagination, historical-bound, and chain-boundary gates (?:were )?proven/i);
  assert.match(combined, /no cap, truncation, partial result, or provider uncertainty/i);
  assert.match(combined, /no (?:live candidate resolution or )?Slice 7 invocation occurred because there was no selectable candidate/i);
  assert.match(combined, /API key and raw provider bodies were absent from the sanitized report/i);
  assert.match(combined, /classification totals matched the first pre-hardening run/i);
  assert.match(combined, /zero candidates was a valid result, not a validation failure/i);
  assert.match(combined, /deterministic remediation is complete/i);
  assert.match(combined, /one fresh post-remediation controlled live validation is still required before tagging/i);
  assert.match(combined, /v1\.14\.0 is not yet tagged/i);
  assert.match(combined, /tracked tree intentionally contains (?:exactly )?(?:the )?five exact retained Helius fixture bodies|tracked tree intentionally contains exactly five retained Helius fixture bodies/i);
  assert.match(combined, /controlled-live raw responses are not retained/i);
  assert.match(combined, /Artifact deterministically reconstructs supported trades from provider-attested on-chain evidence and exposes the evidence boundaries and limitations required to reproduce its result\./i);
  assert.doesNotMatch(documents['README.md'], /fully verifiable trade|Anyone can independently|Anyone can verify a trade receipt independently|full re-derivation from raw transactions/i);
  assert.doesNotMatch(documents['engine/docs/verifier_flow.md'], /No proprietary tools, API keys, or trust relationships required|Full Re-Derivation \(Highest Assurance\)|Trades actually happened as claimed|strongest possible verification/i);
  assert.match(combined, /5f6b167ba07671e60ea3b9b09c5f65a5d8b98cf9e87bf810b5efa69bd42e1b76/);
  assert.match(combined, /1,951 bytes/);
  assert.match(combined, /(?:mode )?`?0600`?/i);
  assert.doesNotMatch(combined, /BJsHXqhTWD4ECKXmhRNEnaZjd5ymDiZMyjFJzYuzCzGy/);
  assert.doesNotMatch(combined, /(?<!No )live candidate resolution (?:occurred|was performed)|(?<!No live candidate resolution or )Slice 7 invocation occurred|Slice 7 (?:was invoked|was performed)/i);
  assert.doesNotMatch(combined, /v1\.14 (?:has been|is already) tagged/i);
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
