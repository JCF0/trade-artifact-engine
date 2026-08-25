#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDeterministicCandidateFixtureV1, JUP_GOLDEN, RAY_GOLDEN } from '../candidate-set/fixtures/deterministic-fixtures.mjs';
import { resolveCandidateSelectionV1 } from '../candidate-set/selection-resolver.mjs';
import { orchestrateTargetedReceiptPackageV1 } from '../receipt-package/targeted-orchestrator.mjs';

const MEMBER_NAMES = Object.freeze([
  'archive-record.json', 'canonical-receipt.json', 'economics.json', 'manifest.json', 'verification.json',
]);
const FROZEN_IDENTITIES = Object.freeze({
  JUP: Object.freeze({
    receipt_hash: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
    package_digest: '5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278',
    member_hashes: Object.freeze({
      'archive-record.json': 'd28c5a58b920f526c5ed9e08e4e5b034d99285cd7182a1374f1eb9c10697c6ac',
      'canonical-receipt.json': 'c636cfda958eb87341d3225d33b53b7dc9dcf157def5cc3a054eb56cd4e9eb61',
      'economics.json': 'd8d716459707f3b8c7f95b2f6e64a3c1f1faf91e62629e0477213e4b4ed9ffbd',
      'manifest.json': '2ce234ccedcb52ac555f49129de7a3b6660506b04ed452c02503ec626646f1f6',
      'verification.json': '851c283e7e321bee61a939f1b39dbfb1f09ec038cdd078ceca50c8f7167c6ad0',
    }),
  }),
  RAY: Object.freeze({
    receipt_hash: '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
    package_digest: '25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2',
    member_hashes: Object.freeze({
      'archive-record.json': '777987cf14a3e41034923a6acc0e87ce15ec7affef68b0e3fb32890ad24bd695',
      'canonical-receipt.json': '94717ca77018826e88bf39313c7b4b810ade1d42ed9f507809c649f1f6f3f2cb',
      'economics.json': '4664d29a151bba54051c4a8ef6044990a2ca474a4b45a421536106e9fa5d0ea8',
      'manifest.json': '9fffd0746b49b5e3b89dbf113675c76290c7ae10f99542a23b1c385e3c75b41e',
      'verification.json': '808c2d03cd54bb13ed418ea034075dc8b523cb01e6a9ce3359d2959498141e6d',
    }),
  }),
});

function resolveLegacySelection(built, tokenMint) {
  const candidates = built.candidateSet.payload.candidates.filter(candidate => candidate.projection.token_mint === tokenMint);
  assert.equal(candidates.length, 1);
  return resolveCandidateSelectionV1({
    candidateSet: built.candidateSet,
    evidenceBundle: built.evidenceBundle,
    selection: {
      candidate_set_digest: built.candidateSet.candidate_set_digest,
      candidate_digest: candidates[0].candidate_digest,
    },
  });
}

test('additive v1.3 kernel leaves frozen JUP and RAY receipt, package, and member identities byte-exact', async () => {
  for (const [symbol, fixture] of [['JUP', JUP_GOLDEN], ['RAY', RAY_GOLDEN]]) {
    const expected = FROZEN_IDENTITIES[symbol];
    assert.equal(fixture.receiptHash, expected.receipt_hash);
    assert.equal(fixture.packageDigest, expected.package_digest);
    assert.deepEqual(fixture.memberHashes, expected.member_hashes);

    const built = buildDeterministicCandidateFixtureV1(fixture);
    const resolved = resolveLegacySelection(built, fixture.tokenMint);
    assert.equal(resolved.slice7_request.mode, 'dry_run');
    const packageResult = await orchestrateTargetedReceiptPackageV1(resolved.slice7_request, {});
    assert.equal(packageResult.receipt_hash, expected.receipt_hash, `${symbol} receipt identity changed`);
    assert.equal(packageResult.package_digest, expected.package_digest, `${symbol} package identity changed`);
    assert.deepEqual(Object.keys(packageResult.member_hashes).sort(), MEMBER_NAMES);
    assert.deepEqual(packageResult.member_hashes, expected.member_hashes, `${symbol} package member identities changed`);
  }
});
