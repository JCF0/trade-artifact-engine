import { Message } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { RECOVERED_SETUP_PROFILE_V2 } from './recovered-setup-v2.mjs';
import { assertExactFields, canonicalJson } from '../contract.mjs';
import { validateHeliusFullTransactionV1 } from '../../wallet-acquisition/helius-full-transaction-validator.mjs';
import { inspectSignedLegacyWire } from './reused/bounded-rebroadcast-v1.mjs';
const need = v => { if (!v) throw new Error('SUPERVISED_SETUP_SOURCE_INVALID'); };
// Setup bodies corroborate retained history, never enter the episode's economic
// population and never substitute for authenticated setup archive identities.
export function validateSupervisedSetupSourceV1({ source, loaded, mandate: m, rpc_pairs }) {
  const admission = loaded.parseMemberV1(source.descriptor.history.admission), rows = new Map();
  for (const lane of admission.lanes) for (const page of lane.pages) {
    for (const row of loaded.parseMemberV1(page.response).result) if (row.blockTime <= m.setup_authority.latest_setup_block_time) {
      const prior = rows.get(row.signature);
      need(!prior || canonicalJson(prior) === canonicalJson(row)); rows.set(row.signature, row);
    }
  }
  need(Array.isArray(source.setup_transactions) && source.setup_transactions.length === rows.size);
  const seen = new Set(), observations = [];
  for (const item of source.setup_transactions) {
    assertExactFields(item, ['signature', 'response'], 'supervised_setup_transaction');
    const row = rows.get(item.signature); need(row && !seen.has(item.signature)); seen.add(item.signature);
    const envelope = loaded.parseMemberV1(item.response), raw = envelope.result;
    const pair = rpc_pairs.find(p => p.body.id === envelope.id);
    need(pair && canonicalJson(pair.body.params) === canonicalJson([item.signature,
      { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]) && pair.body.method === 'getTransaction');
    need(Array.isArray(raw?.transaction) && raw.transaction.length === 2 && raw.transaction[1] === 'base64');
    const inspected = inspectSignedLegacyWire(raw.transaction[0]), message = Message.from(inspected.message);
    const normalized = validateHeliusFullTransactionV1({ ...raw, transaction: { signatures: [inspected.expectedSignature],
      message: { header: message.header, accountKeys: message.accountKeys.map(k => k.toBase58()),
        recentBlockhash: message.recentBlockhash, instructions: message.instructions } } }, item.signature);
    need(normalized.signature === row.signature && normalized.slot === row.slot && normalized.block_time === row.blockTime
      && (normalized.execution_state === 'succeeded') === (row.err === null));
    observations.push({ signature: normalized.signature, slot: normalized.slot, block_time: normalized.block_time,
      signed_wire_sha256: createHash('sha256').update(inspected.wire).digest('hex'), execution_state: normalized.execution_state });
  }
  validateRecoveredSetupProviderPopulationV2({ mandate: m, observations });
}

// Exact original setup pins from the hash-bound recovered provenance, not new
// operator choices. Provider attestation corroborates, but never repairs custody.
// Disposable V2 has separate synthetic setup wires and is never production proof.
const EXPECTED_RECOVERED_SETUP = [
    { signature: '3fBHWizxAKzRdamG8QzFEvt9io6zvpUhVbC2Pq4dXuX5oqepWMHTcFMmkdkHVwtJNntv4sVzETmqDsPsaS9QsdqH',
      slot: 444518589, block_time: 1788611059, signed_wire_sha256: '5cb2b4bb7c17e491ecc68315c56c83111e211f34623b86f9b73e812846462b7b', execution_state: 'succeeded' },
    { signature: 'Y39KGmwuMGBexEZkAzcZHGGFpfZwxiVjSHRXyeWpHEdm2hiNDBwuhguuWfRFSmfPyp4c46boXuWfuM6wPMggnrR',
      slot: 444519132, block_time: 1788611228, signed_wire_sha256: 'aac4e50b84645d0af714be9a75084c0b2bb2d6af5f57b5a3aec4fad36f8a07a3', execution_state: 'succeeded' },
  ];
export function validateRecoveredSetupProviderPopulationV2({ mandate, observations }) {
  if (mandate.mandate_profile !== RECOVERED_SETUP_PROFILE_V2) return true;
  const expected = EXPECTED_RECOVERED_SETUP;
  need(Array.isArray(observations) && observations.length === expected.length);
  for (const wanted of expected) need(observations.filter(o => canonicalJson(o) === canonicalJson(wanted)).length === 1);
  return true;
}
export function validateRecoveredSetupHistoryV2({ mandate, observations }) {
  if (mandate.mandate_profile !== RECOVERED_SETUP_PROFILE_V2) return true;
  const expected = EXPECTED_RECOVERED_SETUP.map(({ signed_wire_sha256, ...row }) => row);
  need(Array.isArray(observations) && observations.length === expected.length);
  for (const wanted of expected) need(observations.filter(o => canonicalJson(o) === canonicalJson(wanted)).length === 1);
  return true;
}
