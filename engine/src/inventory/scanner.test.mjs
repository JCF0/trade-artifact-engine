import assert from 'assert';

import {
  scanInventorySources,
  scanLegacyReceiptInventory,
} from './scanner.mjs';
import {
  createInventoryFixture,
  removeInventoryFixture,
} from './test-fixtures.mjs';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

const fixture = createInventoryFixture();

try {
  test('defaults to v1.2 receipts only', () => {
    const snapshot = scanInventorySources({ engineRoot: fixture.root });
    assert.equal(snapshot.v12.receipts.length, 2);
    assert.equal(snapshot.legacy.length, 0);
  });

  test('joins verifier and mint artifacts by receipt_hash', () => {
    const snapshot = scanInventorySources({ engineRoot: fixture.root });
    const verify = snapshot.v12.verifyByHash.get(fixture.hashes.receiptAHash);
    const mint = snapshot.v12.mintResultByHash.get(fixture.hashes.receiptAHash);
    const valuation = snapshot.v12.valuationByHash.get(fixture.hashes.receiptBHash);
    assert.equal(verify.hash_valid, true);
    assert.equal(mint.mint_status, 'minted');
    assert.equal(valuation.valuation_status, 'raw_quote');
  });

  test('legacy scan is opt-in and excludes test/e2e/backup paths by default', () => {
    const legacy = scanLegacyReceiptInventory({ engineRoot: fixture.root });
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].verification_hash, fixture.hashes.legacyHash);
  });

  test('legacy scan can include excluded directories when explicitly requested', () => {
    const legacy = scanLegacyReceiptInventory({
      engineRoot: fixture.root,
      includeExcluded: true,
    });
    const hashes = legacy.map(entry => entry.verification_hash).sort();
    assert.deepEqual(hashes, [
      fixture.hashes.excludedHash1,
      fixture.hashes.excludedHash2,
      fixture.hashes.excludedHash3,
      fixture.hashes.legacyHash,
    ].sort());
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
