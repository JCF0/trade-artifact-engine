// Retained real transaction bodies; all history/anchor/boundary carriers below are
// explicitly synthetic test scaffolding, NOT a final agent-directed episode.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { SOLANA_MAINNET_GENESIS_HASH } from '../../../wallet-acquisition/request-contract.mjs';
import { inspectSignedLegacyWire } from '../reused/bounded-rebroadcast-v1.mjs';
export const hash = b => createHash('sha256').update(b).digest('hex');
export const WALLET = '6nHvRF1wK9T4wdnbSZES4mrAfKfJPkVX5wrHqhbkDBgs';
export const TARGET = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const rpc = result => ({ jsonrpc: '2.0', id: 1, result });
export function retainedEpisodeFixtureV1() {
  const files = new Map();
  const put = (name, value) => { files.set(name, Buffer.from(JSON.stringify(value))); return name; };
  for (const leg of ['acquisition', 'disposal']) files.set(`${leg}.json`, readFileSync(new URL(`retained-calibration-${leg}-response.json`, import.meta.url)));
  const txs = ['acquisition', 'disposal'].map(leg => {
    const raw = JSON.parse(files.get(`${leg}.json`)).result;
    return { ...raw, transaction: { signatures: [inspectSignedLegacyWire(raw.transaction[0]).expectedSignature] } };
  });
  const descriptor = {
    version: 'artifact_final_episode_replay_v1',
    evidence_kind: 'CALIBRATION_TRANSACTIONS_SYNTHETIC_BOUNDARIES',
    scope: { wallet: WALLET, target_mint: TARGET, exact_quote_mint: QUOTE,
      route_program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', route_pool: '4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP' },
    acquisition_request: {
      request_version: 'wallet_wide_acquisition_request_v2', chain: 'solana', network: 'mainnet-beta', genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
      wallet: WALLET, window: { window_version: 'fixed_lookback_latest_state_v1', lookback_profile: 'lookback_30d_v1', requested_lookback_seconds: 2592000, initial_before_signature: null },
      finality: { commitment: 'finalized', boundary_profile: 'solana_finalized_anchor_v1', max_anchor_search_slots: 32 },
      budgets: { pagination_profile: 'solana_full_transaction_page_100_v1', page_size: 100, max_pages: 100, max_transactions: 10000,
        retry_profile: 'bounded_exponential_retry_v1', max_attempts_per_operation: 1, timeout_profile: 'bounded_provider_timeout_v1',
        request_timeout_ms: 60000, overall_timeout_ms: 300000, exact_fallback_profile: 'finalized_get_transaction_missing_only_v1', max_exact_fallback_transactions: 0 },
      profiles: { wallet_acquisition_profile: 'wallet_wide_bounded_history_v1', wallet_normalization_profile: 'artifact_wallet_wide_solana_spot_normalization_v1' },
    },
    history: { genesis: put('genesis.json', rpc(SOLANA_MAINNET_GENESIS_HASH)), slot: put('slot.json', rpc(444223891)),
      block: put('block.json', rpc({ blockTime: 1788518190, blockhash: '11111111111111111111111111111111' })),
      pages: [put('history.json', rpc([...txs].reverse().map(t => ({ signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime, err: t.meta.err, memo: null, confirmationStatus: 'finalized' }))))] },
    transactions: txs.map((t, i) => ({ signature: t.transaction.signatures[0], response: i === 0 ? 'acquisition.json' : 'disposal.json' })),
    opening: null, ending: null, selection: null, control: null,
  };
  for (const [name, slot] of [['opening', 444006969], ['ending', 444223890]]) {
    const data = Buffer.alloc(165); new PublicKey(TARGET).toBuffer().copy(data); new PublicKey(WALLET).toBuffer().copy(data, 32); data[108] = 1;
    const paths = [TOKEN, TOKEN2022].map((program, i) => put(`${name}-${i}.json`, rpc({ context: { slot }, value: i ? [] : [{
      pubkey: '88RjLVrrgiowBs7ZG4NqSGhVSsqBZFVVXuMnnpWdwmr6', account: { data: [data.toString('base64'), 'base64'], executable: false,
        lamports: 2039280, owner: program, rentEpoch: 0, space: 165 },
    }] })));
    descriptor[name] = { minimum_context_slot: slot, classic: paths[0], token_2022: paths[1] };
  }
  return { descriptor, files };
}
export function writeRetainedEpisodeFixtureV1(root, fixture) {
  const files = new Map(fixture.files); files.set('episode.json', Buffer.from(JSON.stringify(fixture.descriptor)));
  for (const [name, bytes] of files) writeFileSync(join(root, name), bytes);
  const manifest = Buffer.from(JSON.stringify({ version: 'artifact_retained_episode_package_v1', members: [...files].sort(([a], [b]) => a < b ? -1 : 1).map(([path, b]) => ({ path, bytes: b.length, sha256: hash(b) })) }));
  writeFileSync(join(root, 'manifest.json'), manifest);
  return { root, expected_manifest_sha256: hash(manifest), expected_evidence_kind: fixture.descriptor.evidence_kind };
}
