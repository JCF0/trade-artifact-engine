#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildEventRecordV1, computeReceiptScopedEvidenceDigest } from './identity.mjs';
import { canonicalJson } from './serialize.mjs';
import {
  buildReceiptScopedEvidenceV1,
  validateReceiptScopedEvidenceV1,
} from './receipt-scoped-evidence.mjs';
import { providerPublicKey, providerSignature } from '../wallet-acquisition/fixtures/test-identities.mjs';

const WALLET = providerPublicKey('wallet');
const TOKEN = providerPublicKey('token');
const OTHER = providerPublicKey('other');
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function event({ slot, timestamp, tx, token = TOKEN, buy = true, rawIndex }) {
  return buildEventRecordV1({
    source_slot: slot,
    slice7_event: {
      wallet: WALLET,
      timestamp,
      tx_hash: providerSignature(tx),
      source: 'swap',
      token_in_mint: buy ? QUOTE : token,
      token_in_amount: buy ? 10 : 2,
      token_in_decimals: 6,
      token_out_mint: buy ? token : QUOTE,
      token_out_amount: buy ? 5 : 6,
      token_out_decimals: 6,
      extraction_method: 'balance_delta',
      raw_index: rawIndex,
    },
  });
}

const earlier = event({ slot: 10, timestamp: 100, tx: 'tx-earlier', rawIndex: 0 });
const unrelated = event({ slot: 15, timestamp: 150, tx: 'tx-other', token: OTHER, rawIndex: 1 });
const later = event({ slot: 20, timestamp: 200, tx: 'tx-later', buy: false, rawIndex: 2 });
const input = { wallet: WALLET, tokenMint: TOKEN, normalizedEventRecords: [later, unrelated, earlier] };
const mutableInput = structuredClone(input);
const scoped = buildReceiptScopedEvidenceV1(mutableInput);

assert.equal(scoped.receipt_scoped_evidence_version, 'wallet_candidate_selection_projection_v1');
assert.equal(scoped.wallet, WALLET);
assert.equal(scoped.token_mint, TOKEN);
assert.deepEqual(scoped.source_event_digests, [earlier.event_digest, later.event_digest]);
assert.deepEqual(scoped.events.map(item => item.raw_index), [0, 1]);
assert.deepEqual(scoped.events.map(item => item.tx_hash), [providerSignature('tx-earlier'), providerSignature('tx-later')]);
assert.ok(!canonicalJson(scoped).includes(providerSignature('tx-other')));
assert.match(scoped.receipt_scoped_evidence_digest, /^[0-9a-f]{64}$/);
assert.doesNotThrow(() => validateReceiptScopedEvidenceV1(scoped));
assert.ok(Object.isFrozen(scoped) && Object.isFrozen(scoped.events) && Object.isFrozen(scoped.events[0]));

const reordered = buildReceiptScopedEvidenceV1({ ...input, normalizedEventRecords: [earlier, later, unrelated] });
assert.equal(reordered.receipt_scoped_evidence_digest, scoped.receipt_scoped_evidence_digest);
mutableInput.normalizedEventRecords[0].slice7_event.timestamp = 999;
assert.equal(scoped.events[1].timestamp, 200);

const changed = structuredClone(scoped);
changed.events[0].token_out_amount = 99;
assert.throws(() => validateReceiptScopedEvidenceV1(changed), error => error.code === 'receipt_scoped_event_reference_mismatch');

function rehash(value) {
  value.receipt_scoped_evidence_digest = computeReceiptScopedEvidenceDigest({ wallet: value.wallet, token_mint: value.token_mint, source_event_digests: value.source_event_digests, source_event_references: value.source_event_references, events: value.events });
  return value;
}
for (const mutate of [
  event => { event.token_in_amount = 0; },
  event => { event.token_in_amount = -1; },
  event => { event.token_in_decimals = -1; },
  event => { event.token_out_mint = event.token_in_mint; },
  event => { event.tx_hash = ''; },
]) {
  const invalid = structuredClone(scoped); mutate(invalid.events[0]); rehash(invalid);
  assert.throws(() => validateReceiptScopedEvidenceV1(invalid), error => error.code === 'invalid_field');
}
const noncanonical = structuredClone(scoped);
noncanonical.events.reverse(); noncanonical.source_event_digests.reverse(); noncanonical.source_event_references.reverse(); noncanonical.events.forEach((event, index) => { event.raw_index = index; }); rehash(noncanonical);
assert.throws(() => validateReceiptScopedEvidenceV1(noncanonical), error => error.code === 'receipt_scoped_event_order_mismatch');
const misbound = structuredClone(scoped);
[misbound.source_event_digests[0], misbound.source_event_digests[1]] = [misbound.source_event_digests[1], misbound.source_event_digests[0]];
[misbound.source_event_references[0], misbound.source_event_references[1]] = [misbound.source_event_references[1], misbound.source_event_references[0]]; rehash(misbound);
assert.throws(() => validateReceiptScopedEvidenceV1(misbound), error => error.code === 'receipt_scoped_event_reference_mismatch');
assert.throws(
  () => buildReceiptScopedEvidenceV1({ wallet: WALLET, tokenMint: OTHER, normalizedEventRecords: [earlier, later] }),
  error => error.code === 'candidate_evidence_empty',
);

console.log('candidate-set receipt-scoped evidence: PASS');
