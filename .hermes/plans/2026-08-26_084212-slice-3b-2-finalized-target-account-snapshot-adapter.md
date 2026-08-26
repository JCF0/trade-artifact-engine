# Verification Scope v1.3 Slice 3B-2 Implementation Plan

> **For Hermes:** Do not implement this plan until the user explicitly approves implementation and separately authorizes any network/provider compatibility work. Leave all changes uncommitted and unpushed unless the user later requests otherwise.

**Goal:** Add the smallest source-bound Solana RPC adapter and strict local raw decoder that can supply complete, finalized opening and ending JUP target-account snapshots to the committed Slice 3B-1 evidence-context carrier.

**Architecture:** An eager snapshot-capture adapter will issue separate raw `getTokenAccountsByOwner` requests for canonical SPL Token and Token-2022, retain only a pair whose finalized context slots are identical, strictly validate and locally decode all returned rows, locally filter the target mint, and expose the frozen pair through the existing 3B-1 enumeration capability. No caller supplies a completeness boolean. The implementation remains blocked until one exact RPC/provider contract is shown to be exhaustive and all-or-error rather than silently capped.

**Tech stack:** Node.js ESM; direct Solana JSON-RPC; committed `@solana/web3.js` 1.98.4 and `@solana/spl-token` 0.4.14 only as local references/utilities; `node:test`; existing v1.3 deterministic contract helpers.

---

## 0. Read-only inspection result and current gate

Repository inspected read-only at clean `main` HEAD `9775a576b0215c59b223e4cf823d8599a76fbebf` (`origin/main`). No implementation, provider call, signing, trade, mint, deployment, commit, or push was performed.

Authoritative dependencies inspected:

- `engine/docs/verification_scope_acceptability_v1_3.md`
- `engine/src/wallet-acquisition/target-account-enumeration-port-v1.mjs`
- `engine/src/wallet-acquisition/target-account-enumeration-port-v1.test.mjs`
- `engine/src/verification-scope-v1-3/authoritative-evidence-context.mjs`
- `engine/src/verification-scope-v1-3/authoritative-evidence-context.test.mjs`
- installed `@solana/web3.js/src/connection.ts`
- installed `@solana/spl-token/src/state/account.ts`
- installed `@solana/spl-token/src/state/mint.ts`
- installed Token-2022 account-type and extension sources under `@solana/spl-token/src/extensions/`

**Current verdict: STOP before implementation of positive account-population authority.** Local client/package source establishes request and decoding shapes, but does not establish the server/provider properties needed to rule out pagination, scan abort behavior, secondary-index exclusions, hosted response caps, Token-2022 disparity, or well-formed silent omission. No exact provider contract has yet been selected and current official server/provider documentation was not fetched because this planning task prohibited network access.

Implementation may begin only after Phase 0 below closes this gap. If it does not close, Slice 3B-2 must remain unresolved rather than issue positive zero or complete-population authority.

---

## 1. Recommended authoritative snapshot strategy

### 1.1 Atomic/common-context preference assessment

1. **One atomic standard RPC call:** Not established. Standard `getTokenAccountsByOwner` accepts one filter, so canonical Token and Token-2022 must be enumerated separately by program ID. JSON-RPC batching does not document that batched methods execute against one bank. It must not be treated as atomic.
2. **Bounded identical-context convergence:** Recommended conditional strategy. Each whole-pair attempt issues both lanes with `commitment: "finalized"`, `encoding: "base64"`, no `dataSlice`, and the exact canonical program ID. Accept only when both independently successful responses from that one attempt report the same safe-integer slot. If either lane fails or the slots differ, discard both responses; never retain one lane, re-query only one lane, or combine responses across attempts. Use at most 8 whole-pair attempts under one 30-second deadline; timeout or non-convergence is unresolved.
3. **Multi-context proof:** Reject for v1.3. Two different slots are not made safe merely by narrow elapsed time, wallet history, unchanged current values, or lack of wallet-signed transactions. Relevant account state can change without an analyzed-wallet signature, and standard RPC cannot reconstruct the earlier arbitrary slot. Slice 3B-2 will not infer “no relevant transition” between contexts.
4. **Fallback:** If identical finalized context plus provider completeness cannot be established, positive account-population authority remains unresolved.

