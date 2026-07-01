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
    for (const heading of ['Receipt', 'Verification', 'Valuation', 'Proof Lifecycle', 'Artifacts', 'Flags &amp; Limitations', 'Links']) {
      assert.ok(html.includes(`<h2>${heading}</h2>`), `missing section ${heading}`);
    }
  });

  await test('renderer includes raw quote disclosure and selected receipt framing', async () => {
    assert.ok(html.includes('Raw quote only. No USD normalization.'));
    assert.ok(html.includes('Selected receipt only.'));
    assert.ok(html.includes('local export scaffold'));
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
