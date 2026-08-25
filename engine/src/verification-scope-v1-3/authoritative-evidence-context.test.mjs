import assert from 'node:assert/strict';
import test from 'node:test';

import { createWalletHistoryPortV2 } from '../wallet-acquisition/provider-port-v2.mjs';
import { acquireWalletHistoryV2 } from '../wallet-acquisition/orchestrator.mjs';
import {
  DETACHED_RETAINED_FULL_TRANSACTIONS_V1,
  offlineFullTransactionHistoryFixtureV2,
} from '../wallet-acquisition/fixtures/retained-full-transaction-fixtures.mjs';
import {
  JUP_MINT_V1,
  JUP_WALLET_V1,
} from '../wallet-acquisition/fixtures/retained-provider-fixtures.mjs';
import { providerPublicKey } from '../wallet-acquisition/fixtures/test-identities.mjs';
import { sha256CanonicalJson } from './contract.mjs';
import {
  TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1,
  captureTargetAccountEnumerationV1,
  createTargetAccountEnumerationPortV1,
} from '../wallet-acquisition/target-account-enumeration-port-v1.mjs';
import {
  captureEvidenceContextSidecarV1,
  createEvidenceContextTranscriptPortV1,
} from '../wallet-acquisition/evidence-context-sidecar-v1.mjs';
import {
  buildSourceBoundAuthoritativeEvidenceContextV13,
  validateAuthoritativeEvidenceContextStructureV13,
  validateSourceBoundAuthoritativeEvidenceContextV13,
} from './authoritative-evidence-context.mjs';

const [TOKEN_PROGRAM, TOKEN_2022_PROGRAM] = TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1;
const TARGET_ACCOUNT = providerPublicKey('authoritative-context-target-account');

function account(rawAmount = '1') {
  return {
    account: TARGET_ACCOUNT,
    account_program: TOKEN_PROGRAM,
    lamports: '2039280',
    executable: false,
    rent_epoch: '0',
    raw_account_data: { encoding: 'base64', bytes: 'AQIDBA==' },
    normalized_state_profile: 'CAPABILITY_ATTESTED_TOKEN_ACCOUNT_STATE_V1',
    token_state: {
      mint: JUP_MINT_V1,
      token_authority: JUP_WALLET_V1,
      raw_amount: rawAmount,
      decimals: 6,
      delegate_status: 'NONE',
      delegate: null,
      delegated_raw_amount: '0',
      close_authority_status: 'NONE',
      close_authority: null,
      lifecycle_state: 'EXISTS',
      account_state: 'INITIALIZED',
    },
  };
}

function accountForProgram(tokenProgram, rawAmount = '7') {
  const value = account(rawAmount);
  value.account = providerPublicKey(`authoritative-context-${tokenProgram}-account`);
  value.account_program = tokenProgram;
  return value;
}

function enumerationPort(slot, accountsByProgram = {}) {
  const calls = [];
  return {
    calls,
    port: createTargetAccountEnumerationPortV1({
      async enumerateTargetAccountsByProgramV1(request) {
        calls.push(structuredClone(request));
        return {
          context: { slot },
          accounts: structuredClone(accountsByProgram[request.token_program] ?? []),
        };
      },
    }),
  };
}

function rehashEnumeration(enumeration) {
  const { enumeration_digest: ignored, ...preimage } = enumeration;
  enumeration.enumeration_digest = sha256CanonicalJson(preimage);
}

function rehashContext(context) {
  const { evidence_context_digest: ignored, ...preimage } = context;
  context.evidence_context_digest = sha256CanonicalJson(preimage);
}

function omitEndingProgramAccounts(context, programIndex) {
  const forged = structuredClone(context);
  const snapshot = forged.ending_snapshot;
  const enumeration = snapshot.enumeration_evidence;
  enumeration.program_results[programIndex].accounts = [];
  rehashEnumeration(enumeration);
  snapshot.enumeration_digest = enumeration.enumeration_digest;
  snapshot.program_coverage_evidence[programIndex].account_count = 0;
  snapshot.accounts = [];
  snapshot.account_count = 0;
  snapshot.target_decimals = null;
  snapshot.aggregate_raw_quantity = '0';
  snapshot.zero_status = 'EXACT_ZERO';
  forged.population_reconciliation.ending_account_count = 0;
  forged.population_reconciliation.ending_population_digest = enumeration.enumeration_digest;
  rehashContext(forged);
  return forged;
}

