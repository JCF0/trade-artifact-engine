import { cloneAndFreeze, clonePlainData, assertPlainJsonValue } from './plain-data.mjs';
import { compareCodeUnits } from './order.mjs';
import { fail } from './errors.mjs';
import {
  validateDispositionV1,
  validateEventRecordV1,
  validateFindingV1,
} from './schema.mjs';
import {
  computeDispositionDigest,
  computeEventRecordDigest,
  computeFindingDigest,
  computeSourceTransactionDigest,
} from './identity.mjs';

function compareNullableNumbers(left, right) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

export function compareTransactionDispositionsV1(left, right) {
  return left.slot - right.slot
    || compareNullableNumbers(left.block_time, right.block_time)
    || compareCodeUnits(left.tx_hash, right.tx_hash)
    || compareCodeUnits(left.disposition_digest, right.disposition_digest);
}

export function compareNormalizedEventRecordsV1(left, right) {
  return left.slice7_event.timestamp - right.slice7_event.timestamp
    || compareCodeUnits(left.slice7_event.tx_hash, right.slice7_event.tx_hash)
    || left.source_slot - right.source_slot
    || compareCodeUnits(left.event_digest, right.event_digest);
}

export function canonicalizeTransactionDispositionsV1(dispositions) {
  assertPlainJsonValue(dispositions, ['transaction_dispositions']);
  if (!Array.isArray(dispositions)) fail('invalid_transaction_disposition', 'transaction dispositions must be an array');
  const detached = dispositions.map(item => {
    validateDispositionV1(item);
    return clonePlainData(item);
  });
  detached.sort(compareTransactionDispositionsV1);
  return cloneAndFreeze(detached);
}

function unique(values, code, message) {
  if (new Set(values).size !== values.length) fail(code, message);
}

function exactStringSet(actual, expected, code, message) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) fail(code, message);
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

