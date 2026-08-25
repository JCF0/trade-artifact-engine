import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from '../candidate-set/serialize.mjs';
import { buildWalletAcquisitionResultV1 } from '../candidate-set/acquisition-result.mjs';
import { recomputeCoverageV1 } from '../candidate-set/coverage.mjs';
import { buildDispositionV1, buildEventRecordV1 } from '../candidate-set/identity.mjs';
import { createWalletHistoryPortV2 } from './provider-port-v2.mjs';
import { acquireWalletHistoryV2 } from './orchestrator.mjs';
import {
  DETACHED_RETAINED_FULL_TRANSACTIONS_V1,
  offlineFullTransactionHistoryFixtureV2,
} from './fixtures/retained-full-transaction-fixtures.mjs';
import { JUP_WALLET_V1 } from './fixtures/retained-provider-fixtures.mjs';
import {
  captureEvidenceContextSidecarV1,
  createEvidenceContextTranscriptPortV1,
  validateEvidenceContextSidecarStructureV1,
  validateSourceBoundEvidenceContextSidecarV1,
} from './evidence-context-sidecar-v1.mjs';

async function fixture() {
  const offline = offlineFullTransactionHistoryFixtureV2({
    wallet: JUP_WALLET_V1,
    retainedBodyNames: ['jup_buy_full', 'jup_sell_full'],
  });
  const acquisitionResult = await acquireWalletHistoryV2(offline.request, {
    walletHistoryPort: createWalletHistoryPortV2(offline.port, { beginAcquisitionV2() {} }),
  });
  const transactions = [
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_buy_full,
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_sell_full,
  ].sort((left, right) => right.slot - left.slot || right.block_time - left.block_time);
  const population = transactions.map(({ signature, slot, block_time, execution_state }) => ({
    signature, slot, block_time, execution_state,
  }));
  return { acquisitionResult, transactions, population };
}

function input(value) {
  return {
    legacy_acquisition_result: value.acquisitionResult,
    authoritative_population: value.population,
    full_transactions: value.transactions,
  };
}

function transcriptPort(candidate) {
  return createEvidenceContextTranscriptPortV1({
    async getAuthoritativeTransactionTranscriptV1() {
      return {
        authoritative_population: candidate.authoritative_population,
        full_transactions: candidate.full_transactions,
      };
    },
  });
}

async function capture(candidate) {
  return captureEvidenceContextSidecarV1({
    port: transcriptPort(candidate),
    legacy_acquisition_result: candidate.legacy_acquisition_result,
  });
}

function sourceBoundInput(candidate, sidecar) {
  return {
    transcript_port: transcriptPort(candidate),
    legacy_acquisition_result: candidate.legacy_acquisition_result,
    sidecar,
  };
}

test('preserves authoritative newest-first population, reverse chronology, and matching full transactions beside unchanged legacy bytes', async () => {
  const value = await fixture();
  const legacyBytes = canonicalJson(value.acquisitionResult);
  const sidecar = await capture(input(value));

  assert.equal(validateEvidenceContextSidecarStructureV1(sidecar), true);
  assert.equal(await validateSourceBoundEvidenceContextSidecarV1(sourceBoundInput(input(value), sidecar)), true);
  assert.equal(canonicalJson(value.acquisitionResult), legacyBytes);
  assert.equal(sidecar.transactions.length, 2);
  assert.deepEqual(sidecar.transactions.map(item => item.acquisition_population_coordinate), [0, 1]);
  assert.deepEqual(sidecar.transactions.map(item => item.canonical_transaction_coordinate), [1, 0]);
  assert.deepEqual(sidecar.transactions.map(item => item.source_identity.signature), value.population.map(item => item.signature));
  assert.ok(sidecar.transactions.every(item => item.full_transaction.signature === item.source_identity.signature));
  assert.match(sidecar.legacy_acquisition_result_digest, /^[0-9a-f]{64}$/);
  assert.match(sidecar.population_evidence_digest, /^[0-9a-f]{64}$/);
  assert.match(sidecar.sidecar_digest, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(sidecar.transactions[0].full_transaction));
});

