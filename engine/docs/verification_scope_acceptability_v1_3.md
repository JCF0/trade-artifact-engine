# Artifact Verification Scope / Acceptability v1.3

**Status:** Normative freeze candidate
**Document version:** Verification Scope specification v1.3; not an Artifact software release number
**Scope:** Product and engineering verification contract
**Applies to:** Current Solana spot architecture downstream of Artifact v1.15 acquisition
**Objective:** Define deterministically which transaction, position, and wallet-window claims Artifact may verify, limit, refuse, and turn into receipts.

**Canonical correction note:** The prior canonical SHA-256 was `6124f24f429bc6f90dd4dfd373f3b6f0e24935f2ac7142079a04b4ce68f603cf`. The only normative correction recorded by this note adds `TRANSFER_IN_BASIS_UNRESOLVED` as claim-impact reason code 23 with the fixed final ordinal and the semantics in §27.1. No other v1.3 semantics are changed.

---

## 1. Purpose

Artifact acquires a bounded finalized wallet history and completely accounts for the authoritative transaction population before deriving position candidates.

Real-wallet testing demonstrated that:

* a particular transaction may be reconstructable;
* a complete target position may be reconstructable;
* the whole wallet window may still contain unresolved effects.

These are different propositions.

Artifact MUST therefore evaluate explicit claim scopes rather than requiring every narrower claim to inherit whole-wallet economic authority.

The central rule is:

> **An unresolved evidence item MUST affect every requested claim field it could materially alter. It MUST be excluded from a claim only when the canonical non-interference rules deterministically prove that it cannot alter any field required by that claim.**

Artifact does not become more permissive under this specification.

It becomes more precise.

---

# 2. Inherited invariants

Verification Scope v1.3 MUST preserve the existing Artifact trust boundaries.

In particular:

* finalized wallet signature history remains the bounded acquisition completeness authority;
* every authoritative in-window transaction remains disposition-accounted;
* missing, unsupported, ambiguous, contradictory, or unresolved evidence is never interpreted as zero;
* provider-attested evidence remains distinct from trustless completeness;
* Artifact MUST NOT fabricate cost basis or PnL for unobserved inventory;
* wallet ownership, trader identity, agent identity, authorization, and decision authorship remain separate claims;
* existing frozen historical JUP/RAY receipt and package identities remain unchanged unless a separately approved versioned proof-format migration occurs.

Verification Scope v1.3 operates downstream of these guarantees.

---

# 3. Authoritative establishment standard

Where this specification says that an effect, quantity, boundary component, state, or economic value is:

```text
established
independently established
completely established
authoritatively established
```

it means:

> **The value is derivable solely from authoritative evidence admitted under the bound `ARTIFACT_EFFECT_MODEL_V1_15` and the immutable acquisition/evidence context bound to the claim, using the canonical profiles named by this specification.**

It MUST NOT depend on:

* auxiliary provider lookups not bound to the claim;
* heuristics;
* UI interpretation;
* free-form provider labels;
* market-price assumptions;
* unbound pre-window reconstruction;
* implementation discretion.

This definition applies throughout v1.3.

---

# 4. Canonical profile set

Verification Scope v1.3 supports only canonical versioned profiles.

A caller MUST NOT request an arbitrary field subset and obtain a canonical verification label.

A different proposition requires a separately versioned claim profile defining its complete dependency closure and label semantics.

## 4.1 Canonical claim profiles

```text
TRANSACTION_EFFECT_V1
POSITION_ECONOMICS_V1
WALLET_EFFECT_COVERAGE_V1
```

## 4.2 Canonical limited-result profiles

```text
TRANSACTION_EFFECT_V1_LIMITED
POSITION_ECONOMICS_V1_LIMITED
WALLET_EFFECT_COVERAGE_V1_LIMITED
```

These are **result-shape profiles**, not values of `claim_profile`.

The requested `claim_profile` remains one of the three canonical claim profiles in §4.1.

## 4.3 Canonical supporting policy profiles

Every claim MUST bind:

```text
effect_model_profile
  = ARTIFACT_EFFECT_MODEL_V1_15

boundary_authority_profile
  = ARTIFACT_POSITION_BOUNDARY_V1

canonical_ordering_profile
  = ARTIFACT_CANONICAL_ORDER_V1

intra_tx_effect_order_profile
  = ARTIFACT_INTRA_TX_EFFECT_ORDER_V1

accounting_profile
  = ARTIFACT_WAC_ACCOUNTING_V1

quote_profile
  = ARTIFACT_RAW_QUOTE_V1

non_interference_profile
  = ARTIFACT_NON_INTERFERENCE_V1

episode_enumeration_profile
  = ARTIFACT_EPISODE_ENUMERATION_V1

candidate_population_profile
  = ARTIFACT_CANDIDATE_POPULATION_V1

candidate_selection_policy
  = ARTIFACT_EXPLICIT_DIGEST_SELECTION_V1
```

The same authoritative evidence plus the same bound profiles MUST produce the same:

* evidence admission;
* localization;
* position boundaries;
* claim outcome;
* position state;
* candidate population;
* selection result;
* economics.

Optional runtime interpretation is not permitted.

---

# 5. Canonical claim result

Every requested claim MUST produce exactly one result.

## 5.1 Claim type

