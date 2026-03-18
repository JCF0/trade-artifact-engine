# Trade Artifact Engine — Scope (V1)

## Purpose

Reconstruct closed spot trades from Solana wallet transaction history and generate verifiable trade receipts showing entry price, exit price, and realized PnL.

Receipts are derived directly from on-chain data — no self-reported numbers, no screenshots.

## Chain

Solana only. No EVM, no multi-chain.

## Trade Type

Closed spot swap cycles only.

A trade cycle is: buy → (optional accumulation) → sell → balance returns to ~zero.

## Accounting Method

Weighted average cost basis for both entry and exit pricing.

## V1 Target

Phases 0–6 only:

- Phase 0 — Repository setup
- Phase 1 — Solana transaction ingest (Helius)
- Phase 2 — Event normalization
- Phase 3 — Trade cycle reconstruction
- Phase 4 — PnL engine
- Phase 5 — Receipt generator (JSON)
- Phase 6 — Receipt renderer (PNG)

## Unsupported in V1

- Open / incomplete positions
- Perpetual or leveraged trades
- Multi-chain trades
- Transfers (non-swap token movements)
- LP positions / yield farming
- DCA strategies (may appear as multiple buys but are not distinguished)
- NFT trades
- Agent reputation or wallet scoring (planned for later phases)