test('requires exact population membership reconciliation with legacy dispositions', async () => {
  const value = await fixture();
  for (const mutate of [
    candidate => { candidate.authoritative_population.pop(); candidate.full_transactions.pop(); },
    candidate => { candidate.authoritative_population[0].slot += 1; candidate.full_transactions[0].slot += 1; },
  ]) {
    const candidate = input(value);
    candidate.authoritative_population = structuredClone(candidate.authoritative_population);
    candidate.full_transactions = structuredClone(candidate.full_transactions);
    mutate(candidate);
    await assert.rejects(capture(candidate), error =>
      ['population_disposition_mismatch', 'source_transaction_mismatch'].includes(error.code));
  }
});

test('rejects response permutation, timestamp inversion, and non-dense coordinate forgery', async () => {
  const value = await fixture();
  const permuted = input(value);
  permuted.authoritative_population = [...permuted.authoritative_population].reverse();
  permuted.full_transactions = [...permuted.full_transactions].reverse();
  await assert.rejects(capture(permuted), error => error.code === 'noncanonical_population_order');

  const inverted = input(value);
  inverted.authoritative_population = structuredClone(inverted.authoritative_population);
  inverted.full_transactions = structuredClone(inverted.full_transactions);
  inverted.authoritative_population[1].block_time = inverted.authoritative_population[0].block_time + 1;
  inverted.full_transactions[1].block_time = inverted.authoritative_population[1].block_time;
  await assert.rejects(capture(inverted), error =>
    ['noncanonical_population_order', 'population_disposition_mismatch'].includes(error.code));

  const forged = structuredClone(await capture(input(value)));
  forged.transactions[0].canonical_transaction_coordinate = 0;
  assert.throws(() => validateEvidenceContextSidecarStructureV1(forged), error => error.code === 'noncanonical_population_coordinates');
});

test('rejects full-transaction mismatch and self-consistent sidecar mutation at source-bound validation', async () => {
  const value = await fixture();
  const mismatch = input(value);
  mismatch.full_transactions = structuredClone(mismatch.full_transactions);
  mismatch.full_transactions[0].slot -= 1;
  await assert.rejects(capture(mismatch), error => error.code === 'source_transaction_mismatch');

  const sidecar = structuredClone(await capture(input(value)));
  sidecar.transactions[0].source_identity.slot -= 1;
  assert.throws(() => validateEvidenceContextSidecarStructureV1(sidecar));
  await assert.rejects(validateSourceBoundEvidenceContextSidecarV1(sourceBoundInput(input(value), sidecar)), error =>
    ['source_binding_mismatch', 'source_transaction_mismatch'].includes(error.code));
});

test('rejects caller completeness flags and pagination-terminal rewrites', async () => {
  const value = await fixture();
  const transcriptPort = createEvidenceContextTranscriptPortV1({
    async getAuthoritativeTransactionTranscriptV1() {
      return {
        authoritative_population: value.population,
        full_transactions: value.transactions,
      };
    },
  });
  await assert.rejects(captureEvidenceContextSidecarV1({
    port: transcriptPort,
    legacy_acquisition_result: value.acquisitionResult,
    complete: true,
  }), error => error.code === 'unknown_field');
  await assert.rejects(captureEvidenceContextSidecarV1({
    port: transcriptPort,
    legacy_acquisition_result: value.acquisitionResult,
    pagination_terminal_reason: 'historical_bound_reached',
  }), error => error.code === 'unknown_field');
  const sidecar = await capture(input(value));
  assert.equal(sidecar.pagination_terminal_reason, value.acquisitionResult.coverage.pagination_terminal_reason);
  await assert.rejects(validateSourceBoundEvidenceContextSidecarV1({
    ...sourceBoundInput(input(value), sidecar), pagination_terminal_reason: 'historical_bound_reached',
  }), error => error.code === 'source_binding_mismatch');
});