```text
claim_type =
  TRANSACTION_EFFECT
  POSITION_EPISODE
  WALLET_WINDOW
```

## 5.2 Claim profile

```text
claim_profile =
  TRANSACTION_EFFECT_V1
  POSITION_ECONOMICS_V1
  WALLET_EFFECT_COVERAGE_V1
```

## 5.3 Claim outcome

```text
claim_outcome =
  VERIFIED
  LIMITED
  BLOCKED
  NOT_EVALUATED
```

A requested claim MUST produce exactly one of:

```text
VERIFIED
LIMITED
BLOCKED
```

`NOT_EVALUATED` is permitted only for an **unrequested companion claim** represented for result-shape completeness.

Failure or refusal to evaluate a requested claim MUST NOT be represented as `NOT_EVALUATED`.

## 5.4 Position state

For `POSITION_EPISODE`:

```text
position_state =
  CLOSED
  OPEN_REALIZED_PARTIAL
  OPEN
  null
```

For all other claim types:

```text
position_state = null
```

---

# 6. Derived verification labels

Canonical labels depend on both profile and outcome.

```text
TRANSACTION_VERIFIED
iff
claim_type = TRANSACTION_EFFECT
claim_profile = TRANSACTION_EFFECT_V1
claim_outcome = VERIFIED
```

```text
POSITION_VERIFIED
iff
claim_type = POSITION_EPISODE
claim_profile = POSITION_ECONOMICS_V1
claim_outcome = VERIFIED
```

```text
WALLET_WINDOW_VERIFIED
iff
claim_type = WALLET_WINDOW
claim_profile = WALLET_EFFECT_COVERAGE_V1
claim_outcome = VERIFIED
```

No custom or future profile inherits these labels automatically.

`LIMITED` MUST NOT be presented as lower-confidence verification.

---

# 7. Acquisition scope and claim scope

## 7.1 Acquisition scope

Acquisition scope identifies the authoritative bounded wallet history Artifact examined.

It includes:

* analyzed wallet;
* network;
* bounded request;
* finalized anchor;
* canonical transaction population;
* complete transaction dispositions.

It answers:

> Which wallet history was examined?

## 7.2 Claim scope

Claim scope identifies the proposition Artifact is attempting to prove.

It answers:

> What exactly is being verified?

A verified Position Episode MUST NOT imply that the Wallet Window is verified.

A Wallet Window claim MUST be separately requested and evaluated.

---

# 8. Canonical verification objects

## 8.1 Transaction Effect

A Transaction Effect represents committed analyzed-wallet effects of one finalized transaction.

It does not establish complete position PnL by itself.

## 8.2 Position Episode

A Position Episode is the canonical object for position economics.

It includes every evidence item capable of changing any required `POSITION_ECONOMICS_V1` field, including:

* target inventory;
* opening basis;
* acquisition basis;
* disposal proceeds;
* target transfers;
* fee treatment;
* ending/as-of state;
* boundary validity.

A Position Episode may contain multiple buys, sells, accounts, venues, and programs.

## 8.3 Wallet Window

A Wallet Window claim asserts:

> Every authoritative analyzed-wallet effect in the declared acquisition window is completely classified and reconciled under `ARTIFACT_EFFECT_MODEL_V1_15`.

It does not assert portfolio return or total investment performance.

---

# 9. Canonical ordering

## 9.1 Transaction ordering

`ARTIFACT_CANONICAL_ORDER_V1` uses the authoritative finalized transaction ordering already established by acquisition.

Provider timestamps or display order MUST NOT independently define chronology.

If chronology-sensitive accounting depends on transactions whose canonical order cannot be established:

```text
INTRA_OR_INTER_TX_ORDER_UNRESOLVED
```

MUST affect the claim.

## 9.2 Intra-transaction ordering

A finalized transaction remains one reconciliation unit for Position Episode boundary purposes.

A temporary internal inventory zero MUST NOT split one transaction into multiple Position Episodes.

Within a transaction, economic effects used by position accounting MUST follow `ARTIFACT_INTRA_TX_EFFECT_ORDER_V1`.

That profile requires:

1. authoritative economic-leg ordering derived from admitted normalized transaction evidence;
2. deterministic ordering of every acquisition/disposal whose sequence changes cost-basis consumption;
3. no provider-presentation-order fallback.

If economically relevant intra-transaction ordering cannot be established and the ambiguity changes a required position field:

```text
INTRA_TX_EFFECT_ORDER_UNRESOLVED
```

MUST prevent `VERIFIED`.

---

# 10. Target inventory and boundaries

## 10.1 Aggregate inventory

Target inventory is aggregated across every wallet-owned target account admitted by the analyzed-wallet authority model.

Zero in one ATA or venue account is insufficient.

## 10.2 Exact zero

Unless a future version explicitly defines a dust rule:

```text
zero = exact raw integer zero
```

A boundary MUST NOT be inferred from:

* rounded display values;
* dust thresholds;
* no discovered ATA;
* a missing provider row;
* only one of multiple target accounts.

## 10.3 Custody versus economic inventory

Artifact MUST distinguish:

```text
in_wallet_target_custody
```

from:

```text
complete_position_attributable_economic_inventory
```

A transfer-out may reduce wallet custody to zero while economic continuation remains unresolved.

Therefore:

