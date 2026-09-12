import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildRecoveredSetupMandateV2, RECOVERED_SETUP_AUTHORITY_V2 } from './recovered-setup-v2.mjs';
import { fixedTestMandateInputV1 } from './fixtures/fixed-test-identities-v1.mjs';
const source = await import('./supervised-setup-source-v1.mjs');

test('V2 production setup source must equal both pinned original setup identities', () => {
  assert.equal(typeof source.validateRecoveredSetupProviderPopulationV2, 'function');
  const input = fixedTestMandateInputV1();
  input.setup_authority = { ...RECOVERED_SETUP_AUTHORITY_V2, custodian_attestation_sha256: 'a'.repeat(64) };
  const mandate = buildRecoveredSetupMandateV2(input);
  const publicFixture = JSON.parse(readFileSync(new URL('./fixtures/recovered-setup-v2.json', import.meta.url)));
  const provenance = JSON.parse(Buffer.from(publicFixture.provenance_base64, 'base64'));
  const observations = provenance.original_setup.transactions.map(t => ({ signature: t.signature, slot: t.slot,
    block_time: t.block_time, signed_wire_sha256: t.signed_bytes_sha256, execution_state: 'succeeded' }));
  assert.equal(source.validateRecoveredSetupProviderPopulationV2({ mandate, observations }), true);
  assert.equal(typeof source.validateRecoveredSetupHistoryV2, 'function');
  const history = observations.map(({ signed_wire_sha256, ...row }) => row);
  assert.equal(source.validateRecoveredSetupHistoryV2({ mandate, observations: history }), true);
  assert.throws(() => source.validateRecoveredSetupHistoryV2({ mandate, observations: history.slice(0, 1) }));
  for (const field of ['slot', 'block_time', 'signed_wire_sha256', 'execution_state', 'signature']) {
    const altered = structuredClone(observations);
    altered[0][field] = typeof altered[0][field] === 'number' ? altered[0][field] + 1 : 'contradiction';
    assert.throws(() => source.validateRecoveredSetupProviderPopulationV2({ mandate, observations: altered }));
  }
  assert.throws(() => source.validateRecoveredSetupProviderPopulationV2({ mandate, observations: observations.slice(0, 1) }));
  assert.throws(() => source.validateRecoveredSetupProviderPopulationV2({ mandate, observations: [observations[0], observations[0]] }));
});