test('requires an admitted transcript capability and exposes no direct authoritative sidecar builder', async () => {
  const value = await fixture();
  const sidecar = await capture(input(value));
  const api = await import('./evidence-context-sidecar-v1.mjs');
  assert.equal(api.buildEvidenceContextSidecarV1, undefined);
  assert.equal(api.validateEvidenceContextSidecarV1, undefined);
  assert.equal(typeof api.validateEvidenceContextSidecarStructureV1, 'function');
  assert.throws(
    () => createEvidenceContextTranscriptPortV1({ getAuthoritativeTransactionTranscriptV1: null }),
    error => error.code === 'invalid_transcript_capability',
  );
  const unsafePort = Object.freeze({
    async getAuthoritativeTransactionTranscriptV1() {
      return { authoritative_population: value.population, full_transactions: value.transactions };
    },
  });
  await assert.rejects(captureEvidenceContextSidecarV1({
    port: unsafePort,
    legacy_acquisition_result: value.acquisitionResult,
  }), error => error.code === 'invalid_transcript_port');
  await assert.rejects(validateSourceBoundEvidenceContextSidecarV1({
    ...input(value),
    sidecar,
  }), error => error.code === 'source_binding_mismatch');
});

test('source-bound validation rejects a persisted same-slot permutation against authoritative transcript order', async () => {
  const value = await fixture();
  const commonSlot = Math.min(...value.transactions.map(transaction => transaction.slot));
  const normalizedEventRecords = value.acquisitionResult.normalized_event_records.map(event => buildEventRecordV1({
    source_slot: commonSlot,
    slice7_event: event.slice7_event,
  }));
  const eventByTransaction = new Map(normalizedEventRecords.map(event => [event.slice7_event.tx_hash, event]));
  const transactionDispositions = value.acquisitionResult.transaction_dispositions.map(disposition => {
    const event = eventByTransaction.get(disposition.tx_hash);
    return buildDispositionV1({
      tx_hash: disposition.tx_hash,
      slot: commonSlot,
      block_time: disposition.block_time,
      disposition_type: disposition.disposition_type,
      affected_token_mints: disposition.affected_token_mints,
      normalized_event_digests: event === undefined ? [] : [event.event_digest],
      finding_digests: disposition.finding_digests,
    });
  });
  const coverage = recomputeCoverageV1({
    transactionDispositions,
    normalizedEventRecords,
    activityFindings: value.acquisitionResult.activity_findings,
    boundary: value.acquisitionResult.boundary,
    inputStatus: value.acquisitionResult.input_status,
    paginationTerminalReason: value.acquisitionResult.coverage.pagination_terminal_reason,
  });
  const acquisitionResult = buildWalletAcquisitionResultV1({
    ...value.acquisitionResult,
    coverage,
    transaction_dispositions: transactionDispositions,
    normalized_event_records: normalizedEventRecords,
  });
  const transactions = value.transactions.map(transaction => ({ ...transaction, slot: commonSlot }));
  const authoritativePopulation = transactions.map(({ signature, slot, block_time, execution_state }) => ({
    signature, slot, block_time, execution_state,
  }));
  const authoritativeInput = {
    legacy_acquisition_result: acquisitionResult,
    authoritative_population: authoritativePopulation,
    full_transactions: transactions,
  };
  const persistedPermutation = {
    legacy_acquisition_result: acquisitionResult,
    authoritative_population: [...authoritativePopulation].reverse(),
    full_transactions: [...transactions].reverse(),
  };
  const sidecar = await capture(persistedPermutation);

  assert.equal(validateEvidenceContextSidecarStructureV1(sidecar), true);
  await assert.rejects(validateSourceBoundEvidenceContextSidecarV1({
    transcript_port: transcriptPort(authoritativeInput),
    legacy_acquisition_result: acquisitionResult,
    sidecar,
  }), error => error.code === 'source_binding_mismatch');
});