> **Transfer-out-to-zero MUST NOT by itself establish a closed position or sever a Position Episode.**

## 10.4 Opening boundary

A verified `POSITION_ECONOMICS_V1` claim requires an opening state with:

* exact target inventory; and
* complete attributable opening basis.

The strongest opening state is:

```text
economic target inventory = 0
opening basis = 0
```

A non-zero opening state MUST be admitted when its quantity and attributable basis are authoritatively established under §3.

For v1.3, non-zero opening quantity and basis MUST come from evidence already contained in, or authoritatively referenced by, the immutable acquisition/evidence context bound to the claim.

Artifact MUST NOT establish opening basis through an unbound pre-window lookup.

Therefore, an unknown pre-window inventory basis remains unresolved unless the bound evidence context itself carries authoritative basis evidence admitted by the canonical profiles.

## 10.5 Ending boundary

A position-state determination uses complete position-attributable economic target inventory at the canonical ending/as-of boundary.

A later transaction cannot change an already valid historical pre/post state.

It may provide contradictory authoritative evidence proving that the earlier alleged state was never valid.

---

# 11. Position state is independent of claim outcome

Position state describes the economic state.

Claim outcome describes evidence completeness.

They MUST NOT be conflated.

## 11.1 `CLOSED`

```text
position_state = CLOSED
```

iff complete position-attributable target economic inventory is exactly zero at a valid canonical boundary.

`CLOSED` does not itself establish:

* opening basis;
* realized PnL;
* realized return;
* `VERIFIED`.

Example:

```text
unknown opening basis
→ supported full economic disposal
→ exact economic inventory = 0
```

may produce:

```text
claim_outcome = LIMITED
position_state = CLOSED
```

## 11.2 `OPEN_REALIZED_PARTIAL`

Applies iff:

* ending complete position-attributable economic inventory is positive; and
* at least one supported economic disposal of positive target quantity occurred.

Basis availability does not determine the state.

Transfers out are not economic disposals.

## 11.3 `OPEN`

Applies iff:

* ending complete position-attributable economic inventory is positive; and
* no supported economic disposal of positive target quantity occurred.

## 11.4 `null`

Position state MUST be `null` when complete position-attributable economic inventory state cannot itself be established.

This includes a partial or full target transfer-out whose external continuation is unresolved.

A positive residual in-wallet custody does not by itself establish the complete economic inventory state after such a transfer.

---

# 12. Allowed outcome/state combinations

| Claim outcome   |  `CLOSED` | `OPEN_REALIZED_PARTIAL` |    `OPEN` |    `null` |
| --------------- | --------: | ----------------------: | --------: | --------: |
| `VERIFIED`      |   Allowed |                 Allowed |   Allowed | Forbidden |
| `LIMITED`       |   Allowed |                 Allowed |   Allowed |   Allowed |
| `BLOCKED`       | Forbidden |               Forbidden | Forbidden |  Required |
| `NOT_EVALUATED` | Forbidden |               Forbidden | Forbidden |  Required |

For non-position claims, state is always `null`.

A known position state is not sufficient by itself for `LIMITED`; the applicable limited-result profile MUST also be complete.

---

# 13. Verified `POSITION_ECONOMICS_V1` field matrix

Every authoritative **VERIFIED** Position Episode MUST contain every `REQUIRED` field for its state.

`LIMITED` result shapes are governed by §14.2.

A public UI MAY display fewer fields, but display omission does not change the proved proposition.

| Field                                   | `CLOSED`               | `OPEN_REALIZED_PARTIAL` | `OPEN`                 |
| --------------------------------------- | ---------------------- | ----------------------- | ---------------------- |
| Wallet / network / acquisition identity | REQUIRED               | REQUIRED                | REQUIRED               |
| Target mint                             | REQUIRED               | REQUIRED                | REQUIRED               |
| Exact quote mint                        | REQUIRED               | REQUIRED                | REQUIRED               |
| Episode identity                        | REQUIRED               | REQUIRED                | REQUIRED               |
| Opening boundary                        | REQUIRED               | REQUIRED                | REQUIRED               |
| Ending/as-of boundary                   | REQUIRED               | REQUIRED                | REQUIRED               |
| Opening target inventory                | REQUIRED               | REQUIRED                | REQUIRED               |
| Opening attributable basis              | REQUIRED               | REQUIRED                | REQUIRED               |
| Complete acquisition-event set          | REQUIRED               | REQUIRED                | REQUIRED               |
| Complete disposal-event set             | REQUIRED               | REQUIRED                | REQUIRED               |
| Complete target-transfer set            | REQUIRED               | REQUIRED                | REQUIRED               |
| Aggregate acquisition basis             | REQUIRED               | REQUIRED                | REQUIRED               |
| Fee treatment/disclosure                | REQUIRED               | REQUIRED                | REQUIRED               |
| Disposal proceeds                       | REQUIRED               | REQUIRED                | NOT_APPLICABLE         |
| Realized basis consumed                 | REQUIRED               | REQUIRED                | NOT_APPLICABLE         |
| Realized PnL                            | REQUIRED               | REQUIRED                | NOT_APPLICABLE         |
| Realized return                         | REQUIRED               | REQUIRED                | NOT_APPLICABLE         |
| Ending target inventory                 | exact zero             | positive                | positive               |
| Remaining attributable basis            | exact zero             | REQUIRED                | REQUIRED               |
| Position state                          | `CLOSED`               | `OPEN_REALIZED_PARTIAL` | `OPEN`                 |
| Exclusion references                    | REQUIRED, may be empty | REQUIRED, may be empty  | REQUIRED, may be empty |
| Unresolved claim-affecting findings     | MUST be empty          | MUST be empty           | MUST be empty          |
| Unrealized mark/PnL                     | FORBIDDEN              | FORBIDDEN               | FORBIDDEN              |
| Portfolio return                        | FORBIDDEN              | FORBIDDEN               | FORBIDDEN              |

