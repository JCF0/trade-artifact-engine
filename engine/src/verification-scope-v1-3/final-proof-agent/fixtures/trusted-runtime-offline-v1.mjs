import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';

// Synthetic eligible acquisition, with retained route bytes only. Not historical
// wallet eligibility, endpoint conformance, or onchain test-wallet occurrence.
export function syntheticRuntimeCaptureV1(mandate) {
  const route = JSON.parse(readFileSync(new URL('../../../../orca-readiness-sdk/fixtures/raw-rpc-3107-getMultipleAccounts.json', import.meta.url))).result.value;
  for (const a of route) a.rentEpoch = 0;
  const time = { wall: 1900000010, mono: 0 };
  const calls = [];
  const budget = { total_calls: 64, call_timeout_ms: 1000, overall_timeout_ms: 60000, freshness_seconds: 30,
    history_pages: 4, max_response_bytes: 1048576, fee_retry_count: 1, fee_retry_delay_ms: 0,
    methods: { getGenesisHash: 1, getSlot: 1, getBlock: 1, getMultipleAccounts: 2, getAccountInfo: 1,
      getTokenAccountsByOwner: 2, getSignaturesForAddress: 12, getLatestBlockhash: 1, getFeeForMessage: 2, getBlockHeight: 1 } };
  function account(index, amount) {
    const a = structuredClone(route[index]);
    const b = Buffer.from(a.data[0], 'base64');
    new PublicKey(mandate.wallet_scope.wallet).toBuffer().copy(b, 32);
    b.writeBigUInt64LE(BigInt(amount), 64); a.data[0] = b.toString('base64'); return a;
  }
  const opening = [{ owner: '11111111111111111111111111111111', executable: false,
    data: ['', 'base64'], lamports: 820624, rentEpoch: 0 }, account(4, '0'), account(5, '6000000')];
  const context = value => ({ context: { slot: 900000000 }, value });
  return { budget, calls, time,
    clock: { unixSeconds: () => time.wall, monotonicMs: () => time.mono },
    async transport({ body, signal }) {
      if (signal.aborted) throw Error('aborted fixture request');
      calls.push(body);
      let result;
      switch (body.method) {
        case 'getGenesisHash': result = mandate.network.genesis_hash; break;
        case 'getSlot': result = 900000000; break;
        case 'getBlock': result = { blockTime: time.wall, blockhash: mandate.wallet_scope.wallet }; break;
        case 'getMultipleAccounts': result = context(structuredClone(body.params[0].length === 3 ? opening : route)); break;
        case 'getTokenAccountsByOwner': result = context(body.params[1].programId === mandate.wallet_scope.token_program
          ? [1, 2].map(i => ({ pubkey: [null, mandate.wallet_scope.jup_ata, mandate.wallet_scope.usdc_ata][i], account: structuredClone(opening[i]) })) : []); break;
        case 'getSignaturesForAddress': result = body.params[1].before ? [] : [{ signature: '1'.repeat(64),
          slot: 1, blockTime: mandate.setup_authority.latest_setup_block_time, err: null, memo: null, confirmationStatus: 'finalized' }]; break;
        case 'getAccountInfo': result = context(structuredClone(route[0])); break;
        case 'getLatestBlockhash': result = context({ blockhash: mandate.wallet_scope.wallet, lastValidBlockHeight: 900000100 }); break;
        case 'getFeeForMessage': result = context(5000); break;
        case 'getBlockHeight': result = 900000000; break;
        default: throw Error('unexpected fixture method');
      }
      return JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    },
  };
}