export function validateDispositionAccountingV1(input) {
  assertPlainJsonValue(input, ['disposition_accounting']);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('invalid_transaction_disposition', 'disposition accounting input is invalid');
  const expectedFields = ['transactionDispositions','normalizedEventRecords','activityFindings','wallet','anchorSlot'];
  const keys = Object.keys(input);
  if (keys.some(key => !expectedFields.includes(key)) || expectedFields.some(key => !Object.hasOwn(input, key))) fail('invalid_transaction_disposition', 'disposition accounting fields are invalid');
  const { transactionDispositions, normalizedEventRecords, activityFindings, wallet, anchorSlot } = input;
  if (!Array.isArray(transactionDispositions) || !Array.isArray(normalizedEventRecords) || !Array.isArray(activityFindings)) fail('invalid_transaction_disposition', 'disposition accounting arrays are invalid');
  if (typeof wallet !== 'string' || wallet.length === 0 || !Number.isSafeInteger(anchorSlot) || anchorSlot < 0) fail('invalid_transaction_disposition', 'disposition accounting scope is invalid');

  transactionDispositions.forEach(item => {
    validateDispositionV1(item, { verifyDigest: false });
    if (computeDispositionDigest(item) !== item.disposition_digest) fail('disposition_digest_mismatch', 'transaction disposition digest mismatch');
  });
  normalizedEventRecords.forEach(item => {
    validateEventRecordV1(item, { verifyDigest: false });
    if (computeEventRecordDigest(item) !== item.event_digest) fail('event_digest_mismatch', 'normalized event digest mismatch');
  });
  activityFindings.forEach(item => {
    validateFindingV1(item, { verifyDigest: false });
    if (computeFindingDigest(item) !== item.finding_digest) fail('finding_digest_mismatch', 'activity finding digest mismatch');
  });

  unique(transactionDispositions.map(item => item.tx_hash), 'duplicate_transaction_disposition', 'source transaction has more than one disposition');
  unique(transactionDispositions.map(item => item.disposition_digest), 'duplicate_transaction_disposition', 'duplicate disposition digest');
  unique(transactionDispositions.map(item => item.disposition_id), 'duplicate_transaction_disposition', 'duplicate disposition ID');
  unique(normalizedEventRecords.map(item => item.event_digest), 'duplicate_normalized_event', 'duplicate normalized event digest');
  unique(normalizedEventRecords.map(item => item.event_record_id), 'duplicate_normalized_event', 'duplicate normalized event ID');
  unique(activityFindings.map(item => item.finding_digest), 'duplicate_activity_finding', 'duplicate activity finding digest');
  unique(activityFindings.map(item => item.finding_id), 'duplicate_activity_finding', 'duplicate activity finding ID');

  for (let index = 1; index < transactionDispositions.length; index += 1) {
    if (compareTransactionDispositionsV1(transactionDispositions[index - 1], transactionDispositions[index]) >= 0) fail('order_invalid', 'transaction dispositions are not canonically ordered');
  }
  for (let index = 0; index < normalizedEventRecords.length; index += 1) {
    if (normalizedEventRecords[index].slice7_event.raw_index !== index) fail('event_index_mismatch', 'normalized event raw indexes must be dense in canonical order');
    if (index > 0 && compareNormalizedEventRecordsV1(normalizedEventRecords[index - 1], normalizedEventRecords[index]) >= 0) fail('order_invalid', 'normalized event records are not canonically ordered');
  }

  const events = new Map(normalizedEventRecords.map(item => [item.event_digest, item]));
  const findings = new Map(activityFindings.map(item => [item.finding_digest, item]));
  const eventReferenceCounts = new Map(normalizedEventRecords.map(item => [item.event_digest, 0]));
  const findingReferenceCounts = new Map(activityFindings.map(item => [item.finding_digest, 0]));

  for (const disposition of transactionDispositions) {
    if (disposition.slot > anchorSlot) fail('event_after_anchor_boundary', 'source transaction is after the finalized boundary');
    const sourceDigest = computeSourceTransactionDigest({ tx_hash: disposition.tx_hash, slot: disposition.slot, block_time: disposition.block_time });

    if (disposition.disposition_type === 'supported_normalized_event') {
      const event = events.get(disposition.normalized_event_digests[0]);
      if (!event) fail('event_disposition_mismatch', 'supported disposition references an unknown event');
      eventReferenceCounts.set(event.event_digest, eventReferenceCounts.get(event.event_digest) + 1);
      if (event.slice7_event.tx_hash !== disposition.tx_hash || event.source_slot !== disposition.slot || (disposition.block_time !== null && event.slice7_event.timestamp !== disposition.block_time)) fail('event_source_mismatch', 'event source does not match its disposition');
      if (event.source_slot > anchorSlot || event.slice7_event.wallet !== wallet) fail('event_scope_mismatch', 'normalized event is outside the acquisition scope');
      exactStringSet(disposition.affected_token_mints, sortedUnique([event.slice7_event.token_in_mint, event.slice7_event.token_out_mint]), 'event_disposition_mismatch', 'supported disposition affected mints do not match its event');
      continue;
    }

    if (disposition.disposition_type === 'unsupported_activity' || disposition.disposition_type === 'ambiguous_activity') {
      const referencedFindings = disposition.finding_digests.map(digest => {
        const finding = findings.get(digest);
        if (!finding) fail('finding_disposition_mismatch', 'disposition references an unknown finding');
        findingReferenceCounts.set(digest, findingReferenceCounts.get(digest) + 1);
        if (finding.finding_type !== disposition.disposition_type || !finding.source_transaction_digests.includes(sourceDigest)) fail('finding_disposition_mismatch', 'finding does not describe its source disposition');
        return finding;
      });
      exactStringSet(disposition.affected_token_mints, sortedUnique(referencedFindings.flatMap(item => item.affected_token_mints)), 'finding_disposition_mismatch', 'disposition affected mints do not match its findings');
    }
  }

  for (const [digest, count] of eventReferenceCounts) if (count !== 1) fail('event_disposition_mismatch', `normalized event ${count === 0 ? 'is unreferenced' : 'has duplicate references'}`);
  for (const [digest, count] of findingReferenceCounts) {
    if (count === 0) fail('finding_disposition_mismatch', 'activity finding is unreferenced');
    const finding = findings.get(digest);
    const referencedDispositions = transactionDispositions.filter(item => item.finding_digests.includes(digest));
    const referencedSourceDigests = sortedUnique(referencedDispositions
      .map(item => computeSourceTransactionDigest({ tx_hash: item.tx_hash, slot: item.slot, block_time: item.block_time })));
    exactStringSet(finding.source_transaction_digests, referencedSourceDigests, 'finding_source_mismatch', 'finding source transactions do not match disposition backlinks');
    if (finding.source_event_digests.length !== 0) fail('finding_source_mismatch', 'disposition-backed activity findings cannot reference normalized events');
    const slots = referencedDispositions.map(item => item.slot);
    if (finding.time_range.first_observed_slot !== Math.min(...slots) || finding.time_range.last_observed_slot !== Math.max(...slots)) fail('finding_source_mismatch', 'finding slot range does not match source transactions');
    const blockTimes = referencedDispositions.map(item => item.block_time);
    if (blockTimes.some(value => value === null)) fail('finding_source_mismatch', 'disposition-backed activity findings require source transaction block times');
    if (finding.time_range.first_observed_at !== Math.min(...blockTimes) || finding.time_range.last_observed_at !== Math.max(...blockTimes)) fail('finding_source_mismatch', 'finding timestamp range does not match source transactions');
  }
  return true;
}