`realized_return` is governed by `ARTIFACT_WAC_ACCOUNTING_V1`.

---

# 14. Canonical limited-result profiles

`LIMITED` is objective.

## 14.1 `TRANSACTION_EFFECT_V1_LIMITED`

Required:

* authoritative transaction identity;
* finalized execution status;
* every effect authoritatively established under §3;
* exhaustive residual unresolved-effect references;
* exact available/unavailable field map relative to `TRANSACTION_EFFECT_V1`;
* normalized reason-code set.

If those requirements cannot be established:

```text
claim_outcome = BLOCKED
```

## 14.2 `POSITION_ECONOMICS_V1_LIMITED`

Required:

* analyzed wallet/network;
* authoritative acquisition/evidence identity;
* target mint;
* exact declared quote mint;
* deterministic Position Episode identity;
* canonical observed episode span;
* every target effect and quantity authoritatively established under §3;
* exhaustive verified subordinate-effect references;
* exact available/unavailable field map relative to the state-conditioned `POSITION_ECONOMICS_V1` matrix;
* exhaustive unresolved-finding references;
* normalized reason-code set;
* position state if authoritatively established, otherwise `null`.

If this complete limited-result profile exists:

```text
claim_outcome = LIMITED
```

Otherwise:

```text
claim_outcome = BLOCKED
position_state = null
```

## 14.3 `WALLET_EFFECT_COVERAGE_V1_LIMITED`

Required:

* authoritative acquisition/window identity;
* finalized anchor;
* complete authoritative transaction population;
* exhaustive per-transaction dispositions;
* exhaustive unresolved-effect references;
* normalized reason-code set.

Therefore:

```text
VERIFIED =
authoritative window
+ exhaustive dispositions
+ every authoritative wallet effect reconciled
```

```text
LIMITED =
authoritative window
+ exhaustive dispositions
+ at least one wallet effect remains unresolved
```

```text
BLOCKED =
window authority or exhaustive disposition accounting
cannot itself be established
```

---

# 15. Canonical raw-quote rule

`ARTIFACT_RAW_QUOTE_V1` permits one exact quote mint per Position Episode.

No implicit equivalence exists in v1.3.

Artifact MUST NOT combine:

```text
USDC + USDT
SOL + WSOL
or any other distinct mint pair
```

using:

* assumed peg equivalence;
* current market price;
* historical oracle conversion;
* display-time conversion.

If a required position economic effect cannot be expressed in the exact declared quote mint:

```text
MIXED_QUOTE_UNSUPPORTED
```

MUST affect the claim.

---

# 16. `ARTIFACT_WAC_ACCOUNTING_V1`

The canonical Position Episode accounting profile is weighted-average cost basis in canonical economic-event order.

## 16.1 Arithmetic authority

Authoritative accounting MUST use:

* exact raw token units for quantities;
* exact raw quote units for direct quote amounts;
* exact rational arithmetic for weighted-average basis divisions.

Binary floating-point approximation MUST NOT determine authoritative economics.

## 16.2 Acquisition recurrence

```text
inventory_after =
  inventory_before
  + acquired_quantity
```

```text
basis_after =
  basis_before
  + attributable_acquisition_basis
```

## 16.3 Disposal recurrence

Immediately before each supported economic disposal:

```text
average_basis_per_unit =
  basis_before
  /
  inventory_before
```

```text
basis_consumed =
  disposed_quantity
  × average_basis_per_unit
```

```text
inventory_after =
  inventory_before
  - disposed_quantity
```

```text
basis_after =
  basis_before
  - basis_consumed
```

A later acquisition MUST NOT alter basis already consumed by an earlier disposal.

A disposal exceeding established economic inventory MUST fail closed with:

```text
OVERSOLD_ESTABLISHED_INVENTORY
```

## 16.4 Remainders

Core accounting uses exact rationals.

A partial disposal leaves the exact rational remainder.

When a valid final economic disposal takes exact inventory to zero:

```text
remaining_inventory = 0
remaining_basis = 0
```

No implementation-selected dust remainder may survive.

## 16.5 Quote-denominated fees

An explicit fee denominated in the exact position quote mint is:

* added to acquisition basis when uniquely attributable to acquisition;
* deducted from recognized disposal proceeds when uniquely attributable to disposal.

## 16.6 Non-quote fees

Fees denominated outside the exact position quote mint:

* MUST be disclosed;
* MUST NOT be converted into quote PnL under v1.3.

## 16.7 Shared fees

A fee MUST NOT be charged twice.

If deterministic unique allocation cannot be established:

```text
SHARED_EFFECT_ALLOCATION_UNRESOLVED
```

MUST affect each dependent claim.

## 16.8 Realized economics

