# Helius qualification run plan — BLOCKED, no external dispatch

This is a separate qualification artifact, not accepted executable R, a production
launcher, a mandate, an episode, an eligibility decision, or future-readiness approval.
The accompanying `supervise.py` intentionally exposes **local-only** commands. It
has no live mode and never discovers a credential. `probe.mjs` exports the bounded
read-only probe for a future explicitly bound custodian launch; importing it does not
dispatch. The missing host credential delivery is not replaced with an environment
loader, a secret path option, a root-run probe, or a production activation bypass.

## Recovered inputs and missing prerequisites

- Source manifest: `engine/docs/v1.3-private-helius-query-binding-source-manifest.sha256`,
  SHA-256 `094bedf06a1d8c41b207731afe268b80cc45e049496c9ee21c7b4b5d6a6b27ad`.
- Accepted runtime inventory: `/root/artifact-private-helius-query-binding/runtime-frozen.json`,
  R `1686d69ff98d821ee84a3d58722ea9842c04e49e4d2e4438203608913d91bb6c`.
- Non-secret public addresses: exact `PUBLIC` values in `probe.mjs`, copied from
  `mandate-v1.mjs:26–49` and `supervised-finalized-source-v1.mjs:10`.
- Private capability: OPERATOR FD 5, read-only regular single-link file owned by
  the executor UID, mode excluding all group/other access, 1–73728 bytes,
  canonical `{api_key, ca, capability_id}` with `helius-mainnet-query-v1`.
  The accepted exchange retains its grammar, query encoding, screening, TLS and
  one-shot behavior unchanged. Only this provider credential may cross confinement.
- **Missing:** concrete documented existing custodian/location-to-FD-5 delivery
  on this host. The invoking shell has no FD 5 and its documented legacy
  `HELIUS_API_KEY` environment input is absent (presence-only check). Historical
  Windows `.openclaw/.env` documentation is not a Linux private-FD mapping. No
  credential file or secret store was searched/read and no key is requested in chat.
- **Missing for setup bodies:** exact authentic setup transaction signatures and
  checksum-bound public setup evidence. The inspected final-proof contract fixes
  setup schema and timestamp, but its digest inputs/test identities are not actual
  setup transaction references. Do not derive a new setup authority from a sample.
- **Missing for representative simulation:** admissible input to the existing
  `buildOrcaMessageBoundaryV1`. It requires a validated mandate and source-bound
  quote/fee/current-route inputs. This task forbids creating mandates, and the
  inspected available test inputs are synthetic. No authority DB, signer, live
  readiness factory, or alternate hand-written swap builder may fill that gap.
  The plan therefore allocates **zero** simulations and exact-message fee calls.
  That is a disclosed limitation, not qualification of those contracts.

## Exact bounded read-only allocation

One possible session, never automatically restarted. Fixed standard endpoint only:
`https://mainnet.helius-rpc.com/`, with query key inserted exclusively by the accepted
`createHeliusExchangeV1`. No other endpoints, telemetry, negotiation or transport retries.
Sequential requests only; early STOP leaves later allocations unused.

| Method | Maximum | Parameters / derivation |
|---|---:|---|
| `getGenesisHash` | 1 | `[]`; require frozen mainnet genesis. |
| `getSlot` | 1 | `[{commitment:'finalized'}]`; safe nonnegative anchor slot A. |
| `getBlock` | 1 | `[A,{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:0}]`; nonnull safe block time, not future, at most 300 seconds old. No anchor search. |
| `getMultipleAccounts` | 2 | First `[wallet,JUP ATA,USDC ATA]`, base64/finalized/floor A. Second `[pool,JUP vault,USDC vault,oracle,JUP mint,USDC mint]`, floor from preceding pool `getAccountInfo`. These sample ordered envelopes, not dynamic tick-array or binary-layout qualification. |
| `getTokenAccountsByOwner` | 2 | One classic Token and one Token-2022 program filter, base64/finalized/floor equal to opening context. Record each context; require exact equality to opening or STOP without pair retries. Sample expected two classic addresses and empty Token-2022 lane; never claim universal all-or-error behavior. |
| `getSignaturesForAddress` | 15 | Wallet and two ATAs, each at most four pages plus one repeated head; finalized, limit 100, opening context floor, next `before` exactly last admitted signature. A nonempty short page is not exhaustion. Require explicit empty page, safe times, nonconflicting ordering, and identical head; stop if capped. This is at most 12 scan pages plus three repeated heads, not permission to consume all 15 when fewer suffice. |
| `getAccountInfo` | 1 | Frozen pool, base64/finalized/floor A. |
| `getLatestBlockhash` | 1 | Finalized/floor from second multiple-account context. Retain original blockhash and last-valid height. |
| `getBlockHeight` | 1 | Finalized/floor from blockhash context; require height below last-valid height. No exact-fee-floor claim without a fee call. |
| `getTransaction` | 0 | No authentic frozen setup signatures admitted for this plan. |
| `getFeeForMessage` | 0 | No representative exact message available. |
| `simulateTransaction` | 0 | No representative message available; denied by this harness, never a no-op substitute. |
| All other methods | 0 | In particular all submission, bundle and broadcast methods forbidden. |

