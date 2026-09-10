import { Transaction } from '@solana/web3.js';
import { encodeBase58 } from '../reused/bounded-rebroadcast-v1.mjs';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// Controlled provider fixture only. This is not a source adapter or an exporter.
export function syntheticSupervisedFinalizedTransactionV1(m, wire, phase, amount, output, slot, time) {
  const message = Transaction.from(wire).compileMessage(), keys = message.accountKeys.map(k => k.toBase58());
  const index = key => keys.indexOf(key), acquisition = phase === 'ACQUISITION';
  const targetBefore = acquisition ? 0n : BigInt(amount), targetAfter = acquisition ? BigInt(output) : 0n;
  const quoteBefore = acquisition ? 6000000n : 1000000n, quoteAfter = acquisition ? 1000000n : 1000000n + BigInt(output);
  const balance = (account, mint, owner, n) => ({ accountIndex: index(account), mint, owner,
    uiTokenAmount: { amount: String(n), decimals: 6, uiAmount: null, uiAmountString: String(Number(n) / 1e6) }, programId: TOKEN });
  const rows = (target, quote) => [balance(m.wallet_scope.jup_ata, m.asset_scope.jup_mint, m.wallet_scope.wallet, target),
    balance(m.wallet_scope.usdc_ata, m.asset_scope.usdc_mint, m.wallet_scope.wallet, quote),
    balance(m.route_scope.jup_vault, m.asset_scope.jup_mint, m.route_scope.pool, 1000000000000n - target),
    balance(m.route_scope.usdc_vault, m.asset_scope.usdc_mint, m.route_scope.pool, 1000000000000n - quote)];
  const transfer = (from, to, owner, n) => { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(BigInt(n), 1);
    return { programIdIndex: index(TOKEN), accounts: [from, to, owner].map(index), data: encodeBase58(b), stackHeight: 2 }; };
  const transfers = acquisition ? [transfer(m.wallet_scope.usdc_ata, m.route_scope.usdc_vault, m.wallet_scope.wallet, amount),
    transfer(m.route_scope.jup_vault, m.wallet_scope.jup_ata, m.route_scope.pool, output)]
    : [transfer(m.wallet_scope.jup_ata, m.route_scope.jup_vault, m.wallet_scope.wallet, amount),
      transfer(m.route_scope.usdc_vault, m.wallet_scope.usdc_ata, m.route_scope.pool, output)];
  const preBalances = keys.map((_, i) => i === 0 ? acquisition ? 820624 : 815624 : 0), postBalances = [...preBalances]; postBalances[0] -= 5000;
  return { slot, blockTime: time, version: 'legacy', transaction: [wire.toString('base64'), 'base64'], meta: { err: null, fee: 5000, preBalances, postBalances,
    preTokenBalances: rows(targetBefore, quoteBefore), postTokenBalances: rows(targetAfter, quoteAfter),
    innerInstructions: [{ index: 0, instructions: transfers }], logMessages: [], rewards: [], loadedAddresses: { writable: [], readonly: [] }, computeUnitsConsumed: 1 } };
}
