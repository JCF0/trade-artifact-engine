#!/usr/bin/env node
import assert from 'node:assert/strict';
import { QUOTE_MINTS, USDC_MINT } from '../pipeline/constants.mjs';
import { buildDispositionV1, buildEventRecordV1, buildFindingV1, computeSourceTransactionDigest } from './identity.mjs';
import {
  canonicalizeTransactionDispositionsV1,
  validateDispositionAccountingV1,
} from './dispositions.mjs';

const wallet = 'wallet';
const event = buildEventRecordV1({
  source_slot: 9,
  slice7_event: {
    wallet, timestamp: 90, tx_hash: 'supported-tx', source: 'swap',
    token_in_mint: USDC_MINT, token_in_amount: 10, token_in_decimals: 6,
    token_out_mint: 'TOKEN', token_out_amount: 5, token_out_decimals: 6,
    extraction_method: 'balance_delta', raw_index: 0,
  },
});
const supported = buildDispositionV1({
  tx_hash: 'supported-tx', slot: 9, block_time: 90,
  disposition_type: 'supported_normalized_event',
  affected_token_mints: ['TOKEN'],
  normalized_event_digests: [event.event_digest], finding_digests: [],
});
const unsupportedSource = { tx_hash: 'unsupported-tx', slot: 8, block_time: 80 };
const finding = buildFindingV1({
  finding_type: 'unsupported_activity', severity: 'candidate_blocking', impact_scope: 'token_specific',
  time_range: { first_observed_at: 80, last_observed_at: 80, first_observed_slot: 8, last_observed_slot: 8 },
  affected_token_mints: ['OTHER'], affected_quote_mints: [],
  source_transaction_digests: [computeSourceTransactionDigest(unsupportedSource)], source_event_digests: [],
  reason_codes: ['unsupported_swap_shape'],
  impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
  disclosure_codes: ['activity_not_reconstructable'],
});
const unsupported = buildDispositionV1({
  ...unsupportedSource, disposition_type: 'unsupported_activity', affected_token_mints: ['OTHER'],
  normalized_event_digests: [], finding_digests: [finding.finding_digest],
});

const canonical = canonicalizeTransactionDispositionsV1([supported, unsupported]);
assert.deepEqual(canonical.map(item => item.tx_hash), ['unsupported-tx', 'supported-tx']);
assert.ok(Object.isFrozen(canonical) && Object.isFrozen(canonical[0]));
assert.doesNotThrow(() => validateDispositionAccountingV1({
  transactionDispositions: canonical,
  normalizedEventRecords: [event],
  activityFindings: [finding],
  wallet,
  anchorSlot: 10,
}));

QUOTE_MINTS.delete(USDC_MINT);
try {
  assert.doesNotThrow(() => validateDispositionAccountingV1({
    transactionDispositions: canonical,
    normalizedEventRecords: [event],
    activityFindings: [finding],
    wallet,
    anchorSlot: 10,
  }));
} finally {
  QUOTE_MINTS.add(USDC_MINT);
}

assert.throws(() => validateDispositionAccountingV1({
  transactionDispositions: canonical,
  normalizedEventRecords: [event],
  activityFindings: [],
  wallet,
  anchorSlot: 10,
}), error => error.code === 'finding_disposition_mismatch');

const wrongMint = structuredClone(supported);
wrongMint.affected_token_mints = [USDC_MINT, 'TOKEN'];
assert.throws(() => validateDispositionAccountingV1({
  transactionDispositions: [unsupported, wrongMint], normalizedEventRecords: [event], activityFindings: [finding], wallet, anchorSlot: 10,
}), error => error.code === 'disposition_digest_mismatch' || error.code === 'event_disposition_mismatch');

