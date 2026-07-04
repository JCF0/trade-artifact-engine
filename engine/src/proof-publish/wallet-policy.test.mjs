import assert from 'assert';

import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { applyWalletDisplayPolicy, REDACTED_WALLET_TEXT } from './wallet-policy.mjs';

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
  const knownRecord = getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root });
  const detail = buildProofDetailView(knownRecord);

  test('truncated mode shortens wallet display and does not mutate original view-model', () => {
    const source = structuredClone(detail);
    source.receipt.wallet = 'TESTWALLET12345678901234567890123456789012345';
    const originalWallet = source.receipt.wallet;
    const transformed = applyWalletDisplayPolicy(source, { mode: 'truncated' });
    assert.equal(transformed.receipt.wallet, 'TESTWA...2345');
    assert.equal(source.receipt.wallet, originalWallet);
    assert.notStrictEqual(transformed, source);
    assert.equal(transformed.receipt.receipt_hash, source.receipt.receipt_hash);
  });

  test('redacted mode hides wallet', () => {
    const transformed = applyWalletDisplayPolicy(detail, { mode: 'redacted' });
    assert.equal(transformed.receipt.wallet, REDACTED_WALLET_TEXT);
  });

  test('full mode preserves wallet', () => {
    const transformed = applyWalletDisplayPolicy(detail, { mode: 'full' });
    assert.equal(transformed.receipt.wallet, detail.receipt.wallet);
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