async function enumeration(slot, tokenAccounts = [], omittedProgram = null, boundaryKind = 'OPENING') {
  const capability = {
    async enumerateTargetAccountsByProgramV1({ token_program }) {
      if (token_program === omittedProgram) return undefined;
      return {
        context: { slot },
        accounts: token_program === TOKEN_PROGRAM ? structuredClone(tokenAccounts) : [],
      };
    },
  };
  return captureTargetAccountEnumerationV1({
    port: createTargetAccountEnumerationPortV1(capability),
    wallet: JUP_WALLET_V1,
    target_mint: JUP_MINT_V1,
    boundary_kind: boundaryKind,
  });
}

async function fixture() {
  const offline = offlineFullTransactionHistoryFixtureV2({
    wallet: JUP_WALLET_V1,
    retainedBodyNames: ['jup_buy_full', 'jup_sell_full'],
  });
  const legacyAcquisitionResult = await acquireWalletHistoryV2(offline.request, {
    walletHistoryPort: createWalletHistoryPortV2(offline.port, { beginAcquisitionV2() {} }),
  });
  const fullTransactions = [
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_buy_full,
    DETACHED_RETAINED_FULL_TRANSACTIONS_V1.jup_sell_full,
  ].sort((left, right) => right.slot - left.slot || right.block_time - left.block_time);
  const authoritativePopulation = fullTransactions.map(({ signature, slot, block_time, execution_state }) => ({
    signature, slot, block_time, execution_state,
  }));
  const transcriptPort = createEvidenceContextTranscriptPortV1({
    async getAuthoritativeTransactionTranscriptV1() {
      return {
        authoritative_population: authoritativePopulation,
        full_transactions: fullTransactions,
      };
    },
  });
  const sidecar = await captureEvidenceContextSidecarV1({
    port: transcriptPort,
    legacy_acquisition_result: legacyAcquisitionResult,
  });
  const openingEnumeration = await enumeration(fullTransactions.at(-1).slot - 1, []);
  const endingEnumeration = await enumeration(
    fullTransactions[0].slot + 1, [account('1')], null, 'ENDING_AS_OF',
  );
  return {
    legacyAcquisitionResult,
    authoritativePopulation,
    fullTransactions,
    transcriptPort,
    sidecar,
    openingEnumeration,
    endingEnumeration,
    openingEnumerationPort: enumerationPort(openingEnumeration.enumeration_context.slot).port,
    endingEnumerationPort: enumerationPort(endingEnumeration.enumeration_context.slot, {
      [TOKEN_PROGRAM]: [account('1')],
    }).port,
  };
}

function buildInput(value, overrides = {}) {
  return {
    transaction_transcript_port: value.transcriptPort,
    legacy_acquisition_result: value.legacyAcquisitionResult,
    opening_enumeration_port: value.openingEnumerationPort,
    ending_enumeration_port: value.endingEnumerationPort,
    target_mint: JUP_MINT_V1,
    opening_basis_reference: null,
    ...overrides,
  };
}

function sourceBoundInput(value, context) {
  return {
    context,
    transaction_transcript_port: value.transcriptPort,
    legacy_acquisition_result: value.legacyAcquisitionResult,
    opening_enumeration_port: value.openingEnumerationPort,
    ending_enumeration_port: value.endingEnumerationPort,
    target_mint: JUP_MINT_V1,
    opening_basis_reference: null,
  };
}