const duplicateTxDisposition = buildDispositionV1({
  tx_hash: supported.tx_hash, slot: 7, block_time: 70, disposition_type: 'unrelated_activity',
  affected_token_mints: [], normalized_event_digests: [], finding_digests: [],
});
const duplicateTx = canonicalizeTransactionDispositionsV1([supported, unsupported, duplicateTxDisposition]);
assert.throws(() => validateDispositionAccountingV1({
  transactionDispositions: duplicateTx, normalizedEventRecords: [event], activityFindings: [finding], wallet, anchorSlot: 10,
}), error => error.code === 'duplicate_transaction_disposition');

const crossEventFinding = buildFindingV1({
  finding_type: 'unsupported_activity', severity: 'candidate_blocking', impact_scope: 'token_specific',
  time_range: { first_observed_at: 80, last_observed_at: 80, first_observed_slot: 8, last_observed_slot: 8 },
  affected_token_mints: ['OTHER'], affected_quote_mints: [],
  source_transaction_digests: [computeSourceTransactionDigest(unsupportedSource)], source_event_digests: [event.event_digest],
  reason_codes: ['unsupported_swap_shape'], impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
  disclosure_codes: ['activity_not_reconstructable'],
});
const crossEventDisposition = buildDispositionV1({
  ...unsupportedSource, disposition_type: 'unsupported_activity', affected_token_mints: ['OTHER'],
  normalized_event_digests: [], finding_digests: [crossEventFinding.finding_digest],
});
assert.throws(() => validateDispositionAccountingV1({
  transactionDispositions: canonicalizeTransactionDispositionsV1([supported, crossEventDisposition]),
  normalizedEventRecords: [event], activityFindings: [crossEventFinding], wallet, anchorSlot: 10,
}), error => error.code === 'finding_source_mismatch');

const wrongRangeFinding = buildFindingV1({
  finding_type: 'unsupported_activity', severity: 'candidate_blocking', impact_scope: 'token_specific',
  time_range: { first_observed_at: 70, last_observed_at: 70, first_observed_slot: 7, last_observed_slot: 7 },
  affected_token_mints: ['OTHER'], affected_quote_mints: [],
  source_transaction_digests: [computeSourceTransactionDigest(unsupportedSource)], source_event_digests: [],
  reason_codes: ['unsupported_swap_shape'], impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
  disclosure_codes: ['activity_not_reconstructable'],
});
const wrongRangeDisposition = buildDispositionV1({
  ...unsupportedSource, disposition_type: 'unsupported_activity', affected_token_mints: ['OTHER'],
  normalized_event_digests: [], finding_digests: [wrongRangeFinding.finding_digest],
});
assert.throws(() => validateDispositionAccountingV1({
  transactionDispositions: canonicalizeTransactionDispositionsV1([supported, wrongRangeDisposition]),
  normalizedEventRecords: [event], activityFindings: [wrongRangeFinding], wallet, anchorSlot: 10,
}), error => error.code === 'finding_source_mismatch');

const nullableSource = { tx_hash: 'null-time', slot: 6, block_time: null };
const nullableTimeFinding = buildFindingV1({
  finding_type: 'unsupported_activity', severity: 'candidate_blocking', impact_scope: 'token_specific',
  time_range: { first_observed_at: 999, last_observed_at: 999, first_observed_slot: 6, last_observed_slot: 6 },
  affected_token_mints: ['OTHER'], affected_quote_mints: [], source_transaction_digests: [computeSourceTransactionDigest(nullableSource)], source_event_digests: [],
  reason_codes: ['unsupported_swap_shape'], impact: { blocks_candidate_projection: true, blocks_receipt_publication: true }, disclosure_codes: ['activity_not_reconstructable'],
});
const nullableTimeDisposition = buildDispositionV1({ ...nullableSource, disposition_type: 'unsupported_activity', affected_token_mints: ['OTHER'], normalized_event_digests: [], finding_digests: [nullableTimeFinding.finding_digest] });
assert.throws(() => validateDispositionAccountingV1({
  transactionDispositions: [nullableTimeDisposition], normalizedEventRecords: [], activityFindings: [nullableTimeFinding], wallet, anchorSlot: 10,
}), error => error.code === 'finding_source_mismatch');

console.log('candidate-set dispositions: PASS');
