# Artifact Post-v1.9 Direction: Public Hosting First

## Stable Checkpoint

Artifact v1.9.0 is complete, tagged, and pushed.

The current system can:

- reconstruct supported Solana spot position episodes;
- generate deterministic canonical receipts;
- verify receipt hashes, schemas, and accounting consistency;
- preserve receipts from separate wallet runs in a deterministic local archive;
- resolve archived receipts through proof, verifier, card, export, hosted-preview, and board surfaces;
- display two real verified closed-position receipts on the Historical Verified Receipt Board;
- explain receipt-level coverage without claiming wallet, portfolio, trader, or track-record coverage.

v1.9 should remain the stable local baseline while the next product phase is planned.

## Paths Considered

### 1. More Real-Wallet Validation

Benefits:

- expands the receipt sample set;
- identifies additional normalization and accounting edge cases;
- improves confidence in coverage boundaries.

Limitations:

- produces diminishing returns without a public product surface;
- does not allow outside users to inspect Artifact easily;
- risks turning development into an endless edge-case loop.

Decision:

Continue selectively as supporting validation, not the primary next phase.

### 2. Public Read-Only Hosting

Benefits:

- makes real receipts independently inspectable and shareable;
- turns Artifact from a local prototype into a visible product;
- provides the public verification layer needed before mainnet proof minting matters;
- can preserve the current read-only, receipt-scoped model.

Risks:

- deployment and operational security;
- accidental exposure of local paths, wallet data, secrets, or unsupported artifacts;
- availability, rate limiting, monitoring, and rollback requirements;
- public wording could overstate what Artifact proves.

Decision:

**Provisional next direction.**

### 3. Mainnet Readiness

Benefits:

- creates a credible on-chain proof milestone;
- tests real mint costs, explorer visibility, metadata permanence, and operational security;
- moves Artifact beyond local/devnet status.

Risks:

- key custody and mint-authority security;
- irreversible or duplicate mints;
- metadata permanence and linkage decisions;
- real transaction costs and funding controls;
- a mainnet NFT has limited value without a stable public verifier.

Decision:

Plan after the hosted verifier is stable. Begin with one manually approved mainnet proof, not broad mint access.

## Provisional Sequence

```text
Freeze v1.9 local baseline
-> plan smallest read-only public deployment
-> deploy selected proof and board surfaces
-> validate security, disclosures, monitoring, and rollback
-> conduct mainnet-readiness review
-> mint one controlled mainnet proof
-> consider limited public beta
```

## Public-Hosting Gates

Before implementation:

- v1.9 remains the reproducible local baseline.
- Hosting is read-only.
- No upload, mint, signing, wallet connection, or account creation.
- Only publisher-selected archived receipts are deployed.
- No local filesystem paths, secrets, raw wallet history, or internal diagnostics are exposed.
- Wallet display policy is reviewed explicitly.
- Receipt Coverage Statements remain visible.
- Raw-quote/no-USD limitations remain visible.
- Board framing remains receipt-ranked and publisher-selected.
- Missing, corrupt, conflicting, or unverified receipts fail closed.
- Deployment has reproducible build steps, environment separation, logging, monitoring, rate limiting, and rollback.
- Public copy makes no portfolio, trader-skill, full-history, anti-wash, prize, or track-record claims.

## Mainnet Gates

Before any mainnet transaction:

- Public verifier and hosted proof pages are stable.
- Decide whether minting is optional proof enhancement or central product behavior.
- Finalize token standard and metadata-linkage approach.
- Verify explorer visibility and metadata permanence.
- Use a dedicated mint authority and proof wallet.
- Establish secure key custody; no secrets in repo, logs, chat output, or normal developer environment.
- Add explicit network, balance, metadata, receipt-status, duplicate-mint, and idempotency preflights.
- Define transaction cost and funding limits.
- Define failure recovery and canonical transaction recording.
- Require manual approval for the first mainnet receipt.
- Confirm that the receipt remains independently verifiable without trusting NFT metadata alone.

## Decision

Artifact's next primary phase should be:

```text
Smallest Safe Public Read-Only Deployment
```

More wallet validation continues only when it improves the hosted sample set or tests a clearly identified coverage boundary. Mainnet follows once the public verifier is stable enough for an external person to inspect the proof.
