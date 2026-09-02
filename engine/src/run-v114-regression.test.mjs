#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverWalletAcquisitionTestsV1, parseGitLsFilesZV1, parseTopLevelTapV1, validateCanonicalTestExecutionSetWithinRootV1, validateTrackedLiveReportPathsV1, validateWalletTestExecutionSetV1 } from './run-v114-regression.mjs';

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
  'engine/docs/wallet-candidate-set-v1-privacy.md',
  'engine/docs/wallet-candidate-set-v1-selection.md',
  'engine/docs/verifier_flow.md',
];
const STALE_IDENTITY_VALIDATION_PATTERNS = Object.freeze([
  /(?:wallet|transaction hash|blockhash|mint)[^\n]*(?:only required to be|only validated as|validated only as) non-?empty(?: strings?)?/i,
  /until (?:those fields receive equivalent )?lexical (?:validation is hardened|hardening)/i,
  /lexical and sensitive-value validation still depends partly on the trusted provider projection/i,
]);

function read(relativePath) {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8');
}

test('v1.14 runner discovers the complete wallet-acquisition suite and names the retained and integration gates', () => {
  const runner = readFileSync(RUNNER_PATH, 'utf8');
  const testFiles = readdirSync(WALLET_ACQUISITION_ROOT)
    .filter(name => name.endsWith('.test.mjs'))
    .sort();
  assert.ok(testFiles.length > 0);
  assert.match(runner, /readdirSync\(root, \{ withFileTypes: true \}\)/);
  assert.match(runner, /endsWith\('\.test\.mjs'\)/);
  assert.ok(testFiles.includes('retained-provider-acceptance.test.mjs'));
  assert.ok(testFiles.includes('candidate-set-integration.test.mjs'));
  assert.match(runner, /retained-provider-acceptance\.test\.mjs/);
  assert.match(runner, /candidate-set-integration\.test\.mjs/);
  assert.match(runner, /run-controlled-live-validation\.test\.mjs/);
  assert.deepEqual(discoverWalletAcquisitionTestsV1().map(path => basename(path)), testFiles);
  assert.match(runner, /for \(const file of files\)/);
  assert.match(runner, /strictTapChild\(file/);
});

test('v1.14 runner is direct-Node, safety-adapted, excludes a live command, and accurately names offline operator fixtures', () => {
  const runner = readFileSync(RUNNER_PATH, 'utf8');
  assert.match(runner, /safety-adapted v1\.13 baseline gate/);
  assert.match(runner, /process\.execPath/);
  assert.match(runner, /run-v113-regression\.mjs/);
  assert.doesNotMatch(runner, /spawnSync\(\s*['"]npm['"]/);
  assert.doesNotMatch(runner, /run-controlled-live-validation\.mjs['"]/);
  assert.match(runner, /Offline controlled-live operator tests use injected ports/);
  assert.doesNotMatch(runner, /process\.env|\.env\b|HELIUS_API_KEY/);
  assert.doesNotMatch(runner, /targeted-orchestrator\.test\.mjs|from ['"][^'"]*(?:package-store|publication|upload|signing|minting|deployment)/);
});

function tap(records, plan = records.length, summaries = {}) {
  const pass = records.filter(record => /^ok\b/.test(record) && !/#\s*(?:SKIP|TODO|CANCELLED)/i.test(record)).length;
  const fail = records.filter(record => /^not ok\b/.test(record) && !/#\s*(?:SKIP|TODO|CANCELLED)/i.test(record)).length;
  const skipped = records.filter(record => /#\s*SKIP/i.test(record)).length;
  const todo = records.filter(record => /#\s*TODO/i.test(record)).length;
  const cancelled = records.filter(record => /#\s*CANCELLED/i.test(record)).length;
  const counts = { tests: records.length, pass, fail, cancelled, skipped, todo, ...summaries };
  return `TAP version 13\n${records.join('\n')}\n1..${plan}\n${Object.entries(counts).map(([name, value]) => `# ${name} ${value}`).join('\n')}\n`;
}

test('v1.14 TAP parser accepts one complete dense passing stream', () => {
  assert.deepEqual(parseTopLevelTapV1(tap(['ok 1 - first', 'ok 2 - second'])), {
    tests: 2, pass: 2, fail: 0, skipped: 0, todo: 0, cancelled: 0,
  });
});

const COMPATIBILITY_PROBE_NESTED_TAP_SHAPE = `TAP version 13
ok 1 - first
ok 2 - second
ok 3 - third
ok 4 - fourth
ok 5 - fifth
ok 6 - sixth
ok 7 - seventh
ok 8 - eighth
ok 9 - ninth
ok 10 - tenth
ok 11 - eleventh
ok 12 - twelfth
ok 13 - thirteenth
# Subtest: rejects one-element array responses for every singleton RPC request class
    # Subtest: standard Token
    ok 1 - standard Token
    # Subtest: standard Token-2022
    ok 2 - standard Token-2022
    # Subtest: future-floor
    ok 3 - future-floor
    # Subtest: V2
    ok 4 - V2
    1..4
ok 14 - rejects one-element array responses for every singleton RPC request class
ok 15 - fifteenth
ok 16 - sixteenth
ok 17 - seventeenth
1..17
# tests 21
# suites 0
# pass 21
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

test('v1.14 TAP parser accepts the maintained compatibility-probe nested TAP shape', () => {
  assert.deepEqual(parseTopLevelTapV1(COMPATIBILITY_PROBE_NESTED_TAP_SHAPE), {
    tests: 21, pass: 21, fail: 0, skipped: 0, todo: 0, cancelled: 0,
  });
});

test('v1.14 TAP parser validates multiple nested subtest plans without confusing their local ordinals with top-level ordinals', () => {
  const nested = `TAP version 13
# Subtest: parent one
    ok 1 - child one
    ok 2 - child two
    1..2
ok 1 - parent one
# Subtest: parent two
    ok 1 - child one
    1..1
ok 2 - parent two
1..2
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
  assert.deepEqual(parseTopLevelTapV1(nested), {
    tests: 5, pass: 5, fail: 0, skipped: 0, todo: 0, cancelled: 0,
  });
});

test('v1.14 TAP parser fails closed against ordinal, plan, status, directive, summary, and truncation attacks', () => {
  const valid = tap(['ok 1 - first', 'ok 2 - second']);
  const nestedSummary = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  for (const attack of [
    tap(['ok 1 - first', 'ok 1 - duplicate']),
    tap(['ok 1 - first'], 2),
    tap(['ok 1 - first', 'ok 3 - sparse']),
    valid.replace('1..2\n', '1..2\n1..2\n'),
    valid.replace('1..2\n', ''),
    valid.replace('1..2\n', '1..2\nok 3 - after\n'),
    tap(['ok 1 - first'], 1, { pass: 0, fail: 1 }),
    tap(['not ok 1 - failing'], 1, { pass: 1, fail: 0 }),
    tap(['ok 1 - skipped # SKIP']),
    tap(['ok 1 - todo # TODO']),
    tap(['not ok 1 - cancelled # CANCELLED']),
    COMPATIBILITY_PROBE_NESTED_TAP_SHAPE.replace('    1..4\n', ''),
    COMPATIBILITY_PROBE_NESTED_TAP_SHAPE.replace('    ok 4 - V2\n', '    ok 5 - V2\n'),
    COMPATIBILITY_PROBE_NESTED_TAP_SHAPE.replace('    1..4\n', '    1..3\n'),
    COMPATIBILITY_PROBE_NESTED_TAP_SHAPE.replace('# pass 21\n', '# pass 21\n# pass 20\n'),
    COMPATIBILITY_PROBE_NESTED_TAP_SHAPE.replace('    ok 2 - standard Token-2022\n', '    ok 2 - standard Token-2022\n    oops 3 - malformed nested result\n'),
    COMPATIBILITY_PROBE_NESTED_TAP_SHAPE.replace('    ok 2 - standard Token-2022\n', '    ok 2 - standard Token-2022\n    Bail out! child aborted\n'),
    `TAP version 13\nok 1 - parent\n1..1\n    ok 1 - late child\n    1..1\n${nestedSummary}`,
    `TAP version 13\n${nestedSummary}ok 1 - first\nok 2 - second\n1..2\n`,
    `TAP version 13\n# Subtest: parent one\n    ok 1 - child one\nok 1 - parent one\n# Subtest: parent two\n    ok 2 - child two\n    1..2\nok 2 - parent two\n1..2\n# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
    `TAP version 13\n# Subtest: parent\n    # Subtest: nested parent\n        ok 1 - deep child\n    ok 1 - nested parent\n    1..1\n        1..1\nok 1 - parent\n1..1\n# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
    `TAP version 13\n    1..0\n    1..0\nok 1 - parent\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
    `TAP version 13\nok 1 - pass\n1..1\n# Subtest: unattached late group\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
    `TAP version 13\nok 1 - pass\n  ---\n  [definitely invalid yaml\n  ...\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
    `TAP version 13\nok 1 - pass\n  ---\n  ...\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
    `TAP version 13\nok 1 - pass\n  ---\n  arbitrary: field\n  ...\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`,
    valid.slice(0, -1),
    `${valid}garbage\n`,
  ]) assert.throws(() => parseTopLevelTapV1(attack));
});

test('v1.14 strict child result requires both a zero exit and internally consistent passing TAP', async () => {
  const { validateStrictTapChildResultV1 } = await import('./run-v114-regression.mjs');
  assert.equal(typeof validateStrictTapChildResultV1, 'function');
  const greenOutput = tap(['ok 1 - passing']);
  const greenResult = { status: 0, signal: null, error: undefined, stdout: greenOutput, stderr: '' };
  assert.equal(validateStrictTapChildResultV1(greenResult, 'synthetic child').ok, true);
  assert.equal(validateStrictTapChildResultV1({ ...greenResult, status: 1 }, 'synthetic child').ok, false);

  const contradictoryOutput = greenOutput.replace('# pass 1\n', '# pass 0\n').replace('# fail 0\n', '# fail 1\n');
  const contradictory = validateStrictTapChildResultV1({ ...greenResult, stdout: contradictoryOutput }, 'synthetic child');
  assert.equal(contradictory.ok, false);
  assert.match(contradictory.details, /inconsistent TAP pass summary/);
});

test('wallet-acquisition discovery rejects alternate roots and returns every current file exactly once', () => {
  const discovered = discoverWalletAcquisitionTestsV1();
  assert.equal(new Set(discovered).size, discovered.length);
  assert.deepEqual(discovered.map(path => basename(path)), readdirSync(WALLET_ACQUISITION_ROOT)
    .filter(name => name.endsWith('.test.mjs')).sort());
  assert.throws(() => discoverWalletAcquisitionTestsV1(resolve(WALLET_ACQUISITION_ROOT, '..')));
  assert.equal(validateWalletTestExecutionSetV1(discovered, discovered), true);
  assert.throws(() => validateWalletTestExecutionSetV1(discovered, discovered.slice(1)));
  assert.throws(() => validateWalletTestExecutionSetV1(discovered, [...discovered, discovered[0]]));
  assert.throws(() => validateWalletTestExecutionSetV1(discovered, [...discovered.slice(0, -1), resolve(WALLET_ACQUISITION_ROOT, '../unexpected.test.mjs')]));
});

test('wallet-acquisition execution confinement accepts valid edge basenames and rejects every canonical escape', t => {
  const container = mkdtempSync(join(tmpdir(), 'artifact-v114-test-root-'));
  const root = resolve(container, 'wallet-acquisition');
  mkdirSync(root);
  t.after(() => rmSync(container, { recursive: true, force: true }));
  const ordinary = resolve(root, 'ordinary.test.mjs');
  const twoDots = resolve(root, '..edge.test.mjs');
  const threeDots = resolve(root, '...test.mjs');
  const outside = resolve(container, 'outside.test.mjs');
  for (const file of [ordinary, twoDots, threeDots, outside]) writeFileSync(file, 'export {};\n', { flag: 'wx' });
  const valid = [ordinary, twoDots, threeDots].sort();
  assert.equal(validateCanonicalTestExecutionSetWithinRootV1(valid, valid, root), true);
  assert.throws(() => validateCanonicalTestExecutionSetWithinRootV1([resolve(root, '..')], [resolve(root, '..')], root));
  assert.throws(() => validateCanonicalTestExecutionSetWithinRootV1([resolve(root, '../outside.test.mjs')], [resolve(root, '../outside.test.mjs')], root));
  assert.throws(() => validateCanonicalTestExecutionSetWithinRootV1([outside], [outside], root));

  const sibling = `${root}-evil`;
  mkdirSync(sibling);
  const siblingFile = resolve(sibling, 'escape.test.mjs');
  writeFileSync(siblingFile, 'export {};\n', { flag: 'wx' });
  assert.throws(() => validateCanonicalTestExecutionSetWithinRootV1([siblingFile], [siblingFile], root));

  const link = resolve(root, 'link.test.mjs');
  try {
    symlinkSync(outside, link);
    assert.throws(() => validateCanonicalTestExecutionSetWithinRootV1([link], [link], root));
  } catch (error) {
    if (!['EPERM','EACCES','ENOTSUP'].includes(error?.code)) throw error;
  }
  assert.throws(() => validateCanonicalTestExecutionSetWithinRootV1(valid, [ordinary, twoDots], root));
  assert.throws(() => validateCanonicalTestExecutionSetWithinRootV1(valid, [...valid, ordinary], root));
  assert.throws(() => validateCanonicalTestExecutionSetWithinRootV1(valid, [...valid.slice(0, -1), outside], root));
  assert.throws(() => validateCanonicalTestExecutionSetWithinRootV1(valid, [...valid].reverse(), root));
});

test('complete NUL-delimited Git index paths are parsed and validated without worktree filtering', () => {
  for (const path of [
    'engine/docs/validation_report.md',
    'engine/docs/validation_report_batch2.md',
    'engine/docs/artifact-v114-live-validation-report.json',
  ]) assert.throws(() => validateTrackedLiveReportPathsV1([path]));
  assert.deepEqual(parseGitLsFilesZV1('allowed.txt\0missing-but-tracked.txt\0'), ['allowed.txt','missing-but-tracked.txt']);
  assert.equal(validateTrackedLiveReportPathsV1(parseGitLsFilesZV1('allowed.txt\0missing-but-tracked.txt\0')), true);
  assert.throws(() => validateTrackedLiveReportPathsV1(parseGitLsFilesZV1('engine/docs/validation_report.md\0')));
  assert.throws(() => validateTrackedLiveReportPathsV1(parseGitLsFilesZV1('engine/docs/artifact-v114-live-validation-report.json\0')));
  for (const malformed of ['unterminated', 'one\0\0two\0', '/absolute\0', '../outside\0', 'back\\slash\0']) {
    assert.throws(() => parseGitLsFilesZV1(malformed));
  }
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
  assert.equal(tracked.status, 0);
  const indexedPaths = parseGitLsFilesZV1(tracked.stdout);
  assert.equal(indexedPaths.length > 0, true);
  assert.equal(validateTrackedLiveReportPathsV1(indexedPaths), true);
});

test('documentation stale-identity checks cover prior nonempty-string and trusted-projection wording', () => {
  for (const stale of [
    'wallet and transaction hash fields are currently validated only as nonempty strings',
    'wallet and mint fields are currently only required to be nonempty',
    'until those fields receive equivalent lexical hardening',
    'Lexical and sensitive-value validation still depends partly on the trusted provider projection',
  ]) assert.equal(STALE_IDENTITY_VALIDATION_PATTERNS.some(pattern => pattern.test(stale)), true);
});

test('v1.14 documentation records the completed final post-patch-3 live release gate', () => {
  const documents = Object.fromEntries(DOCUMENTATION_PATHS.map(path => [path, read(path)]));
  const combined = Object.values(documents).join('\n');
  for (const obsolete of [
    /does not implement (?:a )?live wallet-wide Helius adapter/i,
    /future live adapter must prove/i,
    /does not acquire live wallet history/i,
    /live validation (?:has not occurred|was not performed)/i,
    /one final controlled live validation is required after (?:this )?patch(?: 3)? before tagging/i,
    /one final post-patch-3 controlled live validation is required/i,
    /do not satisfy this post-patch rerun requirement/i,
    ...STALE_IDENTITY_VALIDATION_PATTERNS,
  ]) assert.doesNotMatch(combined, obsolete);
  assert.match(combined, /provider-attested/i);
  assert.match(combined, /transaction signatures and `?tx_hash`? values[^\n]*Base58[^\n]*exactly 64 bytes/i);
  assert.match(combined, /wallets, mints, token accounts, ordinary accounts, program IDs, fee payers, and blockhashes[^\n]*Base58[^\n]*exactly 32 bytes/i);
  assert.match(combined, /do not prove provider provenance, account ownership, semantic correctness, or trustless historical completeness/i);
  assert.match(combined, /not (?:a )?trustless cryptographic proof/i);
  assert.match(combined, /no exact retained finalized RPC transcript exists/i);
  assert.match(combined, /synthetic finalized RPC/i);
  assert.match(combined, /first pre-hardening/i);
  assert.match(combined, /distinct later post-hardening/i);
  assert.match(combined, /post-hardening[^\n]*PASS/i);
  assert.match(combined, /final post-remediation controlled live validation[^\n]*PASS/i);
  assert.match(combined, /final post-patch-3 controlled live validation[^\n]*PASS/i);
  assert.match(combined, /final authoritative release-gate run/i);
  assert.match(combined, /one approved public Solana mainnet-beta wallet/i);
  assert.match(combined, /lookback_7d_v1/);
  assert.match(combined, /finalized anchor slot[^\n]*437570354/i);
  assert.match(combined, /finalized anchor block time[^\n]*1786013791/i);
  assert.match(combined, /finalized anchor slot[^\n]*437600788/i);
  assert.match(combined, /finalized anchor block time[^\n]*1786026671/i);
  assert.match(combined, /lower timestamp bound[^\n]*1785421871/i);
  assert.match(combined, /two pages/i);
  assert.match(combined, /historical_bound_reached|historical bound reached/i);
  assert.match(combined, /76 canonical signatures/i);
  assert.match(combined, /zero post-anchor signatures (?:were )?excluded/i);
  assert.match(combined, /five in-window/i);
  assert.match(combined, /five Enhanced/i);
  assert.match(combined, /1 supported, 0 unsupported, 1 ambiguous, 3 unrelated, (?:and )?0 failed/i);
  assert.match(combined, /one normalized event/i);
  assert.match(combined, /one finding/i);
  assert.match(combined, /one localized finding/i);
  assert.match(combined, /one blocked summary/i);
  assert.match(combined, /zero candidates(?: and|\/selectable candidates|, and) zero selectable candidates/i);
  assert.match(combined, /zero retries and zero timeouts/i);
  assert.match(combined, /acquisition, normalization, classification, pagination, historical-bound, and chain-boundary gates (?:were )?proven/i);
  assert.match(combined, /capped, truncated, partial, and provider_uncertain (?:were )?all false/i);
  assert.match(combined, /live candidate resolution and Slice 7 were not exercised/i);
  assert.match(combined, /Slice 7 (?:was )?not invoked because there was no selectable candidate/i);
  assert.match(combined, /no package-store (?:write|operation), publication, upload, signing, minting, or deployment/i);
  assert.match(combined, /credentials, URLs, headers, provider prose, response bodies, and raw provider bodies (?:were )?absent/i);
  assert.match(combined, /no retry attempt actually began/i);
  assert.match(combined, /no HTTP attempt terminated because of its effective transport timeout/i);
  assert.match(combined, /patch 3 changed no aggregate classification relative to the prior run/i);
  assert.match(combined, /newer finalized anchor naturally changed (?:the )?content-addressed digests/i);
  assert.match(combined, /zero candidates was a valid result, not a validation failure/i);
  assert.match(combined, /no receipt or package digest (?:was )?issued/i);
  assert.match(combined, /live release gate is complete/i);
  assert.match(combined, /no further live (?:rerun|re-run) is required before tagging v1\.14\.0/i);
  assert.match(combined, /deterministic remediation is complete only after (?:the )?tests pass/i);
  assert.match(combined, /v1\.14\.0 is not yet tagged/i);
  assert.match(combined, /tracked tree intentionally contains (?:exactly )?(?:the )?five exact retained Helius fixture bodies|tracked tree intentionally contains exactly five retained Helius fixture bodies/i);
  assert.match(combined, /controlled-live raw responses are not retained/i);
  assert.match(combined, /Artifact deterministically reconstructs supported trades from provider-attested on-chain evidence and exposes the evidence boundaries and limitations required to reproduce its result\./i);
  assert.doesNotMatch(documents['README.md'], /fully verifiable trade|Anyone can independently|Anyone can verify a trade receipt independently|full re-derivation from raw transactions/i);
  assert.doesNotMatch(documents['engine/docs/verifier_flow.md'], /No proprietary tools, API keys, or trust relationships required|Full Re-Derivation \(Highest Assurance\)|Trades actually happened as claimed|strongest possible verification/i);
  for (const digest of [
    'd2973f4f97745880d05dd75100071d22b339ac12366db798730f7b7eea8b1ef5',
    'd1ae883f9b41566fd547a79f2dfcb7894e8e7e827e7229abfba1a5c0606f93d3',
    'f463e5cd140b97fba00ad25eb86244ab7bad03dd97412f70d2613aa4ca809dfd',
    '86400e78a0bc28b0367dcd4a8787abf49e58a68939590e8e0e5a449bf6084a61',
  ]) assert.match(combined, new RegExp(digest));
  assert.match(combined, /1,951 bytes/);
  assert.match(combined, /(?:mode|permissions) (?:were )?`?0600`?/i);
  assert.doesNotMatch(combined, /BJsHXqhTWD4ECKXmhRNEnaZjd5ymDiZMyjFJzYuzCzGy/);
  assert.doesNotMatch(combined, /live candidate resolution (?:occurred|was performed)|Slice 7 (?:was invoked|was performed)/i);
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