### 1.2 Can one common finalized context be proven?

There is no identified standard atomic two-program method. A common context is defensible only at the admitted-provider trust boundary if current Solana server documentation/source confirms that `context.slot` is the exact bank used to evaluate the method and the selected provider contract preserves that behavior. Under that contract, equal finalized slot numbers, same network/genesis, same endpoint/provider profile, same wallet/mint scope, and same capture attempt establish one common frozen bank. Slot equality alone, without those provider semantics, is not self-proving.

### 1.3 Eager frozen capture, not later live recapture

The opening snapshot must be captured before trading, but 3B-1 is assembled after the episode. A later live RPC call cannot reconstruct the opening bank. Therefore the adapter must eagerly acquire and validate both lanes, freeze the validated pair inside an opaque registered enumeration port, and return that retained source capability. The opening and ending use separate retained ports. Later 3B-1 source recapture reads the frozen provider capture through the capability; it does not call current-state RPC again.

The smallest controlled protocol is one supervised process. If durable cross-process recovery of the opening capability is required, a separately admitted immutable snapshot store/signature contract is needed and is outside this slice. A process crash before final context assembly aborts the run.

---

## 2. Exact recommended RPC/provider contract

The production adapter contract should be versioned as `SOLANA_STANDARD_RPC_FINALIZED_OWNER_ENUMERATION_V1` and admit one explicitly approved endpoint/provider profile. It must not accept an arbitrary caller assertion that an endpoint is complete.

For each capture:

1. Verify mainnet identity using the existing network/genesis mechanism.
2. Obtain an opening freshness floor from `getSlot` at `finalized`, or use the ending floor derived from the finalized transaction interval.
3. Call standard JSON-RPC `getTokenAccountsByOwner` twice with exact params:
   - analyzed wallet public key;
   - `{ "programId": "Tokenkeg..." }` and `{ "programId": "TokenzQd..." }` separately;
   - `{ "commitment": "finalized", "encoding": "base64", "minContextSlot": floor }`;
   - no `jsonParsed`, `dataSlice`, pagination, limit, cursor, or provider-enhanced method.
4. Validate JSON-RPC version, exact request ID, absence of `error`, exact response/context/value shape, safe nonnegative context slot, context slot at or above the requested floor, and a full array result.
5. Apply the 8-attempt/30-second whole-pair convergence loop described above. No successful output exists until both responses from one indivisible attempt have equal slots.
6. Enforce configured maximum attempts, elapsed time, HTTP/body bytes, row count, and raw account bytes. Crossing a local safety limit is an explicit unresolved error, never a partial success.
7. Preserve the exact returned raw account bytes and authoritative outer account program. Reject `jsonParsed`, `base64+zstd`, data slices, malformed/noncanonical base64, unsafe numeric metadata, or unexpected fields under the admitted strict response profile.

Required provider-side contract before admission:

- the method returns the exhaustive matching owner/program population in one non-paginated array;
- any scan limit, response-size limit, disabled/excluded secondary-index condition, or resource limit returns an explicit JSON-RPC/HTTP error and never a successful partial array;
- Token-2022 has the same exhaustive behavior as classic Token;
- `finalized` and `minContextSlot` retain standard semantics;
- no hidden hosted-provider row cap, pagination, archive tier rule, cache truncation, or silent omission applies;
- load balancing does not alter network identity or context semantics.

A generic “standard RPC compatible” claim is insufficient. If a hosted provider cannot document these properties, use a pinned self-operated Agave RPC configuration whose source/config and all-or-error scan behavior can be reviewed, or STOP.

---

## 3. Raw decoding requirements

### 3.1 Classic SPL Token account decoder

Decode from retained bytes, not `jsonParsed`. Require outer account owner to equal canonical SPL Token, `executable === false`, and data length exactly 165 bytes. Decode and validate:

- mint: bytes 0..31;
- token authority/owner: bytes 32..63;
- raw amount: little-endian u64 at 64..71, serialized as canonical decimal string;
- delegate COption tag at 72..75 (only 0 or 1), delegate bytes at 76..107;
- account state at 108 (admit only initialized/frozen states required by v1.3; uninitialized/unknown fails);
- native COption and rent reserve at 109..120 (validate; target JUP must not be native-wrapped);
- delegated amount u64 at 121..128; reject contradiction such as absent delegate with nonzero delegated amount;
- close-authority COption at 129..132 and key at 133..164.

Validate outer pubkey uniqueness, analyzed token authority, target mint after local filtering, lane/program consistency, and raw/normalized reconciliation. All arithmetic remains BigInt/u64-to-decimal; no display-unit conversion.

### 3.2 Token-2022 base/TLV decoder

Decode the same 165-byte base state. For extended accounts, require the Token-2022 account-type byte to denote a token account and parse every TLV header/value with explicit bounds checks. Do not rely on permissive helper iteration as hostile-byte validation. Reject short headers, short values, duplicate extension IDs, account/mint extension-kind mismatch, illegal 355-byte multisig collision forms, uninitialized padding not explicitly admitted, unknown IDs, wrong fixed lengths, and trailing ambiguity.

For v1.3, classify the installed extension set as follows:

- **Must be recognized and decoded/classified rather than treated as unknown:** TransferFeeAmount; ConfidentialTransferAccount; ImmutableOwner; MemoTransfer; CpiGuard; NonTransferableAccount; TransferHookAccount; ConfidentialTransferFeeAmount; PausableAccount.
- **Must force unresolved under the narrow account-only carrier:** TransferFeeAmount and ConfidentialTransferFeeAmount (withheld quantity/withdrawal authority semantics); ConfidentialTransferAccount (confidential balances/authority); PausableAccount; any extension whose lifecycle/transfer restrictions cannot be represented without weakening the closed 3B-1 state contract; malformed, duplicate, uninitialized, or unknown extensions.
- **Narrow safe-ignore case:** MemoTransfer may be structurally decoded and ignored only for the claimed current owner, ordinary delegate, raw-u64 amount, base state, and close-authority fields; it must not be ignored if the profile later claims general transfer usability. ImmutableOwner, CpiGuard, NonTransferableAccount, and TransferHookAccount require explicit representation or unresolved treatment under the current closed carrier.
- **Mint-level blockers not observable from token-account bytes:** PermanentDelegate, confidential-transfer mint configuration, transfer-fee authority/configuration, transfer-hook configuration, pausable configuration, and other mint-wide authority/lifecycle features. In particular, a base-only Token-2022 account does not prove absence of a mint PermanentDelegate.

Therefore the narrow 3B-2 controlled path may issue positive authority for an **explicitly empty Token-2022 lane**, but it must treat any target-mint Token-2022 account as unresolved until a same-context raw mint-evidence profile and carrier fields for mint-wide authority are separately designed. Do not silently claim full Token-2022 non-empty authority in this slice.

### 3.3 Decimals and mint evidence

Decimals are not in token-account bytes and are unnecessary for exact raw-unit inventory or exact zero. Do not add a mint lookup merely to populate decimals, and do not import caller-supplied decimals as authority. Production decoded rows use `decimals: null`; snapshot `target_decimals` remains null for this profile.

Mint-account evidence would be required later for positive non-empty Token-2022 authority because mint extensions can add delegation/lifecycle semantics, not because raw-unit inventory needs decimals. That expansion is outside this narrow controlled JUP path.

### 3.4 Raw evidence metadata

The adapter must bind exact raw bytes and outer owner program. JSON numeric `rentEpoch` can exceed JavaScript safe-integer precision and is not needed for inventory authority. Add a production raw-evidence profile that permits non-authoritative `rent_epoch: null` rather than fabricating an exact decimal string from a rounded JSON number. Admit lamports only when received as a safe nonnegative integer; otherwise fail closed. Existing 3B-1 mocked profiles remain unchanged.

---