test('builds one immutable source-bound carrier with exact empty opening and one-unit ending populations', async () => {
  const value = await fixture();
  const context = await buildSourceBoundAuthoritativeEvidenceContextV13(buildInput(value));

  assert.equal(validateAuthoritativeEvidenceContextStructureV13(context), true);
  assert.equal(await validateSourceBoundAuthoritativeEvidenceContextV13(sourceBoundInput(value, context)), true);
  assert.equal(context.analyzed_wallet, JUP_WALLET_V1);
  assert.equal(context.target_mint, JUP_MINT_V1);
  assert.equal(context.transaction_population.sidecar_digest, value.sidecar.sidecar_digest);
  assert.equal(context.opening_snapshot.boundary_kind, 'OPENING');
  assert.equal(context.opening_snapshot.boundary.slot, value.openingEnumeration.enumeration_context.slot);
  assert.equal(context.opening_snapshot.account_population_status, 'COMPLETE');
  assert.equal(context.opening_snapshot.account_count, 0);
  assert.equal(context.opening_snapshot.aggregate_raw_quantity, '0');
  assert.equal(context.opening_snapshot.zero_status, 'EXACT_ZERO');
  assert.equal(context.ending_snapshot.account_count, 1);
  assert.equal(context.ending_snapshot.aggregate_raw_quantity, '1');
  assert.equal(context.ending_snapshot.zero_status, 'EXACT_NONZERO');
  assert.equal(context.ending_snapshot.accounts[0].account, TARGET_ACCOUNT);
  assert.equal(context.ending_snapshot.accounts[0].raw_amount, '1');
  assert.equal(
    context.ending_snapshot.accounts[0].normalized_state_profile,
    'CAPABILITY_ATTESTED_TOKEN_ACCOUNT_STATE_V1',
  );
  assert.match(context.ending_snapshot.accounts[0].normalized_state_evidence_digest, /^[0-9a-f]{64}$/);
  assert.equal(context.external_custody_continuity.status, 'UNRESOLVED');
  assert.equal(context.opening_basis_status, 'EXACT_ZERO_DERIVED_FROM_OPENING_SNAPSHOT');
  assert.match(context.evidence_context_digest, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(context.ending_snapshot.accounts[0]));
  assert.ok(Object.isFrozen(context.transaction_population.transactions[0].full_transaction));
});