```text
realized_pnl =
  recognized_disposal_proceeds
  - realized_basis_consumed
```

```text
realized_return =
  realized_pnl
  /
  realized_basis_consumed
```

If:

```text
realized_basis_consumed = 0
```

the required realized-return field MUST encode:

```text
UNDEFINED_ZERO_BASIS
```

`UNDEFINED_ZERO_BASIS` is an authoritative required-field sentinel.

It **satisfies the realized-return field requirement** and does not by itself prevent `VERIFIED` when every other required field is complete.

It MUST NOT be interpreted as:

* zero return;
* infinite return;
* missing evidence.

---

# 17. Funding and trade consideration

External quote funding and target trade consideration are distinct effects.

If both occur in one transaction, Artifact MUST independently establish:

* funding amount;
* actual trade consideration.

Failure to establish that separation MUST emit:

```text
TRANSACTION_EFFECT_UNRESOLVED
```

and, when the ambiguity prevents exact quote economics:

```text
QUOTE_CONTEXT_UNRESOLVED
```

Both applicable reasons MUST be retained.

A deposit is not acquisition cost.

A withdrawal is not disposal proceeds.

---

# 18. Target transfers

## 18.1 Known-basis transfer in

When transferred quantity and attributable basis are authoritatively established under §3, the transfer MUST participate in the position ledger.

## 18.2 Unknown-basis transfer in

Unknown-basis incoming inventory contaminates subsequent weighted-average basis while commingled.

A later supported disposal may establish:

```text
position_state = CLOSED
```

while economics remain:

```text
claim_outcome = LIMITED
```

A later new episode may begin from the resulting valid economic-zero boundary.

## 18.3 Transfer out

A target transfer-out:

* is not a disposal;
* creates no sale proceeds;
* creates no realized PnL or loss.

Where external continuation is unresolved:

* it does not close the Position Episode;
* it does not sever economic continuity;
* `position_state` MUST be `null`.

This remains true whether the transfer drains all wallet custody or only part of it.

If `POSITION_ECONOMICS_V1_LIMITED` is complete:

```text
claim_outcome = LIMITED
```

Otherwise:

```text
claim_outcome = BLOCKED
```

## 18.4 Transfer-out followed by return

A later return of previously transferred target inventory introduces two simultaneous v1.3 issues when continuity remains unresolved:

1. external economic continuity remains unresolved; and
2. the returning inventory is treated as unknown-basis incoming inventory unless its attributable basis is independently established under §3.

Both applicable reason classes MUST remain visible.

The return MUST NOT silently repair the earlier position.

---

# 19. Failed finalized transactions

A failed finalized Solana transaction MUST NOT create committed:

* target acquisitions;
* target disposals;
* target transfers;
* target inventory changes.

Authoritatively committed fees and wallet-native effects remain part of reconciliation.

Missing committed fee/native evidence remains unresolved, never zero.

---

# 20. Claim-scoped projections

A Position Episode MUST consume a fully verified transaction effect when one exists.

It may also consume a claim-scoped projection from a transaction whose complete transaction claim is not verified, but only through `ARTIFACT_NON_INTERFERENCE_V1`.

When an applicable non-interference rule is satisfied, its required projection/localization result MUST be applied.

An implementation MUST NOT decline an applicable rule because of presentation preference or discretionary conservatism.

A claim-scoped projection MUST NOT cause the complete source transaction to become TRANSACTION_VERIFIED.

Every projection MUST bind:

* source transaction;
* included effects;
* residual effects;
* affected assets;
* affected economic dimensions;
* applied non-interference rule;
* authoritative evidence references.

---

# 21. Canonical non-interference profile

`ARTIFACT_NON_INTERFERENCE_V1` evaluates rules in the exact order below.

The **first fully satisfied rule** supplies the authoritative exclusion basis.

Both the NI rule order and the exclusion-code ordinal order are **identity-relevant**.

Changing their order requires a new profile version.

## NI-01 — After valid closed boundary

Requires the finding's canonical transaction coordinate to be strictly after a valid closed episode boundary.

```text
EXCLUDED_AFTER_CLOSED_BOUNDARY
```

## NI-02 — Before independently valid zero opening boundary

Requires the finding to be strictly before a later independently valid economic-zero opening boundary.

```text
EXCLUDED_BEFORE_ZERO_OPEN_BOUNDARY
```

## NI-03 — Asset and economic dimensions provably disjoint

NI-03 proof MUST be derived **solely** from authoritative evidence already admitted under:

```text
ARTIFACT_EFFECT_MODEL_V1_15
```

and bound to the immutable claim evidence context.

NI-03 MUST NOT use:

* auxiliary lookups;
* heuristic inference;
* external labels;
* market assumptions;
* unbound provider data;
* implementation judgement.

The admitted evidence must deterministically establish that the finding cannot alter:

* target quantity;
* target-account ownership/authority;
* delegation;
* target-account closure;
* quote consideration;
* required native/fee treatment;
* external inventory continuity;
* opening/ending boundary validity.

If every predicate is established:

```text
EXCLUDED_ASSET_AND_DIMENSION_DISJOINT
```

Otherwise NI-03 does not apply.

## NI-04 — Failed transaction with no committed target effect

Requires:

* authoritative failed status;
* committed fee/native effects reconciled;
* no committed target effect.

