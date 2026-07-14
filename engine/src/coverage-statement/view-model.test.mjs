import assert from 'assert';

import { createInventoryFixture, removeInventoryFixture } from '../inventory/test-fixtures.mjs';
import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { buildReceiptCoverageStatement } from './view-model.mjs';

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

function assertNoForbiddenFields(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  assert.ok(!serialized.includes('test_wallet'));
  assert.ok(!serialized.includes('wallet_address'));
  assert.ok(!serialized.includes('realized_pnl'));
  assert.ok(!serialized.includes('pnl_pct'));
  assert.ok(!serialized.includes('usd_amount'));
  assert.ok(!serialized.includes('usd_value'));
  assert.ok(!serialized.includes('normalized_valuation'));
  assert.ok(!serialized.includes('participant_total'));
  assert.ok(!serialized.includes('profile'));
  assert.ok(!serialized.includes('nansen'));
  assert.ok(!serialized.includes('upload'));
  assert.ok(!serialized.includes('mint_address'));
  assert.ok(!serialized.includes('transaction_signature'));
  assert.ok(!serialized.includes('signing'));
}

const fixture = createInventoryFixture();
try {
  await test('builds complete receipt-scoped coverage for a verified closed-position receipt', () => {
    const receipt = getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root });
    const coverage = buildReceiptCoverageStatement(receipt);

    assert.equal(coverage.coverage_statement_version, 'receipt_coverage_v1');
    assert.equal(coverage.coverage_status, 'complete');
    assert.deepEqual(coverage.coverage_codes, [
      'receipt_scope_only',
      'canonical_inventory_receipt',
      'raw_quote_no_usd_normalization',
      'closed_position_receipt',
      'canonical_status_verified',
      'hash_valid',
      'verifier_passed',
      'schema_valid',
      'consistency_valid',
      'valuation_raw_quote',
      'event_bounds_complete',
    ]);
    assert.equal(coverage.scope.scope_type, 'receipt');
    assert.equal(coverage.scope.coverage_basis, 'canonical_inventory_receipt');
    assert.equal(coverage.receipt.receipt_hash, fixture.hashes.receiptAHash);
    assert.equal(coverage.receipt.receipt_type, 'closed_position');
    assert.equal(coverage.position_episode.semantic, 'closed_position_receipt_episode');
    assert.equal(coverage.position_episode.opened_at, 1700000000);
    assert.equal(coverage.position_episode.closed_at, 1700000300);
    assert.equal(coverage.position_episode.descriptive_only, true);
    assert.equal(coverage.verification_basis.verification_status, 'verified');
    assert.equal(coverage.verification_basis.verifier_passed, true);
    assert.equal(coverage.valuation_basis.valuation_status, 'raw_quote');
    assert.equal(coverage.valuation_basis.usd_normalized, false);
  });

  await test('adds board publication context without making the core statement board-specific', () => {
    const receipt = getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root });
    const coverage = buildReceiptCoverageStatement(receipt, {
      publicationContext: {
        surface: 'historical_receipt_board',
        selection_mode: 'publisher_selected',
      },
    });

    assert.equal(coverage.scope.scope_type, 'receipt');
    assert.equal(coverage.publication_context.surface, 'historical_receipt_board');
    assert.equal(coverage.publication_context.selection_mode, 'publisher_selected');
    assert.ok(coverage.coverage_codes.includes('surface_historical_receipt_board'));
    assert.ok(coverage.coverage_codes.includes('selection_publisher_selected'));
    assert.ok(coverage.limitations.includes('Publisher-selected board entry unless a future explicit coverage scope is supplied.'));
  });

  await test('missing first event timestamp produces deterministic incomplete coverage', () => {
    const receipt = {
      ...getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root }),
      first_event_at: null,
    };
    const coverage = buildReceiptCoverageStatement(receipt);

    assert.equal(coverage.coverage_status, 'incomplete');
    assert.ok(coverage.coverage_codes.includes('event_bounds_missing_first_event_at'));
    assert.ok(!coverage.coverage_codes.includes('event_bounds_complete'));
    assert.equal(coverage.position_episode.opened_at, null);
    assert.equal(coverage.position_episode.closed_at, 1700000300);
  });

  await test('missing last event timestamp produces deterministic incomplete coverage', () => {
    const receipt = {
      ...getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root }),
      last_event_at: null,
    };
    const coverage = buildReceiptCoverageStatement(receipt);

    assert.equal(coverage.coverage_status, 'incomplete');
    assert.ok(coverage.coverage_codes.includes('event_bounds_missing_last_event_at'));
    assert.ok(!coverage.coverage_codes.includes('event_bounds_complete'));
    assert.equal(coverage.position_episode.opened_at, 1700000000);
    assert.equal(coverage.position_episode.closed_at, null);
  });

  await test('non-verified or verifier-incomplete receipts remain deterministic incomplete coverage', () => {
    const receipt = {
      ...getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root }),
      verification_status: 'unverified',
      verifier_passed: false,
      verifier_schema_valid: false,
      verifier_consistency_valid: false,
    };
    const coverage = buildReceiptCoverageStatement(receipt);

    assert.equal(coverage.coverage_status, 'incomplete');
    assert.ok(coverage.coverage_codes.includes('canonical_status_not_verified'));
    assert.ok(coverage.coverage_codes.includes('verifier_not_passed'));
    assert.ok(coverage.coverage_codes.includes('schema_not_valid'));
    assert.ok(coverage.coverage_codes.includes('consistency_not_valid'));
  });

  await test('coverage statement excludes wallet, PnL, normalized value, profile, upload, mint, and signing fields', () => {
    const receipt = getInventoryReceipt(fixture.hashes.receiptAHash, { engineRoot: fixture.root });
    const coverage = buildReceiptCoverageStatement(receipt, {
      publicationContext: {
        surface: 'historical_receipt_board',
        selection_mode: 'publisher_selected',
      },
    });

    assertNoForbiddenFields(coverage);
    assert.equal(coverage.valuation_basis.usd_normalized, false);
  });
} finally {
  removeInventoryFixture(fixture.root);
}

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
