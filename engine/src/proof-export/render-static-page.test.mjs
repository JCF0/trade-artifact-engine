import assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { runCli } from './cli.mjs';
import { renderStaticProofPage } from './render-static-page.mjs';

let pass = 0;
let fail = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  PASS ${name}`);
    })
    .catch(error => {
      fail += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error.message}`);
    });
}

function createBufferStream() {
  const chunks = [];
  return {
    write(value) {
      chunks.push(String(value));
    },
    toString() {
      return chunks.join('');
    },
  };
}

function extractCoverageSection(value) {
  const start = value.indexOf('<h2>Coverage Statement</h2>');
  assert.ok(start >= 0, 'missing coverage statement section');
  const next = value.indexOf('<h2>', start + 1);
  return next >= 0 ? value.slice(start, next) : value.slice(start);
}

const fixture = createInventoryFixture();
const receipt = getInventoryReceipt(fixture.hashes.receiptAHash, {
  engineRoot: fixture.root,
  includeExcluded: false,
});
const proofDetail = buildProofDetailView(receipt);
const html = renderStaticProofPage(proofDetail, {
  generatedAt: '2026-07-01T00:00:00.000Z',
});

try {
  await test('renderer outputs expected sections', async () => {
    for (const heading of ['Receipt', 'Coverage Statement', 'Verification', 'Valuation', 'Proof Lifecycle', 'Artifacts', 'Flags &amp; Limitations', 'Links']) {
      assert.ok(html.includes(`<h2>${heading}</h2>`), `missing section ${heading}`);
    }
  });


  await test('renderer includes compact coverage statement with exact required wording', async () => {
    const coverage = extractCoverageSection(html);
    assert.ok(coverage.includes('<h2>Coverage Statement</h2>'));
    assert.ok(coverage.includes('Receipt-scoped coverage only.'));
    assert.ok(coverage.includes('Receipt event bounds: 2023-11-14T22:13:20.000Z to 2023-11-14T22:18:20.000Z.'));
    assert.ok(coverage.includes('Raw quote only. No USD normalization.'));
    assert.ok(coverage.includes('Not wallet, trader, portfolio, or track-record coverage.'));
  });

  await test('renderer coverage section omits publisher selection and internal coverage fields', async () => {
    const coverage = extractCoverageSection(html);
    assert.ok(!coverage.includes('Publisher-selected board entry.'));
    assert.ok(!coverage.includes('coverage_codes'));
    assert.ok(!coverage.includes('event_bounds_complete'));
    assert.ok(!coverage.includes('Verifier Passed'));
    assert.ok(!coverage.includes('Upload Status'));
    assert.ok(!coverage.includes('Mint Status'));
    assert.ok(!coverage.includes('Transaction Signature'));
    assert.ok(!coverage.includes('TEST_WALLET'));
    assert.ok(!coverage.includes('realized_pnl'));
    assert.ok(!coverage.includes('usd_value'));
  });

  await test('renderer coverage section handles incomplete event bounds deterministically', async () => {
    const sparse = structuredClone(proofDetail);
    sparse.coverage_statement.position_episode.opened_at = null;
    sparse.coverage_statement.position_episode.closed_at = null;
    const sparseHtml = renderStaticProofPage(sparse, { generatedAt: '2026-07-01T00:00:00.000Z' });
    const coverage = extractCoverageSection(sparseHtml);
    assert.ok(coverage.includes('Receipt event bounds incomplete.'));
  });

  await test('renderer includes raw quote disclosure and selected receipt framing', async () => {
    assert.ok(html.includes('Raw quote only. No USD normalization.'));
    assert.ok(html.includes('Selected receipt only.'));
    assert.ok(html.includes('local export scaffold'));
  });


  await test('hosted render includes the same compact coverage statement', async () => {
    const hostedHtml = renderStaticProofPage(proofDetail, {
      generatedAt: '2026-07-01T00:00:00.000Z',
      hosted: {
        walletDisplayMode: 'truncated',
        visibility: 'unlisted',
      },
    });
    const coverage = extractCoverageSection(hostedHtml);
    assert.ok(coverage.includes('Receipt-scoped coverage only.'));
    assert.ok(coverage.includes('Receipt event bounds: 2023-11-14T22:13:20.000Z to 2023-11-14T22:18:20.000Z.'));
    assert.ok(coverage.includes('Raw quote only. No USD normalization.'));
    assert.ok(coverage.includes('Not wallet, trader, portfolio, or track-record coverage.'));
    assert.ok(!coverage.includes('Publisher-selected board entry.'));
  });

  await test('hosted unlisted render includes required disclosures', async () => {
    const hostedDetail = structuredClone(proofDetail);
    hostedDetail.receipt.wallet = 'TESTWALLET12345678901234567890123456789012345';
    const hostedHtml = renderStaticProofPage(hostedDetail, {
      generatedAt: '2026-07-01T00:00:00.000Z',
      hosted: {
        walletDisplayMode: 'truncated',
        visibility: 'unlisted',
      },
    });

    assert.ok(hostedHtml.includes('Hosted proof page.'));
    assert.ok(hostedHtml.includes('Unlisted does not mean private. Anyone with the link can view.'));
    assert.ok(hostedHtml.includes('Selected receipt only. Not a portfolio statement.'));
    assert.ok(hostedHtml.includes('Raw quote only. No USD normalization.'));
    assert.ok(hostedHtml.includes('Wallet may be truncated or redacted by publisher.'));
    assert.ok(hostedHtml.includes('TESTWA...2345'));
    assert.ok(!hostedHtml.includes('TESTWALLET12345678901234567890123456789012345'));
  });

  await test('hosted public render omits unlisted disclosure and uses public framing', async () => {
    const hostedHtml = renderStaticProofPage(proofDetail, {
      generatedAt: '2026-07-01T00:00:00.000Z',
      hosted: {
        walletDisplayMode: 'full',
        visibility: 'public',
      },
    });

    assert.ok(hostedHtml.includes('Public hosted proof page.'));
    assert.ok(!hostedHtml.includes('Unlisted does not mean private. Anyone with the link can view.'));
    assert.ok(hostedHtml.includes('Selected receipt only. Not a portfolio statement.'));
    assert.ok(hostedHtml.includes('Raw quote only. No USD normalization.'));
  });

  await test('hosted render keeps verification status, hash validity, verifier result, and lifecycle separate', async () => {
    const hostedHtml = renderStaticProofPage(proofDetail, {
      generatedAt: '2026-07-01T00:00:00.000Z',
      hosted: {
        walletDisplayMode: 'full',
      },
    });

    assert.ok(hostedHtml.includes('<strong>Verification Status</strong>'));
    assert.ok(hostedHtml.includes('<strong>Hash Valid</strong>'));
    assert.ok(hostedHtml.includes('<strong>Verifier Passed</strong>'));
    assert.ok(hostedHtml.includes('<strong>Proof Lifecycle</strong>'));
    assert.ok(!hostedHtml.includes('Hash Valid / Verifier Passed'));
  });

  await test('local render remains unchanged when hosted options are omitted', async () => {
    const localHtml = renderStaticProofPage(proofDetail, {
      generatedAt: '2026-07-01T00:00:00.000Z',
    });

    assert.ok(localHtml.includes('Selected receipt only. This static proof page is a local export scaffold, not hosted proof delivery.'));
    assert.ok(localHtml.includes('Hash Valid / Verifier Passed'));
    assert.ok(!localHtml.includes('Hosted proof page.'));
    assert.ok(localHtml.includes(proofDetail.receipt.wallet));
  });

  await test('renderer shows missing fields as Not available', async () => {
    const sparse = structuredClone(proofDetail);
    sparse.artifacts.final_metadata_uri = null;
    sparse.links.legacy_path = null;
    const sparseHtml = renderStaticProofPage(sparse, { generatedAt: '2026-07-01T00:00:00.000Z' });
    assert.ok(sparseHtml.includes('Final Metadata URI'));
    assert.ok(sparseHtml.includes('Not available'));
  });

  await test('renderer does not expose raw legacy blobs', async () => {
    assert.ok(!html.includes('source_path'));
    assert.ok(!html.includes('line_number'));
    assert.ok(!html.includes('raw_legacy_record'));
  });

  await test('renderer does not include external asset references or scripts', async () => {
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<link rel='));
    assert.ok(!html.includes('src="http'));
  });

  await test('CLI stdout export succeeds', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const code = runCli(['--receipt-hash', fixture.hashes.receiptAHash, '--stdout'], {
      stdout,
      stderr,
      env: {
        ...process.env,
        TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root,
      },
    });
    assert.equal(code, 0);
    assert.ok(stdout.toString().includes('<!DOCTYPE html>'));
    assert.equal(stderr.toString(), '');
  });

  await test('CLI output write succeeds only when explicitly requested', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'trade-artifact-export-'));
    const outPath = join(outDir, 'proof.html');
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    try {
      const code = runCli(['--receipt-hash', fixture.hashes.receiptBHash, '--output', outPath], {
        stdout,
        stderr,
        env: {
          ...process.env,
          TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root,
        },
      });
      assert.equal(code, 0);
      const written = readFileSync(outPath, 'utf8');
      assert.ok(written.includes('Selected receipt only.'));
      assert.ok(stderr.toString().includes('Wrote static proof page to'));
      assert.equal(stdout.toString(), '');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  await test('CLI fails non-zero for unknown receipt hash', async () => {
    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const code = runCli(['--receipt-hash', '9'.repeat(64), '--stdout'], {
      stdout,
      stderr,
      env: {
        ...process.env,
        TRADE_ARTIFACT_INVENTORY_ROOT: fixture.root,
      },
    });
    assert.notEqual(code, 0);
    assert.ok(stderr.toString().includes('No proof detail found for receipt_hash'));
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