```text
EXCLUDED_FAILED_TX_NO_COMMITTED_TARGET_EFFECT
```

## NI-05 — Known external quote funding only

Requires funding to be independently separated from trade consideration.

```text
EXCLUDED_QUOTE_FUNDING_ONLY
```

## NI-06 — Known quote withdrawal only

Requires withdrawal to be independently separated from disposal proceeds.

```text
EXCLUDED_QUOTE_WITHDRAWAL_ONLY
```

No other exclusion basis exists in v1.3.

`unknown_token_scope` cannot be asset-localized.

---

# 22. Position Episode enumeration

`ARTIFACT_EPISODE_ENUMERATION_V1` MUST deterministically enumerate Position Episodes from the canonical target-inventory/effect ledger.

A continuous economic position MUST NOT be split for attractiveness.

Separate episodes require a valid economic boundary.

The same evidence and profile set MUST enumerate the same episode population.

---

# 23. Candidate population completeness

Every deterministically enumerated Position Episode MUST receive exactly one population disposition:

```text
VERIFIED
LIMITED
BLOCKED
PROFILE_EXCLUDED
```

Therefore:

```text
source_episode_count
=
verified_count
+ limited_count
+ blocked_count
+ profile_excluded_count
```

Missing, duplicate, silently filtered, or extra dispositions invalidate candidate-population authority.

---

# 24. Candidate selection

v1.3 adopts:

```text
ARTIFACT_EXPLICIT_DIGEST_SELECTION_V1
```

Selection is by authoritative candidate/episode identity from the exhaustive population.

Selection MUST NOT depend on:

* PnL;
* return;
* profitability;
* visual attractiveness.

If an explicitly selected episode evaluates to `LIMITED` or `BLOCKED`, Artifact MUST return that result.

It MUST NOT silently fall back to another passing episode.

---

# 25. Acceptability and receipt eligibility

| Claim/result                            | Diagnostic/coverage artifact |               Verified economics display | Selectable position candidate |    Economic receipt |
| --------------------------------------- | ---------------------------: | ---------------------------------------: | ----------------------------: | ------------------: |
| `POSITION_ECONOMICS_V1 / VERIFIED`      |                          Yes |                                      Yes |                           Yes |                 Yes |
| `POSITION_ECONOMICS_V1 / LIMITED`       |                          Yes | Established fields only, visibly limited |                            No |                  No |
| `POSITION_ECONOMICS_V1 / BLOCKED`       |                 Reasons only |                                       No |                            No |                  No |
| `POSITION_ECONOMICS_V1 / NOT_EVALUATED` |                  Status only |                                       No |                            No |                  No |
| `TRANSACTION_EFFECT_V1 / VERIFIED`      |                          Yes |                 Transaction effects only |                            No | No position receipt |
| `WALLET_EFFECT_COVERAGE_V1 / VERIFIED`  |                          Yes |            No position economics implied |                            No | No position receipt |

Only:

```text
POSITION_EPISODE
+ POSITION_ECONOMICS_V1
+ VERIFIED
```

is eligible to become a verified economic position receipt.

---

# 26. Wallet-window claim

`WALLET_EFFECT_COVERAGE_V1` evaluates the whole acquisition window.

Asset or temporal localization may allow a narrower Position Episode to verify.

It does not make the Wallet Window verified.

Examples:

```text
position claim:
  VERIFIED / CLOSED

wallet-window claim:
  LIMITED
```

or:

```text
position claim:
  VERIFIED / CLOSED

wallet-window claim:
  NOT_EVALUATED
```

when the wallet-window claim was unrequested.

---

# 27. Closed authoritative reason vocabulary

Every non-success claim and every exclusion MUST contain canonical reason codes.

Free-form diagnostics MAY accompany them but MUST NOT determine authoritative outcome.

## 27.1 Claim-impact reason codes

```text
01 ACQUISITION_AUTHORITY_UNRESOLVED
02 TRANSACTION_EFFECT_UNRESOLVED
03 OBJECT_BOUNDARY_UNRESOLVED
04 OPENING_INVENTORY_UNRESOLVED
05 OPENING_BASIS_UNRESOLVED
06 ENDING_INVENTORY_UNRESOLVED
07 TARGET_ACCOUNT_COVERAGE_INCOMPLETE
08 TARGET_TRANSFER_EXTERNAL_CONTINUATION
09 UNKNOWN_TOKEN_SCOPE
10 UNMATCHED_WALLET_INSTRUCTION
11 UNSUPPORTED_NESTED_INSTRUCTION_SHAPE
12 ACCOUNT_AUTHORITY_UNRESOLVED
13 QUOTE_CONTEXT_UNRESOLVED
14 MIXED_QUOTE_UNSUPPORTED
15 FEE_TREATMENT_UNRESOLVED
16 SHARED_EFFECT_ALLOCATION_UNRESOLVED
17 INTRA_OR_INTER_TX_ORDER_UNRESOLVED
18 INTRA_TX_EFFECT_ORDER_UNRESOLVED
19 OVERSOLD_ESTABLISHED_INVENTORY
20 WALLET_EFFECT_UNRESOLVED
21 CANDIDATE_POPULATION_INCOMPLETE
22 NO_LIMITED_PROJECTION
23 TRANSFER_IN_BASIS_UNRESOLVED
```