test('explicit empty population requires both successful program coverages and retains raw evidence for non-empty accounts', async () => {
  const value = await fixture();
  const context = await buildSourceBoundAuthoritativeEvidenceContextV13(buildInput(value));
  assert.deepEqual(context.opening_snapshot.required_token_programs, [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
  assert.equal(context.opening_snapshot.program_coverage_evidence.length, 2);
  assert.ok(context.opening_snapshot.program_coverage_evidence.every(item => item.response_status === 'SUCCESS'));
  assert.match(context.ending_snapshot.accounts[0].raw_account_evidence_digest, /^[0-9a-f]{64}$/);

  const omittedProgramPort = createTargetAccountEnumerationPortV1({
    async enumerateTargetAccountsByProgramV1({ token_program }) {
      if (token_program === TOKEN_2022_PROGRAM) return undefined;
      return { context: { slot: value.openingEnumeration.enumeration_context.slot }, accounts: [] };
    },
  });
  await assert.rejects(buildSourceBoundAuthoritativeEvidenceContextV13(buildInput(value, {
    opening_enumeration_port: omittedProgramPort,
  })), error => error.code === 'account_enumeration_response_invalid');
});

test('derives both boundaries from enumeration response contexts and rejects caller boundary or completeness assertions', async () => {
  const value = await fixture();
  const context = await buildSourceBoundAuthoritativeEvidenceContextV13(buildInput(value));
  assert.equal(context.opening_snapshot.boundary.slot, value.openingEnumeration.program_results[0].context.slot);
  assert.equal(context.ending_snapshot.boundary.slot, value.endingEnumeration.program_results[0].context.slot);

  await assert.rejects(buildSourceBoundAuthoritativeEvidenceContextV13({ ...buildInput(value), complete: true }),
    error => error.code === 'unknown_field');
  await assert.rejects(buildSourceBoundAuthoritativeEvidenceContextV13({ ...buildInput(value), boundary_slot: 1 }),
    error => error.code === 'unknown_field');
});

test('requires opening before the oldest transaction and ending after the newest transaction', async () => {
  const value = await fixture();
  const atOldest = enumerationPort(value.fullTransactions.at(-1).slot).port;
  await assert.rejects(buildSourceBoundAuthoritativeEvidenceContextV13(buildInput(value, {
    opening_enumeration_port: atOldest,
  })),
    error => error.code === 'snapshot_boundary_not_authoritative');

  const atNewest = enumerationPort(value.fullTransactions[0].slot, { [TOKEN_PROGRAM]: [account('0')] }).port;
  await assert.rejects(buildSourceBoundAuthoritativeEvidenceContextV13(buildInput(value, {
    ending_enumeration_port: atNewest,
  })),
    error => error.code === 'snapshot_boundary_not_authoritative');
});

test('keeps a positive opening basis reference identity-bound but unresolved until its evidence profile exists', async () => {
  const value = await fixture();
  value.openingEnumerationPort = enumerationPort(
    value.fullTransactions.at(-1).slot - 1, { [TOKEN_PROGRAM]: [account('9')] },
  ).port;
  const reference = {
    basis_evidence_profile: 'ARTIFACT_OPENING_BASIS_EVIDENCE_V1',
    basis_evidence_digest: 'a'.repeat(64),
  };
  const context = await buildSourceBoundAuthoritativeEvidenceContextV13(buildInput(value, { opening_basis_reference: reference }));
  assert.deepEqual(context.opening_basis_reference, reference);
  assert.equal(context.opening_basis_status, 'REFERENCED_NOT_RESOLVED');

  await assert.rejects(buildSourceBoundAuthoritativeEvidenceContextV13(buildInput(value)),
    error => error.code === 'opening_basis_reference_required');
});

test('rejects context, transaction, enumeration, and digest mutation under source-bound validation', async () => {
  const value = await fixture();
  const original = await buildSourceBoundAuthoritativeEvidenceContextV13(buildInput(value));
  for (const mutate of [
    candidate => { candidate.ending_snapshot.aggregate_raw_quantity = '0'; },
    candidate => { candidate.ending_snapshot.accounts[0].raw_amount = '0'; },
    candidate => { candidate.transaction_population.transactions[0].source_identity.slot -= 1; },
    candidate => { candidate.evidence_context_digest = '0'.repeat(64); },
  ]) {
    const forged = structuredClone(original);
    mutate(forged);
    assert.throws(() => validateAuthoritativeEvidenceContextStructureV13(forged));
    await assert.rejects(validateSourceBoundAuthoritativeEvidenceContextV13(sourceBoundInput(value, forged)));
  }
});

test('exposes only source-bound authoritative context construction', async () => {
  const api = await import('./authoritative-evidence-context.mjs');
  assert.equal(api.buildAuthoritativeEvidenceContextV13, undefined);
  assert.equal(api.validateAuthoritativeEvidenceContextV13, undefined);
  assert.equal(typeof api.validateAuthoritativeEvidenceContextStructureV13, 'function');
  assert.equal(typeof api.buildSourceBoundAuthoritativeEvidenceContextV13, 'function');
});

test('source-bound context recaptures both enumerations and rejects self-rehashed omissions per token program', async () => {
  const value = await fixture();
  for (const [programIndex, tokenProgram] of TARGET_ACCOUNT_ENUMERATION_REQUIRED_PROGRAMS_V1.entries()) {
    const opening = enumerationPort(value.fullTransactions.at(-1).slot - 1);
    const ending = enumerationPort(value.fullTransactions[0].slot + 1, {
      [tokenProgram]: [accountForProgram(tokenProgram)],
    });
    const sourceInput = {
      transaction_transcript_port: value.transcriptPort,
      legacy_acquisition_result: value.legacyAcquisitionResult,
      opening_enumeration_port: opening.port,
      ending_enumeration_port: ending.port,
      target_mint: JUP_MINT_V1,
      opening_basis_reference: null,
    };
    const context = await buildSourceBoundAuthoritativeEvidenceContextV13(sourceInput);
    const forged = omitEndingProgramAccounts(context, programIndex);

    const api = await import('./authoritative-evidence-context.mjs');
    assert.equal(api.validateAuthoritativeEvidenceContextStructureV13(forged), true);
    await assert.rejects(buildSourceBoundAuthoritativeEvidenceContextV13({
      ...sourceInput,
      ending_enumeration: forged.ending_snapshot.enumeration_evidence,
    }), error => error.code === 'unknown_field');
    await assert.rejects(validateSourceBoundAuthoritativeEvidenceContextV13({
      context: forged,
      ...sourceInput,
    }), error => error.code === 'evidence_context_source_mismatch');
    assert.equal(ending.calls.length, 4);
    assert.deepEqual(ending.calls.map(call => call.boundary_kind), [
      'ENDING_AS_OF', 'ENDING_AS_OF', 'ENDING_AS_OF', 'ENDING_AS_OF',
    ]);
  }
});