## 4. Completeness/truncation assumptions and Phase 0 tests

Before implementation, establish all of these for the selected provider/version/config:

1. No pagination/cursor/limit exists for this method and successful `value` means the complete population.
2. Owner-index use, index-disabled behavior, and excluded-key behavior are documented.
3. Full-scan limits and account-scan byte limits return explicit errors.
4. HTTP gateway/body limits and hosted response caps return explicit errors rather than well-formed shortened arrays.
5. Token-2022 owner enumeration has parity with classic Token.
6. A successful empty array is meaningful only under the same complete contract.
7. `context.slot` is the exact evaluated bank and finalized equal-slot responses are one common finalized state.
8. `minContextSlot` violations are explicit and never answered below the floor.
9. Provider caches/load balancers preserve network identity, request scope, and context semantics.
10. No undocumented account-index exclusions or silent omission are admitted.

A bounded compatibility suite can detect incompatibility but cannot prove absence of all silent omission by itself. Positive authority requires both reviewed documented/source behavior and probes. If either is missing, STOP.

---

## 5. Proposed new and changed files

### New production files

- `engine/src/wallet-acquisition/solana-token-account-decoder-v1.mjs`
  - strict classic and Token-2022 base/TLV byte validation;
  - canonical raw-u64 decoding;
  - extension classification and fail-closed errors;
  - no RPC or provider code.
- `engine/src/wallet-acquisition/solana-rpc-target-account-snapshot-adapter-v1.mjs`
  - strict JSON-RPC request/response validation;
  - finalized freshness floor and bounded identical-slot convergence;
  - full-row validation before target-mint filtering;
  - creation of an eager frozen 3B-1 enumeration capability;
  - no completeness input from caller.

### New focused tests

- `engine/src/wallet-acquisition/solana-token-account-decoder-v1.test.mjs`
- `engine/src/wallet-acquisition/solana-rpc-target-account-snapshot-adapter-v1.test.mjs`

Keep byte fixtures/builders inside the focused test modules unless fixture reuse demonstrably requires one additional file; avoid a fixture directory expansion by default.

### Necessary narrow 3B-1 compatibility changes

- `engine/src/wallet-acquisition/target-account-enumeration-port-v1.mjs`
- `engine/src/wallet-acquisition/target-account-enumeration-port-v1.test.mjs`
  - retain the committed mocked capability-attested profile;
  - add a distinct locally decoded Solana state profile;
  - permit `decimals: null` only for the new profile;
  - add a distinct raw Solana RPC evidence profile permitting non-authoritative `rent_epoch: null`;
  - do not loosen field/profile validation generally.
- `engine/src/verification-scope-v1-3/authoritative-evidence-context.mjs`
- `engine/src/verification-scope-v1-3/authoritative-evidence-context.test.mjs`
  - admit only the new exact production profiles in addition to existing committed profiles;
  - preserve null decimals and all source digests;
  - preserve identical-context and boundary-order requirements.

No package or lockfile changes are expected. Do not modify legacy v1.15 acquisition/result code, current ledger, candidate/receipt/package code, or JUP/RAY identity fixtures.

---

## 6. Deterministic offline fixtures and tests

### Decoder tests

Use literal retained base64 account bytes and literal JSON-RPC envelopes whose expected meanings were constructed independently of the decoder under test; do not generate the only positive fixtures through that decoder. Pin canonical raw-byte and projected-object digests so drift is visible. Cover:

- classic initialized account, zero and max u64 amount;
- frozen account;
- delegate absent/present and exact delegated quantity;
- close authority absent/present;
- wrong 165-byte length, invalid COption tags, invalid state, native contradiction;
- outer account owner/program mismatch;
- authority mismatch and mint mismatch;
- malformed/noncanonical base64;
- Token-2022 165-byte base account;
- account-type/TLV bounds, duplicate IDs, wrong lengths, unknown IDs, trailing bytes, mint-only extension in an account;
- each required authority/lifecycle extension classification;
- explicit unresolved result for every unsupported authority-affecting extension;
- permanent-delegate absence cannot be inferred from a base-only Token-2022 account.

