#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildReceiptPackageV1 } from './builder.mjs';
import { validateReceiptPackageV1 } from './validator.mjs';
import { makeFixture, clone } from './fixtures.test-helper.mjs';

function expectCode(mutate, code) { const pkg = clone(buildReceiptPackageV1(makeFixture())); mutate(pkg); assert.throws(() => validateReceiptPackageV1(pkg), e => e.code === code); }
assert.equal(validateReceiptPackageV1(buildReceiptPackageV1(makeFixture())), true);
expectCode(p => { p['economics.json'].realized_pnl_quote += 1; }, 'economics_overlap_mismatch');
expectCode(p => { p['economics.json'].entry_tx_hashes[0] = 'different'; }, 'economics_overlap_mismatch');
expectCode(p => { p['archive-record.json'].wallet = 'different'; }, 'archive_overlap_mismatch');
expectCode(p => { p['verification.json'].schema_valid = false; }, 'verification_result_mismatch');
expectCode(p => { delete p['economics.json']; }, 'package_member_set_invalid');
expectCode(p => { p['extra.json'] = {}; }, 'package_member_set_invalid');
expectCode(p => { p['manifest.json'].members['economics.json'].sha256 = 'a'.repeat(64); }, 'member_hash_mismatch');
expectCode(p => { p['manifest.json'].package_digest = 'a'.repeat(64); }, 'package_digest_mismatch');
expectCode(p => { p['canonical-receipt.json'].raw_transactions = [{ secret: true }]; }, 'forbidden_field');
expectCode(p => { delete p['canonical-receipt.json'].entry_tx_hashes; }, 'missing_field');
console.log('receipt-package validator: PASS');
