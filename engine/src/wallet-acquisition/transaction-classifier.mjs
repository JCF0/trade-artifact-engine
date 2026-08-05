import { types as utilTypes } from 'node:util';

import { classifyEvent } from '../ledger/position-ledger.mjs';
import {
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
} from '../pipeline/constants.mjs';
import { buildActivityFindingV1, canonicalizeActivityFindingsV1 } from '../candidate-set/activity-findings.mjs';
import { buildDispositionV1 } from '../candidate-set/identity.mjs';
import { buildEventRecordV1, computeSourceTransactionDigest } from '../candidate-set/identity.mjs';
import {
  assertExactFieldsV1,
  assertPlainDataV1,
  cloneAndFreezePlainDataV1,
  failWalletAcquisitionV1,
} from './errors.mjs';
import { buildWalletSourceTransactionV1 } from './source-transaction.mjs';

export const TRANSACTION_CLASSIFICATION_VERSION_V1 = 'wallet_source_transaction_classification_v1';

const INPUT_FIELDS = ['sourceTransaction','normalizeSupportedSpotOperation'];
const NORMALIZER_RESULT_FIELDS = ['outcome','event'];
const WALLET_WIDE_NORMALIZER_RESULT_FIELDS = [
  'outcome','event','affected_position_token_mints','affected_quote_mints','impact_scope','reason_code',
];
const NORMALIZER_OUTCOMES = new Set(['supported_event','unsupported_shape','ambiguous_shape','no_supported_operation']);
const QUOTE_MINTS_V1 = Object.freeze([SOL_MINT, USDC_MINT, USDT_MINT]);
const EVENT_FIELDS = [
  'wallet','timestamp','tx_hash','source','token_in_mint','token_in_amount','token_in_decimals',
  'token_out_mint','token_out_amount','token_out_decimals','extraction_method','raw_index',
];

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedUnique(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

function classifyEventWithFrozenQuotes(event) {
  const inputIsQuote = QUOTE_MINTS_V1.includes(event.token_in_mint);
  const outputIsQuote = QUOTE_MINTS_V1.includes(event.token_out_mint);
  if (inputIsQuote && !outputIsQuote) {
    return {
      action: 'buy',
      baseMint: event.token_out_mint,
      quoteMint: event.token_in_mint,
      baseAmt: event.token_out_amount,
      quoteAmt: event.token_in_amount,
    };
  }
  if (!inputIsQuote && outputIsQuote) {
    return {
      action: 'sell',
      baseMint: event.token_in_mint,
      quoteMint: event.token_out_mint,
      baseAmt: event.token_in_amount,
      quoteAmt: event.token_out_amount,
    };
  }
  return { action: null };
}

function stableClassifyEvent(event) {
  const stable = classifyEventWithFrozenQuotes(event);
  const shared = classifyEvent(event);
  return shared.action === stable.action
    && shared.baseMint === stable.baseMint
    && shared.quoteMint === stable.quoteMint
    && shared.baseAmt === stable.baseAmt
    && shared.quoteAmt === stable.quoteAmt
    ? shared
    : stable;
}

function sourceReference(source) {
  return { tx_hash: source.signature, slot: source.slot, block_time: source.block_time };
}

function economicOperations(source) {
  const tokens = source.token_operations
    .filter(operation => !['metadata','account_record'].includes(operation.operation_kind))
    .filter(operation => operation.operation_kind !== 'account_close'
      || operation.direction !== 'none'
      || operation.amount !== null)
    .map(operation => ({
      asset_kind: 'token',
      operation_id: operation.operation_id,
      economic_group: operation.economic_group,
      operation_kind: operation.operation_kind,
      direction: operation.direction,
      owner: operation.owner,
      mint: operation.mint,
      amount: operation.amount,
      decimals: operation.decimals,
    }));
  const native = source.native_sol_operations
    .filter(operation => !['metadata','account_record'].includes(operation.operation_kind))
    .filter(operation => operation.operation_kind !== 'account_close'
      || operation.direction !== 'none'
      || operation.amount_lamports !== null)
    .map(operation => ({
      asset_kind: 'native_sol',
      operation_id: operation.operation_id,
      economic_group: operation.economic_group,
      operation_kind: operation.operation_kind,
      direction: operation.direction,
      owner: operation.owner,
      mint: SOL_MINT,
      amount: operation.amount_lamports === null ? null : operation.amount_lamports / 1_000_000_000,
      decimals: 9,
    }));
  return [...tokens, ...native].sort((left, right) => compareCodeUnits(left.operation_id, right.operation_id));
}

function localizedMints(operations) {
  const knownMints = operations.map(item => item.mint).filter(mint => mint !== null);
  return {
    positionMints: orderedUnique(knownMints.filter(mint => !QUOTE_MINTS_V1.includes(mint))),
    quoteMints: orderedUnique(knownMints.filter(mint => QUOTE_MINTS_V1.includes(mint))),
    hasUnknownMint: operations.some(item => item.mint === null),
  };
}

function buildFindings(source, findingType, positionMints, quoteMints, { walletWide = false, reason } = {}) {
  const sourceDigest = computeSourceTransactionDigest(sourceReference(source));
  const common = {
    finding_type: findingType,
    severity: 'candidate_blocking',
    time_range: {
      first_observed_at: source.block_time,
      last_observed_at: source.block_time,
      first_observed_slot: source.slot,
      last_observed_slot: source.slot,
    },
    source_transaction_digests: [sourceDigest],
    source_event_digests: [],
    reason_codes: [reason],
    impact: { blocks_candidate_projection: true, blocks_receipt_publication: true },
    disclosure_codes: ['activity_not_reconstructable'],
  };
  if (walletWide) {
    return canonicalizeActivityFindingsV1([buildActivityFindingV1({
      ...common,
      impact_scope: 'wallet_wide',
      affected_token_mints: [],
      affected_quote_mints: [],
    })]);
  }
  return canonicalizeActivityFindingsV1(positionMints.map(mint => buildActivityFindingV1({
    ...common,
    impact_scope: 'token_specific',
    affected_token_mints: [mint],
    affected_quote_mints: quoteMints,
  })));
}

function buildFinalResult(source, dispositionType, { eventRecord = null, findings = [], positionMints = [] } = {}) {
  try {
    const normalizedEventRecords = eventRecord === null ? [] : [eventRecord];
    const activityFindings = [...findings];
    const disposition = buildDispositionV1({
      ...sourceReference(source),
      disposition_type: dispositionType,
      affected_token_mints: orderedUnique(positionMints),
      normalized_event_digests: normalizedEventRecords.map(item => item.event_digest).sort(compareCodeUnits),
      finding_digests: activityFindings.map(item => item.finding_digest).sort(compareCodeUnits),
    });
    const sourceTransactionDigest = computeSourceTransactionDigest(sourceReference(source));
    if (disposition.disposition_type === 'supported_normalized_event') {
      if (normalizedEventRecords.length !== 1 || activityFindings.length !== 0
          || disposition.normalized_event_digests[0] !== normalizedEventRecords[0].event_digest) {
        failWalletAcquisitionV1('event_finding_reconciliation_failed');
      }
    } else if (['unsupported_activity','ambiguous_activity'].includes(disposition.disposition_type)) {
      if (normalizedEventRecords.length !== 0 || activityFindings.length === 0
          || activityFindings.some(item => item.source_transaction_digests[0] !== sourceTransactionDigest)
          || disposition.finding_digests.length !== activityFindings.length
          || disposition.finding_digests.some(digest => !activityFindings.some(item => item.finding_digest === digest))) {
        failWalletAcquisitionV1('event_finding_reconciliation_failed');
      }
    } else if (normalizedEventRecords.length !== 0 || activityFindings.length !== 0 || positionMints.length !== 0) {
      failWalletAcquisitionV1('event_finding_reconciliation_failed');
    }
    return cloneAndFreezePlainDataV1({
      classification_version: TRANSACTION_CLASSIFICATION_VERSION_V1,
      source_transaction: source,
      source_transaction_digest: sourceTransactionDigest,
      disposition,
      normalized_event_records: normalizedEventRecords,
      activity_findings: activityFindings,
    }, 'transaction_disposition_failed');
  } catch (error) {
    if (error?.name === 'WalletAcquisitionContractError'
        && ['event_finding_reconciliation_failed','transaction_disposition_failed'].includes(error.code)) throw error;
    failWalletAcquisitionV1('transaction_disposition_failed');
  }
}

function unsupported(source, positionMints, quoteMints, reason = 'unsupported_swap_shape') {
  const findings = buildFindings(source, 'unsupported_activity', positionMints, quoteMints, { reason });
  return buildFinalResult(source, 'unsupported_activity', { findings, positionMints });
}

function ambiguous(source, positionMints, quoteMints, walletWide = false) {
  const findings = buildFindings(source, 'ambiguous_activity', positionMints, quoteMints, {
    walletWide,
    reason: 'ambiguous_swap_direction',
  });
  return buildFinalResult(source, 'ambiguous_activity', { findings, positionMints });
}

function hasSingleSupportedShape(operations) {
  if (operations.length < 2) return false;
  const debits = operations.filter(operation => operation.direction === 'debit');
  const credits = operations.filter(operation => operation.direction === 'credit');
  if (debits.length === 0 || credits.length !== 1 || debits.length + credits.length !== operations.length) return false;
  if (new Set(debits.map(operation => operation.mint)).size !== 1
      || new Set(debits.map(operation => operation.decimals)).size !== 1) return false;
  const sideMints = [debits[0].mint, credits[0].mint];
  const quoteCount = sideMints.filter(mint => QUOTE_MINTS_V1.includes(mint)).length;
  return quoteCount === 1 && sideMints.every(mint => mint !== null) && sideMints[0] !== sideMints[1];
}

function aggregateDebitAmounts(debits) {
  const decimals = debits[0].decimals;
  const scale = 10 ** decimals;
  const scaled = debits.map(operation => operation.amount * scale);
  if (scaled.every(Number.isSafeInteger)) {
    const total = scaled.reduce((sum, amount) => sum + BigInt(amount), 0n);
    return Number(total) / scale;
  }
  return debits.reduce((total, operation) => total + operation.amount, 0);
}

function equivalentEconomicShape(left, right) {
  if (!hasSingleSupportedShape(left) || !hasSingleSupportedShape(right)) return false;
  const leftDebits = left.filter(operation => operation.direction === 'debit');
  const rightDebits = right.filter(operation => operation.direction === 'debit');
  const leftCredit = left.find(operation => operation.direction === 'credit');
  const rightCredit = right.find(operation => operation.direction === 'credit');
  return leftDebits[0].mint === rightDebits[0].mint
    && leftDebits[0].decimals === rightDebits[0].decimals
    && aggregateDebitAmounts(leftDebits) === aggregateDebitAmounts(rightDebits)
    && leftCredit.mint === rightCredit.mint
    && leftCredit.decimals === rightCredit.decimals
    && leftCredit.amount === rightCredit.amount;
}

function supportedOperationView(source, operations) {
  if (source.fee_payer !== source.wallet
      || !source.recognized_programs.some(program => program.program_role === 'spot_swap')
      || new Set(operations.map(operation => operation.economic_group)).size !== 1
      || operations.some(operation => operation.economic_group === null)) return null;
  const kinds = new Set(operations.map(operation => operation.operation_kind));
  if ([...kinds].some(kind => !['swap','transfer'].includes(kind))) return null;
  if (kinds.size === 1) return hasSingleSupportedShape(operations) ? operations : null;
  if (kinds.size !== 2) return null;
  const swaps = operations.filter(operation => operation.operation_kind === 'swap');
  const transfers = operations.filter(operation => operation.operation_kind === 'transfer');
  return equivalentEconomicShape(swaps, transfers) ? swaps : null;
}

function normalizerOperationGroup(source, operations) {
  return cloneAndFreezePlainDataV1({
    operation_group_version: 'wallet_supported_spot_operation_group_v1',
    economic_group: operations[0].economic_group,
    wallet: source.wallet,
    operations,
  }, 'normalization_failed');
}

function invokeNormalizer(normalizer, source, operations) {
  let result;
  try {
    result = normalizer(cloneAndFreezePlainDataV1({
      sourceTransaction: source,
      supportedSpotOperation: normalizerOperationGroup(source, operations),
    }, 'normalization_failed'));
    assertPlainDataV1(result, 'normalization_failed');
    const fields = Object.keys(result).length === NORMALIZER_RESULT_FIELDS.length
      ? NORMALIZER_RESULT_FIELDS
      : WALLET_WIDE_NORMALIZER_RESULT_FIELDS;
    assertExactFieldsV1(result, fields, 'normalization_failed');
    if (!NORMALIZER_OUTCOMES.has(result.outcome)) failWalletAcquisitionV1('normalization_failed');
    if (result.outcome === 'supported_event') {
      if (result.event === null) failWalletAcquisitionV1('normalization_failed');
    } else if (result.event !== null) failWalletAcquisitionV1('normalization_failed');
    return cloneAndFreezePlainDataV1(result, 'normalization_failed');
  } catch {
    failWalletAcquisitionV1('normalization_failed');
  }
}

function reconcileEvent(source, operations, event) {
  try {
    assertExactFieldsV1(event, EVENT_FIELDS, 'source_transaction_mismatch');
  } catch {
    failWalletAcquisitionV1('source_transaction_mismatch');
  }
  const debits = operations.filter(operation => operation.direction === 'debit');
  const debit = debits[0];
  const credit = operations.find(operation => operation.direction === 'credit');
  const debitAmount = aggregateDebitAmounts(debits);
  const exact = event.wallet === source.wallet
    && event.tx_hash === source.signature
    && event.timestamp === source.block_time
    && event.source === 'wallet_source_transaction_v1'
    && event.extraction_method === 'injected_wallet_spot_normalizer_v1'
    && event.token_in_mint === debit.mint
    && event.token_in_amount === debitAmount
    && event.token_in_decimals === debit.decimals
    && event.token_out_mint === credit.mint
    && event.token_out_amount === credit.amount
    && event.token_out_decimals === credit.decimals;
  if (!exact) failWalletAcquisitionV1('source_transaction_mismatch');
  const classified = stableClassifyEvent(event);
  if (!['buy','sell'].includes(classified.action)
      || classified.baseMint !== (QUOTE_MINTS_V1.includes(debit.mint) ? credit.mint : debit.mint)
      || classified.quoteMint !== (QUOTE_MINTS_V1.includes(debit.mint) ? debit.mint : credit.mint)) {
    failWalletAcquisitionV1('source_transaction_mismatch');
  }
  try {
    return buildEventRecordV1({ source_slot: source.slot, slice7_event: event });
  } catch {
    failWalletAcquisitionV1('source_transaction_mismatch');
  }
}

export function classifyWalletSourceTransactionV1(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)) failWalletAcquisitionV1('invalid_source_transaction');
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    failWalletAcquisitionV1('invalid_source_transaction');
  }
  const keys = Object.keys(descriptors);
  if (keys.length !== INPUT_FIELDS.length || keys.some(key => !INPUT_FIELDS.includes(key))
      || INPUT_FIELDS.some(key => !Object.hasOwn(descriptors, key))
      || Object.getOwnPropertySymbols(input).length
      || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    failWalletAcquisitionV1('invalid_source_transaction');
  }
  const source = buildWalletSourceTransactionV1(descriptors.sourceTransaction.value);
  const normalizer = descriptors.normalizeSupportedSpotOperation.value;
  if (typeof normalizer !== 'function') failWalletAcquisitionV1('normalization_failed');

  if (source.execution_state === 'failed') return buildFinalResult(source, 'failed_transaction');

  const operations = economicOperations(source);
  if (operations.length === 0) return buildFinalResult(source, 'unrelated_activity');
  const { positionMints, quoteMints, hasUnknownMint } = localizedMints(operations);
  if (hasUnknownMint) return ambiguous(source, [], [], true);
  if (positionMints.length === 0) return buildFinalResult(source, 'unrelated_activity');
  if (operations.some(operation => ['unknown','none'].includes(operation.direction))) {
    return ambiguous(source, positionMints, quoteMints);
  }

  const supportedOperations = supportedOperationView(source, operations);
  if (supportedOperations === null) {
    const onlyTransfers = operations.every(operation => operation.operation_kind === 'transfer');
    return unsupported(source, positionMints, quoteMints, onlyTransfers ? 'unsupported_transfer_activity' : 'unsupported_swap_shape');
  }

  const normalized = invokeNormalizer(normalizer, source, supportedOperations);
  if (normalized.outcome === 'unsupported_shape') return unsupported(source, positionMints, quoteMints);
  if (['ambiguous_shape','no_supported_operation'].includes(normalized.outcome)) return ambiguous(source, positionMints, quoteMints);
  const eventRecord = reconcileEvent(source, supportedOperations, normalized.event);
  return buildFinalResult(source, 'supported_normalized_event', { eventRecord, positionMints });
}
