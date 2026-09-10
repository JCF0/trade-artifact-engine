import { Message } from '@solana/web3.js';
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
  const seen = new Set();
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
  }
}