### Adapter/RPC tests

Use an injected scripted transport; no socket/network access. Cover:

- exact method/params for both canonical programs;
- local filtering after validating the complete returned owner/program array;
- same-slot immediate success;
- whole-pair retry convergence after an unequal-context attempt, with both prior responses discarded;
- alternating/advancing slots exhausting the bounded attempt budget;
- context below floor, unsafe slot, wrong commitment profile, wrong request ID;
- explicit empty for both lanes produces authoritative empty target population;
- one missing/error lane never produces completeness;
- HTTP/JSON-RPC error, timeout, malformed JSON, malformed schema;
- local body/row/raw-byte safety cap produces unresolved, never partial success;
- duplicate exact rows and contradictory duplicate rows;
- cross-lane duplicate pubkey;
- account outer owner mismatch, decoded owner/mint/program mismatch;
- unknown Token-2022 extension and non-empty Token-2022 target coverage STOP;
- eager opening port replays the frozen pair and never performs a later current-state recapture;
- caller cannot set completeness, common context, decoded state, or raw-evidence profiles.

### Existing regression gates

From repository root, run focused deterministic tests directly:

```bash
node --test \
  engine/src/wallet-acquisition/solana-token-account-decoder-v1.test.mjs \
  engine/src/wallet-acquisition/solana-rpc-target-account-snapshot-adapter-v1.test.mjs \
  engine/src/wallet-acquisition/target-account-enumeration-port-v1.test.mjs \
  engine/src/verification-scope-v1-3/authoritative-evidence-context.test.mjs
```

Then run maintained deterministic v1.3/wallet-acquisition tests and identity locks from the repository root. Do not use `engine/package.json`'s placeholder `npm test`; do not run the root devnet mint suite unless separately authorized. Finish with `node --check` on changed modules, `git diff --check`, and a review proving no legacy acquisition-result or JUP/RAY golden bytes changed.

---

## 7. Prospective controlled-wallet protocol

1. **Create and lock the fresh wallet.** A supervisor owns an exclusive signing gate. The trading agent has no signer/submission capability yet; no background bot may use the wallet.
2. **Capture opening freshness floor.** Verify network/genesis and observe a finalized slot.
3. **Capture opening snapshot.** Eagerly enumerate classic Token and Token-2022, converge on identical finalized slot `S_open`, validate completeness/raw bytes/decoding, construct the frozen opening enumeration port, and immediately validate the resulting 3B-1 enumeration. Abort if any authority is unresolved.
4. **Freeze/record before release.** Retain the immutable opening capability and its context/digest before making the signer available. In the narrow one-process protocol, any process loss aborts the episode.
5. **Release bounded trading capability.** Only after step 4, grant the agent a scoped signer/submission lease. A transaction signed after finalized `S_open` cannot be part of frozen bank `S_open`, so admitted episode transactions must have slots strictly greater than `S_open`.
6. **Close the trade gate.** After the final intended submission, revoke the agent's signer/submission lease before ending acquisition. Record submitted signatures operationally, but do not use that log as population authority.
7. **Finalize and acquire transaction population.** Wait for submitted transactions to reach finality and run the committed bounded acquisition/reconstruction path. Require the authoritative oldest admitted transaction slot to be greater than `S_open`.
8. **Capture ending snapshot.** Set the ending minimum context floor to at least `newest_admitted_transaction_slot + 1`; eagerly converge both program lanes at one finalized `S_end`; require `S_end` greater than the newest transaction slot.
9. **Bind 3B-1 evidence.** Build the source-bound evidence context using the frozen opening port, authoritative transaction population/transcript port, and frozen ending port.
10. **Do not overclaim.** The signer gate prevents agent trading from racing the opening/ending captures. It does not prove absence of unsolicited third-party transfers or other non-interference. Position Episode accounting, WAC, continuity/non-interference, outcomes, candidates, and receipts remain unresolved/out of scope.

---

## 8. Live compatibility work requiring separate authorization

No probe below is authorized by this plan.

### Documentation/source refresh