Maximum **25** application-level requests, including unsuccessful/ambiguous requests;
no per-method allowance is transferable. Existing stricter readiness limits preserved:
**5000 ms/request**, **1 MiB/response**, **1 MiB/request**, at most **16 MiB aggregate
admitted responses**, **55 seconds inner request sequence** and a required **60-second
external whole-process limit** from launch through termination (stricter than 600 seconds).
The successful local synthetic read path used 19 requests, including nine history calls;
these are not expected or guaranteed actual provider counts. No known account quota or
account entitlement is inferred. Custodian must identify any tighter quota before dispatch;
unknown account state is not a monetary-cost claim or permission to relax bounds.

## Frozen evidence and prospective launch protocol

Exclusive session reservation:
`/root/artifact-private-helius-provider-qualification/external-session`.
Its immutable `run-spec.json` and `ledger.json` say **NOT_DISPATCHED**. Do not reuse
this blocked record by overwriting it. A later continuation must bind its dispatch
identity append-only and must not interpret this plan as a renewed run authorization.

1. Establish the actual existing non-secret custody mapping and account restrictions.
   Do not run the root process as the provider client. Do not change existing host
   permissions, create production users/services, or deliver secrets through argv/env.
2. Bind a temporary installed qualification closure, process identity and custody
   gate before dispatch. The tested mechanism is private mount/PID namespaces,
   chroot containing only named public modules/runtime, existing UID/GID 65534,
   empty groups, zero inheritable/permitted/effective/bounding/ambient capabilities,
   no_new_privs, no core dumps, ptrace/process-memory/io_uring denial, complete
   `close_range` closure except administrator-owned 0–2 and credential FD 5.
   No host wallet, state, key, authority, credential store or host process namespace
   is mounted. Parent is a supervisor only. Prove worker isolation before releasing
   its execution gate; record host PID/starttime, PGID, PID namespace and deadline.
3. **Unimplemented/missing live host binding:** local supervision deliberately uses a
   network namespace with only loopback. Do not remove isolation ad hoc. The custodian
   binding must supply the authorized fixed-endpoint DNS/TLS network arrangement
   and its public dependency identity, while preserving signer-inaccessible filesystem,
   UID/FD/process boundaries. Local loopback success is not that host qualification.
4. For each call, `bounded.mjs` durably creates exact canonical clean request bytes,
   consumes a reservation before transport, rechecks time after retention, and
   invokes the unchanged exchange once. It passes remaining aggregate capacity into
   the accepted stream limit. Ambiguous interruption consumes its reservation and
   is never automatically repeated. All request/response writes are exclusive and
   fsynced, followed by directory fsync.
5. Only exact response bytes returned **after accepted screening** are retained.
   Never retain HTTP targets/headers, rejected echoes, raw exception causes or
   credential-bearing URLs. The exchange deliberately collapses HTTP failures,
   contamination and network errors to a fixed refusal; absent clean bodies cannot
   honestly distinguish 401 from 429, DNS/TLS failure or screening rejection.
   Stop on every such failure. Admitted JSON-RPC error codes may be recorded safely.
6. Terminate/collect the entire owned PID namespace on deadline or interruption,
   including descendants that escaped the initial process group. Preserve partial
   evidence before removing owned temporary roots. Never auto-restart or dispatch
   another method to diagnose the first failed call.
7. A future simulation extension, if its genuine prerequisites become available,
   must still use the existing supported builder, an all-zero signature legacy wire,
   exact retained blockhash/message/request identity, and
   `{encoding:'base64',commitment:'finalized',sigVerify:false,replaceRecentBlockhash:false,minContextSlot:<required floor>}`.
   It needs a separately frozen revised call allocation before any dispatch; do not
   silently expand this zero-simulation plan. Separate accepted RPC parameters,
   execution success (`err:null`, safe unitsConsumed, string logs, floor met, no
   replacement), economic/program refusal, transport failure and not tested.

No seven-day eligibility computation, admitted episode, mandate, authorization,
trading-state creation/consumption, signing, funding, wallet mutation, broadcast,
production C/D or activation is part of this plan. A provider sample cannot prove
universal history completeness, absence of omissions, provider secret retention,
broadcast `maxRetries` behavior, future readiness, or installed production-host safety.

## Local verification commands (already executed; not a rerun instruction)

`supervise.py local <exclusive-local-evidence-directory>` and
`supervise.py cleanup-probe <exclusive-cleanup-evidence-directory>` run only the new
synthetic harness. No npm/canonical suite is involved. Final results are 16/16 local
checks and successful whole-PID-namespace cleanup of an escaped-session descendant.
The closeout records all failed/intermediate attempts and their exact identities.

**Stop here.** Smallest next input is the custodian's non-secret actual existing
provider credential delivery mapping and tighter account restrictions, not a key
in chat. A live custodian binding and missing message/setup inputs remain explicitly
unresolved; this artifact does not claim a ready full-provider qualification launcher.