`TRANSFER_IN_BASIS_UNRESOLVED` means that target inventory entered through an admitted transfer-in, but attributable economic basis for that inventory was not established. Any Position Economics field whose value depends on that basis remains unavailable for the affected economic interval.

The exact code MUST be preserved from the Slice 4 unresolved dependency into canonical claim reasons. It is not unknown opening basis; it MUST NOT fabricate zero basis, reclassify a transfer as a purchase or sale, or determine `position_state`. Independently established inventory and continuity may still support any state derived by the Position Episode engine. A later genuine economic zero MAY reset basis for subsequent inventory, but MUST NOT retroactively establish historical basis, realized basis, PnL, or return from the contaminated interval. The reason remains attached to every requested Position Economics claim spanning that interval. A complete limited result is `LIMITED`; otherwise the ordinary `BLOCKED` and `NO_LIMITED_PROJECTION` rules apply.

## 27.2 `NO_LIMITED_PROJECTION`

`NO_LIMITED_PROJECTION` MUST be emitted when:

1. at least one field required by the canonical full claim profile is unavailable; and
2. the corresponding canonical `*_LIMITED` result profile is also incomplete.

This condition implies:

```text
claim_outcome = BLOCKED
```

`NO_LIMITED_PROJECTION` MUST be emitted **in addition to**, not instead of, the substantive unresolved reason codes that caused the full and limited profiles to fail.

Example:

```text
UNKNOWN_TOKEN_SCOPE
OPENING_BASIS_UNRESOLVED
NO_LIMITED_PROJECTION
```

may coexist.

## 27.3 Exclusion codes

```text
01 EXCLUDED_AFTER_CLOSED_BOUNDARY
02 EXCLUDED_BEFORE_ZERO_OPEN_BOUNDARY
03 EXCLUDED_ASSET_AND_DIMENSION_DISJOINT
04 EXCLUDED_FAILED_TX_NO_COMMITTED_TARGET_EFFECT
05 EXCLUDED_QUOTE_FUNDING_ONLY
06 EXCLUDED_QUOTE_WITHDRAWAL_ONLY
```

The ordinal order above is identity-relevant.

Codes are normalized, deduplicated, and emitted in canonical ordinal order.

---

# 28. Identity-bound claim context

Every authoritative v1.3 claim MUST bind, directly or by authoritative reference:

```text
network
analyzed_wallet

acquisition_request/window
finalized_anchor
acquisition/evidence identity

claim_type
claim_profile

target_mint, when applicable
exact_quote_mint, when applicable
Position Episode identity, when applicable
candidate identity, when applicable

effect_model_profile
boundary_authority_profile
canonical_ordering_profile
intra_tx_effect_order_profile
accounting_profile
quote_profile
non_interference_profile
episode_enumeration_profile
candidate_population_profile
candidate_selection_policy

opening/ending boundaries
included evidence
excluded evidence
unresolved findings

claim_outcome
position_state
reason codes
verified or limited result fields

referenced legacy receipt/package identity,
when applicable
```

Unauthenticated display metadata MUST NOT expand what a claim proves.

---

# 29. Claim immutability

A completed semantic claim is immutable.

A change to any bound evidence, profile, scope, boundary, outcome, selection policy, exclusion, or economic result creates a new claim identity.

The prior claim MUST NOT be mutated in place.

Operational status such as:

* published;
* superseded;
* revoked;
* minted;

belongs to a separate lifecycle record.

---

# 30. Claim evaluation algorithm

For every requested claim:

```text
1. Establish authoritative bounded acquisition.

2. Bind all canonical v1.3 profiles.

3. Fix the requested canonical claim profile.

4. Identify claim object and canonical scope.

5. For positions:
   enumerate the exhaustive Position Episode population.

6. Establish canonical boundaries/order where possible.

7. Enumerate every evidence item capable of changing
   a REQUIRED claim field.

8. Apply ARTIFACT_NON_INTERFERENCE_V1
   deterministically to each residual finding.

9. Apply admitted economic effects in canonical order.

10. Derive position_state from admitted evidence, independently of claim outcome.

11. Test the complete canonical VERIFIED field profile.

12. If complete:
      outcome = VERIFIED

13. Else test the canonical LIMITED result profile.

14. If complete:
      outcome = LIMITED

15. Else:
      outcome = BLOCKED
      position_state = null
      emit NO_LIMITED_PROJECTION
      in addition to substantive reasons

16. Emit complete normalized reason set.

17. Apply receipt/candidate eligibility.

18. Bind immutable verifier-facing claim identity.
```

Step 15 deliberately clears any previously derived state.

A `BLOCKED` result carries no authoritative position-state assertion under v1.3.

---

# 31. Conformance matrix

Every row assumes complete authoritative acquisition and satisfaction of all other inherited preconditions unless explicitly stated.