- Fetch current official Solana RPC docs for `getTokenAccountsByOwner`, commitment configuration, response context, and `minContextSlot`.
- Inspect the exact current Agave RPC implementation/version used by the selected provider for bank selection, token-owner indexing, scan limits, exclusions, and all-or-error behavior.
- Inspect the selected hosted provider's current caps, pagination, cache, Token-2022 parity, and error documentation.

### Bounded no-signing provider probes

Against a specifically approved endpoint and public/controlled addresses:

- verify network/genesis and finalized-slot behavior;
- issue both exact raw owner/program requests and test identical-slot convergence under a fixed attempt/deadline budget;
- compare explicit empty and non-empty classic/Token-2022 populations with an independent reviewed method/node;
- exercise known multi-account wallets, non-ATA token accounts, zero-balance accounts, frozen/delegated/close-authority accounts, and supported Token-2022 layouts;
- test future `minContextSlot` and provider resource-limit behavior for explicit errors;
- test a population large enough to cross documented thresholds and prove error rather than successful partial output;
- repeat across provider load-balanced requests to verify stable identity/context semantics.

Any account creation, signing, minting, funding, or trading needed to construct compatibility populations requires an additional explicit authorization beyond read-only provider probes.

---

## 9. STOP conditions

Slice 3B-2 must not issue positive `COMPLETE`, positive empty/zero, or source-bound snapshot authority when any of the following holds:

- no reviewed exact provider/version/config contract for exhaustive all-or-error owner enumeration;
- pagination, caps, index exclusions, scan limits, Token-2022 disparity, or silent omission remain undocumented or ambiguous;
- the two lanes do not converge to the exact same finalized context within the fixed budget;
- the provider cannot establish exact evaluated-bank semantics for `context.slot`;
- response context is below the required floor, wrong/stale, unsafe, or uncertain;
- network/genesis/provider identity is wrong or changes;
- any HTTP/JSON-RPC/provider error, timeout, malformed body, partial body, or local safety limit occurs;
- any returned row is malformed, duplicated, contradictory, wrong-program-owned, executable, data-sliced, non-base64, or fails strict raw decoding;
- local filtering, outer owner, decoded mint, decoded token authority, requested wallet, or requested program disagree;
- unknown/unsupported Token-2022 extensions affect required quantity, authority, closure, or lifecycle;
- any non-empty target-mint Token-2022 population appears before same-context mint-wide authority evidence is designed;
- decimals or completeness are supplied as caller authority;
- the opening frozen capability is lost, mutated, or recaptured only after trading;
- the signing gate was available before opening freeze or remained available during ending capture;
- opening slot is not strictly before the oldest admitted transaction, or ending slot is not strictly after the newest;
- the requested operational guarantee requires proving non-interference or third-party-transfer absence, which this slice deliberately does not establish.

---

## 10. Implementation order after approval and Phase 0 closure

1. Complete the separately authorized documentation/source/provider compatibility review; record the exact admitted contract. STOP if it fails.
2. Add failing classic decoder tests; run to confirm RED.
3. Implement the minimal strict classic decoder; run to GREEN.
4. Add failing Token-2022 base/TLV and extension-classification tests; run RED.
5. Implement strict Token-2022 parsing and conservative unresolved policy; run GREEN.
6. Add failing adapter request/response and explicit-empty tests; run RED.
7. Implement strict RPC envelope/row validation and local filtering; run GREEN.
8. Add failing identical-slot convergence, bounded non-convergence, stale context, and cap/error tests; run RED.
9. Implement eager paired capture and frozen replay capability; run GREEN.
10. Add failing 3B-1 production-profile/null-decimals/raw-metadata tests; run RED.
11. Make only the narrow profile-gated 3B-1 compatibility changes listed above; preserve old profiles and run GREEN.
12. Add source-bound opening/ending integration tests and race-gate protocol fixtures; run GREEN.
13. Run focused regressions, maintained deterministic suites, syntax checks, identity locks, `git diff --check`, and strict scope review.
14. Leave every implementation change uncommitted and unpushed for user review.