| Scenario                                                                         | Required result                                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Clean buy → full sell → economic zero                                            | `VERIFIED / CLOSED`                                                                     |
| Scale in → scale out → economic zero                                             | `VERIFIED / CLOSED`                                                                     |
| Buy 10 → sell 9 → hold 1                                                         | `VERIFIED / OPEN_REALIZED_PARTIAL` when complete                                        |
| Fully open supported position                                                    | `VERIFIED / OPEN`                                                                       |
| Unknown opening basis → full supported disposal → economic zero                  | `LIMITED / CLOSED`                                                                      |
| Known positive inventory, basis incomplete, no disposal                          | `LIMITED / OPEN` if limited profile complete                                            |
| Supported partial disposal, ending economic inventory positive, basis incomplete | `LIMITED / OPEN_REALIZED_PARTIAL` if limited profile complete                           |
| Partial transfer-out, some custody remains, continuation unresolved              | `LIMITED / null` if limited profile complete; otherwise `BLOCKED / null`                |
| Full transfer-out to custody zero, continuation unresolved                       | Never `CLOSED`; `LIMITED / null` or `BLOCKED / null`                                    |
| Transfer-out followed by return with basis/continuity unresolved                 | External-continuation and unknown-basis issues both apply                               |
| Unknown-scope finding inside episode                                             | `LIMITED` or `BLOCKED`; never verified without canonical exclusion                      |
| Unknown-scope before later independent zero boundary                             | Later episode may verify                                                                |
| Unknown-scope after valid closed boundary                                        | Earlier episode may verify                                                              |
| NI-03 exact disjointness proven solely from bound admitted evidence              | Projection MUST be admitted                                                             |
| NI-03 would require auxiliary inference                                          | NI-03 MUST NOT apply                                                                    |
| Non-zero opening quantity/basis supported by bound evidence                      | MUST be admitted                                                                        |
| Non-zero opening basis available only from unbound pre-window lookup             | MUST NOT be admitted                                                                    |
| Quote deposit + buy inseparable                                                  | `TRANSACTION_EFFECT_UNRESOLVED`; add `QUOTE_CONTEXT_UNRESOLVED` when economics affected |
| Zero realized basis with otherwise complete supported disposal                   | `UNDEFINED_ZERO_BASIS`; VERIFIED remains possible                                       |
| Mixed USDC/USDT quote legs                                                       | No verified economics under v1.3                                                        |
| Failed swap with exact committed fee                                             | No committed target effect                                                              |
| Candidate population count mismatch                                              | Aggregate authority invalid                                                             |
| Explicit selected candidate is limited                                           | Return LIMITED; no fallback                                                             |
| Verified position, wallet-window unrequested                                     | Position VERIFIED; wallet window NOT_EVALUATED                                          |
| Verified position, wallet-window unresolved                                      | Position may VERIFY; wallet window LIMITED                                              |

---

# 32. First controlled mainnet case

The preferred first mainnet experiment remains:

```text
dedicated wallet
initial JUP economic inventory = 0
→ supported USDC-funded JUP acquisition
→ supported full JUP disposal to USDC
→ ending JUP economic inventory = 0
```

Ideal claims:

```text
TRANSACTION_EFFECT_V1
  VERIFIED

POSITION_ECONOMICS_V1
  VERIFIED
  CLOSED

WALLET_EFFECT_COVERAGE_V1
  VERIFIED
```

Artifact MUST remain outside the execution mechanism.

---

# 33. Explicit non-goals

Verification Scope v1.3 does not add:

* new decoder support merely to make a target wallet pass;
* multi-wallet economic continuity;
* unbound pre-window basis reconstruction;
* multi-chain accounting;
* bridge inventory accounting;
* stablecoin equivalence;
* SOL/WSOL quote equivalence;
* perps;
* LPs;
* staking derivatives;
* unrealized mark-to-market PnL;
* wallet ownership;
* agent identity;
* authorization;
* privacy redesign;
* mainnet NFT minting;
* leaderboards;
* reputation scoring.

Historical balance APIs may later strengthen boundary validation.

They MUST NOT replace event-ledger or cost-basis reconstruction.

---

# 34. Normative freeze summary

Verification Scope / Acceptability v1.3 establishes:

> **Artifact verifies a fixed canonical proposition.**

> **All authoritative establishment derives solely from evidence admitted under the bound effect model and immutable claim context.**

> **Transaction, Position Episode, and Wallet Window are separate claims.**

> **Claim outcome and economic position state are independent.**

> **Only canonical versioned claim profiles receive canonical verification labels.**

> **`LIMITED` and `BLOCKED` are objectively determined by closed result profiles.**

> **NI-03 cannot use auxiliary inference.**

> **Non-zero opening basis cannot be imported through an unbound historical lookup.**

> **Open positions can be verified; closed positions can remain economically limited.**

> **Wallet custody zero is not necessarily economic zero.**

> **Transfers do not become synthetic purchases, sales, profit, loss, or closure.**

> **One exact raw quote mint governs position economics.**

> **Weighted-average accounting is exact, ordered, and immutable after realization.**

> **A zero-basis realized return is explicitly undefined, not missing or fabricated.**

> **Every Position Episode is deterministically enumerated and accounted for.**

> **Candidate selection cannot silently optimize for profitability.**

> **Only verified canonical Position Economics claims may create verified economic receipts.**

> **Completed semantic claims are immutable.**

> **Non-success outcomes and exclusions use closed, identity-relevant reason vocabularies.**

> **Artifact refuses affected claims rather than weakening its verification boundary.**

The intended behavior is:

```text
fix the proposition
bind the evidence
bind the rules
enumerate the episodes
prove the boundaries
reconstruct the economics
prove every exclusion
classify every outcome
issue only eligible claims
refuse everything else
```
